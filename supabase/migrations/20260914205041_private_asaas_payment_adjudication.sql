-- Operator-only, explicit seven-case adjudication. No provider mutations,
-- discovery, fabricated externalReference, profile JWT, or public write RPC.
alter table public.student_payments drop constraint if exists student_payments_payment_type_check;
alter table public.student_payments add constraint student_payments_payment_type_check
 check (payment_type in ('SUBSCRIPTION','ENROLLMENT','PRO_RATA','REFUND','OTHER','UNASSIGNED_RECEIPT'));
alter table public.financial_transactions drop constraint if exists financial_transactions_refund_shape;
alter table public.financial_transactions add constraint financial_transactions_refund_shape check (
 refund_student_payment_id is null or (student_payment_id is null and type='SAIDA'
   and category in ('ESTORNO_MENSALIDADE','estorno_aporte_ou_movimentacao','ESTORNO_RECEBIMENTO_NAO_CLASSIFICADO')
   and amount>0 and provider_event_id is not null and length(trim(provider_event_id)) between 1 and 240));

create table if not exists private.asaas_payment_adjudications (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null check (tenant_id='school-wise-wolf'),
  batch_id uuid not null,
  manifest_hash text not null check (manifest_hash ~ '^[0-9a-f]{64}$'),
  case_key text not null check (case_key ~ '^C[0-9]{2}$'),
  disposition text not null check (disposition in ('IMPORT_STUDENT','IMPORT_UNASSIGNED','DUPLICATE_OF')),
  provider_payment_id text not null,
  local_payment_id uuid not null references public.student_payments(id) on delete restrict,
  canonical_provider_payment_id text,
  student_id uuid,
  expected_payment jsonb not null,
  expected_canonical jsonb,
  integration_id uuid not null,
  integration_version bigint not null,
  observed_at timestamptz not null,
  operator_label text not null,
  approval_ref text not null,
  reason text not null,
  created_at timestamptz not null default clock_timestamp(),
  unique(tenant_id,provider_payment_id),
  unique(batch_id,case_key),
  check ((disposition='DUPLICATE_OF')=(canonical_provider_payment_id is not null))
);
alter table private.asaas_payment_adjudications owner to postgres;
alter table private.asaas_payment_adjudications enable row level security;
revoke all on private.asaas_payment_adjudications from public,anon,authenticated,service_role;
drop trigger if exists asaas_payment_adjudications_immutable on private.asaas_payment_adjudications;
create trigger asaas_payment_adjudications_immutable before update or delete or truncate
 on private.asaas_payment_adjudications for each statement execute function private.guard_prepayment_audit_immutable();

-- A proven incoming transfer with no identified student is neither tuition
-- nor an inferred owner contribution. Preserve its cash amount/date while
-- marking the nature explicitly unclassified; no other legacy receipt changes.
-- Patch the existing gross/refund writer together, keeping its conflict guards
-- and event dedupe intact. A separate BEFORE-ledger recategorizer would make
-- the refund writer disagree with its own expected category.
drop trigger if exists classify_adjudicated_unassigned_receipt on public.financial_transactions;
drop function if exists private.classify_adjudicated_unassigned_receipt();
do $patch$
declare v_sql text;
begin
 v_sql:=pg_get_functiondef('public.ledger_on_payment_received()'::regprocedure);
 if strpos(v_sql,'ESTORNO_RECEBIMENTO_NAO_CLASSIFICADO')=0 then
   if strpos(v_sql,'v_category := case')=0 or strpos(v_sql,'v_refund_category := case')=0 then
     raise exception 'adjudication_ledger_definition_changed'; end if;
   v_sql:=replace(v_sql,'v_category := case', $replacement$v_category := case
    when new.payment_type = 'UNASSIGNED_RECEIPT' and new.student_id is null
      and new.raw_payload->>'source' = 'OPERATOR_ADJUDICATION'
      then 'RECEBIMENTO_NAO_CLASSIFICADO'$replacement$);
   v_sql:=replace(v_sql,'v_refund_category := case', $replacement$v_refund_category := case
    when new.payment_type = 'UNASSIGNED_RECEIPT' and new.student_id is null
      and new.raw_payload->>'source' = 'OPERATOR_ADJUDICATION'
      then 'ESTORNO_RECEBIMENTO_NAO_CLASSIFICADO'$replacement$);
 end if;
 if strpos(v_sql,'Recebimento nao classificado (conciliacao automatica)')=0 then
   v_sql:=replace(v_sql,$find$else 'Mensalidade (conciliacao automatica)'$find$,
     $replacement$when new.payment_type = 'UNASSIGNED_RECEIPT' and new.student_id is null
          and new.raw_payload->>'source' = 'OPERATOR_ADJUDICATION'
          then 'Recebimento nao classificado (conciliacao automatica)'
        else 'Mensalidade (conciliacao automatica)'$replacement$);
 end if;
 if strpos(v_sql,'Estorno de recebimento nao classificado (evento Asaas)')=0 then
   v_sql:=replace(v_sql,$find$else 'Estorno de mensalidade (evento Asaas)'$find$,
     $replacement$when new.payment_type = 'UNASSIGNED_RECEIPT' and new.student_id is null
          and new.raw_payload->>'source' = 'OPERATOR_ADJUDICATION'
          then 'Estorno de recebimento nao classificado (evento Asaas)'
        else 'Estorno de mensalidade (evento Asaas)'$replacement$);
 end if;
 execute v_sql;
end;
$patch$;

-- Every normal importer also acquires these identity locks. Cross-column
-- aliases cannot race the operator or manufacture a second receipt for an
-- acknowledged duplicate. Financial updates and reversals remain possible.
create or replace function private.guard_adjudicated_provider_identity()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_alias text;
begin
 if tg_op='UPDATE' and new.student_id is null and new.payment_type='UNASSIGNED_RECEIPT'
   and exists(select 1 from private.asaas_payment_adjudications a
     where a.local_payment_id=new.id and a.tenant_id=new.tenant_id and a.disposition='IMPORT_UNASSIGNED') then
   -- Webhooks replace their raw payload; retain only our durable provenance
   -- marker, never old provider facts or reversal metadata.
   new.raw_payload:=jsonb_set(coalesce(new.raw_payload,'{}'::jsonb),'{source}','"OPERATOR_ADJUDICATION"'::jsonb);
 end if;
 for v_alias in select distinct x from unnest(array[new.asaas_payment_id,new.asaas_id,
   case when tg_op='UPDATE' then old.asaas_payment_id end,case when tg_op='UPDATE' then old.asaas_id end]) x
   where nullif(x,'') is not null order by x loop
   perform pg_advisory_xact_lock(hashtextextended('asaas-adjudication-provider:'||v_alias,0));
 end loop;
 if exists(select 1 from private.asaas_payment_adjudications a where a.disposition='DUPLICATE_OF'
   and a.provider_payment_id in(new.asaas_payment_id,new.asaas_id)) then
   raise exception 'adjudicated_duplicate_cannot_create_receipt' using errcode='23505'; end if;
 if exists(select 1 from public.student_payments p where p.id<>new.id
   and (p.asaas_payment_id in(new.asaas_payment_id,new.asaas_id) or p.asaas_id in(new.asaas_payment_id,new.asaas_id))) then
   raise exception 'student_payment_provider_alias_conflict' using errcode='23505'; end if;
 return new;
end;
$$;
alter function private.guard_adjudicated_provider_identity() owner to postgres;
revoke all on function private.guard_adjudicated_provider_identity() from public,anon,authenticated,service_role;
drop trigger if exists guard_adjudicated_provider_identity on public.student_payments;
create trigger guard_adjudicated_provider_identity before insert or update of asaas_payment_id,asaas_id,raw_payload,payment_type,student_id
 on public.student_payments for each row execute function private.guard_adjudicated_provider_identity();

create or replace function private.asaas_adjudication_has_reversal(p_provider text)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.asaas_webhook_inbox i where i.provider_entity_id=p_provider
   and (i.event_name in ('PAYMENT_REFUNDED','PAYMENT_PARTIALLY_REFUNDED','PAYMENT_REFUND_IN_PROGRESS',
     'PAYMENT_CHARGEBACK_REQUESTED','PAYMENT_CHARGEBACK_DISPUTE','PAYMENT_AWAITING_CHARGEBACK_REVERSAL',
     'PAYMENT_DELETED','PAYMENT_RECEIVED_IN_CASH_UNDONE')
     or upper(coalesce(i.payload#>>'{payment,status}','')) in ('REFUNDED','REFUND_REQUESTED','REFUND_IN_PROGRESS',
       'CHARGEBACK_REQUESTED','CHARGEBACK_DISPUTE','AWAITING_CHARGEBACK_REVERSAL','DELETED','CANCELLED')
     or (i.payload#>'{payment,chargeback}' is not null and i.payload#>'{payment,chargeback}'<>'null')
     or coalesce(i.payload#>>'{payment,refundedValue}','0') !~ '^0(\.0+)?$'
     or exists(select 1 from jsonb_array_elements(case when jsonb_typeof(i.payload#>'{payment,refunds}')='array'
       then i.payload#>'{payment,refunds}' else '[]'::jsonb end) r
       where upper(coalesce(r->>'status','')) in ('DONE','REQUESTED','IN_PROGRESS'))));
$$;
alter function private.asaas_adjudication_has_reversal(text) owner to postgres;
revoke all on function private.asaas_adjudication_has_reversal(text) from public,anon,authenticated,service_role;

create or replace function private.asaas_adjudication_payment_matches(p_proof jsonb,p_expected jsonb,p_status text)
returns boolean language plpgsql immutable set search_path='' as $$
declare v_due date; v_paid date; v_credit date; v_value numeric;
begin
 if jsonb_typeof(p_proof) is distinct from 'object' or jsonb_typeof(p_expected) is distinct from 'object'
   or p_proof->>'status' is distinct from p_status or p_status not in ('RECEIVED','RECEIVED_IN_CASH')
   or coalesce(p_proof->>'id','') !~ '^pay_[A-Za-z0-9]+$'
   or coalesce(p_proof->>'customer','') !~ '^cus_[A-Za-z0-9]+$'
   or nullif(p_proof->>'subscription','') is not null or nullif(p_proof->>'externalReference','') is not null
   or coalesce(p_proof->>'deleted','false')<>'false'
   or (p_proof->'chargeback' is not null and p_proof->'chargeback'<>'null')
   or coalesce(p_proof->>'refundedValue','0') !~ '^0(\.0+)?$'
   or (p_proof ? 'refunds' and jsonb_typeof(p_proof->'refunds') not in ('array','null'))
   or exists(select 1 from jsonb_array_elements(case when jsonb_typeof(p_proof->'refunds')='array'
     then p_proof->'refunds' else '[]'::jsonb end) r where coalesce(r->>'status','') not in ('CANCELLED','DENIED'))
   or p_proof->>'id' is distinct from p_expected->>'id'
   or p_proof->>'customer' is distinct from p_expected->>'customer'
   or p_proof->>'dueDate' is distinct from p_expected->>'dueDate'
   or p_proof->>'paymentDate' is distinct from p_expected->>'paymentDate'
   or p_proof->>'creditDate' is distinct from p_expected->>'creditDate'
   or coalesce(p_proof->>'dueDate','') !~ '^\d{4}-\d{2}-\d{2}$'
   or coalesce(p_proof->>'paymentDate','') !~ '^\d{4}-\d{2}-\d{2}$'
   or (p_status='RECEIVED' and coalesce(p_proof->>'creditDate','') !~ '^\d{4}-\d{2}-\d{2}$') then return false; end if;
 v_due:=(p_proof->>'dueDate')::date; v_paid:=(p_proof->>'paymentDate')::date;
 v_credit:=nullif(p_proof->>'creditDate','')::date; v_value:=(p_proof->>'value')::numeric;
 return coalesce(isfinite(v_due) and isfinite(v_paid) and (v_credit is null or isfinite(v_credit))
   and v_value>0 and v_value::text not in ('NaN','Infinity','-Infinity') and v_value=round(v_value,2)
   and v_value=(p_expected->>'value')::numeric,false);
exception when others then return false;
end;
$$;
alter function private.asaas_adjudication_payment_matches(jsonb,jsonb,text) owner to postgres;
revoke all on function private.asaas_adjudication_payment_matches(jsonb,jsonb,text) from public,anon,authenticated,service_role;

-- Replays and the service reader use the same exact local cash proof. Dates
-- are calendar dates in Sao Paulo, not UTC-midnight assumptions.
create or replace function private.adjudicated_local_receipt_matches(
 p_id uuid,p_expected jsonb,p_student uuid,p_disposition text
) returns boolean language sql stable security definer set search_path='' as $$
 select coalesce((select p.tenant_id='school-wise-wolf' and p.student_id is not distinct from p_student
   and p.status=case when p_disposition='DUPLICATE_OF' then 'RECEIVED_IN_CASH' else 'RECEIVED' end
   and p.provider_status=p.status and coalesce(p.refunded_amount,0)=0 and p.ledger_entry_created is true
   and p.value=(p_expected->>'value')::numeric and p.provider_customer_id=p_expected->>'customer'
   and (p_expected->>'id') in(p.asaas_payment_id,p.asaas_id)
   and (nullif(p.asaas_payment_id,'') is null or p.asaas_payment_id=p_expected->>'id')
   and (nullif(p.asaas_id,'') is null or p.asaas_id=p_expected->>'id')
   and (select count(*) from public.student_payments q where (p_expected->>'id') in(q.asaas_payment_id,q.asaas_id))=1
   and p.due_date is not distinct from (p_expected->>'dueDate')::date
   and p.payment_date is not distinct from (p_expected->>'paymentDate')::date
   and (p.paid_at at time zone 'America/Sao_Paulo')::date is not distinct from
     (p_expected->>case when p_disposition='DUPLICATE_OF' then 'paymentDate' else 'creditDate' end)::date
   and (p_disposition='DUPLICATE_OF' or (p.credited_at at time zone 'America/Sao_Paulo')::date=(p_expected->>'creditDate')::date)
   and (p_disposition<>'DUPLICATE_OF' or coalesce(nullif(p.authoritative_subscription_id,''),
     nullif(p.raw_payload#>>'{payment,subscription}',''))=p_expected->>'subscription')
   and (case when p_student is null then p.payment_type='UNASSIGNED_RECEIPT'
     and p.raw_payload->>'source'='OPERATOR_ADJUDICATION'
     and not exists(select 1 from public.profiles s where s.asaas_customer_id=p_expected->>'customer')
     else exists(select 1 from public.profiles s where s.id=p_student and s.tenant_id=p.tenant_id
       and s.role='STUDENT' and s.asaas_customer_id=p_expected->>'customer')
       and (select count(*) from public.profiles s where s.asaas_customer_id=p_expected->>'customer')=1 end)
   and not private.bound_payment_has_reversal_evidence(p.id)
   and not exists(select 1 from public.financial_transactions f where f.refund_student_payment_id=p.id)
   and (select count(*) from public.financial_transactions f where f.student_payment_id=p.id)=1
   and exists(select 1 from public.financial_transactions f where f.student_payment_id=p.id
     and f.tenant_id=p.tenant_id and f.reference_id is not distinct from p.student_id
     and f.type='ENTRADA' and f.amount=p.value and f.amount_cents=round(p.value*100)
     and f.category=case when p_disposition='IMPORT_UNASSIGNED' then 'RECEBIMENTO_NAO_CLASSIFICADO' else 'MENSALIDADE' end
     and (f.occurred_at at time zone 'America/Sao_Paulo')::date=
       (p_expected->>case when p_disposition='DUPLICATE_OF' then 'paymentDate' else 'creditDate' end)::date)
 from public.student_payments p where p.id=p_id),false);
$$;
alter function private.adjudicated_local_receipt_matches(uuid,jsonb,uuid,text) owner to postgres;
revoke all on function private.adjudicated_local_receipt_matches(uuid,jsonb,uuid,text) from public,anon,authenticated,service_role;

create or replace function private.apply_asaas_payment_adjudication_batch(
 p_manifest jsonb,p_proofs jsonb,p_integration_id uuid,p_integration_version bigint,p_commit boolean default false
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_case jsonb; v_proof jsonb; v_payment jsonb; v_canonical jsonb; v_expected jsonb;
 v_batch uuid; v_student uuid; v_local uuid; v_provider text; v_canonical_id text;
 v_disposition text; v_key text; v_operator text; v_approval text; v_hash text;
 v_observed timestamptz; v_paid date; v_credit date; v_first date; v_months integer; v_value numeric;
 v_profile public.profiles%rowtype; v_source public.student_payments%rowtype;
 v_locked_students uuid[]; v_locked_payments uuid[];
 v_prior private.asaas_payment_adjudications%rowtype; v_connection private.tenant_integration_connections%rowtype;
 v_result jsonb:='[]'; v_registration uuid; v_count integer; v_today date:=(clock_timestamp() at time zone 'America/Sao_Paulo')::date;
begin
 -- Database operator only. No service JWT, impersonation, auth.uid(), or role
 -- claims can authorize this command through PostgREST.
 if session_user not in ('postgres','supabase_admin') or current_setting('role',true) not in ('none','postgres','supabase_admin')
   or coalesce(auth.jwt()->>'role','')<>'' or auth.uid() is not null then
   raise exception 'adjudication_database_operator_required' using errcode='42501'; end if;
 if jsonb_typeof(p_manifest) is distinct from 'object' or p_manifest->>'version' is distinct from '1'
   or p_manifest->>'tenant_id' is distinct from 'school-wise-wolf'
   or jsonb_typeof(p_manifest->'cases') is distinct from 'array' or jsonb_array_length(p_manifest->'cases')<>7
   or jsonb_typeof(p_proofs) is distinct from 'array' or jsonb_array_length(p_proofs)<>7 or p_commit is null then
   raise exception 'adjudication_manifest_invalid'; end if;
 v_batch:=(p_manifest->>'batch_id')::uuid; v_operator:=btrim(p_manifest->>'operator'); v_approval:=btrim(p_manifest->>'approval_ref');
 if v_batch is null or length(coalesce(v_operator,'')) not between 3 and 120 or coalesce(v_approval,'') !~ '^[0-9a-f]{64}$'
   or (select count(distinct c->>'case_key') from jsonb_array_elements(p_manifest->'cases') c)<>7
   or (select count(distinct c#>>'{expected_payment,id}') from jsonb_array_elements(p_manifest->'cases') c)<>7
   or (select count(*) from jsonb_array_elements(p_manifest->'cases') c where c->>'disposition'='IMPORT_UNASSIGNED')<>4
   or (select count(*) from jsonb_array_elements(p_manifest->'cases') c where c->>'disposition'='IMPORT_STUDENT')<>2
   or (select count(*) from jsonb_array_elements(p_manifest->'cases') c where c->>'disposition'='DUPLICATE_OF')<>1
   or (select count(*) from jsonb_array_elements(p_manifest->'cases') c where c->'prepayment' is not null and c->'prepayment'<>'null')<>1 then
   raise exception 'adjudication_manifest_scope_invalid'; end if;
 v_hash:=encode(extensions.digest(convert_to(p_manifest::text,'UTF8'),'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended('asaas-adjudication-batch:'||v_batch::text,0));
 -- Same order as normal bound/webhook/prepayment writers: lifecycle ->
 -- notification fence -> profile -> existing payment row -> provider alias.
 -- Taking provider locks first could deadlock a webhook holding lifecycle or
 -- the canonical payment row. Snapshot discovery below is revalidated later.
 select coalesce(array_agg(distinct p.id order by p.id),'{}'::uuid[]) into v_locked_payments
 from public.student_payments p where exists(select 1 from jsonb_array_elements(p_manifest->'cases') c
   where c#>>'{expected_payment,id}' in(p.asaas_payment_id,p.asaas_id)
     or c#>>'{expected_canonical,id}' in(p.asaas_payment_id,p.asaas_id));
 select coalesce(array_agg(distinct s order by s),'{}'::uuid[]) into v_locked_students from (
   select nullif(c->>'student_id','')::uuid s from jsonb_array_elements(p_manifest->'cases') c
   union select student_id from public.student_payments where id=any(v_locked_payments)
 ) candidates where s is not null;
 foreach v_student in array v_locked_students loop
   perform pg_advisory_xact_lock(hashtextextended('student-billing-lifecycle:school-wise-wolf:'||v_student::text,0));
 end loop;
 foreach v_local in array v_locked_payments loop
   perform pg_advisory_xact_lock(hashtextextended('management-payment-notification:school-wise-wolf:'||v_local::text,0));
 end loop;
 perform 1 from public.profiles where id=any(v_locked_students) order by id for share;
 perform 1 from public.student_payments where id=any(v_locked_payments) order by id for update;
 perform 1 from public.tenants where id='school-wise-wolf' for share;
 if not private.tenant_is_operational('school-wise-wolf') then raise exception 'adjudication_tenant_inactive'; end if;
 select * into v_connection from private.tenant_integration_connections where id=p_integration_id
   and tenant_id='school-wise-wolf' and provider='asaas' and mode='PLATFORM_MANAGED_ROOT'
   and status in ('healthy','configured') and version=p_integration_version for share;
 if not found then raise exception 'adjudication_integration_changed'; end if;
 -- All source identities are serialized before touching any payment/allocation.
 for v_provider in select x from (
   select value#>>'{expected_payment,id}' x from jsonb_array_elements(p_manifest->'cases')
   union select value#>>'{expected_canonical,id}' from jsonb_array_elements(p_manifest->'cases')) q
   where x is not null order by x loop
   perform pg_advisory_xact_lock(hashtextextended('asaas-adjudication-provider:'||v_provider,0));
 end loop;
 for v_case in select value from jsonb_array_elements(p_manifest->'cases') order by value->>'case_key' loop
   v_key:=v_case->>'case_key'; v_expected:=v_case->'expected_payment'; v_provider:=v_expected->>'id';
   v_disposition:=v_case->>'disposition'; v_student:=nullif(v_case->>'student_id','')::uuid;
   v_months:=null; v_first:=null; v_registration:=null;
   if coalesce(v_key,'') !~ '^C[0-9]{2}$' or length(btrim(coalesce(v_case->>'reason',''))) not between 12 and 500 then
     raise exception 'adjudication_case_invalid'; end if;
   if (select count(*) from jsonb_array_elements(p_proofs) p where p->>'case_key'=v_key)<>1 then
     raise exception 'adjudication_case_proof_ambiguous'; end if;
   select value into v_proof from jsonb_array_elements(p_proofs) where value->>'case_key'=v_key;
   -- Reject reversal metadata before minimizing, including chargeback payloads.
   if (v_proof#>'{payment,chargeback}' is not null and v_proof#>'{payment,chargeback}'<>'null')
     or (v_proof#>'{canonical_payment,chargeback}' is not null and v_proof#>'{canonical_payment,chargeback}'<>'null') then
     raise exception 'adjudication_chargeback_requires_review'; end if;
   v_payment:=private.minimal_bound_provider_snapshot(v_proof->'payment',false);
   v_canonical:=private.minimal_bound_provider_snapshot(v_proof->'canonical_payment',false);
   v_observed:=(v_proof->>'observed_at')::timestamptz;
   if v_observed is null or v_observed<clock_timestamp()-interval '45 seconds' or v_observed>clock_timestamp()+interval '5 seconds'
     or not private.asaas_adjudication_payment_matches(v_payment,v_expected,'RECEIVED')
     or private.asaas_adjudication_has_reversal(v_provider) then raise exception 'adjudication_payment_unproven_or_stale'; end if;
   v_paid:=(v_payment->>'paymentDate')::date; v_credit:=(v_payment->>'creditDate')::date; v_value:=(v_payment->>'value')::numeric;
   if v_paid>v_today or v_credit>v_today then raise exception 'adjudication_future_cash'; end if;
   select * into v_prior from private.asaas_payment_adjudications where tenant_id='school-wise-wolf' and provider_payment_id=v_provider;
   if found and (v_prior.manifest_hash<>v_hash or v_prior.batch_id<>v_batch or v_prior.case_key<>v_key) then
     raise exception 'adjudication_existing_decision_conflict'; end if;
   select count(*) into v_count from public.student_payments p where v_provider in (p.asaas_payment_id,p.asaas_id);
   if v_disposition='DUPLICATE_OF' then
     v_canonical_id:=v_case#>>'{expected_canonical,id}';
     if v_student is not null or v_count<>0 or v_case->'prepayment' not in ('null'::jsonb) and v_case ? 'prepayment'
       or v_canonical->>'subscription' is distinct from v_case#>>'{expected_canonical,subscription}'
       or coalesce(v_canonical->>'subscription','') !~ '^sub_[A-Za-z0-9]+$'
       or v_provider=v_canonical_id or not private.asaas_adjudication_payment_matches(
         v_canonical - 'subscription',v_case->'expected_canonical','RECEIVED_IN_CASH')
       or v_canonical->>'customer' is distinct from v_payment->>'customer'
       or v_canonical->>'paymentDate' is distinct from v_payment->>'paymentDate'
       or (v_canonical->>'value')::numeric<>v_value or private.asaas_adjudication_has_reversal(v_canonical_id) then
       raise exception 'adjudication_duplicate_not_proven'; end if;
     select * into v_source from public.student_payments p where v_canonical_id in (p.asaas_payment_id,p.asaas_id) for update;
     if not found or (select count(*) from public.student_payments p where v_canonical_id in(p.asaas_payment_id,p.asaas_id))<>1
       or v_source.tenant_id<>'school-wise-wolf' or v_source.student_id is null or v_source.status<>'RECEIVED_IN_CASH'
       or not (v_source.student_id=any(v_locked_students)) or not (v_source.id=any(v_locked_payments))
       or v_source.provider_status is distinct from 'RECEIVED_IN_CASH' or coalesce(v_source.refunded_amount,0)<>0
       or private.bound_payment_has_reversal_evidence(v_source.id)
       or v_source.provider_customer_id is distinct from v_payment->>'customer' or v_source.value<>v_value
       or v_source.payment_date<>v_paid or v_source.due_date is distinct from (v_canonical->>'dueDate')::date
       or coalesce(nullif(v_source.authoritative_subscription_id,''),nullif(v_source.raw_payload#>>'{payment,subscription}',''))
         is distinct from v_canonical->>'subscription'
       or (nullif(v_source.asaas_payment_id,'') is not null and v_source.asaas_payment_id<>v_canonical_id)
       or (nullif(v_source.asaas_id,'') is not null and v_source.asaas_id<>v_canonical_id)
       or not exists(select 1 from public.profiles s where s.id=v_source.student_id and s.tenant_id=v_source.tenant_id
         and s.asaas_customer_id=v_payment->>'customer' and s.role='STUDENT')
       or (select count(*) from public.financial_transactions f where f.student_payment_id=v_source.id
         and f.tenant_id=v_source.tenant_id and f.amount=v_value and f.type='ENTRADA')<>1
       or exists(select 1 from public.financial_transactions f where f.refund_student_payment_id=v_source.id) then
       raise exception 'adjudication_duplicate_canonical_changed'; end if;
     if not private.adjudicated_local_receipt_matches(v_source.id,v_canonical,v_source.student_id,'DUPLICATE_OF')
       or (v_prior.id is not null and v_prior.student_id is distinct from v_source.student_id) then
       raise exception 'adjudication_duplicate_canonical_changed'; end if;
     v_local:=v_source.id;
   else
     if v_disposition='IMPORT_STUDENT' then
       if v_student is null then raise exception 'adjudication_student_required'; end if;
       perform pg_advisory_xact_lock(hashtextextended('student-billing-lifecycle:school-wise-wolf:'||v_student::text,0));
       select * into v_profile from public.profiles where id=v_student for share;
       if not found or v_profile.tenant_id<>'school-wise-wolf' or v_profile.role<>'STUDENT'
         or v_profile.asaas_customer_id is distinct from v_payment->>'customer'
         or lower(coalesce(v_profile.lifecycle_status,''))<>'active'
         or not exists(select 1 from public.tenant_memberships m where m.user_id=v_student and m.tenant_id='school-wise-wolf'
           and m.role='STUDENT' and m.status='ACTIVE')
         or (select count(*) from public.profiles s where s.asaas_customer_id=v_payment->>'customer')<>1 then
         raise exception 'adjudication_student_identity_conflict'; end if;
     elsif v_disposition='IMPORT_UNASSIGNED' then
       if v_student is not null or exists(select 1 from public.profiles s where s.asaas_customer_id=v_payment->>'customer') then
         raise exception 'adjudication_unassigned_has_owner'; end if;
     else raise exception 'adjudication_disposition_invalid'; end if;
     if v_case ? 'prepayment' and v_case->'prepayment'<>'null' then
       v_months:=(v_case#>>'{prepayment,months}')::integer; v_first:=(v_case#>>'{prepayment,first_month}')::date;
       if v_disposition<>'IMPORT_STUDENT' or v_months is distinct from 6 or v_case#>>'{prepayment,mode}' is distinct from 'MENSAL'
         or v_first is distinct from date_trunc('month',v_credit::timestamp)::date or v_value<0.06 then
         raise exception 'adjudication_prepayment_scope_invalid'; end if;
       perform pg_advisory_xact_lock(hashtextextended('student-payment-allocation:'||v_student::text,0));
       if exists(select 1 from public.student_payment_allocations a where a.student_id=v_student
         and a.status in ('ACTIVE','REVIEW') and a.competencia between v_first and (v_first+interval '5 months')::date
         and (v_prior.id is null or a.payment_id is distinct from v_prior.local_payment_id)) then
         raise exception 'adjudication_prepayment_overlap'; end if;
     end if;
     if v_prior.id is not null then
       select * into v_source from public.student_payments where id=v_prior.local_payment_id for update;
       if not found or v_count<>1 or v_source.student_id is distinct from v_student or v_source.tenant_id<>'school-wise-wolf'
         or v_source.status<>'RECEIVED' or v_source.provider_status<>'RECEIVED' or coalesce(v_source.refunded_amount,0)<>0
         or v_source.value<>v_value or v_source.provider_customer_id is distinct from v_payment->>'customer'
         or v_source.due_date is distinct from (v_payment->>'dueDate')::date
         or v_source.payment_date is distinct from v_paid or (v_source.credited_at at time zone 'America/Sao_Paulo')::date is distinct from v_credit then
         raise exception 'adjudication_imported_payment_changed'; end if;
       if not private.adjudicated_local_receipt_matches(v_source.id,v_payment,v_student,v_disposition) then
         raise exception 'adjudication_imported_payment_changed'; end if;
       if v_months is not null and not (select count(*)=6 and count(distinct registration_id)=1
         and sum(valor)=v_value and bool_and(status='ACTIVE' and modo='MENSAL' and tenant_id='school-wise-wolf'
           and student_id=v_student and competencia=(v_first+((sequencia-1)||' months')::interval)::date)
         from public.student_payment_allocations where payment_id=v_source.id) then
         raise exception 'adjudication_imported_coverage_changed'; end if;
       v_local:=v_source.id;
     elsif v_count<>0 then raise exception 'adjudication_payment_already_exists';
     else v_local:=gen_random_uuid(); end if;
   end if;
   -- Every potentially blocking lock above counts against proof freshness.
   if v_observed<clock_timestamp()-interval '45 seconds' then raise exception 'adjudication_proof_expired_after_lock'; end if;
   if p_commit and v_prior.id is null then
     if v_disposition<>'DUPLICATE_OF' then
       insert into public.student_payments(id,tenant_id,student_id,asaas_payment_id,provider_customer_id,value,status,provider_status,
         due_date,payment_date,paid_at,credited_at,payment_type,description,raw_payload,last_authoritative_observed_at)
       values(v_local,'school-wise-wolf',v_student,v_provider,v_payment->>'customer',v_value,'RECEIVED','RECEIVED',
         (v_payment->>'dueDate')::date,v_paid,(v_credit::timestamp+interval '12 hours') at time zone 'UTC',
         (v_credit::timestamp+interval '12 hours') at time zone 'UTC',case when v_student is null then 'UNASSIGNED_RECEIPT' else 'SUBSCRIPTION' end,
         case when v_student is null then 'Recebimento sem aluno — adjudicação operacional' else 'Mensalidade — adjudicação operacional' end,
         jsonb_build_object('source','OPERATOR_ADJUDICATION','batch_id',v_batch,'case_key',v_key,'payment',v_payment),v_observed);
       if v_months is not null then
         if private.prepayment_payment_review_reason(v_local) is not null then raise exception 'adjudication_prepayment_source_review'; end if;
         perform private.prepayment_insert_parcelas('school-wise-wolf',v_local,v_local,v_student,v_first,6,v_value,'MENSAL','ASAAS',v_credit,
           'Operator adjudication '||v_batch::text||' / '||v_key);
         select min(registration_id::text)::uuid into v_registration from public.student_payment_allocations where payment_id=v_local;
         if (select count(*) from public.student_payment_allocations where payment_id=v_local and status='ACTIVE')<>6
           or (select sum(valor) from public.student_payment_allocations where payment_id=v_local)<>v_value then
           raise exception 'adjudication_prepayment_incomplete'; end if;
       end if;
       if v_student is not null then
         insert into private.prepayment_financial_recompute_queue(tenant_id,student_id) values('school-wise-wolf',v_student)
         on conflict(tenant_id,student_id) do update set version=prepayment_financial_recompute_queue.version+1,
           requested_at=clock_timestamp(),next_attempt_at=clock_timestamp();
       end if;
     end if;
     insert into private.asaas_payment_adjudications(tenant_id,batch_id,manifest_hash,case_key,disposition,provider_payment_id,
       local_payment_id,canonical_provider_payment_id,student_id,expected_payment,expected_canonical,
       integration_id,integration_version,observed_at,operator_label,approval_ref,reason)
     values('school-wise-wolf',v_batch,v_hash,v_key,v_disposition,v_provider,v_local,
       case when v_disposition='DUPLICATE_OF' then v_canonical_id end,
       case when v_disposition='DUPLICATE_OF' then v_source.student_id else v_student end,v_payment,
       case when v_disposition='DUPLICATE_OF' then v_canonical end,p_integration_id,p_integration_version,v_observed,v_operator,v_approval,v_case->>'reason');
     -- Mark only exact older positive receipts; preserve every original payload
     -- and never swallow a reversal or a concurrent, different provider event.
     update public.asaas_webhook_inbox i set status='PROCESSED',processed_at=clock_timestamp(),
       last_error='operator_adjudication:'||v_batch::text||':'||v_key,updated_at=clock_timestamp()
     where i.provider_entity_id=v_provider and i.status='TRIAGE' and i.event_name='PAYMENT_RECEIVED'
       and i.event_created_at<=v_observed and i.payload#>>'{payment,status}'='RECEIVED'
       and i.payload#>>'{payment,customer}'=v_payment->>'customer'
       and i.payload#>>'{payment,dueDate}'=v_payment->>'dueDate'
       and i.payload#>>'{payment,paymentDate}'=v_payment->>'paymentDate'
       and i.payload#>>'{payment,creditDate}'=v_payment->>'creditDate'
       and i.payload#>>'{payment,value}' ~ '^\d+(\.\d+)?$' and (i.payload#>>'{payment,value}')::numeric=v_value;
     update public.asaas_reconciliation_issues set resolved_at=clock_timestamp(),resolution_note='Operator adjudication '||v_batch::text||' / '||v_key
     where provider_entity_id=v_provider and resolved_at is null and (tenant_id='school-wise-wolf' or tenant_id is null)
       and kind in ('PROVIDER_PAYMENT_MISSING_LOCAL','STATEMENT_RECEIPT_MISSING_LOCAL_PAYMENT','PROVIDER_CUSTOMER_UNRESOLVED');
   end if;
   v_result:=v_result||jsonb_build_array(jsonb_build_object('case_key',v_key,'disposition',v_disposition,
     'action',case when v_prior.id is not null then 'ALREADY_APPLIED' when p_commit then 'APPLIED' else 'DRY_RUN' end,
     'cash_entries',case when v_disposition='DUPLICATE_OF' or v_prior.id is not null then 0 else 1 end,'amount',v_value,'months',v_months));
 end loop;
 -- A late-case wait also ages earlier proofs. Validate the entire batch at
 -- its last database boundary, then commit once; never leak partial work.
 if exists(select 1 from jsonb_array_elements(p_proofs) p
   where (p->>'observed_at')::timestamptz<clock_timestamp()-interval '45 seconds') then
   raise exception 'adjudication_batch_proof_expired'; end if;
 if exists(select 1 from jsonb_array_elements(p_manifest->'cases') c
   where private.asaas_adjudication_has_reversal(c#>>'{expected_payment,id}')
     or private.asaas_adjudication_has_reversal(c#>>'{expected_canonical,id}')) then
   raise exception 'adjudication_batch_reversal_observed'; end if;
 return jsonb_build_object('ok',true,'committed',p_commit,'batch_id',v_batch,'cases',v_result);
end;
$$;
alter function private.apply_asaas_payment_adjudication_batch(jsonb,jsonb,uuid,bigint,boolean) owner to postgres;
revoke all on function private.apply_asaas_payment_adjudication_batch(jsonb,jsonb,uuid,bigint,boolean) from public,anon,authenticated,service_role;

-- Reader only: reconciliation still compares the fresh provider facts before
-- omitting an acknowledged missing-owner/duplicate warning. Invalidated
-- decisions are returned with valid=false, never silently hidden.
create or replace function public.get_asaas_payment_adjudications()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb;
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'service_role_required' using errcode='42501'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'disposition',a.disposition,'provider_payment_id',a.provider_payment_id,
   'local_payment_id',a.local_payment_id,'canonical_provider_payment_id',a.canonical_provider_payment_id,'student_id',a.student_id,
   'expected_payment',a.expected_payment,'expected_canonical',a.expected_canonical,
   'valid',private.adjudicated_local_receipt_matches(p.id,
     case when a.disposition='DUPLICATE_OF' then a.expected_canonical else a.expected_payment end,a.student_id,a.disposition)
     and not private.asaas_adjudication_has_reversal(a.provider_payment_id)
     and not private.asaas_adjudication_has_reversal(coalesce(a.canonical_provider_payment_id,a.provider_payment_id)))), '[]'::jsonb) into v_result
 from private.asaas_payment_adjudications a join public.student_payments p on p.id=a.local_payment_id
 where a.tenant_id='school-wise-wolf';
 return v_result;
end;
$$;
alter function public.get_asaas_payment_adjudications() owner to postgres;
revoke all on function public.get_asaas_payment_adjudications() from public,anon,authenticated;
grant execute on function public.get_asaas_payment_adjudications() to service_role;
notify pgrst,'reload schema';
