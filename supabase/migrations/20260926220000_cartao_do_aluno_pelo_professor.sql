-- Cartão do aluno: o que o professor sabe e a IA não inventa (26/09/2026).
--
-- "O que engaja este aluno" e "como ele prefere ser corrigido" viviam em três
-- lugares, nenhum revisado por gente: wolf_intelligence (inferido pelo Wolfie a
-- partir das conversas), colunas antigas de profiles (preenchidas na matrícula
-- e nunca mais) e a cabeça do professor. O cartão é o único escrito à mão por
-- quem dá a aula — e no Planner ele VENCE os outros dois.
--
-- Regras da direção:
--   * nunca guardar saúde, religião, política, família ou dinheiro. A tela diz
--     isso junto do formulário; o servidor recusa texto longo demais (limite de
--     tamanho por campo), que é onde esse tipo de relato costuma aparecer;
--   * aluno menor de idade (is_kids ou nascido há menos de 18 anos, a mesma
--     régua do termo de registro das aulas): só os campos pedagógicos —
--     objetivo e temas. Nada de "o que evitar", estilo de correção ou notas;
--   * escrita só por esta RPC: professor vinculado ao aluno (a mesma regra do
--     dossiê de continuidade, private.can_read_student_pedagogy), coordenação e
--     direção da escola. O suporte da plataforma (SUPER_ADMIN) não escreve.
--
-- O histórico guarda QUEM mudou, QUANDO e QUAIS campos — nunca o texto. Um
-- relato que não devia ter sido escrito e foi apagado não pode sobreviver no
-- histórico. Pelo mesmo motivo, a confirmação de leitura do dossiê
-- (student_handover_reads) passa a guardar só a VERSÃO do cartão lido.
--
-- ⚠️ Não é coluna de profiles de propósito: escrita em profiles passa por
-- enforce_profile_authorization_fields, auditoria e lib/profileColumns.ts, e o
-- cartão tem dono (o professor), histórico e regra de menor próprios.

-- ---------------------------------------------------------------------------
-- 1. Tabela do cartão (uma linha por aluno por escola)
-- ---------------------------------------------------------------------------
create table if not exists public.student_learning_cards (
  tenant_id text not null references public.tenants(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  real_goal text not null default '',
  engaging_topics text[] not null default '{}'::text[],
  correction_style text,
  avoid_topics text[] not null default '{}'::text[],
  notes text not null default '',
  version integer not null default 1,
  -- Sem FK de propósito: apagar o perfil de quem editou não pode disparar
  -- UPDATE em cascata no cartão (e o gatilho de menor junto).
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint student_learning_cards_pkey primary key (tenant_id, student_id),
  constraint student_learning_cards_goal_check check (char_length(real_goal) <= 300),
  constraint student_learning_cards_topics_check check (cardinality(engaging_topics) <= 8),
  constraint student_learning_cards_avoid_check check (cardinality(avoid_topics) <= 6),
  constraint student_learning_cards_notes_check check (char_length(notes) <= 400),
  constraint student_learning_cards_correction_check check (
    correction_style is null
    or correction_style in ('immediate', 'end', 'selective', 'examiner')
  ),
  constraint student_learning_cards_version_check check (version >= 1)
);

create index if not exists student_learning_cards_student_idx
  on public.student_learning_cards (student_id);

comment on table public.student_learning_cards is
  'Cartão do aluno preenchido pelo professor, sem IA. Escrita só por save_student_learning_card; no Planner vence wolf_intelligence e profiles. Nunca saúde, religião, política, família ou dinheiro.';

alter table public.student_learning_cards owner to postgres;
alter table public.student_learning_cards enable row level security;
revoke all on table public.student_learning_cards from public, anon, authenticated, service_role;
-- O Planner (edge lesson-planner) lê com a chave de serviço; ninguém escreve
-- por fora da RPC.
grant select on table public.student_learning_cards to service_role;

-- ---------------------------------------------------------------------------
-- 2. Histórico: quem, quando e quais campos — nunca o conteúdo
-- ---------------------------------------------------------------------------
create table if not exists private.student_learning_card_events (
  id bigint generated always as identity primary key,
  tenant_id text not null,
  student_id uuid not null references public.profiles(id) on delete cascade,
  actor_id uuid,
  actor_role text,
  card_version integer not null,
  changed_fields text[] not null default '{}'::text[],
  created_at timestamptz not null default now()
);

create index if not exists student_learning_card_events_student_idx
  on private.student_learning_card_events (tenant_id, student_id, created_at desc);

alter table private.student_learning_card_events owner to postgres;
alter table private.student_learning_card_events enable row level security;
revoke all on table private.student_learning_card_events from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Regras puras
-- ---------------------------------------------------------------------------

-- Limites num lugar só: o gatilho valida por eles e a tela os recebe no JSON.
create or replace function private.student_learning_card_limits()
returns jsonb
language sql immutable security definer set search_path = '' as $$
  select jsonb_build_object(
    'real_goal', 300,
    'topic', 60,
    'engaging_topics', 8,
    'avoid_topics', 6,
    'notes', 400
  );
$$;

-- Menor de idade: is_kids ou nascido há menos de 18 anos (fuso da escola).
create or replace function private.student_learning_card_minor(p_student uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select coalesce(student.is_kids, false)
      or (student.birth_date is not null
        and student.birth_date > (now() at time zone 'America/Sao_Paulo')::date - interval '18 years')
    from public.profiles as student
    where student.id = p_student
  ), false);
$$;

-- Espaço repetido, quebra de linha e caractere de controle viram um espaço só.
create or replace function private.student_learning_card_clean_text(p_value text)
returns text
language sql immutable security definer set search_path = '' as $$
  select btrim(regexp_replace(coalesce(p_value, ''), '[[:space:][:cntrl:]]+', ' ', 'g'));
$$;

-- Lista limpa: sem item vazio e sem repetido (ignorando maiúscula), na ordem
-- em que o professor escreveu.
create or replace function private.student_learning_card_clean_list(p_values text[])
returns text[]
language sql immutable security definer set search_path = '' as $$
  select coalesce(array_agg(deduped.value order by deduped.position), '{}'::text[])
  from (
    select distinct on (lower(cleaned.value)) cleaned.value, cleaned.position
    from (
      select private.student_learning_card_clean_text(raw.value) as value, raw.position
      from unnest(coalesce(p_values, '{}'::text[])) with ordinality as raw(value, position)
    ) as cleaned
    where cleaned.value <> ''
    order by lower(cleaned.value), cleaned.position
  ) as deduped;
$$;

-- Quem edita: quem lê o dossiê (mesma regra) E é professor, coordenação ou
-- direção da escola. SUPER_ADMIN lê pelo dossiê quando está na escola, mas não
-- escreve o cartão de um aluno que não conhece.
create or replace function private.student_learning_card_can_edit(p_tenant text, p_student uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null
    and coalesce(public._my_role(), '') in ('TEACHER', 'SCHOOL_ADMIN', 'COORDINATOR')
    and private.can_read_student_pedagogy(p_tenant, p_student);
$$;

-- O cartão como a tela e o dossiê o enxergam. Para menor, os campos pessoais
-- saem sempre vazios — mesmo que tenham sido escritos antes de a data de
-- nascimento chegar (hidden_for_minor avisa, e o próximo salvamento apaga).
create or replace function private.student_learning_card_view(p_tenant text, p_student uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_card public.student_learning_cards%rowtype;
  v_minor boolean := private.student_learning_card_minor(p_student);
  v_hidden boolean := false;
begin
  select * into v_card
    from public.student_learning_cards as card
   where card.tenant_id = p_tenant and card.student_id = p_student;

  if v_card.student_id is not null and v_minor then
    v_hidden := v_card.correction_style is not null
      or cardinality(v_card.avoid_topics) > 0
      or v_card.notes <> '';
  end if;

  return jsonb_build_object(
    'exists', v_card.student_id is not null,
    'is_minor', v_minor,
    'can_edit', private.student_learning_card_can_edit(p_tenant, p_student),
    'real_goal', coalesce(v_card.real_goal, ''),
    'engaging_topics', to_jsonb(coalesce(v_card.engaging_topics, '{}'::text[])),
    'correction_style', case when v_minor then null else v_card.correction_style end,
    'avoid_topics', case when v_minor then '[]'::jsonb
      else to_jsonb(coalesce(v_card.avoid_topics, '{}'::text[])) end,
    'notes', case when v_minor then '' else coalesce(v_card.notes, '') end,
    'hidden_for_minor', v_hidden,
    'version', coalesce(v_card.version, 0),
    'updated_at', v_card.updated_at,
    'updated_by_name', (
      select editor.full_name from public.profiles as editor where editor.id = v_card.updated_by
    ),
    'limits', private.student_learning_card_limits(),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'created_at', recent.created_at,
        'actor_name', recent.actor_name,
        'actor_role', recent.actor_role,
        'changed_fields', to_jsonb(recent.changed_fields),
        'version', recent.card_version
      ) order by recent.created_at desc, recent.id desc)
      from (
        select event.id, event.created_at, event.actor_role, event.changed_fields,
               event.card_version, actor.full_name as actor_name
          from private.student_learning_card_events as event
          left join public.profiles as actor on actor.id = event.actor_id
         where event.tenant_id = p_tenant and event.student_id = p_student
         order by event.created_at desc, event.id desc
         limit 10
      ) as recent
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Gatilhos: validação (vale para qualquer escritor) e histórico
-- ---------------------------------------------------------------------------
create or replace function private.student_learning_card_guard()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_limits jsonb := private.student_learning_card_limits();
  v_item text;
begin
  -- Só o conteúdo é validado. Atualização que não mexe no texto (ex.: ajuste
  -- técnico) não pode ser barrada pela regra de menor.
  if tg_op = 'UPDATE'
     and new.real_goal is not distinct from old.real_goal
     and new.engaging_topics is not distinct from old.engaging_topics
     and new.correction_style is not distinct from old.correction_style
     and new.avoid_topics is not distinct from old.avoid_topics
     and new.notes is not distinct from old.notes then
    return new;
  end if;

  if not exists (
    select 1 from public.profiles as student
     where student.id = new.student_id
       and student.tenant_id = new.tenant_id
       and student.role = 'STUDENT'
  ) then
    raise exception 'cartao_aluno_invalido';
  end if;

  if char_length(new.real_goal) > (v_limits->>'real_goal')::integer then
    raise exception 'cartao_texto_longo:real_goal' using errcode = '22001';
  end if;
  if char_length(new.notes) > (v_limits->>'notes')::integer then
    raise exception 'cartao_texto_longo:notes' using errcode = '22001';
  end if;
  if cardinality(new.engaging_topics) > (v_limits->>'engaging_topics')::integer then
    raise exception 'cartao_itens_demais:engaging_topics' using errcode = '22023';
  end if;
  if cardinality(new.avoid_topics) > (v_limits->>'avoid_topics')::integer then
    raise exception 'cartao_itens_demais:avoid_topics' using errcode = '22023';
  end if;
  if array_position(new.engaging_topics, null) is not null
     or array_position(new.avoid_topics, null) is not null then
    raise exception 'cartao_item_vazio' using errcode = '22023';
  end if;
  foreach v_item in array new.engaging_topics loop
    if char_length(v_item) > (v_limits->>'topic')::integer then
      raise exception 'cartao_texto_longo:engaging_topics' using errcode = '22001';
    end if;
  end loop;
  foreach v_item in array new.avoid_topics loop
    if char_length(v_item) > (v_limits->>'topic')::integer then
      raise exception 'cartao_texto_longo:avoid_topics' using errcode = '22001';
    end if;
  end loop;
  if new.correction_style is not null
     and new.correction_style not in ('immediate', 'end', 'selective', 'examiner') then
    raise exception 'cartao_estilo_invalido' using errcode = '22023';
  end if;

  if private.student_learning_card_minor(new.student_id) then
    if new.correction_style is not null then
      raise exception 'cartao_campo_de_menor:correction_style' using errcode = '22023';
    end if;
    if cardinality(new.avoid_topics) > 0 then
      raise exception 'cartao_campo_de_menor:avoid_topics' using errcode = '22023';
    end if;
    if new.notes <> '' then
      raise exception 'cartao_campo_de_menor:notes' using errcode = '22023';
    end if;
  end if;

  return new;
end;
$$;

create or replace function private.student_learning_card_log()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_fields text[];
begin
  if tg_op = 'INSERT' then
    v_fields := array_remove(array[
      case when new.real_goal <> '' then 'real_goal' end,
      case when cardinality(new.engaging_topics) > 0 then 'engaging_topics' end,
      case when new.correction_style is not null then 'correction_style' end,
      case when cardinality(new.avoid_topics) > 0 then 'avoid_topics' end,
      case when new.notes <> '' then 'notes' end
    ], null);
  else
    v_fields := array_remove(array[
      case when new.real_goal is distinct from old.real_goal then 'real_goal' end,
      case when new.engaging_topics is distinct from old.engaging_topics then 'engaging_topics' end,
      case when new.correction_style is distinct from old.correction_style then 'correction_style' end,
      case when new.avoid_topics is distinct from old.avoid_topics then 'avoid_topics' end,
      case when new.notes is distinct from old.notes then 'notes' end
    ], null);
    if cardinality(v_fields) = 0 then
      return null;
    end if;
  end if;

  insert into private.student_learning_card_events (
    tenant_id, student_id, actor_id, actor_role, card_version, changed_fields
  ) values (
    new.tenant_id, new.student_id, coalesce(new.updated_by, auth.uid()),
    public._my_role(), new.version, v_fields
  );
  return null;
end;
$$;

drop trigger if exists trg_student_learning_cards_guard on public.student_learning_cards;
create trigger trg_student_learning_cards_guard
  before insert or update on public.student_learning_cards
  for each row execute function private.student_learning_card_guard();

drop trigger if exists trg_student_learning_cards_log on public.student_learning_cards;
create trigger trg_student_learning_cards_log
  after insert or update on public.student_learning_cards
  for each row execute function private.student_learning_card_log();

-- ---------------------------------------------------------------------------
-- 5. RPC de escrita
-- ---------------------------------------------------------------------------
-- p_expected_version: a versão que a tela carregou (0 = ainda não havia
-- cartão). Diferente da atual → recusa, em vez de apagar o que a coordenação
-- escreveu cinco minutos antes. Nulo dispensa a conferência.
create or replace function public.save_student_learning_card(
  p_student_id uuid,
  p_real_goal text,
  p_engaging_topics text[],
  p_correction_style text,
  p_avoid_topics text[],
  p_notes text,
  p_expected_version integer default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant text := public._my_tenant_id();
  v_goal text := private.student_learning_card_clean_text(p_real_goal);
  v_topics text[] := private.student_learning_card_clean_list(p_engaging_topics);
  v_style text := nullif(lower(private.student_learning_card_clean_text(p_correction_style)), '');
  v_avoid text[] := private.student_learning_card_clean_list(p_avoid_topics);
  v_notes text := private.student_learning_card_clean_text(p_notes);
  v_card public.student_learning_cards%rowtype;
begin
  if auth.uid() is null or v_tenant is null or p_student_id is null
     or not private.student_learning_card_can_edit(v_tenant, p_student_id) then
    raise exception 'sem_permissao' using errcode = '42501';
  end if;

  -- Dois salvamentos do mesmo aluno ao mesmo tempo esperam um pelo outro; sem
  -- isso, o primeiro INSERT de dois professores viraria erro de chave.
  perform pg_advisory_xact_lock(
    hashtextextended('student_learning_card:' || v_tenant || ':' || p_student_id::text, 0)
  );

  select * into v_card
    from public.student_learning_cards as card
   where card.tenant_id = v_tenant and card.student_id = p_student_id
   for update;

  if p_expected_version is not null
     and coalesce(v_card.version, 0) <> p_expected_version then
    raise exception 'cartao_alterado_por_outra_pessoa';
  end if;

  if v_card.student_id is null then
    -- Cartão vazio que nunca existiu não vira linha nem histórico.
    if v_goal = '' and cardinality(v_topics) = 0 and v_style is null
       and cardinality(v_avoid) = 0 and v_notes = '' then
      return private.student_learning_card_view(v_tenant, p_student_id);
    end if;
    insert into public.student_learning_cards (
      tenant_id, student_id, real_goal, engaging_topics, correction_style,
      avoid_topics, notes, version, updated_by, updated_at
    ) values (
      v_tenant, p_student_id, v_goal, v_topics, v_style,
      v_avoid, v_notes, 1, auth.uid(), now()
    );
  else
    update public.student_learning_cards as card
       set real_goal = v_goal,
           engaging_topics = v_topics,
           correction_style = v_style,
           avoid_topics = v_avoid,
           notes = v_notes,
           version = card.version + 1,
           updated_by = auth.uid(),
           updated_at = now()
     where card.tenant_id = v_tenant
       and card.student_id = p_student_id
       and (card.real_goal, card.engaging_topics, card.correction_style, card.avoid_topics, card.notes)
           is distinct from (v_goal, v_topics, v_style, v_avoid, v_notes);
  end if;

  return private.student_learning_card_view(v_tenant, p_student_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Dossiê de continuidade devolve o cartão (definição viva de 26/09/2026 +
--    'learning_card'). A confirmação de leitura guarda só a versão do cartão.
-- ---------------------------------------------------------------------------
create or replace function public.get_student_handover(p_student_id uuid, p_acknowledge boolean default false)
returns jsonb
language plpgsql security definer set search_path = '' as $function$
declare t text:=public._my_tenant_id(); result jsonb; begin
  if not private.can_read_student_pedagogy(t,p_student_id) then raise exception 'sem_permissao'; end if;
  select jsonb_build_object('ok',true,'student_name',p.full_name,
    'memories',(select coalesce(jsonb_agg(to_jsonb(m) order by m.occurred_at desc),'[]'::jsonb) from
      (select id,source_type,occurred_at,lesson_objective,content_practiced,recurring_errors,homework_assigned,recommended_next_step,verification_status
       from public.student_learning_memories where tenant_id=t and student_id=p_student_id and verification_status='VERIFIED' order by occurred_at desc limit 30) m),
    'logs',(select coalesce(jsonb_agg(to_jsonb(l) order by l.class_date desc,l.start_time desc),'[]'::jsonb) from
      (select id,class_date,start_time,lesson_objective,content_covered,student_difficulties,homework_assigned,recommended_next_step,lesson_session_id
       from public.class_logs where tenant_id=t and student_id=p_student_id order by class_date desc,start_time desc limit 30) l),
    'learning_card',private.student_learning_card_view(t,p_student_id))
    into result from public.profiles p where p.id=p_student_id and p.tenant_id=t;
  if p_acknowledge then insert into private.student_handover_reads(tenant_id,student_id,actor_id,snapshot)
    values(t,p_student_id,auth.uid(),
      (result-'learning_card')||jsonb_build_object('learning_card_version',result->'learning_card'->'version')); end if;
  return result;
end $function$;

-- ---------------------------------------------------------------------------
-- 7. Donos e permissões
-- ---------------------------------------------------------------------------
do $owners$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'private.student_learning_card_limits()',
    'private.student_learning_card_minor(uuid)',
    'private.student_learning_card_clean_text(text)',
    'private.student_learning_card_clean_list(text[])',
    'private.student_learning_card_can_edit(text,uuid)',
    'private.student_learning_card_view(text,uuid)',
    'private.student_learning_card_guard()',
    'private.student_learning_card_log()',
    'public.save_student_learning_card(uuid,text,text[],text,text[],text,integer)',
    'public.get_student_handover(uuid,boolean)'
  ] loop
    execute format('alter function %s owner to postgres', v_signature);
    execute format('revoke all on function %s from public, anon, authenticated', v_signature);
  end loop;
end
$owners$;

-- As internas não são rota de navegador nem de serviço.
revoke all on function private.student_learning_card_limits() from service_role;
revoke all on function private.student_learning_card_minor(uuid) from service_role;
revoke all on function private.student_learning_card_clean_text(text) from service_role;
revoke all on function private.student_learning_card_clean_list(text[]) from service_role;
revoke all on function private.student_learning_card_can_edit(text,uuid) from service_role;
revoke all on function private.student_learning_card_view(text,uuid) from service_role;
revoke all on function private.student_learning_card_guard() from service_role;
revoke all on function private.student_learning_card_log() from service_role;

-- A checagem de papel, escola e vínculo é interna.
grant execute on function public.save_student_learning_card(uuid,text,text[],text,text[],text,integer) to authenticated;
grant execute on function public.get_student_handover(uuid,boolean) to authenticated, service_role;
