begin;

-- The frontend includes this protected fixture marker in the authenticated
-- profile projection. Column-level privileges are already used on profiles,
-- so a new column does not inherit SELECT automatically.
grant select (is_test_account)
  on table public.profiles
  to authenticated;

commit;
