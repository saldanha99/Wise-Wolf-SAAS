-- Hub Fase 2 (23/11/2026): filtros da biblioteca por habilidade, tema, idade e
-- duração. Só aditiva e re-executável.
--
-- O catálogo cresce sozinho (o agente de conteúdo publica livros neutros pelo
-- trilho de sempre), então a classificação inicial é por REGRA, no banco:
-- `private.hub_catalog_default_tags` olha nicho, título e descrição. O gatilho
-- só preenche o que está nulo; curadoria humana grava a coluna e a regra não
-- passa por cima. Duração é ESTIMADA (a tela diz isso).

alter table public.hub_content_items
  add column if not exists skills text[],
  add column if not exists theme text,
  add column if not exists age_group text,
  add column if not exists duration_minutes integer;

do $constraints$
begin
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'hub_content_items_skills_check' and conrelid = 'public.hub_content_items'::regclass) then
    alter table public.hub_content_items add constraint hub_content_items_skills_check
      check (skills is null or skills <@ array['reading', 'vocabulary', 'speaking', 'writing', 'grammar', 'listening']::text[]);
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'hub_content_items_theme_check' and conrelid = 'public.hub_content_items'::regclass) then
    alter table public.hub_content_items add constraint hub_content_items_theme_check
      check (theme is null or theme in ('dia_a_dia', 'trabalho', 'tecnologia', 'viagem', 'saude', 'provas', 'infantil', 'conversacao', 'sociedade'));
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'hub_content_items_age_group_check' and conrelid = 'public.hub_content_items'::regclass) then
    alter table public.hub_content_items add constraint hub_content_items_age_group_check
      check (age_group is null or age_group in ('kids', 'teens', 'adults', 'all'));
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'hub_content_items_duration_check' and conrelid = 'public.hub_content_items'::regclass) then
    alter table public.hub_content_items add constraint hub_content_items_duration_check
      check (duration_minutes is null or duration_minutes between 5 and 600);
  end if;
end;
$constraints$;

create index if not exists hub_content_items_skills_idx on public.hub_content_items using gin (skills);

comment on column public.hub_content_items.skills is 'Habilidades (filtro da biblioteca). Regra em private.hub_catalog_default_tags; curadoria pode sobrescrever.';
comment on column public.hub_content_items.duration_minutes is 'Duração ESTIMADA de uso em aula, em minutos.';

create or replace function private.hub_catalog_default_tags(
  p_niche text,
  p_title text,
  p_description text
)
returns table (skills text[], theme text, age_group text, duration_minutes integer)
language sql
immutable
set search_path = ''
as $function$
  with input as (
    select pg_catalog.upper(coalesce(p_niche, '')) as niche,
           pg_catalog.lower(coalesce(p_title, '')) as title,
           pg_catalog.lower(coalesce(p_description, '')) as description
  )
  select
    case
      when niche = 'VOCABULARY' or title ~ 'word power|phrasal verbs|collocations' then array['vocabulary']
      when title ~ 'reading strateg' then array['reading', 'vocabulary']
      when title ~ 'listening' then array['listening', 'writing']
      when title ~ 'speaking and writing' then array['speaking', 'writing']
      when niche = 'CONVERSATION' or title ~ 'speak now|conversation lab' then array['speaking', 'vocabulary']
      when title ~ 'e-?mails?|calls|messages|networking' then array['writing', 'speaking', 'vocabulary']
      when title ~ 'presentations|reports' then array['speaking', 'writing']
      when title ~ 'meetings|negotiation|work conversations' then array['speaking', 'vocabulary']
      when title ~ 'debate|argument|opinions|influence' then array['speaking', 'writing']
      when title ~ 'reporting|media|stories|discourse' then array['reading', 'grammar']
      when title ~ 'verb to be|auxiliar|past continuous|hypotheses|regrets|wh questions|questions and requests' then array['grammar', 'speaking']
      when title ~ 'describing|animals|colors|food|body|family' then array['vocabulary', 'speaking']
      else array['reading', 'vocabulary', 'speaking', 'writing', 'grammar']
    end,
    case
      -- Livro de vocabulário cobre vários temas no mesmo volume ("Work, Health
      -- and Travel"): tema de nicho seria enganoso.
      when niche = 'VOCABULARY' or title ~ 'word power' then 'dia_a_dia'
      when niche = 'KIDS' or title ~ 'kids|little explorers' then 'infantil'
      when niche = 'TOEFL_IELTS' or title ~ 'toefl|ielts|test skills' then 'provas'
      when niche = 'TECH' or title ~ '\m(it|tech)\M|cyber' then 'tecnologia'
      when niche = 'TRAVEL' or title ~ 'travel|airport|getting around' then 'viagem'
      when niche = 'MEDICINE' or title ~ 'health' then 'saude'
      when niche = 'BUSINESS' or title ~ 'business|office|workplace|meetings|negotiation' then 'trabalho'
      when niche = 'CONVERSATION' or title ~ 'speak now|conversation' then 'conversacao'
      when title ~ 'society|debate|argument|opinions|media|influence|discourse|nuance' then 'sociedade'
      else 'dia_a_dia'
    end,
    case
      when niche = 'KIDS' or title ~ 'kids|little explorers' then 'kids'
      when niche in ('BUSINESS', 'TECH', 'MEDICINE') or title ~ 'business|office|workplace|toefl|ielts|test skills' then 'adults'
      else 'all'
    end,
    case
      when title ~ 'experimental|trial lesson|sampler|wh questions' then 45
      when title ~ 'part|units?\M|módulo|modulo|volume' then 90
      when description ~ 'livro neutro' then 60
      else 60
    end
  from input;
$function$;
alter function private.hub_catalog_default_tags(text, text, text) owner to postgres;
revoke all on function private.hub_catalog_default_tags(text, text, text) from public, anon, authenticated;

create or replace function private.hub_content_items_fill_tags()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  v_tags record;
begin
  if new.skills is not null and new.theme is not null and new.age_group is not null and new.duration_minutes is not null then
    return new;
  end if;
  select * into v_tags from private.hub_catalog_default_tags(new.niche, new.title, new.description);
  new.skills := coalesce(new.skills, v_tags.skills);
  new.theme := coalesce(new.theme, v_tags.theme);
  new.age_group := coalesce(new.age_group, v_tags.age_group);
  new.duration_minutes := coalesce(new.duration_minutes, v_tags.duration_minutes);
  return new;
end;
$function$;
alter function private.hub_content_items_fill_tags() owner to postgres;
revoke all on function private.hub_content_items_fill_tags() from public, anon, authenticated;

drop trigger if exists hub_content_items_fill_tags on public.hub_content_items;
create trigger hub_content_items_fill_tags
  before insert or update on public.hub_content_items
  for each row execute function private.hub_content_items_fill_tags();

-- Itens ativos que já existem: só o que está nulo (o gatilho calcula). Os
-- inativos ganham as tags pelo mesmo gatilho quando voltarem ao catálogo.
update public.hub_content_items
   set skills = skills
 where is_active
   and (skills is null or theme is null or age_group is null or duration_minutes is null);

-- Leitura do catálogo é por coluna (20260822185207): as novas entram na lista.
grant select (skills, theme, age_group, duration_minutes) on public.hub_content_items to anon, authenticated;
