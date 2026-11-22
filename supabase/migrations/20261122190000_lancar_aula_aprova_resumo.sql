-- Lançar a aula aprova o resumo da aula (decisão do Vinícius, 22/11/2026).
--
-- Substitui a decisão de 28/09/2026 ("salvar lançamento não aprova o rascunho").
-- Desde 28/09 o rascunho do resumo preenche o "Lançar Aula" e os professores
-- passaram a aceitar ali; a tela de revisão ficou sem uso e nenhum resumo era
-- aprovado desde 12/10. Agora:
--   * class_logs APPROVED com lesson_session_id → o último resumo PROPOSED da
--     aula vira VERIFIED (origin HUMAN_REVIEW, created_by = professor que lançou),
--     com o que o professor confirmou no lançamento (objetivo, próximo passo,
--     lição) por cima do rascunho, e entra na memória do aluno
--     (student_learning_memories) como no summary_save;
--   * a mesma função aprova em lote o que estava na fila (aprovador = sistema,
--     created_by nulo, review_reason com a decisão).
-- Nada é apagado: a versão aprovada é uma versão NOVA, filha do rascunho. A
-- rejeição pelo professor continua funcionando (versão REJECTED posterior tira
-- a aula da memória, trigger meet_summary_rejection_revokes_memory).
-- Re-executável.

create or replace function private.approve_proposed_summary(
  p_session uuid,
  p_actor uuid,
  p_reason text,
  p_class_log_id uuid default null
)
returns text
language plpgsql
security definer
set search_path to ''
as $$
declare
  s public.lesson_sessions;
  p private.lesson_summary_versions;
  v private.lesson_summary_versions;
  l public.class_logs;
  v_content jsonb;
  v_sources uuid[];
  v_version integer;
begin
  select * into s from public.lesson_sessions where id = p_session;
  if s.id is null then return 'no_session'; end if;
  if private.google_meet_session_records_erased(s.id) then return 'erased'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('google-meet-summary:' || s.id::text, 0));

  -- Só se a ÚLTIMA versão da aula for rascunho: decisão humana anterior
  -- (VERIFIED/REJECTED) manda e não é sobrescrita.
  select * into p from private.lesson_summary_versions
   where lesson_session_id = s.id order by version desc limit 1;
  if p.id is null then return 'no_summary'; end if;
  if p.status <> 'PROPOSED' then return 'already_reviewed'; end if;

  v_content := p.content;
  if p_class_log_id is not null then
    select * into l from public.class_logs where id = p_class_log_id;
    -- O que o professor confirmou no lançamento vale mais que o rascunho.
    if l.id is not null then
      v_content := v_content
        || case when pg_catalog.length(pg_catalog.btrim(coalesce(l.lesson_objective, ''))) > 0
             then pg_catalog.jsonb_build_object('lesson_objective', l.lesson_objective) else '{}'::jsonb end
        || case when pg_catalog.length(pg_catalog.btrim(coalesce(l.recommended_next_step, ''))) > 0
             then pg_catalog.jsonb_build_object('recommended_next_step', l.recommended_next_step) else '{}'::jsonb end
        || case when pg_catalog.length(pg_catalog.btrim(coalesce(l.homework_assigned, ''))) > 0
             then pg_catalog.jsonb_build_object('homework_assigned', l.homework_assigned) else '{}'::jsonb end;
    end if;
  end if;
  -- Mesma régua do summary_save: aprovado precisa de objetivo e próximo passo.
  if pg_catalog.length(pg_catalog.btrim(coalesce(v_content ->> 'lesson_objective', ''))) = 0
     or pg_catalog.length(pg_catalog.btrim(coalesce(v_content ->> 'recommended_next_step', ''))) = 0 then
    return 'missing_objective_or_next_step';
  end if;

  -- Fontes que ainda existem (as vencidas saem da lista, como no summary_save).
  v_sources := array(
    select x from pg_catalog.unnest(coalesce(p.source_artifact_ids, '{}'::uuid[])) as x
     where exists (select 1 from private.meeting_artifact_revisions as ar
                    where ar.id = x and ar.tenant_id = s.tenant_id and ar.lesson_session_id = s.id
                      and ar.expires_at > pg_catalog.now()));

  select coalesce(max(version), 0) + 1 into v_version
    from private.lesson_summary_versions where lesson_session_id = s.id;
  insert into private.lesson_summary_versions (tenant_id, lesson_session_id, version, parent_version_id, status,
      origin, content, source_artifact_ids, model_id, prompt_version, review_reason, created_by)
  values (s.tenant_id, s.id, v_version, p.id, 'VERIFIED', 'HUMAN_REVIEW', v_content, v_sources,
      p.model_id, p.prompt_version, pg_catalog.left(p_reason, 2000), p_actor)
  returning * into v;

  insert into public.student_learning_memories (tenant_id, student_id, source_type, source_ref, occurred_at,
      lesson_objective, content_practiced, recurring_errors, strengths_observed, homework_assigned,
      recommended_next_step, confidence_level, verification_status, metadata, created_by)
  values (s.tenant_id, s.student_id, 'MEET_SESSION', s.id::text, s.scheduled_start_at,
      v_content ->> 'lesson_objective',
      array(select pg_catalog.jsonb_array_elements_text(coalesce(v_content -> 'content_practiced', '[]'::jsonb))),
      array(select pg_catalog.jsonb_array_elements_text(coalesce(v_content -> 'recurring_errors', '[]'::jsonb))),
      array(select pg_catalog.jsonb_array_elements_text(coalesce(v_content -> 'strengths_observed', '[]'::jsonb))),
      coalesce(v_content ->> 'homework_assigned', ''), v_content ->> 'recommended_next_step', 'HIGH', 'VERIFIED',
      pg_catalog.jsonb_build_object('summary_version_id', v.id, 'pedagogical_documentation_only', true,
        'reviewed_by', p_actor, 'approval', pg_catalog.left(p_reason, 200)),
      p_actor)
  on conflict (tenant_id, student_id, source_type, source_ref) do update set
    lesson_objective = excluded.lesson_objective, content_practiced = excluded.content_practiced,
    recurring_errors = excluded.recurring_errors, strengths_observed = excluded.strengths_observed,
    homework_assigned = excluded.homework_assigned, recommended_next_step = excluded.recommended_next_step,
    confidence_level = excluded.confidence_level, verification_status = 'VERIFIED',
    metadata = excluded.metadata, updated_at = pg_catalog.now();

  insert into private.google_meet_access_events (tenant_id, actor_id, lesson_session_id, action)
  values (s.tenant_id, p_actor, s.id, 'SUMMARY_VERIFIED');
  return 'approved';
end;
$$;

revoke all on function private.approve_proposed_summary(uuid, uuid, text, uuid) from public, anon, authenticated;

create or replace function private.class_log_approves_summary()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  if new.lesson_session_id is null or coalesce(new.approval_status, '') <> 'APPROVED'
     or coalesce(new.presence, '') <> 'COMPLETED' then
    return null;
  end if;
  begin
    perform private.approve_proposed_summary(new.lesson_session_id, new.teacher_id,
      'Aprovado ao lançar a aula (decisão do Vinícius, 22/11/2026)', new.id);
  exception when others then
    -- O lançamento da aula nunca pode falhar por causa do resumo.
    raise warning 'class_log_approves_summary: % (%)', sqlerrm, sqlstate;
  end;
  return null;
end;
$$;

drop trigger if exists zz_class_log_approves_summary on public.class_logs;
create trigger zz_class_log_approves_summary
  after insert or update of approval_status, lesson_session_id, presence on public.class_logs
  for each row execute function private.class_log_approves_summary();

-- Caminho inverso: o resumo da IA costuma nascer DEPOIS do lançamento (30 min a
-- algumas horas após a aula). Rascunho novo de aula já lançada e aprovada é
-- aprovado na hora, em nome do professor que lançou.
create or replace function private.summary_draft_after_class_log()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  l public.class_logs;
begin
  if new.status <> 'PROPOSED' or pg_catalog.pg_trigger_depth() > 1 then
    return null;
  end if;
  select * into l from public.class_logs
   where lesson_session_id = new.lesson_session_id
     and approval_status = 'APPROVED' and presence = 'COMPLETED'
   order by created_at desc limit 1;
  if l.id is null then return null; end if;
  begin
    perform private.approve_proposed_summary(new.lesson_session_id, l.teacher_id,
      'Aprovado ao lançar a aula (decisão do Vinícius, 22/11/2026)', l.id);
  exception when others then
    raise warning 'summary_draft_after_class_log: % (%)', sqlerrm, sqlstate;
  end;
  return null;
end;
$$;

drop trigger if exists zz_summary_draft_after_class_log on private.lesson_summary_versions;
create trigger zz_summary_draft_after_class_log
  after insert on private.lesson_summary_versions
  for each row execute function private.summary_draft_after_class_log();
