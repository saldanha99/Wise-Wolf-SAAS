-- Termo de registro das aulas: autorização permanente do aluno (ou do
-- responsável) e do professor para a documentação pedagógica do Meet.
--
-- A integração de 12/09 (20260912203245) só cria sala e importa transcrição
-- de sessão com lesson_sessions.documentation_consent = true, e hoje essa
-- marca é manual, aula por aula (set_lesson_documentation_consent). Com ~400
-- aulas por mês isso não escala. Aqui:
--
-- - o aluno maior de idade ou o responsável aceita UMA vez por um link;
-- - o professor aceita UMA vez dentro do app;
-- - a cada 15 minutos (no mesmo job que prepara as salas), as sessões das
--   próximas 24 h cujo aluno E professor aceitaram recebem a marca, com um
--   evento de consentimento que cita o termo; quem revogar tem as sessões
--   futuras desmarcadas.
--
-- Só age com a conta Google da escola CONECTADA: antes disso não há sala a
-- criar, e marcar a sessão a congelaria (vira evidência) à toa.
-- Decisões são linhas novas (aceite, recusa, revogação); nada é apagado.

create table if not exists private.lesson_recording_terms (
  audience text not null check (audience in ('STUDENT', 'TEACHER')),
  version text not null check (version ~ '^v[0-9]+$'),
  body text not null check (length(body) between 200 and 20000),
  published_at timestamptz not null default now(),
  primary key (audience, version)
);

create table if not exists private.lesson_recording_consent_links (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id text not null references public.tenants(id),
  student_id uuid not null references public.profiles(id),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index if not exists lesson_recording_consent_links_student_idx
  on private.lesson_recording_consent_links(tenant_id, student_id, created_at desc);

create table if not exists private.lesson_recording_consents (
  seq bigint generated always as identity primary key,
  tenant_id text not null references public.tenants(id),
  subject_id uuid not null references public.profiles(id),
  subject_role text not null check (subject_role in ('STUDENT', 'TEACHER')),
  decision text not null check (decision in ('ACCEPTED', 'REFUSED', 'REVOKED')),
  signer_name text not null check (length(btrim(signer_name)) between 3 and 120),
  signer_relation text not null check (signer_relation in ('SELF', 'GUARDIAN', 'SCHOOL')),
  term_audience text,
  term_version text,
  source text not null check (source in ('LINK', 'APP', 'SCHOOL')),
  link_id uuid references private.lesson_recording_consent_links(id),
  recorded_by uuid references public.profiles(id),
  reason text check (reason is null or length(reason) <= 2000),
  signer_ip text check (signer_ip is null or length(signer_ip) <= 64),
  signer_user_agent text check (signer_user_agent is null or length(signer_user_agent) <= 300),
  decided_at timestamptz not null default now(),
  foreign key (term_audience, term_version)
    references private.lesson_recording_terms(audience, version),
  check (
    (decision = 'REVOKED' and source = 'SCHOOL' and signer_relation = 'SCHOOL')
    or (decision <> 'REVOKED' and term_version is not null and term_audience = subject_role)
  )
);
create index if not exists lesson_recording_consents_subject_idx
  on private.lesson_recording_consents(subject_id, seq desc);
create index if not exists lesson_recording_consents_tenant_idx
  on private.lesson_recording_consents(tenant_id, decided_at desc);

-- As funções abaixo têm dono postgres (SECURITY DEFINER sem superusuário);
-- as tabelas também, senão elas não conseguiriam ler o que gravam.
alter table private.lesson_recording_terms owner to postgres;
alter table private.lesson_recording_consent_links owner to postgres;
alter table private.lesson_recording_consents owner to postgres;
alter table private.lesson_recording_terms enable row level security;
alter table private.lesson_recording_consent_links enable row level security;
alter table private.lesson_recording_consents enable row level security;
revoke all on private.lesson_recording_terms, private.lesson_recording_consent_links,
  private.lesson_recording_consents from public, anon, authenticated, service_role;

-- Textos v1. Mudar o texto = nova versão (linha nova), nunca update: o aceite
-- guarda a versão que a pessoa leu.
insert into private.lesson_recording_terms (audience, version, body) values
(
  'STUDENT', 'v1',
  $term$As aulas acontecem numa sala do Google Meet criada pela escola. Nessas salas, o Google transcreve a aula (converte em texto o que foi falado) e gera anotações automáticas. A aula não é gravada em vídeo.

Para que usamos
• Registrar o que foi trabalhado em cada aula, para dar continuidade ao aprendizado, inclusive se o aluno mudar de professor.
• Planejar as próximas aulas e acompanhar a evolução do aluno.
• Confirmar que a aula aconteceu: o Google informa a que horas cada participante entrou e saiu da sala.

Quem tem acesso
• O professor do aluno e a coordenação pedagógica da escola.
• O professor revisa o resumo antes de ele entrar na ficha do aluno.
• O Google processa os dados como fornecedor da escola (Google Workspace).

Por quanto tempo
• A transcrição completa fica guardada por até 90 dias.
• O resumo aprovado fica na ficha enquanto o aluno estudar na escola.

Menores de 18 anos
• Quem autoriza é o responsável legal.

Dá para mudar de ideia
• A qualquer momento, pelo mesmo link ou pedindo à escola pelo WhatsApp. As aulas seguintes deixam de ser transcritas; o que já foi registrado segue os prazos acima.

Sem autorização, a aula acontece normalmente, só que sem transcrição.$term$
),
(
  'TEACHER', 'v1',
  $term$As aulas da escola acontecem em salas do Google Meet criadas pela conta da escola, com você como coanfitrião. Nessas salas, o Google transcreve a aula e gera anotações automáticas. A aula não é gravada em vídeo. Depois da aula, você revisa o resumo antes de ele entrar na ficha do aluno.

Para que usamos
• Continuidade pedagógica do aluno, inclusive se ele mudar de professor.
• Planejamento das próximas aulas.
• Confirmação de que a aula aconteceu: o Google informa a que horas cada participante entrou e saiu da sala.

Como usamos
• Uma divergência (por exemplo, aula lançada sem ninguém na sala) vira um aviso para a coordenação conversar com você.
• Nada disso muda o seu pagamento automaticamente. Qualquer ajuste passa pela direção, como hoje.

Quem tem acesso
• A coordenação e a direção da escola; o professor que assumir o aluno recebe o dossiê pedagógico dele.

Por quanto tempo
• A transcrição completa fica guardada por até 90 dias; o resumo aprovado, enquanto o aluno estudar na escola.

Você pode revogar quando quiser, nesta mesma tela. A partir daí, as suas aulas deixam de ser transcritas.$term$
)
on conflict (audience, version) do nothing;

create or replace function private.lesson_recording_current_term(p_audience text)
returns private.lesson_recording_terms
language sql stable security definer set search_path = '' as $$
  select term.*
  from private.lesson_recording_terms as term
  where term.audience = p_audience
  order by term.published_at desc, term.version desc
  limit 1;
$$;

create or replace function private.lesson_recording_consent_state(p_subject uuid)
returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select consent.decision
    from private.lesson_recording_consents as consent
    where consent.subject_id = p_subject
    order by consent.seq desc
    limit 1
  ), 'NONE');
$$;

create or replace function private.lesson_recording_active(p_student uuid, p_teacher uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select private.lesson_recording_consent_state(p_student) = 'ACCEPTED'
    and private.lesson_recording_consent_state(p_teacher) = 'ACCEPTED';
$$;

-- Menor de idade decide pelo responsável: is_kids ou data de nascimento.
create or replace function private.lesson_recording_requires_guardian(p_student uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select coalesce(student.is_kids, false)
      or (student.birth_date is not null
        and student.birth_date > (pg_catalog.now() at time zone 'America/Sao_Paulo')::date - interval '18 years')
    from public.profiles as student
    where student.id = p_student
  ), false);
$$;

-- Evidência do aceite pelo link: IP e navegador informados pelo gateway.
-- Cabeçalho ausente ou malformado não impede o registro.
create or replace function private.lesson_recording_request_header(p_name text, p_limit integer)
returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_headers jsonb;
  v_value text;
begin
  begin
    v_headers := nullif(btrim(coalesce(pg_catalog.current_setting('request.headers', true), '')), '')::jsonb;
  exception when others then
    return null;
  end;
  v_value := btrim(split_part(coalesce(v_headers ->> p_name, ''), ',', 1));
  return nullif(left(v_value, p_limit), '');
end;
$$;

create or replace function public.create_lesson_recording_consent_link(p_student_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_student public.profiles;
  v_token text;
  v_expires timestamptz := pg_catalog.now() + interval '30 days';
begin
  select * into v_student from public.profiles where id = p_student_id;
  if not found or v_student.role <> 'STUDENT' then
    raise exception 'aluno_invalido' using errcode = '22023';
  end if;
  if not private.can_manage_lesson_quality(v_student.tenant_id) then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;

  -- Um link vivo por aluno: gerar outro invalida o anterior.
  update private.lesson_recording_consent_links
     set revoked_at = pg_catalog.now()
   where student_id = p_student_id and revoked_at is null;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into private.lesson_recording_consent_links (tenant_id, student_id, token_hash, created_by, expires_at)
  values (v_student.tenant_id, p_student_id, encode(extensions.digest(v_token, 'sha256'), 'hex'),
    (select auth.uid()), v_expires);

  return jsonb_build_object('ok', true, 'token', v_token, 'expires_at', v_expires);
end;
$$;

create or replace function public.get_lesson_recording_consent_public(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
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

create or replace function public.decide_lesson_recording_consent_public(
  p_token text,
  p_signer_name text,
  p_relation text,
  p_accept boolean
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_link private.lesson_recording_consent_links;
  v_term private.lesson_recording_terms;
  v_name text := btrim(regexp_replace(coalesce(p_signer_name, ''), '\s+', ' ', 'g'));
  v_decision text;
begin
  if p_accept is null or coalesce(p_token, '') !~ '^[a-f0-9]{64}$' then
    raise exception 'resposta_invalida' using errcode = '22023';
  end if;
  if coalesce(p_relation, '') not in ('SELF', 'GUARDIAN') then
    raise exception 'relacao_invalida' using errcode = '22023';
  end if;
  if length(v_name) < 5 or length(v_name) > 120 or v_name !~ '^\S+( \S+)+$' then
    raise exception 'nome_completo_obrigatorio' using errcode = '22023';
  end if;

  select * into v_link
  from private.lesson_recording_consent_links
  where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
  for update;
  if not found or v_link.revoked_at is not null or v_link.expires_at <= pg_catalog.now() then
    raise exception 'link_expirado' using errcode = '22023';
  end if;
  if p_relation = 'SELF' and private.lesson_recording_requires_guardian(v_link.student_id) then
    raise exception 'responsavel_obrigatorio' using errcode = '22023';
  end if;

  v_term := private.lesson_recording_current_term('STUDENT');
  v_decision := case when p_accept then 'ACCEPTED' else 'REFUSED' end;
  insert into private.lesson_recording_consents (
    tenant_id, subject_id, subject_role, decision, signer_name, signer_relation,
    term_audience, term_version, source, link_id, signer_ip, signer_user_agent
  ) values (
    v_link.tenant_id, v_link.student_id, 'STUDENT', v_decision, v_name, p_relation,
    'STUDENT', v_term.version, 'LINK', v_link.id,
    private.lesson_recording_request_header('x-forwarded-for', 64),
    private.lesson_recording_request_header('user-agent', 300)
  );

  return jsonb_build_object('ok', true, 'decision', v_decision);
end;
$$;

create or replace function public.get_my_lesson_recording_consent()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_me public.profiles;
  v_term private.lesson_recording_terms;
  v_last private.lesson_recording_consents;
begin
  select * into v_me from public.profiles where id = (select auth.uid());
  if not found or v_me.role <> 'TEACHER' then
    return jsonb_build_object('applies', false);
  end if;
  v_term := private.lesson_recording_current_term('TEACHER');
  select * into v_last from private.lesson_recording_consents
   where subject_id = v_me.id order by seq desc limit 1;
  return jsonb_build_object(
    'applies', true,
    'decision', coalesce(v_last.decision, 'NONE'),
    'decided_at', v_last.decided_at,
    'term_version', v_term.version,
    'term_body', v_term.body
  );
end;
$$;

create or replace function public.set_my_lesson_recording_consent(p_accept boolean)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_me public.profiles;
  v_term private.lesson_recording_terms;
  v_decision text;
begin
  if p_accept is null then
    raise exception 'resposta_invalida' using errcode = '22023';
  end if;
  select * into v_me from public.profiles where id = (select auth.uid());
  if not found or v_me.role <> 'TEACHER' then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  if length(btrim(coalesce(v_me.full_name, ''))) < 3 then
    raise exception 'complete_seu_nome_no_perfil' using errcode = '22023';
  end if;

  v_term := private.lesson_recording_current_term('TEACHER');
  v_decision := case when p_accept then 'ACCEPTED' else 'REFUSED' end;
  insert into private.lesson_recording_consents (
    tenant_id, subject_id, subject_role, decision, signer_name, signer_relation,
    term_audience, term_version, source, recorded_by
  ) values (
    v_me.tenant_id, v_me.id, 'TEACHER', v_decision, left(btrim(v_me.full_name), 120), 'SELF',
    'TEACHER', v_term.version, 'APP', v_me.id
  );
  return jsonb_build_object('ok', true, 'decision', v_decision);
end;
$$;

-- A família pediu por outro canal (WhatsApp, ligação): a escola registra a
-- revogação com o motivo. Aceite a escola não registra por ninguém.
create or replace function public.revoke_lesson_recording_consent(p_subject_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_subject public.profiles;
  v_me public.profiles;
begin
  select * into v_subject from public.profiles where id = p_subject_id;
  if not found or v_subject.role not in ('STUDENT', 'TEACHER') then
    raise exception 'pessoa_invalida' using errcode = '22023';
  end if;
  if not private.can_manage_lesson_quality(v_subject.tenant_id) then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'informe_o_motivo' using errcode = '22023';
  end if;
  select * into v_me from public.profiles where id = (select auth.uid());

  insert into private.lesson_recording_consents (
    tenant_id, subject_id, subject_role, decision, signer_name, signer_relation,
    source, recorded_by, reason
  ) values (
    v_subject.tenant_id, v_subject.id, v_subject.role, 'REVOKED',
    left(coalesce(nullif(btrim(v_me.full_name), ''), 'Escola'), 120), 'SCHOOL',
    'SCHOOL', v_me.id, left(btrim(p_reason), 2000)
  );
  update private.lesson_recording_consent_links
     set revoked_at = pg_catalog.now()
   where student_id = v_subject.id and revoked_at is null;
  return jsonb_build_object('ok', true, 'decision', 'REVOKED');
end;
$$;

-- Painel da escola: quem tem aula nos últimos/próximos 30 dias e como está a
-- autorização de cada um.
create or replace function public.list_lesson_recording_consents()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tenant text := public._my_tenant_id();
  v_today date := (pg_catalog.now() at time zone 'America/Sao_Paulo')::date;
begin
  if v_tenant is null or not private.can_manage_lesson_quality(v_tenant) then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'ok', true,
    'google_connected', exists (
      select 1 from private.google_workspace_connections as connection
      where connection.tenant_id = v_tenant and connection.status = 'CONNECTED'
    ),
    'students', coalesce((
      select jsonb_agg(row_data order by row_data ->> 'name')
      from (
        select jsonb_build_object(
          'student_id', student.id,
          'name', btrim(student.full_name),
          'requires_guardian', private.lesson_recording_requires_guardian(student.id),
          'guardian_name', nullif(btrim(coalesce(student.guardian_name, '')), ''),
          'contact_phone', coalesce(
            case when private.lesson_recording_requires_guardian(student.id)
              then nullif(regexp_replace(coalesce(student.guardian_phone, ''), '\D', '', 'g'), '') end,
            nullif(regexp_replace(coalesce(student.attendance_phone, ''), '\D', '', 'g'), ''),
            nullif(regexp_replace(coalesce(student.phone, ''), '\D', '', 'g'), '')
          ),
          'decision', coalesce(last_decision.decision, 'NONE'),
          'decided_at', last_decision.decided_at,
          'signer_name', last_decision.signer_name,
          'signer_relation', last_decision.signer_relation,
          'link_expires_at', (
            select link.expires_at from private.lesson_recording_consent_links as link
            where link.student_id = student.id and link.revoked_at is null
              and link.expires_at > pg_catalog.now()
            order by link.created_at desc limit 1
          )
        ) as row_data
        from public.profiles as student
        left join lateral (
          select consent.decision, consent.decided_at, consent.signer_name, consent.signer_relation
          from private.lesson_recording_consents as consent
          where consent.subject_id = student.id
          order by consent.seq desc limit 1
        ) as last_decision on true
        where student.tenant_id = v_tenant and student.role = 'STUDENT'
          and exists (
            select 1 from public.lesson_sessions as session
            where session.tenant_id = v_tenant and session.student_id = student.id
              and session.status <> 'SUPERSEDED'
              and session.class_date between v_today - 30 and v_today + 30
          )
      ) as rows
    ), '[]'::jsonb),
    'teachers', coalesce((
      select jsonb_agg(row_data order by row_data ->> 'name')
      from (
        select jsonb_build_object(
          'teacher_id', teacher.id,
          'name', btrim(teacher.full_name),
          'decision', coalesce(last_decision.decision, 'NONE'),
          'decided_at', last_decision.decided_at
        ) as row_data
        from public.profiles as teacher
        left join lateral (
          select consent.decision, consent.decided_at
          from private.lesson_recording_consents as consent
          where consent.subject_id = teacher.id
          order by consent.seq desc limit 1
        ) as last_decision on true
        where teacher.tenant_id = v_tenant and teacher.role = 'TEACHER'
          and exists (
            select 1 from public.lesson_sessions as session
            where session.tenant_id = v_tenant and session.teacher_id = teacher.id
              and session.status <> 'SUPERSEDED'
              and session.class_date between v_today - 30 and v_today + 30
          )
      ) as rows
    ), '[]'::jsonb)
  );
end;
$$;

-- Aplica o termo às sessões das próximas 24 h. Só mexe em sessão que ainda não
-- tem decisão de consentimento: uma marcação manual da escola prevalece. A
-- desmarcação por revogação só alcança o que o próprio termo marcou.
create or replace function private.apply_standing_lesson_recording_consent(p_tenant text)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid;
  v_changed integer := 0;
  v_session record;
  v_marker constant text := 'Termo de registro das aulas';
begin
  if not exists (
    select 1 from private.google_workspace_connections as connection
    where connection.tenant_id = p_tenant and connection.status = 'CONNECTED'
  ) then
    return 0;
  end if;
  v_actor := private.management_group_default_actor(p_tenant);
  if v_actor is null then
    return 0;
  end if;

  -- Mesma trava da materialização das sessões (lesson_quality).
  perform pg_advisory_xact_lock(hashtextextended('lesson-quality:' || p_tenant, 0));

  for v_session in
    select session.id, session.student_id, session.teacher_id, session.documentation_consent,
      exists (
        select 1 from private.lesson_documentation_consent_events as event
        where event.session_id = session.id
      ) as has_event,
      exists (
        select 1 from private.lesson_documentation_consent_events as event
        where event.session_id = session.id and event.allowed
          and event.reason like (v_marker || '%')
      ) as marked_by_term
    from public.lesson_sessions as session
    where session.tenant_id = p_tenant
      and session.status = 'SCHEDULED'
      and session.scheduled_start_at between pg_catalog.now() and pg_catalog.now() + interval '24 hours'
  loop
    if private.lesson_recording_active(v_session.student_id, v_session.teacher_id) then
      if not v_session.documentation_consent and not v_session.has_event then
        insert into private.lesson_documentation_consent_events (session_id, actor_id, allowed, reason)
        values (v_session.id, v_actor, true,
          v_marker || ': aluno (ou responsável) e professor aceitaram o registro permanente.');
        update public.lesson_sessions
           set documentation_consent = true, updated_at = pg_catalog.now()
         where id = v_session.id;
        v_changed := v_changed + 1;
      end if;
    elsif v_session.documentation_consent and v_session.marked_by_term then
      insert into private.lesson_documentation_consent_events (session_id, actor_id, allowed, reason)
      values (v_session.id, v_actor, false,
        v_marker || ': autorização revogada ou recusada depois da marcação.');
      update public.lesson_sessions
         set documentation_consent = false, updated_at = pg_catalog.now()
       where id = v_session.id;
      v_changed := v_changed + 1;
    end if;
  end loop;

  return v_changed;
end;
$$;

-- O job de 15 minutos aplica o termo antes de procurar salas a preparar.
create or replace function public.trigger_sync_google_meet_artifacts()
returns bigint language plpgsql security definer set search_path='' as $$
declare v_key text; v_request bigint; v_tenant text;
begin
  for v_tenant in
    select connection.tenant_id from private.google_workspace_connections as connection
    where connection.status = 'CONNECTED'
  loop
    perform private.apply_standing_lesson_recording_consent(v_tenant);
  end loop;
  if public.get_pending_google_meet_sync_sessions()='[]'::jsonb then return null; end if;
  select decrypted_secret into v_key from vault.decrypted_secrets where name='wisewolf_service_role_key' limit 1;
  if nullif(v_key,'') is null then return null; end if;
  select net.http_post(url:='http://kong:8000/functions/v1/google-meet',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_key),
    body:='{"action":"sync_due"}'::jsonb,timeout_milliseconds:=180000) into v_request;
  return v_request;
end;
$$;

do $owners$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'private.lesson_recording_current_term(text)',
    'private.lesson_recording_consent_state(uuid)',
    'private.lesson_recording_active(uuid,uuid)',
    'private.lesson_recording_requires_guardian(uuid)',
    'private.lesson_recording_request_header(text,integer)',
    'private.apply_standing_lesson_recording_consent(text)',
    'public.create_lesson_recording_consent_link(uuid)',
    'public.get_lesson_recording_consent_public(text)',
    'public.decide_lesson_recording_consent_public(text,text,text,boolean)',
    'public.get_my_lesson_recording_consent()',
    'public.set_my_lesson_recording_consent(boolean)',
    'public.revoke_lesson_recording_consent(uuid,text)',
    'public.list_lesson_recording_consents()'
  ] loop
    execute pg_catalog.format('alter function %s owner to postgres', v_signature);
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated', v_signature);
  end loop;
end
$owners$;

grant execute on function private.management_group_default_actor(text) to postgres;

-- Rotas do link público (token de 64 hex, validade de 30 dias, devolve só o
-- primeiro nome do aluno e o texto do termo).
grant execute on function public.get_lesson_recording_consent_public(text) to anon, authenticated;
grant execute on function public.decide_lesson_recording_consent_public(text,text,text,boolean) to anon, authenticated;
-- Escola (a checagem de papel e escola é interna).
grant execute on function public.create_lesson_recording_consent_link(uuid) to authenticated;
grant execute on function public.revoke_lesson_recording_consent(uuid,text) to authenticated;
grant execute on function public.list_lesson_recording_consents() to authenticated;
-- Professor.
grant execute on function public.get_my_lesson_recording_consent() to authenticated;
grant execute on function public.set_my_lesson_recording_consent(boolean) to authenticated;
