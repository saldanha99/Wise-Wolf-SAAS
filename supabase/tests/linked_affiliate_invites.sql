\set ON_ERROR_STOP on
begin;

-- Nenhum usuário pode criar vínculo direto ou finalizar convite pela Data API.
do $test$
begin
  if pg_catalog.has_table_privilege('authenticated', 'private.affiliate_identity_links', 'INSERT')
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.finalize_linked_vendor_invite_server(uuid,uuid,uuid,uuid)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'authenticated', 'public.create_linked_affiliate_invite(integer,text,text)', 'EXECUTE'
     ) then
    raise exception 'linked affiliate permissions incorrect';
  end if;
end;
$test$;

-- Usa um aluno e diretor ativos apenas dentro deste rollback. Em ambientes
-- sem esse par a checagem de porta acima ainda roda.
do $setup$
declare
  v_admin_id uuid;
  v_email text;
begin
  select director.user_id, student.email
    into v_admin_id, v_email
    from public.tenant_memberships as director
    join public.profiles as director_profile
      on director_profile.id = director.user_id
     and pg_catalog.lower(coalesce(director_profile.lifecycle_status, 'active')) = 'active'
    join public.profiles as student
      on student.tenant_id = director.tenant_id
     and student.role = 'STUDENT'
     and pg_catalog.lower(coalesce(student.lifecycle_status, 'active')) = 'active'
    join public.tenant_memberships as student_membership
      on student_membership.user_id = student.id
     and student_membership.tenant_id = student.tenant_id
     and student_membership.role = 'STUDENT'
     and student_membership.status = 'ACTIVE'
   where director.role = 'SCHOOL_ADMIN'
     and director.status = 'ACTIVE'
     and not exists (
       select 1 from private.affiliate_identity_links as link
        where link.student_user_id = student.id
     )
     and not exists (
       select 1 from public.offers as offer
        where offer.tenant_id = student.tenant_id
          and offer.kind = 'VENDOR_INVITE'
          and offer.payload ->> 'linkedStudentId' = student.id::text
          and offer.consumed_at is null
          and offer.revoked_at is null
          and offer.expires_at > pg_catalog.now()
     )
   limit 1;
  if v_admin_id is not null then
    perform pg_catalog.set_config('test.linked_affiliate_admin', v_admin_id::text, true);
    perform pg_catalog.set_config('test.linked_affiliate_student_email', v_email, true);
  end if;
end;
$setup$;

set local role authenticated;
do $exercise$
declare
  v_offer_id uuid;
  v_email text := nullif(pg_catalog.current_setting('test.linked_affiliate_student_email', true), '');
  v_admin_id text := nullif(pg_catalog.current_setting('test.linked_affiliate_admin', true), '');
begin
  if v_admin_id is null then return; end if;
  perform pg_catalog.set_config('request.jwt.claim.sub', v_admin_id, true);
  perform pg_catalog.set_config('request.jwt.claims',
    pg_catalog.jsonb_build_object('sub', v_admin_id, 'role', 'authenticated')::text, true);
  v_offer_id := public.create_linked_affiliate_invite(4900, null, v_email);
  if v_offer_id is null or not exists (
    select 1 from public.offers as offer
     where offer.id = v_offer_id
       and offer.payload ? 'linkedStudentId'
  ) then
    raise exception 'linked invite did not bind exact student';
  end if;
  begin
    perform public.create_linked_affiliate_invite(4900, null, v_email);
    raise exception 'duplicate linked invite accepted';
  exception when unique_violation then
    null;
  end;
end;
$exercise$;
reset role;
rollback;
