-- Termo de registro das aulas: envio em lote pelo número central da escola e
-- acompanhamento de quem não respondeu.
--
-- Antes (20260926120000) o painel "Autorizações de registro" só gerava o link
-- aluno por aluno, e a direção copiava e mandava na mão. Aqui:
--
-- - a direção clica em "Enviar termo aos alunos pendentes", vê quantas
--   mensagens e até quando elas saem, e confirma. NADA é enviado no deploy;
-- - cada aluno ATIVO sem decisão na versão vigente do termo ganha um link
--   próprio e uma linha na notification_queue (kind
--   LESSON_RECORDING_CONSENT_REQUEST), idempotente por aluno + versão do termo
--   (+ número da tentativa, para o reenvio);
-- - o envio é ESPALHADO: uma mensagem a cada 3 minutos (no máximo 5 a cada
--   15 min), só de segunda a sábado, das 9h às 20h (horário de Brasília). O
--   número da escola foi restringido pelo WhatsApp em 17/09/2026 depois de ~130
--   mensagens automáticas em 7 h; o processador da fila ainda pede licença ao
--   teto (whatsapp_outbound_permit) e adia sem gastar tentativa;
-- - menor de idade OU idade não cadastrada: a mensagem vai ao responsável
--   (contato verificado de responsável, profiles.guardian_phone ou o perfil do
--   responsável). Sem telefone do responsável, o aluno aparece como "sem
--   contato" — o termo nunca vai para o próprio número de quem pode ser menor;
-- - o processador revalida tudo na hora de mandar
--   (get_lesson_recording_consent_request_snapshot): quem respondeu, revogou,
--   saiu da escola, trocou de contato, teve o link substituído ou viu o termo
--   mudar de versão NÃO recebe a mensagem;
-- - "Reenviar" só depois de 3 dias do último envio que saiu (mensagem que não
--   saiu pode ser reenviada na hora);
-- - a página pública passa a registrar quando o link foi aberto (a mensagem
--   chegou e a pessoa clicou), para a lista mostrar "aberto?".
--
-- Recusa e revogação são decisões: ninguém que disse não recebe pedido de novo.

-- Quando o link foi aberto pela primeira e pela última vez.
alter table private.lesson_recording_consent_links
  add column if not exists first_opened_at timestamptz,
  add column if not exists last_opened_at timestamptz;

create table if not exists private.lesson_recording_consent_requests (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id text not null references public.tenants(id),
  student_id uuid not null references public.profiles(id),
  term_version text not null check (term_version ~ '^v[0-9]+$'),
  attempt integer not null check (attempt between 1 and 50),
  batch_id uuid not null,
  link_id uuid not null references private.lesson_recording_consent_links(id),
  notification_id uuid references public.notification_queue(id) on delete set null,
  recipient text not null check (recipient in ('STUDENT', 'GUARDIAN')),
  destination text not null check (destination ~ '^[0-9]{12,15}$'),
  message_sha256 text not null check (message_sha256 ~ '^[a-f0-9]{64}$'),
  requested_by uuid not null references public.profiles(id),
  scheduled_for timestamptz not null,
  created_at timestamptz not null default now(),
  unique (student_id, term_version, attempt)
);
create index if not exists lesson_recording_consent_requests_tenant_idx
  on private.lesson_recording_consent_requests(tenant_id, created_at desc);
create index if not exists lesson_recording_consent_requests_link_idx
  on private.lesson_recording_consent_requests(link_id);
create index if not exists lesson_recording_consent_requests_notification_idx
  on private.lesson_recording_consent_requests(notification_id);
create index if not exists lesson_recording_consent_requests_requested_by_idx
  on private.lesson_recording_consent_requests(requested_by);

alter table private.lesson_recording_consent_requests owner to postgres;
alter table private.lesson_recording_consent_requests enable row level security;
revoke all on private.lesson_recording_consent_requests
  from public, anon, authenticated, service_role;

-- Só a direção (diretor da escola ou super admin no próprio ambiente) dispara
-- mensagem em massa. Coordenação vê a lista, não envia.
create or replace function private.lesson_recording_is_direction(p_tenant text)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.can_manage_lesson_quality(p_tenant), false)
    and exists (
      select 1 from public.profiles as actor
      where actor.id = (select auth.uid())
        and actor.role in ('SCHOOL_ADMIN', 'SUPER_ADMIN')
    );
$$;

-- Para quem vai o termo do aluno e em que número.
-- Menor de idade (is_kids ou nascimento há menos de 18 anos) e idade não
-- cadastrada vão ao responsável; o aluno adulto recebe no próprio número.
create or replace function private.lesson_recording_request_target(p_student uuid)
returns table (recipient text, destination text, missing_reason text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_student public.profiles;
  v_today date := (pg_catalog.now() at time zone 'America/Sao_Paulo')::date;
  v_minor boolean;
  v_unknown_age boolean;
  v_phone text;
begin
  select * into v_student from public.profiles where id = p_student;
  if not found then
    return query select null::text, null::text, 'aluno_nao_encontrado'::text;
    return;
  end if;

  v_minor := coalesce(v_student.is_kids, false)
    or (v_student.birth_date is not null and v_student.birth_date > v_today - interval '18 years');
  v_unknown_age := v_student.birth_date is null and not coalesce(v_student.is_kids, false);

  if v_minor or v_unknown_age or private.lesson_recording_requires_guardian(p_student) then
    select private.normalize_notification_phone(contact.phone) into v_phone
    from public.student_quality_contacts as contact
    where contact.student_id = p_student
      and contact.tenant_id = v_student.tenant_id
      and contact.relationship = 'GUARDIAN'
      and contact.active and contact.verified_at is not null
    order by contact.verified_at desc
    limit 1;
    v_phone := coalesce(
      v_phone,
      private.normalize_notification_phone(v_student.guardian_phone),
      (select private.normalize_notification_phone(guardian.phone)
         from public.profiles as guardian
        where guardian.id = v_student.guardian_id and guardian.id <> v_student.id)
    );
    return query select 'GUARDIAN'::text, v_phone,
      case
        when v_phone is not null then null
        when v_unknown_age then 'idade_nao_cadastrada'
        else 'menor_sem_telefone_do_responsavel'
      end;
    return;
  end if;

  select private.normalize_notification_phone(contact.phone) into v_phone
  from public.student_quality_contacts as contact
  where contact.student_id = p_student
    and contact.tenant_id = v_student.tenant_id
    and contact.relationship = 'STUDENT'
    and contact.active and contact.verified_at is not null
  order by contact.verified_at desc
  limit 1;
  v_phone := coalesce(
    v_phone,
    private.normalize_notification_phone(v_student.attendance_phone),
    private.normalize_notification_phone(v_student.phone)
  );
  return query select 'STUDENT'::text, v_phone,
    case when v_phone is null then 'sem_telefone' end;
end;
$$;

-- Alunos ativos da escola e a situação de cada um diante do termo vigente.
-- "eligible": nunca decidiu, ou aceitou uma versão anterior e ainda não viu a
-- vigente. Quem recusou ou teve a autorização revogada NÃO é chamado de novo.
create or replace function private.lesson_recording_request_roster(p_tenant text)
returns table (
  student_id uuid,
  full_name text,
  decision text,
  decided_at timestamptz,
  eligible boolean,
  term_updated boolean,
  recipient text,
  destination text,
  missing_reason text
)
language sql stable security definer set search_path = '' as $$
  with term as (
    select current_term.version
    from private.lesson_recording_current_term('STUDENT') as current_term
  )
  select
    student.id,
    coalesce(nullif(private.safe_notification_text(student.full_name, 180), ''), 'Aluno'),
    coalesce(last_decision.decision, 'NONE'),
    last_decision.decided_at,
    coalesce(last_decision.decision, 'NONE') in ('NONE', 'ACCEPTED')
      and not exists (
        select 1
        from private.lesson_recording_consents as consent, term
        where consent.subject_id = student.id
          and consent.term_version = term.version
          and consent.decision in ('ACCEPTED', 'REFUSED')
      ),
    coalesce(last_decision.decision, 'NONE') = 'ACCEPTED',
    target.recipient,
    target.destination,
    target.missing_reason
  from public.profiles as student
  left join lateral (
    select consent.decision, consent.decided_at
    from private.lesson_recording_consents as consent
    where consent.subject_id = student.id
    order by consent.seq desc
    limit 1
  ) as last_decision on true
  cross join lateral private.lesson_recording_request_target(student.id) as target
  where student.tenant_id = p_tenant
    and student.role = 'STUDENT'
    and pg_catalog.lower(pg_catalog.btrim(coalesce(student.lifecycle_status, ''))) = 'active'
    and student.is_test_account is not true
    and public.is_student_notifiable(student.id)
    and exists (
      select 1 from public.tenant_memberships as membership
      where membership.tenant_id = p_tenant
        and membership.user_id = student.id
        and membership.role = 'STUDENT'
        and membership.status = 'ACTIVE'
    );
$$;

-- Próximo horário permitido a partir de p_from: segunda a sábado, das 9h às
-- 20h de Brasília. Termo não é urgente; ninguém recebe pedido à noite nem no
-- domingo.
create or replace function private.lesson_recording_send_slot(p_from timestamptz)
returns timestamptz
language plpgsql stable set search_path = '' as $$
declare
  v_local timestamp := p_from at time zone 'America/Sao_Paulo';
begin
  for v_step in 1..10 loop
    if extract(isodow from v_local) = 7 then
      v_local := pg_catalog.date_trunc('day', v_local) + interval '1 day 9 hours';
    elsif v_local::time < time '09:00' then
      v_local := pg_catalog.date_trunc('day', v_local) + interval '9 hours';
    elsif v_local::time >= time '20:00' then
      v_local := pg_catalog.date_trunc('day', v_local) + interval '1 day 9 hours';
    else
      exit;
    end if;
  end loop;
  return v_local at time zone 'America/Sao_Paulo';
end;
$$;

-- Horários de p_count mensagens: uma a cada 3 minutos dentro da janela, o que
-- dá no máximo 5 mensagens em qualquer intervalo de 15 minutos.
create or replace function private.lesson_recording_send_slots(p_start timestamptz, p_count integer)
returns timestamptz[]
language plpgsql stable set search_path = '' as $$
declare
  v_slots timestamptz[] := '{}';
  v_slot timestamptz;
begin
  if coalesce(p_count, 0) < 1 then
    return v_slots;
  end if;
  v_slot := private.lesson_recording_send_slot(p_start);
  for v_position in 1..p_count loop
    v_slots := v_slots || v_slot;
    v_slot := private.lesson_recording_send_slot(v_slot + interval '3 minutes');
  end loop;
  return v_slots;
end;
$$;

-- Onde começa o próximo lote: agora, ou 3 minutos depois do último pedido de
-- termo ainda na fila da escola — dois cliques não somam duas rajadas.
create or replace function private.lesson_recording_batch_start(p_tenant text)
returns timestamptz
language sql stable security definer set search_path = '' as $$
  select pg_catalog.date_trunc('minute', greatest(
    pg_catalog.now() + interval '2 minutes',
    coalesce((
      select max(queue.scheduled_for) + interval '3 minutes'
      from public.notification_queue as queue
      where queue.tenant_id = p_tenant
        and queue.notification_kind = 'LESSON_RECORDING_CONSENT_REQUEST'
        and queue.status in ('pending', 'processing')
    ), '-infinity'::timestamptz)
  ));
$$;

-- Texto curto; o termo completo está no link. Não promete nada que o termo
-- (v2) não diga: transcrição sem vídeo, registro e continuidade, confirmação de
-- que a aula aconteceu, aula normal sem autorização, dá para mudar de ideia.
create or replace function private.lesson_recording_request_message(
  p_student_name text,
  p_school_name text,
  p_token text,
  p_recipient text,
  p_term_updated boolean
)
returns text
language plpgsql immutable set search_path = '' as $$
declare
  v_first text := nullif(split_part(private.safe_notification_text(p_student_name, 120), ' ', 1), '');
  v_school text := coalesce(nullif(private.safe_notification_text(p_school_name, 80), ''), 'escola');
  v_opening text;
begin
  if coalesce(p_token, '') !~ '^[a-f0-9]{64}$' then
    raise exception 'token_invalido' using errcode = '22023';
  end if;
  if p_recipient = 'GUARDIAN' then
    v_opening := pg_catalog.format(
      'Olá! Aqui é da %s. Como responsável %s, pedimos sua autorização para o registro das aulas.',
      v_school, coalesce('por ' || v_first, 'pelo aluno')
    );
  else
    v_opening := pg_catalog.format(
      'Olá%s! Aqui é da %s. Pedimos sua autorização para o registro das aulas.',
      coalesce(', ' || v_first, ''), v_school
    );
  end if;
  if coalesce(p_term_updated, false) then
    v_opening := v_opening || ' O termo foi atualizado desde a sua última resposta.';
  end if;

  return concat_ws(E'\n\n',
    v_opening,
    'Com ela, o Google Meet transcreve a aula (sem vídeo) para registrar o que foi trabalhado, dar continuidade ao aprendizado e confirmar que a aula aconteceu.',
    'Termo completo e resposta (leva 1 minuto): https://system.wisewolflanguage.com.br/registro-das-aulas?token=' || p_token,
    'Sem autorização, a aula acontece normalmente, só que sem transcrição. Dá para mudar de ideia quando quiser.'
  );
end;
$$;

-- Cria o link e a mensagem de UM aluno e põe na fila. Chamado pelo lote e pelo
-- reenvio, já com a trava da escola. Não revoga o link anterior: ele pode ter
-- sido mandado à mão pela direção há pouco; os dois valem até vencer.
create or replace function private.lesson_recording_enqueue_request(
  p_tenant text,
  p_student uuid,
  p_student_name text,
  p_school_name text,
  p_term_version text,
  p_attempt integer,
  p_batch uuid,
  p_recipient text,
  p_destination text,
  p_term_updated boolean,
  p_slot timestamptz,
  p_actor uuid
)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_request uuid := extensions.gen_random_uuid();
  v_key text := 'lesson-recording-consent:' || p_student::text || ':' || p_term_version || ':' || p_attempt::text;
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_link uuid;
  v_message text;
  v_notification uuid;
begin
  if exists (
    select 1 from public.notification_queue as queue
    where queue.tenant_id = p_tenant and queue.idempotency_key = v_key
  ) then
    return null;
  end if;

  insert into private.lesson_recording_consent_links (tenant_id, student_id, token_hash, created_by, expires_at)
  values (p_tenant, p_student, encode(extensions.digest(v_token, 'sha256'), 'hex'), p_actor,
    p_slot + interval '30 days')
  returning id into v_link;

  v_message := private.lesson_recording_request_message(
    p_student_name, p_school_name, v_token, p_recipient, p_term_updated
  );

  insert into public.notification_queue (
    tenant_id, teacher_id, student_id, student_name, student_phone, message_body,
    scheduled_for, next_attempt_at, status, source_id, source_type, notification_kind,
    idempotency_key
  ) values (
    p_tenant, null, p_student, left(p_student_name, 180), p_destination, v_message,
    p_slot, p_slot, 'pending', v_request, 'LESSON_RECORDING_CONSENT',
    'LESSON_RECORDING_CONSENT_REQUEST', v_key
  )
  on conflict (tenant_id, idempotency_key) where idempotency_key is not null do nothing
  returning id into v_notification;

  if v_notification is null then
    update private.lesson_recording_consent_links set revoked_at = pg_catalog.now() where id = v_link;
    return null;
  end if;

  insert into private.lesson_recording_consent_requests (
    id, tenant_id, student_id, term_version, attempt, batch_id, link_id, notification_id,
    recipient, destination, message_sha256, requested_by, scheduled_for
  ) values (
    v_request, p_tenant, p_student, p_term_version, p_attempt, p_batch, v_link, v_notification,
    p_recipient, p_destination, encode(extensions.digest(v_message, 'sha256'), 'hex'), p_actor, p_slot
  );
  return v_request;
end;
$$;

-- Quem entra no lote: ativo, pode ser chamado, tem contato e ainda não recebeu
-- pedido desta versão. Até 60 por clique (~3 h de janela).
create or replace function private.lesson_recording_batch_candidates(p_tenant text)
returns table (
  student_id uuid,
  full_name text,
  recipient text,
  destination text,
  term_updated boolean
)
language sql stable security definer set search_path = '' as $$
  select roster.student_id, roster.full_name, roster.recipient, roster.destination, roster.term_updated
  from private.lesson_recording_request_roster(p_tenant) as roster
  where roster.eligible
    and roster.destination is not null
    and not exists (
      select 1
      from private.lesson_recording_consent_requests as request
      where request.student_id = roster.student_id
        and request.term_version = (select current_term.version
          from private.lesson_recording_current_term('STUDENT') as current_term)
    )
  order by roster.full_name, roster.student_id
  limit 60;
$$;

-- Tela de confirmação: quantas mensagens, para quantos responsáveis, quantos
-- ficam sem contato e de quando a quando o lote sai.
create or replace function public.preview_lesson_recording_consent_batch()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tenant text := public._my_tenant_id();
  v_count integer;
  v_guardians integer;
  v_updated integer;
  v_no_contact integer;
  v_total_pending integer;
  v_slots timestamptz[];
begin
  if v_tenant is null or not private.lesson_recording_is_direction(v_tenant) then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;

  select count(*), count(*) filter (where candidate.recipient = 'GUARDIAN'),
         count(*) filter (where candidate.term_updated)
    into v_count, v_guardians, v_updated
  from private.lesson_recording_batch_candidates(v_tenant) as candidate;

  select count(*) filter (where roster.destination is null),
         count(*) filter (where roster.destination is not null)
    into v_no_contact, v_total_pending
  from private.lesson_recording_request_roster(v_tenant) as roster
  where roster.eligible
    and not exists (
      select 1 from private.lesson_recording_consent_requests as request
      where request.student_id = roster.student_id
        and request.term_version = (select current_term.version
          from private.lesson_recording_current_term('STUDENT') as current_term)
    );

  v_slots := private.lesson_recording_send_slots(private.lesson_recording_batch_start(v_tenant), v_count);
  return jsonb_build_object(
    'ok', true,
    'term_version', (select current_term.version from private.lesson_recording_current_term('STUDENT') as current_term),
    'to_send', v_count,
    'to_guardians', v_guardians,
    'term_updated', v_updated,
    'no_contact', v_no_contact,
    'left_for_next_batch', greatest(v_total_pending - v_count, 0),
    'first_at', v_slots[1],
    'last_at', v_slots[v_count],
    'student_notifications_enabled', not exists (
      select 1 from public.tenant_admin_settings as settings
      where settings.tenant_id = v_tenant and settings.student_notifications_enabled is false
    )
  );
end;
$$;

-- O clique da direção. p_expected_count é o número que a tela mostrou: se
-- mudou entre a prévia e a confirmação, nada é enfileirado e a tela pede para
-- conferir de novo.
create or replace function public.enqueue_lesson_recording_consent_batch(p_expected_count integer)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant text := public._my_tenant_id();
  v_actor uuid := (select auth.uid());
  v_term private.lesson_recording_terms;
  v_school text;
  v_batch uuid := extensions.gen_random_uuid();
  v_count integer;
  v_slots timestamptz[];
  v_position integer := 0;
  v_queued integer := 0;
  v_row record;
begin
  if v_tenant is null or not private.lesson_recording_is_direction(v_tenant) then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.tenant_admin_settings as settings
    where settings.tenant_id = v_tenant and settings.student_notifications_enabled is false
  ) then
    raise exception 'avisos_de_aluno_desligados' using errcode = '22023';
  end if;

  -- Dois cliques (ou duas pessoas) ao mesmo tempo viram um lote só.
  perform pg_advisory_xact_lock(hashtextextended('lesson-recording-consent-batch:' || v_tenant, 0));

  select count(*) into v_count from private.lesson_recording_batch_candidates(v_tenant);
  if p_expected_count is null or v_count <> p_expected_count then
    raise exception 'contagem_mudou' using errcode = '22023';
  end if;
  if v_count = 0 then
    return jsonb_build_object('ok', true, 'queued', 0);
  end if;

  v_term := private.lesson_recording_current_term('STUDENT');
  select tenant.name into v_school from public.tenants as tenant where tenant.id = v_tenant;
  v_slots := private.lesson_recording_send_slots(private.lesson_recording_batch_start(v_tenant), v_count);

  for v_row in select * from private.lesson_recording_batch_candidates(v_tenant) loop
    v_position := v_position + 1;
    if private.lesson_recording_enqueue_request(
      v_tenant, v_row.student_id, v_row.full_name, v_school, v_term.version, 1, v_batch,
      v_row.recipient, v_row.destination, v_row.term_updated, v_slots[v_position], v_actor
    ) is not null then
      v_queued := v_queued + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'batch_id', v_batch,
    'queued', v_queued,
    'first_at', v_slots[1],
    'last_at', v_slots[v_count]
  );
end;
$$;

-- "Reenviar" (ou enviar a um aluno só). Liberado 3 dias depois do último envio
-- que saiu; se o anterior não saiu (sem contato na hora, link substituído,
-- falha), pode na hora. Nunca para quem recusou ou revogou.
create or replace function public.resend_lesson_recording_consent_request(p_student_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant text := public._my_tenant_id();
  v_actor uuid := (select auth.uid());
  v_term private.lesson_recording_terms;
  v_school text;
  v_roster record;
  v_last record;
  v_available_at timestamptz;
  v_slot timestamptz;
  v_request uuid;
begin
  if v_tenant is null or not private.lesson_recording_is_direction(v_tenant) then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.tenant_admin_settings as settings
    where settings.tenant_id = v_tenant and settings.student_notifications_enabled is false
  ) then
    raise exception 'avisos_de_aluno_desligados' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('lesson-recording-consent-batch:' || v_tenant, 0));

  select * into v_roster
  from private.lesson_recording_request_roster(v_tenant) as roster
  where roster.student_id = p_student_id;
  if not found then
    raise exception 'aluno_invalido' using errcode = '22023';
  end if;
  if not v_roster.eligible then
    raise exception 'aluno_ja_decidiu' using errcode = '22023';
  end if;
  if v_roster.destination is null then
    raise exception 'sem_contato' using errcode = '22023';
  end if;

  v_term := private.lesson_recording_current_term('STUDENT');
  select request.attempt, request.created_at, queue.status, queue.delivery_status,
         queue.accepted_at, queue.updated_at
    into v_last
  from private.lesson_recording_consent_requests as request
  left join public.notification_queue as queue on queue.id = request.notification_id
  where request.student_id = p_student_id and request.term_version = v_term.version
  order by request.attempt desc
  limit 1;

  if found then
    if v_last.status in ('pending', 'processing') then
      raise exception 'envio_em_andamento' using errcode = '22023';
    end if;
    v_available_at := case
      when v_last.accepted_at is not null then v_last.accepted_at + interval '3 days'
      when v_last.delivery_status = 'uncertain' then v_last.updated_at + interval '3 days'
      else null
    end;
    if v_available_at is not null and v_available_at > pg_catalog.now() then
      raise exception 'reenvio_so_depois_de_3_dias' using errcode = '22023',
        detail = v_available_at::text;
    end if;
  end if;

  select tenant.name into v_school from public.tenants as tenant where tenant.id = v_tenant;
  v_slot := private.lesson_recording_send_slot(private.lesson_recording_batch_start(v_tenant));
  v_request := private.lesson_recording_enqueue_request(
    v_tenant, p_student_id, v_roster.full_name, v_school, v_term.version,
    coalesce(v_last.attempt, 0) + 1, extensions.gen_random_uuid(),
    v_roster.recipient, v_roster.destination, v_roster.term_updated, v_slot, v_actor
  );
  if v_request is null then
    raise exception 'envio_em_andamento' using errcode = '22023';
  end if;

  return jsonb_build_object(
    'ok', true,
    'request_id', v_request,
    'scheduled_for', v_slot,
    'recipient', v_roster.recipient
  );
end;
$$;

-- Lista do painel: todo aluno ativo, para quem o termo vai, e o que aconteceu
-- com o último pedido da versão vigente (agendado, enviado, aberto, decidido).
create or replace function public.list_lesson_recording_consent_requests()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tenant text := public._my_tenant_id();
  v_term private.lesson_recording_terms;
begin
  if v_tenant is null or not private.can_manage_lesson_quality(v_tenant) then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  v_term := private.lesson_recording_current_term('STUDENT');

  return jsonb_build_object(
    'ok', true,
    'can_send', private.lesson_recording_is_direction(v_tenant),
    'term_version', v_term.version,
    'students', coalesce((
      select jsonb_agg(row_data order by row_data ->> 'name')
      from (
        select jsonb_build_object(
          'student_id', roster.student_id,
          'name', roster.full_name,
          'decision', roster.decision,
          'decided_at', roster.decided_at,
          'eligible', roster.eligible,
          'recipient', roster.recipient,
          'contact_last4', right(roster.destination, 4),
          'missing_reason', roster.missing_reason,
          'request', case when last_request.id is null then null else jsonb_build_object(
            'attempt', last_request.attempt,
            'requested_at', last_request.created_at,
            'scheduled_for', last_request.scheduled_for,
            'recipient', last_request.recipient,
            'contact_last4', right(last_request.destination, 4),
            'state', case
              when last_request.accepted_at is not null then 'SENT'
              when last_request.delivery_status = 'uncertain' then 'UNCERTAIN'
              when last_request.queue_status in ('pending', 'processing') then 'QUEUED'
              else 'NOT_SENT'
            end,
            'sent_at', last_request.accepted_at,
            'read_at', last_request.read_at,
            'not_sent_reason', case
              when last_request.accepted_at is null
                and (last_request.queue_status in ('skipped', 'failed') or last_request.queue_status is null)
                then coalesce(last_request.last_error, 'removido_da_fila')
            end,
            'opened_at', last_request.first_opened_at,
            'answered_after', roster.decided_at is not null
              and roster.decided_at >= last_request.created_at
          ) end,
          'resend_available_at', case
            when not roster.eligible or roster.destination is null then null
            when last_request.id is null then pg_catalog.now()
            when last_request.queue_status in ('pending', 'processing') then null
            when last_request.accepted_at is not null then last_request.accepted_at + interval '3 days'
            when last_request.delivery_status = 'uncertain' then last_request.queue_updated_at + interval '3 days'
            else pg_catalog.now()
          end
        ) as row_data
        from private.lesson_recording_request_roster(v_tenant) as roster
        left join lateral (
          select request.id, request.attempt, request.created_at, request.scheduled_for,
                 request.recipient, request.destination,
                 queue.status as queue_status, queue.delivery_status, queue.accepted_at,
                 queue.read_at, queue.last_error, queue.updated_at as queue_updated_at,
                 link.first_opened_at
          from private.lesson_recording_consent_requests as request
          left join public.notification_queue as queue on queue.id = request.notification_id
          left join private.lesson_recording_consent_links as link on link.id = request.link_id
          where request.student_id = roster.student_id
            and request.term_version = v_term.version
          order by request.attempt desc
          limit 1
        ) as last_request on true
      ) as rows
    ), '[]'::jsonb)
  );
end;
$$;

-- Revalidação na hora de mandar (processador da fila, service role). Qualquer
-- mudança desde o clique cancela aquela mensagem, sem nova tentativa.
create or replace function public.get_lesson_recording_consent_request_snapshot(p_notification_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_queue public.notification_queue;
  v_request private.lesson_recording_consent_requests;
  v_link private.lesson_recording_consent_links;
  v_term private.lesson_recording_terms;
  v_roster record;
  v_token text;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;

  select * into v_queue from public.notification_queue
  where id = p_notification_id
    and notification_kind = 'LESSON_RECORDING_CONSENT_REQUEST'
    and source_type = 'LESSON_RECORDING_CONSENT'
    and teacher_id is null;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'termo_notificacao_invalida');
  end if;

  select * into v_request from private.lesson_recording_consent_requests
  where id = v_queue.source_id and tenant_id = v_queue.tenant_id
    and student_id = v_queue.student_id and notification_id = v_queue.id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'termo_pedido_inexistente');
  end if;

  v_term := private.lesson_recording_current_term('STUDENT');
  if v_term.version is distinct from v_request.term_version then
    return jsonb_build_object('ok', false, 'reason', 'termo_mudou_de_versao');
  end if;

  if exists (
    select 1 from public.tenant_admin_settings as settings
    where settings.tenant_id = v_queue.tenant_id and settings.student_notifications_enabled is false
  ) then
    return jsonb_build_object('ok', false, 'reason', 'avisos_de_aluno_desligados');
  end if;

  select * into v_roster
  from private.lesson_recording_request_roster(v_queue.tenant_id) as roster
  where roster.student_id = v_queue.student_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'aluno_nao_esta_ativo');
  end if;
  if not v_roster.eligible then
    return jsonb_build_object('ok', false, 'reason', 'aluno_ja_decidiu');
  end if;
  if v_roster.destination is null
     or v_roster.recipient is distinct from v_request.recipient
     or not private.notification_phones_same_recipient(v_roster.destination, v_request.destination)
     or not private.notification_phones_same_recipient(v_queue.student_phone, v_request.destination) then
    return jsonb_build_object('ok', false, 'reason', 'contato_mudou');
  end if;

  select * into v_link from private.lesson_recording_consent_links where id = v_request.link_id;
  v_token := substring(v_queue.message_body from 'token=([a-f0-9]{64})');
  if v_link.id is null or v_link.revoked_at is not null or v_link.expires_at <= pg_catalog.now()
     or v_token is null
     or v_link.token_hash <> encode(extensions.digest(v_token, 'sha256'), 'hex') then
    return jsonb_build_object('ok', false, 'reason', 'link_substituido_ou_vencido');
  end if;
  if encode(extensions.digest(v_queue.message_body, 'sha256'), 'hex') <> v_request.message_sha256 then
    return jsonb_build_object('ok', false, 'reason', 'mensagem_alterada');
  end if;

  return jsonb_build_object('ok', true, 'destination', v_queue.student_phone, 'message', v_queue.message_body);
end;
$$;

-- Registro de abertura do link, chamado pela página pública.
create or replace function private.lesson_recording_note_link_opened(p_link_id uuid)
returns void
language sql volatile security definer set search_path = '' as $$
  update private.lesson_recording_consent_links
     set first_opened_at = coalesce(first_opened_at, pg_catalog.now()),
         last_opened_at = pg_catalog.now()
   where id = p_link_id;
$$;

-- Página pública do termo: igual à de 20260926120000, mais o registro de que o
-- link foi aberto. Deixou de ser STABLE porque agora grava.
-- ⚠️ Quem recriar esta função precisa manter a chamada a
-- lesson_recording_note_link_opened (o teste termo_de_registro_envio_em_lote
-- reprova sem ela).
create or replace function public.get_lesson_recording_consent_public(p_token text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_link private.lesson_recording_consent_links;
  v_term private.lesson_recording_terms;
  v_student_name text;
  v_school_name text;
begin
  if coalesce(p_token, '') !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('found', false);
  end if;
  select * into v_link
  from private.lesson_recording_consent_links
  where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
  if not found or v_link.revoked_at is not null or v_link.expires_at <= pg_catalog.now() then
    return jsonb_build_object('found', false, 'expired', found);
  end if;

  perform private.lesson_recording_note_link_opened(v_link.id);

  v_term := private.lesson_recording_current_term('STUDENT');
  select split_part(btrim(student.full_name), ' ', 1) into v_student_name
  from public.profiles as student where student.id = v_link.student_id;
  select tenant.name into v_school_name from public.tenants as tenant where tenant.id = v_link.tenant_id;

  return jsonb_build_object(
    'found', true,
    'school_name', v_school_name,
    'student_first_name', v_student_name,
    'requires_guardian', private.lesson_recording_requires_guardian(v_link.student_id),
    'term_version', v_term.version,
    'term_body', v_term.body,
    'current_decision', private.lesson_recording_consent_state(v_link.student_id),
    'expires_at', v_link.expires_at
  );
end;
$$;

do $owners$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'private.lesson_recording_is_direction(text)',
    'private.lesson_recording_request_target(uuid)',
    'private.lesson_recording_request_roster(text)',
    'private.lesson_recording_send_slot(timestamp with time zone)',
    'private.lesson_recording_send_slots(timestamp with time zone,integer)',
    'private.lesson_recording_batch_start(text)',
    'private.lesson_recording_request_message(text,text,text,text,boolean)',
    'private.lesson_recording_enqueue_request(text,uuid,text,text,text,integer,uuid,text,text,boolean,timestamp with time zone,uuid)',
    'private.lesson_recording_batch_candidates(text)',
    'private.lesson_recording_note_link_opened(uuid)',
    'public.preview_lesson_recording_consent_batch()',
    'public.enqueue_lesson_recording_consent_batch(integer)',
    'public.resend_lesson_recording_consent_request(uuid)',
    'public.list_lesson_recording_consent_requests()',
    'public.get_lesson_recording_consent_request_snapshot(uuid)',
    'public.get_lesson_recording_consent_public(text)'
  ] loop
    execute pg_catalog.format('alter function %s owner to postgres', v_signature);
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
  end loop;
end
$owners$;

-- Direção e coordenação (a checagem de papel e escola é interna).
grant execute on function public.preview_lesson_recording_consent_batch() to authenticated;
grant execute on function public.enqueue_lesson_recording_consent_batch(integer) to authenticated;
grant execute on function public.resend_lesson_recording_consent_request(uuid) to authenticated;
grant execute on function public.list_lesson_recording_consent_requests() to authenticated;
-- Processador da fila.
grant execute on function public.get_lesson_recording_consent_request_snapshot(uuid) to service_role;
-- Rota do link público (já existia; a recriação mantém as mesmas permissões).
grant execute on function public.get_lesson_recording_consent_public(text) to anon, authenticated;
