\set ON_ERROR_STOP on
begin;

do $test$
declare
  v_admin uuid := gen_random_uuid();
  v_teacher uuid := gen_random_uuid();
  v_offer uuid;
  v_claim uuid := gen_random_uuid();
  v_nonce jsonb;
  v_status jsonb;
  v_failed boolean;
begin
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  if has_function_privilege('anon','public.teacher_invite_google_start(uuid,text,text,text)','EXECUTE')
    or has_function_privilege('authenticated','public.teacher_invite_google_claim(uuid,text,uuid,uuid)','EXECUTE')
    or has_table_privilege('service_role','private.teacher_invite_google_proofs','SELECT') then
    raise exception 'Invite Google proof exposed to a browser or direct service table access';
  end if;
  insert into public.tenants(id,name) values ('teacher-invite-google-fixture','Fixture Google convite');
  insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values
    (v_admin,'invite-admin@example.invalid','{"provider":"email"}','{"test_fixture":true}'),
    (v_teacher,'invite-teacher@example.invalid','{"provider":"email"}','{"test_fixture":true}');
  update public.profiles set tenant_id='teacher-invite-google-fixture',role='SCHOOL_ADMIN',
    lifecycle_status='active',is_test_account=true where id=v_admin;
  update public.profiles set tenant_id='teacher-invite-google-fixture',role='TEACHER',
    lifecycle_status='active',is_test_account=true where id=v_teacher;
  insert into private.google_workspace_connections
    (tenant_id,organizer_sub,organizer_email,status,connected_by)
  values ('teacher-invite-google-fixture','fixture-central','central@example.invalid','CONNECTED',v_admin);
  insert into public.offers(kind,tenant_id,payload,expires_at,created_by,invite_security_version)
  values ('TEACHER_INVITE','teacher-invite-google-fixture','{}',now()+interval '1 day',v_admin,1)
  returning id into v_offer;
  if not public.teacher_invite_google_required(v_offer) then
    raise exception 'Configured school did not require Google in teacher invite';
  end if;
  perform public.teacher_invite_google_start(v_offer,repeat('a',64),repeat('b',64),repeat('x',50));
  v_status := public.teacher_invite_google_status(v_offer,repeat('b',64));
  if v_status->>'verified' <> 'false' then raise exception 'Unverified proof looks verified'; end if;
  v_failed := false;
  begin
    perform public.teacher_invite_google_claim(v_offer,repeat('b',64),v_claim,v_teacher);
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'Unverified proof allowed hiring'; end if;
  v_nonce := public.teacher_invite_google_take_state(repeat('a',64));
  if v_nonce->>'offer_id' <> v_offer::text
    or public.teacher_invite_google_take_state(repeat('a',64)) is not null then
    raise exception 'OAuth state not consumed exactly once';
  end if;
  perform public.teacher_invite_google_confirm(repeat('a',64),'fixture-teacher-sub','Teacher@Example.Invalid');
  v_status := public.teacher_invite_google_status(v_offer,repeat('b',64));
  if v_status->>'verified' <> 'true' or v_status->>'email' <> 'teacher@example.invalid' then
    raise exception 'Verified Google account not attached to proof';
  end if;
  v_failed := false;
  begin
    perform public.teacher_invite_google_claim(v_offer,repeat('b',64),v_claim,v_teacher);
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'Unclaimed offer allowed Google identity'; end if;
  update public.offers set invite_claim_token=v_claim,invite_claimed_at=now() where id=v_offer;
  if public.teacher_invite_google_claim(v_offer,repeat('b',64),v_claim,v_teacher)
    <> 'teacher@example.invalid' then
    raise exception 'Claim did not return confirmed account';
  end if;
  if not exists(select 1 from private.teacher_google_identities
    where teacher_id=v_teacher and google_email='teacher@example.invalid') then
    raise exception 'Teacher identity not saved';
  end if;
  v_failed := false;
  begin
    perform public.teacher_invite_google_claim(v_offer,repeat('b',64),v_claim,v_teacher);
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'Google proof was reusable'; end if;
end;
$test$;

rollback;
