-- Cartão do aluno preenchido pelo professor, sem IA (migration 20260926220000).
-- Prova: quem escreve (professor vinculado, coordenação, direção — e mais
-- ninguém), a regra de menor de idade, os limites de tamanho, a conferência de
-- versão e que o histórico e a leitura do dossiê não guardam o texto.
-- Contra o código antigo reprova já no primeiro bloco (a tabela não existe e o
-- dossiê não devolve 'learning_card').
\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.card_assert(p_ok boolean, p_message text)
returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then
    raise exception 'cartao do aluno: %', p_message;
  end if;
end;
$$;

-- Salva como p_actor e devolve 'ok:<versão>' ou a mensagem do erro.
create or replace function pg_temp.card_save(
  p_actor uuid, p_student uuid, p_goal text, p_topics text[], p_style text,
  p_avoid text[], p_notes text, p_version integer
) returns text language plpgsql as $$
declare
  v_result jsonb;
begin
  if p_actor is null then
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  else
    perform set_config('request.jwt.claims',
      jsonb_build_object('sub', p_actor, 'role', 'authenticated')::text, true);
  end if;
  v_result := public.save_student_learning_card(
    p_student, p_goal, p_topics, p_style, p_avoid, p_notes, p_version);
  return 'ok:' || (v_result ->> 'version');
exception when others then
  return sqlerrm;
end;
$$;

create or replace function pg_temp.card_handover(p_actor uuid, p_student uuid, p_ack boolean default false)
returns jsonb language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_actor, 'role', 'authenticated')::text, true);
  return public.get_student_handover(p_student, p_ack);
end;
$$;

do $privileges$
begin
  perform pg_temp.card_assert(
    to_regclass('public.student_learning_cards') is not null
    and to_regclass('private.student_learning_card_events') is not null,
    'tabelas do cartão não existem');
  perform pg_temp.card_assert(
    not has_table_privilege('authenticated', 'public.student_learning_cards', 'SELECT')
    and not has_table_privilege('authenticated', 'public.student_learning_cards', 'INSERT')
    and not has_table_privilege('authenticated', 'public.student_learning_cards', 'UPDATE')
    and not has_table_privilege('anon', 'public.student_learning_cards', 'SELECT'),
    'o navegador alcança a tabela do cartão sem passar pela RPC');
  perform pg_temp.card_assert(
    has_table_privilege('service_role', 'public.student_learning_cards', 'SELECT')
    and not has_table_privilege('service_role', 'public.student_learning_cards', 'INSERT')
    and not has_table_privilege('service_role', 'public.student_learning_cards', 'UPDATE')
    and not has_table_privilege('service_role', 'public.student_learning_cards', 'DELETE'),
    'o Planner precisa ler o cartão, e só ler');
  perform pg_temp.card_assert(
    not has_table_privilege('authenticated', 'private.student_learning_card_events', 'SELECT')
    and not has_table_privilege('service_role', 'private.student_learning_card_events', 'SELECT'),
    'histórico do cartão exposto');
  perform pg_temp.card_assert(
    has_function_privilege('authenticated',
      'public.save_student_learning_card(uuid,text,text[],text,text[],text,integer)', 'EXECUTE')
    and not has_function_privilege('anon',
      'public.save_student_learning_card(uuid,text,text[],text,text[],text,integer)', 'EXECUTE'),
    'RPC de escrita com permissão errada');
  perform pg_temp.card_assert(
    has_function_privilege('authenticated', 'public.get_student_handover(uuid,boolean)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.get_student_handover(uuid,boolean)', 'EXECUTE'),
    'dossiê perdeu a rota do professor ou ganhou rota anônima');
  perform pg_temp.card_assert(
    not has_function_privilege('authenticated', 'private.student_learning_card_guard()', 'EXECUTE')
    and not has_function_privilege('authenticated', 'private.student_learning_card_log()', 'EXECUTE')
    and not has_function_privilege('authenticated', 'private.student_learning_card_view(text,uuid)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'private.student_learning_card_can_edit(text,uuid)', 'EXECUTE'),
    'função interna do cartão exposta ao navegador');
  -- O histórico não tem onde guardar texto: só quem, quando e quais campos.
  perform pg_temp.card_assert(
    (select array_agg(column_name::text order by column_name::text)
       from information_schema.columns
      where table_schema = 'private' and table_name = 'student_learning_card_events')
    = array['actor_id', 'actor_role', 'card_version', 'changed_fields', 'created_at',
            'id', 'student_id', 'tenant_id'],
    'histórico do cartão ganhou coluna de conteúdo');
  perform pg_temp.card_assert(
    not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'profiles'
                   and column_name in ('real_goal', 'engaging_topics', 'correction_style', 'correction_preference')),
    'o cartão não é coluna de profiles');
end
$privileges$;

do $test$
declare
  v_tid text := 'cartao-fixture';
  v_admin uuid := gen_random_uuid();
  v_coord uuid := gen_random_uuid();
  v_teacher uuid := gen_random_uuid();
  v_teacher_booking uuid := gen_random_uuid();
  v_teacher_other uuid := gen_random_uuid();
  v_super uuid := gen_random_uuid();
  v_outsider uuid := gen_random_uuid();
  v_adult uuid := gen_random_uuid();
  v_kid uuid := gen_random_uuid();
  v_teen uuid := gen_random_uuid();
  v_eighteen uuid := gen_random_uuid();
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_r text;
  v_h jsonb;
  v_card public.student_learning_cards%rowtype;
  v_blocked boolean;
  v_nine text[] := array['a1','a2','a3','a4','a5','a6','a7','a8','a9'];
  v_seven text[] := array['b1','b2','b3','b4','b5','b6','b7'];
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into public.tenants (id, name) values
    (v_tid, 'Cartão fixture'), ('cartao-outra', 'Cartão outra escola');
  insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data) values
    (v_admin, 'card-admin@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_coord, 'card-coord@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_teacher, 'card-teacher@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_teacher_booking, 'card-teacher-b@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_teacher_other, 'card-teacher-o@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_super, 'card-super@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_outsider, 'card-outsider@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_adult, 'card-adult@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_kid, 'card-kid@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_teen, 'card-teen@example.invalid', '{"provider":"email"}', '{"test_fixture":true}'),
    (v_eighteen, 'card-eighteen@example.invalid', '{"provider":"email"}', '{"test_fixture":true}');
  update public.profiles
     set tenant_id = case when id = v_outsider then 'cartao-outra' else v_tid end,
         lifecycle_status = 'active', is_test_account = true,
         role = case
           when id in (v_admin, v_outsider) then 'SCHOOL_ADMIN'
           when id = v_coord then 'COORDINATOR'
           when id = v_super then 'SUPER_ADMIN'
           when id in (v_teacher, v_teacher_booking, v_teacher_other) then 'TEACHER'
           else 'STUDENT' end,
         full_name = case
           when id = v_admin then 'Direcao Cartao'
           when id = v_coord then 'Coordenacao Cartao'
           when id = v_teacher then 'Professora Titular'
           when id = v_teacher_booking then 'Professor da Agenda'
           else 'Fixture Cartao' end,
         is_kids = (id = v_kid),
         birth_date = case
           when id = v_teen then v_today - interval '15 years'
           -- Faz 18 anos amanhã: ainda é menor hoje.
           when id = v_eighteen then v_today - interval '18 years' + interval '1 day'
           else null end,
         professor_id = case when id in (v_adult, v_kid, v_teen, v_eighteen) then v_teacher end
   where id in (v_admin, v_coord, v_teacher, v_teacher_booking, v_teacher_other, v_super,
                v_outsider, v_adult, v_kid, v_teen, v_eighteen);
  -- A tabela de vínculo não aceita SUPER_ADMIN: o suporte entra na escola como
  -- membro, e o papel efetivo continua SUPER_ADMIN (private.active_tenant_role).
  insert into public.tenant_memberships (tenant_id, user_id, role, status)
    select tenant_id, id, case when role = 'SUPER_ADMIN' then 'SCHOOL_ADMIN' else role end, 'ACTIVE'
      from public.profiles
     where id in (v_admin, v_coord, v_teacher, v_teacher_booking, v_teacher_other, v_super,
                  v_outsider, v_adult, v_kid, v_teen, v_eighteen)
  on conflict (tenant_id, user_id) do update set role = excluded.role, status = 'ACTIVE';
  -- Professor vinculado só pela agenda (sem professor_id). Aula avulsa (com
  -- data): a fixa faria private.sync_student_primary_teacher trocar o
  -- professor_id do aluno para ele, e o teste perderia o vínculo da titular.
  insert into public.bookings (id, tenant_id, teacher_id, student_id, day_of_week, time_slot, status, start_date, date)
  values (gen_random_uuid(), v_tid, v_teacher_booking, v_adult, 'Segunda', '10:00', 'SCHEDULED', v_today, v_today + 1);
  perform pg_temp.card_assert(
    (select professor_id = v_teacher from public.profiles where id = v_adult),
    'fixture: a titular perdeu o vínculo com o aluno');

  -- Professora titular preenche: texto limpo, tema repetido sai, item vazio sai.
  v_r := pg_temp.card_save(v_teacher, v_adult,
    '  Apresentar   resultados em reuniões  ',
    array['futebol', ' Futebol ', 'séries de ficção', ''],
    ' Selective ', array['spoilers'], 'Prefere começar com conversa livre.', 0);
  perform pg_temp.card_assert(v_r = 'ok:1', 'titular não salvou o cartão: ' || v_r);
  select * into v_card from public.student_learning_cards where tenant_id = v_tid and student_id = v_adult;
  perform pg_temp.card_assert(
    v_card.real_goal = 'Apresentar resultados em reuniões'
    and v_card.engaging_topics = array['futebol', 'séries de ficção']
    and v_card.correction_style = 'selective'
    and v_card.avoid_topics = array['spoilers']
    and v_card.updated_by = v_teacher and v_card.version = 1,
    'cartão gravado sem normalização');
  perform pg_temp.card_assert(
    (select count(*) = 1 from private.student_learning_card_events where student_id = v_adult)
    and (select actor_id = v_teacher and actor_role = 'TEACHER'
                and changed_fields = array['real_goal','engaging_topics','correction_style','avoid_topics','notes']
           from private.student_learning_card_events where student_id = v_adult),
    'histórico da criação errado');
  perform pg_temp.card_assert(
    not exists (select 1 from private.student_learning_card_events e
                 where to_jsonb(e)::text like '%conversa livre%' or to_jsonb(e)::text like '%futebol%'),
    'o histórico guardou o texto do cartão');

  -- Dossiê devolve o cartão; a confirmação de leitura guarda só a versão.
  v_h := pg_temp.card_handover(v_teacher, v_adult, true);
  perform pg_temp.card_assert(
    v_h -> 'learning_card' ->> 'real_goal' = 'Apresentar resultados em reuniões'
    and (v_h -> 'learning_card' ->> 'can_edit')::boolean
    and not (v_h -> 'learning_card' ->> 'is_minor')::boolean
    and v_h -> 'learning_card' ->> 'notes' = 'Prefere começar com conversa livre.'
    and v_h -> 'learning_card' ->> 'updated_by_name' = 'Professora Titular'
    and jsonb_array_length(v_h -> 'learning_card' -> 'history') = 1
    and (v_h -> 'learning_card' -> 'limits' ->> 'notes')::integer = 400,
    'dossiê sem o cartão: ' || coalesce(v_h::text, 'null'));
  perform pg_temp.card_assert(
    (select not (snapshot ? 'learning_card') and snapshot ->> 'learning_card_version' = '1'
            and snapshot::text not like '%conversa livre%'
       from private.student_handover_reads where student_id = v_adult order by created_at desc limit 1),
    'a confirmação de leitura copiou o texto do cartão');

  -- Salvar igual não gera versão nem histórico.
  v_r := pg_temp.card_save(v_teacher, v_adult, 'Apresentar resultados em reuniões',
    array['futebol', 'séries de ficção'], 'selective', array['spoilers'],
    'Prefere começar com conversa livre.', 1);
  perform pg_temp.card_assert(v_r = 'ok:1'
    and (select count(*) = 1 from private.student_learning_card_events where student_id = v_adult),
    'salvamento sem mudança virou versão nova: ' || v_r);

  -- Coordenação muda só a nota; o histórico diz quem e qual campo.
  v_r := pg_temp.card_save(v_coord, v_adult, 'Apresentar resultados em reuniões',
    array['futebol', 'séries de ficção'], 'selective', array['spoilers'],
    'Rende mais com roleplay de reunião.', 1);
  perform pg_temp.card_assert(v_r = 'ok:2', 'coordenação não salvou: ' || v_r);
  perform pg_temp.card_assert(
    (select actor_id = v_coord and actor_role = 'COORDINATOR' and changed_fields = array['notes']
           and card_version = 2
       from private.student_learning_card_events where student_id = v_adult
      order by id desc limit 1),
    'histórico da coordenação errado');

  -- Versão velha não sobrescreve o que outra pessoa escreveu.
  v_r := pg_temp.card_save(v_teacher, v_adult, 'Outro objetivo', '{}', null, '{}', '', 1);
  perform pg_temp.card_assert(v_r = 'cartao_alterado_por_outra_pessoa',
    'versão velha sobrescreveu o cartão: ' || v_r);

  -- Professor vinculado pela agenda também escreve.
  v_r := pg_temp.card_save(v_teacher_booking, v_adult, 'Apresentar resultados em reuniões',
    array['futebol', 'séries de ficção', 'viagens'], 'selective', array['spoilers'],
    'Rende mais com roleplay de reunião.', 2);
  perform pg_temp.card_assert(v_r = 'ok:3', 'professor da agenda não salvou: ' || v_r);

  -- Quem não pode: outro professor da escola, outra escola, suporte da
  -- plataforma, o próprio aluno e anônimo.
  perform pg_temp.card_assert(
    pg_temp.card_save(v_teacher_other, v_adult, 'x', '{}', null, '{}', '', null) = 'sem_permissao',
    'professor sem vínculo escreveu o cartão');
  perform pg_temp.card_assert(
    pg_temp.card_save(v_outsider, v_adult, 'x', '{}', null, '{}', '', null) = 'sem_permissao',
    'outra escola escreveu o cartão');
  perform pg_temp.card_assert(
    pg_temp.card_save(v_super, v_adult, 'x', '{}', null, '{}', '', null) = 'sem_permissao',
    'suporte da plataforma escreveu o cartão');
  perform pg_temp.card_assert(
    pg_temp.card_save(v_adult, v_adult, 'x', '{}', null, '{}', '', null) = 'sem_permissao',
    'o aluno escreveu o próprio cartão');
  perform pg_temp.card_assert(
    pg_temp.card_save(null, v_adult, 'x', '{}', null, '{}', '', null) = 'sem_permissao',
    'anônimo escreveu o cartão');
  v_blocked := false;
  begin perform pg_temp.card_handover(v_teacher_other, v_adult);
  exception when others then v_blocked := true; end;
  perform pg_temp.card_assert(v_blocked, 'professor sem vínculo leu o dossiê');

  -- Limites: o servidor recusa (não corta) texto longo demais.
  perform pg_temp.card_assert(
    pg_temp.card_save(v_teacher, v_adult, repeat('a', 301), '{}', null, '{}', '', null)
      = 'cartao_texto_longo:real_goal', 'objetivo acima de 300 aceito');
  perform pg_temp.card_assert(
    pg_temp.card_save(v_teacher, v_adult, 'ok', '{}', null, '{}', repeat('n', 401), null)
      = 'cartao_texto_longo:notes', 'nota acima de 400 aceita');
  perform pg_temp.card_assert(
    pg_temp.card_save(v_teacher, v_adult, 'ok', array[repeat('t', 61)], null, '{}', '', null)
      = 'cartao_texto_longo:engaging_topics', 'tema acima de 60 aceito');
  perform pg_temp.card_assert(
    pg_temp.card_save(v_teacher, v_adult, 'ok', '{}', null, array[repeat('t', 61)], '', null)
      = 'cartao_texto_longo:avoid_topics', 'item a evitar acima de 60 aceito');
  perform pg_temp.card_assert(
    pg_temp.card_save(v_teacher, v_adult, 'ok', v_nine, null, '{}', '', null)
      = 'cartao_itens_demais:engaging_topics', 'nove temas aceitos');
  perform pg_temp.card_assert(
    pg_temp.card_save(v_teacher, v_adult, 'ok', '{}', null, v_seven, '', null)
      = 'cartao_itens_demais:avoid_topics', 'sete itens a evitar aceitos');
  perform pg_temp.card_assert(
    pg_temp.card_save(v_teacher, v_adult, 'ok', '{}', 'gentle', '{}', '', null)
      = 'cartao_estilo_invalido', 'estilo de correção inventado aceito');
  perform pg_temp.card_assert(
    (select version = 3 from public.student_learning_cards where student_id = v_adult),
    'recusa mexeu no cartão');
  v_r := pg_temp.card_save(v_teacher, v_adult, repeat('a', 300), array[repeat('t', 60)],
    'immediate', array[repeat('e', 60)], repeat('n', 400), 3);
  perform pg_temp.card_assert(v_r = 'ok:4', 'limite exato recusado: ' || v_r);

  -- Menor (is_kids): só objetivo e temas.
  v_r := pg_temp.card_save(v_admin, v_kid, 'Ler histórias curtas', array['dinossauros'], null, '{}', '', 0);
  perform pg_temp.card_assert(v_r = 'ok:1', 'direção não salvou cartão de criança: ' || v_r);
  perform pg_temp.card_assert(
    pg_temp.card_save(v_admin, v_kid, 'Ler', '{}', null, '{}', 'Nota pessoal', null)
      = 'cartao_campo_de_menor:notes', 'nota em cartão de criança aceita');
  perform pg_temp.card_assert(
    pg_temp.card_save(v_teacher, v_kid, 'Ler', '{}', null, array['escola'], '', null)
      = 'cartao_campo_de_menor:avoid_topics', '"o que evitar" em cartão de criança aceito');
  perform pg_temp.card_assert(
    pg_temp.card_save(v_teacher, v_kid, 'Ler', '{}', 'immediate', '{}', '', null)
      = 'cartao_campo_de_menor:correction_style', 'estilo de correção em cartão de criança aceito');
  v_h := pg_temp.card_handover(v_teacher, v_kid);
  perform pg_temp.card_assert(
    (v_h -> 'learning_card' ->> 'is_minor')::boolean
    and v_h -> 'learning_card' -> 'engaging_topics' = '["dinossauros"]'::jsonb,
    'dossiê da criança sem o cartão');

  -- Menor pela data de nascimento (sem is_kids), inclusive na véspera dos 18.
  perform pg_temp.card_assert(
    pg_temp.card_save(v_teacher, v_teen, 'Intercâmbio', '{}', null, '{}', 'Nota', null)
      = 'cartao_campo_de_menor:notes', 'adolescente pela data de nascimento aceitou nota');
  perform pg_temp.card_assert(
    pg_temp.card_save(v_teacher, v_eighteen, 'Vestibular', '{}', null, '{}', 'Nota', null)
      = 'cartao_campo_de_menor:notes', 'véspera dos 18 anos tratada como adulto');

  -- Cartão vazio que nunca existiu não vira linha nem histórico.
  v_r := pg_temp.card_save(v_teacher, v_teen, '   ', array['', '  '], '', '{}', '  ', 0);
  perform pg_temp.card_assert(v_r = 'ok:0'
    and not exists (select 1 from public.student_learning_cards where student_id = v_teen)
    and not exists (select 1 from private.student_learning_card_events where student_id = v_teen),
    'cartão vazio virou registro: ' || v_r);

  -- Adulto que passa a constar como menor: a nota antiga some da tela e o
  -- próximo salvamento a apaga de verdade.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  update public.profiles set birth_date = v_today - interval '10 years' where id = v_adult;
  v_h := pg_temp.card_handover(v_teacher, v_adult);
  perform pg_temp.card_assert(
    (v_h -> 'learning_card' ->> 'is_minor')::boolean
    and (v_h -> 'learning_card' ->> 'hidden_for_minor')::boolean
    and v_h -> 'learning_card' ->> 'notes' = ''
    and v_h -> 'learning_card' -> 'avoid_topics' = '[]'::jsonb
    and v_h -> 'learning_card' -> 'correction_style' = 'null'::jsonb,
    'nota pessoal de quem virou menor apareceu no dossiê');
  v_r := pg_temp.card_save(v_teacher, v_adult, 'Apresentar resultados', array['futebol'], null, '{}', '', 4);
  perform pg_temp.card_assert(v_r = 'ok:5', 'salvamento de quem virou menor falhou: ' || v_r);
  perform pg_temp.card_assert(
    (select notes = '' and avoid_topics = '{}'::text[] and correction_style is null
       from public.student_learning_cards where student_id = v_adult),
    'campo pessoal sobreviveu ao salvamento de menor');

  -- O gatilho vale para qualquer escritor, não só para a RPC.
  v_blocked := false;
  begin
    insert into public.student_learning_cards (tenant_id, student_id, notes)
    values (v_tid, v_teen, 'Escrito por fora da RPC');
  exception when others then v_blocked := sqlerrm = 'cartao_campo_de_menor:notes';
  end;
  perform pg_temp.card_assert(v_blocked, 'escrita direta furou a regra de menor');
  v_blocked := false;
  begin
    insert into public.student_learning_cards (tenant_id, student_id, real_goal)
    values ('cartao-outra', v_kid, 'Aluno de outra escola');
  exception when others then v_blocked := sqlerrm = 'cartao_aluno_invalido';
  end;
  perform pg_temp.card_assert(v_blocked, 'cartão gravado na escola errada');
end
$test$;

rollback;
