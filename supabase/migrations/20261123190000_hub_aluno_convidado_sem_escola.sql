-- Hub Fase 1 (23/11/2026): o aluno convidado pelo professor conseguia entrar, mas o Wolfie e as
-- funções do Hub respondiam 403. Causa: o cadastro nasce STUDENT sem escola (tenant nulo) e o
-- aceite do convite não muda o papel; `authorizeRequest` só aceita conta sem escola quando ela é
-- NON_STUDENT (o claim do professor já faz essa troca, o aceite do convite não fazia).
-- Agora: ao virar membro ATIVO de uma conta do Hub, perfil STUDENT sem escola passa a NON_STUDENT
-- (mesmo caminho do claim). Aluno de escola (tenant preenchido) não muda. Corrige os que existem.
-- Aditiva. Desfazer: drop trigger hub_memberships_promote_tenantless on public.hub_memberships;
-- drop function private.hub_promote_tenantless_member();
create or replace function private.hub_promote_tenantless_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'ACTIVE' then
    perform pg_catalog.set_config('app.enrollment_claim', '1', true);
    update public.profiles as profile
       set role = 'NON_STUDENT'
     where profile.id = new.user_id
       and profile.role = 'STUDENT'
       and profile.tenant_id is null;
  end if;
  return new;
end;
$$;
revoke all on function private.hub_promote_tenantless_member() from public, anon, authenticated;

drop trigger if exists hub_memberships_promote_tenantless on public.hub_memberships;
create trigger hub_memberships_promote_tenantless
after insert or update of status on public.hub_memberships
for each row execute function private.hub_promote_tenantless_member();

-- Correção dos que já entraram por convite (1 em 23/11).
do $fix$
begin
  perform pg_catalog.set_config('app.enrollment_claim', '1', true);
  update public.profiles as profile
     set role = 'NON_STUDENT'
   where profile.role = 'STUDENT'
     and profile.tenant_id is null
     and exists (
       select 1 from public.hub_memberships m
        where m.user_id = profile.id and m.status = 'ACTIVE'
     );
end;
$fix$;
