-- Prevent a card-update link from collecting a prepaid, disputed or unbound
-- obligation. No provider call, payment mutation or new money is made here.
create or replace function private.validate_overdue_card_obligations(
 p_tenant text,p_student uuid,p_subscription text,p_snapshots jsonb
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_profile public.profiles%rowtype; v_payment public.student_payments%rowtype;
 v_item jsonb; v_count integer; v_due date; v_cents numeric; v_block text;
begin
 if p_tenant is null or p_student is null or nullif(p_subscription,'') is null
   or jsonb_typeof(p_snapshots) is distinct from 'array' or jsonb_array_length(p_snapshots)>500 then
   return jsonb_build_object('ok',false,'reason','invalid_obligation_snapshot'); end if;
 perform pg_advisory_xact_lock(hashtextextended('student-billing-lifecycle:'||p_tenant||':'||p_student::text,0));
 select * into v_profile from public.profiles where id=p_student and tenant_id=p_tenant for update;
 if not found or v_profile.role is distinct from 'STUDENT' or lower(coalesce(v_profile.lifecycle_status,''))<>'active'
   or lower(coalesce(v_profile.status,'')) not in ('ativo','active')
   or v_profile.subscription_id is distinct from p_subscription
   or nullif(v_profile.asaas_customer_id,'') is null or not private.tenant_is_operational(p_tenant)
   or (select count(*) from public.tenant_memberships where user_id=p_student)<>1
   or not exists(select 1 from public.tenant_memberships where user_id=p_student and tenant_id=p_tenant and role='STUDENT' and status='ACTIVE') then
   return jsonb_build_object('ok',false,'reason','student_binding_unavailable'); end if;
 if exists(select 1 from jsonb_array_elements(p_snapshots) x group by x->>'id' having count(*)<>1) then
   return jsonb_build_object('ok',false,'reason','ambiguous_obligation'); end if;
 -- Same invoice order for every call, then the allocation fence shared by
 -- registration/cancellation. Prepayment registration never locks profiles.
 perform 1 from public.student_payments p where p.tenant_id=p_tenant and p.student_id=p_student
   and exists(select 1 from jsonb_array_elements(p_snapshots) x where x->>'id' in (p.asaas_payment_id,p.asaas_id))
   order by p.id for update;
 perform pg_advisory_xact_lock(hashtextextended('student-payment-allocation:'||p_student::text,0));
 if jsonb_array_length(p_snapshots)>0 and exists(select 1 from private.prepayment_financial_recompute_queue
   where tenant_id=p_tenant and student_id=p_student and processed_version<version) then
   return jsonb_build_object('ok',false,'reason','financial_recompute_pending'); end if;
 for v_item in select value from jsonb_array_elements(p_snapshots) loop
   if jsonb_typeof(v_item) is distinct from 'object' or coalesce(v_item->>'id','')!~'^pay_[A-Za-z0-9_]+$'
     or v_item->>'subscription' is distinct from p_subscription or v_item->>'status' is distinct from 'OVERDUE'
     or coalesce(v_item->>'billingType','') not in ('PIX','BOLETO','CREDIT_CARD','UNDEFINED')
     or coalesce(v_item->>'value_cents','')!~'^[1-9][0-9]*$'
     or coalesce(v_item->>'dueDate','')!~'^\d{4}-\d{2}-\d{2}$' then
     return jsonb_build_object('ok',false,'reason','invalid_obligation_snapshot'); end if;
   begin v_due:=(v_item->>'dueDate')::date; v_cents:=(v_item->>'value_cents')::numeric;
   exception when others then return jsonb_build_object('ok',false,'reason','invalid_obligation_snapshot'); end;
   if not isfinite(v_due) or v_due>=(clock_timestamp() at time zone 'America/Sao_Paulo')::date or v_cents>9007199254740991 then
     return jsonb_build_object('ok',false,'reason','obligation_not_overdue'); end if;
   select count(*) into v_count from public.student_payments p where v_item->>'id' in (p.asaas_payment_id,p.asaas_id);
   if v_count<>1 then return jsonb_build_object('ok',false,'reason','obligation_binding_missing_or_ambiguous'); end if;
   select * into v_payment from public.student_payments p where v_item->>'id' in (p.asaas_payment_id,p.asaas_id);
   if v_payment.tenant_id is distinct from p_tenant or v_payment.student_id is distinct from p_student
     or v_payment.provider_customer_id is distinct from v_profile.asaas_customer_id
     or (nullif(v_payment.asaas_payment_id,'') is not null and v_payment.asaas_payment_id<>v_item->>'id')
     or (nullif(v_payment.asaas_id,'') is not null and v_payment.asaas_id<>v_item->>'id')
     or coalesce(v_payment.status,'') not in ('PENDING','OVERDUE')
     or coalesce(v_payment.provider_status,v_payment.status,'') not in ('PENDING','OVERDUE')
     or v_payment.due_date is distinct from v_due or round(v_payment.value*100) is distinct from v_cents
     or coalesce(v_payment.refunded_amount,0)<>0 or v_payment.paid_at is not null or v_payment.credited_at is not null
     or (nullif(v_payment.raw_payload#>>'{payment,subscription}','') is not null
       and v_payment.raw_payload#>>'{payment,subscription}'<>p_subscription) then
     return jsonb_build_object('ok',false,'reason','obligation_changed'); end if;
   if private.bound_payment_has_reversal_evidence(v_payment.id) then
     return jsonb_build_object('ok',false,'reason','provider_reversal_requires_review'); end if;
   v_block:=private.student_payment_provider_block_reason(v_payment.id);
   if v_block is not null then return jsonb_build_object('ok',false,'reason',v_block); end if;
 end loop;
 return jsonb_build_object('ok',true);
end; $$;
alter function private.validate_overdue_card_obligations(text,uuid,text,jsonb) owner to postgres;
revoke all on function private.validate_overdue_card_obligations(text,uuid,text,jsonb) from public,anon,authenticated,service_role;

create or replace function public.validate_student_overdue_card_obligations(
 p_tenant_id text,p_student_id uuid,p_subscription_id text,p_payment_snapshots jsonb
)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
 return private.validate_overdue_card_obligations(p_tenant_id,p_student_id,p_subscription_id,p_payment_snapshots);
end; $$;
alter function public.validate_student_overdue_card_obligations(text,uuid,text,jsonb) owner to postgres;
revoke all on function public.validate_student_overdue_card_obligations(text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.validate_student_overdue_card_obligations(text,uuid,text,jsonb) to service_role;

create or replace function public.mark_student_overdue_card_charge_submitting_v2(
 p_claim_id uuid,p_claim_token uuid,p_payment_snapshot jsonb
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_claim public.student_overdue_card_charge_claims%rowtype; v_result jsonb;
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
 select * into v_claim from public.student_overdue_card_charge_claims where id=p_claim_id and claim_token=p_claim_token;
 if not found or v_claim.status<>'PROCESSING' or v_claim.lease_expires_at<=clock_timestamp()
   or p_payment_snapshot->>'id' is distinct from v_claim.asaas_payment_id then
   return jsonb_build_object('ok',false,'reason','claim_lost'); end if;
 v_result:=private.validate_overdue_card_obligations(v_claim.tenant_id,v_claim.student_id,
   v_claim.asaas_subscription_id,jsonb_build_array(p_payment_snapshot));
 if v_result->>'ok' is distinct from 'true' then return v_result; end if;
 return public.mark_student_overdue_card_charge_submitting(p_claim_id,p_claim_token);
end; $$;
alter function public.mark_student_overdue_card_charge_submitting_v2(uuid,uuid,jsonb) owner to postgres;
revoke all on function public.mark_student_overdue_card_charge_submitting_v2(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.mark_student_overdue_card_charge_submitting_v2(uuid,uuid,jsonb) to service_role;
-- The old service boundary cannot bypass the new financial proof. Its body is
-- retained for the owner-only delegate and historical database tests.
revoke execute on function public.mark_student_overdue_card_charge_submitting(uuid,uuid) from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
