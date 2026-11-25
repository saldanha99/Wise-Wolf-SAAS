-- Hub Fase 1 (23/11/2026): logo do professor nos materiais exportados (impressão/PDF e Word).
-- Uma linha por conta do Hub; a imagem fica como data URL pequena (o navegador reduz para no
-- máximo 400 px antes de salvar), sem bucket novo. Só OWNER/ADMIN da conta grava; quem usa o
-- Educador IA da conta lê. Aditiva. Desfazer: drop table public.hub_account_branding;
create table if not exists public.hub_account_branding (
  account_id uuid primary key references public.hub_accounts (id) on delete cascade,
  logo_data_url text,
  display_name text,
  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now(),
  constraint hub_account_branding_logo_check check (
    logo_data_url is null
    or (logo_data_url ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$'
        and char_length(logo_data_url) <= 400000)
  ),
  constraint hub_account_branding_name_check check (
    display_name is null or char_length(display_name) between 1 and 120
  )
);

alter table public.hub_account_branding enable row level security;
revoke all on table public.hub_account_branding from public, anon, authenticated;
grant select, insert, update, delete on table public.hub_account_branding to authenticated;
grant all on table public.hub_account_branding to service_role;

drop policy if exists hub_account_branding_select on public.hub_account_branding;
create policy hub_account_branding_select on public.hub_account_branding
for select to authenticated
using (
  (select private.hub_is_account_manager(account_id))
  or (select private.hub_has_educator_planner_access(account_id))
);

drop policy if exists hub_account_branding_write on public.hub_account_branding;
create policy hub_account_branding_write on public.hub_account_branding
for all to authenticated
using ((select private.hub_is_account_manager(account_id)))
with check (
  (select private.hub_is_account_manager(account_id))
  and updated_by = (select auth.uid())
);
