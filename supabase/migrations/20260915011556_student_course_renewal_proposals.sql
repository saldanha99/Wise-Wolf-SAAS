-- Commercial conditions only. This is NOT a signature, invoice, enrollment,
-- payment authorization or invitation. No worker/cron consumes these drafts.
create table if not exists private.student_course_renewal_proposals (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete restrict,
  student_id uuid not null references public.profiles(id) on delete restrict,
  term_months smallint not null default 6 check(term_months=6),
  monthly_fee_cents bigint not null check(monthly_fee_cents between 1 and 100000000),
  classes_per_week smallint not null check(classes_per_week between 1 and 7),
  suggested_due_day smallint not null check(suggested_due_day between 1 and 28),
  status text not null default 'DRAFT' check(status='DRAFT'),
  signature_status text not null default 'NOT_REQUESTED' check(signature_status='NOT_REQUESTED'),
  billing_status text not null default 'NOT_AUTHORIZED' check(billing_status='NOT_AUTHORIZED'),
  source_snapshot jsonb not null check(jsonb_typeof(source_snapshot)='object'),
  source_note text not null check(length(btrim(source_note)) between 20 and 1500),
  approval_ref text not null check(approval_ref ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  unique(tenant_id,student_id,approval_ref)
);
alter table private.student_course_renewal_proposals owner to postgres;
alter table private.student_course_renewal_proposals enable row level security;
revoke all on private.student_course_renewal_proposals from public,anon,authenticated,service_role;
create index if not exists student_course_renewal_proposals_tenant_idx
  on private.student_course_renewal_proposals(tenant_id,created_at desc);
drop trigger if exists student_course_renewal_proposals_immutable on private.student_course_renewal_proposals;
create trigger student_course_renewal_proposals_immutable before update or delete or truncate
  on private.student_course_renewal_proposals for each statement
  execute function private.guard_prepayment_audit_immutable();

-- Explicit operator command; deliberately unavailable through the Data API.
-- The expected amount is compared to the current profile, never used to
-- silently change it. Missing legacy frequency/day needs documented evidence.
create or replace function private.register_student_course_renewal_proposal(
  p_tenant text,p_student uuid,p_expected_fee_cents bigint,p_frequency smallint,
  p_due_day smallint,p_source_note text,p_approval_ref text
) returns uuid language plpgsql security definer set search_path='' as $$
declare p public.profiles%rowtype; existing private.student_course_renewal_proposals%rowtype;
  v_frequency text; v_id uuid;
begin
  if p_tenant is null or p_student is null or p_expected_fee_cents is null
    or p_frequency is null or p_due_day is null or p_source_note is null or p_approval_ref is null
    or p_frequency not between 1 and 7 or p_due_day not between 1 and 28
    or length(btrim(p_source_note)) not between 20 and 1500
    or p_approval_ref !~ '^[a-f0-9]{64}$' then
    raise exception 'renewal_conditions_invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('course-renewal-proposal:'||p_tenant||':'||p_student::text,0));
  select * into p from public.profiles where id=p_student for share;
  if not found or p.tenant_id is distinct from p_tenant or p.role is distinct from 'STUDENT'
    or coalesce(p.lifecycle_status,'') not in ('active','suspended')
    or p.contract_accepted is distinct from true
    or not private.tenant_is_operational(p_tenant) then
    raise exception 'renewal_student_scope_invalid';
  end if;
  if p.monthly_fee is null or p.monthly_fee<=0 or p.monthly_fee::text in ('NaN','Infinity','-Infinity')
    or p.monthly_fee<>round(p.monthly_fee,2)
    or round(p.monthly_fee*100)::bigint is distinct from p_expected_fee_cents then
    raise exception 'renewal_price_changed';
  end if;
  v_frequency:=nullif(lower(btrim(p.class_frequency)),'');
  if v_frequency is not null and v_frequency is distinct from p_frequency::text||'x' then
    raise exception 'renewal_frequency_changed';
  end if;
  if p.due_day is not null and p.due_day is distinct from p_due_day then
    raise exception 'renewal_due_day_changed';
  end if;
  select * into existing from private.student_course_renewal_proposals
    where tenant_id=p_tenant and student_id=p_student and approval_ref=p_approval_ref;
  if found then
    if existing.monthly_fee_cents<>p_expected_fee_cents or existing.classes_per_week<>p_frequency
      or existing.suggested_due_day<>p_due_day or existing.source_note<>btrim(p_source_note) then
      raise exception 'renewal_proposal_replay_conflict';
    end if;
    return existing.id;
  end if;
  insert into private.student_course_renewal_proposals(
    tenant_id,student_id,monthly_fee_cents,classes_per_week,suggested_due_day,
    source_snapshot,source_note,approval_ref
  ) values(p_tenant,p_student,p_expected_fee_cents,p_frequency,p_due_day,
    jsonb_build_object('monthly_fee',p.monthly_fee,'class_frequency',p.class_frequency,
      'due_day',p.due_day,'fidelity_plan',p.fidelity_plan,'contract_accepted',p.contract_accepted,
      'accepted_at',p.accepted_at,'lifecycle_status',p.lifecycle_status,
      'subscription_id',p.subscription_id,'subscription_end_date',p.asaas_subscription_end_date),
    btrim(p_source_note),p_approval_ref) returning id into v_id;
  return v_id;
end;
$$;
alter function private.register_student_course_renewal_proposal(text,uuid,bigint,smallint,smallint,text,text) owner to postgres;
revoke all on function private.register_student_course_renewal_proposal(text,uuid,bigint,smallint,smallint,text,text)
  from public,anon,authenticated,service_role;

create or replace function public.list_student_course_renewal_proposals(p_tenant text default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_tenant text; v_role text; v_rows jsonb;
begin
  v_tenant:=private.active_tenant_id(auth.uid());
  v_role:=private.active_tenant_role(auth.uid());
  if auth.uid() is null or v_tenant is null or coalesce(v_role,'') not in ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR')
    or (p_tenant is not null and p_tenant is distinct from v_tenant)
    or not private.tenant_is_operational(v_tenant) then
    raise exception 'renewal_proposal_access_denied' using errcode='42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',r.id,'student_name',p.full_name,'term_months',r.term_months,
    'monthly_fee_cents',r.monthly_fee_cents,'total_cents',r.monthly_fee_cents*r.term_months,
    'classes_per_week',r.classes_per_week,'suggested_due_day',r.suggested_due_day,
    'status',r.status,'signature_status',r.signature_status,'billing_status',r.billing_status
  ) order by r.created_at desc),'[]'::jsonb) into v_rows
  from private.student_course_renewal_proposals r
  join public.profiles p on p.id=r.student_id and p.tenant_id=r.tenant_id
  where r.tenant_id=v_tenant;
  return jsonb_build_object('items',v_rows);
end;
$$;
alter function public.list_student_course_renewal_proposals(text) owner to postgres;
revoke all on function public.list_student_course_renewal_proposals(text) from public,anon,authenticated,service_role;
grant execute on function public.list_student_course_renewal_proposals(text) to authenticated;
