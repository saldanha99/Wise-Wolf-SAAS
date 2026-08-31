-- A reposicao e um documento financeiro: fault_type decide se a aula futura
-- entra ou nao na folha do professor. Professores continuam vendo seus
-- creditos, mas nao podem mais criar, apagar ou reclassificar essa origem.

alter table public.reschedules enable row level security;

drop policy if exists reschedules_write on public.reschedules;
drop policy if exists reschedules_admin_write on public.reschedules;

create policy reschedules_admin_write
on public.reschedules
for all
to authenticated
using (
  tenant_id = (select public._my_tenant_id())
  and (select public._my_tenant_is_operational())
  and (select public._my_role()) = any (
    array['SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN']::text[]
  )
)
with check (
  tenant_id = (select public._my_tenant_id())
  and (select public._my_tenant_is_operational())
  and (select public._my_role()) = any (
    array['SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN']::text[]
  )
);

comment on policy reschedules_admin_write on public.reschedules is
  'Somente a gestao ativa pode criar, apagar ou mudar a origem/donos de uma reposicao. Professores usam schedule_reschedule para alterar exclusivamente data e hora.';

-- Tanto a RPC estreita quanto o lancador de aulas usam a mesma regra de
-- lifecycle. Isso impede agendar/consumir credito de aluno ou professor ja
-- desligado, sem confiar no estado carregado pelo navegador.
create or replace function private.reschedule_participants_are_active(
  p_reschedule_id uuid,
  p_tenant_id text,
  p_teacher_id uuid,
  p_student_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
      from public.reschedules as reschedule
      join public.profiles as teacher
        on teacher.id = reschedule.teacher_id
      join public.tenant_memberships as teacher_membership
        on teacher_membership.user_id = teacher.id
       and teacher_membership.tenant_id = reschedule.tenant_id
       and teacher_membership.role = 'TEACHER'
       and teacher_membership.status = 'ACTIVE'
      join public.profiles as student
        on student.id = reschedule.student_id
      join public.tenant_memberships as student_membership
        on student_membership.user_id = student.id
       and student_membership.tenant_id = reschedule.tenant_id
       and student_membership.role = 'STUDENT'
       and student_membership.status = 'ACTIVE'
     where reschedule.id = p_reschedule_id
       and reschedule.tenant_id = p_tenant_id
       and reschedule.teacher_id = p_teacher_id
       and reschedule.student_id = p_student_id
       and reschedule.used_at is null
       and pg_catalog.lower(pg_catalog.btrim(coalesce(
             teacher.lifecycle_status,
             ''
           ))) = 'active'
       and pg_catalog.lower(pg_catalog.btrim(coalesce(
             student.lifecycle_status,
             ''
           ))) = 'active'
  );
$function$;

alter function private.reschedule_participants_are_active(uuid, text, uuid, uuid)
  owner to postgres;
revoke all on function private.reschedule_participants_are_active(uuid, text, uuid, uuid)
  from public, anon, authenticated, service_role;

-- fault_type='TEACHER' sozinho nao e prova suficiente para pagar. A origem
-- precisa estar ligada a uma falta do professor registrada no class_log ou a
-- uma decisao final de frequencia. Assim, ate uma correcao administrativa
-- equivocada de STUDENT -> TEACHER nao transforma a reposicao em paga.
create or replace function private.teacher_reschedule_financial_origin_is_proven(
  p_reschedule_id uuid,
  p_tenant_id text,
  p_teacher_id uuid,
  p_student_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
      from public.reschedules as reschedule
     where reschedule.id = p_reschedule_id
       and reschedule.tenant_id = p_tenant_id
       and reschedule.teacher_id = p_teacher_id
       and reschedule.student_id = p_student_id
       and reschedule.fault_type = 'TEACHER'
       and (
         (
           reschedule.original_booking_id is not null
           and exists (
             select 1
               from public.class_logs as origin_log
              where origin_log.tenant_id = reschedule.tenant_id
                and origin_log.teacher_id = reschedule.teacher_id
                and origin_log.student_id = reschedule.student_id
                and origin_log.booking_id = reschedule.original_booking_id::text
                and origin_log.presence in (
                  'TEACHER_ABSENCE',
                  'Falta do Professor'
                )
           )
         )
         or (
           reschedule.attendance_session_key is not null
           and exists (
             select 1
               from public.attendance_confirmations as confirmation
              where confirmation.session_key = reschedule.attendance_session_key
                and confirmation.tenant_id = reschedule.tenant_id
                and confirmation.teacher_id = reschedule.teacher_id
                and confirmation.student_id is not distinct from reschedule.student_id
                and confirmation.status = 'RESOLVED_UNPAID'
                and confirmation.resolution_verdict = 'TEACHER_ABSENT'
           )
         )
       )
  );
$function$;

alter function private.teacher_reschedule_financial_origin_is_proven(uuid, text, uuid, uuid)
  owner to postgres;
revoke all on function private.teacher_reschedule_financial_origin_is_proven(uuid, text, uuid, uuid)
  from public, anon, authenticated, service_role;

-- A UI do professor precisa remarcar um credito real. Esta e a unica mutacao
-- permitida: o servidor resolve tenant/donos/origem pelo id e atualiza somente
-- date/time. Nao existe parametro para fault_type, aluno, professor ou booking.
create or replace function public.schedule_reschedule(
  p_reschedule_id uuid,
  p_date date,
  p_time time without time zone
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid := auth.uid();
  v_actor_role text := public._my_role();
  v_actor_tenant text := public._my_tenant_id();
  v_reschedule public.reschedules%rowtype;
  v_result jsonb;
begin
  if v_actor_id is null then
    raise exception using
      errcode = '42501',
      message = 'authentication_required';
  end if;

  if v_actor_tenant is null
     or not coalesce(v_actor_role in (
       'TEACHER', 'SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN'
     ), false)
     or not coalesce(public._my_tenant_is_operational(), false)
  then
    raise exception using
      errcode = '42501',
      message = 'reschedule_schedule_not_authorized';
  end if;

  if p_reschedule_id is null or p_date is null or p_time is null then
    raise exception using
      errcode = '22023',
      message = 'invalid_reschedule_slot';
  end if;

  select reschedule.*
    into v_reschedule
    from public.reschedules as reschedule
   where reschedule.id = p_reschedule_id
     and reschedule.tenant_id = v_actor_tenant
     and reschedule.used_at is null
   for update of reschedule;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'reschedule_not_found_or_consumed';
  end if;

  if v_actor_role = 'TEACHER'
     and v_reschedule.teacher_id is distinct from v_actor_id
  then
    raise exception using
      errcode = '42501',
      message = 'reschedule_schedule_not_authorized';
  end if;

  if v_actor_role = 'TEACHER'
     and (p_date + p_time) <= (
       pg_catalog.now() at time zone 'America/Sao_Paulo'
     )
  then
    raise exception using
      errcode = '22023',
      message = 'teacher_reschedule_slot_must_be_future';
  end if;

  if not private.reschedule_participants_are_active(
    v_reschedule.id,
    v_reschedule.tenant_id,
    v_reschedule.teacher_id,
    v_reschedule.student_id
  ) then
    raise exception using
      errcode = '55000',
      message = 'reschedule_participant_inactive';
  end if;

  update public.reschedules as reschedule
     set date = pg_catalog.to_char(p_date, 'YYYY-MM-DD'),
         time = pg_catalog.to_char(p_time, 'HH24:MI')
   where reschedule.id = v_reschedule.id;

  select pg_catalog.jsonb_build_object(
           'id', reschedule.id,
           'date', reschedule.date,
           'time', reschedule.time,
           'notification_revision', reschedule.notification_revision
         )
    into v_result
    from public.reschedules as reschedule
   where reschedule.id = v_reschedule.id;

  return v_result;
end;
$function$;

comment on function public.schedule_reschedule(uuid, date, time without time zone) is
  'Agenda um credito de reposicao existente alterando somente data e hora. Identidade, tenant e origem financeira nao sao aceitos como entrada.';

alter function public.schedule_reschedule(uuid, date, time without time zone)
  owner to postgres;
revoke all on function public.schedule_reschedule(uuid, date, time without time zone)
  from public, anon, authenticated, service_role;
grant execute on function public.schedule_reschedule(uuid, date, time without time zone)
  to authenticated;

-- Mantem a implementacao transacional consolidada do lancador e troca apenas
-- o bloco que classifica reposicoes. A substituicao e assertiva: se o corpo
-- autoritativo tiver divergido, a migration para em vez de aplicar meia trava.
do $harden_log_teacher_classes$
declare
  definition text;
  old_fragment constant text := $old$
          -- AQUI mora a correção: quem decide se a reposição paga é a ORIGEM
          -- registrada no banco. Falta do professor → 'REPOSIÇÃO_PROF' (paga).
          -- Falta do aluno (ou origem desconhecida) → 'REPOSIÇÃO' (não paga).
          v_subtype := case
            when v_fault_origin = 'TEACHER' then 'REPOSIÇÃO_PROF'
            else 'REPOSIÇÃO'
          end;
$old$;
  new_fragment constant text := $new$
          -- Lifecycle e integridade sao resolvidos no banco. Um valor TEACHER
          -- editado sem prova autoritativa nunca pode virar aula paga.
          if not private.reschedule_participants_are_active(
            v_reschedule_id::uuid,
            v_profile.tenant_id,
            v_teacher_id,
            v_student_id
          ) then
            v_skip_reason := 'participante_inativo';
          elsif v_fault_origin is not null
                and v_fault_origin not in ('STUDENT', 'TEACHER') then
            v_skip_reason := 'origem_reposicao_invalida';
          elsif v_fault_origin = 'TEACHER'
                and not private.teacher_reschedule_financial_origin_is_proven(
                  v_reschedule_id::uuid,
                  v_profile.tenant_id,
                  v_teacher_id,
                  v_student_id
                ) then
            v_skip_reason := 'reposicao_professor_sem_origem_comprovada';
          else
            -- Origem nula legada permanece conservadoramente nao paga.
            v_subtype := case
              when v_fault_origin = 'TEACHER' then 'REPOSIÇÃO_PROF'
              else 'REPOSIÇÃO'
            end;
          end if;
$new$;
begin
  if pg_catalog.to_regprocedure('public.log_teacher_classes(jsonb)') is null then
    raise exception 'required function public.log_teacher_classes(jsonb) is missing';
  end if;

  select pg_catalog.pg_get_functiondef(
           pg_catalog.to_regprocedure('public.log_teacher_classes(jsonb)')
         )
    into definition;

  if pg_catalog.strpos(definition, new_fragment) > 0 then
    -- O release reaplica a lista de migrations em toda publicação. Se o bloco
    -- endurecido já está instalado, esta etapa precisa ser um no-op seguro.
    null;
  elsif (
    pg_catalog.length(definition)
    - pg_catalog.length(pg_catalog.replace(definition, old_fragment, ''))
  ) = pg_catalog.length(old_fragment) then
    definition := pg_catalog.replace(definition, old_fragment, new_fragment);
    execute definition;
  else
    raise exception 'unexpected public.log_teacher_classes(jsonb) reschedule classifier';
  end if;
end;
$harden_log_teacher_classes$;

alter function public.log_teacher_classes(jsonb) owner to postgres;
revoke all on function public.log_teacher_classes(jsonb)
  from public, anon;
grant execute on function public.log_teacher_classes(jsonb)
  to authenticated, service_role;

comment on function public.log_teacher_classes(jsonb) is
  'Lanca aulas em lote e classifica reposicao paga somente quando a origem TEACHER possui prova autoritativa e os participantes seguem ativos.';

notify pgrst, 'reload schema';
