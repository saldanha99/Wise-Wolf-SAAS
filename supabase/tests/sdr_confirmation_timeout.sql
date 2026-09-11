-- Remarcação de experimental só altera o appointment após o aceite explícito
-- do professor. Recusa e conflito preservam o horário anterior.

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(value, false) then
    raise exception 'assertion failed: %', message;
  end if;
end;
$$;
grant execute on function pg_temp.assert_true(boolean, text) to public;

insert into public.tenants (id, name)
values ('trial-reschedule-test', 'Trial Reschedule Test');

insert into auth.users (
  id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  ('00000000-0000-4000-8000-000000000971', 'authenticated', 'authenticated', 'trial-reschedule-teacher@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Teacher Confirmação"}', now(), now()),
  ('00000000-0000-4000-8000-000000000972', 'authenticated', 'authenticated', 'trial-reschedule-other@example.invalid', '{"provider":"email","providers":["email"]}', '{"full_name":"Teacher Outro"}', now(), now());

update public.profiles
   set tenant_id = 'trial-reschedule-test', role = 'TEACHER',
       full_name = 'Teacher Confirmação', phone = '5511999999971'
 where id = '00000000-0000-4000-8000-000000000971';

update public.profiles
   set tenant_id = 'trial-reschedule-test', role = 'TEACHER',
       full_name = 'Teacher Outro', phone = '5511999999972'
 where id = '00000000-0000-4000-8000-000000000972';

set local request.jwt.claims = '{"role":"service_role"}';

insert into public.crm_leads (
  id, tenant_id, name, phone, status, created_at
)
values (
  '00000000-0000-4000-8000-000000000973',
  'trial-reschedule-test',
  'Lead Confirmação',
  '5511999999973',
  'CONTACTED',
  now()
);

insert into public.appointments (
  id, tenant_id, teacher_id, professor_id,
  student_name, student_phone, start_time, status, type
)
values (
  '00000000-0000-4000-8000-000000000974',
  'trial-reschedule-test',
  '00000000-0000-4000-8000-000000000971',
  '00000000-0000-4000-8000-000000000971',
  'Lead Confirmação',
  '5511999999973',
  date_trunc('day', now()) + interval '10 days 15 hours',
  'confirmed',
  'experimental'
);

insert into public.opportunities (
  id, tenant_id, student_name, student_phone, slots_proposed,
  status, winner_teacher_id, professor_id, trial_appointment_id, kind
)
values (
  '00000000-0000-4000-8000-000000000975',
  'trial-reschedule-test',
  'Lead Confirmação',
  '5511999999973',
  '[]'::jsonb,
  'CLAIMED',
  '00000000-0000-4000-8000-000000000971',
  '00000000-0000-4000-8000-000000000971',
  '00000000-0000-4000-8000-000000000974',
  'TRIAL'
);


set local role service_role;
do $test$
declare
  a constant uuid := '00000000-0000-4000-8000-000000000974';
  o constant uuid := '00000000-0000-4000-8000-000000000975';
  t constant uuid := '00000000-0000-4000-8000-000000000971';
  l constant uuid := '00000000-0000-4000-8000-000000000973';
  requested timestamptz := date_trunc('day', now()) + interval '11 days 18 hours';
  original timestamptz;
  request_id uuid;
  reply jsonb;
  expires timestamptz;
begin
  select start_time into original from public.appointments where id=a;
  reply := public.create_trial_reschedule_confirmation('trial-reschedule-test',o,a,t,l,requested);
  perform pg_temp.assert_true((reply->>'created')::boolean, 'request created');
  request_id := (reply->>'request_id')::uuid;
  select expires_at into expires from public.trial_reschedule_requests where id=request_id;
  perform pg_temp.assert_true(expires=now()+interval '60 minutes', 'deadline must be 60 minutes');
  reply := public.create_trial_reschedule_confirmation('trial-reschedule-test',o,a,t,l,requested);
  perform pg_temp.assert_true((reply->>'created')::boolean=false, 'same request must be reused');
  perform pg_temp.assert_true((select expires_at=expires from public.trial_reschedule_requests where id=request_id), 'reuse must not reset deadline');
  reply := public.expire_trial_reschedule_confirmation('other-tenant',request_id);
  perform pg_temp.assert_true(reply->>'error'='request_not_found', 'tenant isolation');
  reply := public.expire_trial_reschedule_confirmation('trial-reschedule-test',request_id);
  perform pg_temp.assert_true((reply->>'expired')::boolean=false, 'must not expire before deadline');
  update public.trial_reschedule_requests set created_at=now()-interval '60 minutes' where id=request_id;
  reply := public.expire_trial_reschedule_confirmation('trial-reschedule-test',request_id);
  perform pg_temp.assert_true((reply->>'expired')::boolean, 'expire at exactly 60 minutes');
  reply := public.expire_trial_reschedule_confirmation('trial-reschedule-test',request_id);
  perform pg_temp.assert_true((reply->>'expired')::boolean, 'retry remains expired');
  reply := public.respond_trial_reschedule_confirmation(request_id,t,true,'SIM teste');
  perform pg_temp.assert_true(reply->>'status'='EXPIRED', 'late acceptance must not revive request');
  perform pg_temp.assert_true((select start_time=original from public.appointments where id=a), 'expired request preserves appointment');
  reply := public.create_trial_reschedule_confirmation('trial-reschedule-test',o,a,t,l,requested+interval '1 day');
  request_id := (reply->>'request_id')::uuid;
  reply := public.respond_trial_reschedule_confirmation(request_id,t,true,'SIM teste');
  perform pg_temp.assert_true(reply->>'status'='ACCEPTED', 'acceptance before deadline still works');
  reply := public.expire_trial_reschedule_confirmation('trial-reschedule-test',request_id);
  perform pg_temp.assert_true((reply->>'expired')::boolean=false, 'accepted request never expires');
end;
$test$;
reset role;
select pg_temp.assert_true(not has_function_privilege('anon','public.expire_trial_reschedule_confirmation(text,uuid)','execute'), 'anon cannot expire');
select pg_temp.assert_true(not has_function_privilege('authenticated','public.expire_trial_reschedule_confirmation(text,uuid)','execute'), 'browser cannot expire');

insert into public.opportunities(id,tenant_id,student_name,student_phone,kind,status,conversion_status,opened_at,slots_proposed)
values ('00000000-0000-4000-8000-000000000976','trial-reschedule-test','Test fixture','5511999999976','TRIAL','OPEN','OPEN',now()-interval '59 minutes',
jsonb_build_array(jsonb_build_object('date',to_char(now()+interval '10 days','YYYY-MM-DD'),'time','15:00')));
set local role service_role;
select pg_temp.assert_true((public.expire_trial_opportunity_atomic('trial-reschedule-test','00000000-0000-4000-8000-000000000976')->>'expired')::boolean=false,'generic must wait 60 minutes');
update public.opportunities set opened_at=now()-interval '60 minutes' where id='00000000-0000-4000-8000-000000000976';
select pg_temp.assert_true((public.expire_trial_opportunity_atomic('trial-reschedule-test','00000000-0000-4000-8000-000000000976')->>'expired')::boolean,'generic expires at 60 minutes');
select pg_temp.assert_true((public.expire_trial_opportunity_atomic('trial-reschedule-test','00000000-0000-4000-8000-000000000976')->>'idempotent')::boolean,'expiration is idempotent');
rollback;
