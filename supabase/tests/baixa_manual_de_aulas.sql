\set ON_ERROR_STOP on
begin;
-- Baixa manual de aulas: prova oral de quem não é aluno e reposição de aluno da
-- escola entram na folha como lançamento de aula, com motivo. Identidades e
-- escola isoladas; nada sai deste rollback.
create or replace function pg_temp.bm_assert(v boolean, m text) returns void language plpgsql as $$
begin if not coalesce(v, false) then raise exception 'baixa manual: %', m; end if; end $$;

do $test$
declare
  tenant text := 'manual-lesson-' || gen_random_uuid();
  other_tenant text := 'manual-lesson-other-' || gen_random_uuid();
  adm uuid := gen_random_uuid();
  coord uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  prof uuid := gen_random_uuid();
  prof_out uuid := gen_random_uuid();
  aluno uuid := gen_random_uuid();
  today date := (now() at time zone 'America/Sao_Paulo')::date;
  d date := today - 2;
  closed_day date := (date_trunc('month', today) - interval '1 day')::date;
  m text := to_char(today - 2, 'YYYY-MM');
  result jsonb;
  oral uuid;
  repo uuid;
  failed boolean;
  r uuid;
  before_sum numeric;
begin
  perform set_config('request.headers', '{}', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- Tabelas fechadas; RPC só para quem está logado.
  perform pg_temp.bm_assert(not has_table_privilege('authenticated', 'public.manual_lesson_entries', 'SELECT'), 'tabela aberta para authenticated');
  perform pg_temp.bm_assert(not has_table_privilege('anon', 'public.manual_lesson_entries', 'SELECT'), 'tabela aberta para anon');
  perform pg_temp.bm_assert(not has_table_privilege('authenticated', 'public.manual_lesson_entry_logs', 'SELECT'), 'vinculos abertos');
  perform pg_temp.bm_assert(not has_function_privilege('anon', 'public.create_manual_lesson_entry(uuid,text,date,time,integer,uuid,text,text,numeric)', 'EXECUTE'), 'lancar aberto para anon');
  perform pg_temp.bm_assert(has_function_privilege('authenticated', 'public.create_manual_lesson_entry(uuid,text,date,time,integer,uuid,text,text,numeric)', 'EXECUTE'), 'lancar fechado para authenticated');
  perform pg_temp.bm_assert(not has_function_privilege('anon', 'public.list_manual_lesson_entries(text)', 'EXECUTE'), 'listar aberto para anon');
  perform pg_temp.bm_assert(not has_function_privilege('authenticated', 'private.manual_lesson_require_manager()', 'EXECUTE'), 'funcao interna aberta');

  insert into public.tenants(id, name) values (tenant, 'BM fixture'), (other_tenant, 'BM other');
  insert into auth.users(id, email, raw_app_meta_data, raw_user_meta_data)
    select id, id || '@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'
      from unnest(array[adm, coord, outsider, prof, prof_out, aluno]) as f(id);
  update public.profiles set tenant_id = tenant, role = 'SCHOOL_ADMIN', full_name = 'BM Direção', status = 'Ativo', lifecycle_status = 'active', is_test_account = true where id = adm;
  update public.profiles set tenant_id = tenant, role = 'COORDINATOR', full_name = 'BM Coordenação', status = 'Ativo', lifecycle_status = 'active', is_test_account = true where id = coord;
  update public.profiles set tenant_id = other_tenant, role = 'SCHOOL_ADMIN', full_name = 'BM Outra escola', status = 'Ativo', lifecycle_status = 'active', is_test_account = true where id = outsider;
  update public.profiles set tenant_id = tenant, role = 'TEACHER', full_name = 'BM Professora', status = 'Ativo', lifecycle_status = 'active', hourly_rate = 8, is_test_account = true where id = prof;
  update public.profiles set tenant_id = other_tenant, role = 'TEACHER', full_name = 'BM Professora de fora', status = 'Ativo', lifecycle_status = 'active', hourly_rate = 8, is_test_account = true where id = prof_out;
  update public.profiles set tenant_id = tenant, role = 'STUDENT', full_name = 'BM Aluno', status = 'Ativo', lifecycle_status = 'active', is_test_account = true where id = aluno;
  insert into public.tenant_memberships(tenant_id, user_id, role, status)
    select tenant_id, id, role, 'ACTIVE' from public.profiles where id = any(array[adm, coord, outsider, prof, prof_out, aluno])
    on conflict (tenant_id, user_id) do update set role = excluded.role, status = 'ACTIVE';

  -- Professora, aluno e outra escola não lançam.
  foreach r in array array[prof, aluno, outsider] loop
    perform set_config('request.jwt.claims', json_build_object('sub', r, 'role', 'authenticated')::text, true);
    failed := false;
    begin
      perform public.create_manual_lesson_entry(prof, 'TESTE_ORAL', d, '10:00', 1, null, 'Pessoa de fora', 'Prova oral de quem não é aluno');
    exception when others then failed := true; end;
    perform pg_temp.bm_assert(failed, 'sem permissao lancou: ' || r);
  end loop;

  -- Coordenação vê as opções e lança a prova oral de quem não é aluno.
  perform set_config('request.jwt.claims', json_build_object('sub', coord, 'role', 'authenticated')::text, true);
  result := public.manual_lesson_options();
  perform pg_temp.bm_assert(jsonb_array_length(result -> 'teachers') = 1 and jsonb_array_length(result -> 'students') = 1, 'opcoes');

  result := public.create_manual_lesson_entry(prof, 'TESTE_ORAL', d, '10:00', 1, null, 'Sara Élisa', 'Prova oral de avaliação, aluna de outra escola');
  oral := (result ->> 'id')::uuid;
  perform pg_temp.bm_assert((result ->> 'valor')::numeric = 8, 'prova oral: valor ' || coalesce(result ->> 'valor', 'nulo'));
  perform pg_temp.bm_assert(exists(select 1 from public.class_logs cl join public.manual_lesson_entry_logs l on l.class_log_id = cl.id
     where l.entry_id = oral and cl.subtype = 'Teste Oral' and cl.student_id is null and cl.presence = 'COMPLETED'
       and cl.teacher_id = prof and cl.class_date = d and cl.start_time = '10:00'), 'prova oral: lancamento');
  perform pg_temp.bm_assert((select created_by from public.manual_lesson_entries where id = oral) = coord, 'trilha: quem lancou');
  perform pg_temp.bm_assert(not exists(select 1 from public.class_logs cl join public.manual_lesson_entry_logs l on l.class_log_id = cl.id
     where l.entry_id = oral and cl.notes like '%avaliação%'), 'motivo vazou para o lancamento do professor');

  -- A mesma pessoa no mesmo dia é a mesma aula, com ou sem acento.
  failed := false;
  begin perform public.create_manual_lesson_entry(prof, 'TESTE_ORAL', d, '15:00', 1, null, '  sara elisa ', 'Repetiu a prova oral sem querer');
  exception when others then failed := sqlerrm = 'ja_lancado_para_esta_pessoa'; end;
  perform pg_temp.bm_assert(failed, 'duplicou a mesma pessoa');

  -- Horário já ocupado pela professora.
  failed := false;
  begin perform public.create_manual_lesson_entry(prof, 'OUTRO', d, '10:00', 1, null, 'Outra pessoa', 'Aula avulsa combinada com a escola');
  exception when others then failed := sqlerrm = 'professor_ja_tem_aula_no_horario'; end;
  perform pg_temp.bm_assert(failed, 'aceitou horario ocupado');

  -- Motivo, futuro, aluno e nome juntos, professora de outra escola.
  failed := false;
  begin perform public.create_manual_lesson_entry(prof, 'OUTRO', d, '11:00', 1, null, 'X Y', 'curto');
  exception when others then failed := sqlerrm = 'motivo_obrigatorio'; end;
  perform pg_temp.bm_assert(failed, 'aceitou sem motivo');
  failed := false;
  begin perform public.create_manual_lesson_entry(prof, 'OUTRO', today + 1, '11:00', 1, null, 'X Y', 'Aula que ainda vai acontecer');
  exception when others then failed := sqlerrm = 'aula_ainda_nao_terminou'; end;
  perform pg_temp.bm_assert(failed, 'aceitou aula futura');
  failed := false;
  begin perform public.create_manual_lesson_entry(prof, 'OUTRO', d, '11:00', 1, aluno, 'X Y', 'Aluno e nome ao mesmo tempo');
  exception when others then failed := sqlerrm = 'aluno_ou_nome'; end;
  perform pg_temp.bm_assert(failed, 'aceitou aluno e nome');
  failed := false;
  begin perform public.create_manual_lesson_entry(prof_out, 'OUTRO', d, '11:00', 1, null, 'X Y', 'Professora de outra escola');
  exception when others then failed := sqlerrm = 'professor_nao_encontrado'; end;
  perform pg_temp.bm_assert(failed, 'aceitou professora de outra escola');
  failed := false;
  begin perform public.create_manual_lesson_entry(prof, 'OUTRO', d, '11:15', 1, null, 'X Y', 'Horário fora da meia hora');
  exception when others then failed := sqlerrm = 'data_ou_horario_invalido'; end;
  perform pg_temp.bm_assert(failed, 'aceitou horario quebrado');

  -- Reposição de aluno da escola, 1 hora, com o valor combinado pela direção.
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  result := public.create_manual_lesson_entry(prof, 'REPOSICAO', d, '13:30', 2, aluno, null, 'Reposição deixada pela professora anterior', 10);
  repo := (result ->> 'id')::uuid;
  perform pg_temp.bm_assert((result ->> 'aulas')::int = 2 and (result ->> 'valor')::numeric = 20, 'reposicao: valor ' || coalesce(result ->> 'valor', 'nulo'));
  perform pg_temp.bm_assert((select count(*) from public.class_logs cl join public.manual_lesson_entry_logs l on l.class_log_id = cl.id
     where l.entry_id = repo and cl.subtype = 'REPOSIÇÃO MANUAL' and cl.student_id = aluno) = 2, 'reposicao: dois lancamentos');
  perform pg_temp.bm_assert(exists(select 1 from public.class_logs where teacher_id = prof and class_date = d and start_time = '14:00'), 'reposicao: segunda meia hora');

  -- O aluno não tem duas aulas no mesmo horário.
  failed := false;
  begin perform public.create_manual_lesson_entry(prof, 'OUTRO', d, '14:00', 1, aluno, null, 'Mesmo aluno, mesmo horário');
  exception when others then failed := sqlerrm in ('professor_ja_tem_aula_no_horario', 'aluno_ja_tem_aula_no_horario'); end;
  perform pg_temp.bm_assert(failed, 'aluno duplicado');

  -- Lista do mês: as duas baixas, com valor e quem lançou.
  result := public.list_manual_lesson_entries(m);
  perform pg_temp.bm_assert(jsonb_array_length(result) = 2, 'lista: quantidade');
  perform pg_temp.bm_assert(exists(select 1 from jsonb_array_elements(result) e where e ->> 'id' = oral::text
     and e ->> 'guest_name' = 'Sara Élisa' and e ->> 'created_by_name' = 'BM Coordenação' and (e ->> 'valor')::numeric = 8), 'lista: prova oral');

  -- Outra escola não vê.
  perform set_config('request.jwt.claims', json_build_object('sub', outsider, 'role', 'authenticated')::text, true);
  perform pg_temp.bm_assert(jsonb_array_length(public.list_manual_lesson_entries(m)) = 0, 'outra escola listou');
  failed := false;
  begin perform public.cancel_manual_lesson_entry(oral, 'Tentativa de outra escola');
  exception when others then failed := sqlerrm = 'baixa_nao_encontrada'; end;
  perform pg_temp.bm_assert(failed, 'outra escola cancelou');

  -- Mês fechado recusa.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into public.teacher_closings(tenant_id, teacher_id, month_year, status)
    values (tenant, prof, to_char(closed_day, 'YYYY-MM'), 'PAGO');
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  failed := false;
  begin perform public.create_manual_lesson_entry(prof, 'EXPERIMENTAL', closed_day, '09:00', 1, null, 'Lead de fora', 'Experimental de mês já pago');
  exception when others then failed := sqlerrm = 'mes_fechado'; end;
  perform pg_temp.bm_assert(failed, 'aceitou mes fechado');

  -- Cancelar tira da folha e guarda a trilha.
  select coalesce(sum(rate_efetivo), 0) into before_sum from public.v_payable_class_logs where teacher_id = prof;
  failed := false;
  begin perform public.cancel_manual_lesson_entry(oral, 'curto');
  exception when others then failed := sqlerrm = 'motivo_obrigatorio'; end;
  perform pg_temp.bm_assert(failed, 'cancelou sem motivo');
  result := public.cancel_manual_lesson_entry(oral, 'Lançada para a professora errada');
  perform pg_temp.bm_assert((select coalesce(sum(rate_efetivo), 0) from public.v_payable_class_logs where teacher_id = prof) = before_sum - 8, 'cancelar: valor nao saiu');
  perform pg_temp.bm_assert((select cancelled_by = adm and cancel_reason is not null from public.manual_lesson_entries where id = oral), 'cancelar: trilha');
  perform pg_temp.bm_assert((public.cancel_manual_lesson_entry(oral, 'Segundo clique no botão') ->> 'ja_cancelada')::boolean, 'cancelar: repetido');
  -- Depois de cancelada, a mesma pessoa pode ser lançada de novo.
  result := public.create_manual_lesson_entry(prof, 'TESTE_ORAL', d, '10:00', 1, null, 'Sara Elisa', 'Prova oral lançada de novo, agora certa');
  perform pg_temp.bm_assert((result ->> 'ok')::boolean, 'relancar depois de cancelar');

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end;
$test$;
rollback;
