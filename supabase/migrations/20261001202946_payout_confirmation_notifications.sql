-- A baixa financeira cria uma intenção transacional; o worker oficial envia.
-- Não faz transferência, não toca pagamentos passados e não envia ao fechar/NF.
create or replace function private.payout_confirmation_snapshot(p_source_type text,p_source_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $function$
declare c public.teacher_closings%rowtype; w public.vendor_withdrawal_requests%rowtype;
  recipient public.profiles%rowtype; tenant text; recipient_id uuid;
  amount numeric; paid timestamptz; reference text; heading text; detail text;
  phone text; message text;
begin
  if p_source_type='TEACHER_CLOSING' then
    select * into c from public.teacher_closings where id=p_source_id;
    if not found or c.paid_at is null or c.total_amount<=0
       or upper(c.status) not in ('PAGO','PAID','PAID_WAITING_NF','UNDER_REVIEW','COMPLETED','REJECTED','REJEITADO') then
      return jsonb_build_object('ok',false,'reason','payout_not_confirmed');
    end if;
    if exists(select 1 from public.asaas_teacher_transfer_attempts a
      where a.closing_id=c.id and (a.status<>'COMPLETED'
        or a.provider_transfer_id is distinct from c.asaas_transfer_id)) then
      return jsonb_build_object('ok',false,'reason','provider_transfer_not_completed');
    end if;
    tenant:=c.tenant_id;recipient_id:=c.teacher_id;amount:=c.total_amount;paid:=c.paid_at;
    heading:='✅ *Pagamento do professor confirmado*';
    reference:=right(c.month_year,2)||'/'||left(c.month_year,4);
    detail:=format(E'Competência: *%s*\nAulas no fechamento: %s\nConfira seu relatório e a situação da nota fiscal em Financeiro.',reference,c.total_lessons);
  elsif p_source_type='AFFILIATE_WITHDRAWAL' then
    select * into w from public.vendor_withdrawal_requests where id=p_source_id;
    if not found or w.status<>'PAID' or w.paid_at is null or w.amount_brl<=0 then
      return jsonb_build_object('ok',false,'reason','payout_not_confirmed');
    end if;
    tenant:=w.tenant_id;recipient_id:=w.vendor_id;amount:=w.amount_brl/100.0;paid:=w.paid_at;
    heading:='✅ *Pagamento do afiliado confirmado*';
    detail:=format(E'Saque: %s comissão(ões)\nConfira o pedido como pago no seu painel de afiliado.',w.commission_count);
  else return jsonb_build_object('ok',false,'reason','payout_source_invalid'); end if;
  select * into recipient from public.profiles where id=recipient_id and tenant_id=tenant
    and ((p_source_type='AFFILIATE_WITHDRAWAL' and role='SALESPERSON')
      or (p_source_type='TEACHER_CLOSING' and role in ('TEACHER','SCHOOL_ADMIN','SUPER_ADMIN')));
  if not found or coalesce(recipient.is_test_account,false)
    or exists(select 1 from auth.users u where u.id=recipient.id
      and (u.raw_user_meta_data @> '{"test_fixture":true}' or u.raw_user_meta_data @> '{"testMode":true}')) then
    return jsonb_build_object('ok',false,'reason','payout_recipient_or_fixture_invalid');
  end if;
  phone:=coalesce(nullif(btrim(recipient.phone),''),nullif(btrim(recipient.attendance_phone),''));
  if phone like '%@%' then phone:=null; end if;
  phone:=private.normalize_notification_phone(phone);
  if phone is null then return jsonb_build_object('ok',false,'reason','payout_phone_missing'); end if;
  message:=heading||E'\nOlá, *'||regexp_replace(coalesce(recipient.full_name,'parceiro'),'[\n\r*]',' ','g')||E'*!\nA direção registrou seu pagamento de *R$ '||replace(round(amount,2)::text,'.',',')||E'*.\nPago em: '||to_char(paid at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI')||E'\n\n'||detail;
  return jsonb_build_object('ok',true,'tenant_id',tenant,'recipient_id',recipient_id,
    'teacherId',case when p_source_type='TEACHER_CLOSING' then recipient_id else null end,
    'destination',phone,'message',message);
end;
$function$;
alter function private.payout_confirmation_snapshot(text,uuid) owner to postgres;
revoke all on function private.payout_confirmation_snapshot(text,uuid) from public,anon,authenticated,service_role;

create or replace function private.enqueue_payout_confirmation(p_source_type text,p_source_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $function$
declare s jsonb; q public.notification_queue%rowtype; kind text;
begin
  s:=private.payout_confirmation_snapshot(p_source_type,p_source_id);
  if coalesce((s->>'ok')::boolean,false) is false then return s; end if;
  kind:=case when p_source_type='TEACHER_CLOSING' then 'TEACHER_PAYOUT_CONFIRMED' else 'AFFILIATE_PAYOUT_CONFIRMED' end;
  insert into public.notification_queue(tenant_id,teacher_id,student_name,student_phone,message_body,
    scheduled_for,status,source_type,source_id,notification_kind,idempotency_key)
  values(s->>'tenant_id',nullif(s->>'teacherId','')::uuid,'Pagamento confirmado',s->>'destination',s->>'message',
    now(),'pending',p_source_type,p_source_id,kind,'payout-confirmed:'||p_source_type||':'||p_source_id)
  on conflict(tenant_id,idempotency_key) where idempotency_key is not null do nothing;
  select * into q from public.notification_queue where tenant_id=s->>'tenant_id'
    and idempotency_key='payout-confirmed:'||p_source_type||':'||p_source_id;
  return jsonb_build_object('ok',true,'notification_id',q.id,'status',q.status);
end;
$function$;
alter function private.enqueue_payout_confirmation(text,uuid) owner to postgres;
revoke all on function private.enqueue_payout_confirmation(text,uuid) from public,anon,authenticated,service_role;

create or replace function private.queue_payout_confirmation()
returns trigger language plpgsql security definer set search_path='' as $function$
begin
  if tg_table_name='teacher_closings' then
    if old.paid_at is null and new.paid_at is not null
      and upper(new.status) in ('PAGO','PAID','PAID_WAITING_NF') then
      perform private.enqueue_payout_confirmation('TEACHER_CLOSING',new.id);
    end if;
  elsif old.status is distinct from 'PAID' and new.status='PAID' and new.paid_at is not null then
    perform private.enqueue_payout_confirmation('AFFILIATE_WITHDRAWAL',new.id);
  end if;
  return new;
end;
$function$;
alter function private.queue_payout_confirmation() owner to postgres;
revoke all on function private.queue_payout_confirmation() from public,anon,authenticated,service_role;
drop trigger if exists queue_teacher_payout_confirmation on public.teacher_closings;
create trigger queue_teacher_payout_confirmation after update of status,paid_at on public.teacher_closings
 for each row execute function private.queue_payout_confirmation();
drop trigger if exists queue_affiliate_payout_confirmation on public.vendor_withdrawal_requests;
create trigger queue_affiliate_payout_confirmation after update of status,paid_at on public.vendor_withdrawal_requests
 for each row execute function private.queue_payout_confirmation();

create or replace function public.get_payout_confirmation_notice_snapshot(p_notification_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $function$
declare q public.notification_queue%rowtype; s jsonb;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then
    return jsonb_build_object('ok',false,'reason','forbidden');
  end if;
  select * into q from public.notification_queue where id=p_notification_id;
  if q.id is null or not ((q.notification_kind='TEACHER_PAYOUT_CONFIRMED' and q.source_type='TEACHER_CLOSING')
    or (q.notification_kind='AFFILIATE_PAYOUT_CONFIRMED' and q.source_type='AFFILIATE_WITHDRAWAL')) then
    return jsonb_build_object('ok',false,'reason','payout_notice_invalid');
  end if;
  s:=private.payout_confirmation_snapshot(q.source_type,q.source_id);
  if coalesce((s->>'ok')::boolean,false) is false then return s; end if;
  if s->>'tenant_id' is distinct from q.tenant_id
    or s->>'destination' is distinct from q.student_phone
    or s->>'message' is distinct from q.message_body
    or nullif(s->>'teacherId','')::uuid is distinct from q.teacher_id then
    return jsonb_build_object('ok',false,'reason','payout_snapshot_changed');
  end if;
  return s;
end;
$function$;
alter function public.get_payout_confirmation_notice_snapshot(uuid) owner to postgres;
revoke all on function public.get_payout_confirmation_notice_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.get_payout_confirmation_notice_snapshot(uuid) to service_role;

-- Confirma somente PIX já realizado fora da integração: não dispara Asaas.
create or replace function public.confirm_teacher_payout(p_closing_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $function$
declare actor public.profiles%rowtype; c public.teacher_closings%rowtype;
  teacher public.profiles%rowtype; notice jsonb;
begin
  select * into actor from public.profiles where id=auth.uid()
    and role in ('SCHOOL_ADMIN','SUPER_ADMIN');
  if not found then return jsonb_build_object('ok',false,'error','FORBIDDEN'); end if;
  select * into c from public.teacher_closings where id=p_closing_id
    and (actor.role='SUPER_ADMIN' or tenant_id=actor.tenant_id) for update;
  if not found then return jsonb_build_object('ok',false,'error','NOT_FOUND'); end if;
  if c.paid_at is not null then
    notice:=private.enqueue_payout_confirmation('TEACHER_CLOSING',c.id);
    return jsonb_build_object('ok',true,'already_paid',true,'notice',notice);
  end if;
  if exists(select 1 from public.asaas_teacher_transfer_attempts where closing_id=c.id)
    or c.asaas_transfer_id is not null then
    return jsonb_build_object('ok',false,'error','PROVIDER_RECONCILIATION_REQUIRED');
  end if;
  if upper(c.status) not in ('PENDENTE','WAITING_PAYMENT','CONFIRMADO') or c.total_amount<=0 then
    return jsonb_build_object('ok',false,'error','INVALID_STATE');
  end if;
  select * into teacher from public.profiles where id=c.teacher_id and tenant_id=c.tenant_id
    and role in ('TEACHER','SCHOOL_ADMIN','SUPER_ADMIN');
  if not found then return jsonb_build_object('ok',false,'error','TEACHER_NOT_FOUND'); end if;
  update public.teacher_closings set paid_at=now(),
    status=case when coalesce(teacher.nf_exempt,false) then 'PAGO' else 'PAID_WAITING_NF' end,
    payment_method='PIX_MANUAL',updated_at=now() where id=c.id;
  notice:=private.enqueue_payout_confirmation('TEACHER_CLOSING',c.id);
  return jsonb_build_object('ok',true,'notice',notice);
end;
$function$;
alter function public.confirm_teacher_payout(uuid) owner to postgres;
revoke all on function public.confirm_teacher_payout(uuid) from public,anon;
grant execute on function public.confirm_teacher_payout(uuid) to authenticated,service_role;

CREATE OR REPLACE FUNCTION public.begin_notification_delivery_submission(p_notification_id uuid, p_claim_token uuid, p_provider_instance_name text, p_expected_destination text, p_provider_destination text, p_expected_message_body text, p_integration_id uuid, p_integration_version bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_runtime_role text := coalesce((select auth.jwt() ->> 'role'), '');
  v_notification public.notification_queue%rowtype;
  v_kind text;
  v_snapshot jsonb;
  v_current_destination text;
  v_current_teacher_id uuid;
begin
  if v_runtime_role <> 'service_role' then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'action', 'REVIEW_REQUIRED', 'reason', 'forbidden'
    );
  end if;

  select notification.*
  into v_notification
  from public.notification_queue as notification
  where notification.id = p_notification_id;
  v_kind := pg_catalog.upper(pg_catalog.btrim(coalesce(
    v_notification.notification_kind,
    ''
  )));

  if v_kind in ('TEACHER_PAYOUT_CONFIRMED','AFFILIATE_PAYOUT_CONFIRMED') then
    begin
      if v_kind='TEACHER_PAYOUT_CONFIRMED' then
        perform id from public.teacher_closings where id=v_notification.source_id
          and tenant_id=v_notification.tenant_id for share nowait;
      else
        perform id from public.vendor_withdrawal_requests where id=v_notification.source_id
          and tenant_id=v_notification.tenant_id for share nowait;
      end if;
    exception when lock_not_available then
      return jsonb_build_object('ok',false,'action','RETRY','reason','payout_source_busy');
    end;
    v_snapshot:=public.get_payout_confirmation_notice_snapshot(p_notification_id);
    if coalesce((v_snapshot->>'ok')::boolean,false) is false
      or v_snapshot->>'destination' is distinct from p_expected_destination
      or v_snapshot->>'message' is distinct from p_expected_message_body then
      return jsonb_build_object('ok',false,'action','REVIEW_REQUIRED',
        'reason',coalesce(v_snapshot->>'reason','payout_snapshot_changed'));
    end if;
  end if;

  if v_kind = 'AFFILIATE_WITHDRAWAL_REQUESTED' then
    begin
      perform id from public.vendor_withdrawal_requests
        where id=v_notification.source_id and tenant_id=v_notification.tenant_id for share nowait;
    exception when lock_not_available then
      return jsonb_build_object('ok',false,'action','RETRY','reason','withdrawal_source_busy');
    end;
    v_snapshot:=public.get_affiliate_withdrawal_notice_snapshot(p_notification_id);
    if coalesce((v_snapshot->>'ok')::boolean,false) is false
       or v_snapshot->>'destination' is distinct from p_expected_destination
       or v_snapshot->>'message' is distinct from p_expected_message_body then
      return jsonb_build_object('ok',false,'action','REVIEW_REQUIRED',
        'reason',coalesce(v_snapshot->>'reason','withdrawal_snapshot_changed'));
    end if;
  end if;

  if v_kind not in (
    'TRIAL_TEACHER_REQUESTED',
    'TRIAL_MANAGEMENT_ACCEPTED'
  ) then
    return public.begin_notification_delivery_submission_pre_trial_lifecycle_impl(
      p_notification_id,
      p_claim_token,
      p_provider_instance_name,
      p_expected_destination,
      p_provider_destination,
      p_expected_message_body,
      p_integration_id,
      p_integration_version
    );
  end if;

  if v_notification.id is null
     or v_notification.source_id is null
     or pg_catalog.upper(pg_catalog.btrim(coalesce(
       v_notification.source_type,
       ''
     ))) <> 'TRIAL_OPPORTUNITY'
     or v_notification.tenant_id is null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'invalid_trial_notification_identity'
    );
  end if;

  begin
    perform opportunity.id
    from public.opportunities as opportunity
    where opportunity.id = v_notification.source_id
      and opportunity.tenant_id = v_notification.tenant_id
    for share nowait;
    if not found then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'action', 'REVIEW_REQUIRED',
        'reason', 'trial_notification_source_unavailable'
      );
    end if;

    perform link.id
    from public.enrollment_links as link
    where link.opportunity_id = v_notification.source_id
    order by link.id
    for share nowait;

    perform request.id
    from private.vendor_trial_teacher_requests as request
    where request.opportunity_id = v_notification.source_id
    order by request.id
    for share nowait;
  exception when lock_not_available then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'RETRY',
      'reason', 'trial_notification_revalidation_busy'
    );
  end;

  v_snapshot := public.get_trial_notification_delivery_snapshot(
    v_notification.tenant_id,
    v_notification.source_id,
    v_kind
  );
  if coalesce((v_snapshot ->> 'ok')::boolean, false) is not true then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', case
        when coalesce((v_snapshot ->> 'retryable')::boolean, false)
          then 'RETRY'
        else 'REVIEW_REQUIRED'
      end,
      'reason', coalesce(
        v_snapshot ->> 'reason',
        'trial_notification_revalidation_failed'
      )
    );
  end if;

  v_current_destination := private.normalize_notification_destination(
    v_snapshot ->> 'destination'
  );
  begin
    v_current_teacher_id := nullif(v_snapshot ->> 'teacherId', '')::uuid;
  exception when invalid_text_representation then
    v_current_teacher_id := null;
  end;
  if v_current_destination is null
     or v_current_destination is distinct from
       private.normalize_notification_destination(p_expected_destination)
     or (
       v_current_destination like '%@g.us'
       and private.normalize_notification_destination(p_provider_destination)
         is distinct from v_current_destination
     )
     or (
       v_current_destination not like '%@g.us'
       and not private.notification_phones_same_recipient(
         v_current_destination,
         private.normalize_notification_destination(p_provider_destination)
       )
     )
     or (
       v_kind = 'TRIAL_TEACHER_REQUESTED'
       and v_notification.teacher_id is distinct from v_current_teacher_id
     )
     or (
       v_kind = 'TRIAL_MANAGEMENT_ACCEPTED'
       and v_notification.teacher_id is not null
     ) then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'action', 'REVIEW_REQUIRED',
      'reason', 'trial_notification_authorized_snapshot_changed'
    );
  end if;

  return public.begin_notification_delivery_submission_pre_trial_lifecycle_impl(
    p_notification_id,
    p_claim_token,
    p_provider_instance_name,
    p_expected_destination,
    p_provider_destination,
    p_expected_message_body,
    p_integration_id,
    p_integration_version
  );
end;
$function$
;
CREATE OR REPLACE FUNCTION public.set_vendor_withdrawal_status(p_request_id uuid, p_status text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor_id uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_request public.vendor_withdrawal_requests%rowtype;
  v_status text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_status, '')));
begin
  select profile.* into v_actor
    from public.profiles as profile
   where profile.id = v_actor_id;
  if not found or coalesce(v_actor.role, '') not in ('SCHOOL_ADMIN', 'SUPER_ADMIN') then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  end if;

  select request.* into v_request
    from public.vendor_withdrawal_requests as request
   where request.id = p_request_id
   for update;
  if v_actor.id is null
     or not found
     or (v_actor.role <> 'SUPER_ADMIN' and v_actor.tenant_id <> v_request.tenant_id)
  then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  end if;

  if not (
    (v_request.status = 'PENDING' and v_status in ('APPROVED', 'REJECTED'))
    or (v_request.status = 'APPROVED' and v_status in ('PAID', 'CANCELLED'))
  ) then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'INVALID_TRANSITION');
  end if;

  update public.vendor_withdrawal_requests as request
     set status = v_status,
         reviewed_at = coalesce(request.reviewed_at, pg_catalog.now()),
         paid_at = case when v_status = 'PAID' then pg_catalog.now() else request.paid_at end,
         reviewed_by = v_actor_id,
         review_note = nullif(pg_catalog.btrim(coalesce(p_note, '')), ''),
         updated_at = pg_catalog.now()
   where request.id = p_request_id;

  if v_status = 'PAID' then
    update public.vendor_commissions as commission
       set status = 'PAID',
           paid_at = coalesce(commission.paid_at, pg_catalog.now())
     where commission.withdrawal_request_id = p_request_id
       and commission.status = 'CONFIRMED';
  elsif v_status in ('REJECTED', 'CANCELLED') then
    update public.vendor_commissions as commission
       set withdrawal_request_id = null
     where commission.withdrawal_request_id = p_request_id
       and commission.status = 'CONFIRMED';
  end if;

  return pg_catalog.jsonb_build_object('ok', true, 'status', v_status,
    'notice',case when v_status='PAID' then private.enqueue_payout_confirmation('AFFILIATE_WITHDRAWAL',p_request_id) else null end);
end;
$function$
;
notify pgrst,'reload schema';
