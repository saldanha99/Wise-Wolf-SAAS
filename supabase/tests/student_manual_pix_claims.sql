begin;

do $test$
begin
  if to_regclass('public.student_manual_pix_issuances') is null then
    raise exception 'student_manual_pix_issuances_missing';
  end if;

  if not exists (
    select 1
      from pg_class
     where oid = 'public.student_manual_pix_issuances'::regclass
       and relrowsecurity
       and relforcerowsecurity
  ) then
    raise exception 'student_manual_pix_issuances_rls_not_forced';
  end if;

  if has_table_privilege('anon', 'public.student_manual_pix_issuances', 'select')
     or has_table_privilege('authenticated', 'public.student_manual_pix_issuances', 'select')
     or has_table_privilege('authenticated', 'public.student_manual_pix_issuances', 'insert')
     or has_table_privilege('authenticated', 'public.student_manual_pix_issuances', 'update') then
    raise exception 'student_manual_pix_issuances_browser_privilege_present';
  end if;

  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.student_manual_pix_issuances'::regclass
       and conname = 'student_manual_pix_issuances_student_due_key'
       and contype = 'u'
  ) then
    raise exception 'student_manual_pix_issuances_unique_claim_missing';
  end if;

  if not has_table_privilege(
    'service_role',
    'public.student_manual_pix_issuances',
    'select,insert,update'
  ) then
    raise exception 'student_manual_pix_issuances_service_privilege_missing';
  end if;
end
$test$;

rollback;
