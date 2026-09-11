-- A pending change keeps the original appointment intact. The database owns the
-- deadline, so delayed webhooks cannot extend it or accept an expired request.
alter table public.trial_reschedule_requests
  alter column expires_at set default (now() + interval '60 minutes');

create or replace function public.cap_trial_reschedule_deadline()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.expires_at := least(new.expires_at, new.created_at + interval '60 minutes', new.requested_start_time);
  return new;
end;
$$;
revoke all on function public.cap_trial_reschedule_deadline() from public, anon, authenticated;
drop trigger if exists cap_trial_reschedule_deadline on public.trial_reschedule_requests;
create trigger cap_trial_reschedule_deadline
before insert or update of expires_at, created_at, requested_start_time
on public.trial_reschedule_requests
for each row execute function public.cap_trial_reschedule_deadline();

update public.trial_reschedule_requests
set expires_at = least(expires_at, created_at + interval '60 minutes', requested_start_time)
where status = 'PENDING';

create or replace function public.expire_trial_reschedule_confirmation(p_tenant_id text, p_request_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_request public.trial_reschedule_requests%rowtype;
begin
  select * into v_request from public.trial_reschedule_requests
  where id = p_request_id and tenant_id = p_tenant_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'request_not_found'); end if;
  -- Same lock order as the teacher acceptance RPC: appointment then request.
  perform 1 from public.appointments where id = v_request.appointment_id for update;
  select * into v_request from public.trial_reschedule_requests
  where id = p_request_id and tenant_id = p_tenant_id for update;
  if v_request.status = 'PENDING' and
     least(v_request.expires_at, v_request.created_at + interval '60 minutes') <= now() then
    update public.trial_reschedule_requests
    set status = 'EXPIRED', responded_at = now(), response_text = 'teacher_acceptance_timeout'
    where id = p_request_id;
    return jsonb_build_object('ok', true, 'expired', true);
  end if;
  return jsonb_build_object('ok', true, 'expired', v_request.status = 'EXPIRED');
end;
$$;
revoke all on function public.expire_trial_reschedule_confirmation(text,uuid) from public, anon, authenticated;
grant execute on function public.expire_trial_reschedule_confirmation(text,uuid) to service_role;

create or replace function public.expire_trial_opportunity_atomic(
  p_tenant_id text,
  p_opportunity_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_runtime_role text := coalesce((select auth.jwt() ->> 'role'), '');
  v_opportunity public.opportunities%rowtype;
  v_request private.vendor_trial_teacher_requests%rowtype;
  v_slot_date date;
  v_slot_time time without time zone;
  v_slot_start timestamptz;
  v_due boolean := false;
begin
  if v_runtime_role <> 'service_role' then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'forbidden'
    );
  end if;
  if nullif(pg_catalog.btrim(coalesce(p_tenant_id, '')), '') is null
     or p_opportunity_id is null then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'invalid_request'
    );
  end if;

  begin
    perform private.lock_trial_conversion_graph(p_opportunity_id);
  exception when no_data_found then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'opportunity_not_found'
    );
  end;
  select opportunity.*
  into v_opportunity
  from public.opportunities as opportunity
  where opportunity.id = p_opportunity_id;

  if v_opportunity.tenant_id is distinct from p_tenant_id
     or v_opportunity.kind <> 'TRIAL' then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'error', 'opportunity_not_found'
    );
  end if;
  if v_opportunity.status = 'EXPIRED'
     and v_opportunity.conversion_status = 'LOST' then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'expired', false,
      'idempotent', true,
      'state', 'EXPIRED'
    );
  end if;
  if v_opportunity.status <> 'OPEN'
     or v_opportunity.conversion_status <> 'OPEN' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'error', 'opportunity_not_expirable',
      'state', v_opportunity.status
    );
  end if;

  select request.*
  into v_request
  from private.vendor_trial_teacher_requests as request
  where request.opportunity_id = p_opportunity_id;

  v_due := coalesce(v_opportunity.opened_at, v_opportunity.created_at)
    <= pg_catalog.now() - case when v_request.id is null
      then interval '60 minutes' else interval '48 hours' end;
  if v_request.id is not null
     and v_request.status in ('AWAITING_STUDENT', 'AWAITING_TEACHER')
     and v_request.slot_start <= pg_catalog.now() + interval '5 minutes' then
    v_due := true;
  end if;
  if exists (
    select 1
    from public.enrollment_links as link
    where link.opportunity_id = p_opportunity_id
      and link.purpose = 'TRIAL_CONFIRMATION'
      and link.status = 'PENDING'
      and link.expires_at <= pg_catalog.now()
  ) then
    v_due := true;
  end if;

  if pg_catalog.jsonb_typeof(v_opportunity.slots_proposed) = 'array'
     and pg_catalog.jsonb_array_length(v_opportunity.slots_proposed) > 0
     and coalesce(v_opportunity.slots_proposed #>> '{0,date}', '')
       ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     and coalesce(v_opportunity.slots_proposed #>> '{0,time}', '')
       ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' then
    begin
      v_slot_date := (v_opportunity.slots_proposed #>> '{0,date}')::date;
      v_slot_time := (v_opportunity.slots_proposed #>> '{0,time}')::time;
      v_slot_start := (v_slot_date + v_slot_time)
        at time zone 'America/Sao_Paulo';
      if v_slot_start <= pg_catalog.now() then
        v_due := true;
      end if;
    exception
      when invalid_datetime_format or datetime_field_overflow then
        null;
    end;
  end if;

  if not v_due then
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'expired', false,
      'idempotent', false,
      'state', 'NOT_DUE'
    );
  end if;

  update public.enrollment_links as link
  set status = 'EXPIRED'
  where link.opportunity_id = p_opportunity_id
    and link.purpose = 'TRIAL_CONFIRMATION'
    and link.status = 'PENDING';

  update private.vendor_trial_teacher_requests as request
  set status = 'EXPIRED',
      updated_at = pg_catalog.now()
  where request.opportunity_id = p_opportunity_id
    and request.status in ('AWAITING_STUDENT', 'AWAITING_TEACHER');

  update public.opportunities as opportunity
  set status = 'EXPIRED',
      conversion_status = 'LOST',
      lost_reason = case
        when v_request.status = 'AWAITING_STUDENT' then coalesce(
          nullif(pg_catalog.btrim(opportunity.lost_reason), ''),
          'STUDENT_CONFIRMATION_EXPIRED'
        )
        else null
      end
  where opportunity.id = p_opportunity_id
    and opportunity.tenant_id = p_tenant_id
    and opportunity.status = 'OPEN'
    and opportunity.conversion_status = 'OPEN';
  if not found then
    raise exception 'trial_expiration_lost_lock' using errcode = '40001';
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'expired', true,
    'idempotent', false,
    'state', 'EXPIRED'
  );
end;
$function$;

alter function public.expire_trial_opportunity_atomic(text,uuid)
  owner to postgres;
revoke all on function public.expire_trial_opportunity_atomic(text,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.expire_trial_opportunity_atomic(text,uuid)
  to service_role;


-- Existing scheduler and authentication stay in place; no job is created on a
-- fresh database. The next sweep after the deadline runs within five minutes.
do $$
declare v_job bigint;
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    select jobid into v_job from cron.job where jobname = 'wisewolf-funnel-sweeper';
    if v_job is not null then perform cron.alter_job(v_job, schedule := '*/5 * * * *'); end if;
  end if;
end;
$$;
