-- Matrícula vai até o fim antes dos termos individuais (decisão da direção, 29/10/2026).
--
-- Antes: com o termo individual pendente, a página de matrícula parava depois do
-- contrato ("aguarda a assinatura do termo… retorne a este link") e o aluno saía
-- sem pagar. Agora o aluno preenche, assina e paga até o fim; o que espera os
-- termos (escola + professor) é só a LIBERAÇÃO: a agenda com o professor e a
-- conclusão da matrícula.
--
-- 1) O horário oferecido fica segurado enquanto o termo está em conferência.
--    A reserva da matrícula era de 30 min; vencida, o termo virava "fonte
--    alterada" e nem a escola conseguia assinar.
-- 2) Uma rotina a cada 2 min materializa a agenda e conclui a matrícula assim
--    que os termos ficam completos. A conclusão continua conferindo, ela mesma,
--    que o pagamento exigido foi liquidado — sem pagamento, nada é concluído.
-- A guarda dos termos em bookings/materialização/conclusão não muda.

-- 1) Segurar o horário enquanto houver termo em conferência ------------------
create or replace function private.enrollment_slot_hold_for_terms()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_expires timestamptz;
begin
  if new.status <> 'RESERVED' or new.reserved_by is null then
    return new;
  end if;
  select o.expires_at into v_expires
    from public.offers o
   where o.id = new.offer_id and o.kind = 'ENROLLMENT' and o.revoked_at is null
     and o.processing_by = new.reserved_by and o.processing_state <> 'COMPLETED'
     and o.expires_at > pg_catalog.now();
  if v_expires is null then
    return new;
  end if;
  if exists (
    select 1 from private.teacher_student_terms t
     where t.source_kind = 'ENROLLMENT' and t.source_id = new.offer_id
       and t.student_id = new.reserved_by and t.teacher_id = new.teacher_id
       and t.status in ('PROPOSED', 'EXECUTED') and t.retired_at is null
  ) then
    new.reservation_expires_at := greatest(
      coalesce(new.reservation_expires_at, pg_catalog.now()), v_expires);
  end if;
  return new;
end;
$function$;

drop trigger if exists zz_hold_slot_for_teacher_terms on private.enrollment_offer_schedule_slots;
create trigger zz_hold_slot_for_teacher_terms
  before insert or update on private.enrollment_offer_schedule_slots
  for each row execute function private.enrollment_slot_hold_for_terms();

-- O termo nasceu (ou mudou): reaplica a regra acima nas vagas da matrícula.
-- Recusado ou retirado sem outra versão em conferência → solta em 30 min.
create or replace function private.enrollment_term_refresh_slot_hold()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.source_kind <> 'ENROLLMENT' then
    return new;
  end if;
  begin
    if new.status in ('PROPOSED', 'EXECUTED') and new.retired_at is null then
      update private.enrollment_offer_schedule_slots s
         set updated_at = pg_catalog.now()
       where s.offer_id = new.source_id and s.teacher_id = new.teacher_id
         and s.reserved_by = new.student_id and s.status = 'RESERVED';
    elsif not exists (
      select 1 from private.teacher_student_terms t
       where t.source_kind = 'ENROLLMENT' and t.source_id = new.source_id
         and t.teacher_id = new.teacher_id and t.student_id = new.student_id
         and t.id <> new.id and t.status in ('PROPOSED', 'EXECUTED') and t.retired_at is null
    ) then
      update private.enrollment_offer_schedule_slots s
         set reservation_expires_at = least(s.reservation_expires_at, pg_catalog.now() + interval '30 minutes'),
             updated_at = pg_catalog.now()
       where s.offer_id = new.source_id and s.teacher_id = new.teacher_id
         and s.reserved_by = new.student_id and s.status = 'RESERVED';
    end if;
  exception when others then
    raise warning '[termo da matrícula] reserva não ajustada para %: %', new.id, sqlerrm;
  end;
  return new;
end;
$function$;

drop trigger if exists zz_term_refresh_enrollment_hold on private.teacher_student_terms;
create trigger zz_term_refresh_enrollment_hold
  after insert or update of status, retired_at on private.teacher_student_terms
  for each row execute function private.enrollment_term_refresh_slot_hold();

-- 2) Liberação: termos completos → agenda + conclusão ------------------------
create or replace function private.finish_enrollments_after_teacher_terms()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  r record;
  v_claims text := pg_catalog.current_setting('request.jwt.claims', true);
  v_mat jsonb;
  v_done jsonb;
  v_materialized integer := 0;
  v_completed integer := 0;
begin
  -- Rotina de sistema: as RPCs da matrícula exigem o papel de serviço.
  perform pg_catalog.set_config('request.jwt.claims', '{"role":"service_role"}', true);
  for r in
    select distinct o.id, o.processing_by, o.processing_state
      from public.offers o
      join private.teacher_student_terms t
        on t.source_kind = 'ENROLLMENT' and t.source_id = o.id and t.student_id = o.processing_by
     where o.kind = 'ENROLLMENT' and o.revoked_at is null and o.processing_by is not null
       and o.processing_state <> 'COMPLETED'
       and t.status = 'EXECUTED' and t.retired_at is null
       and t.updated_at > pg_catalog.now() - interval '30 days'
  loop
    begin
      if not private.student_term_enrollment(r.id, r.processing_by) then
        continue;
      end if;
      if exists (
        select 1 from private.enrollment_offer_schedule_slots s
         where s.offer_id = r.id and s.status = 'RESERVED' and s.reserved_by = r.processing_by
      ) then
        v_mat := public.materialize_enrollment_offer_schedule(r.id, r.processing_by);
        if coalesce((v_mat ->> 'success')::boolean, false) then
          v_materialized := v_materialized + 1;
        else
          raise warning '[liberação da matrícula] agenda não materializada para %: %', r.id, v_mat;
          continue;
        end if;
      end if;
      -- Só conclui quem já tem a cobrança exigida registrada; a conclusão
      -- confere o pagamento liquidado e recusa sem ele.
      if r.processing_state = 'BILLING_READY' then
        v_done := public.complete_enrollment_offer(r.id, r.processing_by);
        if coalesce((v_done ->> 'success')::boolean, false) then
          v_completed := v_completed + 1;
        end if;
      end if;
    exception when others then
      raise warning '[liberação da matrícula] falha em %: %', r.id, sqlerrm;
    end;
  end loop;
  perform pg_catalog.set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  return pg_catalog.jsonb_build_object('materialized', v_materialized, 'completed', v_completed);
end;
$function$;

-- 3) Para a tela: a matrícula está paga e só espera os termos? --------------
create or replace function public.enrollment_awaiting_teacher_terms(p_offer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  o public.offers;
begin
  select * into o from public.offers
   where id = p_offer_id and kind = 'ENROLLMENT' and processing_by = v_uid;
  if o.id is null then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authorized');
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'processing_state', o.processing_state,
    'terms_ready', private.student_term_enrollment(o.id, v_uid),
    'payment_registered', o.processing_state in ('BILLING_READY', 'COMPLETED'));
end;
$function$;

do $$
declare r record;
begin
  for r in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname in (
      'enrollment_slot_hold_for_terms', 'enrollment_term_refresh_slot_hold',
      'finish_enrollments_after_teacher_terms') loop
    execute pg_catalog.format('alter function %s owner to postgres', r.signature);
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated, service_role', r.signature);
  end loop;
end $$;
alter function public.enrollment_awaiting_teacher_terms(uuid) owner to postgres;
revoke all on function public.enrollment_awaiting_teacher_terms(uuid) from public, anon, authenticated, service_role;
grant execute on function public.enrollment_awaiting_teacher_terms(uuid) to authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'wisewolf-finish-enrollments-after-terms') then
    perform cron.unschedule('wisewolf-finish-enrollments-after-terms');
  end if;
  perform cron.schedule('wisewolf-finish-enrollments-after-terms', '*/2 * * * *',
    'select private.finish_enrollments_after_teacher_terms()');
end $$;

-- Matrículas que já pararam esperando o termo: o horário volta a ficar segurado.
update private.enrollment_offer_schedule_slots s
   set updated_at = pg_catalog.now()
 where s.status = 'RESERVED'
   and exists (
     select 1 from private.teacher_student_terms t
      where t.source_kind = 'ENROLLMENT' and t.source_id = s.offer_id
        and t.student_id = s.reserved_by and t.teacher_id = s.teacher_id
        and t.status = 'PROPOSED' and t.retired_at is null)
   and not exists (
     select 1 from private.enrollment_offer_schedule_slots other
      where other.teacher_id = s.teacher_id and other.day_of_week = s.day_of_week
        and other.class_time = s.class_time and other.offer_id <> s.offer_id
        and (other.status = 'MATERIALIZED'
          or (other.status = 'RESERVED' and other.reservation_expires_at > pg_catalog.now())))
   and not exists (
     select 1 from public.bookings b
      where b.teacher_id = s.teacher_id and b.status = 'SCHEDULED'
        and public.dow_name_to_int(b.day_of_week) = s.day_of_week
        and b.time_slot = pg_catalog.to_char(s.class_time, 'HH24:MI'));
