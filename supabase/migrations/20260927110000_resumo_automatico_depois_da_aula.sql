-- Resumo por IA automático depois de cada aula (onda 2, frente "resumo-auto").
--
-- Decisões da direção (26/09/2026) que esta migration implementa:
--   * resumo por IA AUTOMÁTICO depois de toda aula documentada, num fornecedor
--     PAGO que não usa o conteúdo para treinar (OpenRouter com
--     provider.data_collection = "deny"; a chamada é da edge google-meet);
--   * teto de gasto mensal por escola (padrão US$ 20), que a direção vê e muda em
--     "Conta central Google". Atingido o teto, a geração automática para; a
--     manual continua, pedindo o aceite de custo de sempre;
--   * a memória do aluno continua só com resumo APROVADO pelo professor: o
--     rascunho da IA é PROPOSED e entra na fila "Aulas para revisar", com o prazo
--     em que deixa de poder ser aprovado (fim da retenção das fontes);
--   * resumos parados há 3+ dias viram pendência da direção
--     (director_pending_counts.resumos_para_revisar).
--
-- Peças:
--   1. ai_usage_events.reasoning_tokens (tokens de raciocínio do modelo);
--   2. private.google_meet_summary_settings (teto por escola, pausa automática);
--   3. private.google_meet_summary_generations (livro de cada geração: lease,
--      hash das fontes, estimativa, custo real, tokens) — é ele que garante que o
--      mesmo conteúdo nunca é cobrado duas vezes e que soma o gasto do mês;
--   4. réguas private.meet_summary_* (elegibilidade, gasto, fila de revisão);
--   5. public.google_meet_summary_backend (só service_role, usado pela edge);
--   6. RPCs da tela: get/set do teto (direção) e a fila de revisão;
--   7. get_pending_google_meet_sync_sessions ganha a operação GENERATE_SUMMARY
--      (UMA por rodada) — remendo por ÂNCORA na definição viva;
--   8. director_pending_counts ganha resumos_para_revisar — remendo por ÂNCORA.
--
-- Os remendos por âncora (7 e 8) leem a definição viva com pg_get_functiondef e
-- param com erro se a âncora sumir: outras frentes da onda 2 mexem nessas mesmas
-- funções, e recriar a função inteira apagaria o que elas acrescentaram.
--
-- Re-executável: if not exists, drop/add constraint, create or replace, remendo
-- só quando a marca ainda não está na definição. Sem begin/commit. SECURITY
-- DEFINER nova: search_path = '' e dono postgres.

-- 1. Tokens de raciocínio no registro de consumo de IA ---------------------------
-- Os tokens de raciocínio são cobrados como saída e já estão dentro de
-- output_tokens (completion_tokens do OpenRouter); a coluna é a quebra, para o
-- painel de custo mostrar quanto do gasto foi "pensando".
alter table public.ai_usage_events add column if not exists reasoning_tokens integer not null default 0;
alter table public.ai_usage_events drop constraint if exists ai_usage_events_reasoning_tokens_check;
alter table public.ai_usage_events add constraint ai_usage_events_reasoning_tokens_check
  check (reasoning_tokens >= 0);
comment on column public.ai_usage_events.reasoning_tokens is
  'Tokens de raciocínio do modelo. Já estão dentro de output_tokens (são cobrados como saída); a coluna é só a quebra.';

-- 2. Teto mensal por escola -------------------------------------------------------
create table if not exists private.google_meet_summary_settings (
  tenant_id text primary key references public.tenants(id) on delete cascade,
  -- Sem linha = padrão de US$ 20/mês. Zero desliga a geração automática.
  monthly_cap_usd numeric(10,2) not null default 20,
  -- Estimativa da última geração avaliada: a fila só oferece trabalho novo
  -- quando ele ainda cabe no teto (sem isso, com o teto quase no fim, a edge
  -- seria chamada a cada 15 min para recusar).
  last_estimate_usd numeric(12,6),
  -- Pausa automática quando a IA não está configurada no servidor (sem chave,
  -- sem flag, sem preço do modelo): a fila não chama a edge à toa.
  auto_paused_until timestamptz,
  auto_pause_reason text,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table private.google_meet_summary_settings drop constraint if exists google_meet_summary_settings_cap_check;
alter table private.google_meet_summary_settings add constraint google_meet_summary_settings_cap_check
  check (monthly_cap_usd >= 0 and monthly_cap_usd <= 500);
alter table private.google_meet_summary_settings drop constraint if exists google_meet_summary_settings_estimate_check;
alter table private.google_meet_summary_settings add constraint google_meet_summary_settings_estimate_check
  check (last_estimate_usd is null or (last_estimate_usd >= 0 and last_estimate_usd <= 5));
alter table private.google_meet_summary_settings drop constraint if exists google_meet_summary_settings_pause_check;
alter table private.google_meet_summary_settings add constraint google_meet_summary_settings_pause_check
  check (auto_pause_reason is null or auto_pause_reason ~ '^[a-z_]{1,80}$');
alter table private.google_meet_summary_settings owner to postgres;
alter table private.google_meet_summary_settings enable row level security;
revoke all on private.google_meet_summary_settings from public, anon, authenticated, service_role;
comment on table private.google_meet_summary_settings is
  'Teto mensal (US$) do resumo por IA das aulas, por escola. Sem linha = US$ 20. A direção muda em "Conta central Google".';

-- 3. Livro das gerações -------------------------------------------------------------
create table if not exists private.google_meet_summary_generations (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id),
  lesson_session_id uuid not null,
  trigger text not null,
  status text not null default 'RUNNING',
  -- sha256 de "id:content_sha256" das fontes (ordenadas): o MESMO conteúdo não é
  -- gerado duas vezes (índice único das bem-sucedidas).
  sources_sha256 text not null,
  source_artifact_ids uuid[] not null,
  model_id text not null,
  -- Estimativa reservada no início (entrada aproximada + teto de saída). Conta no
  -- gasto do mês até o custo real chegar — e fica valendo se o worker morrer no
  -- meio (o provedor pode ter cobrado).
  estimated_usd numeric(12,6) not null,
  cost_usd numeric(12,6),
  cost_source text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  reasoning_tokens integer not null default 0,
  cached_tokens integer not null default 0,
  error_code text,
  summary_version_id uuid,
  requested_by uuid references public.profiles(id) on delete set null,
  lease_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key (lesson_session_id, tenant_id) references public.lesson_sessions(id, tenant_id)
);
alter table private.google_meet_summary_generations drop constraint if exists google_meet_summary_generations_trigger_check;
alter table private.google_meet_summary_generations add constraint google_meet_summary_generations_trigger_check
  check (trigger in ('AUTOMATIC','MANUAL'));
alter table private.google_meet_summary_generations drop constraint if exists google_meet_summary_generations_status_check;
alter table private.google_meet_summary_generations add constraint google_meet_summary_generations_status_check
  check (status in ('RUNNING','SUCCEEDED','FAILED','ABANDONED'));
alter table private.google_meet_summary_generations drop constraint if exists google_meet_summary_generations_hash_check;
alter table private.google_meet_summary_generations add constraint google_meet_summary_generations_hash_check
  check (sources_sha256 ~ '^[a-f0-9]{64}$' and cardinality(source_artifact_ids) between 1 and 6);
alter table private.google_meet_summary_generations drop constraint if exists google_meet_summary_generations_model_check;
alter table private.google_meet_summary_generations add constraint google_meet_summary_generations_model_check
  check (model_id ~ '^[a-z0-9][a-z0-9._-]{0,60}(/[A-Za-z0-9][A-Za-z0-9._-]{0,100})?$');
alter table private.google_meet_summary_generations drop constraint if exists google_meet_summary_generations_money_check;
alter table private.google_meet_summary_generations add constraint google_meet_summary_generations_money_check
  check (estimated_usd >= 0 and estimated_usd <= 5 and (cost_usd is null or (cost_usd >= 0 and cost_usd <= 50))
    and (cost_source is null or cost_source in ('PROVIDER','PRICING','NONE')));
alter table private.google_meet_summary_generations drop constraint if exists google_meet_summary_generations_tokens_check;
alter table private.google_meet_summary_generations add constraint google_meet_summary_generations_tokens_check
  check (input_tokens >= 0 and output_tokens >= 0 and reasoning_tokens >= 0 and cached_tokens >= 0);
alter table private.google_meet_summary_generations drop constraint if exists google_meet_summary_generations_error_check;
alter table private.google_meet_summary_generations add constraint google_meet_summary_generations_error_check
  check (error_code is null or error_code ~ '^[a-z_]{1,80}$');
create unique index if not exists google_meet_summary_generations_once_idx
  on private.google_meet_summary_generations(lesson_session_id, sources_sha256) where status = 'SUCCEEDED';
create unique index if not exists google_meet_summary_generations_running_idx
  on private.google_meet_summary_generations(lesson_session_id) where status = 'RUNNING';
create index if not exists google_meet_summary_generations_month_idx
  on private.google_meet_summary_generations(tenant_id, created_at);
alter table private.google_meet_summary_generations owner to postgres;
alter table private.google_meet_summary_generations enable row level security;
revoke all on private.google_meet_summary_generations from public, anon, authenticated, service_role;
comment on table private.google_meet_summary_generations is
  'Cada geração de resumo por IA de uma aula (automática ou manual): fontes (hash), estimativa, custo real e tokens. Base do teto mensal.';

-- As funções novas (dono postgres) gravam o rascunho e o registro de acesso nas
-- tabelas do Meet, que são do supabase_admin. Só inserção; a leitura o postgres
-- já tem.
grant insert on private.lesson_summary_versions to postgres;
grant insert on private.google_meet_access_events to postgres;

-- 4. Réguas -----------------------------------------------------------------------
-- Início do mês corrente no calendário da escola (America/Sao_Paulo).
create or replace function private.meet_summary_month_start()
returns timestamptz
language sql stable security definer set search_path = '' as $$
  select pg_catalog.timezone('America/Sao_Paulo',
    pg_catalog.date_trunc('month', pg_catalog.timezone('America/Sao_Paulo', pg_catalog.now())));
$$;

create or replace function private.meet_summary_cap(p_tenant text)
returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce((select settings.monthly_cap_usd from private.google_meet_summary_settings as settings
    where settings.tenant_id = p_tenant), 20.00::numeric);
$$;

-- Gasto do mês: custo real de cada geração ou, sem ele (em andamento, worker
-- que morreu, resposta incerta), a estimativa reservada. Automáticas e manuais.
create or replace function private.meet_summary_month_spend(p_tenant text)
returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(pg_catalog.sum(coalesce(generation.cost_usd, generation.estimated_usd)), 0)::numeric
  from private.google_meet_summary_generations as generation
  where generation.tenant_id = p_tenant
    and generation.created_at >= private.meet_summary_month_start();
$$;

-- A fila pode oferecer uma geração automática desta escola agora: sem pausa, teto
-- maior que zero e o gasto do mês mais a última estimativa ainda cabem no teto.
create or replace function private.meet_summary_auto_budget_ok(p_tenant text)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select coalesce(settings.auto_paused_until, '-infinity'::timestamptz) <= pg_catalog.now()
      and private.meet_summary_cap(p_tenant) > 0
      and private.meet_summary_month_spend(p_tenant) + coalesce(settings.last_estimate_usd, 0.05)
        <= private.meet_summary_cap(p_tenant)
    from (select 1) as one
    left join private.google_meet_summary_settings as settings on settings.tenant_id = p_tenant
  ), false);
$$;

-- Fontes do resumo: a revisão mais recente, ainda na retenção, de cada documento
-- da aula (uma transcrição editada no Docs gera outra revisão — vale a última).
-- Transcrição primeiro; no máximo 6.
create or replace function private.meet_summary_session_sources(p_session uuid)
returns table (id uuid, kind text, provider_name text, content_sha256 text, imported_at timestamptz, expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select latest.id, latest.kind, latest.provider_name, latest.content_sha256, latest.imported_at, latest.expires_at
  from (
    select distinct on (revision.provider_name) revision.*
    from private.meeting_artifact_revisions as revision
    where revision.lesson_session_id = p_session and revision.expires_at > pg_catalog.now()
    order by revision.provider_name, revision.imported_at desc, revision.id
  ) as latest
  order by case when latest.kind = 'TRANSCRIPT' then 0 else 1 end, latest.imported_at desc, latest.id
  limit 6;
$$;

-- A aula pode ganhar o rascunho automático agora:
--   * aceite EFETIVO (a marca menos recusa/revogação antes do fim e o aceite do
--     termo que caiu — a mesma régua da importação);
--   * terminou há 30+ min e há menos de 7 dias (a janela da importação);
--   * tem fonte importada ainda na retenção, nenhuma chegou nos últimos 20 min e
--     nenhum documento ainda "sendo gerado" pelo Google (há menos de 6 h) — o
--     conteúdo parou de mudar, para não pagar um resumo da transcrição e outro
--     quando as anotações chegarem;
--   * ainda não tem resumo de IA nem versão aprovada (o professor já revisou);
--   * nenhuma geração em andamento; no máximo 2 tentativas automáticas que
--     falharam, com 1 h entre elas.
create or replace function private.meet_summary_auto_eligible(p_session uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select session.documentation_consent
      and session.status <> 'SUPERSEDED'
      and session.scheduled_end_at < pg_catalog.now() - interval '30 minutes'
      and session.scheduled_end_at > pg_catalog.now() - interval '7 days'
      and not private.lesson_session_documentation_blocked(session.id)
      and exists (select 1 from private.meeting_artifact_revisions as revision
        where revision.lesson_session_id = session.id and revision.expires_at > pg_catalog.now())
      and not exists (select 1 from private.meeting_artifact_revisions as revision
        where revision.lesson_session_id = session.id and revision.imported_at > pg_catalog.now() - interval '20 minutes')
      and not exists (select 1 from private.google_meet_artifact_imports as import
        where import.lesson_session_id = session.id and import.status = 'PENDING'
          and import.updated_at > pg_catalog.now() - interval '6 hours')
      and not exists (select 1 from private.lesson_summary_versions as version
        where version.lesson_session_id = session.id and (version.origin = 'GEMINI_API' or version.status = 'VERIFIED'))
      and not exists (select 1 from private.google_meet_summary_generations as generation
        where generation.lesson_session_id = session.id
          and (generation.status = 'SUCCEEDED'
            or (generation.status = 'RUNNING' and generation.lease_expires_at > pg_catalog.now())
            or (generation.status in ('FAILED','ABANDONED')
              and coalesce(generation.finished_at, generation.lease_expires_at) > pg_catalog.now() - interval '1 hour')))
      and (select pg_catalog.count(*) from private.google_meet_summary_generations as generation
        where generation.lesson_session_id = session.id and generation.trigger = 'AUTOMATIC'
          and generation.status in ('FAILED','ABANDONED')) < 2
    from public.lesson_sessions as session
    where session.id = p_session
  ), false);
$$;

-- Aulas com rascunho esperando revisão: a versão mais recente é PROPOSED (nem
-- aprovada nem rejeitada) e as fontes dela ainda existem — depois da retenção o
-- servidor recusa a aprovação (summary_artifact_scope_mismatch), então o
-- rascunho sai da fila. approvable_until = a fonte que vence primeiro.
-- pending_since = o primeiro rascunho desde a última revisão.
create or replace function private.meet_summary_review_items(p_tenant text, p_teacher uuid default null)
returns table (
  lesson_session_id uuid, student_id uuid, teacher_id uuid, class_date date,
  scheduled_start_at timestamptz, latest_version_id uuid, latest_version integer, latest_origin text,
  latest_created_at timestamptz, pending_since timestamptz, approvable_until timestamptz
)
language sql stable security definer set search_path = '' as $$
  select session.id, session.student_id, session.teacher_id, session.class_date, session.scheduled_start_at,
    latest.id, latest.version, latest.origin, latest.created_at,
    (select pg_catalog.min(draft.created_at) from private.lesson_summary_versions as draft
      where draft.lesson_session_id = session.id and draft.status = 'PROPOSED'
        and draft.version > coalesce((select pg_catalog.max(reviewed.version) from private.lesson_summary_versions as reviewed
          where reviewed.lesson_session_id = session.id and reviewed.status in ('VERIFIED','REJECTED')), 0)),
    sources.approvable_until
  from (
    select distinct on (version.lesson_session_id) version.*
    from private.lesson_summary_versions as version
    where version.tenant_id = p_tenant
    order by version.lesson_session_id, version.version desc
  ) as latest
  join public.lesson_sessions as session
    on session.id = latest.lesson_session_id and session.tenant_id = latest.tenant_id
  cross join lateral (
    select pg_catalog.min(revision.expires_at) as approvable_until,
      pg_catalog.count(revision.id) as alive
    from pg_catalog.unnest(latest.source_artifact_ids) as source(artifact_id)
    left join private.meeting_artifact_revisions as revision
      on revision.id = source.artifact_id and revision.lesson_session_id = session.id
        and revision.expires_at > pg_catalog.now()
  ) as sources
  where latest.status = 'PROPOSED'
    and session.status <> 'SUPERSEDED'
    and (p_teacher is null or session.teacher_id = p_teacher)
    and sources.alive = coalesce(pg_catalog.cardinality(latest.source_artifact_ids), 0);
$$;

-- Pendência da direção: rascunho parado há 3+ dias.
create or replace function private.meet_summary_review_stale_count(p_tenant text)
returns integer
language sql stable security definer set search_path = '' as $$
  select case when p_tenant is null then 0 else (
    select pg_catalog.count(*)::integer from private.meet_summary_review_items(p_tenant, null) as item
    where item.pending_since <= pg_catalog.now() - interval '3 days'
  ) end;
$$;

alter function private.meet_summary_month_start() owner to postgres;
alter function private.meet_summary_cap(text) owner to postgres;
alter function private.meet_summary_month_spend(text) owner to postgres;
alter function private.meet_summary_auto_budget_ok(text) owner to postgres;
alter function private.meet_summary_session_sources(uuid) owner to postgres;
alter function private.meet_summary_auto_eligible(uuid) owner to postgres;
alter function private.meet_summary_review_items(text, uuid) owner to postgres;
alter function private.meet_summary_review_stale_count(text) owner to postgres;
revoke all on function private.meet_summary_month_start() from public, anon, authenticated;
revoke all on function private.meet_summary_cap(text) from public, anon, authenticated;
revoke all on function private.meet_summary_month_spend(text) from public, anon, authenticated;
revoke all on function private.meet_summary_auto_budget_ok(text) from public, anon, authenticated;
revoke all on function private.meet_summary_session_sources(uuid) from public, anon, authenticated;
revoke all on function private.meet_summary_auto_eligible(uuid) from public, anon, authenticated;
revoke all on function private.meet_summary_review_items(text, uuid) from public, anon, authenticated;
revoke all on function private.meet_summary_review_stale_count(text) from public, anon, authenticated;

-- 5. Porta da edge (só service_role) -----------------------------------------------
-- Ações:
--   budget       — teto, gasto do mês e (com sessão) a última geração da aula;
--   auto_sources — fontes da aula para a geração automática (com a elegibilidade
--                  conferida de novo agora);
--   claim        — reserva a geração: hash das fontes calculado AQUI (não confia
--                  na edge), idempotência, lease de 3 min e, na automática, o teto
--                  (trava por escola: duas gerações simultâneas não furam o teto);
--   finish       — custo real, tokens e, se deu certo, o rascunho PROPOSED;
--   auto_pause   — a edge não tem IA configurada (flag, chave ou preço): a fila
--                  para de oferecer geração automática da escola por um tempo.
create or replace function public.google_meet_summary_backend(
  p_action text, p_tenant_id text, p_actor_id uuid default null,
  p_session_id uuid default null, p_payload jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
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
      if not private.meet_summary_auto_eligible(s.id) then
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
$$;
alter function public.google_meet_summary_backend(text, text, uuid, uuid, jsonb) owner to postgres;
revoke all on function public.google_meet_summary_backend(text, text, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.google_meet_summary_backend(text, text, uuid, uuid, jsonb) to service_role;

-- 6. Telas --------------------------------------------------------------------------
-- Teto e gasto do mês, para a direção ("Conta central Google").
create or replace function public.get_meet_summary_budget()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tenant text := public._my_tenant_id();
  v_cap numeric;
  v_spent numeric;
  v_settings private.google_meet_summary_settings%rowtype;
begin
  if (select auth.uid()) is null or v_tenant is null or public._my_role() is distinct from 'SCHOOL_ADMIN' then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  select * into v_settings from private.google_meet_summary_settings where tenant_id = v_tenant;
  v_cap := private.meet_summary_cap(v_tenant);
  v_spent := private.meet_summary_month_spend(v_tenant);
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'month', pg_catalog.to_char(pg_catalog.timezone('America/Sao_Paulo', pg_catalog.now()), 'YYYY-MM'),
    'cap_usd', v_cap,
    'default_cap', v_settings.tenant_id is null or v_settings.updated_by is null,
    'spent_usd', pg_catalog.round(v_spent, 4),
    'remaining_usd', pg_catalog.round(greatest(v_cap - v_spent, 0), 4),
    -- A geração automática parou pelo teto (a manual continua, com aceite).
    'cap_reached', v_cap <= 0 or v_spent + coalesce(v_settings.last_estimate_usd, 0.05) > v_cap,
    'paused_until', case when v_settings.auto_paused_until > pg_catalog.now() then v_settings.auto_paused_until end,
    'pause_reason', case when v_settings.auto_paused_until > pg_catalog.now() then v_settings.auto_pause_reason end,
    'automatic_count', (select pg_catalog.count(*) from private.google_meet_summary_generations as generation
      where generation.tenant_id = v_tenant and generation.trigger = 'AUTOMATIC'
        and generation.created_at >= private.meet_summary_month_start()),
    'manual_count', (select pg_catalog.count(*) from private.google_meet_summary_generations as generation
      where generation.tenant_id = v_tenant and generation.trigger = 'MANUAL'
        and generation.created_at >= private.meet_summary_month_start()),
    'failed_count', (select pg_catalog.count(*) from private.google_meet_summary_generations as generation
      where generation.tenant_id = v_tenant and generation.status in ('FAILED','ABANDONED')
        and generation.created_at >= private.meet_summary_month_start()));
end;
$$;

create or replace function public.set_meet_summary_monthly_cap(p_cap_usd numeric)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant text := public._my_tenant_id();
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null or v_tenant is null or public._my_role() is distinct from 'SCHOOL_ADMIN' then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  if p_cap_usd is null or p_cap_usd < 0 or p_cap_usd > 500 then
    raise exception 'summary_cap_invalid' using errcode = '22023';
  end if;
  insert into private.google_meet_summary_settings as settings (tenant_id, monthly_cap_usd, updated_by, updated_at)
  values (v_tenant, pg_catalog.round(p_cap_usd, 2), v_uid, pg_catalog.now())
  on conflict (tenant_id) do update set monthly_cap_usd = excluded.monthly_cap_usd,
    updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  insert into private.google_meet_access_events (tenant_id, actor_id, lesson_session_id, action)
  values (v_tenant, v_uid, null, 'SUMMARY_CAP_CHANGED');
  return public.get_meet_summary_budget();
end;
$$;

-- "Aulas para revisar": o professor vê as aulas dele (a mesma régua da
-- transcrição bruta: quem deu a aula); coordenação e direção veem as da escola.
create or replace function public.get_meet_summary_review_queue()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tenant text := public._my_tenant_id();
  v_role text := public._my_role();
  v_teacher uuid;
begin
  if (select auth.uid()) is null or v_tenant is null then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  if v_role = 'TEACHER' then
    v_teacher := (select auth.uid());
  elsif v_role in ('SCHOOL_ADMIN','COORDINATOR') and private.can_manage_lesson_quality(v_tenant) then
    v_teacher := null;
  else
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  return pg_catalog.jsonb_build_object('ok', true, 'stale_after_days', 3, 'items', coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'session_id', item.lesson_session_id,
        'student_id', item.student_id,
        'student_name', student.full_name,
        'teacher_id', item.teacher_id,
        'teacher_name', teacher.full_name,
        'class_date', item.class_date,
        'scheduled_start_at', item.scheduled_start_at,
        'version_id', item.latest_version_id,
        'version', item.latest_version,
        'origin', item.latest_origin,
        'draft_created_at', item.latest_created_at,
        'pending_since', item.pending_since,
        'approvable_until', item.approvable_until,
        'stale', item.pending_since <= pg_catalog.now() - interval '3 days')
      order by item.approvable_until nulls last, item.pending_since)
    from (select * from private.meet_summary_review_items(v_tenant, v_teacher) limit 200) as item
    join public.profiles as student on student.id = item.student_id
    join public.profiles as teacher on teacher.id = item.teacher_id), '[]'::jsonb));
end;
$$;
alter function public.get_meet_summary_budget() owner to postgres;
alter function public.set_meet_summary_monthly_cap(numeric) owner to postgres;
alter function public.get_meet_summary_review_queue() owner to postgres;
revoke all on function public.get_meet_summary_budget() from public, anon;
revoke all on function public.set_meet_summary_monthly_cap(numeric) from public, anon;
revoke all on function public.get_meet_summary_review_queue() from public, anon;
grant execute on function public.get_meet_summary_budget() to authenticated;
grant execute on function public.set_meet_summary_monthly_cap(numeric) to authenticated;
grant execute on function public.get_meet_summary_review_queue() to authenticated;

-- 7. Fila: GENERATE_SUMMARY, uma por rodada ---------------------------------------------
-- Remendo por âncora na definição viva (que hoje é a de 20260926180000 e pode ter
-- ganho ramos de outras frentes). A operação entra no grupo 1 (junto das
-- primeiras importações), pela aula mais antiga, UMA por rodada: o worker morre em
-- 150 s e a chamada ao modelo leva até ~55 s. Não depende da conta central
-- conectada (as fontes já estão no banco; actor_id nulo = geração do sistema).
do $patch_queue$
declare
  v_def text;
  v_anchor constant text := E'(\\)\\s+jobs\\s+order\\s+by\\s+jobs\\.priority_group)';
  v_branch constant text := E'union all\n'
    || E'      -- Resumo por IA depois da aula (20260927110000): UMA sessão por rodada,\n'
    || E'      -- elegível (aceite efetivo, fontes paradas, sem resumo de IA) e com saldo\n'
    || E'      -- no teto mensal da escola.\n'
    || E'      (select cand.tenant_id,null::uuid,cand.id,''GENERATE_SUMMARY'',1,cand.scheduled_end_at\n'
    || E'       from public.lesson_sessions cand\n'
    || E'       where cand.documentation_consent and cand.status<>''SUPERSEDED''\n'
    || E'         and cand.scheduled_end_at<now()-interval ''30 minutes'' and cand.scheduled_end_at>now()-interval ''7 days''\n'
    || E'         and private.meet_summary_auto_eligible(cand.id)\n'
    || E'         and private.meet_summary_auto_budget_ok(cand.tenant_id)\n'
    || E'       order by cand.scheduled_end_at limit 1)\n    ';
begin
  v_def := pg_catalog.pg_get_functiondef('public.get_pending_google_meet_sync_sessions()'::regprocedure);
  if strpos(v_def, 'GENERATE_SUMMARY') > 0 then
    return;
  end if;
  if (select pg_catalog.count(*) from pg_catalog.regexp_matches(v_def, v_anchor, 'g')) <> 1 then
    raise exception 'âncora da fila do Meet (") jobs order by jobs.priority_group") não encontrada uma única vez';
  end if;
  execute pg_catalog.regexp_replace(v_def, v_anchor, v_branch || E'\\1');
end
$patch_queue$;

-- 8. Pendência da direção: resumos parados há 3+ dias -------------------------------
-- Remendo por âncora na definição viva de director_pending_counts.
do $patch_pending$
declare
  v_def text;
  v_anchor constant text := 'return v_counts || pg_catalog.jsonb_build_object(';
begin
  v_def := pg_catalog.pg_get_functiondef('public.director_pending_counts()'::regprocedure);
  if strpos(v_def, 'resumos_para_revisar') > 0 then
    return;
  end if;
  if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1
    or strpos(v_def, 'v_tenant_id') = 0 then
    raise exception 'âncora de director_pending_counts ("%") não encontrada uma única vez', v_anchor;
  end if;
  execute replace(v_def, v_anchor,
    E'return v_counts\n    -- Rascunho de resumo de aula parado há 3+ dias (20260927110000).\n'
    || E'    || pg_catalog.jsonb_build_object(''resumos_para_revisar'', private.meet_summary_review_stale_count(v_tenant_id))\n'
    || E'    || pg_catalog.jsonb_build_object(');
end
$patch_pending$;
