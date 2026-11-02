\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.quality_assert(p_ok boolean,p_message text)
returns void language plpgsql as $$ begin if not coalesce(p_ok,false) then raise exception 'quality assertion: %',p_message; end if; end; $$;
grant execute on function pg_temp.quality_assert(boolean,text) to public;

do $test$
declare
 teacher_id uuid:=extensions.gen_random_uuid(); student_id uuid:=extensions.gen_random_uuid();
 sibling_id uuid:=extensions.gen_random_uuid(); admin_id uuid:=extensions.gen_random_uuid(); outsider_id uuid:=extensions.gen_random_uuid();
 booking_id uuid:=extensions.gen_random_uuid(); conflict_booking uuid:=extensions.gen_random_uuid(); contact_request uuid; contact_id uuid; change_id uuid; change_two uuid; change_three uuid;
 token_one text; token_two text; result jsonb; snapshot jsonb; blocked boolean; notification_id uuid; original_message text;
 today date:=(now() at time zone 'America/Sao_Paulo')::date;
 monday date; old_date date; new_date date;
begin
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 monday:=today+21+((8-extract(dow from today+21)::integer)%7);
 insert into public.tenants(id,name) values('quality-contact-fixture','Quality Contact Fixture'),('quality-other-fixture','Quality Other Fixture');
 -- Mudança feita por professor avisa o grupo de Coordenação desde a migration
 -- 20260922024045; sem canal configurado a gravação é recusada. As escolas do
 -- teste precisam de um grupo, como uma real.
 insert into public.tenant_notice_channels(tenant_id,channel,group_jid)
 values('quality-contact-fixture','coordenacao','120363000000000002@g.us'),
       ('quality-other-fixture','coordenacao','120363000000000003@g.us');
 insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values
 (teacher_id,'qc-teacher@example.invalid','{"provider":"email","providers":["email"]}','{"test_fixture":true}'),
 (student_id,'qc-student@example.invalid','{"provider":"email","providers":["email"]}','{"test_fixture":true}'),
 (sibling_id,'qc-sibling@example.invalid','{"provider":"email","providers":["email"]}','{"test_fixture":true}'),
 (admin_id,'qc-admin@example.invalid','{"provider":"email","providers":["email"]}','{"test_fixture":true}'),
 (outsider_id,'qc-other@example.invalid','{"provider":"email","providers":["email"]}','{"test_fixture":true}');
 update public.profiles set tenant_id='quality-contact-fixture',lifecycle_status='active',is_test_account=true,
  role=case when id=teacher_id then 'TEACHER' when id=admin_id then 'SCHOOL_ADMIN' else 'STUDENT' end
  where id in(teacher_id,student_id,sibling_id,admin_id);
 update public.profiles set tenant_id='quality-other-fixture',role='SCHOOL_ADMIN',lifecycle_status='active',is_test_account=true where id=outsider_id;
 update public.profiles set professor_id=teacher_id,phone='5511999991111',attendance_phone='5511999992222',meeting_link='https://meet.google.com/abc-defg-hij' where id in(student_id,sibling_id);
 insert into public.tenant_memberships(tenant_id,user_id,role,status) values
 ('quality-contact-fixture',teacher_id,'TEACHER','ACTIVE'),('quality-contact-fixture',student_id,'STUDENT','ACTIVE'),
 ('quality-contact-fixture',sibling_id,'STUDENT','ACTIVE'),('quality-contact-fixture',admin_id,'SCHOOL_ADMIN','ACTIVE'),
 ('quality-other-fixture',outsider_id,'SCHOOL_ADMIN','ACTIVE') on conflict(tenant_id,user_id) do update set role=excluded.role,status=excluded.status;
 insert into public.bookings(id,tenant_id,teacher_id,student_id,day_of_week,time_slot,status,start_date)
 values(booking_id,'quality-contact-fixture',teacher_id,student_id,'Segunda','08:00','SCHEDULED',today-30);
 insert into public.teacher_availability(tenant_id,teacher_id,day_of_week,start_time) values
 ('quality-contact-fixture',teacher_id,2,'09:00'),('quality-contact-fixture',teacher_id,3,'10:00');

 perform set_config('request.jwt.claims',jsonb_build_object('sub',teacher_id,'role','authenticated')::text,true);
 blocked:=false;
 begin perform public.update_student_pedagogical_profile(student_id,'{"attendance_phone":"5511999999999"}'::jsonb); exception when insufficient_privilege then blocked:=true; end;
 perform pg_temp.quality_assert(blocked,'teacher can change attendance destination');
 blocked:=false;
 begin update public.profiles set meeting_link='https://meet.google.com/zzz-zzzz-zzz' where id=student_id; exception when insufficient_privilege then blocked:=true; end;
 perform pg_temp.quality_assert(blocked,'direct teacher meeting link change');
 blocked:=false;
 begin perform public.change_booking_schedule(booking_id,'Terça','09:00'); exception when insufficient_privilege then blocked:=true; end;
 perform pg_temp.quality_assert(blocked,'legacy teacher schedule mutation bypass');
 blocked:=false;
 begin delete from public.bookings where id=booking_id; exception when insufficient_privilege then blocked:=true; end;
 perform pg_temp.quality_assert(blocked,'teacher delete/recreate bypass');
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 blocked:=false;
 begin perform public.gestao_change_booking_schedule('quality-contact-fixture',teacher_id,booking_id,student_id,'Terça','09:00','120363499999999999@g.us','quality-fixture-management-request');
 exception when insufficient_privilege then blocked:=true; end;
 perform pg_temp.quality_assert(blocked,'management service impersonated teacher schedule change');
 perform set_config('request.jwt.claims',jsonb_build_object('sub',teacher_id,'role','authenticated')::text,true);

 result:=public.request_student_contact_change(student_id,'Responsável Teste','11988887777','GUARDIAN','Contato indicado para qualidade'); contact_request:=(result->>'id')::uuid;
 blocked:=false;
 begin perform public.review_student_contact_change(contact_request,true,'Eu professor confirmei'); exception when insufficient_privilege then blocked:=true; end;
 perform pg_temp.quality_assert(blocked,'teacher verifies own audit contact');
 perform set_config('request.jwt.claims',jsonb_build_object('sub',outsider_id,'role','authenticated')::text,true);
 blocked:=false;
 begin perform public.review_student_contact_change(contact_request,true,'Outra escola confirmou'); exception when insufficient_privilege then blocked:=true; end;
 perform pg_temp.quality_assert(blocked,'cross tenant contact review');
 perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
 result:=public.review_student_contact_change(contact_request,true,'Identidade e vínculo confirmados pela escola em atendimento'); contact_id:=(result->>'contact_id')::uuid;
 perform pg_temp.quality_assert(exists(select 1 from public.student_quality_contacts c where c.id=contact_id and c.phone='5511988887777' and c.verified_by=admin_id),'verified contact missing');
 result:=public.request_student_contact_change(sibling_id,'Responsável Teste','11988887777','GUARDIAN','Mesmo responsável para segundo filho');
 perform public.review_student_contact_change((result->>'id')::uuid,true,'Conferimos separadamente o vínculo com segundo filho');
 perform pg_temp.quality_assert((select count(*)=2 from public.student_quality_contacts where tenant_id='quality-contact-fixture' and phone='5511988887777'),'multiple children cannot share guardian');
 perform pg_temp.quality_assert((select count(*)=2 from public.quality_contact_events where tenant_id='quality-contact-fixture'),'contact history missing');

 perform set_config('request.jwt.claims',jsonb_build_object('sub',teacher_id,'role','authenticated')::text,true);
 blocked:=false;
 begin perform public.request_booking_schedule_change(booking_id,'Terça','09:00',monday,'Professor atribuindo pedido à escola','PERMANENT',null,null,'SCHOOL');
 exception when insufficient_privilege then blocked:=true; end;
 perform pg_temp.quality_assert(blocked,'teacher can claim school initiated request');
 result:=public.request_booking_schedule_change(booking_id,'Terça','09:00',monday,'Necessidade familiar de mudança de rotina'); change_id:=(result->>'id')::uuid;
 perform pg_temp.quality_assert((select b.day_of_week='Segunda' from public.bookings b where b.id=booking_id),'request mutated schedule before acceptance');
 blocked:=false;
 begin perform public.issue_schedule_change_link(change_id,contact_id); exception when insufficient_privilege then blocked:=true; end;
 perform pg_temp.quality_assert(blocked,'teacher can obtain family acceptance token');
 perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
 result:=public.enqueue_schedule_change_acceptance(change_id,contact_id);
 perform pg_temp.quality_assert((result->>'suppressed')::boolean,'test fixture crossed notification queue boundary');
 perform pg_temp.quality_assert(not exists(select 1 from public.notification_queue where source_id=change_id),'test fixture queued external family message');
 -- Exercise the eligible delivery branch inside this uncommitted transaction.
 -- Auth metadata remains test_fixture=true; no worker can observe these rows,
 -- no external API is called, and the entire test rolls back.
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 update public.profiles set is_test_account=false where id in(student_id,teacher_id);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
 result:=public.enqueue_schedule_change_acceptance(change_id,contact_id); notification_id:=(result->>'notification_id')::uuid;
 perform pg_temp.quality_assert((result->>'queued')::boolean,'eligible acceptance not queued');
 perform pg_temp.quality_assert((public.enqueue_schedule_change_acceptance(change_id,contact_id)->>'already')::boolean,'acceptance queue not idempotent');
 perform pg_temp.quality_assert((select count(*)=1 from public.notification_queue q where q.source_id=change_id and q.teacher_id is null),'acceptance duplicated or teacher can read token');
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 result:=public.get_schedule_change_delivery_snapshot(notification_id);
 perform pg_temp.quality_assert((result->>'ok')::boolean,'valid delivery snapshot rejected');
 select message_body into original_message from public.notification_queue where id=notification_id;
 update public.notification_queue set message_body=message_body||' injected' where id=notification_id;
 perform pg_temp.quality_assert(not(public.get_schedule_change_delivery_snapshot(notification_id)->>'ok')::boolean,'edited delivery body accepted');
 update public.notification_queue set message_body=original_message where id=notification_id;
 update public.student_quality_contacts set active=false where id=contact_id;
 perform pg_temp.quality_assert(not(public.get_schedule_change_delivery_snapshot(notification_id)->>'ok')::boolean,'deactivated contact can receive acceptance');
 update public.student_quality_contacts set active=true where id=contact_id;
 update public.profiles set is_test_account=true where id in(student_id,teacher_id);
 perform pg_temp.quality_assert(not(public.get_schedule_change_delivery_snapshot(notification_id)->>'ok')::boolean,'fixture marked after queue crossed external boundary');
 perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
 blocked:=false;
 begin perform public.review_booking_schedule_change(change_id,true,'Aplicação sem aceite familiar'); exception when others then blocked:=sqlerrm='family_acceptance_required'; end;
 perform pg_temp.quality_assert(blocked,'school applied without family acceptance');
 result:=public.issue_schedule_change_link(change_id,contact_id); token_one:=result->>'token';
 result:=public.issue_schedule_change_link(change_id,contact_id); token_two:=result->>'token';
 perform pg_temp.quality_assert(not(public.get_schedule_change_public(token_one)->>'found')::boolean,'replaced token remains valid');
 perform pg_temp.quality_assert((public.get_schedule_change_public(token_two)->>'found')::boolean,'new token invalid');
 perform set_config('request.jwt.claims','{"role":"anon"}',true);
 result:=public.respond_schedule_change_public(token_two,true);
 perform pg_temp.quality_assert(result->>'status'='ACCEPTED','family acceptance missing');
 perform pg_temp.quality_assert((public.respond_schedule_change_public(token_two,false)->>'already')::boolean,'family replay changed decision');
 perform pg_temp.quality_assert((select b.day_of_week='Segunda' from public.bookings b where b.id=booking_id),'family acceptance changed schedule before school review');
 perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
 perform public.review_booking_schedule_change(change_id,true,'Conferida disponibilidade e vigência com família');
 snapshot:=public.booking_schedule_on_date(booking_id,monday-7);
 perform pg_temp.quality_assert((snapshot->>'valid')::boolean and snapshot->>'time_slot'='08:00','past schedule lost after permanent change');
 snapshot:=public.booking_schedule_on_date(booking_id,monday);
 perform pg_temp.quality_assert(not(snapshot->>'valid')::boolean,'old weekday remains valid after effective date');
 snapshot:=public.booking_schedule_on_date(booking_id,monday+1);
 perform pg_temp.quality_assert((snapshot->>'valid')::boolean and snapshot->>'time_slot'='09:00','future schedule missing');
 perform pg_temp.quality_assert((public.review_booking_schedule_change(change_id,true,'Repetindo revisão idempotente')->>'already')::boolean,'apply not idempotent');

 old_date:=monday+8; new_date:=monday+9;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',teacher_id,'role','authenticated')::text,true);
 blocked:=false;
 begin perform public.request_booking_schedule_change(booking_id,'Terça','10:00',old_date,'Tentativa de mover sobre outra aula','ONE_OFF',old_date,old_date+7,'TEACHER');
 exception when others then blocked:=sqlerrm='target_date_already_has_this_lesson'; end;
 perform pg_temp.quality_assert(blocked,'one-off can overwrite a regular occurrence of the same booking');
 result:=public.request_booking_schedule_change(booking_id,'Quarta','10:00',old_date,'Mudança excepcional solicitada pela família','ONE_OFF',old_date,new_date,'GUARDIAN'); change_two:=(result->>'id')::uuid;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
 result:=public.issue_schedule_change_link(change_two,contact_id); token_two:=result->>'token';
 perform public.respond_schedule_change_public(token_two,true);
 perform public.review_booking_schedule_change(change_two,true,'Conferida mudança pontual com retorno à grade');
 snapshot:=public.booking_schedule_on_date(booking_id,old_date);
 perform pg_temp.quality_assert((snapshot->>'excluded')::boolean and not(snapshot->>'valid')::boolean,'one-off original occurrence still valid');
 snapshot:=public.booking_schedule_on_date(booking_id,new_date);
 perform pg_temp.quality_assert((snapshot->>'valid')::boolean and snapshot->>'time_slot'='10:00','one-off target occurrence missing');
 snapshot:=public.booking_schedule_on_date(booking_id,old_date+7);
 perform pg_temp.quality_assert((snapshot->>'valid')::boolean and snapshot->>'time_slot'='09:00','one-off modified following weeks');
 blocked:=false;
 begin update public.bookings set day_of_week='Quinta',time_slot='11:00' where id=booking_id; exception when insufficient_privilege then blocked:=true; end;
 perform pg_temp.quality_assert(blocked,'legacy administrator change silently bypassed version history');
 insert into public.bookings(id,tenant_id,teacher_id,student_id,day_of_week,time_slot,status,start_date)
 values(conflict_booking,'quality-contact-fixture',teacher_id,sibling_id,'Quinta','11:00','SCHEDULED',today);
 insert into public.booking_schedule_versions(tenant_id,booking_id,valid_from,day_of_week,time_slot)
 values('quality-contact-fixture',conflict_booking,monday+21,'Quarta','10:00');
 perform set_config('request.jwt.claims',jsonb_build_object('sub',teacher_id,'role','authenticated')::text,true);
 result:=public.request_booking_schedule_change(booking_id,'Quarta','10:00',monday+21,'Proposta conflita somente com vigência futura'); change_three:=(result->>'id')::uuid;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
 result:=public.issue_schedule_change_link(change_three,contact_id);
 perform public.respond_schedule_change_public(result->>'token',true);
 blocked:=false;
 begin perform public.review_booking_schedule_change(change_three,true,'Revisão precisa detectar conflito futuro'); exception when others then blocked:=sqlerrm='schedule_conflict'; end;
 perform pg_temp.quality_assert(blocked,'schedule conflict ignored future effective versions');
 perform public.review_booking_schedule_change(change_three,false,'Proposta cancelada por conflito futuro');
 perform set_config('request.jwt.claims',jsonb_build_object('sub',teacher_id,'role','authenticated')::text,true);
 perform set_config('role','authenticated',true);
 perform pg_temp.quality_assert((select count(*)=0 from public.student_quality_contacts),'teacher can read verified family directory');
 snapshot:=public.booking_schedule_on_date(booking_id,new_date);
 perform pg_temp.quality_assert((snapshot->>'valid')::boolean,'teacher cannot read own authorized schedule helper');
 perform set_config('role','none',true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',outsider_id,'role','authenticated')::text,true);
 perform set_config('role','authenticated',true);
 perform pg_temp.quality_assert((select count(*)=0 from public.student_quality_contacts),'other school can read contact directory');
 perform pg_temp.quality_assert((select count(*)=0 from public.schedule_change_requests),'other school can read schedule requests');
 perform set_config('role','none',true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
 perform public.deactivate_student_quality_contact(contact_id,'Responsável pediu remoção deste canal');
 perform pg_temp.quality_assert(not(public.get_schedule_change_public(token_two)->>'found')::boolean,'deactivated family token remains usable');
 perform pg_temp.quality_assert(not has_table_privilege('authenticated','private.schedule_change_tokens','select'),'tokens exposed to client');
 perform pg_temp.quality_assert(not has_table_privilege('authenticated','public.student_quality_contacts','update'),'direct contact writes exposed');
 perform pg_temp.quality_assert(not has_function_privilege('anon','public.review_booking_schedule_change(uuid,boolean,text)','execute'),'public school approval exposed');
end;
$test$;
rollback;
