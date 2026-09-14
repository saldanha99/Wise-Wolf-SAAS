-- Explicit director intent for ONE covered tuition invoice, never a subscription.
-- No scheduler, seed, or provider request is performed by this migration.
create table if not exists private.prepaid_invoice_cancellation_intents (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id),
  student_id uuid not null references public.profiles(id),
  payment_id uuid not null unique references public.student_payments(id),
  requested_by uuid not null references public.profiles(id),
  reason text not null check(length(btrim(reason)) between 12 and 500),
  source_snapshot jsonb not null,
  status text not null default 'REQUESTED'
    check(status in ('REQUESTED','CHECKING','SUBMITTING','UNKNOWN','CONFIRMED','REVIEW')),
  claim_token uuid,
  lease_until timestamptz,
  provider_precheck jsonb,
  integration_snapshot jsonb,
  last_reason text,
  requested_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  confirmed_at timestamptz
);
create index if not exists prepaid_invoice_cancellation_student
  on private.prepaid_invoice_cancellation_intents(tenant_id,student_id,requested_at desc);
create table if not exists private.prepaid_invoice_cancellation_events (
  id bigint generated always as identity primary key,
  operation_id uuid not null references private.prepaid_invoice_cancellation_intents(id),
  actor_id uuid references public.profiles(id),
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default clock_timestamp()
);
create index if not exists prepaid_invoice_cancellation_event_operation
  on private.prepaid_invoice_cancellation_events(operation_id,id);
alter table private.prepaid_invoice_cancellation_intents owner to postgres;
alter table private.prepaid_invoice_cancellation_events owner to postgres;
alter table private.prepaid_invoice_cancellation_intents enable row level security;
alter table private.prepaid_invoice_cancellation_intents force row level security;
alter table private.prepaid_invoice_cancellation_events enable row level security;
alter table private.prepaid_invoice_cancellation_events force row level security;
revoke all on private.prepaid_invoice_cancellation_intents,private.prepaid_invoice_cancellation_events
  from public,anon,authenticated,service_role;

create or replace function private.guard_prepaid_invoice_event_history()
returns trigger language plpgsql set search_path='' as $$
begin raise exception 'prepaid_invoice_history_is_append_only' using errcode='55000'; end;
$$;
alter function private.guard_prepaid_invoice_event_history() owner to postgres;
revoke all on function private.guard_prepaid_invoice_event_history() from public,anon,authenticated,service_role;
drop trigger if exists prepaid_invoice_event_immutable on private.prepaid_invoice_cancellation_events;
create trigger prepaid_invoice_event_immutable before update or delete on private.prepaid_invoice_cancellation_events
 for each row execute function private.guard_prepaid_invoice_event_history();

create or replace function private.prepaid_invoice_actor_allowed(p_actor uuid,p_tenant text)
returns boolean language sql stable security definer set search_path='' as $$
 select coalesce(p_actor is not null and private.tenant_is_operational(p_tenant) and exists (
   select 1 from public.profiles p where p.id=p_actor and p.lifecycle_status='active'
     and (p.role='SUPER_ADMIN' or (p.tenant_id=p_tenant and exists (
       select 1 from public.tenant_memberships m where m.user_id=p.id
         and m.tenant_id=p_tenant and m.role='SCHOOL_ADMIN' and m.status='ACTIVE'
     )))
 ),false)
$$;
alter function private.prepaid_invoice_actor_allowed(uuid,text) owner to postgres;
revoke all on function private.prepaid_invoice_actor_allowed(uuid,text) from public,anon,authenticated,service_role;

create or replace function private.prepaid_invoice_source(p_payment uuid)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
   'payment_id',p.id,'tenant_id',p.tenant_id,'student_id',p.student_id,
   'provider_payment_id',p.asaas_payment_id,'customer_id',p.provider_customer_id,
   'subscription_id',nullif(s.subscription_id,''),'due_date',p.due_date,'value',p.value,
   'status',p.status,'description',p.description,
   'coverage_registrations',(select jsonb_agg(distinct a.registration_id order by a.registration_id)
     from public.student_payment_allocations a where a.tenant_id=p.tenant_id and a.student_id=p.student_id
       and a.competencia=date_trunc('month',p.due_date)::date and a.status='ACTIVE'
       and private.student_month_covered(p.student_id,p.due_date))
 )
 from public.student_payments p join public.profiles s on s.id=p.student_id and s.tenant_id=p.tenant_id
 where p.id=p_payment and s.role='STUDENT' and p.status in ('PENDING','OVERDUE')
   and private.student_payment_is_covered(p.id)
   and nullif(btrim(p.asaas_payment_id),'') is not null
   and p.provider_customer_id is not null and p.provider_customer_id=nullif(s.asaas_customer_id,'')
   and coalesce(p.refunded_amount,0)=0 and p.value>0 and p.due_date is not null
   -- A historical subscription must not be silently rebound to today's one.
   and (nullif(p.raw_payload#>>'{payment,subscription}','') is null
     or p.raw_payload#>>'{payment,subscription}'=nullif(s.subscription_id,''))
$$;
alter function private.prepaid_invoice_source(uuid) owner to postgres;
revoke all on function private.prepaid_invoice_source(uuid) from public,anon,authenticated,service_role;

create or replace function public.get_prepaid_invoice_cancellations(p_tenant text,p_student uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_rows jsonb;
begin
 if not private.prepaid_invoice_actor_allowed(auth.uid(),p_tenant) then
   return jsonb_build_object('ok',false,'error','sem_permissao'); end if;
 if not exists(select 1 from public.profiles where id=p_student and tenant_id=p_tenant and role='STUDENT') then
   return jsonb_build_object('ok',false,'error','aluno_de_outra_escola'); end if;
 select coalesce(jsonb_agg(jsonb_build_object(
   'payment_id',p.id,'due_date',p.due_date,'value',p.value,'description',p.description,'status',p.status,
   'eligible',private.prepaid_invoice_source(p.id) is not null,
   'operation_id',o.id,'operation_status',o.status,'reason',o.last_reason,'requested_at',o.requested_at,
   'confirmed_at',o.confirmed_at
 ) order by p.due_date,p.id),'[]'::jsonb) into v_rows
 from public.student_payments p left join private.prepaid_invoice_cancellation_intents o on o.payment_id=p.id
 where p.tenant_id=p_tenant and p.student_id=p_student
   and (private.prepaid_invoice_source(p.id) is not null or o.id is not null);
 return jsonb_build_object('ok',true,'invoices',v_rows);
end;
$$;
alter function public.get_prepaid_invoice_cancellations(text,uuid) owner to postgres;
revoke all on function public.get_prepaid_invoice_cancellations(text,uuid) from public,anon;
grant execute on function public.get_prepaid_invoice_cancellations(text,uuid) to authenticated;

create or replace function public.request_prepaid_invoice_cancellation(
 p_payment_id uuid,p_reason text,p_expected_due_date date,p_expected_value numeric
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_source jsonb; v_tenant text; v_op private.prepaid_invoice_cancellation_intents%rowtype;
begin
 select tenant_id into v_tenant from public.student_payments where id=p_payment_id;
 if not private.prepaid_invoice_actor_allowed(auth.uid(),v_tenant) then
   return jsonb_build_object('ok',false,'error','sem_permissao'); end if;
 if length(btrim(coalesce(p_reason,''))) not between 12 and 500 then
   return jsonb_build_object('ok',false,'error','motivo_obrigatorio_12_a_500_caracteres'); end if;
 perform pg_advisory_xact_lock(hashtextextended('prepaid-invoice-cancel:'||p_payment_id::text,0));
 perform 1 from public.student_payments where id=p_payment_id for update;
 if not private.prepaid_invoice_actor_allowed(auth.uid(),v_tenant) then
   return jsonb_build_object('ok',false,'error','sem_permissao'); end if;
 select * into v_op from private.prepaid_invoice_cancellation_intents where payment_id=p_payment_id;
 if found then return jsonb_build_object('ok',true,'already_requested',true,'operation_id',v_op.id,'status',v_op.status); end if;
 v_source:=private.prepaid_invoice_source(p_payment_id);
 if v_source is null then return jsonb_build_object('ok',false,'error','cobranca_nao_elegivel'); end if;
 if (v_source->>'due_date')::date is distinct from p_expected_due_date
   or (v_source->>'value')::numeric is distinct from p_expected_value then
   return jsonb_build_object('ok',false,'error','cobranca_alterada_recarregue'); end if;
 insert into private.prepaid_invoice_cancellation_intents(tenant_id,student_id,payment_id,requested_by,reason,source_snapshot)
 values(v_tenant,(v_source->>'student_id')::uuid,p_payment_id,auth.uid(),btrim(p_reason),v_source) returning * into v_op;
 insert into private.prepaid_invoice_cancellation_events(operation_id,actor_id,event_type,payload)
 values(v_op.id,auth.uid(),'DIRECTOR_REQUESTED',jsonb_build_object('reason',btrim(p_reason),'source',v_source));
 return jsonb_build_object('ok',true,'operation_id',v_op.id,'status',v_op.status);
end;
$$;
alter function public.request_prepaid_invoice_cancellation(uuid,text,date,numeric) owner to postgres;
revoke all on function public.request_prepaid_invoice_cancellation(uuid,text,date,numeric) from public,anon;
grant execute on function public.request_prepaid_invoice_cancellation(uuid,text,date,numeric) to authenticated;

-- Service-only commands still re-check the actual director on every claim and submit.
create or replace function public.claim_prepaid_invoice_cancellation(p_operation uuid,p_actor uuid,p_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_op private.prepaid_invoice_cancellation_intents%rowtype; v_action text;
begin
 select * into v_op from private.prepaid_invoice_cancellation_intents where id=p_operation for update;
 if not found or p_token is null or not private.prepaid_invoice_actor_allowed(p_actor,v_op.tenant_id) then
   return jsonb_build_object('ok',false,'error','sem_permissao'); end if;
 if v_op.status in ('CONFIRMED','REVIEW') then return jsonb_build_object('ok',true,'action','TERMINAL','status',v_op.status); end if;
 if v_op.lease_until>clock_timestamp() and v_op.status in ('CHECKING','SUBMITTING','UNKNOWN') then
   return jsonb_build_object('ok',true,'action','IN_PROGRESS','status',v_op.status); end if;
 v_action:=case when v_op.status in ('SUBMITTING','UNKNOWN') then 'RECONCILE_ONLY' else 'SUBMIT_ONCE' end;
 if v_action='SUBMIT_ONCE' and private.prepaid_invoice_source(v_op.payment_id) is distinct from v_op.source_snapshot then
   update private.prepaid_invoice_cancellation_intents set status='REVIEW',last_reason='source_changed',updated_at=clock_timestamp() where id=v_op.id;
   insert into private.prepaid_invoice_cancellation_events(operation_id,actor_id,event_type) values(v_op.id,p_actor,'SOURCE_CHANGED');
   return jsonb_build_object('ok',true,'action','TERMINAL','status','REVIEW'); end if;
 update private.prepaid_invoice_cancellation_intents set claim_token=p_token,lease_until=clock_timestamp()+interval '60 seconds',
   status=case when v_action='SUBMIT_ONCE' then 'CHECKING' else 'UNKNOWN' end,updated_at=clock_timestamp() where id=v_op.id;
 insert into private.prepaid_invoice_cancellation_events(operation_id,actor_id,event_type,payload)
 values(v_op.id,p_actor,v_action,jsonb_build_object('claim_token',p_token));
 return jsonb_build_object('ok',true,'action',v_action,'operation_id',v_op.id,'token',p_token,'source',v_op.source_snapshot);
end;
$$;
alter function public.claim_prepaid_invoice_cancellation(uuid,uuid,uuid) owner to postgres;
revoke all on function public.claim_prepaid_invoice_cancellation(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_prepaid_invoice_cancellation(uuid,uuid,uuid) to service_role;

create or replace function private.prepaid_invoice_provider_matches(p_source jsonb,p_provider jsonb)
returns boolean language sql immutable set search_path='' as $$
 select coalesce(p_provider->>'id'=p_source->>'provider_payment_id'
   and p_provider->>'customer'=p_source->>'customer_id'
   and nullif(p_provider->>'subscription','') is not distinct from nullif(p_source->>'subscription_id','')
   and p_provider->>'dueDate'=p_source->>'due_date'
   and (p_provider->>'value')::numeric=(p_source->>'value')::numeric,false)
$$;
alter function private.prepaid_invoice_provider_matches(jsonb,jsonb) owner to postgres;
revoke all on function private.prepaid_invoice_provider_matches(jsonb,jsonb) from public,anon,authenticated,service_role;

create or replace function public.begin_prepaid_invoice_delete(
 p_operation uuid,p_actor uuid,p_token uuid,p_provider jsonb,p_integration jsonb
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_op private.prepaid_invoice_cancellation_intents%rowtype;
begin
 select * into v_op from private.prepaid_invoice_cancellation_intents where id=p_operation for update;
 if not found or not private.prepaid_invoice_actor_allowed(p_actor,v_op.tenant_id)
   or v_op.claim_token is distinct from p_token or v_op.status<>'CHECKING' or v_op.lease_until<=clock_timestamp() then
   return jsonb_build_object('ok',false,'error','claim_changed'); end if;
 perform 1 from public.student_payments where id=v_op.payment_id for update;
 if private.prepaid_invoice_source(v_op.payment_id) is distinct from v_op.source_snapshot
   or not private.prepaid_invoice_provider_matches(v_op.source_snapshot,p_provider)
   or not coalesce(p_provider->>'status' in ('PENDING','OVERDUE'),false) or coalesce((p_provider->>'deleted')::boolean,false)
   or p_integration->>'tenant_id' is distinct from v_op.tenant_id then
   return jsonb_build_object('ok',false,'error','source_or_provider_changed'); end if;
 update private.prepaid_invoice_cancellation_intents set status='SUBMITTING',provider_precheck=p_provider,
   integration_snapshot=p_integration,updated_at=clock_timestamp() where id=v_op.id;
 insert into private.prepaid_invoice_cancellation_events(operation_id,actor_id,event_type,payload)
 values(v_op.id,p_actor,'DELETE_BOUNDARY',jsonb_build_object('provider',p_provider,'integration',p_integration));
 return jsonb_build_object('ok',true);
end;
$$;
alter function public.begin_prepaid_invoice_delete(uuid,uuid,uuid,jsonb,jsonb) owner to postgres;
revoke all on function public.begin_prepaid_invoice_delete(uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.begin_prepaid_invoice_delete(uuid,uuid,uuid,jsonb,jsonb) to service_role;

create or replace function public.finish_prepaid_invoice_cancellation(
 p_operation uuid,p_actor uuid,p_token uuid,p_outcome text,p_proof jsonb default '{}'::jsonb
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_op private.prepaid_invoice_cancellation_intents%rowtype; v_confirm boolean:=false; v_local public.student_payments%rowtype;
begin
 select * into v_op from private.prepaid_invoice_cancellation_intents where id=p_operation for update;
 if not found or v_op.claim_token is distinct from p_token or v_op.status not in ('CHECKING','SUBMITTING','UNKNOWN') then
   return jsonb_build_object('ok',false,'error','claim_changed'); end if;
 if p_outcome not in ('UNKNOWN','REVIEW','GET_DELETED','DELETE_CONFIRMED') then
   return jsonb_build_object('ok',false,'error','invalid_outcome'); end if;
 -- A successful DELETE receipt is accepted only after a durable, validated GET.
 if p_outcome='DELETE_CONFIRMED' then
   v_confirm:=v_op.status='SUBMITTING' and v_op.provider_precheck is not null
     and p_proof->>'id'=v_op.source_snapshot->>'provider_payment_id' and p_proof->'deleted'='true'::jsonb;
 elsif p_outcome='GET_DELETED' then
   v_confirm:=private.prepaid_invoice_provider_matches(v_op.source_snapshot,p_proof) and p_proof->'deleted'='true'::jsonb
     and coalesce(p_proof->>'status' in ('PENDING','OVERDUE','CANCELLED','DELETED'),false);
 end if;
 if p_outcome in ('DELETE_CONFIRMED','GET_DELETED') and not coalesce(v_confirm,false) then
   return jsonb_build_object('ok',false,'error','deletion_not_proven'); end if;
 if v_confirm then
   select * into v_local from public.student_payments where id=v_op.payment_id for update;
   if v_local.tenant_id is distinct from v_op.tenant_id or v_local.student_id is distinct from v_op.student_id
     or v_local.asaas_payment_id is distinct from v_op.source_snapshot->>'provider_payment_id'
     or v_local.provider_customer_id is distinct from v_op.source_snapshot->>'customer_id'
     or v_local.due_date is distinct from (v_op.source_snapshot->>'due_date')::date
     or v_local.value is distinct from (v_op.source_snapshot->>'value')::numeric
     or v_local.status not in ('PENDING','OVERDUE','CANCELLED') or coalesce(v_local.refunded_amount,0)<>0 then
     p_outcome:='REVIEW'; v_confirm:=false;
   else
     update public.student_payments set status='CANCELLED',provider_status='DELETED' where id=v_op.payment_id;
   end if;
 end if;
 update private.prepaid_invoice_cancellation_intents set status=case when v_confirm then 'CONFIRMED' else p_outcome end,
   last_reason=case when v_confirm then null else left(coalesce(p_proof->>'reason',p_outcome),160) end,
   confirmed_at=case when v_confirm then clock_timestamp() else confirmed_at end,
   lease_until=null,updated_at=clock_timestamp() where id=v_op.id;
 insert into private.prepaid_invoice_cancellation_events(operation_id,actor_id,event_type,payload)
 values(v_op.id,p_actor,case when v_confirm then 'PROVIDER_DELETION_CONFIRMED' else p_outcome end,p_proof);
 return jsonb_build_object('ok',true,'status',case when v_confirm then 'CONFIRMED' else p_outcome end,'local_cancelled',v_confirm);
end;
$$;
alter function public.finish_prepaid_invoice_cancellation(uuid,uuid,uuid,text,jsonb) owner to postgres;
revoke all on function public.finish_prepaid_invoice_cancellation(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.finish_prepaid_invoice_cancellation(uuid,uuid,uuid,text,jsonb) to service_role;
