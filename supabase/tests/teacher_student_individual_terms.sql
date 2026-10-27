\set ON_ERROR_STOP on
begin;
create or replace function pg_temp.term_assert(v boolean,m text) returns void language plpgsql as $$begin if not coalesce(v,false) then raise exception 'individual term: %',m;end if;end$$;
do $test$
declare tenant text:='individual-term-fixture-'||gen_random_uuid();teacher uuid:=gen_random_uuid();student uuid:=gen_random_uuid();director uuid:=gen_random_uuid();coordinator uuid:=gen_random_uuid();other_teacher uuid:=gen_random_uuid();unsigned_teacher uuid:=gen_random_uuid();other_student uuid:=gen_random_uuid();term uuid;term2 uuid;source uuid:=gen_random_uuid();booking uuid:=gen_random_uuid();r jsonb;old_hash text;old_body text;offer uuid;enrollment_term uuid;new_term uuid;coverage_term uuid;coverage uuid:=gen_random_uuid();absence uuid:=gen_random_uuid();request uuid:=gen_random_uuid();original_eligibility text;signature text;today date:=(now() at time zone 'America/Sao_Paulo')::date;coverage_date date:=today+14+((5-extract(dow from today+14)::int+7)%7);change_booking uuid;staged_term uuid;transfer_result jsonb;identity jsonb:='{"companyName":"Empresa Fixture Ltda","cnpj":"12.ABC.345/01DE-35","companyAddress":"Rua Fixture, 1","representativeCpf":"52998224725","representativeHasAuthority":true}';
begin
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 perform pg_temp.term_assert(not has_function_privilege('anon','public.teacher_student_terms(text,uuid,jsonb)','EXECUTE'),'anonymous signature API');
 perform pg_temp.term_assert(not has_function_privilege('authenticated','public.enrollment_teacher_terms_ready(uuid,uuid)','EXECUTE'),'browser completion API');
 perform pg_temp.term_assert(not has_table_privilege('authenticated','private.teacher_student_terms','SELECT'),'raw terms exposed');
 insert into public.tenants(id,name,slug,saas_status,school_info) values(tenant,'Individual term fixture',tenant,'active',jsonb_build_object('legalName','Escola Fixture Ltda','cnpj','11222333000181','address','Rua Fixture, 1','email','legal@example.invalid','phone','5511999999999','city','Cidade Fixture','state','SP','legalRepresentativeName','Diretor Fixture','legalRepresentativeSignaturePath',tenant||'/legal-representative-signature/00000000-0000-4000-8000-000000000001.png'));
 insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) select id,id||'@example.invalid','{"provider":"email"}','{"test_fixture":true}' from unnest(array[teacher,student,director,coordinator,other_teacher,other_student]) f(id);
 update public.profiles set tenant_id=tenant,full_name=case id when teacher then 'Professor Fixture' when student then 'Aluno Fixture' when director then 'Diretor Fixture' when coordinator then 'Coordenador Fixture' else 'Outro Fixture' end,role=case when id in(teacher,other_teacher) then 'TEACHER' when id=director then 'SCHOOL_ADMIN' when id=coordinator then 'COORDINATOR' else 'STUDENT' end,is_test_account=true,phone=null,status='Ativo',lifecycle_status='active',contract_accepted=(id<>other_student),hourly_rate=8 where id=any(array[teacher,student,director,coordinator,other_teacher,other_student]);
 insert into public.tenant_memberships(user_id,tenant_id,role,status,is_primary) select id,tenant_id,role,'ACTIVE',true from public.profiles where tenant_id=tenant on conflict(user_id,tenant_id) do update set role=excluded.role,status='ACTIVE';
 insert into public.tenant_user_contexts(user_id,tenant_id) select id,tenant_id from public.profiles where tenant_id=tenant on conflict(user_id) do update set tenant_id=excluded.tenant_id;
 -- Nenhuma fixture pode receber mensagens. O teste substitui só a decisão de
 -- elegibilidade dentro desta transação invisível aos workers e a restaura.
 perform pg_temp.term_assert(not public.teacher_opportunity_recipient_eligible(tenant,teacher),'fixture messaging exclusion missing');
 original_eligibility:=pg_get_functiondef('public.teacher_opportunity_recipient_eligible(text,uuid)'::regprocedure);
 execute $stub$create or replace function public.teacher_opportunity_recipient_eligible(p_tenant text,p_teacher uuid) returns boolean language sql stable security definer set search_path='' as $body$ select exists(select 1 from public.profiles p join public.tenant_memberships m on m.user_id=p.id and m.tenant_id=p.tenant_id and m.status='ACTIVE' and m.role='TEACHER' where p.id=p_teacher and p.tenant_id=p_tenant and p.role='TEACHER' and p.lifecycle_status='active' and p.status='Ativo') $body$ $stub$;
 insert into private.teacher_student_term_policy(tenant_id,enabled) values(tenant,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',director,'role','authenticated')::text,true);
 r:=public.teacher_student_terms('prepare',source,jsonb_build_object('student_id',student,'teacher_id',teacher,'mode','RECURRING','starts_on',today+3,'slots','[{"day":1,"time":"18:00"},{"day":1,"time":"18:30"}]'::jsonb));term:=(r->>'id')::uuid;
 perform pg_temp.term_assert(term is not null,'manual proposal missing');
 perform pg_temp.term_assert((select provider_identity is null and school_signed_at is null and teacher_signed_at is null from private.teacher_student_terms where id=term),'invented signature or company');
 begin insert into public.bookings(tenant_id,teacher_id,student_id,day_of_week,time_slot,start_date) values(tenant,teacher,student,'Segunda','18:00',today+3);raise exception 'unsigned booking accepted';exception when sqlstate 'PT412' then null;end;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',teacher,'role','authenticated')::text,true);
 r:=public.teacher_student_terms('identity',null,identity);
 select content_hash,body into old_hash,old_body from private.teacher_student_terms where id=term;
 perform pg_temp.term_assert(old_hash=encode(extensions.digest(old_body,'sha256'),'hex') and position('Empresa Fixture Ltda' in old_body)>0,'content hash or company wrong');
 begin perform public.teacher_student_terms('sign',term,jsonb_build_object('content_hash',old_hash,'typed_name','Professor Fixture','accepted',true,'has_authority',true));raise exception 'teacher signed before school';exception when raise_exception then if sqlerrm='teacher signed before school' then raise;end if;end;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',coordinator,'role','authenticated')::text,true);
 begin perform public.teacher_student_terms('sign',term,jsonb_build_object('content_hash',old_hash,'typed_name','Coordenador Fixture','accepted',true,'has_authority',true));raise exception 'coordinator signed for school';exception when insufficient_privilege then null;end;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',director,'role','authenticated')::text,true);
 r:=public.teacher_student_terms('sign',term,jsonb_build_object('content_hash',old_hash,'typed_name','Diretor Fixture','accepted',true,'has_authority',true));
 perform pg_temp.term_assert(r->>'ok'='true','school signature failed');
 begin update private.teacher_student_terms set body='changed' where id=term;raise exception 'signed content changed';exception when raise_exception then if sqlerrm='signed content changed' then raise;end if;end;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',other_teacher,'role','authenticated')::text,true);
 begin perform public.teacher_student_terms('sign',term,jsonb_build_object('content_hash',old_hash,'typed_name','Outro Fixture','accepted',true,'has_authority',true));raise exception 'other teacher signed';exception when insufficient_privilege then null;end;
 r:=public.teacher_student_terms('list');perform pg_temp.term_assert(jsonb_array_length(r->'terms')=0,'other teacher read confidential terms');
 perform set_config('request.jwt.claims',jsonb_build_object('sub',teacher,'role','authenticated')::text,true);
 begin perform public.teacher_student_terms('sign',term,jsonb_build_object('content_hash',repeat('0',64),'typed_name','Professor Fixture','accepted',true,'has_authority',true));raise exception 'wrong version signed';exception when raise_exception then if sqlerrm='wrong version signed' then raise;end if;end;
 r:=public.teacher_student_terms('sign',term,jsonb_build_object('content_hash',old_hash,'typed_name','Professor Fixture','accepted',true,'has_authority',true));
 perform pg_temp.term_assert(r->>'phase'='FAMILY_PENDING','family confirmation inferred');
 r:=public.teacher_student_terms('sign',term,jsonb_build_object('content_hash',old_hash,'typed_name','Professor Fixture','accepted',true,'has_authority',true));perform pg_temp.term_assert(r->>'already'='true','signature replay not idempotent');
 perform set_config('request.jwt.claims',jsonb_build_object('sub',student,'role','authenticated')::text,true);
 r:=public.teacher_student_terms('list');
 perform pg_temp.term_assert(not((r->'terms'->0)?'unit_rate') and not((r->'terms'->0)?'body') and not((r->'terms'->0)?'provider_identity'),'family saw remuneration or professional identity');
 r:=public.teacher_student_terms('family_confirm',term,jsonb_build_object('confirmed',true,'schedule_hash',r->'terms'->0->>'schedule_hash'));
 perform pg_temp.term_assert((select status='EXECUTED' and body=old_body and content_hash=old_hash from private.teacher_student_terms where id=term),'family changed signed document');
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 insert into public.bookings(id,tenant_id,teacher_id,student_id,day_of_week,time_slot,start_date) values(booking,tenant,teacher,student,'Segunda','18:00',today+3);
 perform pg_temp.term_assert(exists(select 1 from private.teacher_student_term_bindings where entity_table='bookings' and entity_id=booking and term_id=term),'booking not bound to signatures');
 begin insert into public.bookings(tenant_id,teacher_id,student_id,day_of_week,time_slot,start_date) values(tenant,teacher,student,'Terça','18:00',today+3);raise exception 'different agenda reused signature';exception when sqlstate 'PT412' then null;end;
 insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values(unsigned_teacher,unsigned_teacher||'@example.invalid','{"provider":"email"}','{"test_fixture":true}');
 update public.profiles set tenant_id=tenant,full_name='Sem Contrato Fixture',role='TEACHER',is_test_account=true,phone=null,status='Ativo',lifecycle_status='active',contract_accepted=false where id=unsigned_teacher;
 insert into public.tenant_memberships(user_id,tenant_id,role,status,is_primary) values(unsigned_teacher,tenant,'TEACHER','ACTIVE',true) on conflict(user_id,tenant_id) do update set role='TEACHER',status='ACTIVE';
 -- Reposição por substituto COM contrato geral é cobertura pontual (dispensada,
 -- reposicao_por_substituto_sem_termo.sql); sem contrato geral continua barrada.
 begin insert into public.reschedules(tenant_id,teacher_id,student_id,date,time) values(tenant,unsigned_teacher,student,(today+4)::text,'19:00');raise exception 'replacement teacher bypassed signature';exception when sqlstate 'PT412' then null;end;
 update public.bookings set status='CANCELLED' where id=booking;
 perform pg_temp.term_assert((select retired_at is not null from private.teacher_student_terms where id=term),'closed binding reusable');
 begin insert into public.bookings(tenant_id,teacher_id,student_id,day_of_week,time_slot,start_date) values(tenant,teacher,student,'Segunda','18:00',today+3);raise exception 'closed term reused';exception when sqlstate 'PT412' then null;end;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',director,'role','authenticated')::text,true);
 r:=public.teacher_student_terms('prepare',gen_random_uuid(),jsonb_build_object('student_id',other_student,'teacher_id',teacher,'mode','DATED','starts_on',today+5,'ends_on',today+5,'slots',jsonb_build_array(jsonb_build_object('date',today+5,'time','20:00'))));term2:=(r->>'id')::uuid;
 perform pg_temp.term_assert(term2 is not null and term2<>term,'second student copied original term');
 update public.profiles set lifecycle_status='suspended' where id=teacher;
 select content_hash into old_hash from private.teacher_student_terms where id=term2;
 begin perform public.teacher_student_terms('sign',term2,jsonb_build_object('content_hash',old_hash,'typed_name','Diretor Fixture','accepted',true,'has_authority',true));raise exception 'inactive teacher assignment allowed';exception when raise_exception then if sqlerrm='inactive teacher assignment allowed' then raise;end if;end;

 -- Matrícula real pelo fluxo público, somente em fixtures transacionais. Não
 -- há customer, cobrança, e-mail ou WhatsApp de provedor nesta suíte.
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 update public.profiles set lifecycle_status='active' where id=teacher;
 insert into public.tenant_contract_terms(tenant_id,contract_kind,terms_version) values(tenant,'STUDENT',2);
 update public.profiles set role='SUPER_ADMIN' where id=director;
 insert into public.teacher_availability(tenant_id,teacher_id,day_of_week,start_time,end_time) values(tenant,teacher,5,'19:00','20:00'),(tenant,teacher,6,'19:00','20:00');
 perform set_config('request.jwt.claims',jsonb_build_object('sub',director,'role','authenticated')::text,true);
 offer:=public.create_enrollment_offer(jsonb_build_object('unitId',tenant,'value',160,'dueDay',10,'planDuration',1,'classesPerWeek',2,'requiresEnrollment',false,'enrollmentFee',0,'startDate',to_char(today+14,'YYYY-MM-DD'),'billingStartMonth',to_char(today+45,'YYYY-MM'),'enableProRata',false,'testMode',true,'test_fixture','individual-terms','schedule',jsonb_build_array(jsonb_build_object('day','Friday','time','19:00','teacherId',teacher),jsonb_build_object('day','Saturday','time','19:00','teacherId',teacher))));
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 update public.profiles set role='SCHOOL_ADMIN' where id=director;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',other_student,'role','authenticated')::text,true);
 r:=public.begin_enrollment_offer(offer,jsonb_build_object('full_name','Aluno Novo Fixture','phone','11988887777','cpf','52998224725','typed_signature','Aluno Novo Fixture','billing_type','PIX'));
 perform pg_temp.term_assert(r->>'success'='true','enrollment begin blocked before proposal: '||r::text);
 r:=public.record_enrollment_contract_terms(offer,2);
 perform pg_temp.term_assert(r->>'ok'='true','student contract recording failed: '||r::text);
 select id into enrollment_term from private.teacher_student_terms where source_id=offer and teacher_id=teacher and status='PROPOSED';
 perform pg_temp.term_assert(enrollment_term is not null,'begin did not prepare exact enrollment term');
 perform pg_temp.term_assert((select family_confirmation->>'kind'='ENROLLMENT_CONTRACT' from private.teacher_student_terms where id=enrollment_term),'family contract not referenced separately');
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 perform pg_temp.term_assert(not public.student_billing_teacher_terms_ready(tenant,other_student),'billing accepted unsigned enrollment');
 r:=public.materialize_enrollment_offer_schedule(offer,other_student);
 perform pg_temp.term_assert(r->>'error'='TEACHER_TERM_PENDING','unsigned enrollment materialized: '||r::text);
 select content_hash into old_hash from private.teacher_student_terms where id=enrollment_term;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',director,'role','authenticated')::text,true);
 r:=public.teacher_student_terms('sign',enrollment_term,jsonb_build_object('content_hash',old_hash,'typed_name','Diretor Fixture','accepted',true,'has_authority',true));
 perform set_config('request.jwt.claims',jsonb_build_object('sub',teacher,'role','authenticated')::text,true);
 r:=public.teacher_student_terms('sign',enrollment_term,jsonb_build_object('content_hash',old_hash,'typed_name','Professor Fixture','accepted',true,'has_authority',true));
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 perform pg_temp.term_assert(public.student_billing_teacher_terms_ready(tenant,other_student),'signed enrollment still blocked');
 r:=public.materialize_enrollment_offer_schedule(offer,other_student);
 perform pg_temp.term_assert(r->>'success'='true' and r->>'booking_count'='2','signed enrollment failed to materialize: '||r::text);
 perform pg_temp.term_assert((select count(*)=2 from private.teacher_student_term_bindings where term_id=enrollment_term and entity_table='bookings'),'enrollment did not bind each duration unit');
 -- Uma reserva da matrícula e uma atualização repetida não substituem a via.
 r:=public.materialize_enrollment_offer_schedule(offer,other_student);
 perform pg_temp.term_assert(r->>'idempotent'='true','enrollment re-run duplicated duration units');
 -- Escritores diretos de cobertura, versões de agenda e ficha não contornam
 -- o requisito, mesmo quando chamados com service_role.
 begin update public.profiles set professor_id=other_teacher where id=student;raise exception 'profile assignment bypassed term';exception when sqlstate 'PT412' then null;end;
 begin insert into public.booking_schedule_versions(tenant_id,booking_id,valid_from,day_of_week,time_slot) select tenant,id,'2099-02-01','Segunda','20:00' from public.bookings where enrollment_offer_id=offer limit 1;raise exception 'versioned schedule bypassed term';exception when sqlstate 'PT412' then null;end;
 insert into public.teacher_availability(tenant_id,teacher_id,day_of_week,start_time,end_time) values(tenant,other_teacher,5,'19:00','20:00');
 insert into public.teacher_absences(id,tenant_id,teacher_id,starts_at,ends_at,reason,status) values(absence,tenant,teacher,coverage_date,coverage_date,'OTHER','ACTIVE');
 insert into public.class_coverages(id,tenant_id,original_teacher_id,cover_teacher_id,student_id,booking_id,absence_id,class_date,class_time,status,token,invite_expires_at) select coverage,tenant,teacher,other_teacher,other_student,id,absence,coverage_date,'19:00','pending',repeat('b',32),(coverage_date::text||'T22:00:00Z')::timestamptz from public.bookings where enrollment_offer_id=offer and day_of_week='Sexta' limit 1;
 -- Decisão de 27/10/2026: cobertura pontual de aluno atual, por professor com
 -- contrato geral aceito, dispensa termo; vale o contrato geral e o link de aceite.
 perform pg_temp.term_assert(not exists(select 1 from private.teacher_student_terms where source_kind='COVERAGE' and source_id=coverage),'pontual coverage of current student prepared a term');
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 r:=public.resolve_coverage_invite(repeat('b',32),true);
 perform pg_temp.term_assert(r->>'ok'='true','pontual coverage not confirmed: '||r::text);
 perform pg_temp.term_assert(not exists(select 1 from private.teacher_student_term_bindings where entity_table='class_coverages' and entity_id=coverage),'exempt coverage bound to a term');
 perform set_config('request.jwt.claims',jsonb_build_object('sub',other_teacher,'role','authenticated')::text,true);
 r:=public.teacher_student_terms('identity',null,identity);
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);

 -- A alteração direta vira proposta persistente, sem perder a grade atual.
 select id into change_booking from public.bookings where enrollment_offer_id=offer and day_of_week='Sexta';
 insert into public.teacher_availability(tenant_id,teacher_id,day_of_week,start_time,end_time) values(tenant,teacher,4,'20:00','21:00');
 perform set_config('request.jwt.claims',jsonb_build_object('sub',teacher,'role','authenticated')::text,true);
 r:=public.teacher_apply_student_schedule_change(other_student,jsonb_build_array(jsonb_build_object('booking_id',change_booking,'new_day','Quinta','new_time','20:00')),today+30,'Mudança de agenda fixture solicitada');
 perform pg_temp.term_assert(r->>'pending_terms'='true' and(select day_of_week='Sexta' from public.bookings where id=change_booking),'schedule proposal changed booking prematurely');
 staged_term:=(r->'term_ids'->>0)::uuid;
 select content_hash into old_hash from private.teacher_student_terms where id=staged_term;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',director,'role','authenticated')::text,true);
 r:=public.teacher_student_terms('sign',staged_term,jsonb_build_object('content_hash',old_hash,'typed_name','Diretor Fixture','accepted',true,'has_authority',true));
 perform set_config('request.jwt.claims',jsonb_build_object('sub',teacher,'role','authenticated')::text,true);
 r:=public.teacher_student_terms('sign',staged_term,jsonb_build_object('content_hash',old_hash,'typed_name','Professor Fixture','accepted',true,'has_authority',true));
 perform set_config('request.jwt.claims',jsonb_build_object('sub',other_student,'role','authenticated')::text,true);
 r:=public.teacher_student_terms('list');select value->>'schedule_hash' into old_hash from jsonb_array_elements(r->'terms') where value->>'id'=staged_term::text;
 r:=public.teacher_student_terms('family_confirm',staged_term,jsonb_build_object('confirmed',true,'schedule_hash',old_hash));
 perform set_config('request.jwt.claims',jsonb_build_object('sub',teacher,'role','authenticated')::text,true);
 r:=public.teacher_apply_student_schedule_change(other_student,jsonb_build_array(jsonb_build_object('booking_id',change_booking,'new_day','Quinta','new_time','20:00')),today+30,'Mudança de agenda fixture solicitada');
 perform pg_temp.term_assert(r->>'changed'='1' and(select day_of_week='Quinta' from public.bookings where id=change_booking),'signed schedule failed to apply: '||r::text);

 -- Transferência futura persiste pendente sem declarar o novo titular aceito.
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 insert into public.teacher_availability(tenant_id,teacher_id,day_of_week,start_time,end_time) values(tenant,other_teacher,6,'19:00','20:00');
 insert into public.teacher_transfers(id,tenant_id,student_id,from_teacher_id,to_teacher_id,proposed_slots,cutover_date,reason,status,created_by,token)
 values(request,tenant,other_student,teacher,other_teacher,'[{"day_of_week":"Sexta","time_slot":"19:30"},{"day_of_week":"Sábado","time_slot":"19:00"}]',today+60,'Transferência futura de fixture','ACCEPTED',director,'direct:'||source::text);
 perform pg_temp.term_assert((select status='PENDING' from public.teacher_transfers where id=request),'transfer assigned before manifestations');
 perform set_config('request.jwt.claims',jsonb_build_object('sub',director,'role','authenticated')::text,true);
 r:=public.admin_schedule_student_transfer(other_student,other_teacher,'[{"day_of_week":"Sexta","time_slot":"19:30"},{"day_of_week":"Sábado","time_slot":"19:00"}]',today+60,'Transferência futura de fixture',source);
 perform pg_temp.term_assert(r->>'pending_terms'='true' and r->>'idempotent'='true','transfer retry lost pending state');
 select id,content_hash into staged_term,old_hash from private.teacher_student_terms where source_kind='TRANSFER' and source_id=request;
 r:=public.teacher_student_terms('sign',staged_term,jsonb_build_object('content_hash',old_hash,'typed_name','Diretor Fixture','accepted',true,'has_authority',true));
 perform set_config('request.jwt.claims',jsonb_build_object('sub',other_teacher,'role','authenticated')::text,true);
 r:=public.teacher_student_terms('sign',staged_term,jsonb_build_object('content_hash',old_hash,'typed_name','Outro Fixture','accepted',true,'has_authority',true));
 perform set_config('request.jwt.claims',jsonb_build_object('sub',other_student,'role','authenticated')::text,true);
 r:=public.teacher_student_terms('list');select value->>'schedule_hash' into old_hash from jsonb_array_elements(r->'terms') where value->>'id'=staged_term::text;
 r:=public.teacher_student_terms('family_confirm',staged_term,jsonb_build_object('confirmed',true,'schedule_hash',old_hash));
 perform set_config('request.jwt.claims',jsonb_build_object('sub',director,'role','authenticated')::text,true);
 r:=public.teacher_student_terms('apply_transfer',staged_term);
 perform pg_temp.term_assert(r->>'ok'='true' and(select status='ACCEPTED' and applied_at is null from public.teacher_transfers where id=request) and(select professor_id=teacher from public.profiles where id=other_student),'future transfer applied too early or not accepted');
 -- Fonte retirada não autoriza novas atribuições mesmo com assinatura histórica.
 -- Reemissão exige justificativa e novos aceites; não copia assinaturas.
 perform set_config('request.jwt.claims',jsonb_build_object('sub',director,'role','authenticated')::text,true);
 r:=public.teacher_student_terms('reissue',term2,jsonb_build_object('reason','Revisão futura solicitada pela direção fixture'));
 new_term:=(r->>'id')::uuid;
 perform pg_temp.term_assert(new_term<>term2 and(select version=2 and school_signed_at is null and teacher_signed_at is null from private.teacher_student_terms where id=new_term),'new revision copied signature');
 perform pg_temp.term_assert((select status='REVOKED' from private.teacher_student_terms where id=term2),'previous proposal resurrected');
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 update public.offers set revoked_at=now() where id=offer;
 perform pg_temp.term_assert(not private.student_term_source_valid((select t from private.teacher_student_terms t where id=enrollment_term)),'revoked enrollment still authorized new assignments');
 execute original_eligibility;
 perform pg_temp.term_assert((select count(*)=2 from private.teacher_student_term_events where term_id=term and event in('SCHOOL_SIGNED','TEACHER_SIGNED')),'signature history missing or duplicated');
end;$test$;
rollback;
