-- All access goes through google-meet with verified membership and booking ownership.
-- No Google token or raw transcript is exposed through the browser Data API.
create table public.meet_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  google_sub text not null,
  email text not null,
  encrypted_refresh_token text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id,teacher_id), unique (google_sub)
);
create table public.meet_oauth_states (
  state_hash text primary key,
  tenant_id text not null references public.tenants(id) on delete cascade,
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index meet_oauth_states_expiry_idx on public.meet_oauth_states(expires_at);
create index meet_oauth_states_teacher_idx on public.meet_oauth_states(teacher_id);
create table public.meet_rooms (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  google_sub text not null,
  space_name text unique,
  meeting_uri text,
  state text not null default 'CREATING' check (state in ('CREATING','READY','REVIEW')),
  consent_confirmed_at timestamptz not null,
  last_sync_at timestamptz,
  sync_error text,
  lease_until timestamptz,
  lease_token uuid,
  created_at timestamptz not null default now(),
  unique(booking_id,teacher_id)
);
create index meet_rooms_teacher_idx on public.meet_rooms(tenant_id,teacher_id);
create index meet_rooms_student_idx on public.meet_rooms(tenant_id,student_id);
create index meet_rooms_sync_idx on public.meet_rooms(last_sync_at) where state='READY';
create table public.meet_transcripts (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.meet_rooms(id) on delete cascade,
  tenant_id text not null references public.tenants(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  transcript_name text not null unique,
  occurred_at timestamptz not null,
  entries jsonb not null check(jsonb_typeof(entries)='array'),
  participants jsonb not null check(jsonb_typeof(participants)='array'),
  learner_participant text,
  proposal jsonb,
  analysis_cost_usd numeric,
  analysis_tokens integer,
  state text not null default 'IMPORTED' check(state in ('IMPORTED','ANALYZING','REVIEW','APPROVED','REJECTED')),
  analysis_started_at timestamptz,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  raw_expires_at timestamptz not null default now()+interval '30 days',
  created_at timestamptz not null default now()
);
create index meet_transcripts_room_idx on public.meet_transcripts(room_id,occurred_at desc);
create index meet_transcripts_student_idx on public.meet_transcripts(tenant_id,student_id,occurred_at desc);
create index meet_transcripts_reviewed_by_idx on public.meet_transcripts(reviewed_by);
create index meet_transcripts_expiry_idx on public.meet_transcripts(raw_expires_at);

alter table public.student_learning_memories drop constraint student_learning_memories_source_type_check;
alter table public.student_learning_memories add constraint student_learning_memories_source_type_check
  check(source_type in ('CLASS_LOG','WOLFIE_SESSION','PLANNER_AI','CHATGPT_IMPORT','MANUAL','GOOGLE_MEET'));
create unique index student_learning_memories_meet_source_idx
  on public.student_learning_memories(tenant_id,student_id,source_ref) where source_type='GOOGLE_MEET';

alter table public.meet_connections enable row level security;
alter table public.meet_oauth_states enable row level security;
alter table public.meet_rooms enable row level security;
alter table public.meet_transcripts enable row level security;
revoke all on public.meet_connections,public.meet_oauth_states,public.meet_rooms,public.meet_transcripts from public,anon,authenticated;
grant all on public.meet_connections,public.meet_oauth_states,public.meet_rooms,public.meet_transcripts to service_role;

-- Atomic acceptance: retried clicks cannot create duplicate memories. No profile guesses.
create function public.review_meet_transcript(p_id uuid,p_tenant text,p_reviewer uuid,p_approve boolean)
returns void language plpgsql security invoker set search_path='' as $$
declare t public.meet_transcripts%rowtype; r public.meet_rooms%rowtype; p jsonb;
begin
  select * into t from public.meet_transcripts where id=p_id and tenant_id=p_tenant for update;
  if not found or t.state<>'REVIEW' then raise exception 'review_unavailable'; end if;
  select * into r from public.meet_rooms where id=t.room_id;
  if r.teacher_id<>p_reviewer or not exists(select 1 from public.bookings b where b.id=r.booking_id
    and b.teacher_id=p_reviewer and b.student_id=t.student_id and b.tenant_id=p_tenant
    and upper(b.status)='SCHEDULED') then raise exception 'forbidden'; end if;
  if p_approve then
    p:=t.proposal;
    if p is null then raise exception 'missing_proposal'; end if;
    insert into public.student_learning_memories(tenant_id,student_id,source_type,source_ref,occurred_at,
      lesson_objective,content_practiced,new_vocabulary,recurring_errors,strengths_observed,
      recommended_next_step,confidence_level,verification_status,metadata,created_by)
    values(p_tenant,t.student_id,'GOOGLE_MEET',t.transcript_name,t.occurred_at,
      coalesce(p->>'summary',''),
      array(select jsonb_array_elements_text(p->'practiced')),
      array(select jsonb_array_elements_text(p->'vocabulary')),
      array(select jsonb_array_elements_text(p->'difficulties')),
      array(select jsonb_array_elements_text(p->'strengths')),
      coalesce(p->>'next_lesson',''),'MEDIUM','VERIFIED',
      jsonb_build_object('interests',p->'interests','professional_context',p->'professional_context',
        'teacher_preparation',p->'teacher_preparation','oral_test',p->'oral_test','evidence',p->'evidence',
        'reviewed_by',p_reviewer,'reviewed_at',now()),p_reviewer);
  end if;
  update public.meet_transcripts set state=case when p_approve then 'APPROVED' else 'REJECTED' end,
    reviewed_by=p_reviewer,reviewed_at=now() where id=t.id;
end $$;
revoke all on function public.review_meet_transcript(uuid,text,uuid,boolean) from public,anon,authenticated;
grant execute on function public.review_meet_transcript(uuid,text,uuid,boolean) to service_role;

-- Worker leases are fenced; a stale invocation cannot clear another worker's lease.
create function public.claim_meet_room(p_id uuid)
returns uuid language plpgsql security invoker set search_path='' as $$
declare token uuid := gen_random_uuid();
begin
  update public.meet_rooms set lease_token=token,lease_until=now()+interval '5 minutes'
    where id=p_id and state='READY' and (lease_until is null or lease_until<now());
  if not found then return null; end if;
  return token;
end $$;
revoke all on function public.claim_meet_room(uuid) from public,anon,authenticated;
grant execute on function public.claim_meet_room(uuid) to service_role;

-- The existing VPS vault contains the runtime key. No secret is embedded in this migration.
create function private.trigger_meet_sync()
returns bigint language plpgsql security invoker set search_path='' as $$
declare key text; request_id bigint;
begin
  delete from public.meet_oauth_states where expires_at<now();
  update public.meet_transcripts set entries='[]',participants='[]'
    where raw_expires_at<now() and entries<>'[]'::jsonb;
  if not exists(select 1 from public.meet_rooms r join public.meet_connections c
    on c.tenant_id=r.tenant_id and c.teacher_id=r.teacher_id and c.google_sub=r.google_sub where r.state='READY') then return 0; end if;
  select decrypted_secret into key from vault.decrypted_secrets where name='wisewolf_service_role_key' limit 1;
  if nullif(key,'') is null then return -1; end if;
  select net.http_post(url:='http://kong:8000/functions/v1/google-meet',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||key),
    body:='{"action":"worker"}'::jsonb,timeout_milliseconds:=55000) into request_id;
  return request_id;
end $$;
revoke all on function private.trigger_meet_sync() from public,anon,authenticated;
grant execute on function private.trigger_meet_sync() to service_role;
do $$ begin
  if exists(select 1 from pg_namespace where nspname='cron') then
    perform cron.schedule('wisewolf-meet-sync','*/5 * * * *','select private.trigger_meet_sync();');
  end if;
end $$;
