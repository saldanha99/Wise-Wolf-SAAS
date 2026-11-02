-- Presença pelo relatório nativo do Google Meet (Business Plus).
--
-- A escola assinou o Google Workspace Business Plus em 26/09/2026. Depois de
-- cada reunião na sala da escola, o Google gera uma planilha com nome, e-mail,
-- entrada, saída e duração de cada participante, no Drive da conta central. A
-- edge google-meet encontra essa planilha, resume professor × aluno e guarda
-- aqui; o banco compara com o LANÇAMENTO da aula e abre caso na Central de
-- Qualidade quando diverge.
--
-- Decisão da direção (26/09/2026): divergência SÓ SINALIZA. Nada aqui mexe em
-- class_logs, folha, pagamento ou confirmação de presença. A API do Meet não é
-- usada para ler participantes (o Google diz que ela não é destinada a
-- acompanhamento de desempenho); o dado vem do recurso de presença do Google.
--
-- Só sessões com autorização de registro (documentation_consent) chegam aqui:
-- o termo do aluno e o do professor citam o controle de presença.

create table if not exists private.meeting_attendance_reports (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id text not null,
  lesson_session_id uuid not null,
  conference_name text check (conference_name is null or conference_name ~ '^conferenceRecords/[A-Za-z0-9_-]+$'),
  document_id text not null check (document_id ~ '^[A-Za-z0-9_-]+$'),
  document_name text check (document_name is null or length(document_name) <= 300),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  source_csv text not null check (length(source_csv) between 1 and 200000),
  parse_error text check (parse_error is null or parse_error ~ '^[a-z_]+$'),
  participants jsonb not null default '[]'::jsonb check (jsonb_typeof(participants) = 'array'),
  teacher_first_join_at timestamptz,
  teacher_seconds integer check (teacher_seconds is null or teacher_seconds >= 0),
  student_first_join_at timestamptz,
  student_seconds integer check (student_seconds is null or student_seconds >= 0),
  imported_at timestamptz not null default now(),
  expires_at timestamptz not null,
  foreign key (lesson_session_id, tenant_id) references public.lesson_sessions(id, tenant_id),
  unique (tenant_id, lesson_session_id, content_sha256)
);
create index if not exists meeting_attendance_reports_session_idx
  on private.meeting_attendance_reports(tenant_id, lesson_session_id, imported_at desc);
create index if not exists meeting_attendance_reports_expiry_idx
  on private.meeting_attendance_reports(expires_at);
alter table private.meeting_attendance_reports owner to postgres;
alter table private.meeting_attendance_reports enable row level security;
revoke all on private.meeting_attendance_reports from public, anon, authenticated, service_role;
comment on table private.meeting_attendance_reports is
  'Relatório de presença nativo do Google Meet por sessão. Só sinaliza divergência na Central de Qualidade; nunca altera lançamento, folha ou pagamento.';

-- Categorias novas na fila de qualidade.
alter table public.lesson_quality_cases drop constraint if exists lesson_quality_cases_category_check;
alter table public.lesson_quality_cases add constraint lesson_quality_cases_category_check check (
  category in ('LATE_START','EARLY_END','SCHEDULE_CHANGE','DID_NOT_HAPPEN','OTHER',
    'DELIVERY_FAILURE','MISSING_LOG','MEET_ATTENDANCE','OUTSIDE_ROOM')
);

-- Presença lançada para a sessão: a aula de 1 h vira dois lançamentos; basta
-- um COMPLETED para valer como dada.
create or replace function private.lesson_session_logged_presence(p_session uuid)
returns text
language sql stable security definer set search_path = '' as $$
  with logs as (
    select cl.presence
    from public.class_logs as cl
    where cl.lesson_session_id = p_session
       or cl.id in (
         select occurrence.class_log_id from public.lesson_occurrences as occurrence
         where occurrence.session_id = p_session and occurrence.class_log_id is not null
       )
  )
  select case
    when exists (select 1 from logs where presence = 'COMPLETED') then 'COMPLETED'
    when exists (select 1 from logs where presence = 'STUDENT_ABSENCE') then 'STUDENT_ABSENCE'
    when exists (select 1 from logs where presence = 'TEACHER_ABSENCE') then 'TEACHER_ABSENCE'
    else (select presence from logs limit 1)
  end;
$$;

-- Regras (todas só abrem caso; nenhuma decide nada):
--   professor entrou 10+ min depois do horário ........... LATE_START
--   lançada como dada e o aluno quase não esteve (< 5 min) MEET_ATTENDANCE (alta)
--   lançada como falta do aluno e ele esteve 10+ min ....... MEET_ATTENDANCE (alta)
--   lançada e o professor quase não esteve (< 5 min) ....... MEET_ATTENDANCE (alta)
--   lançada e a sala da escola nem foi aberta (2 h depois) . OUTSIDE_ROOM (baixa)
-- Caso já aberto (ou resolvido) para a mesma regra e sessão não reabre.
create or replace function private.meet_attendance_evaluate(
  p_session uuid,
  p_presence text,
  p_conference_count integer
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_session public.lesson_sessions;
  v_report private.meeting_attendance_reports;
  v_opened text[] := '{}';
  v_flag record;
  v_case uuid;
  v_late_minutes integer;
begin
  select * into v_session from public.lesson_sessions where id = p_session;
  if not found or not v_session.documentation_consent then
    return jsonb_build_object('evaluated', false);
  end if;
  select * into v_report from private.meeting_attendance_reports
   where lesson_session_id = v_session.id and parse_error is null
   order by imported_at desc limit 1;

  for v_flag in
    select * from (values
      ('late', 'LATE_START', 'NORMAL',
        v_report.id is not null and v_report.teacher_first_join_at is not null
          and v_report.teacher_first_join_at > v_session.scheduled_start_at + interval '10 minutes'),
      ('no-student', 'MEET_ATTENDANCE', 'HIGH',
        v_report.id is not null and p_presence = 'COMPLETED' and coalesce(v_report.student_seconds, 0) < 300),
      ('absence-mismatch', 'MEET_ATTENDANCE', 'HIGH',
        v_report.id is not null and p_presence = 'STUDENT_ABSENCE' and coalesce(v_report.student_seconds, 0) >= 600),
      ('no-teacher', 'MEET_ATTENDANCE', 'HIGH',
        v_report.id is not null and p_presence in ('COMPLETED', 'STUDENT_ABSENCE')
          and coalesce(v_report.teacher_seconds, 0) < 300),
      ('outside-room', 'OUTSIDE_ROOM', 'LOW',
        coalesce(p_conference_count, -1) = 0 and p_presence in ('COMPLETED', 'STUDENT_ABSENCE')
          and v_session.scheduled_end_at < now() - interval '2 hours')
    ) as rule(slug, category, severity, fires)
    where fires
  loop
    v_late_minutes := case when v_report.teacher_first_join_at is null then null
      else floor(extract(epoch from (v_report.teacher_first_join_at - v_session.scheduled_start_at)) / 60)::integer end;
    insert into public.lesson_quality_cases (tenant_id, session_id, student_id, teacher_id,
      category, source, severity, description, dedupe_key)
    values (v_session.tenant_id, v_session.id, v_session.student_id, v_session.teacher_id,
      v_flag.category, 'SYSTEM', v_flag.severity,
      case v_flag.slug
        when 'late' then 'Relatório de presença do Meet: o professor entrou ' || v_late_minutes
          || ' min depois do horário da aula.'
        when 'no-student' then 'Aula lançada como dada, mas o relatório de presença do Meet mostra o aluno por '
          || round(coalesce(v_report.student_seconds, 0) / 60.0) || ' min na sala da escola.'
        when 'absence-mismatch' then 'Aula lançada como falta do aluno, mas o relatório de presença do Meet mostra o aluno por '
          || round(v_report.student_seconds / 60.0) || ' min na sala da escola.'
        when 'no-teacher' then 'Aula lançada, mas o relatório de presença do Meet mostra o professor por '
          || round(coalesce(v_report.teacher_seconds, 0) / 60.0) || ' min na sala da escola.'
        else 'Aula lançada sem uso da sala da escola no Meet. Combine com o professor o uso da sala oficial.'
      end || ' Isto é um aviso para conversar com o professor: não altera o pagamento.',
      'meet:' || v_session.id || ':' || v_flag.slug)
    on conflict (tenant_id, dedupe_key) do nothing
    returning id into v_case;
    if v_case is not null then
      insert into public.lesson_quality_case_events (tenant_id, case_id, actor_id, event_type, details)
      values (v_session.tenant_id, v_case, null, 'MEET_ATTENDANCE_REPORT', jsonb_build_object(
        'rule', v_flag.slug,
        'logged_presence', p_presence,
        'scheduled_start_at', v_session.scheduled_start_at,
        'teacher_first_join_at', v_report.teacher_first_join_at,
        'teacher_minutes', round(coalesce(v_report.teacher_seconds, 0) / 60.0),
        'student_first_join_at', v_report.student_first_join_at,
        'student_minutes', round(coalesce(v_report.student_seconds, 0) / 60.0),
        'conference_count', p_conference_count,
        'report_id', v_report.id));
      v_opened := v_opened || v_flag.slug;
    end if;
    v_case := null;
  end loop;

  return jsonb_build_object('evaluated', true, 'presence', p_presence,
    'report_id', v_report.id, 'opened', to_jsonb(v_opened));
end;
$$;

-- Porta da edge (service_role): guardar o relatório e avaliar a sessão.
create or replace function public.google_meet_attendance_backend(
  p_action text,
  p_tenant_id text,
  p_session_id uuid,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_session public.lesson_sessions;
  v_id uuid;
  v_retention integer;
begin
  select * into v_session from public.lesson_sessions
   where id = p_session_id and tenant_id = p_tenant_id;
  if not found then
    raise exception 'lesson_session_not_found' using errcode = '22023';
  end if;
  if not v_session.documentation_consent then
    raise exception 'documentation_consent_required' using errcode = '42501';
  end if;

  if p_action = 'attendance_save' then
    v_retention := greatest(7, least(365, coalesce((p_payload ->> 'retention_days')::integer, 90)));
    insert into private.meeting_attendance_reports (tenant_id, lesson_session_id, conference_name,
      document_id, document_name, content_sha256, source_csv, parse_error, participants,
      teacher_first_join_at, teacher_seconds, student_first_join_at, student_seconds, expires_at)
    values (v_session.tenant_id, v_session.id, nullif(p_payload ->> 'conference_name', ''),
      p_payload ->> 'document_id', left(p_payload ->> 'document_name', 300),
      p_payload ->> 'content_sha256', p_payload ->> 'source_csv', nullif(p_payload ->> 'parse_error', ''),
      coalesce(p_payload -> 'participants', '[]'::jsonb),
      nullif(p_payload ->> 'teacher_first_join_at', '')::timestamptz,
      nullif(p_payload ->> 'teacher_seconds', '')::integer,
      nullif(p_payload ->> 'student_first_join_at', '')::timestamptz,
      nullif(p_payload ->> 'student_seconds', '')::integer,
      now() + make_interval(days => v_retention))
    on conflict (tenant_id, lesson_session_id, content_sha256) do nothing
    returning id into v_id;
    return jsonb_build_object('id', v_id, 'inserted', v_id is not null);
  elsif p_action = 'attendance_evaluate' then
    return private.meet_attendance_evaluate(
      v_session.id,
      private.lesson_session_logged_presence(v_session.id),
      nullif(p_payload ->> 'conference_count', '')::integer
    );
  end if;
  raise exception 'unknown_attendance_action' using errcode = '22023';
end;
$$;

-- Retenção: a planilha tem nome e e-mail de quem esteve na sala — some junto
-- com as cópias brutas de transcrição (padrão 90 dias).
create or replace function public.purge_expired_meet_artifacts()
returns integer language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  delete from private.meeting_artifact_revisions where expires_at<now();
  get diagnostics v_count=row_count;
  delete from private.meeting_attendance_reports where expires_at<now();
  delete from private.google_meet_oauth_states where expires_at<now()-interval '1 day';
  return v_count;
end;
$$;

do $owners$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'private.lesson_session_logged_presence(uuid)',
    'private.meet_attendance_evaluate(uuid,text,integer)',
    'public.google_meet_attendance_backend(text,text,uuid,jsonb)'
  ] loop
    execute pg_catalog.format('alter function %s owner to postgres', v_signature);
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated', v_signature);
  end loop;
end
$owners$;
grant execute on function public.google_meet_attendance_backend(text,text,uuid,jsonb) to service_role;
