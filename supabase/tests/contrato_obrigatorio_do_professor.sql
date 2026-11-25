-- Contrato geral obrigatório do professor novo: só conta nova, sem contrato e sem dispensa.
begin;
do $$
declare v_tenant text; v_new uuid := gen_random_uuid(); v_old uuid; v_admin uuid; r jsonb;
begin
  if has_function_privilege('anon', 'public.my_teacher_contract_gate()', 'EXECUTE') then
    raise exception 'anon não pode consultar o contrato obrigatório';
  end if;
  if has_function_privilege('anon', 'public.save_my_teacher_contract_identity(text,text,date,text)', 'EXECUTE') then
    raise exception 'anon não pode gravar dados do contrato';
  end if;

  select p.tenant_id, p.id into v_tenant, v_admin from public.profiles p where p.role = 'SCHOOL_ADMIN' limit 1;
  if v_tenant is null then return; end if; -- cópia de estrutura sem dados

  insert into auth.users (id, email, aud, role, instance_id)
  values (v_new, 'contrato-gate-' || v_new || '@example.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');
  insert into public.profiles (id, full_name, email, role, tenant_id, contract_accepted, is_test_account)
  values (v_new, 'Professor Fixture Contrato', 'contrato-gate-' || v_new || '@example.test', 'TEACHER', v_tenant, false, true)
  on conflict (id) do update set role = 'TEACHER', tenant_id = v_tenant, contract_accepted = false;

  perform set_config('request.jwt.claims', json_build_object('sub', v_new, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_new::text, true);
  r := public.my_teacher_contract_gate();
  if (r->>'required')::boolean is distinct from true then raise exception 'professor novo sem contrato deveria ser barrado: %', r; end if;
  if not (r->'missing' ? 'cpf') then raise exception 'deveria pedir o CPF: %', r; end if;

  r := public.save_my_teacher_contract_identity('111.111.111-11', '12345', date '2004-05-10', 'Rua A, 10, Centro');
  if r->>'error' is distinct from 'cpf_invalido' then raise exception 'CPF inválido deveria ser recusado: %', r; end if;
  r := public.save_my_teacher_contract_identity('529.982.247-25', '12345', current_date, 'Rua A, 10, Centro');
  if r->>'error' is distinct from 'nascimento_invalido' then raise exception 'nascimento de hoje deveria ser recusado: %', r; end if;
  r := public.save_my_teacher_contract_identity('529.982.247-25', '12345', date '2004-05-10', 'Rua A, 10, Centro, Recife');
  if (r->>'ok')::boolean is distinct from true then raise exception 'dados válidos deveriam ser gravados: %', r; end if;
  r := public.my_teacher_contract_gate();
  if (r->>'required')::boolean is distinct from true or jsonb_array_length(r->'missing') <> 0 then
    raise exception 'com os dados completos falta só assinar: %', r;
  end if;

  perform set_config('request.jwt.claims', '', true); perform set_config('request.jwt.claim.sub', '', true);
  -- Dispensa da direção libera.
  perform private.set_teacher_general_contract_waiver(v_tenant, v_new, v_admin, true, 'Teste do contrato obrigatório');
  perform set_config('request.jwt.claims', json_build_object('sub', v_new, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_new::text, true);
  if (public.my_teacher_contract_gate()->>'required')::boolean then raise exception 'professor dispensado não é barrado'; end if;

  -- Conta antiga sem contrato não é barrada (segue pela faixa do Início).
  select p.id into v_old from public.profiles p where p.role = 'TEACHER' and coalesce(p.contract_accepted, false) = false
    and p.created_at < private.teacher_contract_gate_since() limit 1;
  if v_old is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', v_old, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_old::text, true);
    if (public.my_teacher_contract_gate()->>'required')::boolean then raise exception 'conta antiga não deveria ser barrada'; end if;
  end if;

  -- Aluno nunca vê o pop-up nem grava por aqui.
  select p.id into v_old from public.profiles p where p.role = 'STUDENT' limit 1;
  if v_old is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', v_old, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_old::text, true);
    if (public.my_teacher_contract_gate()->>'required')::boolean then raise exception 'aluno não tem contrato de professor'; end if;
    if public.save_my_teacher_contract_identity('529.982.247-25', '1', date '2000-01-01', 'Rua A, 10')->>'error' <> 'apenas_professor' then
      raise exception 'aluno não grava dados de professor';
    end if;
  end if;
  perform set_config('request.jwt.claims', '', true); perform set_config('request.jwt.claim.sub', '', true);
end $$;
rollback;
