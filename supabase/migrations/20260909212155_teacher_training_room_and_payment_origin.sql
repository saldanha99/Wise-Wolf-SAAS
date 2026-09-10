begin;
-- The acceptance URL is available even while the trainer is setting up a meeting room.
create or replace function private.schedule_teacher_training(p_tenant text,p_actor uuid,p_request text,p_trainer uuid,p_trainee uuid,p_start timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.profiles%rowtype; n public.profiles%rowtype; s public.teacher_training_sessions%rowtype; v_token text; v_phone text; v_link text;
begin
  if length(coalesce(p_request,'')) not between 8 and 200 or p_trainer=p_trainee then raise exception 'Pedido inválido: selecione dois teachers diferentes.'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('training-request:'||p_tenant||':'||p_request,0));
  select * into s from public.teacher_training_sessions where tenant_id=p_tenant and request_id=p_request;
  if found then
    if s.trainer_id<>p_trainer or s.trainee_id<>p_trainee or s.starts_at<>p_start then raise exception 'Este pedido já foi utilizado para outro treinamento.'; end if;
    return jsonb_build_object('ok',true,'id',s.id,'status',s.status,'idempotent',true);
  end if;
  perform private.validate_training_slot(p_tenant,p_trainer,p_trainee,p_start);
  select * into t from public.profiles where id=p_trainer;
  select * into n from public.profiles where id=p_trainee;
  v_phone := regexp_replace(coalesce(nullif(n.attendance_phone,''),n.phone,''),'[^0-9]','','g');
  if length(v_phone) in (10,11) then v_phone:='55'||v_phone; end if;
  if length(v_phone) not between 12 and 15 then raise exception 'O teacher que receberá o treinamento precisa cadastrar seu WhatsApp.'; end if;
  if nullif(btrim(t.meeting_link),'') is not null and btrim(t.meeting_link) !~ '^https://[^[:space:]]+$' then raise exception 'O link da sala cadastrado precisa começar com https://.'; end if;
  insert into public.teacher_training_sessions(tenant_id,trainer_id,trainee_id,trainer_name,trainee_name,trainee_phone,meeting_link,starts_at,ends_at,request_id,created_by,test_fixture)
  values(p_tenant,p_trainer,p_trainee,t.full_name,n.full_name,v_phone,coalesce(btrim(t.meeting_link),''),p_start,p_start+interval '30 minutes',p_request,p_actor,coalesce(t.is_test_account,false) or coalesce(n.is_test_account,false)) returning * into s;
  v_token:=encode(extensions.gen_random_bytes(32),'hex');
  insert into private.teacher_training_invite_tokens values(encode(extensions.digest(v_token,'sha256'),'hex'),s.id,p_start);
  v_link:='https://api.wisewolflanguage.com.br/functions/v1/teacher-training-invite?token='||v_token;
  if not s.test_fixture then
    insert into public.notification_queue(tenant_id,student_name,student_phone,message_body,scheduled_for,source_type,source_id,notification_kind,idempotency_key)
    values(p_tenant,n.full_name,v_phone,'Olá, '||n.full_name||'! Você recebeu um convite para treinamento com '||t.full_name||' em '||to_char(p_start at time zone 'America/Sao_Paulo','DD/MM/YYYY "às" HH24:MI')||' (Brasília), duração de 30 minutos. Confira e aceite pelo link: '||v_link,now(),'teacher_training',s.id,'TEACHER_TRAINING_INVITE','teacher-training-invite:'||s.id);
  end if;
  return jsonb_build_object('ok',true,'id',s.id,'status',s.status,'invitation_queued',not s.test_fixture);
end;
$$;

create or replace function public.teacher_training_invite(p_token text,p_decision text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.teacher_training_sessions%rowtype; v_appointment uuid; v_phone text;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception using errcode='42501',message='service_role_required'; end if;
 if p_token !~ '^[a-f0-9]{64}$' then return jsonb_build_object('ok',false,'error','Convite inválido.'); end if;
 select t.* into s from public.teacher_training_sessions t join private.teacher_training_invite_tokens k on k.session_id=t.id where k.token_hash=encode(extensions.digest(p_token,'sha256'),'hex') and k.expires_at>now() for update of t;
 if not found then return jsonb_build_object('ok',false,'error','Convite inválido ou expirado. Peça um novo agendamento à gestão.'); end if;
 if p_decision is not null and p_decision not in ('accept','decline') then return jsonb_build_object('ok',false,'error','Resposta inválida.'); end if;
 if s.status='PENDING' and p_decision is not null then
   if p_decision='accept' then
     perform private.validate_training_slot(s.tenant_id,s.trainer_id,s.trainee_id,s.starts_at,s.id);
     insert into public.appointments(tenant_id,teacher_id,professor_id,student_name,student_phone,start_time,status,type)
     values(s.tenant_id,s.trainer_id,s.trainer_id,s.trainee_name,s.trainee_phone,s.starts_at,'scheduled','training') returning id into v_appointment;
     update public.teacher_training_sessions set status='CONFIRMED',appointment_id=v_appointment,responded_at=now() where id=s.id returning * into s;
   else
     update public.teacher_training_sessions set status='DECLINED',responded_at=now() where id=s.id returning * into s;
   end if;
   select regexp_replace(coalesce(nullif(attendance_phone,''),phone,''),'[^0-9]','','g') into v_phone from public.profiles where id=s.trainer_id;
   if length(v_phone) in (10,11) then v_phone:='55'||v_phone; end if;
   if not s.test_fixture and length(v_phone) between 12 and 15 then
     insert into public.notification_queue(tenant_id,student_phone,message_body,scheduled_for,source_type,source_id,notification_kind,idempotency_key)
     values(s.tenant_id,v_phone,s.trainee_name||case when s.status='CONFIRMED' then ' aceitou' else ' recusou' end||' o treinamento de '||to_char(s.starts_at at time zone 'America/Sao_Paulo','DD/MM "às" HH24:MI')||'.'||case when s.status='CONFIRMED' then ' Após ministrar o treinamento, registre a conclusão no lançador de aulas para receber R$ 16,00.' else ' Nenhum valor foi lançado.' end,now(),'teacher_training',s.id,'TEACHER_TRAINING_RESPONSE','teacher-training-response:'||s.id);
   end if;
 end if;
 return jsonb_build_object('ok',true,'status',s.status,'trainer',s.trainer_name,'trainee',s.trainee_name,'starts_at',s.starts_at,'ends_at',s.ends_at,'meeting_link',case when s.status='CONFIRMED' then coalesce(nullif(s.meeting_link,''),(select p.meeting_link from public.profiles p where p.id=s.trainer_id and p.meeting_link ~ '^https://[^[:space:]]+$')) else null end);
end;
$$;
notify pgrst,'reload schema';
commit;
