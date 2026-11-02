-- Cartão do aluno preenchido pelo professor, sem IA (migration 20260926220000).
-- Prova: quem escreve (professor vinculado, coordenação, direção — e mais
-- ninguém), a regra de menor de idade (a do termo + responsável cadastrado),
-- a limpeza de quem passa a ser menor, os limites de tamanho, a conferência de
-- versão, a chave imutável, a leitura do Planner e que o histórico e a leitura
-- do dossiê não guardam o texto.
-- Contra o código antigo reprova já no primeiro bloco (a tabela não existe e o
-- dossiê não devolve 'learning_card'); contra a primeira versão do cartão
-- reprova no responsável cadastrado, na limpeza e na troca de escola.
--
-- Vale com a régua do termo de 20260926120000 (idade não cadastrada = adulto)
-- e com a fail-closed de 20260926200000 (idade não comprovada = responsável):
-- o adulto do teste tem a data ATESTADA pela escola quando a RPC existe, e o
-- aluno sem data é conferido contra a própria régua do termo.
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

-- A escola atesta a data de nascimento pela RPC do termo quando ela existe
-- (régua fail-closed); sem a RPC, a data do cadastro já basta.
create or replace function pg_temp.card_attest_birth(p_admin uuid, p_student uuid, p_birth date)
returns void language plpgsql as $$
begin
  if to_regprocedure('public.set_student_birth_date(uuid,date,text)') is not null then
    perform set_config('request.jwt.claims',
      jsonb_build_object('sub', p_admin, 'role', 'authenticated')::text, true);
    execute 'select public.set_student_birth_date($1, $2, $3)'
      using p_student, p_birth, 'fixture do teste do cartão do aluno';
  end if;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
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
  -- O Planner lê pela RPC que já aplica a regra de menor; a tabela crua (com
  -- o texto de quem acabou de virar menor) não é porta de ninguém.
  perform pg_temp.card_assert(
    not has_table_privilege('service_role', 'public.student_learning_cards', 'SELECT')
    and not has_table_privilege('service_role', 'public.student_learning_cards', 'INSERT')
    and not has_table_privilege('service_role', 'public.student_learning_cards', 'UPDATE')
    and not has_table_privilege('service_role', 'public.student_learning_cards', 'DELETE'),
    'a chave de serviço lê ou escreve a tabela do cartão direto');
  perform pg_temp.card_assert(
    has_function_privilege('service_role', 'public.student_learning_card_for_planner(text,uuid)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.student_learning_card_for_planner(text,uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.student_learning_card_for_planner(text,uuid)', 'EXECUTE'),
    'leitura do Planner com permissão errada');
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
    and not has_function_privilege('authenticated', 'private.student_learning_card_can_edit(text,uuid)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'private.student_learning_card_minor_reason(uuid)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'private.student_learning_card_purge_minor_fields(uuid)', 'EXECUTE')
    and not has_function_privilege('service_role', 'private.student_learning_card_purge_minor_fields(uuid)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'private.student_learning_card_minor_purge_on_profile()', 'EXECUTE'),
    'função interna do cartão exposta');
  perform pg_temp.card_assert(
    exists (select 1 from pg_trigger
             where tgrelid = 'public.profiles'::regclass
               and tgname = 'trg_student_learning_card_minor_purge'
               and not tgisinternal),
    'profiles sem o gatilho que apaga os campos pessoais de quem vira menor');
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
  v_adult2 uuid := gen_random_uuid();
  v_kid uuid := gen_random_uuid();
  v_teen uuid := gen_random_uuid();
  v_eighteen uuid := gen_random_uuid();
  v_parent uuid := gen_random_uuid();
  v_guarded uuid := gen_random_uuid();
  v_guarded_name uuid := gen_random_uuid();
  v_unknown uuid := gen_random_uuid();
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_adult_birth date := ((now() at time zone 'America/Sao_Paulo')::date - interval '30 years')::date;
  v_r text;
  v_h jsonb;
  v_p jsonb;
  v_card public.student_learning_cards%rowtype;
  v_blocked boolean;
  v_unknown_minor boolean;
  v_nine text[] := array['a1','a2','a3','a4','a5','a6','a7','a8','a9'];
  v_seven text[] := array['b1','b2','b3','b4','b5','b6','b7'];
  v_all uuid[];
begin
  v_all := array[v_admin, v_coord, v_teacher, v_teacher_booking, v_teacher_other, v_super,
                 v_outsider, v_adult, v_adult2, v_kid, v_teen, v_eighteen, v_parent,
                 v_guarded, v_guarded_name, v_unknown];
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  insert into public.tenants (id, name) values
    (v_tid, 'Cartão fixture'), ('cartao-outra', 'Cartão outra escola');
  insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  select id, 'card-' || replace(id::text, '-', '') || '@example.invalid',
         '{"provider":"email"}', '{"test_fixture":true}'
    from unnest(v_all) as fixture(id);
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
           when id = v_parent then 'Responsavel Cartao'
           else 'Fixture Cartao' end,
         is_kids = (id = v_kid),
         birth_date = case
           when id in (v_adult, v_adult2, v_guarded_name) then v_adult_birth
           when id = v_teen then v_today - interval '15 years'
           -- Faz 18 anos amanhã: ainda é menor hoje.
           when id = v_eighteen then v_today - interval '18 years' + interval '1 day'
           else null end,
         -- Responsável cadastrado: pelo perfil (guardian_id) ou só pelo nome.
         guardian_id = case when id = v_guarded then v_parent end,
         guardian_name = case when id = v_guarded_name then 'Mãe do aluno' end,
         professor_id = case
           when id in (v_adult, v_adult2, v_kid, v_teen, v_eighteen, v_guarded, v_guarded_name, v_unknown)
             then v_teacher end
   where id = any (v_all);
  -- A tabela de vínculo não aceita SUPER_ADMIN: o suporte entra na escola como
  -- membro, e o papel efetivo continua SUPER_ADMIN (private.active_tenant_role).
  insert into public.tenant_memberships (tenant_id, user_id, role, status)
    select tenant_id, id, case when role = 'SUPER_ADMIN' then 'SCHOOL_ADMIN' else role end, 'ACTIVE'
      from public.profiles
     where id = any (v_all)
  on conflict (tenant_id, user_id) do update set role = excluded.role, status = 'ACTIVE';
  -- Adulto comprovado nas duas réguas do termo.
  perform pg_temp.card_attest_birth(v_admin, v_adult, v_adult_birth);
  perform pg_temp.card_attest_birth(v_admin, v_adult2, v_adult_birth);
  perform pg_temp.card_attest_birth(v_admin, v_guarded_name, v_adult_birth);
  perform pg_temp.card_assert(
    not private.lesson_recording_requires_guardian(v_adult)
    and not private.lesson_recording_requires_guardian(v_adult2),
    'fixture: o adulto do teste exige responsável na régua do termo');
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
    and v_h -> 'learning_card' -> 'minor_reason' = 'null'::jsonb
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
    and v_h -> 'learning_card' ->> 'minor_reason' = 'KIDS'
    and v_h -> 'learning_card' -> 'engaging_topics' = '["dinossauros"]'::jsonb,
    'dossiê da criança sem o cartão');

  -- Menor pela data de nascimento (sem is_kids), inclusive na véspera dos 18.
  perform pg_temp.card_assert(
    pg_temp.card_save(v_teacher, v_teen, 'Intercâmbio', '{}', null, '{}', 'Nota', null)
      = 'cartao_campo_de_menor:notes', 'adolescente pela data de nascimento aceitou nota');
  perform pg_temp.card_assert(
    pg_temp.card_save(v_teacher, v_eighteen, 'Vestibular', '{}', null, '{}', 'Nota', null)
      = 'cartao_campo_de_menor:notes', 'véspera dos 18 anos tratada como adulto');

  -- Responsável cadastrado é menor para o cartão, mesmo sem data de nascimento
  -- (o caso real de 26/09/2026: guardian_id preenchido, birth_date nulo).
  perform pg_temp.card_assert(
    pg_temp.card_save(v_teacher, v_guarded, 'Ler histórias', '{}', null, '{}', 'Nota pessoal', null)
      = 'cartao_campo_de_menor:notes', 'aluno com responsável cadastrado aceitou nota pessoal');
  perform pg_temp.card_assert(
    pg_temp.card_save(v_teacher, v_guarded, 'Ler histórias', '{}', 'end', '{}', '', null)
      = 'cartao_campo_de_menor:correction_style', 'aluno com responsável aceitou estilo de correção');
  v_r := pg_temp.card_save(v_teacher, v_guarded, 'Ler histórias', array['animais'], null, '{}', '', 0);
  perform pg_temp.card_assert(v_r = 'ok:1', 'objetivo e temas de aluno com responsável recusados: ' || v_r);
  v_h := pg_temp.card_handover(v_teacher, v_guarded);
  perform pg_temp.card_assert(
    (v_h -> 'learning_card' ->> 'is_minor')::boolean
    and v_h -> 'learning_card' ->> 'minor_reason' in ('GUARDIAN', 'AGE_UNKNOWN'),
    'dossiê não trata o aluno com responsável como menor: ' || coalesce(v_h -> 'learning_card' ->> 'minor_reason', 'null'));
  -- Só o nome do responsável, com maioridade atestada: ainda assim, menor.
  perform pg_temp.card_assert(
    pg_temp.card_save(v_teacher, v_guarded_name, 'Trabalho', '{}', null, array['política'], '', null)
      = 'cartao_campo_de_menor:avoid_topics', 'aluno com nome de responsável aceitou "o que evitar"');
  v_h := pg_temp.card_handover(v_teacher, v_guarded_name);
  perform pg_temp.card_assert(v_h -> 'learning_card' ->> 'minor_reason' = 'GUARDIAN',
    'motivo do responsável não chegou à tela: ' || coalesce(v_h -> 'learning_card' ->> 'minor_reason', 'null'));

  -- Idade não cadastrada segue a régua do TERMO (não uma cópia dela).
  v_unknown_minor := private.lesson_recording_requires_guardian(v_unknown);
  perform pg_temp.card_assert(
    private.student_learning_card_minor(v_unknown) = v_unknown_minor,
    'cartão e termo discordam sobre o aluno sem data de nascimento');
  v_r := pg_temp.card_save(v_teacher, v_unknown, 'Viagem', '{}', null, '{}', 'Nota', 0);
  perform pg_temp.card_assert(
    case when v_unknown_minor then v_r = 'cartao_campo_de_menor:notes' else v_r = 'ok:1' end,
    'aluno sem data de nascimento fora da régua do termo: ' || v_r);

  -- Cartão vazio que nunca existiu não vira linha nem histórico.
  v_r := pg_temp.card_save(v_teacher, v_teen, '   ', array['', '  '], '', '{}', '  ', 0);
  perform pg_temp.card_assert(v_r = 'ok:0'
    and not exists (select 1 from public.student_learning_cards where student_id = v_teen)
    and not exists (select 1 from private.student_learning_card_events where student_id = v_teen),
    'cartão vazio virou registro: ' || v_r);

  -- A direção corrige a data de nascimento de um adulto atestado para outra data
  -- de adulto (erro de digitação na ficha): os campos pessoais continuam. Antes
  -- (integração da onda 1), set_student_birth_date mudava o cadastro ANTES de
  -- gravar o atestado novo; o gatilho do cartão rodava no meio, lia o atestado
  -- antigo contra a data nova ("idade não comprovada" = menor) e apagava estilo,
  -- "o que evitar" e observações. Só vale com a régua fail-closed do termo.
  if to_regprocedure('public.set_student_birth_date(uuid,date,text)') is not null then
    select * into v_card from public.student_learning_cards where tenant_id = v_tid and student_id = v_adult;
    perform pg_temp.card_assert(
      v_card.correction_style is not null and v_card.notes <> '' and v_card.avoid_topics <> '{}'::text[],
      'fixture: o cartão do adulto não tinha campos pessoais antes da correção da data');
    perform pg_temp.card_attest_birth(v_admin, v_adult, v_adult_birth - 1);
    perform pg_temp.card_assert(
      not private.lesson_recording_requires_guardian(v_adult)
      and (select birth_date = v_adult_birth - 1 from public.profiles where id = v_adult),
      'fixture: a data corrigida não ficou atestada como adulta');
    perform pg_temp.card_assert(
      (select version = v_card.version
              and correction_style is not distinct from v_card.correction_style
              and avoid_topics = v_card.avoid_topics
              and notes = v_card.notes
         from public.student_learning_cards where tenant_id = v_tid and student_id = v_adult)
      and not exists (select 1 from private.student_learning_card_events
                       where student_id = v_adult and actor_role = 'SYSTEM_MINOR_RULE'),
      'corrigir a data de nascimento de um adulto apagou os campos pessoais do cartão');
  end if;

  -- Adulto que passa a constar como menor: os campos pessoais são APAGADOS na
  -- hora, sem esperar ninguém abrir e salvar o cartão.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  update public.profiles set birth_date = v_today - interval '10 years' where id = v_adult;
  select * into v_card from public.student_learning_cards where tenant_id = v_tid and student_id = v_adult;
  perform pg_temp.card_assert(
    v_card.notes = '' and v_card.avoid_topics = '{}'::text[] and v_card.correction_style is null
    and v_card.real_goal = repeat('a', 300) and v_card.engaging_topics = array[repeat('t', 60)]
    and v_card.version = 5 and v_card.updated_by is null,
    'nota pessoal de quem virou menor ficou guardada na tabela');
  perform pg_temp.card_assert(
    (select actor_role = 'SYSTEM_MINOR_RULE' and card_version = 5
            and changed_fields = array['correction_style','avoid_topics','notes']
       from private.student_learning_card_events where student_id = v_adult
      order by id desc limit 1),
    'limpeza de menor sem registro no histórico');
  v_h := pg_temp.card_handover(v_teacher, v_adult);
  perform pg_temp.card_assert(
    (v_h -> 'learning_card' ->> 'is_minor')::boolean
    and not (v_h -> 'learning_card' ->> 'hidden_for_minor')::boolean
    and v_h -> 'learning_card' ->> 'notes' = ''
    and v_h -> 'learning_card' -> 'avoid_topics' = '[]'::jsonb
    and v_h -> 'learning_card' -> 'correction_style' = 'null'::jsonb,
    'nota pessoal de quem virou menor apareceu no dossiê');
  v_r := pg_temp.card_save(v_teacher, v_adult, 'Apresentar resultados', array['futebol'], null, '{}', '', 5);
  perform pg_temp.card_assert(v_r = 'ok:6', 'salvamento de quem virou menor falhou: ' || v_r);

  -- O mesmo pelo responsável: cadastrar o responsável limpa o cartão.
  v_r := pg_temp.card_save(v_teacher, v_adult2, 'Carreira', array['tecnologia'], 'end', array['spoilers'], 'Gosta de debate.', 0);
  perform pg_temp.card_assert(v_r = 'ok:1', 'adulto não salvou o cartão: ' || v_r);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  update public.profiles set guardian_id = v_parent where id = v_adult2;
  perform pg_temp.card_assert(
    (select notes = '' and avoid_topics = '{}'::text[] and correction_style is null
            and real_goal = 'Carreira' and version = 2
       from public.student_learning_cards where student_id = v_adult2),
    'cadastrar o responsável não apagou os campos pessoais');
  -- Editar outra coisa na ficha (sem mudar idade/responsável) não gera versão.
  update public.profiles set full_name = 'Fixture Cartao Renomeado' where id = v_adult2;
  perform pg_temp.card_assert(
    (select version = 2 from public.student_learning_cards where student_id = v_adult2),
    'editar a ficha sem mudar idade mexeu no cartão');
  update public.profiles set guardian_id = null where id = v_adult2;

  -- Leitura do Planner: regra do banco, cartão de menor sem campo pessoal.
  v_r := pg_temp.card_save(v_teacher, v_adult2, 'Carreira', array['tecnologia'], 'end', array['spoilers'], 'Gosta de debate.', 2);
  perform pg_temp.card_assert(v_r = 'ok:3', 'adulto de volta não salvou: ' || v_r);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_p := public.student_learning_card_for_planner(v_tid, v_adult2);
  perform pg_temp.card_assert(
    v_p ->> 'is_minor' = 'false'
    and v_p -> 'card' ->> 'real_goal' = 'Carreira'
    and v_p -> 'card' ->> 'notes' = 'Gosta de debate.'
    and v_p -> 'card' ->> 'correction_style' = 'end'
    and v_p -> 'card' -> 'avoid_topics' = '["spoilers"]'::jsonb,
    'Planner não recebeu o cartão do adulto: ' || coalesce(v_p::text, 'null'));
  v_p := public.student_learning_card_for_planner(v_tid, v_kid);
  perform pg_temp.card_assert(
    v_p ->> 'is_minor' = 'true' and v_p ->> 'minor_reason' = 'KIDS'
    and v_p -> 'card' ->> 'real_goal' = 'Ler histórias curtas'
    and v_p -> 'card' ->> 'notes' = ''
    and v_p -> 'card' -> 'correction_style' = 'null'::jsonb
    and v_p -> 'card' -> 'avoid_topics' = '[]'::jsonb,
    'Planner recebeu campo pessoal de criança: ' || coalesce(v_p::text, 'null'));
  perform pg_temp.card_assert(
    public.student_learning_card_for_planner('cartao-outra', v_adult2) is null
    and public.student_learning_card_for_planner(v_tid, v_teacher) is null,
    'Planner leu cartão fora da escola do aluno');
  v_p := public.student_learning_card_for_planner(v_tid, v_teen);
  perform pg_temp.card_assert(v_p ->> 'is_minor' = 'true' and v_p -> 'card' = 'null'::jsonb,
    'aluno sem cartão virou cartão para o Planner');

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
  -- ...inclusive no UPDATE: a chave do cartão não muda.
  v_blocked := false;
  begin
    update public.student_learning_cards set tenant_id = 'cartao-outra' where student_id = v_adult2;
  exception when others then v_blocked := sqlerrm = 'cartao_chave_imutavel';
  end;
  perform pg_temp.card_assert(v_blocked, 'UPDATE levou o cartão para outra escola');
  v_blocked := false;
  begin
    update public.student_learning_cards set student_id = v_kid where student_id = v_adult2;
  exception when others then v_blocked := sqlerrm = 'cartao_chave_imutavel';
  end;
  perform pg_temp.card_assert(v_blocked, 'UPDATE trocou o aluno do cartão');
  perform pg_temp.card_assert(
    (select tenant_id = v_tid and version = 3 from public.student_learning_cards where student_id = v_adult2),
    'recusa da troca de chave mexeu no cartão');

  -- A régua do termo muda sem tocar em profiles (ex.: idade não comprovada
  -- passa a exigir responsável): a leitura esconde na hora e a varredura
  -- diária apaga. Por último — redefine a régua até o rollback.
  create or replace function private.lesson_recording_requires_guardian(p_student uuid)
  returns boolean language sql stable security definer set search_path = '' as $fn$
    select true;
  $fn$;
  perform pg_temp.card_assert(private.student_learning_card_minor(v_adult2),
    'o cartão não segue a régua do termo');
  v_h := pg_temp.card_handover(v_teacher, v_adult2);
  perform pg_temp.card_assert(
    (v_h -> 'learning_card' ->> 'hidden_for_minor')::boolean
    and v_h -> 'learning_card' ->> 'minor_reason' = 'AGE_UNKNOWN'
    and v_h -> 'learning_card' ->> 'notes' = '',
    'régua nova do termo não escondeu os campos pessoais: ' || coalesce(v_h::text, 'null'));
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform pg_temp.card_assert(
    private.student_learning_card_purge_minor_fields(null) >= 1,
    'varredura não apagou nada');
  perform pg_temp.card_assert(
    (select notes = '' and avoid_topics = '{}'::text[] and correction_style is null and version = 4
       from public.student_learning_cards where student_id = v_adult2),
    'varredura deixou campo pessoal na tabela');
  perform pg_temp.card_assert(
    private.student_learning_card_purge_minor_fields(null) = 0,
    'varredura repetida mexeu de novo');
end
$test$;

rollback;
