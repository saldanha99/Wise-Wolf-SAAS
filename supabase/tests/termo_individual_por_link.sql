\set ON_ERROR_STOP on
-- Termo individual por link no WhatsApp (31/10/2026): cada parte recebe um link
-- pessoal, assina sem login e em qualquer ordem; o link é de uso único, age só
-- como quem o recebeu e nunca mostra valor pago pelo aluno.
begin;
create or replace function pg_temp.tl_assert(v boolean,m text) returns void language plpgsql as $$begin if not coalesce(v,false) then raise exception 'termo por link: %',m;end if;end$$;
do $test$
declare tenant text:='term-link-fixture-'||gen_random_uuid();teacher uuid:=gen_random_uuid();teacher2 uuid:=gen_random_uuid();student uuid:=gen_random_uuid();director uuid:=gen_random_uuid();
 today date:=(now() at time zone 'America/Sao_Paulo')::date;original_eligibility text;r jsonb;v jsonb;term uuid;term2 uuid;t_tok text;s_tok text;t2_tok text;hash text;
begin
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 insert into public.tenants(id,name,slug,saas_status,custom_domain,custom_domain_verified,school_info) values(tenant,'Term link fixture',tenant,'active','term-link.example.com',true,jsonb_build_object('legalName','Escola Link Ltda','cnpj','11222333000181','address','Rua Fixture, 1','email','legal@example.invalid','phone','5511999999999','city','Cidade Fixture','state','SP','legalRepresentativeName','Diretor Link','legalRepresentativeSignaturePath',tenant||'/legal-representative-signature/00000000-0000-4000-8000-000000000001.png'));
 insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) select id,id||'@example.invalid','{"provider":"email"}','{"test_fixture":true}' from unnest(array[teacher,teacher2,student,director]) f(id);
 update public.profiles set tenant_id=tenant,full_name=case id when teacher then 'Professora Link' when teacher2 then 'Professor Sem Dados' when director then 'Diretor Link' else 'Aluna Link' end,
  role=case when id in(teacher,teacher2) then 'TEACHER' when id=director then 'SCHOOL_ADMIN' else 'STUDENT' end,is_test_account=true,
  phone=case id when teacher then '11988887771' when teacher2 then '11988887772' when director then '11988887773' else null end,
  status='Ativo',lifecycle_status='active',contract_accepted=true,hourly_rate=8,monthly_fee=777 where id=any(array[teacher,teacher2,student,director]);
 insert into public.tenant_memberships(user_id,tenant_id,role,status,is_primary) select id,tenant_id,role,'ACTIVE',true from public.profiles where tenant_id=tenant on conflict(user_id,tenant_id) do update set role=excluded.role,status='ACTIVE';
 insert into public.tenant_user_contexts(user_id,tenant_id) select id,tenant_id from public.profiles where tenant_id=tenant on conflict(user_id) do update set tenant_id=excluded.tenant_id;
 original_eligibility:=pg_get_functiondef('public.teacher_opportunity_recipient_eligible(text,uuid)'::regprocedure);
 execute $stub$create or replace function public.teacher_opportunity_recipient_eligible(p_tenant text,p_teacher uuid) returns boolean language sql stable security definer set search_path='' as $body$ select exists(select 1 from public.profiles p join public.tenant_memberships m on m.user_id=p.id and m.tenant_id=p.tenant_id and m.status='ACTIVE' and m.role='TEACHER' where p.id=p_teacher and p.tenant_id=p_tenant and p.role='TEACHER' and p.lifecycle_status='active' and p.status='Ativo') $body$ $stub$;
 insert into private.teacher_service_identities(tenant_id,teacher_id,identity) values(tenant,teacher,'{"kind":"INDIVIDUAL","companyName":"Professora Link (pessoa física, autônomo)","cnpj":"não se aplica (pessoa física)","companyAddress":"Rua da Professora, 10","representativeCpf":"52998224725","representativeHasAuthority":true}');
 insert into private.teacher_student_term_policy(tenant_id,enabled,starts_at) values(tenant,true,now()-interval '1 day');

 -- 1. A proposta nasce e os dois links saem pela fila, sem valor do aluno.
 perform set_config('request.jwt.claims',jsonb_build_object('sub',director,'role','authenticated')::text,true);
 r:=public.teacher_student_terms('prepare',gen_random_uuid(),jsonb_build_object('student_id',student,'teacher_id',teacher,'mode','RECURRING','starts_on',today+3,'slots','[{"day":2,"time":"18:00"},{"day":2,"time":"18:30"}]'::jsonb));term:=(r->>'id')::uuid;
 perform set_config('request.jwt.claims','',true);
 select substring(message_body from 't=([0-9a-f]{64})') into t_tok from public.notification_queue where tenant_id=tenant and idempotency_key=format('student-term-link:%s:teacher:1',term);
 select substring(message_body from 't=([0-9a-f]{64})') into s_tok from public.notification_queue where tenant_id=tenant and idempotency_key=format('student-term-link:%s:school:1',term);
 perform pg_temp.tl_assert(t_tok is not null and s_tok is not null,'links da proposta nao enfileirados');
 perform pg_temp.tl_assert(not exists(select 1 from public.notification_queue where tenant_id=tenant and (message_body like '%777%' or message_body ilike '%mensalidade%')),'mensagem com valor do aluno');
 perform pg_temp.tl_assert((select student_phone from public.notification_queue where idempotency_key=format('student-term-link:%s:teacher:1',term))='5511988887771','link do professor fora do WhatsApp dele');
 perform pg_temp.tl_assert(exists(select 1 from public.notification_queue where idempotency_key=format('student-term-link:%s:teacher:1',term) and message_body like '%Terça 18:00 (1h)%'),'agenda ilegivel na mensagem');
 perform pg_temp.tl_assert(not exists(select 1 from private.student_term_links where token_hash in(t_tok,s_tok)),'token guardado em claro');
 -- Link criado entre 21h e 8h espera as 8h (Brasília); de dia sai na hora.
 perform pg_temp.tl_assert(private.student_term_send_at('2026-11-01 23:10-03')='2026-11-02 08:00-03','link das 23h nao espera as 8h');
 perform pg_temp.tl_assert(private.student_term_send_at('2026-11-02 03:00-03')='2026-11-02 08:00-03','link da madrugada nao espera as 8h');
 perform pg_temp.tl_assert(private.student_term_send_at('2026-11-02 14:00-03')='2026-11-02 14:00-03','link de dia atrasado');
 perform pg_temp.tl_assert((select scheduled_for=private.student_term_send_at(now()) and next_attempt_at=scheduled_for from public.notification_queue where idempotency_key=format('student-term-link:%s:teacher:1',term)),'link fora do horario de envio');

 -- Termo novo nasce no modelo jurídico 2, com as multas aprovadas em 31/10.
 perform pg_temp.tl_assert((select position('Modelo jurídico: 2' in body)>0 and position('dez vezes o valor de referência' in body)>0 and position('dois meses de honorários' in body)>0 and position('duas vezes o valor de referência' in body)>0 from private.teacher_student_terms where id=term),'termo novo fora do modelo 2');
 -- 2. A página mostra o resumo e o valor do professor, nunca o do aluno.
 v:=public.student_term_link_view(t_tok);
 perform pg_temp.tl_assert(v->>'ok'='true' and v->>'signer'='TEACHER' and (v->>'unit_rate')::numeric=8 and v->>'agenda' like 'Terça 18:00%','leitura do link do professor: '||v::text);
 perform pg_temp.tl_assert(position('777' in v::text)=0,'pagina com valor do aluno');
 perform pg_temp.tl_assert(public.student_term_link_view(repeat('0',64))->>'reason'='invalid','token inventado aceito');
 perform pg_temp.tl_assert(public.student_term_link_view('abc')->>'reason'='invalid','token malformado aceito');

 -- 3. Professor assina primeiro; nome errado recusa; link vira uso único.
 hash:=v->>'content_hash';
 r:=public.student_term_link_act(t_tok,'sign',jsonb_build_object('typed_name','Outra Pessoa','content_hash',hash,'accepted',true,'has_authority',true));
 perform pg_temp.tl_assert(r->>'ok'='false','nome errado assinou');
 perform pg_temp.tl_assert(public.student_term_link_act(s_tok,'decline','{}')->>'error'='acao_invalida','escola recusou pelo link do professor');
 r:=public.student_term_link_act(t_tok,'sign',jsonb_build_object('typed_name','professora link','content_hash',hash,'accepted',true,'has_authority',true));
 perform pg_temp.tl_assert(r->>'ok'='true' and r->>'phase'='SCHOOL_PENDING','professor nao assinou antes da escola: '||r::text);
 perform pg_temp.tl_assert((select teacher_signed_by=teacher and school_signed_at is null from private.teacher_student_terms where id=term),'assinatura atribuida a outra pessoa');
 perform pg_temp.tl_assert(exists(select 1 from private.teacher_student_term_events where term_id=term and event='SIGNED_VIA_WHATSAPP_LINK' and actor_id=teacher and details->>'signer'='TEACHER'),'evento do link ausente');
 perform pg_temp.tl_assert(public.student_term_link_act(t_tok,'sign',jsonb_build_object('typed_name','Professora Link','content_hash',hash,'accepted',true,'has_authority',true))->>'error'='link_invalido','link usado duas vezes');
 perform pg_temp.tl_assert(public.student_term_link_view(t_tok)->>'reason'='used','link usado ainda abre');
 perform pg_temp.tl_assert(coalesce(current_setting('request.jwt.claims',true),'')='','identidade do link vazou da funcao');

 -- 4. Escola assina por último com a família já confirmada: termo executa.
 update private.teacher_student_terms set family_confirmed_at=now(),family_confirmation='{"kind":"FIXTURE"}' where id=term;
 r:=public.student_term_link_act(s_tok,'sign',jsonb_build_object('typed_name','Diretor Link','content_hash',hash,'accepted',true,'has_authority',true));
 perform pg_temp.tl_assert(r->>'ok'='true' and r->>'status'='EXECUTED','escola por ultimo nao executou: '||r::text);

 -- 5. Professor sem dados: preenche pelo link e só então a escola recebe o dela.
 perform set_config('request.jwt.claims',jsonb_build_object('sub',director,'role','authenticated')::text,true);
 r:=public.teacher_student_terms('prepare',gen_random_uuid(),jsonb_build_object('student_id',student,'teacher_id',teacher2,'mode','RECURRING','starts_on',today+4,'slots','[{"day":4,"time":"10:00"}]'::jsonb));term2:=(r->>'id')::uuid;
 perform set_config('request.jwt.claims','',true);
 perform pg_temp.tl_assert(not exists(select 1 from private.student_term_links where term_id=term2 and signer='SCHOOL'),'escola recebeu link sem os dados do prestador');
 select substring(message_body from 't=([0-9a-f]{64})') into t2_tok from public.notification_queue where idempotency_key=format('student-term-link:%s:teacher:1',term2);
 perform pg_temp.tl_assert(public.student_term_link_view(t2_tok)->>'needs_identity'='true','pagina nao pediu os dados');
 r:=public.student_term_link_act(t2_tok,'identity','{"kind":"INDIVIDUAL","representativeCpf":"529.982.247-25","companyAddress":"Rua do Professor, 20","representativeHasAuthority":true}'::jsonb);
 perform pg_temp.tl_assert(r->>'ok'='true','dados pelo link recusados: '||r::text);
 perform pg_temp.tl_assert(exists(select 1 from private.student_term_links where term_id=term2 and signer='SCHOOL' and used_at is null),'link da escola nao saiu depois dos dados');
 perform pg_temp.tl_assert(public.student_term_link_view(t2_tok)->>'needs_identity'='false','dados nao entraram no termo');
 r:=public.student_term_link_act(t2_tok,'decline','{}');
 perform pg_temp.tl_assert(r->>'ok'='true' and (select status from private.teacher_student_terms where id=term2)='DECLINED','recusa pelo link falhou');

 -- 6. Navegador não lê a tabela de links.
 perform pg_temp.tl_assert(not has_table_privilege('anon','private.student_term_links','SELECT') and not has_table_privilege('authenticated','private.student_term_links','SELECT'),'tabela de links exposta');
 perform pg_temp.tl_assert(has_function_privilege('anon','public.student_term_link_act(text,text,jsonb)','EXECUTE'),'pagina publica sem acesso');

 execute original_eligibility;
end;$test$;
rollback;
