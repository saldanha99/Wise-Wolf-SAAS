-- Aluno pago com termo pendente tem acesso; quem não pagou continua bloqueado
-- (migration 20261104120000). Roda dentro da transação do release; nada sai dela.
begin;

do $test$
declare
  v_tenant text;
  v_teacher uuid;
  v_student uuid;
  v_offer uuid := gen_random_uuid();
  v_term uuid;
  v_payment uuid;
  v_denied boolean := false;
begin
  select p.tenant_id, p.id into v_tenant, v_student from public.profiles p
   where p.role = 'STUDENT' and p.tenant_id is not null
     and nullif(p.asaas_customer_id, '') is not null and nullif(p.subscription_id, '') is not null
   order by p.created_at limit 1;
  select p.id into v_teacher from public.profiles p
   where p.role = 'TEACHER' and p.tenant_id = v_tenant order by p.created_at limit 1;
  if v_teacher is null or v_student is null then
    raise notice 'aluno_pago_nao_fica_bloqueado: sem professor e aluno; pulado';
    return;
  end if;

  insert into public.offers (id, kind, tenant_id, payload, expires_at, created_by,
    requires_enrollment, enrollment_fee, processing_by, processing_state, metadata, invite_security_version)
  values (v_offer, 'ENROLLMENT', v_tenant, jsonb_build_object('planDuration', 12, 'value', 100, 'classesPerWeek', 1),
    now() + interval '20 days', v_student, true, 0, v_student, 'BILLING_READY', '{}'::jsonb, 1);

  insert into private.teacher_student_terms (tenant_id, student_id, teacher_id, source_kind, source_id,
    source_key, source_hash, mode, starts_on, slots, unit_rate, school_snapshot, student_name, teacher_name)
  values (v_tenant, v_student, v_teacher, 'ENROLLMENT', v_offer,
    'ENROLLMENT:' || v_offer || ':' || v_teacher, 'teste', 'RECURRING', current_date + 7,
    '[{"day":0,"date":null,"time":"05:15"}]'::jsonb, 8, '{}'::jsonb, 'Aluno Teste', 'Professor Teste')
  returning id into v_term;

  -- BILLING_READY também nasce ao criar a cobrança: sem pagamento, nada libera.
  if private.enrollment_paid_awaiting_terms(v_offer, v_student) then
    raise exception 'cobrança ainda não paga não pode liberar o acesso';
  end if;

  insert into public.student_payments (tenant_id, student_id, asaas_payment_id, value, status, due_date, payment_type)
  values (v_tenant, v_student, 'pay_teste_' || v_offer, 100, 'PENDING', current_date + 7, 'SUBSCRIPTION')
  returning id into v_payment;
  if private.enrollment_paid_awaiting_terms(v_offer, v_student) then
    raise exception 'cobrança PENDING não pode liberar o acesso';
  end if;

  -- Cartão aprovado com vencimento futuro: o caso real.
  update public.student_payments set status = 'CONFIRMED' where id = v_payment;
  if not private.enrollment_paid_awaiting_terms(v_offer, v_student) then
    raise exception 'cartão aprovado com termo pendente deve liberar o acesso';
  end if;

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  if not public.student_paid_awaiting_teacher_terms(v_student, v_tenant) then
    raise exception 'a superfície da edge deve enxergar o aluno pago';
  end if;
  if public.student_paid_awaiting_teacher_terms(v_student, v_tenant || '-outra') then
    raise exception 'outra escola não libera';
  end if;
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  begin
    perform public.student_paid_awaiting_teacher_terms(v_student, v_tenant);
  exception when insufficient_privilege then
    v_denied := true;
  end;
  if not v_denied then
    raise exception 'só o papel de serviço consulta';
  end if;
  perform set_config('request.jwt.claims', '', true);

  -- Taxa de matrícula em aberto continua bloqueando.
  update public.offers set enrollment_fee = 10 where id = v_offer;
  update public.profiles set enrollment_fee_paid = false where id = v_student;
  if private.enrollment_paid_awaiting_terms(v_offer, v_student) then
    raise exception 'taxa em aberto não pode liberar o acesso';
  end if;
  update public.offers set enrollment_fee = 0 where id = v_offer;

  -- Estorno volta a bloquear.
  update public.student_payments set status = 'REFUNDED' where id = v_payment;
  if private.enrollment_paid_awaiting_terms(v_offer, v_student) then
    raise exception 'pagamento estornado não pode liberar o acesso';
  end if;

  -- Pagamento anterior à oferta (matrícula antiga) não conta.
  update public.student_payments
     set status = 'CONFIRMED', created_at = now() - interval '1 day' where id = v_payment;
  if private.enrollment_paid_awaiting_terms(v_offer, v_student) then
    raise exception 'pagamento de matrícula antiga não pode liberar a nova';
  end if;
  update public.student_payments set created_at = now() where id = v_payment;

  -- Matrícula reaberta por pagamento não liquidado volta a bloquear.
  update public.offers set processing_state = 'AWAITING_PAYMENT' where id = v_offer;
  if private.enrollment_paid_awaiting_terms(v_offer, v_student) then
    raise exception 'matrícula aguardando pagamento não pode liberar o acesso';
  end if;
  update public.offers set processing_state = 'BILLING_READY' where id = v_offer;

  -- Termo recusado não é espera de assinatura: a direção precisa decidir.
  update private.teacher_student_terms set status = 'DECLINED' where id = v_term;
  if private.enrollment_paid_awaiting_terms(v_offer, v_student) then
    raise exception 'termo recusado não pode liberar o acesso';
  end if;

  if pg_catalog.has_function_privilege('authenticated', 'public.student_paid_awaiting_teacher_terms(uuid,text)', 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', 'public.student_paid_awaiting_teacher_terms(uuid,text)', 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', 'private.enrollment_paid_awaiting_terms(uuid,uuid)', 'EXECUTE') then
    raise exception 'privilégios abertos demais';
  end if;
  if pg_catalog.pg_get_functiondef('private.student_term_link_reminders()'::regprocedure)
     not like '%enrollment_paid_awaiting_terms%' then
    raise exception 'lembrete antecipado para aluno pago sumiu';
  end if;
end;
$test$;

rollback;
