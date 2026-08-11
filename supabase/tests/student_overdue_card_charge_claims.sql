begin;

do $test$
begin
  if to_regclass('public.student_overdue_card_charge_claims') is null then
    raise exception 'student_overdue_card_charge_claims_missing';
  end if;

  if not exists (
    select 1
      from pg_class
     where oid = 'public.student_overdue_card_charge_claims'::regclass
       and relrowsecurity
       and relforcerowsecurity
  ) then
    raise exception 'student_overdue_card_charge_claims_rls_not_forced';
  end if;

  if has_table_privilege('anon', 'public.student_overdue_card_charge_claims', 'select')
     or has_table_privilege('authenticated', 'public.student_overdue_card_charge_claims', 'select')
     or has_table_privilege('authenticated', 'public.student_overdue_card_charge_claims', 'insert')
     or has_table_privilege('authenticated', 'public.student_overdue_card_charge_claims', 'update') then
    raise exception 'student_overdue_card_charge_claims_browser_privilege_present';
  end if;

  if not has_table_privilege(
    'service_role',
    'public.student_overdue_card_charge_claims',
    'select,insert,update'
  ) then
    raise exception 'student_overdue_card_charge_claims_service_privilege_missing';
  end if;

  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.student_overdue_card_charge_claims'::regclass
       and conname = 'student_overdue_card_charge_claims_pkey'
       and contype = 'p'
  ) then
    raise exception 'student_overdue_card_charge_claims_primary_key_missing';
  end if;

  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.student_overdue_card_charge_claims'::regclass
       and conname = 'student_overdue_card_charge_claims_payment_key'
       and contype = 'u'
  ) then
    raise exception 'student_overdue_card_charge_claims_unique_payment_missing';
  end if;
end
$test$;

rollback;
