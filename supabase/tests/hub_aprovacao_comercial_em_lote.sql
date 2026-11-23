-- Hub: aprovação comercial em lote (migration 20261122250000).
\set ON_ERROR_STOP on
begin;
create or replace function pg_temp.assert_true(value boolean, message text)
returns void language plpgsql as $$
begin
  if not coalesce(value, false) then raise exception 'assertion failed: %', message; end if;
end;
$$;

-- Só usuário logado chama; anon nunca.
select pg_temp.assert_true(
  not has_function_privilege('anon', 'public.hub_pending_commercial_approvals()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.hub_approve_commercial_publications(uuid[])', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.hub_pending_commercial_approvals()', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.hub_approve_commercial_publications(uuid[])', 'EXECUTE'),
  'bulk approval grants');

-- Quem não é SUPER_ADMIN recebe 42501 nas duas.
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid()::text, 'role', 'authenticated')::text, true);
do $$
begin
  begin
    perform * from public.hub_pending_commercial_approvals();
    raise exception 'assertion failed: list accepted a non super admin';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.hub_approve_commercial_publications(array[gen_random_uuid()]);
    raise exception 'assertion failed: approve accepted a non super admin';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

-- A aprovação passa pelo gatilho de sempre e nunca aprova o que o próprio ator pediu.
select pg_temp.assert_true(
  pg_get_functiondef('public.hub_approve_commercial_publications(uuid[])'::regprocedure)
    like '%hub_publication_requested_by <> v_actor%'
  and pg_get_functiondef('public.hub_approve_commercial_publications(uuid[])'::regprocedure)
    like '%set hub_commercial_approved = true%'
  and pg_get_functiondef('public.hub_approve_commercial_publications(uuid[])'::regprocedure)
    not like '%hub_rights_verified_by =%',
  'approve must rely on the consent trigger to record the verifier');
select pg_temp.assert_true(
  exists (
    select 1 from pg_trigger
     where tgrelid = 'public.pedagogical_materials'::regclass
       and tgname = 'hub_b_guard_material_publication_consent'
       and not tgisinternal
  ),
  'consent trigger missing');
rollback;
