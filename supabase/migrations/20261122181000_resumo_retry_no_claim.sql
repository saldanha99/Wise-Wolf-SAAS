-- Reprocessar resumos que falharam por crédito (22/11/2026), parte 2.
--
-- O claim AUTOMATIC exige meet_summary_auto_eligible (janela de 7 dias e no
-- máximo 2 falhas). A ação de serviço retry_failed_summaries manda
-- retry_failed=true no payload; nesse caso o claim aceita também a aula que
-- falhou por falta de crédito/indisponibilidade do provedor e ainda não tem
-- resumo da IA nem aprovado. Aceite do termo, IA autorizada, fontes vivas, trava
-- da escola e TETO MENSAL continuam conferidos aqui embaixo, como antes.
-- A função só é executável por service_role (o payload não vem do navegador).
-- Corpo = definição de produção de 22/11/2026 com essa única condição a mais.

CREATE OR REPLACE FUNCTION public.google_meet_summary_backend(p_action text, p_tenant_id text, p_actor_id uuid DEFAULT NULL::uuid, p_session_id uuid DEFAULT NULL::uuid, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  s public.lesson_sessions%rowtype;
  a public.profiles%rowtype;
  g private.google_meet_summary_generations%rowtype;
  v_trigger text;
  v_sources uuid[];
  v_hash text;
  v_estimate numeric;
  v_cap numeric;
  v_spent numeric;
  v_model text;
  v_status text;
  v_content jsonb;
  v_version integer;
  v_version_id uuid;
  v_minutes integer;
  v_raw boolean;
begin
  if coalesce(p_tenant_id, '') = '' then
    raise exception 'tenant_scope_required' using errcode = '22023';
  end if;

  if p_action = 'budget' then
    v_cap := private.meet_summary_cap(p_tenant_id);
    v_spent := private.meet_summary_month_spend(p_tenant_id);
    return pg_catalog.jsonb_build_object(
      'cap_usd', v_cap,
      'spent_usd', pg_catalog.round(v_spent, 4),
      'remaining_usd', pg_catalog.round(greatest(v_cap - v_spent, 0), 4),
      'cap_reached', not private.meet_summary_auto_budget_ok(p_tenant_id)
        and coalesce((select settings.auto_paused_until from private.google_meet_summary_settings as settings
          where settings.tenant_id = p_tenant_id), '-infinity'::timestamptz) <= pg_catalog.now(),
      'paused_until', (select settings.auto_paused_until from private.google_meet_summary_settings as settings
        where settings.tenant_id = p_tenant_id and settings.auto_paused_until > pg_catalog.now()),
      'pause_reason', (select settings.auto_pause_reason from private.google_meet_summary_settings as settings
        where settings.tenant_id = p_tenant_id and settings.auto_paused_until > pg_catalog.now()),
      'last_generation', case when p_session_id is null then null else (
        select pg_catalog.jsonb_build_object('trigger', generation.trigger, 'status', generation.status,
          'error_code', generation.error_code, 'created_at', generation.created_at,
          'finished_at', generation.finished_at)
        from private.google_meet_summary_generations as generation
        where generation.tenant_id = p_tenant_id and generation.lesson_session_id = p_session_id
        order by generation.created_at desc limit 1) end);
  elsif p_action = 'auto_pause' then
    v_minutes := greatest(15, least(1440, coalesce((p_payload ->> 'minutes')::integer, 60)));
    insert into private.google_meet_summary_settings as settings (tenant_id, auto_paused_until, auto_pause_reason, updated_at)
    values (p_tenant_id, pg_catalog.now() + pg_catalog.make_interval(mins => v_minutes),
      coalesce(nullif(p_payload ->> 'reason', ''), 'google_summary_ai_not_configured'), pg_catalog.now())
    on conflict (tenant_id) do update set auto_paused_until = excluded.auto_paused_until,
      auto_pause_reason = excluded.auto_pause_reason, updated_at = pg_catalog.now();
    return pg_catalog.jsonb_build_object('ok', true);
  end if;

  select * into s from public.lesson_sessions where id = p_session_id and tenant_id = p_tenant_id;
  if s.id is null then raise exception 'lesson_session_not_found' using errcode = '22023'; end if;

  if p_action = 'auto_sources' then
    if not private.meet_summary_auto_eligible(s.id) then
      return pg_catalog.jsonb_build_object('eligible', false, 'sources', '[]'::jsonb);
    end if;
    insert into private.google_meet_access_events (tenant_id, actor_id, lesson_session_id, action)
    values (s.tenant_id, null, s.id, 'SUMMARY_AI_SOURCES_READ');
    return pg_catalog.jsonb_build_object('eligible', true, 'sources', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', revision.id, 'kind', revision.kind,
          'provider_name', revision.provider_name, 'source_text', revision.source_text,
          'expires_at', revision.expires_at) order by source.ordinality)
      from private.meet_summary_session_sources(s.id) with ordinality as source
      join private.meeting_artifact_revisions as revision on revision.id = source.id), '[]'::jsonb));

  elsif p_action = 'claim' then
    v_trigger := p_payload ->> 'trigger';
    if v_trigger is null or v_trigger not in ('AUTOMATIC','MANUAL') then
      raise exception 'invalid_summary_trigger' using errcode = '22023'; end if;
    v_model := p_payload ->> 'model_id';
    if v_model is null or v_model !~ '^[a-z0-9][a-z0-9._-]{0,60}(/[A-Za-z0-9][A-Za-z0-9._-]{0,100})?$' then
      raise exception 'google_summary_model_invalid' using errcode = '22023'; end if;
    v_estimate := nullif(p_payload ->> 'estimated_usd', '')::numeric;
    if v_estimate is null or v_estimate < 0 or v_estimate > 5 then
      raise exception 'google_summary_pricing_required' using errcode = '22023'; end if;
    -- Aceite efetivo, como na importação: sem ele nada da aula vai para a IA.
    if not s.documentation_consent or private.lesson_session_documentation_blocked(s.id) then
      raise exception 'documentation_consent_required' using errcode = '42501'; end if;
    if v_trigger = 'MANUAL' then
      -- Quem pede à mão precisa ver a fonte: professor da aula, coordenação e
      -- direção da escola (a mesma régua da transcrição bruta).
      select * into a from public.profiles where id = p_actor_id;
      v_raw := a.id is not null and pg_catalog.lower(coalesce(a.lifecycle_status, '')) = 'active'
        and ((a.role in ('SCHOOL_ADMIN','COORDINATOR') and a.tenant_id = s.tenant_id)
          or (a.role = 'TEACHER' and s.teacher_id = a.id));
      if not v_raw then raise exception 'google_meet_raw_access_required' using errcode = '42501'; end if;
    end if;
    -- IA só com aceite de termo que a declara, valendo no fim da aula (aluno e
    -- professor). Vale para o botão manual também: o aceite de custo da tela é
    -- da escola, não da família.
    if not private.meet_summary_ai_consented(s.id) then
      return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'google_summary_ai_consent_required');
    end if;
    v_sources := array(select pg_catalog.jsonb_array_elements_text(coalesce(p_payload -> 'source_artifact_ids', '[]'::jsonb)))::uuid[];
    if coalesce(pg_catalog.cardinality(v_sources), 0) not between 1 and 6
      or (select pg_catalog.count(distinct x) from pg_catalog.unnest(v_sources) as x) <> pg_catalog.cardinality(v_sources)
      or exists (select 1 from pg_catalog.unnest(v_sources) as x where not exists (
        select 1 from private.meeting_artifact_revisions as revision
        where revision.id = x and revision.tenant_id = s.tenant_id and revision.lesson_session_id = s.id
          and revision.expires_at > pg_catalog.now())) then
      raise exception 'summary_artifact_scope_mismatch' using errcode = '42501'; end if;
    -- O hash é do conteúdo que o banco guarda, não do que a edge disser.
    select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.string_agg(
        revision.id::text || ':' || revision.content_sha256, ',' order by revision.id), 'UTF8')), 'hex')
      into v_hash
      from private.meeting_artifact_revisions as revision
     where revision.id = any (v_sources);

    -- Uma escola por vez: o teto é conferido e reservado na mesma trava.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('google-meet-summary-budget:' || s.tenant_id, 0));
    -- Lease vencida (o worker morreu): a geração vira ABANDONED. O custo fica a
    -- estimativa — o provedor pode ter cobrado.
    update private.google_meet_summary_generations as generation
       set status = 'ABANDONED', finished_at = pg_catalog.now(),
           error_code = coalesce(generation.error_code, 'google_summary_worker_lost')
     where generation.lesson_session_id = s.id and generation.status = 'RUNNING'
       and generation.lease_expires_at <= pg_catalog.now();
    if exists (select 1 from private.google_meet_summary_generations as generation
      where generation.lesson_session_id = s.id and generation.status = 'SUCCEEDED'
        and generation.sources_sha256 = v_hash) then
      return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'google_summary_already_generated');
    end if;
    if exists (select 1 from private.google_meet_summary_generations as generation
      where generation.lesson_session_id = s.id and generation.status = 'RUNNING') then
      return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'google_summary_generation_rate_limited');
    end if;
    if v_trigger = 'MANUAL' then
      if exists (select 1 from private.google_meet_summary_generations as generation
        where generation.lesson_session_id = s.id and generation.created_at > pg_catalog.now() - interval '60 seconds') then
        return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'google_summary_generation_rate_limited');
      end if;
    else
      if not private.meet_summary_auto_eligible(s.id)
        -- 22/11/2026: reprocessamento (só serviço) das aulas que falharam por falta
        -- de crédito/indisponibilidade do provedor, sem a janela de 7 dias.
        and not (
          coalesce((p_payload ->> 'retry_failed')::boolean, false)
          and exists (select 1 from private.google_meet_summary_generations as failed
            where failed.lesson_session_id = s.id and failed.status = 'FAILED'
              and failed.error_code in ('google_summary_provider_credits', 'google_summary_provider_unavailable'))
          and not exists (select 1 from private.lesson_summary_versions as version
            where version.lesson_session_id = s.id and (version.origin = 'GEMINI_API' or version.status = 'VERIFIED'))
        ) then
        return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'google_summary_not_eligible');
      end if;
      insert into private.google_meet_summary_settings as settings (tenant_id, last_estimate_usd, updated_at)
      values (s.tenant_id, v_estimate, pg_catalog.now())
      on conflict (tenant_id) do update set last_estimate_usd = excluded.last_estimate_usd;
      v_cap := private.meet_summary_cap(s.tenant_id);
      v_spent := private.meet_summary_month_spend(s.tenant_id);
      if v_cap <= 0 or v_spent + v_estimate > v_cap then
        return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'google_summary_budget_exhausted',
          'cap_usd', v_cap, 'spent_usd', pg_catalog.round(v_spent, 4));
      end if;
    end if;
    insert into private.google_meet_summary_generations (tenant_id, lesson_session_id, trigger, status, sources_sha256,
      source_artifact_ids, model_id, estimated_usd, requested_by, lease_expires_at)
    values (s.tenant_id, s.id, v_trigger, 'RUNNING', v_hash, v_sources, v_model, v_estimate,
      case when v_trigger = 'MANUAL' then p_actor_id end, pg_catalog.now() + interval '3 minutes')
    returning * into g;
    insert into private.google_meet_access_events (tenant_id, actor_id, lesson_session_id, action)
    values (s.tenant_id, case when v_trigger = 'MANUAL' then p_actor_id end, s.id, 'SUMMARY_AI_CLAIMED');
    return pg_catalog.jsonb_build_object('claimed', true, 'generation_id', g.id, 'sources_sha256', v_hash,
      'lease_expires_at', g.lease_expires_at);

  elsif p_action = 'finish' then
    select * into g from private.google_meet_summary_generations as generation
     where generation.id = nullif(p_payload ->> 'generation_id', '')::uuid
       and generation.tenant_id = s.tenant_id and generation.lesson_session_id = s.id
     for update;
    if g.id is null then raise exception 'summary_generation_not_found' using errcode = '22023'; end if;
    if g.status not in ('RUNNING','ABANDONED') then
      raise exception 'summary_generation_already_finished' using errcode = '55000'; end if;
    v_status := p_payload ->> 'status';
    if v_status is null or v_status not in ('SUCCEEDED','FAILED') then
      raise exception 'invalid_summary_generation_status' using errcode = '22023'; end if;
    v_content := p_payload -> 'content';
    v_version_id := null;
    if v_status = 'SUCCEEDED' then
      if pg_catalog.jsonb_typeof(v_content) is distinct from 'object' or pg_catalog.octet_length(v_content::text) > 150000
        or pg_catalog.jsonb_typeof(v_content -> 'evidence') is distinct from 'array'
        or pg_catalog.jsonb_array_length(v_content -> 'evidence') = 0 then
        raise exception 'invalid_summary' using errcode = '22023'; end if;
      if not s.documentation_consent or private.lesson_session_documentation_blocked(s.id) then
        -- A escola retirou a autorização durante a geração: o custo fica
        -- registrado, o rascunho não.
        v_status := 'FAILED';
        p_payload := p_payload || pg_catalog.jsonb_build_object('error_code', 'documentation_consent_required');
      elsif exists (select 1 from pg_catalog.unnest(g.source_artifact_ids) as x where not exists (
        select 1 from private.meeting_artifact_revisions as revision
        where revision.id = x and revision.lesson_session_id = s.id and revision.expires_at > pg_catalog.now())) then
        v_status := 'FAILED';
        p_payload := p_payload || pg_catalog.jsonb_build_object('error_code', 'summary_artifact_scope_mismatch');
      elsif g.trigger = 'AUTOMATIC' and exists (select 1 from private.lesson_summary_versions as version
        where version.lesson_session_id = s.id and version.status in ('VERIFIED','REJECTED')
          and version.created_at >= g.created_at) then
        -- O professor revisou enquanto a IA escrevia: um rascunho novo por cima
        -- devolveria a aula para a fila de revisão.
        p_payload := p_payload || pg_catalog.jsonb_build_object('error_code', 'summary_reviewed_meanwhile');
      else
        perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('google-meet-summary:' || s.id::text, 0));
        select coalesce(pg_catalog.max(version.version), 0) + 1 into v_version
          from private.lesson_summary_versions as version where version.lesson_session_id = s.id;
        insert into private.lesson_summary_versions (tenant_id, lesson_session_id, version, status, origin, content,
          source_artifact_ids, model_id, prompt_version, created_by)
        values (s.tenant_id, s.id, v_version, 'PROPOSED', 'GEMINI_API', v_content, g.source_artifact_ids,
          g.model_id, nullif(left(coalesce(p_payload ->> 'prompt_version', ''), 80), ''), g.requested_by)
        returning id into v_version_id;
      end if;
    end if;
    update private.google_meet_summary_generations as generation set
      status = v_status,
      finished_at = pg_catalog.now(),
      cost_usd = case when p_payload ? 'cost_usd' and nullif(p_payload ->> 'cost_usd', '') is not null
        then least(50, greatest(0, (p_payload ->> 'cost_usd')::numeric)) else null end,
      cost_source = case when p_payload ->> 'cost_source' in ('PROVIDER','PRICING','NONE') then p_payload ->> 'cost_source' end,
      input_tokens = greatest(0, coalesce((p_payload ->> 'input_tokens')::integer, 0)),
      output_tokens = greatest(0, coalesce((p_payload ->> 'output_tokens')::integer, 0)),
      reasoning_tokens = greatest(0, coalesce((p_payload ->> 'reasoning_tokens')::integer, 0)),
      cached_tokens = greatest(0, coalesce((p_payload ->> 'cached_tokens')::integer, 0)),
      error_code = case when coalesce(p_payload ->> 'error_code', '') ~ '^[a-z_]{1,80}$' then p_payload ->> 'error_code' end,
      summary_version_id = v_version_id
    where generation.id = g.id
    returning * into g;
    insert into private.google_meet_access_events (tenant_id, actor_id, lesson_session_id, action)
    values (s.tenant_id, g.requested_by, s.id, 'SUMMARY_AI_' || g.status);
    return pg_catalog.jsonb_build_object('status', g.status, 'error_code', g.error_code,
      'summary', case when v_version_id is null then null else (
        select pg_catalog.to_jsonb(saved) from private.lesson_summary_versions as saved where saved.id = v_version_id) end);
  end if;
  raise exception 'unknown_summary_action' using errcode = '22023';
end;
$function$;

revoke all on function public.google_meet_summary_backend(text, text, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.google_meet_summary_backend(text, text, uuid, uuid, jsonb) to service_role;
