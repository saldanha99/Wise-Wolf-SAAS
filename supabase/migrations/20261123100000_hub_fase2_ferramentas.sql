-- Hub, Fase 2 (23/11/2026, pedido do Vinícius): ferramentas de IA por habilidade,
-- verificador CEFR e adaptação de material autêntico. Só aditiva e re-executável.
--
-- 1. `hub_educator_materials` aceita os 8 tipos novos e guarda a ferramenta do
--    catálogo (`tool_id`, catálogo em `_shared/hub-tools.ts`).
-- 2. `private.hub_strip_answer_keys` também tira o gabarito dos tipos novos
--    (o aluno nunca recebe resposta).
-- 3. Cotas novas `educator_ai.cefr_check` e `educator_ai.adapt` por plano.
--    Teto de custo: Pro e Escola abaixo de 40% da receita com franquia cheia
--    (plano em /data/OpenBot/Shared/wisewolf/hub-fase2-plano-tecnico.md).
-- 4. `hub_reserve_feature_internal` passa a reservar as duas cotas novas pela
--    mesma regra da `educator_ai.generate` (remendo por âncora, uma vez).

-- 1. Tipos novos e ferramenta
alter table public.hub_educator_materials
  add column if not exists tool_id text;

do $constraint$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
     where conname = 'hub_educator_materials_tool_id_check'
       and conrelid = 'public.hub_educator_materials'::regclass
  ) then
    alter table public.hub_educator_materials
      add constraint hub_educator_materials_tool_id_check
      check (tool_id is null or tool_id ~ '^[a-z0-9-]{3,60}$');
  end if;
end;
$constraint$;

alter table public.hub_educator_materials
  drop constraint if exists hub_educator_materials_kind_check;
alter table public.hub_educator_materials
  add constraint hub_educator_materials_kind_check
  check (kind in (
    'worksheet', 'quiz', 'vocab_cards', 'grammar_drill', 'reading', 'conversation', 'journey',
    'matching', 'gap_fill', 'true_false', 'discussion', 'writing_prompt',
    'error_correction', 'sentence_transformation', 'text_questions'
  ));

comment on column public.hub_educator_materials.tool_id is
  'Ferramenta do catálogo do Hub (_shared/hub-tools.ts) que gerou o material; nulo = gerador livre.';

-- 2. Gabarito fora da mesa do aluno, inclusive nos tipos novos
create or replace function private.hub_strip_answer_keys(p_material jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v jsonb := coalesce(p_material, '{}'::jsonb);
  v_key text;
  v_strategies jsonb;
begin
  -- Chaves de topo que são só do professor. `answer_key` = gabarito da
  -- associação; `model_answer` = texto-modelo da redação.
  v := v - 'teacher_notes_pt' - 'retention_moves_pt' - 'answer_key' - 'model_answer';

  -- Listas de questões/itens: some com resposta, explicação e resposta-modelo
  foreach v_key in array array[
    'questions', 'exercises', 'multiple_choice', 'fill_blanks', 'open_questions', 'ai_homework', 'cards',
    'gaps', 'statements', 'sentences', 'items'
  ]
  loop
    if pg_catalog.jsonb_typeof(v -> v_key) = 'array' then
      v := pg_catalog.jsonb_set(v, array[v_key], coalesce((
        select pg_catalog.jsonb_agg(
          case when pg_catalog.jsonb_typeof(item) = 'object'
            then item - 'correct' - 'explanation_pt' - 'answer' - 'model_answer' - 'tip_pt'
            else item end)
        from pg_catalog.jsonb_array_elements(v -> v_key) as item
      ), '[]'::jsonb));
    end if;
  end loop;

  -- Foco gramatical: os "cuidados" são para o professor
  if pg_catalog.jsonb_typeof(v -> 'grammar_focus') = 'object' then
    v := pg_catalog.jsonb_set(v, '{grammar_focus}', (v -> 'grammar_focus') - 'watch_out_pt');
  end if;

  -- Leitura: scanning perde a resposta, chunking perde a tradução (o aluno traduz)
  if pg_catalog.jsonb_typeof(v -> 'strategies') = 'object' then
    v_strategies := v -> 'strategies';
    if pg_catalog.jsonb_typeof(v_strategies -> 'scanning') = 'array' then
      v_strategies := pg_catalog.jsonb_set(v_strategies, '{scanning}', coalesce((
        select pg_catalog.jsonb_agg(item - 'answer') from pg_catalog.jsonb_array_elements(v_strategies -> 'scanning') as item), '[]'::jsonb));
    end if;
    if pg_catalog.jsonb_typeof(v_strategies -> 'chunks') = 'array' then
      v_strategies := pg_catalog.jsonb_set(v_strategies, '{chunks}', coalesce((
        select pg_catalog.jsonb_agg(item - 'pt') from pg_catalog.jsonb_array_elements(v_strategies -> 'chunks') as item), '[]'::jsonb));
    end if;
    v := pg_catalog.jsonb_set(v, '{strategies}', v_strategies);
  end if;

  return v;
end;
$function$;
alter function private.hub_strip_answer_keys(jsonb) owner to postgres;
revoke all on function private.hub_strip_answer_keys(jsonb) from public, anon, authenticated, service_role;

-- 3. Cotas novas (cota de plano do Hub muda por MIGRATION, nunca à mão)
with wanted(code, feature_key, limit_value, reset_period) as (
  values
    ('DISCOVERY', 'educator_ai.cefr_check', 10, 'MONTH'),
    ('DISCOVERY', 'educator_ai.adapt', 2, 'MONTH'),
    ('PROFESSOR_PRO', 'educator_ai.cefr_check', 150, 'MONTH'),
    ('PROFESSOR_PRO', 'educator_ai.adapt', 20, 'MONTH'),
    ('PROFESSOR_ESCOLA', 'educator_ai.cefr_check', 450, 'MONTH'),
    ('PROFESSOR_ESCOLA', 'educator_ai.adapt', 60, 'MONTH')
)
insert into public.hub_plan_entitlements (plan_id, feature_key, limit_value, reset_period)
select plan.id, wanted.feature_key, wanted.limit_value, wanted.reset_period
  from wanted join public.hub_plans as plan on plan.code = wanted.code
on conflict (plan_id, feature_key) do update
  set limit_value = excluded.limit_value, reset_period = excluded.reset_period;

-- 4. Reserva aceita as cotas novas (mesma origem e metadados da geração)
do $patch$
declare
  v_signature constant text := 'private.hub_reserve_feature_internal(uuid,text,integer,uuid,text,uuid,jsonb)';
  v_old constant text := $old$  if v_feature_key = 'educator_ai.generate' then$old$;
  v_new constant text := $new$  if v_feature_key in ('educator_ai.generate', 'educator_ai.cefr_check', 'educator_ai.adapt') then$new$;
  v_def text;
  v_count integer;
begin
  if pg_catalog.to_regprocedure(v_signature) is null then
    raise exception 'hub fase 2: funcao % nao encontrada', v_signature;
  end if;
  v_def := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  -- Re-execução do release: já remendada, segue.
  if pg_catalog.strpos(v_def, 'educator_ai.cefr_check') > 0 then
    return;
  end if;
  v_count := (pg_catalog.length(v_def) - pg_catalog.length(pg_catalog.replace(v_def, v_old, '')))
    / pg_catalog.length(v_old);
  if v_count <> 1 then
    raise exception 'hub fase 2: ancora encontrada % vez(es) em %', v_count, v_signature;
  end if;
  execute pg_catalog.replace(v_def, v_old, v_new);
end;
$patch$;

do $assert$
begin
  if pg_catalog.strpos(
    pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(
      'private.hub_reserve_feature_internal(uuid,text,integer,uuid,text,uuid,jsonb)')),
    'educator_ai.cefr_check'
  ) = 0 then
    raise exception 'hub fase 2: reserva sem as cotas novas';
  end if;
end;
$assert$;
