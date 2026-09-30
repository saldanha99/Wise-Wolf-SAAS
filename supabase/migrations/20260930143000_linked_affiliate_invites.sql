-- A escola escolhe uma conta de aluno existente por e-mail exato. O convite
-- continua sendo de uso unico; a vinculacao so acontece apos o aluno entrar
-- na propria conta e aceitar o programa.
create or replace function public.create_linked_affiliate_invite(
  p_commission_cents integer,
  p_affiliate_code text,
  p_student_email text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_student public.profiles%rowtype;
  v_offer_id uuid;
  v_tenant_id text;
begin
  if nullif(pg_catalog.btrim(coalesce(p_student_email, '')), '') is null then
    raise exception 'student_email_required' using errcode = '22023';
  end if;

  -- Esta porta reaproveita todas as verificacoes de papel, tenant, cupom e
  -- comissao da criacao normal; erro posterior reverte o convite inteiro.
  v_offer_id := public.create_affiliate_invite(
    p_commission_cents, null, p_affiliate_code
  );
  select offer.tenant_id into v_tenant_id
    from public.offers as offer where offer.id = v_offer_id;

  select profile.* into v_student
    from public.profiles as profile
   where profile.tenant_id = v_tenant_id
     and profile.role = 'STUDENT'
     and pg_catalog.lower(profile.email) = pg_catalog.lower(pg_catalog.btrim(p_student_email))
     and pg_catalog.lower(coalesce(profile.lifecycle_status, 'active')) = 'active'
     and exists (
       select 1 from public.tenant_memberships as membership
        where membership.user_id = profile.id
          and membership.tenant_id = profile.tenant_id
          and membership.role = 'STUDENT'
          and membership.status = 'ACTIVE'
     )
   limit 1;
  if not found then
    raise exception 'student_not_found' using errcode = 'P0002';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('linked-affiliate:' || v_student.id::text, 0)
  );
  if exists (
    select 1 from private.affiliate_identity_links as link
     where link.student_user_id = v_student.id
  ) or exists (
    select 1 from public.offers as offer
     where offer.tenant_id = v_tenant_id
       and offer.kind = 'VENDOR_INVITE'
       and offer.id <> v_offer_id
       and offer.payload ->> 'linkedStudentId' = v_student.id::text
       and offer.consumed_at is null
       and offer.revoked_at is null
       and offer.expires_at > pg_catalog.now()
  ) then
    raise exception 'student_already_invited_or_linked' using errcode = '23505';
  end if;

  update public.offers as offer
     set payload = offer.payload || pg_catalog.jsonb_build_object(
       'linkedStudentId', v_student.id::text,
       'suggestedName', v_student.full_name
     )
   where offer.id = v_offer_id;

  return v_offer_id;
end;
$function$;

alter function public.create_linked_affiliate_invite(integer,text,text) owner to postgres;
revoke all on function public.create_linked_affiliate_invite(integer,text,text)
  from public, anon;
grant execute on function public.create_linked_affiliate_invite(integer,text,text)
  to authenticated;

-- Chamado exclusivamente pela funcao de cadastro apos verificar o JWT do
-- proprio aluno. Vínculo e consumo do convite são uma única transação.
create or replace function public.finalize_linked_vendor_invite_server(
  p_offer_id uuid,
  p_claim_token uuid,
  p_student_user_id uuid,
  p_vendor_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_tenant_id text;
  v_linked_student_id text;
begin
  if p_student_user_id is null or p_vendor_user_id is null then
    raise exception 'invalid_linked_invite_finalize' using errcode = '22023';
  end if;
  select offer.tenant_id, offer.payload ->> 'linkedStudentId'
    into v_tenant_id, v_linked_student_id
    from public.offers as offer
   where offer.id = p_offer_id
     and offer.kind = 'VENDOR_INVITE'
     and offer.invite_claim_token = p_claim_token
     and offer.invite_security_version >= 1
     and offer.consumed_at is null
     and offer.revoked_at is null
     and offer.expires_at > pg_catalog.now()
     and offer.invite_claimed_at > pg_catalog.now() - interval '15 minutes'
   for update;
  if v_tenant_id is null or v_linked_student_id is distinct from p_student_user_id::text then
    raise exception 'linked_invite_claim_mismatch' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.profiles as profile
     where profile.id = p_student_user_id
       and profile.role = 'STUDENT'
       and profile.tenant_id = v_tenant_id
       and pg_catalog.lower(coalesce(profile.lifecycle_status, 'active')) = 'active'
       and exists (
         select 1 from public.tenant_memberships as membership
          where membership.user_id = profile.id
            and membership.tenant_id = profile.tenant_id
            and membership.role = 'STUDENT'
            and membership.status = 'ACTIVE'
       )
  ) or not exists (
    select 1 from public.profiles as profile
     where profile.id = p_vendor_user_id
       and profile.role = 'SALESPERSON'
       and profile.tenant_id = v_tenant_id
  ) then
    raise exception 'linked_invite_profile_mismatch' using errcode = '42501';
  end if;

  insert into private.affiliate_identity_links (
    student_user_id, affiliate_user_id, tenant_id, approval_note
  ) values (
    p_student_user_id, p_vendor_user_id, v_tenant_id,
    'Convite da escola aceito pela conta de aluno autenticada'
  );
  perform public.finalize_invite_offer_server(
    p_offer_id, 'VENDOR_INVITE', p_claim_token, p_vendor_user_id
  );
  return true;
end;
$function$;

alter function public.finalize_linked_vendor_invite_server(uuid,uuid,uuid,uuid) owner to postgres;
revoke all on function public.finalize_linked_vendor_invite_server(uuid,uuid,uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.finalize_linked_vendor_invite_server(uuid,uuid,uuid,uuid)
  to service_role;
