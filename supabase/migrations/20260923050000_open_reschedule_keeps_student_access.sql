-- Reposição SEM data é obrigação em aberto, não registro histórico.
--
-- A migration 20260922040028 quis que "historical coverage and reschedule
-- records must not grant access forever" e pôs uma janela de 7 dias. Para
-- BOOKING ela tolera data nula (`booking.date is null or ...`); para reposição,
-- não: sem data o `case` devolve null, e `null >= data` não é verdade.
--
-- Nesta escola reposição sem data é o estado NORMAL — medido em 23/09/2026:
-- 196 reposições abertas atribuídas a professor, 4 com data, 1 dentro da
-- janela. O ramo virou letra morta e 11 pares professor–aluno perderam acesso
-- (Flávio 4, Mateus 3, Beatrís 2, Débora 2): sem booking, sem serem titulares,
-- só a reposição ligava. E é aula que o professor DEVE ao aluno — o contrário
-- de um registro velho.
--
-- Regra que fica, espelhando o booking: reposição aberta (`used_at is null`)
-- sem data utilizável continua abrindo o aluno; a janela de 7 dias vale para a
-- reposição que TEM data e já passou. Nada mais muda.

create or replace function public._teacher_can_access_student(
  p_student_id uuid,
  p_tenant_id text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  with context as (
    select caller.id as teacher_id,
           student.id as student_id,
           ((now() at time zone 'America/Sao_Paulo')::date) as local_date
    from public.profiles as caller
    join public.profiles as student on student.id = p_student_id
    where caller.id = (select auth.uid())
      and caller.role = 'TEACHER'
      and caller.status = 'Ativo'
      and caller.tenant_id = p_tenant_id
      and student.role = 'STUDENT'
      and lower(coalesce(student.status, '')) in ('ativo', 'active')
      and lower(coalesce(student.lifecycle_status, 'active')) not in ('suspended', 'offboarded')
      and student.tenant_id = p_tenant_id
  )
  select exists (
    select 1 from context as ctx
    where exists (
      select 1 from public.bookings as booking
      where booking.student_id = ctx.student_id
        and booking.teacher_id = ctx.teacher_id
        and booking.tenant_id = p_tenant_id
        and upper(coalesce(booking.status, '')) = 'SCHEDULED'
        and (booking.date is null or booking.date >= ctx.local_date - 7)
    )
    or (
      not exists (
        select 1 from public.bookings as live_booking
        where live_booking.student_id = ctx.student_id
          and live_booking.tenant_id = p_tenant_id
          and upper(coalesce(live_booking.status, '')) = 'SCHEDULED'
          and (live_booking.date is null or live_booking.date >= ctx.local_date - 7)
      )
      and exists (
        select 1 from public.profiles as assigned_student
        where assigned_student.id = ctx.student_id
          and (assigned_student.professor_id = ctx.teacher_id
               or assigned_student.professor_id2 = ctx.teacher_id)
      )
    )
    or exists (
      select 1 from public.class_coverages as coverage
      where coverage.student_id = ctx.student_id
        and coverage.cover_teacher_id = ctx.teacher_id
        and coverage.tenant_id = p_tenant_id
        and lower(coalesce(coverage.status, '')) = 'confirmed'
        and coverage.class_date >= ctx.local_date - 7
    )
    or exists (
      select 1 from public.reschedules as reschedule
      where reschedule.student_id = ctx.student_id
        and reschedule.teacher_id = ctx.teacher_id
        and reschedule.tenant_id = p_tenant_id
        and reschedule.used_at is null
        and (
          reschedule.date !~ '^\d{4}-\d{2}-\d{2}$'
          or reschedule.date::date >= ctx.local_date - 7
        )
    )
  );
$function$;

alter function public._teacher_can_access_student(uuid, text) owner to postgres;
