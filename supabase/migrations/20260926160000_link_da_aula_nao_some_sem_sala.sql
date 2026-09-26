-- O botão "entrar na aula" do app estava vazio desde 13/09/2026.
--
-- get_my_lesson_rooms devolvia TODA sessão da agenda (lesson_sessions nasce de
-- bookings/reposições a cada 15 min), com meeting_uri nulo quando não havia sala
-- da escola. O cliente (lib/lessonRooms.ts) trata "sessão sem sala" como "não
-- abra a sala pessoal" e devolve link nulo — regra certa para aula com aceite de
-- documentação, errada para as outras. Medido em 26/09: um professor com 4 aulas
-- em 25/09 recebeu as 4 sem link; 0 salas da escola existem. As aulas seguiram
-- pelo lembrete do WhatsApp, que usa profiles.meeting_link.
--
-- Conserto só no servidor (vale também para o app antigo em cache): a sessão só
-- volta quando a sala da escola existe ou está prevista (aceite de documentação).
-- Sem isso, o cliente cai no link de sempre. Com aceite e sala ainda não pronta,
-- a regra antiga continua: não abre sala pessoal.
create or replace function public.get_my_lesson_rooms(
  p_from date default null, p_to date default null
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare a public.profiles%rowtype;
begin
  select * into a from public.profiles where id=auth.uid();
  if a.id is null or lower(coalesce(a.lifecycle_status,''))<>'active' then
    raise exception 'authentication_required' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(x order by x.scheduled_start_at) from (
    select s.id as session_id,s.class_date,s.scheduled_start_at,s.scheduled_end_at,
      case when r.state='READY' then r.meeting_uri else null end as meeting_uri,
      coalesce((select jsonb_agg(jsonb_build_object('source_type',o.source_type,'source_id',o.source_id))
        from public.lesson_occurrences o where o.session_id=s.id and o.tenant_id=s.tenant_id and o.status<>'SUPERSEDED'),'[]'::jsonb) as source_references
    from public.lesson_sessions s
    left join private.google_meet_rooms r on r.lesson_session_id=s.id and r.tenant_id=s.tenant_id
    where s.tenant_id=a.tenant_id and s.status<>'SUPERSEDED'
      and (s.documentation_consent or r.lesson_session_id is not null)
      and ((a.role='STUDENT' and s.student_id=a.id) or (a.role='TEACHER' and s.teacher_id=a.id)
        or a.role in ('SCHOOL_ADMIN','SUPER_ADMIN','COORDINATOR'))
      and s.class_date between coalesce(p_from,(now() at time zone 'America/Sao_Paulo')::date)
        and coalesce(p_to,coalesce(p_from,(now() at time zone 'America/Sao_Paulo')::date)+30)
    order by s.scheduled_start_at limit 300
  ) x),'[]'::jsonb);
end;
$$;
revoke all on function public.get_my_lesson_rooms(date,date) from public,anon;
grant execute on function public.get_my_lesson_rooms(date,date) to authenticated;
