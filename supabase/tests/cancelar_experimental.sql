-- Cancelar experimental pela plataforma (migration 20261029190000).
-- Roda dentro da transação do release; nada sai da transação.
begin;

do $test$
declare
  v_admin uuid;
  v_teacher uuid;
  v_tenant text;
  v_opp uuid;
  v_appt uuid;
  v_res jsonb;
begin
  select p.id, p.tenant_id into v_admin, v_tenant
    from public.profiles p
   where p.role = 'SCHOOL_ADMIN' and private.active_tenant_id(p.id) = p.tenant_id
     and private.tenant_is_operational(p.tenant_id)
   order by p.created_at limit 1;
  select p.id into v_teacher from public.profiles p
   where p.role = 'TEACHER' and p.tenant_id = v_tenant order by p.created_at limit 1;
  if v_admin is null or v_teacher is null then
    raise notice 'cancelar_experimental: sem escola com diretor e professor; pulado';
    return;
  end if;

  insert into public.appointments(professor_id, teacher_id, student_name, student_phone, start_time, status, type, tenant_id)
  values (v_teacher, v_teacher, 'Teste Cancelamento', '5500000000001', now() + interval '7 days', 'scheduled', 'experimental', v_tenant)
  returning id into v_appt;
  insert into public.opportunities(student_name, student_phone, slots_proposed, status, tenant_id, kind, winner_teacher_id,
    trial_appointment_id, trial_status, user_id, origin, is_test_fixture)
  values ('Teste Cancelamento', '5500000000001', '[]'::jsonb, 'CLAIMED', v_tenant, 'TRIAL', v_teacher, v_appt, 'SCHEDULED', v_admin, 'AI_SDR', true)
  returning id into v_opp;

  perform set_config('request.jwt.claims', pg_catalog.jsonb_build_object('sub', v_teacher, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_res := public.cancel_trial_opportunity(v_opp, 'teste', false);
  reset role;
  if v_res ->> 'error' is distinct from 'sem_permissao' then
    raise exception 'professor não pode cancelar experimental: %', v_res;
  end if;

  perform set_config('request.jwt.claims', pg_catalog.jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_res := public.cancel_trial_opportunity(v_opp, '   ', false);
  if v_res ->> 'error' is distinct from 'motivo_obrigatorio' then
    reset role;
    raise exception 'motivo é obrigatório: %', v_res;
  end if;
  v_res := public.cancel_trial_opportunity(v_opp, 'duplicada', false);
  reset role;
  if (v_res ->> 'ok')::boolean is not true then
    raise exception 'direção cancela experimental: %', v_res;
  end if;
  if not exists (select 1 from public.opportunities where id = v_opp and status = 'CANCELED' and trial_status = 'CANCELLED') then
    raise exception 'oportunidade não ficou cancelada';
  end if;
  if not exists (select 1 from public.appointments where id = v_appt and status = 'cancelled') then
    raise exception 'aula não saiu da agenda do professor';
  end if;

  perform set_config('request.jwt.claims', pg_catalog.jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_res := public.cancel_trial_opportunity(v_opp, 'de novo', false);
  reset role;
  if (v_res ->> 'already')::boolean is not true then
    raise exception 'segundo cancelamento é idempotente: %', v_res;
  end if;

  if pg_catalog.has_function_privilege('anon', 'public.cancel_trial_opportunity(uuid,text,boolean)', 'EXECUTE') then
    raise exception 'anon não pode cancelar experimental';
  end if;
  perform set_config('request.jwt.claims', '', true);
end;
$test$;

rollback;
