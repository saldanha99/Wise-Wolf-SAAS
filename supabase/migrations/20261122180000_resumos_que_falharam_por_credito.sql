-- Reprocessar resumos que falharam por falta de crédito no provedor (22/11/2026).
--
-- De 19/10 a 11/11 o OpenRouter devolvia 402 (google_summary_provider_credits):
-- 273 gerações falharam e 137 aulas ficaram sem resumo. A esteira automática só
-- olha os últimos 7 dias e desiste depois de 2 falhas, então essas aulas nunca
-- voltaram. Estas duas funções deixam o serviço (só service_role) reprocessá-las
-- pela MESMA esteira (claim → IA → finish, com teto mensal e trava da escola),
-- sem a janela de 7 dias. Os critérios de aceite continuam os mesmos: termo
-- valendo, IA autorizada, fonte ainda guardada e nenhum resumo da IA/aprovado.
-- Re-executável.

create or replace function public.google_meet_summary_retry_candidates(p_limit integer default 10)
returns table (tenant_id text, lesson_session_id uuid)
language sql
stable
security definer
set search_path to ''
as $$
  select s.tenant_id, s.id
    from public.lesson_sessions as s
   where s.status <> 'SUPERSEDED'
     and s.documentation_consent
     and not private.lesson_session_documentation_blocked(s.id)
     and private.meet_summary_ai_consented(s.id)
     and exists (select 1 from private.google_meet_summary_generations as g
                  where g.lesson_session_id = s.id and g.status = 'FAILED'
                    and g.error_code in ('google_summary_provider_credits', 'google_summary_provider_unavailable'))
     and not exists (select 1 from private.google_meet_summary_generations as g
                      where g.lesson_session_id = s.id
                        and (g.status = 'SUCCEEDED'
                          or (g.status = 'RUNNING' and g.lease_expires_at > pg_catalog.now())))
     and not exists (select 1 from private.lesson_summary_versions as v
                      where v.lesson_session_id = s.id and (v.origin = 'GEMINI_API' or v.status = 'VERIFIED'))
     and exists (select 1 from private.meeting_artifact_revisions as r
                  where r.lesson_session_id = s.id and r.expires_at > pg_catalog.now())
   order by s.scheduled_start_at desc
   limit greatest(1, least(coalesce(p_limit, 10), 50));
$$;

create or replace function public.google_meet_summary_retry_sources(p_session uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_tenant text;
begin
  select c.tenant_id into v_tenant
    from public.google_meet_summary_retry_candidates(50) as c
   where c.lesson_session_id = p_session;
  if v_tenant is null then
    -- Pode não estar entre as 50 mais recentes: confere a aula direto.
    select s.tenant_id into v_tenant
      from public.lesson_sessions as s
     where s.id = p_session
       and s.status <> 'SUPERSEDED'
       and s.documentation_consent
       and not private.lesson_session_documentation_blocked(s.id)
       and private.meet_summary_ai_consented(s.id)
       and not exists (select 1 from private.google_meet_summary_generations as g
                        where g.lesson_session_id = s.id
                          and (g.status = 'SUCCEEDED'
                            or (g.status = 'RUNNING' and g.lease_expires_at > pg_catalog.now())))
       and not exists (select 1 from private.lesson_summary_versions as v
                        where v.lesson_session_id = s.id and (v.origin = 'GEMINI_API' or v.status = 'VERIFIED'));
  end if;
  if v_tenant is null then
    return pg_catalog.jsonb_build_object('eligible', false, 'sources', '[]'::jsonb);
  end if;
  insert into private.google_meet_access_events (tenant_id, actor_id, lesson_session_id, action)
  values (v_tenant, null, p_session, 'SUMMARY_AI_SOURCES_READ');
  return pg_catalog.jsonb_build_object('eligible', true, 'tenant_id', v_tenant, 'sources', coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', revision.id, 'kind', revision.kind,
        'provider_name', revision.provider_name, 'source_text', revision.source_text) order by source.ordinality)
      from private.meet_summary_session_sources(p_session) with ordinality as source
      join private.meeting_artifact_revisions as revision on revision.id = source.id), '[]'::jsonb));
end;
$$;

revoke all on function public.google_meet_summary_retry_candidates(integer) from public, anon, authenticated;
revoke all on function public.google_meet_summary_retry_sources(uuid) from public, anon, authenticated;
grant execute on function public.google_meet_summary_retry_candidates(integer) to service_role;
grant execute on function public.google_meet_summary_retry_sources(uuid) to service_role;
