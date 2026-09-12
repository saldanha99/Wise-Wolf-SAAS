\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(value, false) then
    raise exception 'assertion failed: %', message;
  end if;
end;
$$;

create or replace function pg_temp.assert_equals(actual text, expected text, message text)
returns void
language plpgsql
as $$
begin
  if actual is distinct from expected then
    raise exception 'assertion failed: % (esperado: %, obtido: %)', message, expected, actual;
  end if;
end;
$$;

grant execute on function pg_temp.assert_true(boolean, text) to public;
grant execute on function pg_temp.assert_equals(text, text, text) to public;

do $$
declare
  v_tenant_id text := 'student-status-fixture-' || gen_random_uuid()::text;
  v_director uuid := gen_random_uuid();
  v_teacher uuid := gen_random_uuid();
  v_unlinked_teacher uuid := gen_random_uuid();
  v_student uuid := gen_random_uuid();
  v_res jsonb;
  v_mod text;
  v_part text;
  v_status text;
  v_lifecycle text;
  v_sensitive_blocked boolean := false;
  v_unlinked_blocked boolean := false;
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- A schema-only QA database has no school rows. Never borrow a real tenant.
  insert into public.tenants(id, name, saas_status)
  values (v_tenant_id, 'Student status transaction fixture', 'active');

  -- The placement RPC selects the first published milestone; a schema-only
  -- database intentionally has no catalogue seeds. Existing publication data
  -- is not changed, and both fixture rows disappear with the rollback.
  insert into public.pedagogical_evaluation_catalog(book_part,module,part,title,active)
  values ('A2-1','A2',1,'A2 fixture milestone',true),
         ('B1-1','B1',1,'B1 fixture milestone',true)
  on conflict (book_part) do nothing;

  -- Fixture de auth users
  insert into auth.users (id, email, raw_user_meta_data)
  values 
    (v_director, v_director::text || '@example.invalid', '{"test_fixture":true}'),
    (v_teacher, v_teacher::text || '@example.invalid', '{"test_fixture":true}'),
    (v_unlinked_teacher, v_unlinked_teacher::text || '@example.invalid', '{"test_fixture":true}'),
    (v_student, v_student::text || '@example.invalid', '{"test_fixture":true}');

  update public.profiles set is_test_account = true
   where id in (v_director, v_teacher, v_unlinked_teacher, v_student);

  -- Atualiza perfis criados
  update public.profiles
     set full_name = 'Diretor Teste',
         role = 'SCHOOL_ADMIN',
         tenant_id = v_tenant_id
   where id = v_director;

  update public.profiles
     set full_name = 'Professor Responsavel',
         role = 'TEACHER',
         tenant_id = v_tenant_id
   where id = v_teacher;

  update public.profiles
     set full_name = 'Professor Estranho',
         role = 'TEACHER',
         tenant_id = v_tenant_id
   where id = v_unlinked_teacher;

  update public.profiles
     set full_name = 'Aluno Teste',
         role = 'STUDENT',
         tenant_id = v_tenant_id,
         professor_id = v_teacher,
         module = 'A1',
         current_book_part = 'A1-1',
         status = 'Ativo',
         lifecycle_status = 'active'
   where id = v_student;

  -- 1. Diretor altera nível para B1 e status para Inativo
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_director::text)::text, true);
  v_res := public.update_student_pedagogical_profile(
    v_student,
    jsonb_build_object(
      'module', 'B1',
      'status', 'Inativo'
    )
  );
  perform pg_temp.assert_true((v_res ->> 'success')::boolean, 'diretor update deve ter sucesso');

  select module, current_book_part, status, lifecycle_status
    into v_mod, v_part, v_status, v_lifecycle
    from public.profiles
   where id = v_student;

  perform pg_temp.assert_equals(v_mod, 'B1', 'modulo atualizado pelo diretor');
  perform pg_temp.assert_equals(v_part, 'B1-1', 'book part atualizado pelo diretor');
  perform pg_temp.assert_equals(v_status, 'Inativo', 'status atualizado pelo diretor');
  perform pg_temp.assert_equals(v_lifecycle, 'suspended', 'lifecycle atualizado pelo diretor');

  -- 2. Professor responsável altera nível para A2 e status de volta para Ativo
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_teacher::text)::text, true);
  v_res := public.update_student_pedagogical_profile(
    v_student,
    jsonb_build_object(
      'module', 'A2',
      'status', 'Ativo'
    )
  );
  perform pg_temp.assert_true((v_res ->> 'success')::boolean, 'professor update deve ter sucesso');

  select module, current_book_part, status, lifecycle_status
    into v_mod, v_part, v_status, v_lifecycle
    from public.profiles
   where id = v_student;

  perform pg_temp.assert_equals(v_mod, 'A2', 'modulo atualizado pelo professor');
  perform pg_temp.assert_equals(v_part, 'A2-1', 'book part atualizado pelo professor');
  perform pg_temp.assert_equals(v_status, 'Ativo', 'status atualizado pelo professor');
  perform pg_temp.assert_equals(v_lifecycle, 'active', 'lifecycle atualizado pelo professor');

  -- 3. Professor tentando alterar dado sensível (CPF ou Preço) DEVE SER BLOQUEADO
  begin
    v_res := public.update_student_pedagogical_profile(
      v_student,
      jsonb_build_object(
        'cpf', '11122233344'
      )
    );
  exception when others then
    v_sensitive_blocked := true;
  end;
  perform pg_temp.assert_true(v_sensitive_blocked, 'professor nao pode alterar CPF');

  -- 4. Professor NÃO VINCULADO tentando alterar aluno DEVE SER BLOQUEADO
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', v_unlinked_teacher::text)::text, true);
  begin
    v_res := public.update_student_pedagogical_profile(
      v_student,
      jsonb_build_object(
        'module', 'B2'
      )
    );
  exception when others then
    v_unlinked_blocked := true;
  end;
  perform pg_temp.assert_true(v_unlinked_blocked, 'professor nao vinculado deve ser bloqueado');

end;
$$;

rollback;
