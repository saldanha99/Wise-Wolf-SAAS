\set ON_ERROR_STOP on
begin;
do $test$
declare student uuid := gen_random_uuid(); start_day date; issued jsonb; offer private.student_course_renewal_offers%rowtype; expected date;
begin
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  insert into public.tenants(id,name,saas_status) values ('renewal-month-end-fixture','Month end fixture','active');
  insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data)
    values(student,'renewal-month-end@example.invalid','{"provider":"email"}','{"test_fixture":true}');
  perform set_config('app.enrollment_claim','1',true);
  update public.profiles set tenant_id='renewal-month-end-fixture',role='STUDENT',
    lifecycle_status='active',is_test_account=true,monthly_fee=377,class_frequency='5x',due_day=12,contract_accepted=true
    where id=student;
  perform set_config('app.enrollment_claim','',true);
  foreach start_day in array array[date '2030-01-29',date '2030-01-30',date '2030-01-31',date '2032-01-31'] loop
    issued := private.issue_student_course_renewal_offer(
      private.register_student_course_renewal_proposal('renewal-month-end-fixture',student,37700,5::smallint,12::smallint,
        'Fixture month end renewal',encode(extensions.gen_random_bytes(32),'hex')),
      start_day,start_day-1,'CREATE_NEW','cus_month_end_fixture',null,'PIX');
    select * into offer from private.student_course_renewal_offers where id=(issued->>'id')::uuid;
    expected := public.fim_do_servico(public.fim_do_servico(public.fim_do_servico(public.fim_do_servico(public.fim_do_servico(start_day)))));
    if offer.last_due_date is distinct from expected or offer.service_end_date is distinct from public.fim_do_servico(expected) then
      raise exception 'Legacy renewal month-end dates incorrect for %',start_day; end if;
    perform private.cancel_student_course_renewal_offer(offer.id,'Fixture cleanup inside rollback');
  end loop;
end;
$test$;
rollback;
