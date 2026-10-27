-- Reexecutável. Conserta o termo individual ativado em 27/10/2026 sem reescrever
-- termo, assinatura, agenda ou lançamento existente.
--
-- O que estava errado (medido em produção, transação revertida):
--  1. Lançar falta (do aluno ou do professor) cria reposição com date='Pendente';
--     o gatilho fazia 'Pendente'::date e o lançamento inteiro era recusado
--     ("falha_no_lancamento").
--  2. Reposição e troca de horário de quem já era aluno antes da política exigiam
--     termo — assinatura retroativa da carteira, que a direção não pediu.
--  3. Nenhum aviso saía quando um termo esperava assinatura; o aluno da matrícula
--     por link ficava parado em "volte depois".
--  4. set_student_status mudava o status sem passar pelo financeiro.

-- Aluno que já existia antes da política, com o mesmo professor de hoje. Não vale
-- para professor novo: esse continua exigindo termo (transferência, cobertura,
-- ficha com outro titular).
create or replace function private.student_term_legacy_relationship(p_tenant text,p_student uuid,p_teacher uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(
  select 1 from public.profiles s join private.teacher_student_term_policy cfg on cfg.tenant_id=s.tenant_id
  where s.id=p_student and s.tenant_id=p_tenant and s.role='STUDENT' and s.created_at<cfg.starts_at
   and (p_teacher in(s.professor_id,s.professor_id2)
    or exists(select 1 from public.bookings b where b.tenant_id=p_tenant and b.student_id=p_student and b.teacher_id=p_teacher
      and upper(coalesce(b.status,''))='SCHEDULED' and b.created_at<cfg.starts_at)));
$$;

-- Reposição é a mesma prestação já contratada: vale para o professor com vínculo
-- antigo ou com termo assinado e vigente com aquele aluno.
create or replace function private.student_term_covers_reschedule(p_tenant text,p_student uuid,p_teacher uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select private.student_term_legacy_relationship(p_tenant,p_student,p_teacher)
  or exists(select 1 from private.teacher_student_terms t where t.tenant_id=p_tenant and t.student_id=p_student and t.teacher_id=p_teacher
   and t.status='EXECUTED' and t.retired_at is null and private.student_term_source_valid(t));
$$;

create or replace function private.guard_student_individual_term()
returns trigger language plpgsql security definer set search_path='' as $$
declare t text;sid uuid;teacher uuid;day integer;tm text;from_date date;occurrence date;mode text;oid uuid;tid uuid;b public.bookings;old_shape jsonb;new_shape jsonb;policy_start timestamptz;
begin
 t:=new.tenant_id;
 if not private.student_term_required(t,null) then return new;end if;
 if tg_table_name='bookings' then
  if upper(coalesce(new.status,'SCHEDULED'))<>'SCHEDULED' then return new;end if;
  sid:=new.student_id;teacher:=new.teacher_id;day:=public.dow_name_to_int(new.day_of_week);tm:=new.time_slot;from_date:=coalesce(new.start_date,new.date,(now() at time zone 'America/Sao_Paulo')::date);occurrence:=new.date;oid:=new.enrollment_offer_id;
  if tg_op='UPDATE' and upper(coalesce(old.status,'SCHEDULED'))='SCHEDULED' and row(new.tenant_id,new.student_id,new.teacher_id,new.day_of_week,new.time_slot,new.start_date,new.date,new.type) is not distinct from row(old.tenant_id,old.student_id,old.teacher_id,old.day_of_week,old.time_slot,old.start_date,old.date,old.type) then return new;end if;
  if not private.student_term_required(t,oid) then return new;end if;
  -- Aluno antigo com o mesmo professor: troca de horário não exige termo retroativo.
  if sid is not null and teacher is not null and private.student_term_legacy_relationship(t,sid,teacher) then return new;end if;
  if tg_op='UPDATE' and row(new.day_of_week,new.time_slot) is distinct from row(old.day_of_week,old.time_slot) then select greatest(from_date,max(valid_from)) into from_date from public.booking_schedule_versions where booking_id=new.id and tenant_id=t and day_of_week=public.canonical_weekday_name(new.day_of_week) and left(time_slot,5)=left(new.time_slot,5) and valid_until is null;end if;
 elsif tg_table_name='booking_schedule_versions' then
  select * into b from public.bookings where id=new.booking_id and tenant_id=t;
  sid:=b.student_id;teacher:=b.teacher_id;day:=public.dow_name_to_int(new.day_of_week);tm:=new.time_slot;from_date:=new.valid_from;
  if tg_op='UPDATE' and row(old.booking_id,old.tenant_id,old.valid_from,old.day_of_week,old.time_slot) is not distinct from row(new.booking_id,new.tenant_id,new.valid_from,new.day_of_week,new.time_slot) and(new.valid_until is not distinct from old.valid_until or(new.valid_until is not null and(old.valid_until is null or new.valid_until<=old.valid_until))) then return new;end if;
  select starts_at into policy_start from private.teacher_student_term_policy where tenant_id=t;
  if tg_op='INSERT' and b.created_at<policy_start and new.request_id is null and day=public.dow_name_to_int(b.day_of_week) and left(tm,5)=left(b.time_slot,5) and new.valid_from=coalesce(b.start_date,(b.created_at at time zone 'America/Sao_Paulo')::date) then return new;end if;
  if sid is not null and teacher is not null and private.student_term_legacy_relationship(t,sid,teacher) then return new;end if;
 elsif tg_table_name='reschedules' then
  -- Reposição sem data ("Pendente") ainda não é ocorrência; nasce no lançamento
  -- da falta e não pode derrubá-lo. A data é conferida quando for marcada.
  if coalesce(new.date,'') !~ '^\d{4}-\d{2}-\d{2}$' then return new;end if;
  sid:=new.student_id;teacher:=new.teacher_id;occurrence:=new.date::date;day:=extract(dow from occurrence)::int;tm:=new.time;from_date:=occurrence;
  if tg_op='UPDATE' and row(new.tenant_id,new.student_id,new.teacher_id,new.date,new.time) is not distinct from row(old.tenant_id,old.student_id,old.teacher_id,old.date,old.time) then return new;end if;
  if sid is not null and teacher is not null and private.student_term_covers_reschedule(t,sid,teacher) then return new;end if;
 elsif tg_table_name='class_coverages' then
  if lower(coalesce(new.status,''))<>'confirmed' then return new;end if;
  select * into b from public.bookings where id=new.booking_id and tenant_id=t;
  sid:=coalesce(new.student_id,b.student_id);teacher:=new.cover_teacher_id;occurrence:=new.class_date;day:=extract(dow from occurrence)::int;tm:=new.class_time;from_date:=occurrence;
  select starts_at into policy_start from private.teacher_student_term_policy where tenant_id=t;
  if new.confirmed_by is not null and occurrence<(policy_start at time zone 'America/Sao_Paulo')::date then return new;end if;
  if tg_op='UPDATE' and lower(old.status)='confirmed' and row(new.tenant_id,new.student_id,new.cover_teacher_id,new.class_date,new.class_time,new.booking_id) is not distinct from row(old.tenant_id,old.student_id,old.cover_teacher_id,old.class_date,old.class_time,old.booking_id) then return new;end if;
 end if;
 if sid is null or teacher is null then return new;end if;
 -- Treinamento de professores não é matrícula de aluno.
 if not exists(select 1 from public.profiles where id=sid and tenant_id=t and role='STUDENT') then return new;end if;
 if tg_table_name='bookings' and occurrence is null and private.student_term_legacy_transfer_allows(t,sid,teacher,day,tm,from_date) then return new;end if;
 mode:=case when occurrence is null then 'RECURRING' else 'DATED' end;
 tid:=private.student_term_match(t,sid,teacher,mode,day,tm,from_date,occurrence);
 if tid is null and occurrence is not null and tg_table_name='reschedules' then tid:=private.student_term_match(t,sid,teacher,'RECURRING',day,tm,from_date);end if;
 if tid is not null and tg_table_name='class_coverages' then
  if new.offered_rate is not null and not exists(select 1 from private.teacher_student_terms where id=tid and unit_rate=new.offered_rate) then tid:=null;end if;
 end if;
 if tid is null then raise exception using errcode='PT412',message='Assinatura do termo individual pendente. Abra Contratos > Termos por aluno.',detail='teacher_student_term_required';end if;
 if tg_when='AFTER' then
  with ended as(update private.teacher_student_term_bindings set ended_at=now() where entity_table=tg_table_name and entity_id=new.id and term_id<>tid and ended_at is null returning term_id) update private.teacher_student_terms set retired_at=coalesce(retired_at,now()) where id in(select term_id from ended);
  insert into private.teacher_student_term_bindings(entity_table,entity_id,term_id) values(tg_table_name,new.id,tid) on conflict(entity_table,entity_id,term_id) do nothing;
 end if;
 return new;
end;$$;

-- Troca de horário do aluno antigo com o mesmo professor segue direto para a RPC
-- da tela (vigência futura, choque, aviso) em vez de virar proposta de termo.
do $patch$
declare s text;anchor text;
begin
 s:=pg_get_functiondef('private.student_term_stage_schedule(uuid,jsonb,date,text)'::regprocedure);
 if strpos(s,'student_term_legacy_relationship')=0 then
  anchor:='  if(public.booking_schedule_on_date(b.id,p_from)->>''day_of_week'')';
  if strpos(s,anchor)=0 then raise exception 'stage_schedule_anchor_changed';end if;
  execute replace(s,anchor,E'  if private.student_term_legacy_relationship(tenant,p_student,b.teacher_id) then continue;end if;\n'||anchor);
 end if;
end;$patch$;

-- Aviso de termo esperando assinatura: a direção quando a proposta nasce, o
-- professor quando a escola assina (ele só assina depois). Pela fila oficial,
-- idempotente por termo e evento; falha no aviso nunca derruba a proposta.
create or replace function private.student_term_notify()
returns trigger language plpgsql security definer set search_path='' as $$
declare r private.teacher_student_terms;v_dest text;v_msg text;v_phone text;v_origin text;v_actor uuid;
begin
 if new.event not in('PROPOSED','SCHOOL_SIGNED') then return new;end if;
 select * into r from private.teacher_student_terms where id=new.term_id;
 if r.id is null or r.status<>'PROPOSED' then return new;end if;
 v_origin:=case r.source_kind when 'ENROLLMENT' then 'matrícula nova (o aluno está aguardando para seguir ao pagamento)'
  when 'COVERAGE' then 'cobertura' when 'COVERAGE_OPPORTUNITY' then 'cobertura do dia' when 'TRANSFER' then 'transferência de professor'
  when 'SCHEDULE_CHANGE' then 'mudança de horário' else 'atendimento manual/reposição' end;
 begin
  v_actor:=private.management_group_default_actor(r.tenant_id);
  if new.event='PROPOSED' then
   v_dest:=private.tenant_notice_destination(r.tenant_id,'direcao');
   if v_dest is null then return new;end if;
   v_msg:=format(E'📝 Termo individual aguardando assinatura da escola\nAluno: %s\nProfessor: %s\nOrigem: %s\nInício: %s\n\nAssine em Contratos → Termos por aluno. Depois o professor recebe o aviso para assinar.',
     r.student_name,r.teacher_name,v_origin,to_char(r.starts_on,'DD/MM/YYYY'));
   insert into public.notification_queue(tenant_id,teacher_id,student_id,student_name,student_phone,message_body,scheduled_for,status,source_type,notification_kind,idempotency_key)
   values(r.tenant_id,coalesce(v_actor,r.teacher_id),r.student_id,'Direção',v_dest,v_msg,now(),'pending','MANAGEMENT_NOTICE','MANAGEMENT_NOTICE',format('student-term:%s:proposed',r.id))
   on conflict(tenant_id,idempotency_key) where idempotency_key is not null do nothing;
  else
   select private.whatsapp_digits(nullif(p.phone,'')) into v_phone from public.profiles p where p.id=r.teacher_id;
   if v_phone is null or not public.teacher_opportunity_recipient_eligible(r.tenant_id,r.teacher_id) then return new;end if;
   v_msg:=format(E'Oi, %s! 🐺 A escola assinou o termo individual do aluno %s (%s, início %s).\n\nPara confirmar o atendimento, abra o portal em Meu Contrato → Termos por aluno, confira e assine. Se não puder assumir, use Recusar.',
     split_part(btrim(r.teacher_name),' ',1),r.student_name,v_origin,to_char(r.starts_on,'DD/MM/YYYY'));
   insert into public.notification_queue(tenant_id,teacher_id,student_id,student_name,student_phone,message_body,scheduled_for,status,source_type,notification_kind,idempotency_key)
   values(r.tenant_id,r.teacher_id,r.student_id,r.teacher_name,v_phone,v_msg,now(),'pending','MANAGEMENT_NOTICE','MANAGEMENT_NOTICE',format('student-term:%s:school-signed',r.id))
   on conflict(tenant_id,idempotency_key) where idempotency_key is not null do nothing;
  end if;
 exception when others then
  raise warning '[termo individual] aviso não enfileirado para %: %',r.id,sqlerrm;
 end;
 return new;
end;$$;
drop trigger if exists zz_student_term_notify on private.teacher_student_term_events;
create trigger zz_student_term_notify after insert on private.teacher_student_term_events for each row execute function private.student_term_notify();

do $$declare r record;begin
 for r in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='private' and p.proname in('student_term_legacy_relationship','student_term_covers_reschedule','guard_student_individual_term','student_term_stage_schedule','student_term_notify') loop
  execute format('alter function %s owner to postgres',r.signature);
  execute format('revoke all on function %s from public,anon,authenticated,service_role',r.signature);
 end loop;
end$$;

-- A fachada antiga mudava o status do aluno sem parar a recorrência no Asaas.
-- Continua sendo uma fachada autenticada (auditoria de SECURITY DEFINER), mas
-- recusa a transição: pausa, reativação e encerramento passam pelo fluxo oficial.
create or replace function public.set_student_status(p_student_id uuid,p_status text)
returns jsonb language plpgsql security definer set search_path='' as $function$
begin
 if not private.can_execute_legacy_role_rpc(array['SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR']::text[]) then
  return pg_catalog.jsonb_build_object('ok',false,'error','sem_permissao');
 end if;
 raise exception using errcode='42501',message='student_lifecycle_requires_school_admin',
  hint='Use pausar, reativar ou encerrar na ficha do aluno: o fluxo oficial também ajusta a cobrança.';
end;
$function$;
alter function public.set_student_status(uuid,text) owner to postgres;
revoke all on function public.set_student_status(uuid,text) from public,anon;
grant execute on function public.set_student_status(uuid,text) to authenticated,service_role;
