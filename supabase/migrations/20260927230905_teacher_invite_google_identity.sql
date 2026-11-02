-- A conta Google do candidato é confirmada antes da assinatura do convite.
-- Só a edge com service_role acessa estas funções; o token do Google é descartado.
create table if not exists private.teacher_invite_google_proofs (
  proof_hash text primary key check (proof_hash ~ '^[0-9a-f]{64}$'),
  state_hash text not null unique check (state_hash ~ '^[0-9a-f]{64}$'),
  offer_id uuid not null references public.offers(id) on delete cascade,
  tenant_id text not null references public.tenants(id),
  verifier_ciphertext text not null,
  expires_at timestamptz not null,
  state_consumed_at timestamptz,
  google_sub text check (google_sub is null or google_sub ~ '^[0-9A-Za-z_-]{1,255}$'),
  google_email text check (google_email is null or
    (google_email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' and google_email = lower(google_email))),
  verified_at timestamptz,
  claimed_at timestamptz,
  teacher_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint teacher_invite_google_verified_pair check
    ((google_sub is null and google_email is null and verified_at is null) or
     (google_sub is not null and google_email is not null and verified_at is not null))
);
create index if not exists teacher_invite_google_proofs_offer_idx
  on private.teacher_invite_google_proofs(offer_id, expires_at desc);
alter table private.teacher_invite_google_proofs owner to postgres;
alter table private.teacher_invite_google_proofs enable row level security;
revoke all on private.teacher_invite_google_proofs from public, anon, authenticated, service_role;

create or replace function public.teacher_invite_google_required(p_offer_id uuid)
returns boolean language sql stable security definer set search_path = '' as $function$
  select exists (
    select 1 from public.offers o
    join private.google_workspace_connections c on c.tenant_id = o.tenant_id
    where o.id = p_offer_id and o.kind = 'TEACHER_INVITE'
  );
$function$;

create or replace function public.teacher_invite_google_start(
  p_offer_id uuid, p_state_hash text, p_proof_hash text, p_verifier_ciphertext text
) returns text language plpgsql security definer set search_path = '' as $function$
declare v_tenant text;
begin
  if p_state_hash !~ '^[0-9a-f]{64}$' or p_proof_hash !~ '^[0-9a-f]{64}$'
    or length(p_verifier_ciphertext) not between 30 and 10000 then
    raise exception 'google_invite_request_invalid' using errcode='22023';
  end if;
  select o.tenant_id into v_tenant from public.offers o
  where o.id=p_offer_id and o.kind='TEACHER_INVITE'
    and o.invite_security_version >= 1
    and o.consumed_at is null and o.revoked_at is null
    and o.expires_at > now()
    and private.tenant_is_operational(o.tenant_id)
    and (o.invite_claim_token is null or o.invite_claimed_at < now()-interval '15 minutes');
  if v_tenant is null or not public.teacher_invite_google_required(p_offer_id) then
    raise exception 'google_invite_unavailable' using errcode='22023';
  end if;
  delete from private.teacher_invite_google_proofs where expires_at < now()-interval '1 day';
  insert into private.teacher_invite_google_proofs
    (proof_hash,state_hash,offer_id,tenant_id,verifier_ciphertext,expires_at)
  values (p_proof_hash,p_state_hash,p_offer_id,v_tenant,p_verifier_ciphertext,
    least(now()+interval '2 hours', (select expires_at from public.offers where id=p_offer_id)));
  return v_tenant;
end;
$function$;

create or replace function public.teacher_invite_google_take_state(p_state_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_row private.teacher_invite_google_proofs%rowtype;
begin
  update private.teacher_invite_google_proofs p set state_consumed_at=now()
  where p.state_hash=p_state_hash and p.state_consumed_at is null
    and p.expires_at > now() and p.claimed_at is null
  returning * into v_row;
  if not found then return null; end if;
  return jsonb_build_object('state_hash',v_row.state_hash,'tenant_id',v_row.tenant_id,
    'offer_id',v_row.offer_id,'verifier_ciphertext',v_row.verifier_ciphertext);
end;
$function$;

create or replace function public.teacher_invite_google_confirm(
  p_state_hash text, p_google_sub text, p_google_email text
) returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_row private.teacher_invite_google_proofs%rowtype; v_email text;
begin
  v_email := lower(btrim(coalesce(p_google_email,'')));
  if p_google_sub !~ '^[0-9A-Za-z_-]{1,255}$'
    or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then
    raise exception 'google_identity_invalid' using errcode='22023';
  end if;
  update private.teacher_invite_google_proofs p
  set google_sub=p_google_sub,google_email=v_email,verified_at=now()
  where p.state_hash=p_state_hash and p.state_consumed_at is not null
    and p.google_sub is null and p.expires_at > now() and p.claimed_at is null
  returning * into v_row;
  if not found then raise exception 'oauth_state_invalid' using errcode='22023'; end if;
  if exists (
    select 1 from private.teacher_google_identities i
    join public.profiles holder on holder.id=i.teacher_id
    where i.tenant_id=v_row.tenant_id and i.google_sub=p_google_sub
      and lower(coalesce(holder.lifecycle_status,''))='active'
  ) then raise exception 'google_identity_in_use' using errcode='23505'; end if;
  return jsonb_build_object('email',v_email);
end;
$function$;

create or replace function public.teacher_invite_google_status(p_offer_id uuid,p_proof_hash text)
returns jsonb language sql stable security definer set search_path = '' as $function$
  select jsonb_build_object('verified',p.verified_at is not null,
    'email',p.google_email,'expires_at',p.expires_at)
  from private.teacher_invite_google_proofs p
  join public.offers o on o.id=p.offer_id
  where p.offer_id=p_offer_id and p.proof_hash=p_proof_hash
    and p.expires_at>now() and p.claimed_at is null
    and o.kind='TEACHER_INVITE' and o.consumed_at is null and o.revoked_at is null
    and o.expires_at>now();
$function$;

create or replace function public.teacher_invite_google_claim(
  p_offer_id uuid,p_proof_hash text,p_claim_token uuid,p_teacher_id uuid
) returns text language plpgsql security definer set search_path = '' as $function$
declare v_row private.teacher_invite_google_proofs%rowtype;
  v_tenant text; v_holder uuid;
begin
  select * into v_row from private.teacher_invite_google_proofs p
  where p.offer_id=p_offer_id and p.proof_hash=p_proof_hash for update;
  select o.tenant_id into v_tenant from public.offers o
  where o.id=p_offer_id and o.kind='TEACHER_INVITE'
    and o.invite_claim_token=p_claim_token and o.consumed_at is null
    and o.revoked_at is null and o.expires_at>now();
  if v_row.proof_hash is null or v_row.verified_at is null
    or v_row.claimed_at is not null or v_row.expires_at<=now()
    or v_tenant is null or v_tenant<>v_row.tenant_id
    or not public.teacher_invite_google_required(p_offer_id)
    or not exists(select 1 from public.profiles p where p.id=p_teacher_id
      and p.tenant_id=v_tenant and p.role='TEACHER') then
    raise exception 'teacher_google_identity_required' using errcode='42501';
  end if;
  select i.teacher_id into v_holder from private.teacher_google_identities i
  join public.profiles holder on holder.id=i.teacher_id
  where i.tenant_id=v_tenant and i.google_sub=v_row.google_sub
    and lower(coalesce(holder.lifecycle_status,''))='active';
  if v_holder is not null and v_holder<>p_teacher_id then
    raise exception 'google_identity_in_use' using errcode='23505';
  end if;
  delete from private.teacher_google_identities i
  where i.tenant_id=v_tenant and i.google_sub=v_row.google_sub
    and i.teacher_id<>p_teacher_id;
  insert into private.teacher_google_identities
    (teacher_id,tenant_id,google_sub,google_email,email_verified,verified_at,updated_at)
  values (p_teacher_id,v_tenant,v_row.google_sub,v_row.google_email,true,now(),now());
  update private.teacher_invite_google_proofs p set claimed_at=now(),teacher_id=p_teacher_id
  where p.proof_hash=p_proof_hash;
  return v_row.google_email;
end;
$function$;

do $grants$
declare r record;
begin
  for r in select p.oid::regprocedure as signature
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'teacher_invite_google_%'
  loop
    execute format('alter function %s owner to postgres',r.signature);
    execute format('revoke all on function %s from public,anon,authenticated',r.signature);
    execute format('grant execute on function %s to service_role',r.signature);
  end loop;
end;
$grants$;
