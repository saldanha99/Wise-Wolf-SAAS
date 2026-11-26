-- Família confirma a agenda pelo link do WhatsApp e a troca se aplica sozinha
-- (decisão da direção, 25/11/2026). Caso: a Amábile ficou com escola e Teacher
-- Laís assinadas e a troca parada, porque a confirmação da família só existia no
-- portal (com login) e ninguém avisou a família. E, mesmo completo, o termo de
-- uma troca esperava a direção tocar em "Concluir atribuição da transferência".
--
-- 1. Quando o professor assina, a família (o aluno; o responsável, se for kids)
--    recebe um link pessoal /aceitar-termo?t=... e confirma sem login. O link
--    mostra aluno, professor, dias, horários e início; nunca o valor do professor
--    nem o texto do termo (que é entre escola e professor). Lembrete em 24 h pela
--    rotina de lembretes que já existe.
-- 2. Termo de troca completo (EXECUTED) → a troca vira ACCEPTED e é aplicada já
--    (ou no dia da troca, pela rotina das 6h). A saída do professor segue com o
--    gatilho próprio (zz_departure_apply_on_term_executed).
-- 3. Troca aplicada → aviso ao professor anterior (o aluno saiu da agenda dele)
--    e ao novo (o aluno entrou), fora da saída do professor, que já avisa.

alter table private.student_term_links drop constraint if exists student_term_links_signer_check;
alter table private.student_term_links add constraint student_term_links_signer_check
  check (signer in ('SCHOOL', 'TEACHER', 'FAMILY'));

create or replace function private.student_term_family_phone(p_student uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case when coalesce(s.is_kids, false) and private.whatsapp_digits(nullif(s.guardian_phone, '')) is not null
              then private.whatsapp_digits(nullif(s.guardian_phone, ''))
              else private.whatsapp_digits(nullif(s.phone, '')) end
    from public.profiles s where s.id = p_student;
$$;
alter function private.student_term_family_phone(uuid) owner to postgres;
revoke all on function private.student_term_family_phone(uuid) from public, anon, authenticated, service_role;

create or replace function private.student_term_issue_link(p_term uuid,p_signer text,p_reminder boolean default false)
returns boolean language plpgsql security definer set search_path='' as $$
declare r private.teacher_student_terms;v_signer uuid;v_phone text;v_token text;v_url text;v_msg text;v_first text;v_n int;v_name text;
begin
 select * into r from private.teacher_student_terms where id=p_term;
 if r.id is null or r.status<>'PROPOSED' or r.retired_at is not null then return false;end if;
 if p_signer='TEACHER' then
  if r.teacher_signed_at is not null or not public.teacher_opportunity_recipient_eligible(r.tenant_id,r.teacher_id) then return false;end if;
  v_signer:=r.teacher_id;
 elsif p_signer='SCHOOL' then
  if r.school_signed_at is not null or r.provider_identity is null then return false;end if;
  v_signer:=private.student_term_school_signer(r.tenant_id);
 elsif p_signer='FAMILY' then
  -- Família só confirma depois que o professor aceitou: não pede confirmação de
  -- agenda com professor que ainda pode recusar.
  if r.family_confirmed_at is not null or r.teacher_signed_at is null or not public.is_student_notifiable(r.student_id) then return false;end if;
  v_signer:=r.student_id;
 else return false;end if;
 select case when p_signer='SCHOOL' then private.student_term_school_signer_phone(r.tenant_id,v_signer)
             when p_signer='FAMILY' then private.student_term_family_phone(v_signer)
             else private.whatsapp_digits(nullif(p.phone,'')) end,p.full_name into v_phone,v_name from public.profiles p where p.id=v_signer;
 v_url:=private.lesson_recording_portal_url(r.tenant_id);
 if v_signer is null or v_phone is null or v_url is null then return false;end if;
 update private.student_term_links set revoked_at=clock_timestamp() where term_id=r.id and signer=p_signer and used_at is null and revoked_at is null;
 v_token:=encode(extensions.gen_random_bytes(32),'hex');
 insert into private.student_term_links(token_hash,term_id,signer,signer_id,phone,expires_at,reminded_at)
 values(encode(extensions.digest(v_token,'sha256'),'hex'),r.id,p_signer,v_signer,v_phone,now()+interval '7 days',case when p_reminder then clock_timestamp() end);
 select count(*) into v_n from private.student_term_links where term_id=r.id and signer=p_signer;
 v_url:=v_url||'/aceitar-termo?t='||v_token;
 v_first:=split_part(btrim(v_name),' ',1);
 if p_signer='TEACHER' then
  v_msg:=format(E'%sOi, %s! 🐺 Aluno novo para você: *%s*\n📅 %s, a partir de %s.\n\nAo aceitar, você assume este aluno nesses horários (o termo traz as regras de falta e de saída). Toque no link, confira e assine (leva 1 minuto):\n%s\n\nSe não puder atender, é só tocar em "Não posso atender" na mesma página.',
   case when p_reminder then E'⏰ Lembrete: ' else '' end,v_first,r.student_name,private.student_term_agenda_text(r.slots),to_char(r.starts_on,'DD/MM'),v_url);
 elsif p_signer='FAMILY' then
  v_msg:=format(E'%sOi, %s! 🐺 Para concluir a mudança das suas aulas para o(a) teacher *%s*, confirme sua agenda:\n📅 %s, a partir de %s.\n\nÉ só tocar no link e confirmar (leva 10 segundos):\n%s',
   case when p_reminder then E'⏰ Lembrete: ' else '' end,v_first,r.teacher_name,private.student_term_agenda_text(r.slots),to_char(r.starts_on,'DD/MM'),v_url);
 else
  v_msg:=format(E'%s📝 Termo do aluno *%s* com %s para a escola assinar.\n📅 %s, a partir de %s.\n\nAssine por aqui:\n%s',
   case when p_reminder then E'⏰ Lembrete: ' else '' end,r.student_name,r.teacher_name,private.student_term_agenda_text(r.slots),to_char(r.starts_on,'DD/MM'),v_url);
 end if;
 insert into public.notification_queue(tenant_id,teacher_id,student_id,student_name,student_phone,message_body,scheduled_for,next_attempt_at,status,source_type,notification_kind,idempotency_key)
 values(r.tenant_id,case when p_signer='SCHOOL' then v_signer else r.teacher_id end,r.student_id,v_name,v_phone,v_msg,private.student_term_send_at(now()),private.student_term_send_at(now()),'pending','MANAGEMENT_NOTICE','MANAGEMENT_NOTICE',format('student-term-link:%s:%s:%s',r.id,lower(p_signer),v_n))
 on conflict(tenant_id,idempotency_key) where idempotency_key is not null do nothing;
 return true;
end;$$;
alter function private.student_term_issue_link(uuid,text,boolean) owner to postgres;

create or replace function public.student_term_link_view(p_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare l private.student_term_links;r private.teacher_student_terms;v_name text;v_school text;v_identity jsonb;
begin
 l:=private.student_term_link_open(p_token);
 if l.token_hash is null then
  select * into l from private.student_term_links where p_token ~ '^[0-9a-f]{64}$' and token_hash=encode(extensions.digest(p_token,'sha256'),'hex');
  return jsonb_build_object('ok',false,'reason',case when l.token_hash is null then 'invalid' when l.used_at is not null then 'used' when l.revoked_at is not null then 'replaced' else 'expired' end);
 end if;
 select * into r from private.teacher_student_terms where id=l.term_id;
 if r.status<>'PROPOSED' then return jsonb_build_object('ok',false,'reason',lower(r.status));end if;
 if (l.signer='TEACHER' and r.teacher_signed_at is not null) or (l.signer='SCHOOL' and r.school_signed_at is not null)
    or (l.signer='FAMILY' and r.family_confirmed_at is not null) then return jsonb_build_object('ok',false,'reason','used');end if;
 update private.student_term_links set opened_at=coalesce(opened_at,clock_timestamp()) where token_hash=l.token_hash;
 select full_name into v_name from public.profiles where id=l.signer_id;
 v_school:=coalesce(r.school_snapshot->>'legalName',r.school_snapshot->>'name',r.tenant_id);
 if l.signer='FAMILY' then
  -- A família vê só a agenda: o valor do professor e o termo são entre escola e professor.
  return jsonb_build_object('ok',true,'signer','FAMILY','signer_name',v_name,'school_name',v_school,
   'student_name',r.student_name,'teacher_name',r.teacher_name,'agenda',private.student_term_agenda_text(r.slots),
   'starts_on',r.starts_on,'ends_on',r.ends_on,'term_id',r.id,'expires_at',l.expires_at);
 end if;
 if l.signer='TEACHER' then select i.identity into v_identity from private.teacher_service_identities i where i.tenant_id=r.tenant_id and i.teacher_id=r.teacher_id;end if;
 return jsonb_build_object('ok',true,'signer',l.signer,'signer_name',v_name,'school_name',v_school,
  'student_name',r.student_name,'teacher_name',r.teacher_name,'agenda',private.student_term_agenda_text(r.slots),
  'starts_on',r.starts_on,'ends_on',r.ends_on,'unit_rate',r.unit_rate,
  'needs_identity',r.provider_identity is null,'identity_on_file',v_identity is not null,
  'other_signed',case when l.signer='TEACHER' then r.school_signed_at is not null else r.teacher_signed_at is not null end,
  'body',r.body,'content_hash',r.content_hash,'term_id',r.id,'version',r.version,'expires_at',l.expires_at);
end;$$;
alter function public.student_term_link_view(text) owner to postgres;

create or replace function public.student_term_link_act(p_token text,p_action text,p_payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare l private.student_term_links;r private.teacher_student_terms;v_result jsonb;h jsonb;v_ip text;v_ua text;
begin
 if p_action not in('identity','sign','decline','confirm') then return jsonb_build_object('ok',false,'error','acao_invalida');end if;
 l:=private.student_term_link_open(p_token);
 if l.token_hash is null then return jsonb_build_object('ok',false,'error','link_invalido');end if;
 if p_action in('identity','decline') and l.signer<>'TEACHER' then return jsonb_build_object('ok',false,'error','acao_invalida');end if;
 if (p_action='confirm') <> (l.signer='FAMILY') then return jsonb_build_object('ok',false,'error','acao_invalida');end if;
 h:=coalesce(nullif(current_setting('request.headers',true),'')::jsonb,'{}');
 v_ip:=left(btrim(split_part(coalesce(h->>'x-real-ip',h->>'cf-connecting-ip',h->>'x-forwarded-for',''),',',1)),64);
 v_ua:=left(coalesce(h->>'user-agent',''),300);
 select * into r from private.teacher_student_terms where id=l.term_id;
 perform private.trial_closing_act_as(l.signer_id);
 begin
  if p_action='confirm' then
   -- Mesma RPC do portal; a agenda conferida é a do termo deste link.
   v_result:=public.teacher_student_terms('family_confirm',l.term_id,jsonb_build_object('confirmed',true,
    'schedule_hash',encode(extensions.digest(jsonb_build_object('id',r.id,'slots',r.slots,'from',r.starts_on,'until',r.ends_on)::text,'sha256'),'hex')));
  else
   v_result:=public.teacher_student_terms(p_action,case when p_action='identity' then null else l.term_id end,
    case when p_action='sign' then jsonb_build_object('typed_name',p_payload->>'typed_name','content_hash',p_payload->>'content_hash','accepted',p_payload->'accepted','has_authority',p_payload->'has_authority') else coalesce(p_payload,'{}') end);
  end if;
 exception when others then
  perform private.trial_closing_act_as(null);
  return jsonb_build_object('ok',false,'error',sqlerrm);
 end;
 perform private.trial_closing_act_as(null);
 select * into r from private.teacher_student_terms where id=l.term_id;
 if p_action='identity' then
  return jsonb_build_object('ok',true);
 end if;
 update private.student_term_links set used_at=clock_timestamp() where token_hash=l.token_hash;
 insert into private.teacher_student_term_events(term_id,actor_id,event,content_hash,details)
 values(r.id,l.signer_id,case p_action when 'sign' then 'SIGNED_VIA_WHATSAPP_LINK' when 'confirm' then 'FAMILY_CONFIRMED_VIA_WHATSAPP_LINK' else 'DECLINED_VIA_WHATSAPP_LINK' end,r.content_hash,
  jsonb_build_object('signer',l.signer,'phone',l.phone,'ip',nullif(v_ip,''),'user_agent',nullif(v_ua,''),'link_created_at',l.created_at));
 return jsonb_build_object('ok',true,'phase',private.student_term_phase(r),'status',r.status);
end;$$;
alter function public.student_term_link_act(text,text,jsonb) owner to postgres;
grant execute on function public.student_term_link_view(text) to anon,authenticated;
grant execute on function public.student_term_link_act(text,text,jsonb) to anon,authenticated;

-- Professor assinou e a família ainda não confirmou → link para a família.
create or replace function private.student_term_teacher_signed_family_link()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.teacher_signed_at is null and new.teacher_signed_at is not null and new.status='PROPOSED' and new.family_confirmed_at is null
  and not exists(select 1 from private.student_term_links where term_id=new.id and signer='FAMILY' and used_at is null and revoked_at is null and expires_at>now()) then
  begin perform private.student_term_issue_link(new.id,'FAMILY');
  exception when others then raise warning '[termo individual] link da família não enfileirado para %: %',new.id,sqlerrm;end;
 end if;
 return null;
end;$$;
alter function private.student_term_teacher_signed_family_link() owner to postgres;
revoke all on function private.student_term_teacher_signed_family_link() from public, anon, authenticated, service_role;
drop trigger if exists zz_student_term_family_link on private.teacher_student_terms;
create trigger zz_student_term_family_link after update of teacher_signed_at on private.teacher_student_terms
 for each row execute function private.student_term_teacher_signed_family_link();

-- Termo de troca completo → a troca se aplica sozinha (a saída do professor tem gatilho próprio).
create or replace function private.student_term_apply_transfer_on_executed()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.status is distinct from 'EXECUTED' or old.status is not distinct from 'EXECUTED' or new.source_kind <> 'TRANSFER' then return null;end if;
 if exists(select 1 from public.teacher_departure_offers o where o.transfer_id=new.source_id) then return null;end if;
 begin
  update public.teacher_transfers set status='ACCEPTED',decided_at=coalesce(decided_at,now())
   where id=new.source_id and tenant_id=new.tenant_id and status='PENDING';
  -- Aplica já se a data da troca chegou; senão a rotina das 6h aplica no dia.
  perform public.apply_teacher_transfer(new.source_id);
  insert into private.teacher_student_term_events(term_id,actor_id,event,content_hash,details)
  values(new.id,null,'TRANSFER_APPLIED_AUTOMATICALLY',new.content_hash,jsonb_build_object('transfer_id',new.source_id));
 exception when others then
  raise warning '[termo individual] troca % não aplicada após o termo: %',new.source_id,sqlerrm;
 end;
 return null;
end;$$;
alter function private.student_term_apply_transfer_on_executed() owner to postgres;
revoke all on function private.student_term_apply_transfer_on_executed() from public, anon, authenticated, service_role;
drop trigger if exists zz_student_term_apply_transfer on private.teacher_student_terms;
create trigger zz_student_term_apply_transfer after update of status on private.teacher_student_terms
 for each row execute function private.student_term_apply_transfer_on_executed();

-- Troca aplicada → avisa os dois professores (a saída do professor já avisa pelo fluxo dela).
create or replace function private.teacher_transfer_applied_notify_teachers()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_student text;v_from text;v_from_phone text;v_to text;v_to_phone text;v_agenda text;
begin
 if new.status is distinct from 'APPLIED' or old.status is not distinct from 'APPLIED' then return null;end if;
 if exists(select 1 from public.teacher_departure_offers o where o.transfer_id=new.id) then return null;end if;
 begin
  select full_name into v_student from public.profiles where id=new.student_id;
  select full_name,private.whatsapp_digits(nullif(phone,'')) into v_from,v_from_phone from public.profiles where id=new.from_teacher_id;
  select full_name,private.whatsapp_digits(nullif(phone,'')) into v_to,v_to_phone from public.profiles where id=new.to_teacher_id;
  v_agenda:=private.student_term_agenda_text(new.proposed_slots);
  if v_from_phone is not null and new.from_teacher_id is distinct from new.to_teacher_id then
   insert into public.notification_queue(tenant_id,teacher_id,student_id,student_name,student_phone,message_body,scheduled_for,next_attempt_at,status,source_type,notification_kind,idempotency_key)
   values(new.tenant_id,new.from_teacher_id,new.student_id,v_from,v_from_phone,
    format(E'Oi, %s! 🐺 O aluno *%s* foi transferido para o(a) teacher %s a partir de %s e saiu da sua agenda. Obrigado por tudo até aqui!',
     split_part(btrim(v_from),' ',1),v_student,v_to,to_char(new.cutover_date,'DD/MM')),
    private.student_term_send_at(now()),private.student_term_send_at(now()),'pending','MANAGEMENT_NOTICE','MANAGEMENT_NOTICE',format('teacher-transfer:%s:applied:from',new.id))
   on conflict(tenant_id,idempotency_key) where idempotency_key is not null do nothing;
  end if;
  if v_to_phone is not null then
   insert into public.notification_queue(tenant_id,teacher_id,student_id,student_name,student_phone,message_body,scheduled_for,next_attempt_at,status,source_type,notification_kind,idempotency_key)
   values(new.tenant_id,new.to_teacher_id,new.student_id,v_to,v_to_phone,
    format(E'Oi, %s! 🐺 Tudo assinado: *%s* entrou na sua agenda.\n📅 %s, a partir de %s.',
     split_part(btrim(v_to),' ',1),v_student,v_agenda,to_char(new.cutover_date,'DD/MM')),
    private.student_term_send_at(now()),private.student_term_send_at(now()),'pending','MANAGEMENT_NOTICE','MANAGEMENT_NOTICE',format('teacher-transfer:%s:applied:to',new.id))
   on conflict(tenant_id,idempotency_key) where idempotency_key is not null do nothing;
  end if;
 exception when others then
  raise warning '[troca de professor] aviso aos professores falhou para %: %',new.id,sqlerrm;
 end;
 return null;
end;$$;
alter function private.teacher_transfer_applied_notify_teachers() owner to postgres;
revoke all on function private.teacher_transfer_applied_notify_teachers() from public, anon, authenticated, service_role;
drop trigger if exists zz_teacher_transfer_applied_notify_teachers on public.teacher_transfers;
create trigger zz_teacher_transfer_applied_notify_teachers after update of status on public.teacher_transfers
 for each row execute function private.teacher_transfer_applied_notify_teachers();

-- Termos que já têm o aceite do professor e esperam a família (ex.: Amábile):
-- link agora, uma vez.
do $backfill$
declare t record;
begin
 if exists(select 1 from public.schema_one_shots where key='familia_confirma_agenda_por_link_backfill_20261125') then return;end if;
 for t in select id from private.teacher_student_terms
   where status='PROPOSED' and retired_at is null and teacher_signed_at is not null and family_confirmed_at is null loop
  begin perform private.student_term_issue_link(t.id,'FAMILY');
  exception when others then raise warning '[termo individual] backfill do link da família falhou para %: %',t.id,sqlerrm;end;
 end loop;
 insert into public.schema_one_shots(key,applied_at,nota) values('familia_confirma_agenda_por_link_backfill_20261125',now(),'Link da família para termos já aceitos pelo professor');
end $backfill$;
