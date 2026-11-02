-- Turbo em reais e experimental conferida pelo Meet (migration 20261101020000).
-- Roda dentro da transação do release; nada sai da transação.
begin;

do $test$
declare
  v_admin uuid;
  v_teacher uuid;
  v_other uuid;
  v_tenant text;
  v_opp uuid;
  v_appt uuid;
  v_appt2 uuid;
  v_res jsonb;
  v_claim jsonb;
  v_denied boolean;
begin
  select p.id, p.tenant_id into v_admin, v_tenant
    from public.profiles p
   where p.role = 'SCHOOL_ADMIN' and private.active_tenant_id(p.id) = p.tenant_id
     and private.tenant_is_operational(p.tenant_id)
   order by p.created_at limit 1;
  select p.id into v_teacher from public.profiles p
   where p.role = 'TEACHER' and p.tenant_id = v_tenant order by p.created_at limit 1;
  select p.id into v_other from public.profiles p
   where p.role = 'TEACHER' and p.tenant_id = v_tenant and p.id <> v_teacher order by p.created_at limit 1;
  if v_admin is null or v_teacher is null or v_other is null then
    raise notice 'turbo_visivel_e_experimental_pelo_meet: sem escola com diretor e dois professores; pulado';
    return;
  end if;

  -- ── Turbo: o extra nunca é negativo e nunca passa do que a aula pagou ──
  if exists (
    select 1 from private.turbo_lessons(v_tenant, pg_catalog.to_char(current_date, 'YYYY-MM')) l
     where l.extra < 0 or l.extra > l.rate_efetivo
  ) then
    raise exception 'extra do turbo fora da aula';
  end if;

  -- Professor lê o próprio extra; não lê o de outro professor.
  perform set_config('request.jwt.claims', pg_catalog.jsonb_build_object('sub', v_teacher, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_res := public.teacher_turbo_earnings(v_teacher, null);
  v_denied := false;
  begin
    perform public.teacher_turbo_earnings(v_other, null);
  exception when insufficient_privilege then v_denied := true;
  end;
  reset role;
  if v_res ->> 'month' is null or (v_res ->> 'extra')::numeric < 0 then
    raise exception 'professor não leu o próprio turbo: %', v_res;
  end if;
  if not v_denied then
    raise exception 'professor leu o turbo de outro professor';
  end if;

  -- Direção lê a prévia da folha com o turbo de cada professor.
  perform set_config('request.jwt.claims', pg_catalog.jsonb_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_res := public.payroll_month_preview(pg_catalog.to_char(current_date, 'YYYY-MM'));
  reset role;
  if v_res ? 'total_turbo' is not true
     or exists (select 1 from pg_catalog.jsonb_array_elements(v_res -> 'teachers') t where not (t ? 'turbo')) then
    raise exception 'folha sem o turbo por professor: %', v_res;
  end if;
  perform set_config('request.jwt.claims', '', true);

  -- ── Experimental: sala, presença e liquidação ──
  if pg_catalog.has_function_privilege('authenticated', 'public.trial_meet_backend(text,jsonb)', 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', 'public.trial_meet_backend(text,jsonb)', 'EXECUTE') then
    raise exception 'porta da sala da experimental aberta para cliente';
  end if;

  insert into public.appointments(professor_id, teacher_id, student_name, student_phone, start_time, status, type, tenant_id)
  values (v_teacher, v_teacher, 'Teste Meet', '5500000000002', now() - interval '2 hours', 'scheduled', 'experimental', v_tenant)
  returning id into v_appt;
  insert into public.opportunities(student_name, student_phone, slots_proposed, status, tenant_id, kind, winner_teacher_id,
    trial_appointment_id, trial_status, user_id, origin, is_test_fixture)
  values ('Teste Meet', '5500000000002', '[]'::jsonb, 'CLAIMED', v_tenant, 'TRIAL', v_teacher, v_appt, 'SCHEDULED', v_admin, 'AI_SDR', true)
  returning id into v_opp;

  perform set_config('request.jwt.claims', pg_catalog.jsonb_build_object('role', 'service_role')::text, true);
  set local role service_role;

  v_claim := public.trial_meet_backend('room_claim', pg_catalog.jsonb_build_object(
    'appointment_id', v_appt, 'tenant_id', v_tenant, 'teacher_id', v_teacher,
    'cohost_email', 'teste-meet@example.invalid'));
  if (v_claim ->> 'claimed')::boolean is not true then
    raise exception 'reserva da sala falhou: %', v_claim;
  end if;
  -- Segunda reserva da mesma sala em andamento não cria outra.
  if (public.trial_meet_backend('room_claim', pg_catalog.jsonb_build_object(
        'appointment_id', v_appt, 'tenant_id', v_tenant, 'teacher_id', v_teacher,
        'cohost_email', 'teste-meet@example.invalid')) ->> 'claimed')::boolean then
    raise exception 'duas reservas para a mesma sala';
  end if;
  perform public.trial_meet_backend('room_save', pg_catalog.jsonb_build_object(
    'appointment_id', v_appt, 'claim_id', v_claim ->> 'claim_id', 'state', 'READY',
    'space_name', 'spaces/teste', 'meeting_uri', 'https://meet.google.com/abc-defg-hij'));
  if not exists (select 1 from public.appointments where id = v_appt
                   and meeting_link = 'https://meet.google.com/abc-defg-hij') then
    raise exception 'link da sala não virou o link da experimental';
  end if;

  -- Professor e lead juntos: a aula é lançada e passa a pagar.
  v_res := public.trial_meet_backend('evaluate_save', pg_catalog.jsonb_build_object(
    'appointment_id', v_appt, 'outcome', 'ATTENDED',
    'evidence', pg_catalog.jsonb_build_object('teacher_seconds', 1800, 'lead_seconds', 1700)));
  if v_res ->> 'settle' is distinct from 'pago' then
    raise exception 'aula dada não foi liquidada: %', v_res;
  end if;
  if not exists (select 1 from public.class_logs where appointment_id = v_appt::text
                   and presence = 'COMPLETED' and subtype = 'AULA EXPERIMENTAL')
     or not exists (select 1 from public.appointments where id = v_appt and status = 'completed') then
    raise exception 'liquidação não lançou a aula';
  end if;

  -- Lead não veio, mas o professor lançou como dada: divergência, nada muda.
  reset role;
  insert into public.appointments(professor_id, teacher_id, student_name, student_phone, start_time, status, type, tenant_id)
  values (v_teacher, v_teacher, 'Teste Meet 2', '5500000000003', now() - interval '2 hours', 'scheduled', 'experimental', v_tenant)
  returning id into v_appt2;
  insert into public.class_logs (tenant_id, teacher_id, appointment_id, presence, subtype, date, class_date, created_at)
  select v_tenant, v_teacher, v_appt2::text, 'COMPLETED', 'AULA EXPERIMENTAL',
         (a.start_time at time zone 'America/Sao_Paulo')::date,
         (a.start_time at time zone 'America/Sao_Paulo')::date, now()
    from public.appointments a where a.id = v_appt2;
  insert into private.trial_meet_rooms (appointment_id, tenant_id, teacher_id, cohost_email, state, claim_id)
  values (v_appt2, v_tenant, v_teacher, 'teste-meet@example.invalid', 'READY', gen_random_uuid());
  set local role service_role;
  v_res := public.trial_meet_backend('evaluate_save', pg_catalog.jsonb_build_object(
    'appointment_id', v_appt2, 'outcome', 'NO_SHOW', 'evidence', '{}'::jsonb));
  if v_res ->> 'outcome' is distinct from 'CONFLICT' then
    raise exception 'divergência com o lançamento não virou conflito: %', v_res;
  end if;
  if not exists (select 1 from public.appointments where id = v_appt2 and status = 'scheduled') then
    raise exception 'conflito mexeu no appointment';
  end if;

  -- Professor que não entrou fica para a direção: nada é liquidado.
  reset role;
  delete from public.class_logs where appointment_id = v_appt2::text;
  update private.trial_meet_rooms set outcome = null, settled_at = null where appointment_id = v_appt2;
  set local role service_role;
  v_res := public.trial_meet_backend('evaluate_save', pg_catalog.jsonb_build_object(
    'appointment_id', v_appt2, 'outcome', 'TEACHER_ABSENT', 'evidence', '{}'::jsonb));
  if exists (select 1 from public.appointments where id = v_appt2 and status <> 'scheduled')
     or exists (select 1 from public.class_logs where appointment_id = v_appt2::text) then
    raise exception 'professor ausente liquidou a experimental';
  end if;

  -- Lead não veio, sem lançamento: marca não veio.
  reset role;
  update private.trial_meet_rooms set outcome = null, settled_at = null where appointment_id = v_appt2;
  set local role service_role;
  v_res := public.trial_meet_backend('evaluate_save', pg_catalog.jsonb_build_object(
    'appointment_id', v_appt2, 'outcome', 'NO_SHOW', 'evidence', '{}'::jsonb));
  if v_res ->> 'settle' is distinct from 'nao_veio'
     or not exists (select 1 from public.appointments where id = v_appt2 and status = 'no_show') then
    raise exception 'não veio não foi registrado: %', v_res;
  end if;

  reset role;
  perform set_config('request.jwt.claims', '', true);
end;
$test$;

rollback;
