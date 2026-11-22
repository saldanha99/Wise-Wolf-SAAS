-- Hub: aprovação comercial em lote pelo SUPER_ADMIN (22/11/2026, decisão do Vinícius).
--
-- O SUPER_ADMIN vive no tenant da plataforma e só vê o SuperAdminDashboard, então nunca
-- alcançava a Biblioteca da escola nem passava na RLS de UPDATE de pedagogical_materials
-- (tenant_id = _my_tenant_id()). Estas duas RPCs são a porta dele:
--   * hub_pending_commercial_approvals(): lista o que o diretor já pediu (opt-in, direitos,
--     prévia separada) e ainda espera a aprovação comercial;
--   * hub_approve_commercial_publications(ids): aprova SÓ os ids escolhidos que continuam
--     pendentes. A gravação é a mesma da tela individual (hub_commercial_approved = true):
--     o gatilho hub_b_guard_material_publication_consent grava hub_rights_verified_by =
--     auth.uid() (quem clicou) e recusa quem pediu a própria publicação.
-- Aditiva: nenhuma tabela, coluna ou função existente muda.

create or replace function public.hub_pending_commercial_approvals()
returns table (
  material_id uuid,
  title text,
  level_tag text,
  niche text,
  tenant_id text,
  tenant_name text,
  requested_at timestamptz,
  rights_basis text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not coalesce(public.is_super_admin(), false) then
    raise exception 'hub_bulk_approval_requires_super_admin' using errcode = '42501';
  end if;

  return query
    select m.id, m.title, m.level_tag, m.niche, m.tenant_id, t.name,
           m.hub_publication_requested_at, m.hub_rights_basis
      from public.pedagogical_materials m
      left join public.tenants t on t.id = m.tenant_id
     where m.hub_catalog_opt_in is true
       and coalesce(m.hub_commercial_approved, false) is false
       and m.approval_status = 'APPROVED'
       and upper(coalesce(m.type, '')) = 'PDF'
       and m.storage_object_path is not null
       and m.hub_preview_source_path is not null
       and m.hub_preview_source_path <> m.storage_object_path
       and m.hub_rights_basis in ('OWNED', 'LICENSED', 'PUBLIC_DOMAIN')
       and m.hub_publication_requested_by is not null
       and m.hub_publication_requested_by <> (select auth.uid())
     order by t.name nulls last, m.level_tag nulls last, m.title;
end;
$$;

create or replace function public.hub_approve_commercial_publications(p_material_ids uuid[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_requested int := coalesce(pg_catalog.cardinality(p_material_ids), 0);
  v_approved uuid[];
begin
  if v_actor is null or not coalesce(public.is_super_admin(), false) then
    raise exception 'hub_bulk_approval_requires_super_admin' using errcode = '42501';
  end if;
  if v_requested = 0 then
    return jsonb_build_object('ok', true, 'requested', 0, 'approved', '[]'::jsonb, 'skipped', 0);
  end if;
  if v_requested > 200 then
    raise exception 'hub_bulk_approval_too_many' using errcode = '22023';
  end if;

  with done as (
    update public.pedagogical_materials m
       set hub_commercial_approved = true
     where m.id = any (p_material_ids)
       and m.hub_catalog_opt_in is true
       and coalesce(m.hub_commercial_approved, false) is false
       and m.approval_status = 'APPROVED'
       and m.hub_preview_source_path is not null
       and m.hub_publication_requested_by is not null
       and m.hub_publication_requested_by <> v_actor
    returning m.id
  )
  select coalesce(array_agg(id), '{}') into v_approved from done;

  return jsonb_build_object(
    'ok', true,
    'requested', v_requested,
    'approved', to_jsonb(v_approved),
    'skipped', v_requested - pg_catalog.cardinality(v_approved)
  );
end;
$$;

revoke all on function public.hub_pending_commercial_approvals() from public, anon;
revoke all on function public.hub_approve_commercial_publications(uuid[]) from public, anon;
grant execute on function public.hub_pending_commercial_approvals() to authenticated;
grant execute on function public.hub_approve_commercial_publications(uuid[]) to authenticated;

comment on function public.hub_approve_commercial_publications(uuid[]) is
  'SUPER_ADMIN aprova em lote publicações do Hub já pedidas pelo diretor. O gatilho grava hub_rights_verified_by = auth.uid().';
