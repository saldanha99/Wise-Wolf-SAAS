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
  v_tenant_id text;
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

  select id into v_tenant_id from public.tenants limit 1;

  -- Fixture de auth users
  insert into auth.users (id, email)
  values 
    (v_director, 'director_test@example.com'),
    (v_teacher, 'teacher_test@example.com'),
    (v_unlinked_teacher, 'unlinked_teacher@example.com'),
    (v_student, 'student_test@example.com');

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
  perform set_config('request.jwt.claims', json_build_object('sub', v_director::text)::text, true);
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
  perform set_config('request.jwt.claims', json_build_object('sub', v_teacher::text)::text, true);
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
  perform set_config('request.jwt.claims', json_build_object('sub', v_unlinked_teacher::text)::text, true);
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
