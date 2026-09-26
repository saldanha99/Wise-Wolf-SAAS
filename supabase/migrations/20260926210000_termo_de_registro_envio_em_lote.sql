-- Termo de registro das aulas: envio em lote pelo número central da escola e
-- acompanhamento de quem não respondeu.
--
-- ⚠️ Depende de 20260926200000_termo_seguro_do_aluno (idade atestada pela
-- escola, telefones congelados no link, código de 6 dígitos para decidir).
-- As duas saem no mesmo release, nesta ordem; esta NÃO recria nada daquela
-- migration: usa as funções dela e só acrescenta o registro de abertura à
-- página pública por âncora (bloco no fim do arquivo).
--
-- Antes (20260926120000) o painel "Autorizações de registro" só gerava o link
-- aluno por aluno, e a direção copiava e mandava na mão. Aqui:
--
-- - a direção clica em "Enviar termo aos alunos pendentes", vê quantas
--   mensagens e até quando elas saem, e confirma. NADA é enviado no deploy;
-- - cada aluno ATIVO sem decisão que valha na versão vigente ganha um link
--   próprio e uma linha na notification_queue (kind
--   LESSON_RECORDING_CONSENT_REQUEST), idempotente por aluno + versão do termo
--   (+ número da tentativa, para o reenvio);
-- - o link guarda os telefones do cadastro (student_phone/guardian_phone, as
--   colunas de 20260926200000): a mensagem e o código de confirmação vão para
--   o MESMO número;
-- - para quem vai é a regra de 20260926200000: sem data de nascimento atestada
--   pela escola, responde o responsável. O telefone do responsável só vale se
--   a escola verificou o contato, ou se quem gravou por último não foi o
--   próprio aluno e não é o número dele (o aluno pode editar o próprio
--   cadastro pela API). Sem isso, o aluno aparece como "sem contato";
-- - o envio é ESPALHADO: uma mensagem a cada 3 minutos (no máximo 5 a cada
--   15 min), só de segunda a sábado, das 9h às 20h (horário de Brasília). A
--   janela e o ritmo valem NA HORA DE MANDAR, não só no agendamento: o
--   processador adia (sem gastar tentativa) o que cair fora dela e descarta o
--   pedido que passou 2 dias na fila. O número da escola foi restringido pelo
--   WhatsApp em 17/09/2026 depois de ~130 mensagens automáticas em 7 h;
-- - o processador revalida tudo na hora de mandar
--   (get_lesson_recording_consent_request_snapshot): quem respondeu, revogou,
--   saiu da escola, trocou de contato, teve o link substituído ou viu o termo
--   mudar de versão NÃO recebe a mensagem;
-- - um link vivo por aluno: o pedido novo revoga os links anteriores. O lote
--   pula quem tem link gerado à mão há menos de 3 dias (a direção acabou de
--   mandar); o "Enviar"/"Reenviar" de um aluno é explícito e substitui;
-- - "Reenviar" só 3 dias depois do último envio que saiu; mensagem que não
--   saiu, ou contato que mudou desde o último envio, libera na hora;
-- - o link usa o portal da escola (domínio próprio verificado ou o portal
--   oficial da Wise Wolf); escola sem portal conhecido não envia em lote;
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

-- Portal onde a família abre o link. Mesma prioridade de
-- resolveTenantCommunicationIdentity (_shared/tenant-communication.ts), mas só
-- os ramos que se sabe existir: domínio próprio VERIFICADO, ou o portal
-- oficial para a Wise Wolf. `tenants.domain`/subdomínio do slug não entram —
-- em 26/09/2026 as outras escolas tinham domínios de exemplo (royal.school.com)
-- e "wisewolf.wisewolflanguage.com.br" nem existe no DNS. Sem portal, nulo, e
-- o lote é recusado em vez de mandar link que não abre.
create or replace function private.lesson_recording_portal_url(p_tenant text)
returns text
language sql stable security definer set search_path = '' as $$
  select case
    when tenant.custom_domain_verified is true
      and pg_catalog.lower(pg_catalog.btrim(coalesce(tenant.custom_domain, '')))
        ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
      then 'https://' || pg_catalog.lower(pg_catalog.btrim(tenant.custom_domain))
    when tenant.id = 'school-wise-wolf'
      or pg_catalog.lower(pg_catalog.btrim(coalesce(tenant.slug, ''))) in ('wisewolf', 'system')
      then 'https://system.wisewolflanguage.com.br'
  end
  from public.tenants as tenant
  where tenant.id = p_tenant;
$$;

-- O último valor do campo foi gravado pelo próprio aluno? Lê a trilha genérica
-- de profiles (audit_logs, trigger trg_audit_profiles, com o auth.uid() de
-- quem gravou). Sem trilha (valor antigo, cadastro pela escola ou por service
-- role), não.
create or replace function private.lesson_recording_field_written_by_student(p_student uuid, p_field text)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select log.user_id = p_student
    from public.audit_logs as log
    where log.resource_type = 'profiles'
      and log.resource_id = p_student::text
      and (
        (log.action = 'UPDATE' and log.diff ? p_field)
        or (log.action = 'INSERT' and log.new_values ->> p_field is not null)
      )
    order by log.created_at desc
    limit 1
  ), false);
$$;

-- Telefone do responsável em que a escola pode confiar para mandar o termo e
-- o código: (1) contato GUARDIAN verificado pela escola; (2) guardian_phone
-- do cadastro, se quem gravou por último não foi o próprio aluno e não é o
-- número dele; (3) telefone do perfil de guardian_id, da MESMA escola, ativo,
-- vínculo não gravado pelo próprio aluno e diferente do número dele.
create or replace function private.lesson_recording_trusted_guardian_phone(p_student uuid)
returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_student public.profiles;
  v_own text[];
  v_phone text;
begin
  select * into v_student from public.profiles where id = p_student;
  if not found then
    return null;
  end if;
  v_own := array_remove(array[
    private.lesson_recording_normalize_phone(v_student.phone),
    private.lesson_recording_normalize_phone(v_student.attendance_phone)
  ], null);

  select private.lesson_recording_normalize_phone(contact.phone) into v_phone
  from public.student_quality_contacts as contact
  where contact.student_id = p_student
    and contact.tenant_id = v_student.tenant_id
    and contact.relationship = 'GUARDIAN'
    and contact.active and contact.verified_at is not null
  order by contact.verified_at desc
  limit 1;
  if v_phone is not null then
    return v_phone;
  end if;

  v_phone := private.lesson_recording_normalize_phone(v_student.guardian_phone);
  if v_phone is not null
     and not exists (
       select 1 from unnest(v_own) as own(phone)
       where private.notification_phones_same_recipient(own.phone, v_phone)
     )
     and not private.lesson_recording_field_written_by_student(p_student, 'guardian_phone') then
    return v_phone;
  end if;

  select private.lesson_recording_normalize_phone(guardian.phone) into v_phone
  from public.profiles as guardian
  where guardian.id = v_student.guardian_id
    and guardian.id <> v_student.id
    and guardian.tenant_id = v_student.tenant_id
    and pg_catalog.lower(pg_catalog.btrim(coalesce(guardian.lifecycle_status, ''))) = 'active';
  if v_phone is not null
     and not exists (
       select 1 from unnest(v_own) as own(phone)
       where private.notification_phones_same_recipient(own.phone, v_phone)
     )
     and not private.lesson_recording_field_written_by_student(p_student, 'guardian_id') then
    return v_phone;
  end if;
  return null;
end;
$$;

-- Para quem vai o termo do aluno e em que número, e os dois telefones que o
-- link guarda para o código. Quem responde é a regra de 20260926200000
-- (lesson_recording_guardian_reason: sem idade atestada pela escola, o
-- responsável); o telefone do aluno é o mesmo helper do link manual.
create or replace function private.lesson_recording_request_target(p_student uuid)
returns table (
  recipient text,
  destination text,
  missing_reason text,
  student_phone text,
  guardian_phone text
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_reason text;
  v_student_phone text;
  v_guardian_phone text;
begin
  if not exists (select 1 from public.profiles where id = p_student) then
    return query select null::text, null::text, 'aluno_nao_encontrado'::text, null::text, null::text;
    return;
  end if;

  v_reason := private.lesson_recording_guardian_reason(p_student);
  v_student_phone := private.lesson_recording_student_phone(p_student);
  v_guardian_phone := private.lesson_recording_trusted_guardian_phone(p_student);

  if v_reason is not null then
    return query select 'GUARDIAN'::text, v_guardian_phone,
      case
        when v_guardian_phone is not null then null
        -- Há telefone de responsável no cadastro, mas foi o próprio aluno que
        -- gravou (ou é o número dele): a escola confirma antes.
        when private.lesson_recording_guardian_phone(p_student) is not null then 'responsavel_nao_confirmado'
        when v_reason = 'AGE_UNKNOWN' then 'idade_nao_cadastrada'
        else 'menor_sem_telefone_do_responsavel'
      end,
      v_student_phone, v_guardian_phone;
    return;
  end if;

  return query select 'STUDENT'::text, v_student_phone,
    case when v_student_phone is null then 'sem_telefone' end,
    v_student_phone, v_guardian_phone;
end;
$$;

-- Alunos ativos da escola e a situação de cada um diante do termo vigente.
-- "eligible": nunca decidiu; aceitou versão anterior (term_updated); ou o
-- aceite da versão vigente não vale para marcar aula (sem código, ou dado
-- "como aluno" por quem hoje exige responsável — reconfirm). Quem recusou ou
-- teve a autorização revogada NÃO é chamado de novo.
-- manual_link_at: link vivo gerado à mão (sem pedido do lote por trás).
create or replace function private.lesson_recording_request_roster(p_tenant text)
returns table (
  student_id uuid,
  full_name text,
  decision text,
  decided_at timestamptz,
  eligible boolean,
  term_updated boolean,
  reconfirm boolean,
  recipient text,
  destination text,
  missing_reason text,
  student_phone text,
  guardian_phone text,
  manual_link_at timestamptz
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
    case
      when last_decision.decision is null then true
      when last_decision.decision in ('REFUSED', 'REVOKED') then false
      when last_decision.term_version is distinct from term.version then true
      else not private.lesson_recording_student_consent_effective(student.id)
    end,
    coalesce(last_decision.decision = 'ACCEPTED'
      and last_decision.term_version is distinct from term.version, false),
    coalesce(last_decision.decision = 'ACCEPTED'
      and last_decision.term_version is not distinct from term.version
      and not private.lesson_recording_student_consent_effective(student.id), false),
    target.recipient,
    target.destination,
    target.missing_reason,
    target.student_phone,
    target.guardian_phone,
    manual.created_at
  from public.profiles as student
  cross join term
  left join lateral (
    select consent.decision, consent.decided_at, consent.term_version
    from private.lesson_recording_consents as consent
    where consent.subject_id = student.id
    order by consent.seq desc
    limit 1
  ) as last_decision on true
  left join lateral (
    select max(link.created_at) as created_at
    from private.lesson_recording_consent_links as link
    where link.student_id = student.id
      and link.tenant_id = p_tenant
      and link.revoked_at is null
      and link.expires_at > pg_catalog.now()
      and not exists (
        select 1 from private.lesson_recording_consent_requests as request
        where request.link_id = link.id
      )
  ) as manual on true
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

-- Onde começa o próximo lote: daqui a 2 minutos, ou 3 minutos depois do
-- último pedido de termo da escola — o que ainda está na fila (pelo horário
-- em que vai sair) E o que já saiu nos últimos 15 minutos. Sem o que saiu,
-- um clique logo depois do fim de um lote encavalava o próximo nele.
-- Arredonda para CIMA no minuto: arredondar para baixo encurtaria o intervalo.
create or replace function private.lesson_recording_batch_start(p_tenant text)
returns timestamptz
language sql stable security definer set search_path = '' as $$
  with last_message as (
    select max(
      case
        when queue.status in ('pending', 'processing')
          then greatest(queue.scheduled_for, coalesce(queue.next_attempt_at, queue.scheduled_for))
        else coalesce(queue.accepted_at, queue.sent_at, queue.scheduled_for)
      end
    ) + interval '3 minutes' as after_last
    from public.notification_queue as queue
    where queue.tenant_id = p_tenant
      and queue.notification_kind = 'LESSON_RECORDING_CONSENT_REQUEST'
      and (
        queue.status in ('pending', 'processing')
        or coalesce(queue.accepted_at, queue.sent_at, queue.scheduled_for)
          > pg_catalog.now() - interval '15 minutes'
      )
  ), candidate as (
    select greatest(
      pg_catalog.now() + interval '2 minutes',
      coalesce(last_message.after_last, '-infinity'::timestamptz)
    ) as at
    from last_message
  )
  select case
    when candidate.at = pg_catalog.date_trunc('minute', candidate.at) then candidate.at
    else pg_catalog.date_trunc('minute', candidate.at) + interval '1 minute'
  end
  from candidate;
$$;

-- Texto curto; o termo completo está no link. Não promete nada que o termo
-- (v2) não diga: transcrição sem vídeo, registro e continuidade, confirmação de
-- que a aula aconteceu, aula normal sem autorização, dá para mudar de ideia.
-- O código de 6 dígitos vai para o número que recebe esta mensagem (é o
-- telefone guardado no link). p_context: NEW, TERM_UPDATED ou RECONFIRM.
create or replace function private.lesson_recording_request_message(
  p_student_name text,
  p_school_name text,
  p_portal text,
  p_token text,
  p_recipient text,
  p_context text
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
  if coalesce(p_portal, '') !~ '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' then
    raise exception 'portal_da_escola_indefinido' using errcode = '22023';
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
  if p_context = 'TERM_UPDATED' then
    v_opening := v_opening || ' O termo foi atualizado desde a sua última resposta.';
  elsif p_context = 'RECONFIRM' then
    v_opening := v_opening || case when p_recipient = 'GUARDIAN'
      then ' A autorização registrada antes não foi dada pelo responsável e precisa ser confirmada por você.'
      else ' A resposta registrada antes precisa ser confirmada com o código do WhatsApp.'
    end;
  end if;

  return concat_ws(E'\n\n',
    v_opening,
    'Com ela, o Google Meet transcreve a aula (sem vídeo) para registrar o que foi trabalhado, dar continuidade ao aprendizado e confirmar que a aula aconteceu.',
    'Termo completo e resposta (leva 1 minuto): ' || p_portal || '/registro-das-aulas?token=' || p_token,
    'Para confirmar, a página envia um código de 6 dígitos para este WhatsApp.',
    'Sem autorização, a aula acontece normalmente, só que sem transcrição. Dá para mudar de ideia quando quiser.'
  );
end;
$$;

-- Cria o link e a mensagem de UM aluno e põe na fila. Chamado pelo lote e pelo
-- reenvio, já com a trava da escola. O link guarda os telefones do cadastro
-- (o código de confirmação vai para o telefone do destinatário, o mesmo desta
-- mensagem) e passa a ser o ÚNICO vivo do aluno: os anteriores (outro envio,
-- link gerado à mão) são revogados — um número errado corrigido não continua
-- com um link que decide pelo aluno.
create or replace function private.lesson_recording_enqueue_request(
  p_tenant text,
  p_student uuid,
  p_student_name text,
  p_school_name text,
  p_portal text,
  p_term_version text,
  p_attempt integer,
  p_batch uuid,
  p_recipient text,
  p_destination text,
  p_student_phone text,
  p_guardian_phone text,
  p_context text,
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
  -- A mensagem e o código precisam ir para o mesmo número.
  if p_recipient not in ('STUDENT', 'GUARDIAN')
     or p_destination is null
     or p_destination is distinct from
       (case p_recipient when 'GUARDIAN' then p_guardian_phone else p_student_phone end) then
    raise exception 'destino_diferente_do_link' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.notification_queue as queue
    where queue.tenant_id = p_tenant and queue.idempotency_key = v_key
  ) then
    return null;
  end if;

  insert into private.lesson_recording_consent_links (
    tenant_id, student_id, token_hash, created_by, expires_at, student_phone, guardian_phone
  ) values (
    p_tenant, p_student, encode(extensions.digest(v_token, 'sha256'), 'hex'), p_actor,
    p_slot + interval '30 days', p_student_phone, p_guardian_phone
  )
  returning id into v_link;

  v_message := private.lesson_recording_request_message(
    p_student_name, p_school_name, p_portal, v_token, p_recipient, p_context
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

  -- Um link vivo por aluno (mesma regra de create_lesson_recording_consent_link).
  update private.lesson_recording_consent_links
     set revoked_at = pg_catalog.now()
   where student_id = p_student and revoked_at is null and id <> v_link;

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

-- Quem pode entrar num lote (antes do teto de 60): ativo, pode ser chamado,
-- tem contato, ainda não recebeu pedido desta versão e não tem link gerado à
-- mão há menos de 3 dias.
create or replace function private.lesson_recording_batch_pool(p_tenant text)
returns table (
  student_id uuid,
  full_name text,
  recipient text,
  destination text,
  student_phone text,
  guardian_phone text,
  term_updated boolean,
  reconfirm boolean,
  has_contact boolean,
  recent_manual_link boolean
)
language sql stable security definer set search_path = '' as $$
  select roster.student_id, roster.full_name, roster.recipient, roster.destination,
         roster.student_phone, roster.guardian_phone, roster.term_updated, roster.reconfirm,
         roster.destination is not null,
         coalesce(roster.manual_link_at > pg_catalog.now() - interval '3 days', false)
  from private.lesson_recording_request_roster(p_tenant) as roster
  where roster.eligible
    and not exists (
      select 1
      from private.lesson_recording_consent_requests as request
      where request.student_id = roster.student_id
        and request.term_version = (select current_term.version
          from private.lesson_recording_current_term('STUDENT') as current_term)
    );
$$;

-- Quem entra no lote: até 60 por clique (~3 h de janela).
create or replace function private.lesson_recording_batch_candidates(p_tenant text)
returns table (
  student_id uuid,
  full_name text,
  recipient text,
  destination text,
  student_phone text,
  guardian_phone text,
  term_updated boolean,
  reconfirm boolean
)
language sql stable security definer set search_path = '' as $$
  select pool.student_id, pool.full_name, pool.recipient, pool.destination,
         pool.student_phone, pool.guardian_phone, pool.term_updated, pool.reconfirm
  from private.lesson_recording_batch_pool(p_tenant) as pool
  where pool.has_contact and not pool.recent_manual_link
  order by pool.full_name, pool.student_id
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
  v_reconfirm integer;
  v_no_contact integer;
  v_manual integer;
  v_total_pending integer;
  v_slots timestamptz[];
begin
  if v_tenant is null or not private.lesson_recording_is_direction(v_tenant) then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;

  select count(*), count(*) filter (where candidate.recipient = 'GUARDIAN'),
         count(*) filter (where candidate.term_updated),
         count(*) filter (where candidate.reconfirm)
    into v_count, v_guardians, v_updated, v_reconfirm
  from private.lesson_recording_batch_candidates(v_tenant) as candidate;

  select count(*) filter (where not pool.has_contact),
         count(*) filter (where pool.has_contact and pool.recent_manual_link),
         count(*) filter (where pool.has_contact and not pool.recent_manual_link)
    into v_no_contact, v_manual, v_total_pending
  from private.lesson_recording_batch_pool(v_tenant) as pool;

  v_slots := private.lesson_recording_send_slots(private.lesson_recording_batch_start(v_tenant), v_count);
  return jsonb_build_object(
    'ok', true,
    'term_version', (select current_term.version from private.lesson_recording_current_term('STUDENT') as current_term),
    'to_send', v_count,
    'to_guardians', v_guardians,
    'term_updated', v_updated,
    'reconfirm', v_reconfirm,
    'no_contact', v_no_contact,
    'manual_link_recent', v_manual,
    'left_for_next_batch', greatest(v_total_pending - v_count, 0),
    'first_at', v_slots[1],
    'last_at', v_slots[v_count],
    'portal_ok', private.lesson_recording_portal_url(v_tenant) is not null,
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
  v_portal text;
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
  v_portal := private.lesson_recording_portal_url(v_tenant);
  if v_portal is null then
    raise exception 'portal_da_escola_indefinido' using errcode = '22023';
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
      v_tenant, v_row.student_id, v_row.full_name, v_school, v_portal, v_term.version, 1, v_batch,
      v_row.recipient, v_row.destination, v_row.student_phone, v_row.guardian_phone,
      case when v_row.term_updated then 'TERM_UPDATED' when v_row.reconfirm then 'RECONFIRM' else 'NEW' end,
      v_slots[v_position], v_actor
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
-- que saiu; na hora se o anterior não saiu (sem contato, link substituído,
-- falha) ou se o destinatário/número mudou desde ele. Nunca para quem recusou
-- ou revogou. O link anterior (do lote ou gerado à mão) deixa de valer.
create or replace function public.resend_lesson_recording_consent_request(p_student_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant text := public._my_tenant_id();
  v_actor uuid := (select auth.uid());
  v_term private.lesson_recording_terms;
  v_school text;
  v_portal text;
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
  v_portal := private.lesson_recording_portal_url(v_tenant);
  if v_portal is null then
    raise exception 'portal_da_escola_indefinido' using errcode = '22023';
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
  select request.attempt, request.created_at, request.recipient, request.destination,
         queue.status, queue.delivery_status, queue.accepted_at, queue.updated_at
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
      -- Número ou destinatário mudou desde o último envio: o anterior foi
      -- para outro lugar, o novo sai na hora (e o link antigo é revogado).
      when v_last.recipient is distinct from v_roster.recipient
        or not private.notification_phones_same_recipient(v_last.destination, v_roster.destination) then null
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
    v_tenant, p_student_id, v_roster.full_name, v_school, v_portal, v_term.version,
    coalesce(v_last.attempt, 0) + 1, extensions.gen_random_uuid(),
    v_roster.recipient, v_roster.destination, v_roster.student_phone, v_roster.guardian_phone,
    case when v_roster.term_updated then 'TERM_UPDATED' when v_roster.reconfirm then 'RECONFIRM' else 'NEW' end,
    v_slot, v_actor
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
    'portal_ok', private.lesson_recording_portal_url(v_tenant) is not null,
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
          'reconfirm', roster.reconfirm,
          'recipient', roster.recipient,
          'contact_last4', right(roster.destination, 4),
          'missing_reason', roster.missing_reason,
          'manual_link_at', roster.manual_link_at,
          'request', case when last_request.id is null then null else jsonb_build_object(
            'attempt', last_request.attempt,
            'requested_at', last_request.created_at,
            'scheduled_for', last_request.scheduled_for,
            'next_attempt_at', last_request.next_attempt_at,
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
            when last_request.recipient is distinct from roster.recipient
              or not private.notification_phones_same_recipient(last_request.destination, roster.destination)
              then pg_catalog.now()
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
                 queue.next_attempt_at,
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

-- Revalidação na hora de mandar, com o relógio explícito (o teste fixa o
-- horário; o processador passa now()). Ordem: primeiro o que CANCELA a
-- mensagem (skipped, sem nova tentativa), depois o que só a ADIA (janela e
-- ritmo — defer_seconds, o processador devolve a vaga sem gastar tentativa).
create or replace function private.lesson_recording_request_snapshot_at(
  p_notification_id uuid,
  p_now timestamptz
)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_queue public.notification_queue;
  v_request private.lesson_recording_consent_requests;
  v_link private.lesson_recording_consent_links;
  v_term private.lesson_recording_terms;
  v_roster record;
  v_token text;
  v_portal text;
  v_slot timestamptz;
  v_recent timestamptz[];
  v_wait_until timestamptz;
begin
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
  if v_link.id is null or v_link.revoked_at is not null or v_link.expires_at <= p_now
     or v_token is null
     or v_link.token_hash <> encode(extensions.digest(v_token, 'sha256'), 'hex') then
    return jsonb_build_object('ok', false, 'reason', 'link_substituido_ou_vencido');
  end if;
  -- O código de confirmação vai para o telefone guardado no link: se não é o
  -- desta mensagem, a família receberia o código em outro número.
  if (case v_request.recipient when 'GUARDIAN' then v_link.guardian_phone else v_link.student_phone end)
       is distinct from v_request.destination then
    return jsonb_build_object('ok', false, 'reason', 'link_sem_telefone_do_pedido');
  end if;
  if encode(extensions.digest(v_queue.message_body, 'sha256'), 'hex') <> v_request.message_sha256 then
    return jsonb_build_object('ok', false, 'reason', 'mensagem_alterada');
  end if;
  v_portal := private.lesson_recording_portal_url(v_queue.tenant_id);
  if v_portal is null then
    return jsonb_build_object('ok', false, 'reason', 'portal_da_escola_indefinido');
  end if;
  if pg_catalog.strpos(v_queue.message_body, v_portal || '/registro-das-aulas?token=' || v_token) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'portal_mudou');
  end if;
  -- Fila parada (instância desconectada, teto do dia, cron fora) não vira
  -- rajada dias depois: passou de 2 dias do horário marcado, cancela; a lista
  -- libera o reenvio na hora.
  if v_request.scheduled_for < p_now - interval '2 days' then
    return jsonb_build_object('ok', false, 'reason', 'pedido_vencido');
  end if;

  -- Janela: só de segunda a sábado, das 9h às 20h — também na hora de mandar.
  v_slot := private.lesson_recording_send_slot(p_now);
  if v_slot > p_now then
    return jsonb_build_object(
      'ok', false, 'retryable', true, 'reason', 'fora_da_janela_de_envio',
      'defer_seconds', ceil(extract(epoch from v_slot - p_now))::integer
    );
  end if;

  -- Ritmo: no máximo 5 termos da escola em 15 minutos, e pelo menos 2min30
  -- do anterior (a folga de 30 s é o passo do cron; com 3 min cheios cada
  -- mensagem atrasaria um minuto a mais que a anterior). Conta o que o
  -- provedor aceitou e o que está sendo entregue agora.
  select coalesce(array_agg(sent.at order by sent.at desc), '{}')
    into v_recent
  from (
    select coalesce(queue.accepted_at, queue.sent_at, queue.updated_at) as at
    from public.notification_queue as queue
    where queue.tenant_id = v_queue.tenant_id
      and queue.notification_kind = 'LESSON_RECORDING_CONSENT_REQUEST'
      and queue.id <> v_queue.id
      and (queue.accepted_at is not null or queue.sent_at is not null
        or queue.delivery_status in ('submitting', 'uncertain'))
  ) as sent
  where sent.at > p_now - interval '15 minutes' and sent.at <= p_now;

  v_wait_until := null;
  if cardinality(v_recent) >= 1 and v_recent[1] > p_now - interval '150 seconds' then
    v_wait_until := v_recent[1] + interval '150 seconds';
  end if;
  if cardinality(v_recent) >= 5 then
    v_wait_until := greatest(v_wait_until, v_recent[5] + interval '15 minutes');
  end if;
  if v_wait_until is not null and v_wait_until > p_now then
    return jsonb_build_object(
      'ok', false, 'retryable', true, 'reason', 'ritmo_do_termo',
      'defer_seconds', greatest(1, ceil(extract(epoch from v_wait_until - p_now))::integer)
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'destination', v_queue.student_phone,
    'message', v_queue.message_body,
    'portal', v_portal
  );
end;
$$;

-- Porta do processador da fila (service role).
create or replace function public.get_lesson_recording_consent_request_snapshot(p_notification_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  return private.lesson_recording_request_snapshot_at(p_notification_id, pg_catalog.now());
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

do $owners$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'private.lesson_recording_is_direction(text)',
    'private.lesson_recording_portal_url(text)',
    'private.lesson_recording_field_written_by_student(uuid,text)',
    'private.lesson_recording_trusted_guardian_phone(uuid)',
    'private.lesson_recording_request_target(uuid)',
    'private.lesson_recording_request_roster(text)',
    'private.lesson_recording_send_slot(timestamp with time zone)',
    'private.lesson_recording_send_slots(timestamp with time zone,integer)',
    'private.lesson_recording_batch_start(text)',
    'private.lesson_recording_request_message(text,text,text,text,text,text)',
    'private.lesson_recording_enqueue_request(text,uuid,text,text,text,text,integer,uuid,text,text,text,text,text,timestamp with time zone,uuid)',
    'private.lesson_recording_batch_pool(text)',
    'private.lesson_recording_batch_candidates(text)',
    'private.lesson_recording_request_snapshot_at(uuid,timestamp with time zone)',
    'private.lesson_recording_note_link_opened(uuid)',
    'public.preview_lesson_recording_consent_batch()',
    'public.enqueue_lesson_recording_consent_batch(integer)',
    'public.resend_lesson_recording_consent_request(uuid)',
    'public.list_lesson_recording_consent_requests()',
    'public.get_lesson_recording_consent_request_snapshot(uuid)'
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

-- Página pública do termo: registra que o link foi aberto (a lista mostra
-- "aberto?"). Remendo por ÂNCORA sobre a definição viva — a de
-- 20260926200000 (motivo do responsável, telefones mascarados) —, sem
-- recriá-la a partir de um texto antigo: recriar apagaria em silêncio o que a
-- outra migration pôs ali. Deixa de ser STABLE porque grava (o PostgREST roda
-- função STABLE em transação só leitura). Âncora sumiu = a migration para e
-- avisa, em vez de publicar a página sem o registro.
-- ⚠️ Quem recriar esta função depois precisa manter a chamada a
-- lesson_recording_note_link_opened e o VOLATILE (o teste
-- termo_de_registro_envio_em_lote reprova sem eles).
do $public_page$
declare
  v_definition text;
  v_anchor text := E'''expired'', found);\n  end if;\n';
begin
  select pg_catalog.pg_get_functiondef(
    'public.get_lesson_recording_consent_public(text)'::pg_catalog.regprocedure
  ) into v_definition;
  if v_definition is null
     or pg_catalog.strpos(v_definition, 'private.lesson_recording_consent_links') = 0 then
    raise exception 'get_lesson_recording_consent_public_definition_changed';
  end if;

  if pg_catalog.strpos(v_definition, 'lesson_recording_note_link_opened') = 0 then
    if (pg_catalog.length(v_definition)
        - pg_catalog.length(pg_catalog.replace(v_definition, v_anchor, '')))
        / pg_catalog.length(v_anchor) <> 1 then
      raise exception 'get_lesson_recording_consent_public_anchor_changed';
    end if;
    v_definition := pg_catalog.replace(
      v_definition,
      v_anchor,
      v_anchor || E'\n  -- A lista do envio em lote mostra se o link foi aberto (20260926210000).\n'
        || E'  perform private.lesson_recording_note_link_opened(v_link.id);\n'
    );
  end if;
  v_definition := pg_catalog.replace(
    v_definition, E'\n STABLE SECURITY DEFINER', E'\n VOLATILE SECURITY DEFINER'
  );
  execute v_definition;
end
$public_page$;
