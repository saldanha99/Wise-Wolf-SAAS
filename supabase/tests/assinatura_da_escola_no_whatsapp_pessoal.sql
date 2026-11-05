\set ON_ERROR_STOP on
-- Link de assinatura da escola no WhatsApp pessoal (05/11/2026): nunca sai para o
-- próprio número central, chega no celular cadastrado pela direção, o termo conta
-- na Central de Pendências e o horário segurado aparece como reservado.
begin;
create or replace function pg_temp.sw_assert(v boolean,m text) returns void language plpgsql as $$begin if not coalesce(v,false) then raise exception 'assinatura da escola: %',m;end if;end$$;
do $test$
declare tenant text:='term-sign-fixture-'||gen_random_uuid();teacher uuid:=gen_random_uuid();other_teacher uuid:=gen_random_uuid();student uuid:=gen_random_uuid();director uuid:=gen_random_uuid();
 today date:=(now() at time zone 'America/Sao_Paulo')::date;original_eligibility text;r jsonb;term uuid;term2 uuid;offer uuid:=gen_random_uuid();tok text;tok2 text;hash text;
begin
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 insert into public.tenants(id,name,slug,saas_status,custom_domain,custom_domain_verified,school_info) values(tenant,'Term sign fixture',tenant,'active','term-sign.example.com',true,jsonb_build_object('legalName','Escola Assina Ltda','cnpj','11222333000181','address','Rua Fixture, 1','email','legal@example.invalid','phone','5511999999999','city','Cidade Fixture','state','SP','legalRepresentativeName','Diretor Assina','legalRepresentativeSignaturePath',tenant||'/legal-representative-signature/00000000-0000-4000-8000-000000000001.png'));
 insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) select id,id||'@example.invalid','{"provider":"email"}','{"test_fixture":true}' from unnest(array[teacher,other_teacher,student,director]) f(id);
 -- O perfil do diretor tem o telefone da instância central, como na Wise Wolf.
 update public.profiles set tenant_id=tenant,full_name=case id when teacher then 'Professora Assina' when other_teacher then 'Outro Professor' when director then 'Diretor Assina' else 'Aluna Assina' end,
  role=case when id in(teacher,other_teacher) then 'TEACHER' when id=director then 'SCHOOL_ADMIN' else 'STUDENT' end,is_test_account=true,
  phone=case id when teacher then '11966667771' when other_teacher then '11966667772' when director then '11966667773' else null end,
  whatsapp_instance=case when id=director then 'fixture-central-'||tenant end,
  status='Ativo',lifecycle_status='active',contract_accepted=true,hourly_rate=8,monthly_fee=777 where id=any(array[teacher,other_teacher,student,director]);
 insert into public.tenant_memberships(user_id,tenant_id,role,status,is_primary) select id,tenant_id,role,'ACTIVE',true from public.profiles where tenant_id=tenant on conflict(user_id,tenant_id) do update set role=excluded.role,status='ACTIVE';
 insert into public.tenant_user_contexts(user_id,tenant_id) select id,tenant_id from public.profiles where tenant_id=tenant on conflict(user_id) do update set tenant_id=excluded.tenant_id;
 original_eligibility:=pg_get_functiondef('public.teacher_opportunity_recipient_eligible(text,uuid)'::regprocedure);
 execute $stub$create or replace function public.teacher_opportunity_recipient_eligible(p_tenant text,p_teacher uuid) returns boolean language sql stable security definer set search_path='' as $body$ select exists(select 1 from public.profiles p join public.tenant_memberships m on m.user_id=p.id and m.tenant_id=p.tenant_id and m.status='ACTIVE' and m.role='TEACHER' where p.id=p_teacher and p.tenant_id=p_tenant and p.role='TEACHER' and p.lifecycle_status='active' and p.status='Ativo') $body$ $stub$;
 insert into private.teacher_service_identities(tenant_id,teacher_id,identity) values(tenant,teacher,'{"kind":"INDIVIDUAL","companyName":"Professora Assina (pessoa física, autônomo)","cnpj":"não se aplica (pessoa física)","companyAddress":"Rua da Professora, 10","representativeCpf":"52998224725","representativeHasAuthority":true}');
 insert into private.teacher_student_term_policy(tenant_id,enabled,starts_at) values(tenant,true,now()-interval '1 day');

 -- 1. Termo nasce: o professor recebe; a escola não, porque o único destino é o
 -- próprio número central. O termo conta como pendente mesmo assim.
 perform set_config('request.jwt.claims',jsonb_build_object('sub',director,'role','authenticated')::text,true);
 r:=public.teacher_student_terms('prepare',gen_random_uuid(),jsonb_build_object('student_id',student,'teacher_id',teacher,'mode','RECURRING','starts_on',today+3,'slots','[{"day":2,"time":"18:00"}]'::jsonb));term:=(r->>'id')::uuid;
 perform pg_temp.sw_assert(exists(select 1 from public.notification_queue where idempotency_key=format('student-term-link:%s:teacher:1',term)),'link do professor nao saiu');
 perform pg_temp.sw_assert(not exists(select 1 from public.notification_queue where idempotency_key like format('student-term-link:%s:school:%%',term)),'link da escola saiu para o proprio numero central');
 perform pg_temp.sw_assert(not exists(select 1 from private.student_term_links where term_id=term and signer='SCHOOL'),'link da escola criado sem destino valido');
 perform pg_temp.sw_assert((public.director_pending_counts()->>'termos_para_assinar')::int=1,'termo fora da central de pendencias');

 -- 2. O cartão pede o número. Número da escola e número inválido são recusados.
 r:=public.my_term_signature_contact();
 perform pg_temp.sw_assert(r->>'ok'='true' and (r->>'needs_number')::boolean and r->>'phone' is null and (r->>'pending')::int=1,'cartao sem pedir numero: '||r::text);
 perform pg_temp.sw_assert(public.set_my_term_signature_contact('(11) 96666-7773')->>'error'='numero_da_escola','numero central aceito');
 perform pg_temp.sw_assert(public.set_my_term_signature_contact('5511966667773')->>'error'='numero_da_escola','numero central com DDI aceito');
 perform pg_temp.sw_assert(public.set_my_term_signature_contact('1234')->>'error'='numero_invalido','numero invalido aceito');
 perform pg_temp.sw_assert(public.set_my_term_signature_contact(null)->>'error'='numero_invalido','numero vazio aceito');
 perform pg_temp.sw_assert(not exists(select 1 from private.term_signature_contacts where tenant_id=tenant),'numero recusado foi gravado');

 -- 3. Número pessoal: grava, emite o link em aberto para ele e entra como equipe.
 r:=public.set_my_term_signature_contact('(11) 95555-4441');
 perform pg_temp.sw_assert(r->>'ok'='true' and r->>'phone'='5511955554441' and (r->>'links_sent')::int=1,'numero pessoal: '||r::text);
 perform pg_temp.sw_assert((select student_phone from public.notification_queue where idempotency_key=format('student-term-link:%s:school:1',term))='5511955554441','link da escola fora do numero pessoal');
 perform pg_temp.sw_assert((select phone='5511955554441' and signer_id=director from private.student_term_links where term_id=term and signer='SCHOOL' and revoked_at is null),'link da escola sem o assinante certo');
 perform pg_temp.sw_assert(private.whatsapp_outbound_kind('5511955554441')='staff','celular de quem assina tratado como contato frio');
 perform pg_temp.sw_assert((public.my_term_signature_contact()->>'needs_number')::boolean is false,'cartao ainda pede numero');
 select substring(message_body from 't=([0-9a-f]{64})') into tok from public.notification_queue where idempotency_key=format('student-term-link:%s:school:1',term);

 -- 4. Salvar o mesmo número não manda nada de novo.
 r:=public.set_my_term_signature_contact('11955554441');
 perform pg_temp.sw_assert((r->>'links_sent')::int=0,'mesmo numero reemitiu link');
 perform pg_temp.sw_assert((select count(*) from private.student_term_links where term_id=term and signer='SCHOOL')=1,'mesmo numero criou link');

 -- 5. Trocar o número revoga o link anterior e emite outro. A trilha guarda só o final.
 r:=public.set_my_term_signature_contact('11955554442');
 perform pg_temp.sw_assert((r->>'links_sent')::int=1,'troca de numero nao reemitiu');
 perform pg_temp.sw_assert(public.student_term_link_view(tok)->>'reason'='replaced','link antigo segue valendo');
 select substring(message_body from 't=([0-9a-f]{64})') into tok2 from public.notification_queue where idempotency_key=format('student-term-link:%s:school:2',term);
 perform pg_temp.sw_assert((select student_phone from public.notification_queue where idempotency_key=format('student-term-link:%s:school:2',term))='5511955554442','link novo fora do numero novo');
 perform pg_temp.sw_assert((select new_values->>'phone_end'='4442' and old_values->>'phone_end'='4441' from public.audit_logs where tenant_id=tenant and action='TERM_SIGNATURE_CONTACT_SET' order by created_at desc,new_values->>'phone_end' desc limit 1),'trilha da troca ausente');
 perform pg_temp.sw_assert(not exists(select 1 from public.audit_logs where tenant_id=tenant and action='TERM_SIGNATURE_CONTACT_SET' and (new_values::text like '%55555%' or coalesce(old_values::text,'') like '%55555%')),'telefone completo na trilha');

 -- 6. Professor e aluno não cadastram nem leem esse número.
 perform set_config('request.jwt.claims',jsonb_build_object('sub',teacher,'role','authenticated')::text,true);
 perform pg_temp.sw_assert(public.set_my_term_signature_contact('11955554443')->>'error'='not_authorized','professor cadastrou numero');
 perform pg_temp.sw_assert(public.my_term_signature_contact()->>'error'='not_authorized','professor leu o numero');
 perform set_config('request.jwt.claims',jsonb_build_object('sub',student,'role','authenticated')::text,true);
 perform pg_temp.sw_assert(public.set_my_term_signature_contact('11955554443')->>'error'='not_authorized','aluno cadastrou numero');
 perform set_config('request.jwt.claims','',true);

 -- 7. O link no celular novo assina como a direção, e o termo sai das pendências.
 hash:=(public.student_term_link_view(tok2))->>'content_hash';
 r:=public.student_term_link_act(tok2,'sign',jsonb_build_object('typed_name','Diretor Assina','content_hash',hash,'accepted',true,'has_authority',true));
 perform pg_temp.sw_assert(r->>'ok'='true','escola nao assinou pelo link: '||r::text);
 perform pg_temp.sw_assert((select school_signed_by=director from private.teacher_student_terms where id=term),'assinatura atribuida a outra pessoa');
 perform pg_temp.sw_assert((select phone='5511955554442' from private.student_term_links where term_id=term and signer='SCHOOL' and used_at is not null),'assinatura sem o numero usado');
 perform pg_temp.sw_assert(private.student_term_school_pending_count(tenant)=0,'termo assinado segue pendente');

 -- 8. Horário de matrícula à espera do termo aparece como reservado, só para quem pode ver.
 insert into public.offers(id,kind,tenant_id,payload,expires_at,created_by,requires_enrollment,enrollment_fee,processing_by,processing_state,metadata,invite_security_version)
 values(offer,'ENROLLMENT',tenant,jsonb_build_object('planDuration',12,'value',100,'classesPerWeek',1),now()+interval '20 days',director,true,0,student,'BILLING_READY','{}'::jsonb,1);
 insert into private.enrollment_offer_schedule_slots(offer_id,tenant_id,slot_index,teacher_id,day_of_week,day_name,class_time,start_date)
 values(offer,tenant,1,teacher,3,'Quarta','12:30',today+3);
 update private.enrollment_offer_schedule_slots set status='RESERVED',reserved_by=student,reserved_at=now(),reservation_expires_at=now()+interval '20 days' where offer_id=offer;
 insert into private.teacher_student_terms(tenant_id,student_id,teacher_id,source_kind,source_id,source_key,source_hash,mode,starts_on,slots,unit_rate,school_snapshot,student_name,teacher_name)
 values(tenant,student,teacher,'ENROLLMENT',offer,'ENROLLMENT:'||offer||':'||teacher,'teste','RECURRING',today+3,'[{"day":3,"date":null,"time":"12:30"}]'::jsonb,8,'{}'::jsonb,'Aluna Assina','Professora Assina')
 returning id into term2;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',teacher,'role','authenticated')::text,true);
 r:=public.list_term_reserved_slots(tenant,array[teacher]);
 perform pg_temp.sw_assert(jsonb_array_length(r)=1 and r->0->>'class_time'='12:30' and (r->0->>'day_of_week')::int=3 and r->0->>'student_label'='Aluna Assina' and (r->0->>'waiting_school')::boolean,'professor nao ve a reserva: '||r::text);
 perform pg_temp.sw_assert(position('777' in r::text)=0,'reserva com valor do aluno');
 perform set_config('request.jwt.claims',jsonb_build_object('sub',other_teacher,'role','authenticated')::text,true);
 perform pg_temp.sw_assert(jsonb_array_length(public.list_term_reserved_slots(tenant,array[teacher]))=0,'outro professor ve a reserva');
 perform set_config('request.jwt.claims',jsonb_build_object('sub',student,'role','authenticated')::text,true);
 perform pg_temp.sw_assert(jsonb_array_length(public.list_term_reserved_slots(tenant,null))=0,'aluno ve a reserva');
 perform set_config('request.jwt.claims',jsonb_build_object('sub',director,'role','authenticated')::text,true);
 perform pg_temp.sw_assert(jsonb_array_length(public.list_term_reserved_slots(tenant,array[teacher]))=1,'direcao nao ve a reserva');
 perform set_config('request.jwt.claims','',true);
 update private.teacher_student_terms set status='DECLINED' where id=term2;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',teacher,'role','authenticated')::text,true);
 perform pg_temp.sw_assert(jsonb_array_length(public.list_term_reserved_slots(tenant,array[teacher]))=0,'termo recusado segue reservando');
 perform set_config('request.jwt.claims','',true);

 -- 9. Escola sem o problema continua usando o telefone do perfil.
 delete from private.term_signature_contacts where tenant_id=tenant;
 update public.profiles set whatsapp_instance=null where id=director;
 perform pg_temp.sw_assert(private.student_term_school_signer_phone(tenant,director)='5511966667773','perfil sem instancia perdeu o telefone');
 perform pg_temp.sw_assert(private.student_term_school_signer(tenant)=director,'direcao sem instancia deixou de assinar');

 -- 10. Navegador não lê a tabela; visitante não chama as funções.
 perform pg_temp.sw_assert(not has_table_privilege('authenticated','private.term_signature_contacts','SELECT') and not has_table_privilege('anon','private.term_signature_contacts','SELECT'),'tabela de numeros exposta');
 perform pg_temp.sw_assert(not has_function_privilege('anon','public.set_my_term_signature_contact(text)','EXECUTE') and not has_function_privilege('anon','public.my_term_signature_contact()','EXECUTE') and not has_function_privilege('anon','public.list_term_reserved_slots(text,uuid[])','EXECUTE'),'funcao aberta a visitante');
 perform pg_temp.sw_assert(has_function_privilege('authenticated','public.set_my_term_signature_contact(text)','EXECUTE'),'portal sem acesso');

 execute original_eligibility;
end;$test$;
rollback;
