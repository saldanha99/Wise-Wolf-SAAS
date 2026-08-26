-- Provider payment identity must be globally unambiguous in the root account.

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
grant execute on function pg_temp.assert_true(boolean, text) TO anon, authenticated, service_role;

select pg_temp.assert_true(
  exists (
    select 1
      from pg_catalog.pg_indexes
     where schemaname = 'public'
       and tablename = 'student_payments'
       and indexname = 'student_payments_asaas_payment_id_uidx'
       and indexdef ilike 'create unique index%'
  ),
  'student payment provider identity is not unique'
);

select pg_temp.assert_true(
  not exists (
    select 1
      from public.student_payments
     where asaas_payment_id is not null
     group by asaas_payment_id
    having count(*) > 1
  ),
  'production data contains a duplicated provider payment id'
);

rollback;
