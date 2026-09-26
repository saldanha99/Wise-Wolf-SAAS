-- Sugestões da IA para o cartão do aluno (onda 3, frente "perfil-ia").
--
-- Decisões da direção (26/09/2026) que esta migration implementa:
--   * depois que um resumo de aula é APROVADO pelo professor (ou pelo botão do
--     professor no dossiê), a IA lê a aula e SUGERE itens para o cartão do aluno
--     (public.student_learning_cards): objetivo real, temas que engajam, estilo
--     de correção e o que evitar. Cada sugestão vem com a FRASE LITERAL da aula
--     que a sustenta, conferida contra a fonte (a mesma régua de citação do
--     resumo: trecho que existe na transcrição/anotações, espaços à parte);
--   * a sugestão NUNCA entra no cartão sozinha: o professor aceita ou descarta
--     uma a uma, e aceitar grava pelo caminho do cartão
--     (save_student_learning_card: permissão, limites, regra de menor, versão
--     e histórico sem texto);
--   * nunca saúde, religião, política, família, dinheiro nem dado de terceiros
--     (e os outros dados sensíveis da LGPD): o prompt proíbe e uma lista de
--     termos, aqui E na edge, descarta a sugestão — ou a citação — que escapar;
--   * aluno menor de idade (ou com idade não atestada, ou com responsável): só
--     objetivo e temas — a régua do cartão (private.student_learning_card_minor),
--     chamada, não copiada;
--   * tudo que usa IA exige o aceite do termo que DECLARA a IA (v3 em diante)
--     do aluno e do professor da aula: o que valia no fim da aula
--     (private.meet_summary_ai_consented, a régua do resumo) E o de hoje (quem
--     revogou ou tem aceite de versão anterior não tem a aula relida pela IA);
--   * o custo conta no MESMO teto mensal do resumo por IA
--     (private.google_meet_summary_settings): private.meet_summary_month_spend
--     passa a somar as leituras para o cartão (remendo por âncora);
--   * a citação (a evidência) fica no máximo 90 dias depois da aula, como os
--     trechos da aula nos resumos (private.lesson_memory_retention_policy); o
--     texto de uma sugestão só vive enquanto ela espera decisão — aceita,
--     descartada, vencida ou retirada, fica só o hash (para não sugerir de novo)
--     e quem decidiu.
--
-- Não usa wolfie_memory_items (é lido pelo Wolfie, outra finalidade).
--
-- Re-executável: if not exists, drop/add constraint, create or replace, remendo
-- por âncora só quando a marca ainda não está na definição. Sem begin/commit.
-- SECURITY DEFINER nova: search_path = '' e dono postgres.

-- ---------------------------------------------------------------------------
-- 1. Tabelas
-- ---------------------------------------------------------------------------

-- Livro das leituras de uma aula pela IA para sugerir o cartão (uma por aula e
-- conteúdo): fontes (hash), estimativa, custo real e tokens. É o que entra no
-- teto mensal e garante que o mesmo conteúdo não é pago duas vezes. Sem texto.
create table if not exists private.student_card_suggestion_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id),
  -- Sem FK de propósito: a trilha de custo sobrevive à remoção do perfil.
  student_id uuid not null,
  lesson_session_id uuid not null,
  summary_version_id uuid not null,
  trigger text not null,
  status text not null default 'RUNNING',
  sources_sha256 text not null,
  source_artifact_ids uuid[] not null,
  model_id text not null,
  estimated_usd numeric(12,6) not null,
  cost_usd numeric(12,6),
  cost_source text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  reasoning_tokens integer not null default 0,
  cached_tokens integer not null default 0,
  suggestions_saved integer not null default 0,
  suggestions_dropped integer not null default 0,
  error_code text,
  requested_by uuid,
  lease_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key (lesson_session_id, tenant_id) references public.lesson_sessions(id, tenant_id)
);
alter table private.student_card_suggestion_runs drop constraint if exists student_card_suggestion_runs_trigger_check;
alter table private.student_card_suggestion_runs add constraint student_card_suggestion_runs_trigger_check
  check (trigger in ('AUTOMATIC','MANUAL'));
alter table private.student_card_suggestion_runs drop constraint if exists student_card_suggestion_runs_status_check;
alter table private.student_card_suggestion_runs add constraint student_card_suggestion_runs_status_check
  check (status in ('RUNNING','SUCCEEDED','FAILED','ABANDONED'));
alter table private.student_card_suggestion_runs drop constraint if exists student_card_suggestion_runs_hash_check;
alter table private.student_card_suggestion_runs add constraint student_card_suggestion_runs_hash_check
  check (sources_sha256 ~ '^[a-f0-9]{64}$' and cardinality(source_artifact_ids) between 1 and 6);
alter table private.student_card_suggestion_runs drop constraint if exists student_card_suggestion_runs_model_check;
alter table private.student_card_suggestion_runs add constraint student_card_suggestion_runs_model_check
  check (model_id ~ '^[a-z0-9][a-z0-9._-]{0,60}(/[A-Za-z0-9][A-Za-z0-9._-]{0,100})?$');
alter table private.student_card_suggestion_runs drop constraint if exists student_card_suggestion_runs_money_check;
alter table private.student_card_suggestion_runs add constraint student_card_suggestion_runs_money_check
  check (estimated_usd >= 0 and estimated_usd <= 1 and (cost_usd is null or (cost_usd >= 0 and cost_usd <= 10))
    and (cost_source is null or cost_source in ('PROVIDER','PRICING','NONE')));
alter table private.student_card_suggestion_runs drop constraint if exists student_card_suggestion_runs_counts_check;
alter table private.student_card_suggestion_runs add constraint student_card_suggestion_runs_counts_check
  check (input_tokens >= 0 and output_tokens >= 0 and reasoning_tokens >= 0 and cached_tokens >= 0
    and suggestions_saved >= 0 and suggestions_dropped >= 0);
alter table private.student_card_suggestion_runs drop constraint if exists student_card_suggestion_runs_error_check;
alter table private.student_card_suggestion_runs add constraint student_card_suggestion_runs_error_check
  check (error_code is null or error_code ~ '^[a-z_]{1,80}$');
create unique index if not exists student_card_suggestion_runs_once_idx
  on private.student_card_suggestion_runs(lesson_session_id, sources_sha256) where status = 'SUCCEEDED';
create unique index if not exists student_card_suggestion_runs_running_idx
  on private.student_card_suggestion_runs(lesson_session_id) where status = 'RUNNING';
create index if not exists student_card_suggestion_runs_month_idx
  on private.student_card_suggestion_runs(tenant_id, created_at);
create index if not exists student_card_suggestion_runs_student_idx
  on private.student_card_suggestion_runs(tenant_id, student_id, created_at desc);
alter table private.student_card_suggestion_runs owner to postgres;
alter table private.student_card_suggestion_runs enable row level security;
revoke all on private.student_card_suggestion_runs from public, anon, authenticated, service_role;
comment on table private.student_card_suggestion_runs is
  'Cada leitura de uma aula aprovada pela IA para sugerir o cartão do aluno (automática ou pelo botão do professor): hash das fontes, estimativa, custo real e tokens. Conta no teto mensal do resumo por IA. Nunca texto.';

-- As sugestões. O texto (valor e citação) só existe enquanto a sugestão espera
-- decisão; fechada (aceita, descartada, vencida ou retirada), fica o hash do
-- valor — para não sugerir de novo o que o professor já decidiu — e quem/quando.
create table if not exists private.student_card_suggestions (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  student_id uuid not null references public.profiles(id) on delete cascade,
  lesson_session_id uuid not null,
  summary_version_id uuid not null,
  run_id uuid not null references private.student_card_suggestion_runs(id) on delete cascade,
  field text not null,
  value text not null default '',
  value_sha256 text not null,
  evidence_artifact_id uuid,
  evidence_quote text,
  -- 90 dias depois do fim da aula (lesson_memory_retention_policy): a citação é
  -- trecho literal da aula, como a evidence dos resumos.
  evidence_expires_at timestamptz not null,
  status text not null default 'PENDING',
  close_reason text,
  closed_by uuid,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (lesson_session_id, tenant_id) references public.lesson_sessions(id, tenant_id) on delete cascade
);
alter table private.student_card_suggestions drop constraint if exists student_card_suggestions_field_check;
alter table private.student_card_suggestions add constraint student_card_suggestions_field_check
  check (field in ('real_goal','engaging_topics','correction_style','avoid_topics'));
alter table private.student_card_suggestions drop constraint if exists student_card_suggestions_status_check;
alter table private.student_card_suggestions add constraint student_card_suggestions_status_check
  check (status in ('PENDING','ACCEPTED','DISCARDED','EXPIRED','WITHDRAWN'));
alter table private.student_card_suggestions drop constraint if exists student_card_suggestions_text_lives_while_pending_check;
alter table private.student_card_suggestions add constraint student_card_suggestions_text_lives_while_pending_check
  check (
    (status = 'PENDING' and value <> '' and char_length(value) <= 300
      and evidence_quote is not null and char_length(evidence_quote) between 8 and 300
      and evidence_artifact_id is not null and closed_at is null)
    or (status <> 'PENDING' and value = '' and evidence_quote is null and evidence_artifact_id is null
      and closed_at is not null)
  );
alter table private.student_card_suggestions drop constraint if exists student_card_suggestions_hash_check;
alter table private.student_card_suggestions add constraint student_card_suggestions_hash_check
  check (value_sha256 ~ '^[a-f0-9]{64}$');
alter table private.student_card_suggestions drop constraint if exists student_card_suggestions_reason_check;
alter table private.student_card_suggestions add constraint student_card_suggestions_reason_check
  check (close_reason is null or close_reason ~ '^[a-z_]{1,60}$');
-- A mesma sugestão (campo + valor) não espera decisão duas vezes.
create unique index if not exists student_card_suggestions_pending_once_idx
  on private.student_card_suggestions(tenant_id, student_id, field, value_sha256) where status = 'PENDING';
create index if not exists student_card_suggestions_student_idx
  on private.student_card_suggestions(tenant_id, student_id, status);
create index if not exists student_card_suggestions_session_idx
  on private.student_card_suggestions(lesson_session_id);
create index if not exists student_card_suggestions_expiry_idx
  on private.student_card_suggestions(evidence_expires_at) where status = 'PENDING';
alter table private.student_card_suggestions owner to postgres;
alter table private.student_card_suggestions enable row level security;
revoke all on private.student_card_suggestions from public, anon, authenticated, service_role;
comment on table private.student_card_suggestions is
  'Sugestões da IA para o cartão do aluno, cada uma com a frase da aula que a sustenta. Só entram no cartão pelo aceite do professor (decide_student_card_suggestion). Texto só enquanto PENDING; a citação vence 90 dias depois da aula.';

-- Pausa automática por escola (edge sem IA configurada: flag, chave, modelo ou
-- preço) e a última estimativa (a fila só oferece trabalho que cabe no teto).
create table if not exists private.student_card_suggestion_settings (
  tenant_id text primary key references public.tenants(id) on delete cascade,
  last_estimate_usd numeric(12,6),
  paused_until timestamptz,
  pause_reason text,
  updated_at timestamptz not null default now()
);
alter table private.student_card_suggestion_settings drop constraint if exists student_card_suggestion_settings_check;
alter table private.student_card_suggestion_settings add constraint student_card_suggestion_settings_check
  check ((last_estimate_usd is null or (last_estimate_usd >= 0 and last_estimate_usd <= 1))
    and (pause_reason is null or pause_reason ~ '^[a-z_]{1,80}$'));
alter table private.student_card_suggestion_settings owner to postgres;
alter table private.student_card_suggestion_settings enable row level security;
revoke all on private.student_card_suggestion_settings from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Regras puras
-- ---------------------------------------------------------------------------

-- Prazos e tetos num lugar só.
create or replace function private.student_card_suggestion_policy()
returns jsonb
language sql immutable set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    -- A citação é trecho da aula: o mesmo prazo dos trechos nos resumos.
    'evidence_days', (private.lesson_memory_retention_policy() ->> 'lesson_excerpts_days')::integer,
    'after_leaving_days', (private.lesson_memory_retention_policy() ->> 'after_leaving_days')::integer,
    -- Automática: resumo aprovado nos últimos 14 dias.
    'auto_window_days', 14,
    'max_auto_failures', 2,
    'max_saved_per_run', 8,
    'lease_minutes', 3,
    'manual_cooldown_seconds', 60,
    'quote_min', 8,
    'quote_max', 300,
    'goal_max', (private.student_learning_card_limits() ->> 'real_goal')::integer,
    'topic_max', (private.student_learning_card_limits() ->> 'topic')::integer
  );
$$;

-- Texto para comparar: minúsculas, sem acento, só letras e números separados por
-- um espaço. A edge faz o mesmo (core.ts, foldForMatch). unaccent não existe
-- neste banco.
create or replace function private.student_card_suggestion_fold(p_value text)
returns text
language sql immutable set search_path = '' as $$
  select pg_catalog.btrim(pg_catalog.regexp_replace(
    pg_catalog.translate(pg_catalog.lower(coalesce(p_value, '')),
      'áàâãäåéèêëíìîïóòôõöúùûüçñý', 'aaaaaaeeeeiiiiooooouuuucny'),
    '[^a-z0-9]+', ' ', 'g'));
$$;

-- Termos que derrubam uma sugestão (no valor OU na citação). Já dobrados (sem
-- acento, minúsculas). "*" no fim = prefixo de palavra; com espaço = expressão.
-- A lista é CONSERVADORA de propósito: falso positivo só descarta uma sugestão
-- (o professor escreve à mão, se quiser); falso negativo guardaria dado
-- sensível. ⚠️ A edge tem a MESMA lista (student-card-suggestions/core.ts,
-- BLOCKED_TERMS); source.test.ts reprova se as duas divergirem.
create or replace function private.student_card_suggestion_blocked_terms()
returns text[]
language sql immutable set search_path = '' as $$
  select array[
    -- termos-bloqueados:inicio
    -- saúde
    'saude', 'doen*', 'sintoma*', 'diagnos*', 'tratament*', 'remedio*', 'medicament*', 'medicac*',
    'medico', 'medica', 'medicos', 'medicas', 'hospital*', 'internac*', 'cirurgi*', 'terapi*',
    'terapeut*', 'fisioterap*', 'psicolog*', 'psiquiatr*', 'ansiedade', 'ansios*', 'depress*',
    'cancer*', 'diabet*', 'autis*', 'tdah', 'deficien*', 'alergi*', 'gravid*', 'gestante', 'dor',
    'dores', 'lesao', 'lesoes', 'mental', 'health*', 'sick*', 'ill', 'illness*', 'disease*',
    'doctor*', 'medicine*', 'medication*', 'therap*', 'psycholog*', 'psychiatr*', 'anxi*',
    'autism*', 'autistic', 'adhd', 'disabilit*', 'disabled', 'allerg*', 'pregnan*', 'surger*',
    'symptom*', 'injur*', 'pain', 'painful', 'hurt*',
    -- religião
    'religi*', 'igreja*', 'church*', 'deus', 'deuses', 'god', 'gods', 'jesus', 'cristo',
    'christian*', 'cristao', 'crista', 'cristaos', 'cristas', 'cristianismo', 'biblia*', 'bible*',
    'biblic*', 'evangel*', 'catolic*', 'catholic*', 'protestant*', 'espirit*', 'spiritual*',
    'umbanda', 'candomble', 'budis*', 'buddh*', 'judai*', 'judeu*', 'judia', 'jewish',
    'muculman*', 'muslim*', 'islam*', 'ateu', 'ateia', 'ateus', 'atheis*', 'oracao', 'oracoes',
    'rezar', 'reza', 'pray*', 'missa', 'missas', 'culto', 'cultos', 'pastor', 'padre', 'faith',
    'templo*', 'mesquita*', 'mosque*', 'sinagoga*', 'synagogue*',
    -- política
    'politic*', 'partido', 'partidos', 'eleic*', 'eleitor*', 'eleito', 'eleita', 'election*',
    'voto', 'votos', 'votar', 'votac*', 'vote', 'votes', 'voting', 'governo*', 'government*',
    'president*', 'lula', 'bolsonaro', 'trump', 'biden', 'senador*', 'deputad*', 'vereador*',
    'prefeito*', 'ideolog*', 'de esquerda', 'de direita', 'extrema direita', 'extrema esquerda',
    'left wing', 'right wing', 'democrat*', 'democracia', 'republican*', 'comunis*', 'communis*',
    'socialis*', 'fascis*', 'protesto*', 'protest', 'protests',
    -- família
    'familia', 'familias', 'familiares', 'family', 'families', 'pai', 'mae', 'papai', 'mamae',
    'filho', 'filha', 'filhos', 'filhas', 'enteado*', 'enteada*', 'esposa', 'esposo', 'marido',
    'maridos', 'namorad*', 'noivo', 'noiva', 'noivad*', 'irmao', 'irma', 'irmaos', 'irmas', 'avo',
    'avos', 'neto', 'neta', 'netos', 'netas', 'tio', 'tia', 'tios', 'tias', 'primo', 'prima',
    'primos', 'primas', 'sogr*', 'cunhad*', 'genro', 'nora', 'casament*', 'casado', 'casada',
    'casados', 'divorc*', 'bebe', 'bebes', 'meus pais', 'seus pais', 'os pais', 'dos pais',
    'father', 'fathers', 'mother', 'mothers', 'motherhood', 'dad', 'dads', 'daddy', 'mom', 'moms',
    'mommy', 'mum', 'mummy', 'son', 'sons', 'daughter', 'daughters', 'wife', 'wives', 'husband',
    'husbands', 'boyfriend', 'boyfriends', 'girlfriend', 'girlfriends', 'fiance', 'fiancee',
    'brother', 'brothers', 'sister', 'sisters', 'sibling', 'siblings', 'grandmother*',
    'grandfather*', 'grandma', 'grandpa', 'grandparent*', 'grandson*', 'granddaughter*',
    'grandchild', 'grandchildren', 'uncle', 'uncles', 'aunt', 'aunts', 'auntie', 'cousin',
    'cousins', 'nephew', 'nephews', 'niece', 'nieces', 'in law', 'married', 'marriage', 'wedding',
    'weddings', 'spouse', 'spouses', 'baby', 'babies', 'child', 'children', 'parent', 'parents',
    'relatives', 'stepmother', 'stepfather', 'stepson', 'stepdaughter',
    -- dinheiro
    'dinheiro*', 'salari*', 'salary', 'salaries', 'renda', 'rendas', 'income*', 'divida*', 'debt*',
    'emprestim*', 'loan*', 'financiament*', 'pagament*', 'pagar', 'pagou', 'pago', 'paga', 'pagam',
    'mensalidade*', 'preco*', 'price*', 'aluguel*', 'rent', 'rents', 'desempreg*', 'unemploy*',
    'falencia', 'falido', 'falida', 'bankrupt*', 'money', 'cash', 'investiment*', 'investment*',
    'investing', 'investor*', 'bolsa de valores', 'stock market', 'cartao de credito',
    'credit card', 'boleto*', 'pix', 'reais', 'dolar', 'dolares', 'dollar*', 'euro', 'euros',
    'heranca', 'inheritance', 'imposto*', 'tax', 'taxes', 'finance*', 'financa*', 'financeir*',
    'financial',
    -- terceiros
    'amigo', 'amiga', 'amigos', 'amigas', 'friend', 'friends', 'colega*', 'colleague*',
    'coworker*', 'co worker', 'co workers', 'chefe', 'chefes', 'patrao', 'patroa', 'boss', 'bosses',
    'vizinh*', 'neighbo*', 'meu ex', 'minha ex',
    -- outros dados sensíveis (LGPD, art. 5º, II)
    'sexual*', 'sexo', 'sex', 'gay', 'gays', 'lesbic*', 'lesbian*', 'bissexual*', 'bisexual*',
    'homossexual*', 'homosexual*', 'transgener*', 'transgender*', 'lgbt*', 'raca', 'racial',
    'racismo', 'etnia*', 'etnic*', 'ethnic*', 'sindicat*'
    -- termos-bloqueados:fim
  ]::text[];
$$;

-- Nomes de pessoas da aula que não podem aparecer no VALOR de uma sugestão (o
-- cartão fala "do aluno", nunca de alguém). Tokens dobrados com 3+ letras,
-- fora partículas de sobrenome.
create or replace function private.student_card_suggestion_name_tokens(p_names text[])
returns text[]
language sql immutable set search_path = '' as $$
  select coalesce(pg_catalog.array_agg(distinct token.value), '{}'::text[])
  from pg_catalog.unnest(coalesce(p_names, '{}'::text[])) as name(value)
  cross join lateral pg_catalog.regexp_split_to_table(private.student_card_suggestion_fold(name.value), ' ') as token(value)
  where pg_catalog.char_length(token.value) >= 3
    and token.value not in ('dos', 'das', 'del', 'der', 'van', 'von', 'teacher', 'prof', 'professor', 'professora');
$$;

-- O texto cai na lista de exclusão? Termos (palavra, prefixo ou expressão),
-- nomes de pessoas da aula, e-mail, endereço de site, @perfil, valor em
-- dinheiro e número longo (telefone, documento). Horário de transcrição
-- ("[10:00:01]") não conta como número. Mesma régua da edge (textBlocked).
create or replace function private.student_card_suggestion_text_blocked(p_text text, p_names text[] default '{}'::text[])
returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  v_folded text := private.student_card_suggestion_fold(p_text);
  v_padded text;
  v_tokens text[];
  v_term text;
  v_raw text := coalesce(p_text, '');
  v_clean text;
  v_match text[];
begin
  if v_folded = '' then
    return false;
  end if;
  v_padded := ' ' || v_folded || ' ';
  v_tokens := pg_catalog.string_to_array(v_folded, ' ');
  foreach v_term in array private.student_card_suggestion_blocked_terms() loop
    if pg_catalog.strpos(v_term, ' ') > 0 then
      if pg_catalog.strpos(v_padded, ' ' || v_term || ' ') > 0 then return true; end if;
    elsif pg_catalog.right(v_term, 1) = '*' then
      if exists (select 1 from pg_catalog.unnest(v_tokens) as token(value)
                  where pg_catalog.starts_with(token.value, pg_catalog.left(v_term, -1))) then
        return true;
      end if;
    elsif v_term = any (v_tokens) then
      return true;
    end if;
  end loop;
  if v_tokens && private.student_card_suggestion_name_tokens(p_names) then
    return true;
  end if;
  if v_raw ~* '[^[:space:]@]+@[^[:space:]@]+\.[[:alpha:]]{2,}'
     or v_raw ~* '(https?://|www\.)'
     or v_raw ~* '(^|[[:space:]])@[[:alnum:]_.]{3,}'
     or v_raw ~* '(r\$|us\$|€|£|\$)[[:space:]]*[0-9]' then
    return true;
  end if;
  v_clean := pg_catalog.regexp_replace(v_raw, '\[?[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?\]?', ' ', 'g');
  for v_match in select pg_catalog.regexp_matches(v_clean, '[0-9][0-9 ().-]{6,}[0-9]', 'g') loop
    if pg_catalog.char_length(pg_catalog.regexp_replace(v_match[1], '[^0-9]', '', 'g')) >= 8 then
      return true;
    end if;
  end loop;
  return false;
end;
$$;

-- A citação existe na fonte (literal, ou com os espaços e quebras de linha
-- colapsados — a mesma régua de normalizeSummary).
create or replace function private.student_card_suggestion_quote_in_source(p_quote text, p_source text)
returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(p_quote, '') <> '' and coalesce(p_source, '') <> '' and (
    pg_catalog.strpos(p_source, p_quote) > 0
    or pg_catalog.strpos(pg_catalog.regexp_replace(p_source, '\s+', ' ', 'g'),
      pg_catalog.btrim(pg_catalog.regexp_replace(p_quote, '\s+', ' ', 'g'))) > 0);
$$;

-- Hash do valor (campo + texto dobrado): identifica a sugestão sem guardar o
-- texto depois da decisão.
create or replace function private.student_card_suggestion_value_hash(p_field text, p_value text)
returns text
language sql immutable set search_path = '' as $$
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    coalesce(p_field, '') || ':' || private.student_card_suggestion_fold(p_value), 'UTF8')), 'hex');
$$;

-- Campos que a IA pode sugerir para o aluno AGORA: menor (a régua do cartão,
-- chamada, não copiada) só objetivo e temas.
create or replace function private.student_card_suggestion_fields(p_student uuid)
returns text[]
language sql stable security definer set search_path = '' as $$
  select case when private.student_learning_card_minor(p_student)
    then array['real_goal', 'engaging_topics']::text[]
    else array['real_goal', 'engaging_topics', 'correction_style', 'avoid_topics']::text[]
  end;
$$;

-- A versão aprovada que vale para a aula: a última decisão humana (maior
-- versão VERIFIED ou REJECTED) quando ela é VERIFIED. Nulo = não aprovada (ou
-- aprovada e depois rejeitada — a última decisão humana vale, como na memória).
create or replace function private.student_card_suggestion_approved_version(p_session uuid)
returns uuid
language sql stable security definer set search_path = '' as $$
  select latest.id
  from (
    select version.id, version.status
    from private.lesson_summary_versions as version
    where version.lesson_session_id = p_session
      and version.status in ('VERIFIED', 'REJECTED')
    order by version.version desc
    limit 1
  ) as latest
  where latest.status = 'VERIFIED';
$$;

-- A IA pode ler esta aula AGORA: a aula segue marcada para documentação (como
-- na reserva do resumo) e o aceite de termo que declara a IA (v3 em diante) do
-- aluno e do professor da aula valia no fim da aula (a régua do resumo) E vale
-- hoje (aceite vigente — com o código e o responsável, se o cadastro exige — e
-- última decisão "autorizo" de versão que declara a IA); a aula não tem
-- recusa/revogação antes do fim nem aceite que caiu; os registros dela não
-- foram apagados a pedido.
create or replace function private.student_card_suggestion_ai_allowed(p_session uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select session.documentation_consent
      and private.meet_summary_ai_consented(session.id)
      and private.lesson_recording_student_consent_effective(session.student_id)
      and private.lesson_recording_ai_accepted_at(session.student_id, pg_catalog.now())
      and private.lesson_recording_teacher_consent_effective(session.teacher_id)
      and private.lesson_recording_ai_accepted_at(session.teacher_id, pg_catalog.now())
      and not private.lesson_session_documentation_blocked(session.id)
      and not private.google_meet_session_records_erased(session.id)
    from public.lesson_sessions as session
    where session.id = p_session
  ), false);
$$;

-- Por que a aula NÃO pode ser lida pela IA para o cartão (nulo = pode). Vale
-- para as duas portas (automática e botão).
create or replace function private.student_card_suggestion_block(p_session uuid)
returns text
language sql stable security definer set search_path = '' as $$
  select case
    when session.id is null or session.status = 'SUPERSEDED' then 'sessao_invalida'
    when private.google_meet_session_records_erased(session.id) then 'aula_apagada'
    when private.student_card_suggestion_approved_version(session.id) is null then 'sem_aula_aprovada'
    when not exists (select 1 from public.profiles as student
        where student.id = session.student_id and student.tenant_id = session.tenant_id
          and student.role = 'STUDENT')
      or private.student_left_school_at(session.student_id) is not null then 'aluno_fora_da_escola'
    when not exists (select 1 from private.meeting_artifact_revisions as revision
        where revision.lesson_session_id = session.id and revision.expires_at > pg_catalog.now())
      then 'sem_fonte'
    when not private.student_card_suggestion_ai_allowed(session.id) then 'sem_aceite_da_ia'
    else null
  end
  from (select 1) as anchor
  left join public.lesson_sessions as session on session.id = p_session;
$$;

-- Porta automática (fila): além do bloqueio comum, o resumo aprovado nos
-- últimos 14 dias, nenhuma leitura bem-sucedida da aula (o botão continua
-- podendo, se o conteúdo mudou), nenhuma em andamento, no máximo 2 falhas
-- automáticas e 1 h entre tentativas.
create or replace function private.student_card_suggestion_auto_block(p_session uuid)
returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(private.student_card_suggestion_block(p_session), case
    when not exists (select 1 from private.lesson_summary_versions as version
        where version.id = private.student_card_suggestion_approved_version(p_session)
          and version.created_at > pg_catalog.now() - pg_catalog.make_interval(
            days => (private.student_card_suggestion_policy() ->> 'auto_window_days')::integer))
      then 'fora_da_janela'
    when exists (select 1 from private.student_card_suggestion_runs as run
        where run.lesson_session_id = p_session and run.status = 'SUCCEEDED') then 'ja_sugerido'
    when exists (select 1 from private.student_card_suggestion_runs as run
        where run.lesson_session_id = p_session and run.status = 'RUNNING'
          and run.lease_expires_at > pg_catalog.now()) then 'em_andamento'
    when (select pg_catalog.count(*) from private.student_card_suggestion_runs as run
        where run.lesson_session_id = p_session and run.trigger = 'AUTOMATIC'
          and run.status in ('FAILED', 'ABANDONED'))
        >= (private.student_card_suggestion_policy() ->> 'max_auto_failures')::integer
      then 'tentativas_esgotadas'
    when exists (select 1 from private.student_card_suggestion_runs as run
        where run.lesson_session_id = p_session and run.status in ('FAILED', 'ABANDONED')
          and coalesce(run.finished_at, run.lease_expires_at) > pg_catalog.now() - interval '1 hour')
      then 'aguardando_nova_tentativa'
    else null
  end);
$$;

-- Gasto do mês com as leituras para o cartão (custo real, ou a estimativa
-- reservada enquanto não há custo — como no resumo).
create or replace function private.student_card_suggestion_month_spend(p_tenant text)
returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(pg_catalog.sum(coalesce(run.cost_usd, run.estimated_usd)), 0)::numeric
  from private.student_card_suggestion_runs as run
  where run.tenant_id = p_tenant
    and run.created_at >= private.meet_summary_month_start();
$$;

-- ---------------------------------------------------------------------------
-- 3. O MESMO teto mensal do resumo por IA soma as leituras para o cartão
-- ---------------------------------------------------------------------------
-- Remendo por âncora na definição viva de private.meet_summary_month_spend
-- (20260927110000): tudo que lê o gasto do mês — a fila do resumo automático
-- (meet_summary_auto_budget_ok), a reserva do resumo, a tela da direção — passa
-- a contar as sugestões do cartão, sem recriar a função.
do $patch_spend$
declare
  v_def text;
  v_anchor constant text := 'select coalesce(pg_catalog.sum(coalesce(generation.cost_usd, generation.estimated_usd)), 0)::numeric';
begin
  v_def := pg_catalog.pg_get_functiondef('private.meet_summary_month_spend(text)'::regprocedure);
  if pg_catalog.strpos(v_def, 'student_card_suggestion_month_spend') > 0 then
    return;
  end if;
  if (pg_catalog.length(v_def) - pg_catalog.length(pg_catalog.replace(v_def, v_anchor, '')))
       / pg_catalog.length(v_anchor) <> 1 then
    raise exception 'sugestoes_do_cartao_ancora_mudou: meet_summary_month_spend';
  end if;
  execute pg_catalog.replace(v_def, v_anchor,
    'select private.student_card_suggestion_month_spend(p_tenant) + '
    || 'coalesce(pg_catalog.sum(coalesce(generation.cost_usd, generation.estimated_usd)), 0)::numeric');
end
$patch_spend$;

-- Cabe no teto: teto maior que zero e gasto do mês (resumos + cartão) mais a
-- estimativa dentro dele.
create or replace function private.student_card_suggestion_budget_ok(p_tenant text, p_estimate numeric)
returns boolean
language sql stable security definer set search_path = '' as $$
  select private.meet_summary_cap(p_tenant) > 0
    and private.meet_summary_month_spend(p_tenant) + greatest(coalesce(p_estimate, 0), 0)
      <= private.meet_summary_cap(p_tenant);
$$;

-- Tela da direção ("Conta central Google" → "Resumo automático por IA"): o
-- gasto do mês já inclui o cartão; a quebra vai junto. Remendo por âncora na
-- definição viva de get_meet_summary_budget (20260927110000).
do $patch_budget$
declare
  v_def text;
  v_anchor constant text := '''failed_count'', (select pg_catalog.count(*) from private.google_meet_summary_generations as generation';
begin
  v_def := pg_catalog.pg_get_functiondef('public.get_meet_summary_budget()'::regprocedure);
  if pg_catalog.strpos(v_def, 'card_suggestion_count') > 0 then
    return;
  end if;
  if (pg_catalog.length(v_def) - pg_catalog.length(pg_catalog.replace(v_def, v_anchor, '')))
       / pg_catalog.length(v_anchor) <> 1 then
    raise exception 'sugestoes_do_cartao_ancora_mudou: get_meet_summary_budget';
  end if;
  execute pg_catalog.replace(v_def, v_anchor,
    E'-- Sugestões da IA para o cartão do aluno (20260928130000): já dentro de spent_usd.\n'
    || E'    ''card_suggestion_count'', (select pg_catalog.count(*) from private.student_card_suggestion_runs as card_run\n'
    || E'      where card_run.tenant_id = v_tenant and card_run.created_at >= private.meet_summary_month_start()),\n'
    || E'    ''card_suggestion_spent_usd'', pg_catalog.round(private.student_card_suggestion_month_spend(v_tenant), 4),\n    '
    || v_anchor);
end
$patch_budget$;

-- Quem pede pelo botão pode editar o cartão do aluno (professor vinculado,
-- coordenação, direção — private.student_learning_card_can_edit, a MESMA
-- régua do cartão, avaliada como a própria pessoa dentro da transação:
-- private.trial_closing_act_as, e a identidade de quem chamou volta no fim).
create or replace function private.student_card_suggestion_actor_can_edit(p_tenant text, p_student uuid, p_actor uuid)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_sub text := pg_catalog.current_setting('request.jwt.claim.sub', true);
  v_claims text := pg_catalog.current_setting('request.jwt.claims', true);
  v_ok boolean;
begin
  if p_tenant is null or p_student is null or p_actor is null then
    return false;
  end if;
  perform private.trial_closing_act_as(p_actor);
  begin
    v_ok := public._my_tenant_id() = p_tenant
      and private.student_learning_card_can_edit(p_tenant, p_student);
  exception when others then
    perform private.trial_closing_restore(v_sub, v_claims);
    raise;
  end;
  perform private.trial_closing_restore(v_sub, v_claims);
  return coalesce(v_ok, false);
end;
$$;

-- A aula que o botão lê: a aprovada mais recente do aluno (últimos 90 dias)
-- que a IA pode ler e que ainda não teve leitura bem-sucedida. Sem ela, o
-- motivo: já sugerido, sem aceite do termo que declara a IA, ou sem aula
-- aprovada com a transcrição ainda guardada.
create or replace function private.student_card_suggestion_target(p_tenant text, p_student uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
  with candidates as (
    select session.id, session.class_date, session.scheduled_end_at,
      private.student_card_suggestion_block(session.id) as block,
      exists (select 1 from private.student_card_suggestion_runs as run
        where run.lesson_session_id = session.id and run.status = 'SUCCEEDED') as done,
      exists (select 1 from private.student_card_suggestion_runs as run
        where run.lesson_session_id = session.id and run.status = 'RUNNING'
          and run.lease_expires_at > pg_catalog.now()) as running
    from public.lesson_sessions as session
    where session.tenant_id = p_tenant and session.student_id = p_student
      and session.scheduled_end_at <= pg_catalog.now()
      and session.scheduled_end_at > pg_catalog.now() - interval '90 days'
      and exists (select 1 from private.lesson_summary_versions as version
        where version.lesson_session_id = session.id and version.status = 'VERIFIED')
  ), chosen as (
    select candidate.id, candidate.class_date
    from candidates as candidate
    where candidate.block is null and not candidate.done and not candidate.running
    order by candidate.scheduled_end_at desc
    limit 1
  )
  select case
    when exists (select 1 from chosen) then (
      select pg_catalog.jsonb_build_object('session_id', chosen.id, 'class_date', chosen.class_date, 'reason', null)
      from chosen)
    when exists (select 1 from candidates where block is null and not done and running) then
      pg_catalog.jsonb_build_object('session_id', null, 'reason', 'em_andamento')
    when exists (select 1 from candidates where block is null and done) then
      pg_catalog.jsonb_build_object('session_id', null, 'reason', 'ja_sugerido')
    when exists (select 1 from candidates where block = 'sem_aceite_da_ia') then
      pg_catalog.jsonb_build_object('session_id', null, 'reason', 'sem_aceite_da_ia')
    else pg_catalog.jsonb_build_object('session_id', null, 'reason', 'sem_aula_aprovada')
  end;
$$;

-- O valor já está no cartão do aluno (então a sugestão é redundante).
create or replace function private.student_card_suggestion_in_card(
  p_tenant text, p_student uuid, p_field text, p_value_hash text
) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case p_field
      when 'real_goal' then card.real_goal <> ''
        and private.student_card_suggestion_value_hash('real_goal', card.real_goal) = p_value_hash
      when 'correction_style' then card.correction_style is not null
        and private.student_card_suggestion_value_hash('correction_style', card.correction_style) = p_value_hash
      when 'engaging_topics' then exists (select 1 from pg_catalog.unnest(card.engaging_topics) as item(value)
        where private.student_card_suggestion_value_hash('engaging_topics', item.value) = p_value_hash)
      when 'avoid_topics' then exists (select 1 from pg_catalog.unnest(card.avoid_topics) as item(value)
        where private.student_card_suggestion_value_hash('avoid_topics', item.value) = p_value_hash)
      else false
    end
    from public.student_learning_cards as card
    where card.tenant_id = p_tenant and card.student_id = p_student
  ), false);
$$;

-- ---------------------------------------------------------------------------
-- 4. Porta da edge student-card-suggestions (só service_role)
-- ---------------------------------------------------------------------------
-- Ações:
--   due        — aulas prontas para a leitura automática (qualquer escola, sem
--                texto): aprovadas nos últimos 14 dias, IA autorizada, com
--                saldo no teto e escola não pausada;
--   auto_pause — a edge não tem a IA configurada: a escola sai da fila;
--   target     — a aula que o botão do professor lê (permissão conferida como
--                a própria pessoa);
--   sources    — o texto da aula para a IA (conferido de novo agora), os campos
--                permitidos (regra de menor) e os nomes que não podem aparecer;
--   claim      — reserva: hash das fontes calculado AQUI, idempotência, lease
--                de 3 min e o teto (trava por escola, a mesma do resumo);
--   finish     — custo real e tokens; cada sugestão é conferida de novo AQUI
--                (campo permitido, tamanho, citação na fonte, lista de exclusão,
--                repetida) e só então gravada como PENDING.
create or replace function public.student_card_suggestions_backend(
  p_action text, p_tenant_id text default null, p_actor_id uuid default null,
  p_session_id uuid default null, p_payload jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_policy jsonb := private.student_card_suggestion_policy();
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  s public.lesson_sessions%rowtype;
  r private.student_card_suggestion_runs%rowtype;
  v_trigger text;
  v_reason text;
  v_student uuid;
  v_version uuid;
  v_sources uuid[];
  v_hash text;
  v_model text;
  v_estimate numeric;
  v_status text;
  v_error text;
  v_fields text[];
  v_names text[];
  v_item jsonb;
  v_field text;
  v_value text;
  v_quote text;
  v_artifact_text text;
  v_artifact uuid;
  v_source_text text;
  v_value_hash text;
  v_batch text[] := '{}'::text[];
  v_saved integer := 0;
  v_dropped integer := 0;
  v_limit integer;
  v_minutes integer;
begin
  if p_action = 'due' then
    v_limit := greatest(1, least(5, coalesce(nullif(v_payload ->> 'limit', '')::integer, 3)));
    return pg_catalog.jsonb_build_object('items', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'tenant_id', due.tenant_id, 'session_id', due.session_id, 'student_id', due.student_id)
        order by due.approved_at)
      from (
        select session.tenant_id, session.id as session_id, session.student_id, latest.created_at as approved_at
        from (
          select distinct on (version.lesson_session_id) version.lesson_session_id, version.status, version.created_at
          from private.lesson_summary_versions as version
          where version.status in ('VERIFIED', 'REJECTED')
            and version.created_at > pg_catalog.now() - pg_catalog.make_interval(
              days => (v_policy ->> 'auto_window_days')::integer)
          order by version.lesson_session_id, version.version desc
        ) as latest
        join public.lesson_sessions as session on session.id = latest.lesson_session_id
        left join private.student_card_suggestion_settings as settings on settings.tenant_id = session.tenant_id
        where latest.status = 'VERIFIED'
          and (p_tenant_id is null or session.tenant_id = p_tenant_id)
          and coalesce(settings.paused_until, '-infinity'::timestamptz) <= pg_catalog.now()
          and private.student_card_suggestion_budget_ok(session.tenant_id, coalesce(settings.last_estimate_usd, 0.01))
          and private.student_card_suggestion_auto_block(session.id) is null
        order by latest.created_at
        limit v_limit
      ) as due), '[]'::jsonb));
  end if;

  if coalesce(p_tenant_id, '') = '' then
    raise exception 'tenant_scope_required' using errcode = '22023';
  end if;

  if p_action = 'auto_pause' then
    v_minutes := greatest(15, least(1440, coalesce(nullif(v_payload ->> 'minutes', '')::integer, 60)));
    insert into private.student_card_suggestion_settings as settings (tenant_id, paused_until, pause_reason, updated_at)
    values (p_tenant_id, pg_catalog.now() + pg_catalog.make_interval(mins => v_minutes),
      case when coalesce(v_payload ->> 'reason', '') ~ '^[a-z_]{1,80}$' then v_payload ->> 'reason'
        else 'card_suggestions_not_configured' end, pg_catalog.now())
    on conflict (tenant_id) do update set paused_until = excluded.paused_until,
      pause_reason = excluded.pause_reason, updated_at = excluded.updated_at;
    return pg_catalog.jsonb_build_object('ok', true);
  end if;

  if p_action = 'target' then
    v_student := nullif(v_payload ->> 'student_id', '')::uuid;
    if not private.student_card_suggestion_actor_can_edit(p_tenant_id, v_student, p_actor_id) then
      raise exception 'sem_permissao' using errcode = '42501';
    end if;
    return private.student_card_suggestion_target(p_tenant_id, v_student)
      || pg_catalog.jsonb_build_object('budget_ok', private.student_card_suggestion_budget_ok(p_tenant_id, 0.01));
  end if;

  select * into s from public.lesson_sessions where id = p_session_id and tenant_id = p_tenant_id;
  if s.id is null then
    raise exception 'lesson_session_not_found' using errcode = '22023';
  end if;

  if p_action in ('sources', 'claim') then
    v_trigger := v_payload ->> 'trigger';
    if v_trigger is null or v_trigger not in ('AUTOMATIC', 'MANUAL') then
      raise exception 'invalid_suggestion_trigger' using errcode = '22023';
    end if;
    if v_trigger = 'MANUAL'
       and not private.student_card_suggestion_actor_can_edit(s.tenant_id, s.student_id, p_actor_id) then
      raise exception 'sem_permissao' using errcode = '42501';
    end if;
    v_reason := case when v_trigger = 'AUTOMATIC' then private.student_card_suggestion_auto_block(s.id)
      else private.student_card_suggestion_block(s.id) end;
    if v_reason is not null then
      return pg_catalog.jsonb_build_object('eligible', false, 'claimed', false, 'reason', v_reason,
        'sources', '[]'::jsonb);
    end if;
  end if;

  if p_action = 'sources' then
    insert into private.google_meet_access_events (tenant_id, actor_id, lesson_session_id, action)
    values (s.tenant_id, case when v_trigger = 'MANUAL' then p_actor_id end, s.id, 'CARD_SUGGESTIONS_SOURCES_READ');
    return pg_catalog.jsonb_build_object(
      'eligible', true,
      'minor', private.student_learning_card_minor(s.student_id),
      'fields', pg_catalog.to_jsonb(private.student_card_suggestion_fields(s.student_id)),
      'class_date', s.class_date,
      -- Nomes que não podem aparecer no valor de uma sugestão (a edge soma os
      -- rótulos de quem falou na transcrição).
      'people_names', coalesce((select pg_catalog.jsonb_agg(person.full_name)
        from public.profiles as person
        where person.id in (s.student_id, s.teacher_id) and coalesce(person.full_name, '') <> ''), '[]'::jsonb),
      'sources', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', revision.id, 'kind', revision.kind,
            'provider_name', revision.provider_name, 'imported_at', revision.imported_at,
            'source_text', revision.source_text) order by source.ordinality)
        from private.meet_summary_session_sources(s.id) with ordinality as source
        join private.meeting_artifact_revisions as revision on revision.id = source.id), '[]'::jsonb));

  elsif p_action = 'claim' then
    v_model := v_payload ->> 'model_id';
    if v_model is null or v_model !~ '^[a-z0-9][a-z0-9._-]{0,60}(/[A-Za-z0-9][A-Za-z0-9._-]{0,100})?$' then
      raise exception 'card_suggestions_model_invalid' using errcode = '22023';
    end if;
    v_estimate := nullif(v_payload ->> 'estimated_usd', '')::numeric;
    if v_estimate is null or v_estimate < 0 or v_estimate > 1 then
      raise exception 'card_suggestions_pricing_required' using errcode = '22023';
    end if;
    v_sources := array(select pg_catalog.jsonb_array_elements_text(
      coalesce(v_payload -> 'source_artifact_ids', '[]'::jsonb)))::uuid[];
    if coalesce(pg_catalog.cardinality(v_sources), 0) not between 1 and 6
      or (select pg_catalog.count(distinct x) from pg_catalog.unnest(v_sources) as x) <> pg_catalog.cardinality(v_sources)
      or exists (select 1 from pg_catalog.unnest(v_sources) as x where not exists (
        select 1 from private.meeting_artifact_revisions as revision
        where revision.id = x and revision.tenant_id = s.tenant_id and revision.lesson_session_id = s.id
          and revision.expires_at > pg_catalog.now())) then
      raise exception 'suggestion_artifact_scope_mismatch' using errcode = '42501';
    end if;
    -- O hash é do conteúdo que o banco guarda, não do que a edge disser.
    select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.string_agg(
        revision.id::text || ':' || revision.content_sha256, ',' order by revision.id), 'UTF8')), 'hex')
      into v_hash
      from private.meeting_artifact_revisions as revision
     where revision.id = any (v_sources);

    -- Uma escola por vez, com a MESMA trava da reserva do resumo: resumo e
    -- cartão disputam o mesmo teto sem furá-lo.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('google-meet-summary-budget:' || s.tenant_id, 0));
    -- Lease vencida (o worker morreu): ABANDONED; o custo fica a estimativa.
    update private.student_card_suggestion_runs as run
       set status = 'ABANDONED', finished_at = pg_catalog.now(),
           error_code = coalesce(run.error_code, 'card_suggestions_worker_lost')
     where run.lesson_session_id = s.id and run.status = 'RUNNING'
       and run.lease_expires_at <= pg_catalog.now();
    if exists (select 1 from private.student_card_suggestion_runs as run
      where run.lesson_session_id = s.id and run.status = 'SUCCEEDED' and run.sources_sha256 = v_hash) then
      return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'ja_sugerido');
    end if;
    if exists (select 1 from private.student_card_suggestion_runs as run
      where run.lesson_session_id = s.id and run.status = 'RUNNING') then
      return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'em_andamento');
    end if;
    if v_trigger = 'MANUAL' and exists (select 1 from private.student_card_suggestion_runs as run
      where run.tenant_id = s.tenant_id and run.student_id = s.student_id
        and run.created_at > pg_catalog.now() - pg_catalog.make_interval(
          secs => (v_policy ->> 'manual_cooldown_seconds')::integer)) then
      return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'aguarde_um_minuto');
    end if;
    insert into private.student_card_suggestion_settings as settings (tenant_id, last_estimate_usd, updated_at)
    values (s.tenant_id, v_estimate, pg_catalog.now())
    on conflict (tenant_id) do update set last_estimate_usd = excluded.last_estimate_usd, updated_at = excluded.updated_at;
    -- O teto vale para as duas portas: o botão não tem aceite de custo à parte.
    if not private.student_card_suggestion_budget_ok(s.tenant_id, v_estimate) then
      return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'teto_atingido',
        'cap_usd', private.meet_summary_cap(s.tenant_id),
        'spent_usd', pg_catalog.round(private.meet_summary_month_spend(s.tenant_id), 4));
    end if;
    insert into private.student_card_suggestion_runs (tenant_id, student_id, lesson_session_id, summary_version_id,
      trigger, status, sources_sha256, source_artifact_ids, model_id, estimated_usd, requested_by, lease_expires_at)
    values (s.tenant_id, s.student_id, s.id, private.student_card_suggestion_approved_version(s.id), v_trigger, 'RUNNING',
      v_hash, v_sources, v_model, v_estimate, case when v_trigger = 'MANUAL' then p_actor_id end,
      pg_catalog.now() + pg_catalog.make_interval(mins => (v_policy ->> 'lease_minutes')::integer))
    returning * into r;
    insert into private.google_meet_access_events (tenant_id, actor_id, lesson_session_id, action)
    values (s.tenant_id, r.requested_by, s.id, 'CARD_SUGGESTIONS_CLAIMED');
    return pg_catalog.jsonb_build_object('claimed', true, 'run_id', r.id, 'sources_sha256', v_hash,
      'lease_expires_at', r.lease_expires_at);

  elsif p_action = 'finish' then
    select * into r from private.student_card_suggestion_runs as run
     where run.id = nullif(v_payload ->> 'run_id', '')::uuid
       and run.tenant_id = s.tenant_id and run.lesson_session_id = s.id
     for update;
    if r.id is null then
      raise exception 'suggestion_run_not_found' using errcode = '22023';
    end if;
    if r.status not in ('RUNNING', 'ABANDONED') then
      raise exception 'suggestion_run_already_finished' using errcode = '55000';
    end if;
    v_status := v_payload ->> 'status';
    if v_status is null or v_status not in ('SUCCEEDED', 'FAILED') then
      raise exception 'invalid_suggestion_run_status' using errcode = '22023';
    end if;
    v_error := case when coalesce(v_payload ->> 'error_code', '') ~ '^[a-z_]{1,80}$' then v_payload ->> 'error_code' end;
    v_dropped := greatest(0, least(100, coalesce(nullif(v_payload ->> 'dropped', '')::integer, 0)));
    if v_status = 'SUCCEEDED' then
      if pg_catalog.jsonb_typeof(v_payload -> 'suggestions') is distinct from 'array'
         or pg_catalog.jsonb_array_length(v_payload -> 'suggestions') > 20 then
        raise exception 'invalid_suggestions' using errcode = '22023';
      end if;
      v_reason := private.student_card_suggestion_block(s.id);
      if v_reason is not null then
        -- A autorização caiu (ou a aprovação saiu) durante a leitura: o custo
        -- fica registrado, nenhuma sugestão.
        v_status := 'FAILED';
        v_error := v_reason;
      else
        v_version := private.student_card_suggestion_approved_version(s.id);
        v_fields := private.student_card_suggestion_fields(s.student_id);
        select coalesce(pg_catalog.array_agg(person.full_name), '{}'::text[]) into v_names
          from public.profiles as person where person.id in (s.student_id, s.teacher_id);
        for v_item in select value from pg_catalog.jsonb_array_elements(v_payload -> 'suggestions') loop
          v_field := v_item ->> 'field';
          v_value := private.student_learning_card_clean_text(v_item ->> 'value');
          v_quote := pg_catalog.btrim(coalesce(v_item ->> 'quote', ''));
          v_artifact_text := coalesce(v_item ->> 'artifact_id', '');
          v_artifact := case when v_artifact_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            then v_artifact_text::uuid end;
          if v_field = 'correction_style' then
            v_value := pg_catalog.lower(v_value);
          end if;
          v_source_text := (select revision.source_text from private.meeting_artifact_revisions as revision
            where revision.id = v_artifact and revision.lesson_session_id = s.id
              and revision.expires_at > pg_catalog.now());
          v_value_hash := private.student_card_suggestion_value_hash(v_field, v_value);
          if v_saved >= (v_policy ->> 'max_saved_per_run')::integer
            or v_field is null or not (v_field = any (v_fields))
            or (v_field = 'correction_style' and v_value not in ('immediate', 'end', 'selective', 'examiner'))
            or (v_field = 'real_goal' and pg_catalog.char_length(v_value) not between 3 and (v_policy ->> 'goal_max')::integer)
            or (v_field in ('engaging_topics', 'avoid_topics')
              and pg_catalog.char_length(v_value) not between 2 and (v_policy ->> 'topic_max')::integer)
            or pg_catalog.char_length(v_quote) not between (v_policy ->> 'quote_min')::integer and (v_policy ->> 'quote_max')::integer
            or v_artifact is null or not (v_artifact = any (r.source_artifact_ids))
            or not private.student_card_suggestion_quote_in_source(v_quote, v_source_text)
            or private.student_card_suggestion_text_blocked(v_value, v_names)
            or private.student_card_suggestion_text_blocked(v_quote, '{}'::text[])
            or v_value_hash = any (v_batch)
            -- Já decidida (ou esperando decisão) antes — de qualquer aula.
            or exists (select 1 from private.student_card_suggestions as previous
              where previous.tenant_id = s.tenant_id and previous.student_id = s.student_id
                and previous.field = v_field and previous.value_sha256 = v_value_hash
                and previous.status in ('PENDING', 'ACCEPTED', 'DISCARDED'))
            or private.student_card_suggestion_in_card(s.tenant_id, s.student_id, v_field, v_value_hash) then
            v_dropped := v_dropped + 1;
            continue;
          end if;
          insert into private.student_card_suggestions (tenant_id, student_id, lesson_session_id, summary_version_id,
            run_id, field, value, value_sha256, evidence_artifact_id, evidence_quote, evidence_expires_at)
          values (s.tenant_id, s.student_id, s.id, v_version, r.id, v_field, v_value, v_value_hash, v_artifact,
            v_quote, s.scheduled_end_at + pg_catalog.make_interval(days => (v_policy ->> 'evidence_days')::integer));
          v_batch := v_batch || v_value_hash;
          v_saved := v_saved + 1;
        end loop;
      end if;
    end if;
    update private.student_card_suggestion_runs as run set
      status = v_status,
      finished_at = pg_catalog.now(),
      cost_usd = case when nullif(v_payload ->> 'cost_usd', '') is not null
        then least(10, greatest(0, (v_payload ->> 'cost_usd')::numeric)) end,
      cost_source = case when v_payload ->> 'cost_source' in ('PROVIDER', 'PRICING', 'NONE')
        then v_payload ->> 'cost_source' end,
      input_tokens = greatest(0, coalesce(nullif(v_payload ->> 'input_tokens', '')::integer, 0)),
      output_tokens = greatest(0, coalesce(nullif(v_payload ->> 'output_tokens', '')::integer, 0)),
      reasoning_tokens = greatest(0, coalesce(nullif(v_payload ->> 'reasoning_tokens', '')::integer, 0)),
      cached_tokens = greatest(0, coalesce(nullif(v_payload ->> 'cached_tokens', '')::integer, 0)),
      suggestions_saved = v_saved,
      suggestions_dropped = v_dropped,
      error_code = case when v_status = 'FAILED' then coalesce(v_error, 'card_suggestions_failed') end
    where run.id = r.id
    returning * into r;
    insert into private.google_meet_access_events (tenant_id, actor_id, lesson_session_id, action)
    values (s.tenant_id, r.requested_by, s.id, 'CARD_SUGGESTIONS_' || r.status);
    return pg_catalog.jsonb_build_object('status', r.status, 'error_code', r.error_code,
      'saved', r.suggestions_saved, 'dropped', r.suggestions_dropped);
  end if;
  raise exception 'unknown_suggestion_action' using errcode = '22023';
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Telas (dossiê → cartão do aluno)
-- ---------------------------------------------------------------------------

-- Sugestões esperando decisão, com a frase da aula e a data. Só para quem pode
-- editar o cartão (a mesma régua do cartão). Menor: só objetivo e temas — os
-- outros campos nem saem daqui (e são apagados pela varredura). Aula que
-- deixou de estar aprovada ou foi apagada a pedido não mostra sugestão.
create or replace function public.get_student_card_suggestions(p_student_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tenant text := public._my_tenant_id();
  v_fields text[];
  v_target jsonb;
begin
  if (select auth.uid()) is null or v_tenant is null or p_student_id is null
     or not private.student_learning_card_can_edit(v_tenant, p_student_id) then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  v_fields := private.student_card_suggestion_fields(p_student_id);
  v_target := private.student_card_suggestion_target(v_tenant, p_student_id);
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'is_minor', private.student_learning_card_minor(p_student_id),
    'allowed_fields', pg_catalog.to_jsonb(v_fields),
    'can_request', v_target ->> 'session_id' is not null,
    'request_reason', v_target -> 'reason',
    'request_class_date', v_target -> 'class_date',
    'budget_reached', not private.student_card_suggestion_budget_ok(v_tenant, 0.01),
    'suggestions', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', suggestion.id,
          'field', suggestion.field,
          'value', suggestion.value,
          'quote', suggestion.evidence_quote,
          'class_date', session.class_date,
          'teacher_name', teacher.full_name,
          'already_in_card', private.student_card_suggestion_in_card(
            v_tenant, p_student_id, suggestion.field, suggestion.value_sha256),
          'evidence_expires_at', suggestion.evidence_expires_at,
          'created_at', suggestion.created_at)
        order by session.class_date desc,
          pg_catalog.array_position(array['real_goal', 'engaging_topics', 'correction_style', 'avoid_topics']::text[],
            suggestion.field),
          suggestion.created_at, suggestion.id)
      from private.student_card_suggestions as suggestion
      join public.lesson_sessions as session
        on session.id = suggestion.lesson_session_id and session.tenant_id = suggestion.tenant_id
      left join public.profiles as teacher on teacher.id = session.teacher_id
      where suggestion.tenant_id = v_tenant and suggestion.student_id = p_student_id
        and suggestion.status = 'PENDING'
        and suggestion.field = any (v_fields)
        and suggestion.evidence_expires_at > pg_catalog.now()
        and private.student_card_suggestion_approved_version(suggestion.lesson_session_id) is not null
        and not private.google_meet_session_records_erased(suggestion.lesson_session_id)
    ), '[]'::jsonb));
end;
$$;

-- Aceitar ou descartar UMA sugestão. Aceitar grava no cartão pela RPC do
-- cartão (save_student_learning_card): permissão, limites, regra de menor,
-- conferência de versão (p_expected_version = a versão que a tela carregou) e
-- histórico sem texto. Objetivo e estilo substituem; tema e "o que evitar"
-- entram na lista. Fechada, a sugestão perde o texto.
create or replace function public.decide_student_card_suggestion(
  p_suggestion_id uuid, p_accept boolean, p_expected_version integer default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant text := public._my_tenant_id();
  v_row private.student_card_suggestions%rowtype;
  v_card jsonb;
  v_limits jsonb := private.student_learning_card_limits();
  v_goal text;
  v_topics text[];
  v_style text;
  v_avoid text[];
  v_notes text;
begin
  if (select auth.uid()) is null or v_tenant is null or p_suggestion_id is null or p_accept is null then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  select * into v_row from private.student_card_suggestions as suggestion
   where suggestion.id = p_suggestion_id
   for update;
  if v_row.id is null or v_row.tenant_id is distinct from v_tenant
     or not private.student_learning_card_can_edit(v_tenant, v_row.student_id) then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;
  if v_row.status <> 'PENDING' then
    raise exception 'sugestao_ja_decidida' using errcode = '22023';
  end if;

  if p_accept then
    if not (v_row.field = any (private.student_card_suggestion_fields(v_row.student_id))) then
      raise exception 'cartao_campo_de_menor:%', v_row.field using errcode = '22023';
    end if;
    if private.student_card_suggestion_approved_version(v_row.lesson_session_id) is null
       or private.google_meet_session_records_erased(v_row.lesson_session_id)
       or v_row.evidence_expires_at <= pg_catalog.now() then
      raise exception 'sugestao_sem_aula_aprovada' using errcode = '22023';
    end if;
    if not private.student_card_suggestion_in_card(v_tenant, v_row.student_id, v_row.field, v_row.value_sha256) then
      -- O cartão como a tela o vê (menor: campos pessoais vazios, que é o que o
      -- cartão de menor aceita).
      v_card := private.student_learning_card_view(v_tenant, v_row.student_id);
      v_goal := coalesce(v_card ->> 'real_goal', '');
      v_topics := array(select pg_catalog.jsonb_array_elements_text(coalesce(v_card -> 'engaging_topics', '[]'::jsonb)));
      v_style := v_card ->> 'correction_style';
      v_avoid := array(select pg_catalog.jsonb_array_elements_text(coalesce(v_card -> 'avoid_topics', '[]'::jsonb)));
      v_notes := coalesce(v_card ->> 'notes', '');
      if v_row.field = 'real_goal' then
        v_goal := v_row.value;
      elsif v_row.field = 'correction_style' then
        v_style := v_row.value;
      elsif v_row.field = 'engaging_topics' then
        if pg_catalog.cardinality(v_topics) >= (v_limits ->> 'engaging_topics')::integer then
          raise exception 'cartao_itens_demais:engaging_topics' using errcode = '22023';
        end if;
        v_topics := v_topics || v_row.value;
      elsif v_row.field = 'avoid_topics' then
        if pg_catalog.cardinality(v_avoid) >= (v_limits ->> 'avoid_topics')::integer then
          raise exception 'cartao_itens_demais:avoid_topics' using errcode = '22023';
        end if;
        v_avoid := v_avoid || v_row.value;
      end if;
      perform public.save_student_learning_card(v_row.student_id, v_goal, v_topics, v_style, v_avoid, v_notes,
        p_expected_version);
    end if;
  end if;

  update private.student_card_suggestions as suggestion
     set status = case when p_accept then 'ACCEPTED' else 'DISCARDED' end,
         value = '', evidence_quote = null, evidence_artifact_id = null,
         close_reason = null, closed_by = (select auth.uid()), closed_at = pg_catalog.now()
   where suggestion.id = v_row.id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'status', case when p_accept then 'ACCEPTED' else 'DISCARDED' end,
    'learning_card', private.student_learning_card_view(v_tenant, v_row.student_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Limpezas: rejeição, exclusão a pedido, regra de menor, prazos
-- ---------------------------------------------------------------------------

-- A última decisão humana vale: rejeitar o resumo depois de aprovar retira as
-- sugestões daquela aula que ainda esperavam decisão (e o texto delas).
create or replace function private.student_card_suggestions_on_summary_rejected()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from private.lesson_summary_versions as newer
     where newer.lesson_session_id = new.lesson_session_id
       and newer.version > new.version
       and newer.status in ('VERIFIED', 'REJECTED')
  ) then
    return null;
  end if;
  update private.student_card_suggestions as suggestion
     set status = 'WITHDRAWN', close_reason = 'summary_rejected',
         value = '', evidence_quote = null, evidence_artifact_id = null, closed_at = pg_catalog.now()
   where suggestion.lesson_session_id = new.lesson_session_id
     and suggestion.status = 'PENDING';
  return null;
end;
$$;
drop trigger if exists trg_zz_card_suggestions_summary_rejected on private.lesson_summary_versions;
create trigger trg_zz_card_suggestions_summary_rejected
  after insert on private.lesson_summary_versions
  for each row when (new.status = 'REJECTED')
  execute function private.student_card_suggestions_on_summary_rejected();

-- Exclusão a pedido (erase_student_lesson_records marca as aulas em
-- google_meet_original_sessions.records_erased_at): as sugestões das aulas
-- apagadas saem inteiras. Vale para qualquer escritor da marca.
create or replace function private.student_card_suggestions_on_records_erased()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from private.student_card_suggestions as suggestion
   where suggestion.lesson_session_id = new.lesson_session_id;
  return null;
end;
$$;
drop trigger if exists trg_zz_card_suggestions_records_erased on private.google_meet_original_sessions;
create trigger trg_zz_card_suggestions_records_erased
  after insert or update of records_erased_at on private.google_meet_original_sessions
  for each row when (new.records_erased_at is not null)
  execute function private.student_card_suggestions_on_records_erased();

-- Quem passa a ser menor perde as sugestões de estilo de correção e "o que
-- evitar" que esperavam decisão — o texto é apagado, não só escondido (a mesma
-- regra do cartão). p_student nulo = todos.
create or replace function private.student_card_suggestions_purge_minor(p_student uuid default null)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  with purged as (
    update private.student_card_suggestions as suggestion
       set status = 'WITHDRAWN', close_reason = 'minor_rule',
           value = '', evidence_quote = null, evidence_artifact_id = null, closed_at = pg_catalog.now()
     where (p_student is null or suggestion.student_id = p_student)
       and suggestion.status = 'PENDING'
       and suggestion.field in ('correction_style', 'avoid_topics')
       and private.student_learning_card_minor(suggestion.student_id)
    returning 1
  )
  select pg_catalog.count(*)::integer into v_count from purged;
  return v_count;
end;
$$;

-- Gatilho em profiles: nunca derruba a edição da ficha (a varredura diária
-- repete o que falhar).
create or replace function private.student_card_suggestions_minor_purge_on_profile()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform private.student_card_suggestions_purge_minor(new.id);
  exception when others then
    raise warning 'sugestões do cartão: limpeza de menor falhou para %: %', new.id, sqlerrm;
  end;
  return null;
end;
$$;
drop trigger if exists trg_student_card_suggestions_minor_purge on public.profiles;
create trigger trg_student_card_suggestions_minor_purge
  after update of is_kids, birth_date, guardian_id, guardian_name on public.profiles
  for each row
  when (
    new.role = 'STUDENT'
    and (new.is_kids is distinct from old.is_kids
      or new.birth_date is distinct from old.birth_date
      or new.guardian_id is distinct from old.guardian_id
      or new.guardian_name is distinct from old.guardian_name)
  )
  execute function private.student_card_suggestions_minor_purge_on_profile();

-- Varredura diária:
--   (a) citação vencida (90 dias depois da aula): a sugestão que esperava
--       decisão vira EXPIRED e perde o texto (sem a frase da aula o professor
--       não tem como conferir);
--   (b) aluno que deixou a escola há mais de 90 dias: as sugestões saem
--       inteiras (como o cartão e a memória, purge_lesson_memory_retention);
--   (c) regra de menor (a régua do termo pode mudar sem tocar em profiles);
--   (d) aula que deixou de estar aprovada: retirada.
-- Só contagens no retorno. Re-executável.
create or replace function private.purge_student_card_suggestions()
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_policy jsonb := private.student_card_suggestion_policy();
  v_expired integer := 0;
  v_left integer := 0;
  v_minor integer := 0;
  v_unapproved integer := 0;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('student-card-suggestions-retention', 0));
  update private.student_card_suggestions as suggestion
     set status = 'EXPIRED', close_reason = 'evidence_retention',
         value = '', evidence_quote = null, evidence_artifact_id = null, closed_at = pg_catalog.now()
   where suggestion.status = 'PENDING' and suggestion.evidence_expires_at <= pg_catalog.now();
  get diagnostics v_expired = row_count;

  delete from private.student_card_suggestions as suggestion
   where private.student_left_school_at(suggestion.student_id)
     < pg_catalog.now() - pg_catalog.make_interval(days => (v_policy ->> 'after_leaving_days')::integer);
  get diagnostics v_left = row_count;

  v_minor := private.student_card_suggestions_purge_minor(null);

  update private.student_card_suggestions as suggestion
     set status = 'WITHDRAWN', close_reason = 'summary_not_approved',
         value = '', evidence_quote = null, evidence_artifact_id = null, closed_at = pg_catalog.now()
   where suggestion.status = 'PENDING'
     and private.student_card_suggestion_approved_version(suggestion.lesson_session_id) is null;
  get diagnostics v_unapproved = row_count;

  return pg_catalog.jsonb_build_object('expired', v_expired, 'left_school_deleted', v_left,
    'minor_withdrawn', v_minor, 'unapproved_withdrawn', v_unapproved);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Fila: a cada 15 min, só chama a edge quando há aula pronta
-- ---------------------------------------------------------------------------
create or replace function public.trigger_student_card_suggestions()
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_key text;
  v_request bigint;
begin
  if pg_catalog.jsonb_array_length(
       public.student_card_suggestions_backend('due', null, null, null, '{"limit":1}'::jsonb) -> 'items') = 0 then
    return null;
  end if;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'wisewolf_service_role_key' limit 1;
  if nullif(v_key, '') is null then
    return null;
  end if;
  select net.http_post(url := 'http://kong:8000/functions/v1/student-card-suggestions',
    headers := pg_catalog.jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{"action":"tick"}'::jsonb, timeout_milliseconds := 150000) into v_request;
  return v_request;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Donos e permissões
-- ---------------------------------------------------------------------------
do $owners$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'private.student_card_suggestion_policy()',
    'private.student_card_suggestion_fold(text)',
    'private.student_card_suggestion_blocked_terms()',
    'private.student_card_suggestion_name_tokens(text[])',
    'private.student_card_suggestion_text_blocked(text,text[])',
    'private.student_card_suggestion_quote_in_source(text,text)',
    'private.student_card_suggestion_value_hash(text,text)',
    'private.student_card_suggestion_fields(uuid)',
    'private.student_card_suggestion_approved_version(uuid)',
    'private.student_card_suggestion_ai_allowed(uuid)',
    'private.student_card_suggestion_block(uuid)',
    'private.student_card_suggestion_auto_block(uuid)',
    'private.student_card_suggestion_month_spend(text)',
    'private.student_card_suggestion_budget_ok(text,numeric)',
    'private.student_card_suggestion_actor_can_edit(text,uuid,uuid)',
    'private.student_card_suggestion_target(text,uuid)',
    'private.student_card_suggestion_in_card(text,uuid,text,text)',
    'private.student_card_suggestions_on_summary_rejected()',
    'private.student_card_suggestions_on_records_erased()',
    'private.student_card_suggestions_purge_minor(uuid)',
    'private.student_card_suggestions_minor_purge_on_profile()',
    'private.purge_student_card_suggestions()',
    'public.trigger_student_card_suggestions()'
  ] loop
    execute pg_catalog.format('alter function %s owner to postgres', v_signature);
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated, service_role', v_signature);
  end loop;
  alter function public.student_card_suggestions_backend(text, text, uuid, uuid, jsonb) owner to postgres;
  revoke all on function public.student_card_suggestions_backend(text, text, uuid, uuid, jsonb)
    from public, anon, authenticated;
  grant execute on function public.student_card_suggestions_backend(text, text, uuid, uuid, jsonb) to service_role;
  foreach v_signature in array array[
    'public.get_student_card_suggestions(uuid)',
    'public.decide_student_card_suggestion(uuid,boolean,integer)'
  ] loop
    execute pg_catalog.format('alter function %s owner to postgres', v_signature);
    execute pg_catalog.format('revoke all on function %s from public, anon, service_role', v_signature);
    execute pg_catalog.format('grant execute on function %s to authenticated', v_signature);
  end loop;
end
$owners$;

-- ---------------------------------------------------------------------------
-- 9. Agendamentos
-- ---------------------------------------------------------------------------
do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'wisewolf-student-card-suggestions';
    perform cron.schedule('wisewolf-student-card-suggestions', '4,19,34,49 * * * *',
      'select public.trigger_student_card_suggestions();');
    perform cron.unschedule(jobid) from cron.job where jobname = 'wisewolf-card-suggestions-retention';
    perform cron.schedule('wisewolf-card-suggestions-retention', '47 6 * * *',
      'select private.purge_student_card_suggestions();');
  end if;
end
$cron$;
