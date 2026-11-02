-- O substituto enxerga o aluno cuja aula ele cobre (e o aluno da reposição que
-- lhe foi atribuída).
--
-- O caso (18/09/2026, Teacher Bruna): a direção atestou pelo grupo três
-- coberturas de 16/09 (Victor Hugo 16:30 e 17:00, Vinícius 17:30, de Flávio
-- para Bruna). `coverages_for_teacher_in_tenant` devolvia as três para ela e
-- os três `bookings` do Flávio apareciam — mas o `Lançar Aula` mostrava NADA
-- ("Não aparece para eu lançar aula", 17/09 10:14). Medido com a sessão dela
-- em BEGIN…ROLLBACK: `select id from profiles where id in (<os dois alunos>)`
-- devolve zero linhas. `_teacher_can_access_student` só reconhece aluno de
-- quem o professor é `professor_id`/`professor_id2` ou tem `bookings`
-- SCHEDULED — cobertura e reposição não contavam. O `LessonLauncher` faz o join
-- `student:student_id(...)`, recebe `null` e descarta a aula em silêncio
-- (`if (!student) return`). O mesmo vale para a Débora com o Theo (16/09).
--
-- Consequência: a cobertura "registrada" pelo grupo nunca chegava ao
-- lançamento — e, como o pagamento é `class_logs` × tarifa, a substituta não
-- recebia. Aqui o predicado passa a reconhecer:
--   • `class_coverages` confirmada com `cover_teacher_id` = quem chama;
--   • `reschedules` cuja `teacher_id` é quem chama (reposição atribuída a
--     outro professor, como as de Ana Clara e Vinícius com a Bruna em 17/09).
-- A leitura continua limitada à projeção de diretório do professor (grants de
-- coluna de `20260824051348_restrict_teacher_profile_pii`); nada de financeiro.

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
  select exists (
    select 1
      from public.profiles as caller
      join public.profiles as student
        on student.id = p_student_id
     where caller.id = (select auth.uid())
       and caller.role = 'TEACHER'
       and caller.tenant_id = p_tenant_id
       and student.role = 'STUDENT'
       and student.tenant_id = p_tenant_id
       and (
         student.professor_id = caller.id
         or student.professor_id2 = caller.id
         or exists (
           select 1
             from public.bookings as booking
            where booking.student_id = student.id
              and booking.teacher_id = caller.id
              and booking.tenant_id = p_tenant_id
              and booking.status = 'SCHEDULED'
         )
         -- Cobertura confirmada: quem assume a aula precisa do aluno na tela
         -- para lançá-la (e receber por ela). Pendente/cancelada não conta.
         or exists (
           select 1
             from public.class_coverages as coverage
            where coverage.student_id = student.id
              and coverage.cover_teacher_id = caller.id
              and coverage.tenant_id = p_tenant_id
              and lower(coalesce(coverage.status, '')) = 'confirmed'
         )
         -- Reposição atribuída a este professor (inclusive de aluno de outro).
         or exists (
           select 1
             from public.reschedules as reschedule
            where reschedule.student_id = student.id
              and reschedule.teacher_id = caller.id
              and reschedule.tenant_id = p_tenant_id
         )
       )
  );
$function$;

alter function public._teacher_can_access_student(uuid, text) owner to postgres;
revoke all on function public._teacher_can_access_student(uuid, text)
  from public, anon;
grant execute on function public._teacher_can_access_student(uuid, text)
  to authenticated;

comment on function public._teacher_can_access_student(uuid, text) is
  'Professor enxerga aluno de quem é professor_id/professor_id2, com booking SCHEDULED, cuja aula ele cobre (class_coverages confirmada) ou cuja reposição lhe foi atribuída (reschedules.teacher_id). Usado pela policy profiles_scoped_read_p1.';
