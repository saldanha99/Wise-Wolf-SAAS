\set ON_ERROR_STOP on
BEGIN;
INSERT INTO public.tenants (id,name,slug,saas_status) VALUES ('test-per-lesson','test_fixture per lesson','test-per-lesson','active');
INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES ('00000000-0000-4000-8000-00000000ca81','authenticated','authenticated','per-lesson@example.invalid','{"provider":"email","providers":["email"],"test_fixture":true}','{"full_name":"test_fixture per lesson"}',now(),now());
UPDATE public.profiles SET tenant_id='test-per-lesson',role='TEACHER',hourly_rate=12.5 WHERE id='00000000-0000-4000-8000-00000000ca81';
INSERT INTO public.teacher_pay_tiers(tenant_id,min_students,rate) VALUES ('test-per-lesson',1,8) ON CONFLICT (tenant_id,min_students) DO UPDATE SET rate=8;
DO $$ BEGIN
 IF public.teacher_student_rate('00000000-0000-4000-8000-00000000ca81',null) <> 8 THEN RAISE EXCEPTION 'legacy tier changed'; END IF;
END $$;
INSERT INTO public.tenant_contract_records(tenant_id,user_id,contract_kind,party_snapshot,legal_snapshot,commercial_snapshot,signed_document_path,accepted_at,accepted_ip)
VALUES ('test-per-lesson','00000000-0000-4000-8000-00000000ca81','TEACHER','{"test_fixture":true}','{}','{"hourlyRate":12.5,"rateUnit":"PER_LESSON","test_fixture":true}','test-per-lesson/test_fixture.pdf',now(),'test_fixture');
DO $$ BEGIN
 IF public.teacher_student_rate('00000000-0000-4000-8000-00000000ca81',null) <> 12.5 THEN RAISE EXCEPTION 'custom lesson rate ignored'; END IF;
END $$;
UPDATE public.profiles SET hourly_rate=8 WHERE id='00000000-0000-4000-8000-00000000ca81';
DO $$ BEGIN
 IF public.teacher_student_rate('00000000-0000-4000-8000-00000000ca81',null) <> 8 THEN RAISE EXCEPTION 'lesson rate halved or doubled'; END IF;
END $$;
ROLLBACK;
