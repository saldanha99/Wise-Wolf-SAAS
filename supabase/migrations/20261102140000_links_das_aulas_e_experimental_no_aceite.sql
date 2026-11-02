-- Links das aulas num lugar só, e a sala da experimental criada no aceite.
--
-- 1. A sala do Meet da experimental nascia só nas 24 h antes da aula, e o
--    lead recebia o link só 6 h antes. Decisão da direção (02/11/2026): a sala
--    nasce assim que o professor aceita (a próxima rodada do cron, até 15 min)
--    e o link vai ao lead logo em seguida.
-- 2. `my_lesson_links` devolve, para quem está logado, as aulas do período com
--    o link certo — a mesma regra das telas (`lib/lessonRooms.ts`): sala da
--    escola pronta → ela; sala da escola prevista e ainda não pronta → nenhum
--    link pessoal (a sala chega); sem sala prevista → link pessoal do aluno.
--    Alimenta a aba "Links de Aula", o aviso de 10 minutos e o "Ao vivo" da
--    direção. Professor e aluno recebem o MESMO link para a mesma aula.

-- 1a. Janela da sala da experimental: 24 h → 30 dias. Remendo por âncora.
do $patch$
declare v_def text;
begin
  v_def := pg_catalog.pg_get_functiondef('public.trial_meet_backend(text,jsonb)'::regprocedure);
  if v_def like '%ap.start_time <= pg_catalog.now() + interval ''24 hours''%' then
    execute pg_catalog.replace(v_def,
      'ap.start_time <= pg_catalog.now() + interval ''24 hours''',
      'ap.start_time <= pg_catalog.now() + interval ''30 days''');
  elsif v_def not like '%ap.start_time <= pg_catalog.now() + interval ''30 days''%' then
    raise exception 'trial_meet_backend_anchor_missing';
  end if;
end
$patch$;

-- 1b. O link vai ao lead assim que a sala fica pronta (antes: só 6 h antes).
-- Quem já recebeu para aquela data sai da lista: a janela agora é longa e
-- o limite de 20 por rodada não pode ficar preso nos já avisados.
create or replace function public.trial_meet_link_notices(p_limit integer default 20)
returns table (
  appointment_id uuid, tenant_id text, class_date date, when_text text,
  lead_name text, lead_phone text, teacher_name text, meeting_uri text
)
language sql
stable
security definer
set search_path = ''
as $$
  select ap.id, ap.tenant_id,
         (ap.start_time at time zone 'America/Sao_Paulo')::date,
         pg_catalog.to_char(ap.start_time at time zone 'America/Sao_Paulo', 'DD/MM às HH24:MI'),
         coalesce(nullif(pg_catalog.btrim(coalesce(o.student_name, '')), ''), ap.student_name),
         private.trial_closing_phone(coalesce(o.student_phone, ap.student_phone)),
         t.full_name, m.meeting_uri
    from private.trial_meet_rooms m
    join public.appointments ap on ap.id = m.appointment_id
    join public.opportunities o on o.trial_appointment_id = ap.id and o.tenant_id = ap.tenant_id
    join public.profiles t on t.id = m.teacher_id
    join private.trial_meet_settings s on s.tenant_id = m.tenant_id and s.enabled
   where m.state = 'READY'
     and ap.meeting_link = m.meeting_uri
     and pg_catalog.lower(coalesce(ap.status, '')) in ('scheduled', 'confirmed')
     and o.status = 'CLAIMED' and not coalesce(o.is_test_fixture, false)
     and ap.start_time > pg_catalog.now()
     and ap.start_time <= pg_catalog.now() + interval '30 days'
     and not exists (
       select 1 from public.automation_sent a
        where a.kind = 'TRIAL_MEET_LINK'
          and a.subject_id = ap.id::text
          and a.ref_date = (ap.start_time at time zone 'America/Sao_Paulo')::date)
   order by ap.start_time
   limit greatest(1, least(coalesce(p_limit, 20), 50))
$$;

-- 2. Aulas do período com o link certo.
create or replace function public.my_lesson_links(p_from date default null, p_to date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a public.profiles%rowtype;
  v_from date := coalesce(p_from, (pg_catalog.now() at time zone 'America/Sao_Paulo')::date);
  v_to date;
  v_staff boolean;
  v_lessons jsonb;
  v_trials jsonb;
begin
  select * into a from public.profiles where id = auth.uid();
  if a.id is null or pg_catalog.lower(coalesce(a.lifecycle_status, '')) <> 'active' then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  v_to := least(coalesce(p_to, v_from), v_from + 14);
  v_staff := a.role in ('SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR');
  if not v_staff and a.role not in ('TEACHER', 'STUDENT') then
    return pg_catalog.jsonb_build_object('lessons', '[]'::jsonb);
  end if;

  select coalesce(pg_catalog.jsonb_agg(x order by x ->> 'starts_at'), '[]'::jsonb) into v_lessons
    from (
      select pg_catalog.jsonb_build_object(
               'kind', 'aula',
               'id', q.id,
               'class_date', q.class_date,
               'starts_at', q.scheduled_start_at,
               'ends_at', q.scheduled_end_at,
               'teacher_id', q.teacher_id,
               'teacher_name', q.teacher_name,
               'student_id', q.student_id,
               'student_name', q.student_name,
               'link', case when q.room_ok then q.meeting_uri
                            when q.room_expected then null
                            else q.personal end,
               'link_kind', case when q.room_ok then 'escola'
                                 when q.room_expected then 'preparando'
                                 when q.personal is not null then 'pessoal'
                                 else 'sem_link' end) as x
        from (
          select s.id, s.class_date, s.scheduled_start_at, s.scheduled_end_at,
                 s.teacher_id, t.full_name as teacher_name,
                 s.student_id, st.full_name as student_name,
                 r.meeting_uri,
                 case when st.meeting_link ~* '^https://' then pg_catalog.btrim(st.meeting_link) end as personal,
                 (u.usable and r.state = 'READY' and r.meeting_uri is not null
                    and not coalesce(r.teacher_handover_pending, false)) as room_ok,
                 -- Mesma regra de `get_my_lesson_rooms`: com aceite e sala
                 -- prevista, a aula não cai no link pessoal — até 15 min antes.
                 (u.usable and coalesce(r.state, '') <> 'READY'
                    and coalesce(r.state, '') not in ('FAILED', 'NEEDS_RECONCILIATION')
                    and (r.lesson_session_id is not null or exists (
                          select 1 from private.teacher_google_identities ident
                           where ident.teacher_id = s.teacher_id and ident.tenant_id = s.tenant_id))
                    and s.scheduled_start_at > pg_catalog.now() + interval '15 minutes') as room_expected
            from public.lesson_sessions s
            join public.profiles t on t.id = s.teacher_id
            join public.profiles st on st.id = s.student_id
            left join private.google_meet_rooms r
              on r.lesson_session_id = s.id and r.tenant_id = s.tenant_id
            cross join lateral (
              select s.documentation_consent
                     and not private.lesson_session_documentation_blocked(s.id)
                     and not private.lesson_session_taught_by_other(s.id) as usable
            ) u
           where s.tenant_id = a.tenant_id
             and s.status <> 'SUPERSEDED'
             and s.class_date between v_from and v_to
             and (v_staff
                  or (a.role = 'TEACHER' and s.teacher_id = a.id)
                  or (a.role = 'STUDENT' and s.student_id = a.id))
           limit 400
        ) q
    ) z;

  -- Experimental: o lead não tem conta; aparece para o professor e a direção.
  select coalesce(pg_catalog.jsonb_agg(x order by x ->> 'starts_at'), '[]'::jsonb) into v_trials
    from (
      select pg_catalog.jsonb_build_object(
               'kind', 'experimental',
               'id', q.id,
               'class_date', (q.start_time at time zone 'America/Sao_Paulo')::date,
               'starts_at', q.start_time,
               'ends_at', q.start_time + interval '30 minutes',
               'teacher_id', q.teacher_id,
               'teacher_name', q.teacher_name,
               'student_id', null,
               'student_name', q.student_name,
               'link', case when q.link is not null then q.link
                            when q.expected then null
                            else q.teacher_link end,
               'link_kind', case when q.link is not null and q.school_room then 'escola'
                                 when q.link is not null then 'pessoal'
                                 when q.expected then 'preparando'
                                 when q.teacher_link is not null then 'pessoal'
                                 else 'sem_link' end) as x
        from (
          select ap.id, ap.start_time, t.id as teacher_id, t.full_name as teacher_name,
                 coalesce(nullif(pg_catalog.btrim(coalesce(o.student_name, '')), ''), ap.student_name) as student_name,
                 case when ap.meeting_link ~* '^https://' then pg_catalog.btrim(ap.meeting_link) end as link,
                 case when t.meeting_link ~* '^https://' then pg_catalog.btrim(t.meeting_link) end as teacher_link,
                 exists (select 1 from private.trial_meet_rooms m
                          where m.appointment_id = ap.id and m.state = 'READY'
                            and m.meeting_uri = ap.meeting_link) as school_room,
                 -- A sala da escola nasce na próxima rodada do cron.
                 (exists (select 1 from private.trial_meet_settings ts
                           where ts.tenant_id = ap.tenant_id and ts.enabled)
                  and exists (select 1 from private.teacher_google_identities gi
                               where gi.teacher_id = t.id and gi.tenant_id = ap.tenant_id)
                  and exists (select 1 from private.google_workspace_connections c
                               where c.tenant_id = ap.tenant_id and c.status = 'CONNECTED')
                  and ap.start_time > pg_catalog.now()) as expected
            from public.appointments ap
            left join public.opportunities o on o.trial_appointment_id = ap.id and o.tenant_id = ap.tenant_id
            join public.profiles t on t.id = coalesce(o.winner_teacher_id, ap.teacher_id, ap.professor_id)
           where ap.tenant_id = a.tenant_id
             and pg_catalog.lower(coalesce(ap.type, '')) = 'experimental'
             and pg_catalog.lower(coalesce(ap.status, '')) in ('scheduled', 'confirmed')
             and not coalesce(o.is_test_fixture, false)
             and (ap.start_time at time zone 'America/Sao_Paulo')::date between v_from and v_to
             and (v_staff or (a.role = 'TEACHER' and t.id = a.id))
           limit 100
        ) q
    ) z;

  return pg_catalog.jsonb_build_object(
    'lessons', (
      select coalesce(pg_catalog.jsonb_agg(e order by e ->> 'starts_at'), '[]'::jsonb)
        from pg_catalog.jsonb_array_elements(v_lessons || v_trials) e),
    -- A direção entra pela conta central (dona das salas): o link abre com
    -- `authuser` e ela entra sem pedir para participar.
    'organizer_email', case when v_staff then (
      select c.organizer_email from private.google_workspace_connections c
       where c.tenant_id = a.tenant_id and c.status = 'CONNECTED') end);
end;
$$;

alter function public.trial_meet_link_notices(integer) owner to postgres;
alter function public.my_lesson_links(date, date) owner to postgres;
revoke all on function public.trial_meet_link_notices(integer) from public, anon, authenticated;
revoke all on function public.my_lesson_links(date, date) from public, anon;
grant execute on function public.trial_meet_link_notices(integer) to service_role;
grant execute on function public.my_lesson_links(date, date) to authenticated;
