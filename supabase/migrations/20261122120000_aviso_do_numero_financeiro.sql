-- Aviso do número só do financeiro (22/11/2026, pedido da direção).
--
-- Toda cobrança da escola passou a sair pelo WhatsApp "Wise Wolf Financeiro".
-- O aluno vê UM pop-up explicando a troca, com a foto nova e o número. O
-- telefone nunca entra no repositório (público): vive nesta tabela privada,
-- preenchida na VPS. Sem linha = escola sem o aviso. "Já vi" usa a mesma
-- tabela das novidades (`feature_tour_views`), por usuário, vale em qualquer
-- aparelho.

create table if not exists private.finance_whatsapp_contacts (
  tenant_id text primary key references public.tenants(id) on delete cascade,
  phone text not null check (phone ~ '^55[0-9]{10,11}$'),
  display_name text not null default 'Wise Wolf Financeiro'
    check (length(btrim(display_name)) between 3 and 80),
  notice_starts_on date not null default ((now() at time zone 'America/Sao_Paulo')::date),
  notice_until date,
  created_at timestamptz not null default now(),
  check (notice_until is null or notice_until >= notice_starts_on)
);
alter table private.finance_whatsapp_contacts enable row level security;
revoke all on private.finance_whatsapp_contacts from public, anon, authenticated;

create or replace function public.my_finance_whatsapp_notice()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_tenant text := public._my_tenant_id();
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_notice constant text := 'aviso-2026-11-22-numero-financeiro';
  c record;
begin
  if v_uid is null or v_tenant is null or public._my_role() is distinct from 'STUDENT' then
    return null;
  end if;
  select f.phone, f.display_name into c from private.finance_whatsapp_contacts f
  where f.tenant_id = v_tenant and f.notice_starts_on <= v_today
    and (f.notice_until is null or f.notice_until >= v_today);
  if not found then return null; end if;
  if exists (select 1 from public.feature_tour_views v where v.user_id = v_uid and v.tour_id = v_notice) then
    return null;
  end if;
  return jsonb_build_object('notice_id', v_notice, 'phone', c.phone, 'display_name', c.display_name);
end $$;

alter function public.my_finance_whatsapp_notice() owner to postgres;
revoke all on function public.my_finance_whatsapp_notice() from public, anon, authenticated, service_role;
grant execute on function public.my_finance_whatsapp_notice() to authenticated;
