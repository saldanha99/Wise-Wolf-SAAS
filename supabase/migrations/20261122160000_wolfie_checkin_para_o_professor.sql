-- Check-in do Wolfie na tela do professor (22/11/2026). Só leitura.
--
-- Na véspera da próxima aula o aluno faz um check-in curto (wolfie_lesson_reviews
-- step CHECKIN). O professor vê, em "Aulas de Hoje", o resultado: acertos, o que
-- ainda erra e a prioridade que saiu da conversa com o Wolfie.
--
-- LGPD: devolve só para quem dá ou deu aula ao aluno (agenda ou registro dos
-- últimos 60 dias) ou para a coordenação/direção da mesma escola. Nada de
-- gabarito nem texto livre do aluno: só os enunciados que ele errou.
-- Re-executável.

create or replace function public.teacher_wolfie_checkins(p_student_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_me public.profiles;
  v_result jsonb;
begin
  select * into v_me from public.profiles where id = (select auth.uid());
  if v_me.id is null
     or upper(coalesce(v_me.role, '')) not in ('TEACHER', 'SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN') then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;

  with wanted as (
    select distinct unnest(coalesce(p_student_ids, '{}'::uuid[])) as student_id
    limit 60
  ), allowed as (
    select w.student_id
      from wanted as w
      join public.profiles as s on s.id = w.student_id and upper(coalesce(s.role, '')) = 'STUDENT'
     where s.tenant_id = v_me.tenant_id
       and (
         upper(coalesce(v_me.role, '')) in ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN')
         or exists (
           select 1 from public.upcoming_classes as u
            where u.student_id = w.student_id and u.teacher_id = v_me.id
              and u.tenant_id = v_me.tenant_id
         )
         or exists (
           select 1 from public.class_logs as l
            where l.student_id = w.student_id and l.teacher_id = v_me.id
              and l.tenant_id = v_me.tenant_id
              and l.class_date >= (pg_catalog.now() - interval '60 days')::date
         )
       )
  ), latest as (
    select distinct on (r.student_id)
      r.student_id, r.track_id, r.score, r.completed_at, r.items, r.answers
      from public.wolfie_lesson_reviews as r
      join allowed as a on a.student_id = r.student_id
     where r.step = 'CHECKIN'
       and r.status = 'DONE'
       and r.tenant_id = v_me.tenant_id
       and r.completed_at >= pg_catalog.now() - interval '7 days'
     order by r.student_id, r.completed_at desc
  )
  select coalesce(pg_catalog.jsonb_object_agg(l.student_id::text, pg_catalog.jsonb_build_object(
      'completed_at', l.completed_at,
      'score', l.score,
      'topic', t.topic,
      'class_date', t.class_date,
      'track_score', t.score,
      'priority', t.roleplay_feedback ->> 'priorityPt',
      'missed', (
        select coalesce(pg_catalog.jsonb_agg(item ->> 'prompt'), '[]'::jsonb)
          from pg_catalog.jsonb_array_elements(l.items) as item
         where coalesce((l.answers -> (item ->> 'id') ->> 'correct')::boolean, false) = false
      )
    )), '{}'::jsonb)
    into v_result
    from latest as l
    join public.wolfie_lesson_tracks as t
      on t.id = l.track_id and t.tenant_id = v_me.tenant_id;

  return v_result;
end;
$$;

revoke all on function public.teacher_wolfie_checkins(uuid[]) from public, anon;
grant execute on function public.teacher_wolfie_checkins(uuid[]) to authenticated;

comment on function public.teacher_wolfie_checkins(uuid[]) is
  'Check-in do Wolfie (véspera da aula) para o professor do aluno ou a coordenação. Só leitura, sem gabarito.';
