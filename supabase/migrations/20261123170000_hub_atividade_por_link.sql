-- Hub Fase 1 (23/11/2026): entrega por link/QR — o aluno abre a atividade sem cadastro.
--
-- O professor gera um link (token aleatório; o banco guarda só o sha256) para um material do
-- Educador IA. Quem abre o link vê a versão do ALUNO (gabarito retirado por
-- private.hub_strip_answer_keys), com o logo e o nome do professor; nada de conta, nome ou
-- dado de aluno. Link vale 30 dias e pode ser revogado. Tudo passa pela edge
-- `hub-material-share` (service_role): nenhuma função nova fica exposta a anon.
-- Aditiva. Desfazer: drop function public.hub_material_share_create(uuid, uuid, text),
-- public.hub_material_share_view(text), public.hub_material_share_revoke(uuid, uuid);
-- drop table public.hub_material_share_links;

create table if not exists public.hub_material_share_links (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.hub_accounts (id) on delete cascade,
  material_id uuid not null references public.hub_educator_materials (id) on delete cascade,
  created_by uuid not null references auth.users (id),
  token_sha256 text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  revoked_at timestamptz,
  view_count integer not null default 0,
  last_viewed_at timestamptz
);
create index if not exists hub_material_share_links_material_idx
  on public.hub_material_share_links (material_id) where revoked_at is null;

alter table public.hub_material_share_links enable row level security;
revoke all on table public.hub_material_share_links from public, anon, authenticated;
grant all on table public.hub_material_share_links to service_role;

-- Cria o link: só o autor do material ou quem administra a conta, com o Educador IA liberado.
create or replace function public.hub_material_share_create(
  p_user_id uuid,
  p_material_id uuid,
  p_token_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_material public.hub_educator_materials%rowtype;
  v_link public.hub_material_share_links%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_token_sha256 is null or p_token_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_token' using errcode = '22023';
  end if;
  select * into v_material from public.hub_educator_materials where id = p_material_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'MATERIAL_NOT_FOUND');
  end if;
  if not private.hub_user_has_educator_planner_access(v_material.account_id, p_user_id) then
    return jsonb_build_object('ok', false, 'code', 'SUBSCRIPTION_REQUIRED');
  end if;
  if v_material.created_by <> p_user_id and not exists (
    select 1 from public.hub_memberships m
     where m.account_id = v_material.account_id and m.user_id = p_user_id
       and m.status = 'ACTIVE' and m.membership_role in ('OWNER', 'ADMIN')
  ) then
    return jsonb_build_object('ok', false, 'code', 'MATERIAL_ACCESS_DENIED');
  end if;
  -- Teto simples contra abuso: 30 links vivos por material.
  if (select count(*) from public.hub_material_share_links
       where material_id = p_material_id and revoked_at is null and expires_at > now()) >= 30 then
    return jsonb_build_object('ok', false, 'code', 'SHARE_LIMIT_REACHED');
  end if;
  insert into public.hub_material_share_links (account_id, material_id, created_by, token_sha256)
  values (v_material.account_id, v_material.id, p_user_id, p_token_sha256)
  returning * into v_link;
  return jsonb_build_object('ok', true, 'linkId', v_link.id, 'expiresAt', v_link.expires_at);
end;
$$;

-- Abre o link: versão do aluno (sem gabarito) + logo/nome do professor. Conta a visita.
create or replace function public.hub_material_share_view(p_token_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link public.hub_material_share_links%rowtype;
  v_material public.hub_educator_materials%rowtype;
  v_branding public.hub_account_branding%rowtype;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_token_sha256 is null or p_token_sha256 !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'code', 'LINK_INVALID');
  end if;
  select * into v_link from public.hub_material_share_links where token_sha256 = p_token_sha256;
  if not found or v_link.revoked_at is not null then
    return jsonb_build_object('ok', false, 'code', 'LINK_INVALID');
  end if;
  if v_link.expires_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'LINK_EXPIRED');
  end if;
  select * into v_material from public.hub_educator_materials where id = v_link.material_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'LINK_INVALID');
  end if;
  update public.hub_material_share_links
     set view_count = view_count + 1, last_viewed_at = now()
   where id = v_link.id;
  select * into v_branding from public.hub_account_branding where account_id = v_link.account_id;
  return jsonb_build_object(
    'ok', true,
    'material', jsonb_build_object(
      'id', v_material.id,
      'kind', v_material.kind,
      'niche', v_material.niche,
      'level_tag', v_material.level_tag,
      'topic', v_material.topic,
      'goal', v_material.goal,
      'audience', v_material.audience,
      'title', v_material.title,
      'material', private.hub_strip_answer_keys(v_material.material),
      'dropped_items', 0,
      'created_at', v_material.created_at
    ),
    'branding', case when v_branding.account_id is null then null else jsonb_build_object(
      'logo_data_url', v_branding.logo_data_url,
      'display_name', v_branding.display_name
    ) end,
    'expiresAt', v_link.expires_at
  );
end;
$$;

-- Revoga todos os links vivos de um material (autor ou quem administra a conta).
create or replace function public.hub_material_share_revoke(p_user_id uuid, p_material_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_material public.hub_educator_materials%rowtype;
  v_count integer;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  select * into v_material from public.hub_educator_materials where id = p_material_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'MATERIAL_NOT_FOUND');
  end if;
  if v_material.created_by <> p_user_id and not exists (
    select 1 from public.hub_memberships m
     where m.account_id = v_material.account_id and m.user_id = p_user_id
       and m.status = 'ACTIVE' and m.membership_role in ('OWNER', 'ADMIN')
  ) then
    return jsonb_build_object('ok', false, 'code', 'MATERIAL_ACCESS_DENIED');
  end if;
  update public.hub_material_share_links set revoked_at = now()
   where material_id = p_material_id and revoked_at is null;
  get diagnostics v_count = row_count;
  return jsonb_build_object('ok', true, 'revoked', v_count);
end;
$$;

revoke all on function public.hub_material_share_create(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.hub_material_share_view(text) from public, anon, authenticated;
revoke all on function public.hub_material_share_revoke(uuid, uuid) from public, anon, authenticated;
grant execute on function public.hub_material_share_create(uuid, uuid, text) to service_role;
grant execute on function public.hub_material_share_view(text) to service_role;
grant execute on function public.hub_material_share_revoke(uuid, uuid) to service_role;
