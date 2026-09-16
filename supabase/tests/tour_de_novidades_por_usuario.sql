-- feature_tour_views: cada pessoa marca só o próprio "já vi".

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(value, false) then
    raise exception 'assertion failed: %', message;
  end if;
end;
$$;
grant execute on function pg_temp.assert_true(boolean, text) to anon, authenticated, service_role;

select pg_temp.assert_true(
  (select relrowsecurity from pg_catalog.pg_class where oid = 'public.feature_tour_views'::regclass),
  'feature_tour_views sem RLS'
);

select pg_temp.assert_true(
  exists (
    select 1 from pg_catalog.pg_policies
     where schemaname = 'public' and tablename = 'feature_tour_views'
       and policyname = 'feature_tour_views_own'
       and with_check is not null
  ),
  'policy feature_tour_views_own ausente ou sem with check'
);

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-4000-8000-000000000911', 'authenticated', 'authenticated',
   'tour-novidade-a@example.invalid', '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('00000000-0000-4000-8000-000000000912', 'authenticated', 'authenticated',
   'tour-novidade-b@example.invalid', '{"provider":"email","providers":["email"]}', '{}', now(), now());

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-000000000911","role":"authenticated"}';

-- Marca o próprio.
insert into public.feature_tour_views (user_id, tour_id)
values ('00000000-0000-4000-8000-000000000911', '2026-09-16-menu-no-topo');

-- Marcar de novo (dois aparelhos) não pode falhar: upsert pela chave.
insert into public.feature_tour_views (user_id, tour_id)
values ('00000000-0000-4000-8000-000000000911', '2026-09-16-menu-no-topo')
on conflict (user_id, tour_id) do nothing;

select pg_temp.assert_true(
  (select count(*) from public.feature_tour_views) = 1,
  'usuário A deveria enxergar exatamente a própria linha'
);

-- Em nome de outro: barrado pelo with check.
do $$
begin
  insert into public.feature_tour_views (user_id, tour_id)
  values ('00000000-0000-4000-8000-000000000912', '2026-09-16-menu-no-topo');
  raise exception 'gravou "já vi" em nome de outro usuário';
exception
  when insufficient_privilege then null;
end;
$$;

-- Usuário B não vê a linha de A.
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-000000000912","role":"authenticated"}';
select pg_temp.assert_true(
  (select count(*) from public.feature_tour_views) = 0,
  'usuário B enxergou linha de A'
);

rollback;
