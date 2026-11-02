-- Revertendo 20260923050000: a regra estrita do Codex estava certa.
--
-- Eu tinha afrouxado o ramo de reposição achando que "reposição sem data" era
-- obrigação em aberto. Conferido com a direção em 23/09/2026, o que ela abria
-- eram FANTASMAS: 26 pares, todos de reposição parada há semanas ou meses, de
-- aluno que hoje é de outro professor — Beatrís via Paulo Eduardo (titular
-- Mateus) e Ana Clara (titular Flávio) por reposições de 09/06, 106 dias
-- paradas; Flávio via Anderson (titular Lais) por 8 reposições de junho/julho;
-- Mateus via Bruno Luis, inativo, por reposição de março.
--
-- Beatrís enxergar ZERO aluno estava certo: ela não tem aluno. Eu medi a saída
-- da regra e não conferi a verdade do terreno — se aquele professor dá aula
-- para aquele aluno hoje.
--
-- Volta exatamente a definição de 20260922040818: reposição só abre o aluno
-- quando tem data utilizável dentro da janela de 7 dias. O caso legítimo —
-- substituto que VAI dar a aula — continua coberto, porque a reposição dele tem
-- data; e a cobertura confirmada tem ramo próprio.

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
        and case
              when reschedule.date ~ '^\d{4}-\d{2}-\d{2}$' then reschedule.date::date
              else null
            end >= ctx.local_date - 7
    )
  );
$function$;
