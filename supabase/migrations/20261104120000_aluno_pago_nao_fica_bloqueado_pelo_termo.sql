-- Aluno que já pagou não fica preso à tela de pagamento por causa do termo.
--
-- Desde 29/10 o aluno paga antes de escola e professor assinarem o termo
-- individual. A matrícula só chega a COMPLETED depois das assinaturas, e o portal
-- lia "não concluída" como "falta pagar": quem pagou via "Conclua o pagamento
-- para liberar seus estudos" até a escola assinar (caso real em 03-04/11/2026).
--
-- O acesso pedagógico passa a acompanhar o pagamento. Agenda e conclusão da
-- matrícula continuam esperando o termo: a guarda dos termos não muda.

-- BILLING_READY sozinho não prova pagamento (também é gravado ao criar a
-- cobrança), então a prova é a própria cobrança, criada depois da oferta para
-- pagamento de matrícula antiga não valer. Cartão aprovado (CONFIRMED) conta,
-- como na matrícula desde 26/10.
create or replace function private.enrollment_paid_awaiting_terms(p_offer uuid, p_student uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  o public.offers;
  p public.profiles;
  v_duration integer;
begin
  select * into o from public.offers
   where id = p_offer and kind = 'ENROLLMENT' and processing_by = p_student
     and revoked_at is null and processing_state = 'BILLING_READY';
  if o.id is null then
    return false;
  end if;

  select * into p from public.profiles
   where id = p_student and tenant_id = o.tenant_id and role = 'STUDENT';
  if p.id is null or nullif(p.asaas_customer_id, '') is null then
    return false;
  end if;

  -- Mesmas pré-condições financeiras de complete_enrollment_offer: só o termo
  -- pode estar faltando.
  v_duration := coalesce(nullif(o.payload ->> 'planDuration', '')::integer, 1);
  if v_duration = 0 then
    if nullif(o.metadata ->> 'one_time_paid_at', '') is null then
      return false;
    end if;
  elsif nullif(p.subscription_id, '') is null then
    return false;
  end if;
  if coalesce(o.enrollment_fee, 0) > 0 and coalesce(p.enrollment_fee_paid, false) is false then
    return false;
  end if;

  if not exists (
    select 1 from private.teacher_student_terms t
     where t.source_kind = 'ENROLLMENT' and t.source_id = o.id
       and t.student_id = p_student and t.status = 'PROPOSED' and t.retired_at is null
  ) then
    return false;
  end if;

  return exists (
    select 1 from public.student_payments sp
     where sp.student_id = p_student and sp.tenant_id = o.tenant_id
       and sp.created_at >= o.created_at
       and sp.status in ('RECEIVED', 'RECEIVED_IN_CASH', 'CONFIRMED')
       and sp.refunded_amount = 0
  );
end;
$function$;

-- Superfície da edge student-context.
create or replace function public.student_paid_awaiting_teacher_terms(p_student uuid, p_tenant text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if (select auth.jwt() ->> 'role') is distinct from 'service_role' then
    raise exception 'service_required' using errcode = '42501';
  end if;
  return exists (
    select 1 from public.offers o
     where o.tenant_id = p_tenant and o.kind = 'ENROLLMENT' and o.processing_by = p_student
       and private.enrollment_paid_awaiting_terms(o.id, p_student)
  );
end;
$function$;

-- Lembrete: com o aluno já pago, a assinatura pendente é lembrada em 2 h, não em
-- 24 h (quem matricula de noite começa no dia seguinte). O resto segue igual.
create or replace function private.student_term_link_reminders()
returns jsonb language plpgsql security definer set search_path='' as $function$
declare l record;v_dest text;n_rem int:=0;n_stale int:=0;h int:=extract(hour from now() at time zone 'America/Sao_Paulo');
begin
 if h<9 or h>=21 then return jsonb_build_object('ok',true,'skipped','fora_do_horario');end if;
 for l in select k.term_id,k.signer from private.student_term_links k join private.teacher_student_terms t on t.id=k.term_id
  where k.used_at is null and k.revoked_at is null and k.reminded_at is null and t.status='PROPOSED'
   and (k.created_at<now()-interval '24 hours'
    or (k.created_at<now()-interval '2 hours' and t.source_kind='ENROLLMENT' and private.enrollment_paid_awaiting_terms(t.source_id,t.student_id)))
   and not exists(select 1 from private.student_term_links o where o.term_id=k.term_id and o.signer=k.signer and o.reminded_at is not null)
 loop
  begin if private.student_term_issue_link(l.term_id,l.signer,true) then n_rem:=n_rem+1;end if;
  exception when others then raise warning '[termo individual] lembrete falhou para %: %',l.term_id,sqlerrm;end;
 end loop;
 for l in select t.* from private.teacher_student_terms t where t.status='PROPOSED' and t.retired_at is null and t.created_at<now()-interval '48 hours'
  and exists(select 1 from private.student_term_links k where k.term_id=t.id) loop
  begin
   v_dest:=private.tenant_notice_destination(l.tenant_id,'coordenacao');
   if v_dest is null then continue;end if;
   insert into public.notification_queue(tenant_id,teacher_id,student_id,student_name,student_phone,message_body,scheduled_for,status,source_type,notification_kind,idempotency_key)
   values(l.tenant_id,l.teacher_id,l.student_id,'Coordenação',v_dest,
    format(E'⏳ Termo do aluno %s com %s parado há mais de 2 dias.\nFalta: %s.\nO aluno não começa enquanto isso não for assinado.',l.student_name,l.teacher_name,
     concat_ws(' e ',case when l.school_signed_at is null then 'assinatura da escola' end,case when l.teacher_signed_at is null then 'assinatura de '||split_part(l.teacher_name,' ',1) end,case when l.family_confirmed_at is null then 'confirmação da agenda pela família' end)),
    now(),'pending','MANAGEMENT_NOTICE','MANAGEMENT_NOTICE',format('student-term:%s:stale',l.id))
   on conflict(tenant_id,idempotency_key) where idempotency_key is not null do nothing;
   if found then n_stale:=n_stale+1;end if;
  exception when others then raise warning '[termo individual] aviso de termo parado falhou para %: %',l.id,sqlerrm;end;
 end loop;
 return jsonb_build_object('ok',true,'reminders',n_rem,'stale',n_stale);
end;$function$;

alter function private.enrollment_paid_awaiting_terms(uuid, uuid) owner to postgres;
alter function private.student_term_link_reminders() owner to postgres;
alter function public.student_paid_awaiting_teacher_terms(uuid, text) owner to postgres;
revoke all on function private.enrollment_paid_awaiting_terms(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.student_term_link_reminders() from public, anon, authenticated, service_role;
revoke all on function public.student_paid_awaiting_teacher_terms(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.student_paid_awaiting_teacher_terms(uuid, text) to service_role;
