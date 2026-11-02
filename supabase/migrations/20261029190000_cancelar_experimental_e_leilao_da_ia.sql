-- Cancelar experimental pela plataforma + leilão aberto pela IA morre quando um
-- humano assume o lead.
--
-- O caso (29/10/2026, um lead novo): a atendente abriu às 11:38 um leilão para
-- 05/11 08:00; às 11:39 a equipe assumiu a conversa e marcou a experimental de
-- hoje 14:30 com outra professora. O leilão da IA continuou vivo e uma professora o
-- aceitou às 11:57 — a aluna ficou com duas experimentais e a professora com uma aula
-- fantasma na agenda. Não havia como desfazer pela tela.

-- 1) De onde a oportunidade nasceu. Só a atendente grava 'AI_SDR'; o resto fica
--    nulo (plataforma, vendedor, legado). É o que permite o handoff matar o
--    leilão da IA sem tocar no leilão que o próprio humano abriu.
alter table public.opportunities add column if not exists origin text;

-- 2) Cancelamento. Direção/coordenação da escola (ou service_role).
create or replace function public.cancel_trial_opportunity(
  p_opportunity_id uuid,
  p_reason text,
  p_notify_teacher boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := auth.uid();
  v_jwt_role text := coalesce(auth.jwt() ->> 'role', '');
  v_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  v_opp public.opportunities%rowtype;
  v_appt public.appointments%rowtype;
  v_teacher uuid;
  v_teacher_name text;
  v_phone text;
  v_when text;
  v_msg text;
  v_notified boolean := false;
begin
  if not private.can_execute_legacy_role_rpc(array['SCHOOL_ADMIN','COORDINATOR']::text[]) then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'sem_permissao');
  end if;
  if v_reason is null then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'motivo_obrigatorio');
  end if;
  if pg_catalog.length(v_reason) > 300 then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'motivo_longo');
  end if;

  select * into v_opp from public.opportunities o
   where o.id = p_opportunity_id for update;
  if not found or coalesce(v_opp.kind, 'TRIAL') <> 'TRIAL' then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'experimental_nao_encontrada');
  end if;
  if v_jwt_role = 'authenticated'
     and private.active_tenant_id(v_actor) is distinct from v_opp.tenant_id then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'sem_permissao');
  end if;
  if v_opp.status in ('CANCELED', 'EXPIRED') then
    return pg_catalog.jsonb_build_object('ok', true, 'already', true);
  end if;
  if v_opp.trial_status = 'DONE' or v_opp.conversion_status in ('WON', 'ENROLLED') then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'experimental_ja_realizada');
  end if;
  if v_opp.trial_appointment_id is not null and exists (
    select 1 from public.class_logs cl where cl.appointment_id = v_opp.trial_appointment_id::text
  ) then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'experimental_ja_lancada');
  end if;

  update public.opportunities o
     set status = 'CANCELED',
         trial_status = case when o.status = 'CLAIMED' then 'CANCELLED' else o.trial_status end,
         lost_reason = pg_catalog.left('Experimental cancelada: ' || v_reason, 500)
   where o.id = v_opp.id;

  -- Sai da agenda do professor: as telas e o lançamento só leem 'scheduled'.
  if v_opp.trial_appointment_id is not null then
    update public.appointments a
       set status = 'cancelled'
     where a.id = v_opp.trial_appointment_id
       and a.status in ('scheduled', 'confirmed')
    returning * into v_appt;
  end if;

  -- O que dependia desta experimental deixa de valer.
  update public.offers as offer
     set revoked_at = coalesce(offer.revoked_at, pg_catalog.now()),
         revoked_by = coalesce(offer.revoked_by, v_actor)
   where offer.opportunity_id = v_opp.id
     and offer.kind = 'ENROLLMENT'
     and offer.revoked_at is null
     and offer.consumed_at is null
     and offer.processing_by is null
     and offer.processing_state = 'NOT_STARTED';
  update public.enrollment_links as link
     set status = 'EXPIRED'
   where link.opportunity_id = v_opp.id and link.status = 'PENDING';
  update private.vendor_trial_teacher_requests as request
     set status = 'CANCELED', updated_at = pg_catalog.now()
   where request.opportunity_id = v_opp.id
     and request.status in ('AWAITING_STUDENT', 'AWAITING_TEACHER');

  -- Aviso ao professor que tinha aceitado (falha no aviso não desfaz o cancelamento).
  v_teacher := coalesce(v_appt.teacher_id, v_opp.winner_teacher_id);
  if p_notify_teacher and v_opp.status = 'CLAIMED' and v_teacher is not null then
    begin
      select p.full_name, private.whatsapp_digits(nullif(p.phone, ''))
        into v_teacher_name, v_phone
        from public.profiles p where p.id = v_teacher;
      if v_phone is not null then
        v_when := case when v_appt.start_time is not null
          then pg_catalog.to_char(v_appt.start_time at time zone 'America/Sao_Paulo', 'DD/MM "às" HH24:MI')
          else coalesce(v_opp.accepted_slot ->> 'formatted', 'data combinada') end;
        v_msg := pg_catalog.format(
          E'Oi, %s! 🐺 A aula experimental de %s (%s) foi CANCELADA pela escola e já saiu da sua agenda.\n\nMotivo: %s\n\nNão precisa fazer nada. Obrigado por ter aceitado!',
          pg_catalog.split_part(pg_catalog.btrim(coalesce(v_teacher_name, '')), ' ', 1),
          coalesce(v_opp.student_name, 'aluno'), v_when, v_reason);
        insert into public.notification_queue(
          tenant_id, teacher_id, student_id, student_name, student_phone, message_body,
          scheduled_for, status, source_type, notification_kind, idempotency_key)
        values (v_opp.tenant_id, v_teacher, null, coalesce(v_teacher_name, 'Professor'), v_phone, v_msg,
          pg_catalog.now(), 'pending', 'MANAGEMENT_NOTICE', 'MANAGEMENT_NOTICE',
          pg_catalog.format('trial-cancel:%s:teacher', v_opp.id))
        on conflict (tenant_id, idempotency_key) where idempotency_key is not null do nothing;
        v_notified := found;
      end if;
    exception when others then
      raise warning '[cancelar experimental] aviso não enfileirado para %: %', v_opp.id, sqlerrm;
    end;
  end if;

  insert into public.audit_logs(tenant_id, user_id, action, resource_type, resource_id, old_values, new_values)
  values (v_opp.tenant_id, v_actor, 'TRIAL_CANCELLED', 'opportunity', v_opp.id::text,
    pg_catalog.jsonb_build_object('status', v_opp.status, 'trial_status', v_opp.trial_status),
    pg_catalog.jsonb_build_object('reason', v_reason, 'status', 'CANCELED',
      'appointment_id', v_opp.trial_appointment_id, 'teacher_id', v_teacher,
      'teacher_notified', v_notified));

  return pg_catalog.jsonb_build_object('ok', true, 'teacher_notified', v_notified,
    'appointment_cancelled', v_appt.id is not null);
end;
$function$;

alter function public.cancel_trial_opportunity(uuid, text, boolean) owner to postgres;
revoke all on function public.cancel_trial_opportunity(uuid, text, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.cancel_trial_opportunity(uuid, text, boolean)
  to authenticated, service_role;
