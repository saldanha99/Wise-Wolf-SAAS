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
  v_creator uuid := gen_random_uuid();
  v_student_a2 uuid := gen_random_uuid();
  v_student_b1 uuid := gen_random_uuid();
  v_student_def uuid := gen_random_uuid();
  v_offer_a2 uuid := gen_random_uuid();
  v_offer_b1 uuid := gen_random_uuid();
  v_offer_def uuid := gen_random_uuid();
  v_claim_res jsonb;
  v_mod text;
  v_part text;
begin
  -- Configuração de contexto de teste
  perform set_config('role', 'postgres', true);

  -- Obter tenant válido existente
  select id into v_tenant_id from public.tenants limit 1;

  -- Fixture de auth users
  insert into auth.users (id, email)
  values 
    (v_creator, 'creator@example.com'),
    (v_student_a2, 'student_a2@example.com'),
    (v_student_b1, 'student_b1@example.com'),
    (v_student_def, 'student_def@example.com');

  -- Oferta 1: Nível A2 explícito
  insert into public.offers (
    id, tenant_id, kind, expires_at, payload, requires_enrollment, enrollment_fee, created_by
  ) values (
    v_offer_a2, v_tenant_id, 'ENROLLMENT', now() + interval '1 day',
    jsonb_build_object(
      'module', 'A2',
      'value', 350,
      'dueDay', 10,
      'classesPerWeek', '2',
      'professorId', null
    ),
    false, 0, v_creator
  );

  -- Oferta 2: Nível B1 explícito
  insert into public.offers (
    id, tenant_id, kind, expires_at, payload, requires_enrollment, enrollment_fee, created_by
  ) values (
    v_offer_b1, v_tenant_id, 'ENROLLMENT', now() + interval '1 day',
    jsonb_build_object(
      'module', 'B1',
      'value', 350,
      'dueDay', 10,
      'classesPerWeek', '2',
      'professorId', null
    ),
    false, 0, v_creator
  );

  -- Oferta 3: Sem nível informado (fallback seguro)
  insert into public.offers (
    id, tenant_id, kind, expires_at, payload, requires_enrollment, enrollment_fee, created_by
  ) values (
    v_offer_def, v_tenant_id, 'ENROLLMENT', now() + interval '1 day',
    jsonb_build_object(
      'value', 350,
      'dueDay', 10,
      'classesPerWeek', '2',
      'professorId', null
    ),
    false, 0, v_creator
  );

  -- 1. Claim A2
  perform set_config('request.jwt.claims', json_build_object('sub', v_student_a2::text)::text, true);
  v_claim_res := public.claim_enrollment_offer(
    v_offer_a2,
    jsonb_build_object(
      'full_name', 'Aluno Teste A2',
      'phone', '11988887777',
      'cpf', '12345678901'
    )
  );
  perform pg_temp.assert_true((v_claim_res ->> 'success')::boolean, 'claim A2 deve ter sucesso: ' || coalesce(v_claim_res ->> 'error', ''));

  select module, current_book_part
    into v_mod, v_part
    from public.profiles
   where id = v_student_a2;

  perform pg_temp.assert_equals(v_mod, 'A2', 'modulo deve ser A2');
  perform pg_temp.assert_equals(v_part, 'A2-1', 'book part deve ser A2-1');

  -- 2. Claim B1
  perform set_config('request.jwt.claims', json_build_object('sub', v_student_b1::text)::text, true);
  v_claim_res := public.claim_enrollment_offer(
    v_offer_b1,
    jsonb_build_object(
      'full_name', 'Aluno Teste B1',
      'phone', '11988887778',
      'cpf', '12345678902'
    )
  );
  perform pg_temp.assert_true((v_claim_res ->> 'success')::boolean, 'claim B1 deve ter sucesso: ' || coalesce(v_claim_res ->> 'error', ''));

  select module, current_book_part
    into v_mod, v_part
    from public.profiles
   where id = v_student_b1;

  perform pg_temp.assert_equals(v_mod, 'B1', 'modulo deve ser B1');
  perform pg_temp.assert_equals(v_part, 'B1-1', 'book part deve ser B1-1');

  -- 3. Claim Default (sem nível especificado -> A1 / A1-1)
  perform set_config('request.jwt.claims', json_build_object('sub', v_student_def::text)::text, true);
  v_claim_res := public.claim_enrollment_offer(
    v_offer_def,
    jsonb_build_object(
      'full_name', 'Aluno Teste Default',
      'phone', '11988887779',
      'cpf', '12345678903'
    )
  );
  perform pg_temp.assert_true((v_claim_res ->> 'success')::boolean, 'claim Default deve ter sucesso: ' || coalesce(v_claim_res ->> 'error', ''));

  select module, current_book_part
    into v_mod, v_part
    from public.profiles
   where id = v_student_def;

  perform pg_temp.assert_equals(v_mod, 'A1', 'modulo padrao deve ser A1');
  perform pg_temp.assert_equals(v_part, 'A1-1', 'book part padrao deve ser A1-1');
end;
$$;

rollback;
