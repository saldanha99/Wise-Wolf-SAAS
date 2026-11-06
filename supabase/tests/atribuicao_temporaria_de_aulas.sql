\set ON_ERROR_STOP on
begin;
-- Atribuição temporária: o exemplo real é 1 hora aos sábados por dois meses, com
-- saldo de 22 aulas de 30 min. Identidades e escola isoladas; nada sai deste rollback.
create or replace function pg_temp.ta_assert(v boolean, m text) returns void language plpgsql as $$
begin if not coalesce(v, false) then raise exception 'atribuicao temporaria: %', m; end if; end $$;

do $test$
declare
  tenant text := 'temp-assign-' || gen_random_uuid();
  other_tenant text := 'temp-assign-other-' || gen_random_uuid();
  adm uuid := gen_random_uuid();
  coord uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  origem uuid := gen_random_uuid();   -- professor original, suspenso
  temporaria uuid := gen_random_uuid();    -- quem assume
  titular uuid := gen_random_uuid();  -- titular do aluno, sem relação com o saldo
  aluno uuid := gen_random_uuid();
  aluna2 uuid := gen_random_uuid();
  aluna3 uuid := gen_random_uuid();
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  sat1 date;
  sat8 date;
  slots jsonb := '[{"day_of_week":6,"start":"10:30","end":"11:30"}]';
  preview jsonb;
  result jsonb;
  assignment uuid;
  second_assignment uuid;
  req uuid := gen_random_uuid();
  fixed_booking uuid;
  n integer;
  failed boolean;
  r1 uuid; r2 uuid; r3 uuid;
  logged jsonb;
  pool jsonb;
  counts jsonb;
  dow text[] := array['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
begin
  -- No release os testes dividem a transação, e um anterior pode deixar estes como ''.
  perform set_config('request.headers', '{}', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- Permissões: tabela e funções internas fechadas; RPC só para quem está logado.
  perform pg_temp.ta_assert(not has_table_privilege('authenticated', 'public.temporary_lesson_assignments', 'SELECT'), 'tabela aberta para authenticated');
  perform pg_temp.ta_assert(not has_table_privilege('anon', 'public.temporary_lesson_assignments', 'SELECT'), 'tabela aberta para anon');
  perform pg_temp.ta_assert(not has_function_privilege('anon', 'public.create_temporary_assignment(uuid,uuid,uuid,date,date,jsonb,integer,text,uuid,boolean)', 'EXECUTE'), 'criar aberto para anon');
  perform pg_temp.ta_assert(not has_function_privilege('anon', 'public.list_temporary_assignments(uuid)', 'EXECUTE'), 'listar aberto para anon');
  perform pg_temp.ta_assert(has_function_privilege('authenticated', 'public.create_temporary_assignment(uuid,uuid,uuid,date,date,jsonb,integer,text,uuid,boolean)', 'EXECUTE'), 'criar fechado para authenticated');
  perform pg_temp.ta_assert(not has_function_privilege('authenticated', 'private.end_due_temporary_assignments()', 'EXECUTE'), 'rotina interna aberta');
  perform pg_temp.ta_assert(not has_function_privilege('authenticated', 'private.temporary_assignment_finish(uuid,uuid,text,boolean,boolean)', 'EXECUTE'), 'encerramento interno aberto');
  perform pg_temp.ta_assert(exists(select 1 from cron.job where jobname = 'wisewolf-temporary-assignments-end'), 'rotina de encerramento nao agendada');

  -- Próximo sábado que ainda não começou, e calendário sem feriado nos dois meses.
  sat1 := today + ((6 - extract(dow from today)::int + 7) % 7);
  if sat1 = today then sat1 := today + 7; end if;
  sat8 := sat1 + 49;
  delete from public.national_holidays where holiday_date between sat1 and sat8 + 14;

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into public.tenants(id, name) values (tenant, 'TA fixture'), (other_tenant, 'TA other');
  insert into auth.users(id, email, raw_app_meta_data, raw_user_meta_data)
    select id, id || '@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'
      from unnest(array[adm, coord, outsider, origem, temporaria, titular, aluno, aluna2, aluna3]) as f(id);
  update public.profiles set tenant_id = tenant, role = 'SCHOOL_ADMIN', full_name = 'TA Direção', status = 'Ativo', lifecycle_status = 'active', is_test_account = true where id = adm;
  update public.profiles set tenant_id = tenant, role = 'COORDINATOR', full_name = 'TA Coordenação', status = 'Ativo', lifecycle_status = 'active', is_test_account = true where id = coord;
  update public.profiles set tenant_id = other_tenant, role = 'SCHOOL_ADMIN', full_name = 'TA Outra escola', status = 'Ativo', lifecycle_status = 'active', is_test_account = true where id = outsider;
  update public.profiles set tenant_id = tenant, role = 'TEACHER', full_name = 'TA Origem', status = 'Inativo', lifecycle_status = 'suspended', is_test_account = true where id = origem;
  update public.profiles set tenant_id = tenant, role = 'TEACHER', full_name = 'TA Temporaria', status = 'Ativo', lifecycle_status = 'active', hourly_rate = 8, phone = '5511988880001', is_test_account = true where id = temporaria;
  update public.profiles set tenant_id = tenant, role = 'TEACHER', full_name = 'TA Titular', status = 'Ativo', lifecycle_status = 'active', is_test_account = true where id = titular;
  update public.profiles set tenant_id = tenant, role = 'STUDENT', full_name = 'TA Aluno', status = 'Ativo', lifecycle_status = 'active', phone = '5511988880002', professor_id = titular, is_test_account = true where id = aluno;
  update public.profiles set tenant_id = tenant, role = 'STUDENT', full_name = 'TA Aluna Dois', status = 'Ativo', lifecycle_status = 'active', phone = '5511988880003', professor_id = titular, is_test_account = true where id = aluna2;
  update public.profiles set tenant_id = tenant, role = 'STUDENT', full_name = 'TA Aluna Tres', status = 'Ativo', lifecycle_status = 'active', phone = '5511988880004', professor_id = titular, is_test_account = true where id = aluna3;
  insert into public.tenant_memberships(tenant_id, user_id, role, status)
    select tenant_id, id, role, 'ACTIVE' from public.profiles where id = any(array[adm, coord, outsider, temporaria, titular, origem, aluno, aluna2, aluna3])
    on conflict (tenant_id, user_id) do update set role = excluded.role, status = 'ACTIVE';
  insert into public.tenant_notice_channels(tenant_id, channel, group_jid) values (tenant, 'coordenacao', '120363000000000001@g.us');
  insert into public.teacher_availability(tenant_id, teacher_id, day_of_week, start_time) values (tenant, temporaria, 6, '10:30'), (tenant, temporaria, 6, '11:00');
  insert into public.bookings(tenant_id, student_id, teacher_id, day_of_week, time_slot, start_date, status)
    values (tenant, aluno, titular, 'Segunda', '18:00', today - 30, 'SCHEDULED') returning id into fixed_booking;

  -- Só a direção e a coordenação da própria escola.
  foreach r1 in array array[origem, aluno, outsider] loop
    perform set_config('request.jwt.claims', json_build_object('sub', r1, 'role', 'authenticated')::text, true);
    failed := false;
    begin
      perform public.preview_temporary_assignment(aluno, origem, temporaria, sat1, sat8, slots, 22);
    exception when others then failed := true; end;
    perform pg_temp.ta_assert(failed, 'sem permissao conseguiu ver o plano: ' || r1);
  end loop;

  perform set_config('request.jwt.claims', json_build_object('sub', coord, 'role', 'authenticated')::text, true);
  perform pg_temp.ta_assert(jsonb_array_length(public.temporary_assignment_options() -> 'students') = 3, 'opcoes: alunos');

  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);

  -- O plano do exemplo: 8 sábados de 1 hora = 16 aulas de 30 min; sobram 6.
  preview := public.preview_temporary_assignment(aluno, origem, temporaria, sat1, sat8 + 4, slots, 22);
  perform pg_temp.ta_assert((preview ->> 'generated')::int = 16, 'plano: esperava 16 aulas, veio ' || (preview ->> 'generated'));
  perform pg_temp.ta_assert((preview ->> 'limit')::int = 22, 'plano: limite');
  perform pg_temp.ta_assert(preview -> 'occurrences' -> 0 ->> 'time' = '10:30' and preview -> 'occurrences' -> 1 ->> 'time' = '11:00', 'plano: uma hora vira 10:30 e 11:00');
  perform pg_temp.ta_assert(preview ->> 'slots_text' = 'sábado das 10:30 às 11:30', 'plano: texto dos horarios');
  perform pg_temp.ta_assert(not exists(select 1 from public.reschedules where student_id = aluno), 'previa gravou aula');

  -- Horários inválidos e período inválido.
  failed := false;
  begin perform public.preview_temporary_assignment(aluno, origem, temporaria, sat1, sat8, '[{"day_of_week":6,"start":"10:15","end":"11:15"}]', 22);
  exception when others then failed := sqlerrm = 'horarios_invalidos'; end;
  perform pg_temp.ta_assert(failed, 'aceitou horario fora da meia hora');
  failed := false;
  begin perform public.preview_temporary_assignment(aluno, origem, temporaria, sat1, sat8, '[{"day_of_week":6,"start":"10:30","end":"11:30"},{"day_of_week":6,"start":"11:00","end":"12:00"}]', 22);
  exception when others then failed := sqlerrm = 'horarios_sobrepostos'; end;
  perform pg_temp.ta_assert(failed, 'aceitou horarios sobrepostos');
  failed := false;
  begin perform public.preview_temporary_assignment(aluno, origem, temporaria, today - 1, sat8, slots, 22);
  exception when others then failed := sqlerrm = 'periodo_invalido'; end;
  perform pg_temp.ta_assert(failed, 'aceitou inicio no passado');
  failed := false;
  begin perform public.preview_temporary_assignment(aluno, origem, origem, sat1, sat8, slots, 22);
  exception when others then failed := sqlerrm = 'professores_iguais'; end;
  perform pg_temp.ta_assert(failed, 'aceitou o mesmo professor');
  failed := false;
  begin perform public.preview_temporary_assignment(aluno, temporaria, origem, sat1, sat8, slots, 22);
  exception when others then failed := sqlerrm = 'professor_temporario_inativo'; end;
  perform pg_temp.ta_assert(failed, 'professor suspenso assumiu aula');

  -- Feriado sai do plano; o professor ocupado em UM sábado só perde aquele sábado.
  insert into public.national_holidays(holiday_date, name) values (sat1 + 14, 'Feriado de teste');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into public.reschedules(tenant_id, teacher_id, student_id, date, time, fault_type)
    values (tenant, temporaria, aluna2, to_char(sat1 + 7, 'YYYY-MM-DD'), '10:30', 'STUDENT') returning id into r3;
  insert into public.bookings(tenant_id, student_id, teacher_id, day_of_week, time_slot, start_date, status)
    values (tenant, aluno, titular, 'Sábado', '11:00', sat1 + 21, 'SCHEDULED');
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  preview := public.preview_temporary_assignment(aluno, origem, temporaria, sat1, sat8, slots, 22);
  perform pg_temp.ta_assert((select count(*) from jsonb_array_elements(preview -> 'occurrences') o where o ->> 'status' = 'FERIADO') = 2, 'plano: feriado');
  perform pg_temp.ta_assert(exists(select 1 from jsonb_array_elements(preview -> 'occurrences') o where o ->> 'status' = 'PROFESSOR_OCUPADO' and o ->> 'date' = (sat1 + 7)::text and o ->> 'time' = '10:30' and o ->> 'detail' = 'reposição de TA Aluna Dois'), 'plano: reposicao ocupa so aquele sabado');
  perform pg_temp.ta_assert(not exists(select 1 from jsonb_array_elements(preview -> 'occurrences') o where o ->> 'status' = 'PROFESSOR_OCUPADO' and o ->> 'date' = (sat1 + 28)::text), 'plano: reposicao contaminou outro sabado');
  perform pg_temp.ta_assert(exists(select 1 from jsonb_array_elements(preview -> 'occurrences') o where o ->> 'status' = 'ALUNO_OCUPADO' and o ->> 'date' = (sat1 + 21)::text and o ->> 'time' = '11:00'), 'plano: aluno com aula fixa');
  perform pg_temp.ta_assert(not exists(select 1 from jsonb_array_elements(preview -> 'occurrences') o where o ->> 'status' = 'ALUNO_OCUPADO' and o ->> 'date' = (sat1 + 14)::text), 'plano: aula fixa antes de comecar');

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  delete from public.national_holidays where holiday_date = sat1 + 14;
  delete from public.reschedules where id = r3;
  delete from public.bookings where tenant_id = tenant and day_of_week = 'Sábado';
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);

  -- Criar: sem motivo não vai; com motivo, grade e titular intactos.
  failed := false;
  begin perform public.create_temporary_assignment(aluno, origem, temporaria, sat1, sat8, slots, 22, ' ', req);
  exception when others then failed := sqlerrm = 'motivo_obrigatorio'; end;
  perform pg_temp.ta_assert(failed, 'criou sem motivo');

  result := public.create_temporary_assignment(aluno, origem, temporaria, sat1, sat8, slots, 22, 'Professor original lançou aula que não aconteceu', req);
  assignment := (result ->> 'id')::uuid;
  perform pg_temp.ta_assert((result ->> 'generated')::int = 16, 'criar: 16 aulas');
  perform pg_temp.ta_assert((result -> 'pool' ->> 'sem_professor')::int = 6, 'criar: 6 sem professor');
  perform pg_temp.ta_assert((result ->> 'first_date')::date = sat1 and (result ->> 'last_date')::date = sat8, 'criar: primeira e ultima data');

  -- Dois cliques: mesma atribuição, nada novo.
  result := public.create_temporary_assignment(aluno, origem, temporaria, sat1, sat8, slots, 22, 'Professor original lançou aula que não aconteceu', req);
  perform pg_temp.ta_assert((result ->> 'already')::boolean and (result ->> 'id')::uuid = assignment, 'idempotencia');
  perform pg_temp.ta_assert((select count(*) from public.reschedules where temporary_assignment_id = assignment) = 16, 'idempotencia: duplicou aula');

  -- Grade fixa preservada.
  perform pg_temp.ta_assert((select professor_id from public.profiles where id = aluno) = titular, 'titular mudou');
  perform pg_temp.ta_assert((select count(*) from public.bookings where student_id = aluno and status = 'SCHEDULED') = 1, 'grade fixa mudou');
  perform pg_temp.ta_assert((select teacher_id from public.bookings where id = fixed_booking) = titular, 'booking mudou de professor');
  perform pg_temp.ta_assert(not exists(select 1 from public.bookings where teacher_id = temporaria), 'nasceu booking para a temporaria');

  -- As aulas são reposição de verdade: origem comprovada e texto neutro.
  perform pg_temp.ta_assert(not exists(
    select 1 from public.reschedules r where r.temporary_assignment_id = assignment
     and not (r.teacher_id = temporaria and r.student_id = aluno and r.fault_type = 'TEACHER' and r.attested_by = adm
              and private.teacher_reschedule_financial_origin_is_proven(r.id, tenant, temporaria, aluno))), 'aula sem origem comprovada');
  perform pg_temp.ta_assert(not exists(select 1 from public.reschedules r where r.temporary_assignment_id = assignment and r.attestation_reason like '%não aconteceu%'), 'motivo vazou para a reposicao');
  perform pg_temp.ta_assert(not exists(select 1 from public.reschedule_events e join public.reschedules r on r.id = e.reschedule_id where r.temporary_assignment_id = assignment and e.reason like '%não aconteceu%'), 'motivo vazou para a trilha');
  perform pg_temp.ta_assert((select count(*) from public.reschedule_events e join public.reschedules r on r.id = e.reschedule_id where r.temporary_assignment_id = assignment and e.action = 'marcada' and e.source = 'direcao') = 16, 'trilha sem as 16 aulas');

  -- Aviso: uma mensagem por pessoa, nunca uma por aula, e sem o motivo.
  perform pg_temp.ta_assert((select count(*) from public.notification_queue where tenant_id = tenant and idempotency_key like 'temporary-assignment:%') = 3, 'esperava 3 avisos da atribuicao');
  perform pg_temp.ta_assert(not exists(select 1 from public.notification_queue where tenant_id = tenant and student_id = aluno and idempotency_key like 'reschedule-event:%'), 'cada aula disparou aviso proprio');
  perform pg_temp.ta_assert(exists(select 1 from public.notification_queue where tenant_id = tenant and idempotency_key = format('temporary-assignment:%s:created:teacher', assignment) and student_phone = '5511988880001' and message_body like '%sábado das 10:30 às 11:30%' and message_body like '%16 aulas de 30 min%'), 'aviso da professora');
  perform pg_temp.ta_assert(exists(select 1 from public.notification_queue where tenant_id = tenant and idempotency_key = format('temporary-assignment:%s:created:family', assignment) and student_phone = '5511988880002' and message_body like '%grade normal continua igual%' and message_body not like '%TA Origem%'), 'aviso da familia');
  perform pg_temp.ta_assert(exists(select 1 from public.notification_queue where tenant_id = tenant and idempotency_key = format('temporary-assignment:%s:created:group', assignment) and student_phone = '120363000000000001@g.us' and message_body like '%6 ainda sem professor%'), 'aviso do grupo');
  perform pg_temp.ta_assert(not exists(select 1 from public.notification_queue where tenant_id = tenant and message_body like '%não aconteceu%'), 'motivo vazou no aviso');

  -- A professora enxerga o aluno, e nada mudou para a folha enquanto não há lançamento.
  perform set_config('request.jwt.claims', json_build_object('sub', temporaria, 'role', 'authenticated')::text, true);
  perform pg_temp.ta_assert(public._teacher_can_access_student(aluno, tenant), 'temporaria nao enxerga o aluno');
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- Três aulas passam a estar no passado para poder lançar.
  select id into r1 from public.reschedules where temporary_assignment_id = assignment and date = sat1::text and time = '10:30';
  select id into r2 from public.reschedules where temporary_assignment_id = assignment and date = sat1::text and time = '11:00';
  select id into r3 from public.reschedules where temporary_assignment_id = assignment and date = (sat1 + 7)::text and time = '10:30';
  perform set_config('app.reschedule_silent', 'on', true);
  update public.reschedules set date = (today - 1)::text where id in (r1, r2);
  update public.reschedules set date = (today - 2)::text where id = r3;
  perform set_config('app.reschedule_silent', '', true);

  perform set_config('request.jwt.claims', json_build_object('sub', temporaria, 'role', 'authenticated')::text, true);
  logged := public.log_teacher_classes(jsonb_build_array(
    jsonb_build_object('ref', 'a', 'reschedule_id', r1, 'student_id', aluno, 'class_date', today - 1, 'presence', 'COMPLETED',
      'lesson_objective', 'x', 'content_covered', 'x', 'student_difficulties', 'x', 'homework_assigned', 'x', 'recommended_next_step', 'x', 'late_logging_reason', 'teste'),
    jsonb_build_object('ref', 'b', 'reschedule_id', r2, 'student_id', aluno, 'class_date', today - 1, 'presence', 'STUDENT_ABSENCE', 'absence_reason', 'Outros', 'late_logging_reason', 'teste'),
    jsonb_build_object('ref', 'c', 'reschedule_id', r3, 'student_id', aluno, 'class_date', today - 2, 'presence', 'TEACHER_ABSENCE', 'late_logging_reason', 'teste')));
  perform pg_temp.ta_assert((logged ->> 'inserted')::int = 3, 'lancamento: ' || logged::text);
  perform pg_temp.ta_assert(exists(select 1 from public.class_logs where reschedule_id = r1::text and subtype = 'REPOSIÇÃO_PROF' and teacher_id = temporaria), 'lancamento: subtype derivado');
  perform pg_temp.ta_assert((select rate_efetivo from public.v_payable_class_logs where reschedule_id = r1::text) > 0, 'aula dada nao entrou na folha da temporaria');
  perform pg_temp.ta_assert(not exists(select 1 from public.v_payable_class_logs where reschedule_id = r3::text), 'falta da temporaria entrou na folha');
  perform pg_temp.ta_assert(not exists(select 1 from public.class_logs where teacher_id = origem), 'lancou no professor original');
  -- Falta numa reposição não gera outra reposição: o saldo é quem controla.
  perform pg_temp.ta_assert((select count(*) from public.reschedules where student_id = aluno and temporary_assignment_id is null) = 0, 'falta gerou reposicao solta');

  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  result := public.list_temporary_assignments(aluno) -> 0;
  counts := result -> 'counts';
  pool := result -> 'pool';
  perform pg_temp.ta_assert((counts ->> 'realizadas')::int = 1 and (counts ->> 'aluno_faltou')::int = 1 and (counts ->> 'professor_faltou')::int = 1, 'controle: ' || counts::text);
  perform pg_temp.ta_assert((counts ->> 'agendadas')::int = 13, 'controle: agendadas ' || counts::text);
  -- 22 devidas - 1 dada - 1 falta do aluno = 20; a falta da professora continua devida.
  perform pg_temp.ta_assert((pool ->> 'pendentes')::int = 20, 'saldo pendente ' || pool::text);
  perform pg_temp.ta_assert((pool ->> 'sem_professor')::int = 7, 'sem professor ' || pool::text);
  perform pg_temp.ta_assert(result ->> 'reason' like '%não aconteceu%', 'direcao perdeu o motivo');

  -- Segunda atribuição do mesmo saldo: limitada ao que falta.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into public.teacher_availability(tenant_id, teacher_id, day_of_week, start_time) values (tenant, titular, 2, '09:00');
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  preview := public.preview_temporary_assignment(aluno, origem, titular, sat1 + 3, sat1 + 80, '[{"day_of_week":2,"start":"09:00","end":"09:30"}]', null);
  perform pg_temp.ta_assert((preview ->> 'owed')::int = 22, 'segunda: saldo herdado');
  perform pg_temp.ta_assert((preview ->> 'generated')::int = 7, 'segunda: limite no que falta, veio ' || (preview ->> 'generated'));
  perform pg_temp.ta_assert(exists(select 1 from jsonb_array_elements(preview -> 'occurrences') o where o ->> 'status' = 'LIMITE'), 'segunda: passou do saldo sem avisar');
  perform pg_temp.ta_assert((select count(*) from jsonb_array_elements(preview -> 'occurrences') o where o ->> 'status' = 'OK' and o ->> 'detail' = 'fora_da_grade') = 0, 'grade: horario declarado');

  result := public.create_temporary_assignment(aluno, origem, titular, sat1 + 3, sat1 + 80, '[{"day_of_week":2,"start":"09:00","end":"09:30"}]', null, 'Distribuir o resto', gen_random_uuid(), false);
  second_assignment := (result ->> 'id')::uuid;
  perform pg_temp.ta_assert((result ->> 'generated')::int = 7, 'segunda: gerou demais');
  perform pg_temp.ta_assert((result -> 'pool' ->> 'sem_professor')::int = 0, 'segunda: saldo nao fechou');
  failed := false;
  begin perform public.create_temporary_assignment(aluno, origem, titular, sat1 + 4, sat1 + 80, '[{"day_of_week":3,"start":"09:00","end":"09:30"}]', null, 'Mais uma', gen_random_uuid(), false);
  exception when others then failed := sqlerrm = 'saldo_ja_distribuido'; end;
  perform pg_temp.ta_assert(failed, 'distribuiu alem do saldo');

  -- Encerrar: o futuro sai da agenda e de upcoming_classes; o que passou fica para lançar.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('app.reschedule_silent', 'on', true);
  update public.reschedules set date = (today - 3)::text where temporary_assignment_id = second_assignment and date = (select min(date) from public.reschedules where temporary_assignment_id = second_assignment);
  perform set_config('app.reschedule_silent', '', true);
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  failed := false;
  begin perform public.end_temporary_assignment(second_assignment, ' ');
  exception when others then failed := sqlerrm = 'motivo_obrigatorio'; end;
  perform pg_temp.ta_assert(failed, 'encerrou sem motivo');

  result := public.end_temporary_assignment(second_assignment, 'Direção redistribuiu', false);
  perform pg_temp.ta_assert((result ->> 'closed')::int = 6, 'encerrar: fecha o futuro ' || result::text);
  perform pg_temp.ta_assert((select count(*) from public.reschedules where temporary_assignment_id = second_assignment and used_at is null) = 1, 'encerrar: aula passada sem lancamento sumiu');
  perform pg_temp.ta_assert((select count(*) from public.reschedules where temporary_assignment_id = second_assignment and date = 'Pendente' and closed_reason is not null) = 6, 'encerrar: data mantida');
  perform pg_temp.ta_assert((select count(*) from public.upcoming_classes u join public.reschedules r on r.id = u.source_id where u.source_type = 'reschedule' and r.temporary_assignment_id = second_assignment and r.closed_reason is not null) = 0, 'encerrar: aula cancelada segue em upcoming_classes');
  perform pg_temp.ta_assert((select count(*) from public.reschedule_events e join public.reschedules r on r.id = e.reschedule_id where r.temporary_assignment_id = second_assignment and e.action = 'encerrada' and e.from_date ~ '^\d{4}-') = 6, 'encerrar: trilha perdeu a data');
  result := public.end_temporary_assignment(second_assignment, 'De novo', false);
  perform pg_temp.ta_assert((result ->> 'already')::boolean, 'encerrar: nao idempotente');
  perform pg_temp.ta_assert((select status from public.temporary_lesson_assignments where id = second_assignment) = 'ENDED', 'encerrar: status');
  perform pg_temp.ta_assert(public.list_temporary_assignments(aluno) -> 0 ->> 'id' = assignment::text, 'lista: ativa primeiro');

  -- Crédito antigo sem data vira a aula gerada, sem contar em dobro, e volta se cancelar.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into public.reschedules(tenant_id, teacher_id, student_id, date, time, fault_type, created_at)
    select tenant, origem, aluna2, 'Pendente', 'Pendente', 'STUDENT', now() - (g || ' days')::interval from generate_series(1, 3) g;
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  preview := public.preview_temporary_assignment(aluna2, origem, temporaria, sat1 + 1, sat1 + 15, '[{"day_of_week":0,"start":"14:00","end":"14:30"}]', null);
  perform pg_temp.ta_assert((preview ->> 'open_credits')::int = 3, 'credito: nao contou os abertos');
  perform pg_temp.ta_assert((preview ->> 'owed')::int = 3, 'credito: saldo sugerido');
  perform pg_temp.ta_assert((preview ->> 'generated')::int = 3, 'credito: plano');
  result := public.create_temporary_assignment(aluna2, origem, temporaria, sat1 + 1, sat1 + 15, '[{"day_of_week":0,"start":"14:00","end":"14:30"}]', 3, 'Redistribuição', gen_random_uuid(), false);
  n := (result ->> 'generated')::int;
  perform pg_temp.ta_assert((result ->> 'absorbed_credits')::int = n, 'credito: substituicao');
  perform pg_temp.ta_assert((select count(*) from public.reschedules where student_id = aluna2 and teacher_id = origem and used_at is null) = 3 - n, 'credito: em dobro');
  perform pg_temp.ta_assert((select count(*) from public.reschedules where student_id = aluna2 and teacher_id = origem and replaced_by_assignment_id = (result ->> 'id')::uuid and closed_reason = 'Substituída por reposição agendada') = n, 'credito: trilha');
  result := public.end_temporary_assignment((result ->> 'id')::uuid, 'Mudou de ideia', false);
  perform pg_temp.ta_assert((result ->> 'reopened_credits')::int = n, 'credito: nao voltou');
  perform pg_temp.ta_assert((select count(*) from public.reschedules where student_id = aluna2 and teacher_id = origem and used_at is null and closed_reason is null and replaced_by_assignment_id is null) = 3, 'credito: nao reabriu');

  -- Termina sozinha: acabou o período, ninguém precisa lembrar.
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  result := public.create_temporary_assignment(aluna3, origem, temporaria, sat1 + 2, sat1 + 8, '[{"day_of_week":1,"start":"15:00","end":"15:30"}]', 1, 'Só uma', gen_random_uuid(), false);
  r1 := (result ->> 'id')::uuid;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform pg_temp.ta_assert(private.end_due_temporary_assignments() >= 0, 'rotina');
  perform pg_temp.ta_assert((select status from public.temporary_lesson_assignments where id = r1) = 'ACTIVE', 'rotina: encerrou antes da hora');
  perform pg_temp.ta_assert((select status from public.temporary_lesson_assignments where id = assignment) = 'ACTIVE', 'rotina: encerrou a que tem aula futura');
  perform set_config('app.reschedule_silent', 'on', true);
  update public.reschedules set date = (today - 1)::text where temporary_assignment_id = r1;
  perform set_config('app.reschedule_silent', '', true);
  update public.temporary_lesson_assignments set ends_on = today - 1, starts_on = today - 8 where id = r1;
  perform private.end_due_temporary_assignments();
  perform pg_temp.ta_assert((select status = 'ENDED' and ended_automatically and end_reason = 'Fim do período' from public.temporary_lesson_assignments where id = r1), 'rotina: nao encerrou no fim do periodo');
  perform pg_temp.ta_assert((select count(*) from public.reschedules where temporary_assignment_id = r1 and used_at is null) = 1, 'rotina: apagou aula a lancar');
  perform pg_temp.ta_assert(exists(select 1 from public.notification_queue where tenant_id = tenant and idempotency_key = format('temporary-assignment:%s:finished:group', r1)), 'rotina: sem aviso a coordenacao');
  perform pg_temp.ta_assert(not exists(select 1 from public.notification_queue where tenant_id = tenant and idempotency_key = format('temporary-assignment:%s:finished:family', r1)), 'rotina: avisou a familia sem necessidade');

  -- Outra escola não encerra nem lista.
  perform set_config('request.jwt.claims', json_build_object('sub', outsider, 'role', 'authenticated')::text, true);
  failed := false;
  begin perform public.end_temporary_assignment(assignment, 'Invasão', false);
  exception when others then failed := sqlerrm = 'atribuicao_nao_encontrada'; end;
  perform pg_temp.ta_assert(failed, 'outra escola encerrou');
  perform pg_temp.ta_assert(jsonb_array_length(public.list_temporary_assignments()) = 0, 'outra escola listou');

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end;
$test$;
rollback;
