-- Presença pelo relatório nativo do Meet (migration 20260926140000): a planilha
-- guardada por sessão e as regras que SÓ abrem caso na Central de Qualidade.
\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.att_assert(p_ok boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then
    raise exception 'presença do Meet: %', p_message;
  end if;
end;
$$;

do $privileges$
begin
  perform pg_temp.att_assert(
    has_function_privilege('service_role', 'public.google_meet_attendance_backend(text,text,uuid,jsonb)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.google_meet_attendance_backend(text,text,uuid,jsonb)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.google_meet_attendance_backend(text,text,uuid,jsonb)', 'EXECUTE'),
    'a porta da presença não é só do servidor'
  );
  perform pg_temp.att_assert(
    not has_table_privilege('authenticated', 'private.meeting_attendance_reports', 'SELECT')
    and not has_function_privilege('authenticated', 'private.meet_attendance_evaluate(uuid,text,integer)', 'EXECUTE'),
    'relatório de presença acessível pelo navegador'
  );
  perform pg_temp.att_assert(
    pg_catalog.pg_get_functiondef('public.purge_expired_meet_artifacts()'::regprocedure)
      like '%meeting_attendance_reports%',
    'a retenção não apaga o relatório de presença'
  );
end
$privileges$;

do $test$
declare
  v_admin uuid := gen_random_uuid();
  v_teacher uuid := gen_random_uuid();
  v_student uuid := gen_random_uuid();
  v_done uuid := gen_random_uuid();
  v_absent uuid := gen_random_uuid();
  v_outside uuid := gen_random_uuid();
  v_unlogged uuid := gen_random_uuid();
  v_no_consent uuid := gen_random_uuid();
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_result jsonb;
  v_blocked boolean;
  v_base jsonb;
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into public.tenants (id, name) values ('meet-attendance-fixture', 'Presença fixture');
  insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data) values
    (v_admin, 'att-admin@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_teacher, 'att-teacher@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_student, 'att-student@example.invalid', '{"provider":"email"}', '{"test_fixture":true}');
  update public.profiles
     set tenant_id = 'meet-attendance-fixture', lifecycle_status = 'active', is_test_account = true,
         role = case when id = v_admin then 'SCHOOL_ADMIN' when id = v_teacher then 'TEACHER' else 'STUDENT' end
   where id in (v_admin, v_teacher, v_student);
  insert into public.tenant_memberships (tenant_id, user_id, role, status)
    select tenant_id, id, role, 'ACTIVE' from public.profiles where id in (v_admin, v_teacher, v_student)
  on conflict (tenant_id, user_id) do update set role = excluded.role, status = 'ACTIVE';

  -- Aulas que já acabaram há mais de 2 h (a regra da sala não usada exige isso).
  insert into public.lesson_sessions (id, tenant_id, student_id, teacher_id, class_date,
    scheduled_start_at, scheduled_end_at, source_key, documentation_consent) values
    (v_done, 'meet-attendance-fixture', v_student, v_teacher, v_today, now() - interval '3 hours', now() - interval '150 minutes', 'att-done', true),
    (v_absent, 'meet-attendance-fixture', v_student, v_teacher, v_today, now() - interval '5 hours', now() - interval '270 minutes', 'att-absent', true),
    (v_outside, 'meet-attendance-fixture', v_student, v_teacher, v_today, now() - interval '7 hours', now() - interval '390 minutes', 'att-outside', true),
    (v_unlogged, 'meet-attendance-fixture', v_student, v_teacher, v_today, now() - interval '9 hours', now() - interval '510 minutes', 'att-unlogged', true),
    (v_no_consent, 'meet-attendance-fixture', v_student, v_teacher, v_today, now() - interval '11 hours', now() - interval '630 minutes', 'att-no-consent', false);

  v_base := jsonb_build_object('document_id', 'sheet_fixture', 'document_name', 'abc-defg-hij',
    'conference_name', 'conferenceRecords/fixture', 'retention_days', 90);

  -- Sem autorização de registro, nada entra.
  v_blocked := false;
  begin
    perform public.google_meet_attendance_backend('attendance_save', 'meet-attendance-fixture', v_no_consent,
      v_base || jsonb_build_object('source_csv', 'x', 'content_sha256', repeat('0', 64)));
  exception when insufficient_privilege then v_blocked := true; end;
  perform pg_temp.att_assert(v_blocked, 'guardou presença de sessão sem autorização');

  -- Aula lançada como dada: professor 15 min atrasado, aluno 1 min na sala.
  v_result := public.google_meet_attendance_backend('attendance_save', 'meet-attendance-fixture', v_done,
    v_base || jsonb_build_object('source_csv', 'csv-done', 'content_sha256', repeat('a', 64),
      'teacher_first_join_at', now() - interval '165 minutes', 'teacher_seconds', 900,
      'student_first_join_at', now() - interval '160 minutes', 'student_seconds', 60,
      'participants', '[]'::jsonb));
  perform pg_temp.att_assert((v_result ->> 'inserted')::boolean, 'relatório não foi guardado');
  v_result := public.google_meet_attendance_backend('attendance_save', 'meet-attendance-fixture', v_done,
    v_base || jsonb_build_object('source_csv', 'csv-done', 'content_sha256', repeat('a', 64)));
  perform pg_temp.att_assert(not (v_result ->> 'inserted')::boolean, 'a mesma planilha entrou duas vezes');

  v_result := private.meet_attendance_evaluate(v_done, 'COMPLETED', 1);
  perform pg_temp.att_assert(v_result -> 'opened' ? 'late', 'não sinalizou o atraso do professor');
  perform pg_temp.att_assert(v_result -> 'opened' ? 'no-student', 'não sinalizou aula dada sem aluno');
  perform pg_temp.att_assert(not (v_result -> 'opened' ? 'no-teacher'), 'professor com 15 min tratado como ausente');
  perform pg_temp.att_assert(not (v_result -> 'opened' ? 'outside-room'), 'sala usada tratada como não usada');
  perform pg_temp.att_assert(
    jsonb_array_length(private.meet_attendance_evaluate(v_done, 'COMPLETED', 1) -> 'opened') = 0,
    'a segunda avaliação reabriu os mesmos casos'
  );
  perform pg_temp.att_assert(
    (select count(*) = 2 from public.lesson_quality_cases
      where session_id = v_done and source = 'SYSTEM' and dedupe_key like 'meet:%'
        and description like '%não altera o pagamento%'),
    'casos sem o aviso de que o pagamento não muda'
  );
  perform pg_temp.att_assert(
    exists (select 1 from public.lesson_quality_case_events e
      join public.lesson_quality_cases q on q.id = e.case_id
      where q.session_id = v_done and e.event_type = 'MEET_ATTENDANCE_REPORT'
        and (e.details ->> 'student_minutes')::numeric = 1),
    'caso sem a evidência do relatório'
  );

  -- Lançada como falta do aluno, mas ele esteve 15 min.
  perform public.google_meet_attendance_backend('attendance_save', 'meet-attendance-fixture', v_absent,
    v_base || jsonb_build_object('source_csv', 'csv-absent', 'content_sha256', repeat('b', 64),
      'teacher_first_join_at', now() - interval '300 minutes', 'teacher_seconds', 1800,
      'student_first_join_at', now() - interval '295 minutes', 'student_seconds', 900));
  v_result := private.meet_attendance_evaluate(v_absent, 'STUDENT_ABSENCE', 1);
  perform pg_temp.att_assert(v_result -> 'opened' = '["absence-mismatch"]'::jsonb,
    'falta do aluno com aluno na sala deveria abrir só esse caso');

  -- Lançada, mas a sala da escola não teve reunião nenhuma.
  v_result := private.meet_attendance_evaluate(v_outside, 'COMPLETED', 0);
  perform pg_temp.att_assert(v_result -> 'opened' = '["outside-room"]'::jsonb, 'não sinalizou aula fora da sala');

  -- Sem lançamento, nada é sinalizado (quem cobra lançamento é a regra de 24 h).
  v_result := private.meet_attendance_evaluate(v_unlogged, null, 0);
  perform pg_temp.att_assert(jsonb_array_length(v_result -> 'opened') = 0, 'sinalizou aula ainda não lançada');

  -- Nada disso encosta no pagamento.
  perform pg_temp.att_assert(
    not exists (select 1 from public.class_logs where lesson_session_id in (v_done, v_absent, v_outside, v_unlogged)),
    'a avaliação criou lançamento'
  );

  -- Retenção de 90 dias apaga a planilha.
  update private.meeting_attendance_reports set expires_at = now() - interval '1 day'
   where lesson_session_id = v_done;
  perform public.purge_expired_meet_artifacts();
  perform pg_temp.att_assert(
    not exists (select 1 from private.meeting_attendance_reports where lesson_session_id = v_done),
    'a planilha vencida não foi apagada'
  );
end
$test$;

rollback;
