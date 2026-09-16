-- Troca de plano do aluno (frequência + valor) pedida no grupo da Gestão.
--
-- O caso (16/09/2026): o Gabriel vai do Flávio para o Matheus, que só tem
-- 3 horários na semana — o Gabriel fazia 4. A direção negociou 3x e valor
-- novo, e quer mandar isso por áudio no grupo em vez de abrir a plataforma.
--
-- A regra continua a mesma da tela: a direção PROPÕE, a assinatura do aluno
-- APLICA (`sign_student_plan_change`), e a Asaas entra pela fila. Aqui só nasce
-- a proposta, em nome de quem pediu no grupo, com o mesmo aval que as outras
-- ações do grupo exigem (`management_group_execution_authorized`).
--
-- `p_tipo` diz em que ação do grupo os campos vieram: numa troca de plano
-- avulsa ('mudanca_plano') ou carona numa transferência de professor
-- ('transferencia_professor', o caso do Gabriel). O `expected` é montado AQUI,
-- não pelo chamador — senão o aval não valeria nada.
-- Re-executável: roda a cada release.

alter table public.student_plan_changes
  add column if not exists request_id text;
create unique index if not exists uq_student_plan_changes_request
  on public.student_plan_changes (tenant_id, request_id)
  where request_id is not null;

create or replace function public.gestao_create_plan_change(
  p_tenant text,
  p_actor_id uuid,
  p_request_id text,
  p_tipo text,
  p_student_id uuid,
  p_to_frequency text,
  p_to_fee numeric,
  p_update_pending_payments boolean default true
) returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_actor_role text;
  v_student record;
  v_freq text;
  v_existing public.student_plan_changes%rowtype;
  v_row public.student_plan_changes%rowtype;
  v_phone text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  if p_tenant is null or p_actor_id is null or p_student_id is null then
    return jsonb_build_object('ok', false, 'error', 'parametros_invalidos');
  end if;
  if coalesce(length(btrim(p_request_id)), 0) not between 8 and 200 then
    return jsonb_build_object('ok', false, 'error', 'request_id_invalido');
  end if;
  if p_tipo not in ('mudanca_plano', 'transferencia_professor') then
    return jsonb_build_object('ok', false, 'error', 'tipo_invalido');
  end if;

  v_freq := lower(btrim(coalesce(p_to_frequency, '')));
  if v_freq !~ '^[1-9][0-9]?x$' then
    return jsonb_build_object('ok', false, 'error', 'frequencia_invalida');
  end if;
  if p_to_fee is null or p_to_fee <= 0 or p_to_fee > 100000 then
    return jsonb_build_object('ok', false, 'error', 'valor_invalido');
  end if;

  select membership.role
    into v_actor_role
    from public.tenant_memberships as membership
    join public.profiles as actor on actor.id = membership.user_id
   where membership.user_id = p_actor_id
     and membership.tenant_id = p_tenant
     and membership.status = 'ACTIVE'
     and membership.role in ('SCHOOL_ADMIN', 'COORDINATOR')
     and lower(coalesce(actor.lifecycle_status, 'active')) not in ('suspended', 'offboarded')
   limit 1;
  if v_actor_role is null and not private.management_group_execution_authorized(
       p_tenant, p_actor_id, p_request_id,
       jsonb_build_object(
         'tipo', p_tipo, 'student_id', p_student_id,
         'nova_frequencia', v_freq, 'novo_valor', p_to_fee
       )
     ) then
    raise exception using errcode = '42501', message = 'actor_not_allowed';
  end if;

  -- Idempotência por request_id: o grupo pode reprocessar a mesma confirmação.
  perform pg_advisory_xact_lock(hashtextextended('plan-change-request:' || p_tenant || ':' || left(btrim(p_request_id), 200), 0));
  select * into v_existing
    from public.student_plan_changes
   where tenant_id = p_tenant and request_id = left(btrim(p_request_id), 200)
   for update;
  if found then
    if v_existing.student_id is distinct from p_student_id then
      return jsonb_build_object('ok', false, 'error', 'request_id_em_conflito');
    end if;
    select full_name, coalesce(nullif(attendance_phone, ''), phone) as phone into v_student
      from public.profiles where id = p_student_id;
    return jsonb_build_object(
      'ok', true, 'idempotent', true, 'token', v_existing.token, 'status', v_existing.status,
      'student_name', v_student.full_name, 'student_phone', v_student.phone,
      'from_frequency', v_existing.from_frequency, 'to_frequency', v_existing.to_frequency,
      'from_fee', v_existing.from_monthly_fee, 'to_fee', v_existing.to_monthly_fee
    );
  end if;

  select p.id, p.full_name, p.tenant_id, p.class_frequency, p.monthly_fee, p.fidelity_plan,
         coalesce(nullif(p.attendance_phone, ''), p.phone) as phone
    into v_student
    from public.profiles as p
   where p.id = p_student_id
     and p.role = 'STUDENT'
     and p.tenant_id = p_tenant
     and lower(coalesce(p.lifecycle_status, 'active')) not in ('suspended', 'offboarded');
  if v_student.id is null then
    return jsonb_build_object('ok', false, 'error', 'aluno_invalido');
  end if;
  if v_freq = lower(coalesce(v_student.class_frequency, '')) and p_to_fee = v_student.monthly_fee then
    return jsonb_build_object('ok', false, 'error', 'plano_igual_ao_atual');
  end if;

  -- Uma proposta aberta por aluno (índice uq_plan_change_one_pending): a nova
  -- substitui a anterior, como na tela.
  update public.student_plan_changes
     set status = 'CANCELLED', cancelled_at = now()
   where student_id = p_student_id and status = 'PENDING';

  insert into public.student_plan_changes (
    tenant_id, student_id, created_by,
    from_frequency, to_frequency, from_monthly_fee, to_monthly_fee, fidelity_plan,
    update_pending_payments, request_id
  ) values (
    p_tenant, p_student_id, p_actor_id,
    v_student.class_frequency, v_freq, v_student.monthly_fee, p_to_fee, v_student.fidelity_plan,
    coalesce(p_update_pending_payments, true), left(btrim(p_request_id), 200)
  )
  returning * into v_row;

  insert into public.audit_logs (tenant_id, user_id, user_role, action, resource_type, resource_id, new_values)
  values (
    p_tenant, p_actor_id, v_actor_role,
    'plan_change_proposed_via_management_group', 'student_plan_change', v_row.id::text,
    jsonb_build_object(
      'student_id', p_student_id, 'from_frequency', v_student.class_frequency, 'to_frequency', v_freq,
      'from_fee', v_student.monthly_fee, 'to_fee', p_to_fee, 'via', p_tipo,
      'request_id', left(btrim(p_request_id), 200)
    )
  );

  return jsonb_build_object(
    'ok', true, 'token', v_row.token, 'status', v_row.status,
    'expires_at', v_row.expires_at,
    'student_name', v_student.full_name, 'student_phone', v_student.phone,
    'from_frequency', v_student.class_frequency, 'to_frequency', v_freq,
    'from_fee', v_student.monthly_fee, 'to_fee', p_to_fee
  );
end;
$function$;

revoke all on function public.gestao_create_plan_change(text, uuid, text, text, uuid, text, numeric, boolean) from public, anon, authenticated;
grant execute on function public.gestao_create_plan_change(text, uuid, text, text, uuid, text, numeric, boolean) to service_role;
