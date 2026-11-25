-- Conteúdo pedagógico pelo agente (OpenBot) — 22/11/2026.
--
-- Aditiva e re-executável:
--   1. school_book_generations ganha brand (school|neutral), destination
--      (SCHOOL|HUB), footer_text e created_via (APP|CONTENT_BOT).
--   2. Credencial técnica do agente de conteúdo: só o sha256 do token fica no
--      banco; o token só autoriza o gamma-book-generator (sem login humano, sem
--      service key com o agente). A conta técnica é TEACHER sem alunos.
--   3. Views agregadas no schema openbot (lidas pelo openbot_ro), sem nome nem
--      contato de aluno: materiais, gerações Gamma, créditos por mês e temas
--      dos resumos aprovados (só grupos com 3+ alunos; profissão com 2+).

-- ── 1. Marca e destino da geração ──────────────────────────────────────────
alter table public.school_book_generations
  add column if not exists brand text not null default 'school',
  add column if not exists destination text not null default 'SCHOOL',
  add column if not exists footer_text text,
  add column if not exists created_via text not null default 'APP';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'school_book_generations_brand_check') then
    alter table public.school_book_generations
      add constraint school_book_generations_brand_check check (brand in ('school', 'neutral'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'school_book_generations_destination_check') then
    alter table public.school_book_generations
      add constraint school_book_generations_destination_check
      check (destination in ('SCHOOL', 'HUB') and (destination = 'SCHOOL' or brand = 'neutral'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'school_book_generations_footer_check') then
    alter table public.school_book_generations
      add constraint school_book_generations_footer_check
      check (footer_text is null or (brand = 'neutral' and char_length(footer_text) between 1 and 60));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'school_book_generations_created_via_check') then
    alter table public.school_book_generations
      add constraint school_book_generations_created_via_check
      check (created_via in ('APP', 'CONTENT_BOT') and (created_via = 'APP' or creator_role = 'TEACHER'));
  end if;
end $$;

-- ── 2. Credencial técnica do agente ────────────────────────────────────────
create table if not exists private.content_bot_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  tenant_id text not null references public.tenants(id) on delete cascade,
  label text not null check (char_length(label) between 3 and 80),
  token_sha256 text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_used_at timestamptz
);
alter table private.content_bot_credentials enable row level security;
alter table private.content_bot_credentials force row level security;
revoke all on private.content_bot_credentials from public, anon, authenticated;

-- Resolve o token (sha256) para a conta técnica. Só vale para conta TEACHER do
-- mesmo tenant, sem nenhum aluno vinculado. Usada pela Edge Function via
-- service_role; nunca exposta a anon/authenticated.
create or replace function public.content_bot_authenticate(p_token_sha256 text)
returns table (user_id uuid, tenant_id text)
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_cred private.content_bot_credentials%rowtype;
begin
  if p_token_sha256 is null or p_token_sha256 !~ '^[0-9a-f]{64}$' then
    return;
  end if;
  select c.* into v_cred
    from private.content_bot_credentials c
   where c.token_sha256 = p_token_sha256 and c.revoked_at is null;
  if not found then return; end if;
  if not exists (
    select 1 from public.profiles p
     where p.id = v_cred.user_id and p.tenant_id = v_cred.tenant_id and p.role = 'TEACHER'
       and coalesce(p.is_test_account, false)
  ) then
    return;
  end if;
  if exists (
    select 1 from public.profiles s
     where s.role = 'STUDENT' and (s.professor_id = v_cred.user_id or s.professor_id2 = v_cred.user_id)
  ) then
    return;
  end if;
  update private.content_bot_credentials c set last_used_at = now() where c.id = v_cred.id;
  user_id := v_cred.user_id;
  tenant_id := v_cred.tenant_id;
  return next;
end;
$$;

-- O PDF do agente é enviado pela function (service_role, sem dono). Este passo
-- registra a conta técnica como dona, para a procedência do material valer
-- (hub_material_object_has_provenance) como em qualquer upload de professor.
create or replace function public.content_bot_claim_material_object(p_user uuid, p_object text)
returns boolean
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_tenant text;
  v_rows int;
begin
  select c.tenant_id into v_tenant
    from private.content_bot_credentials c
   where c.user_id = p_user and c.revoked_at is null
   limit 1;
  if v_tenant is null or p_object is null
     or p_object !~ ('^' || v_tenant || '/' || p_user::text || '/[0-9a-f-]{36}[.]pdf$') then
    return false;
  end if;
  update storage.objects o
     set owner = p_user, owner_id = p_user::text
   where o.bucket_id = 'materials' and o.name = p_object
     and o.owner is null and o.owner_id is null;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

revoke all on function public.content_bot_authenticate(text) from public, anon, authenticated;
revoke all on function public.content_bot_claim_material_object(uuid, text) from public, anon, authenticated;
grant execute on function public.content_bot_authenticate(text) to service_role;
grant execute on function public.content_bot_claim_material_object(uuid, text) to service_role;

-- ── 3. Views do agente (schema openbot) ────────────────────────────────────
create schema if not exists openbot;

create or replace view openbot.conteudo_materiais as
  select 'ESCOLA'::text as origem,
         m.level_tag as nivel,
         coalesce(m.niche, 'GENERAL') as nicho,
         coalesce(m.category, '') as categoria,
         coalesce(m.type, '') as tipo,
         coalesce(m.scope, '') as scope,
         coalesce(m.approval_status, '') as aprovacao,
         coalesce(m.hub_catalog_opt_in, false) as no_catalogo_hub,
         coalesce(g.created_via = 'CONTENT_BOT', false) as gerado_pelo_agente,
         coalesce(g.brand, '') as marca,
         count(*)::int as materiais,
         max(m.created_at) as ultimo_em
    from public.pedagogical_materials m
    left join public.school_book_generations g on g.material_id = m.id
   where m.tenant_id = 'school-wise-wolf'
   group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
  union all
  select 'HUB_CATALOGO', i.level_tag, coalesce(i.niche, 'GENERAL'), coalesce(i.collection_name, ''),
         coalesce(i.content_type, ''), coalesce(i.catalog_scope, ''),
         case when i.is_active and i.published_at is not null then 'PUBLICADO' else 'INATIVO' end,
         true, false, '', count(*)::int, max(i.created_at)
    from public.hub_content_items i
   group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
  union all
  select 'HUB_PROFESSOR', e.level_tag, e.niche, e.audience, e.kind, 'PRIVATE', 'GERADO', false, false, '',
         count(*)::int, max(e.created_at)
    from public.hub_educator_materials e
   group by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10;

create or replace view openbot.conteudo_geracoes_gamma as
  select g.id,
         g.status,
         g.brand as marca,
         g.destination as destino,
         g.created_via as origem,
         g.creator_role as papel_criador,
         g.level_tag as nivel,
         g.niche as nicho,
         g.audience as publico,
         g.book_language as idioma,
         g.page_count as paginas,
         nullif(g.provider_credits ->> 'deducted', '')::numeric as creditos_gastos,
         nullif(g.provider_credits ->> 'remaining', '')::numeric as creditos_restantes,
         g.error_code as erro,
         m.approval_status as aprovacao_material,
         m.scope as scope_material,
         g.created_at as criado_em,
         g.completed_at as concluido_em
    from public.school_book_generations g
    left join public.pedagogical_materials m on m.id = g.material_id
   where g.tenant_id = 'school-wise-wolf';

-- Saldo: a API do Gamma devolve credits.remaining em cada geração concluída
-- (e GET /me, consultado pela action "credits" do gerador).
create or replace view openbot.conteudo_creditos_gamma_mes as
  select to_char(g.created_at at time zone 'America/Sao_Paulo', 'YYYY-MM') as mes,
         count(*)::int as geracoes,
         count(*) filter (where g.status = 'COMPLETED')::int as concluidas,
         count(*) filter (where g.status = 'FAILED')::int as falhas,
         coalesce(sum(nullif(g.provider_credits ->> 'deducted', '')::numeric), 0) as creditos_gastos,
         (array_agg(nullif(g.provider_credits ->> 'remaining', '')::numeric order by g.completed_at desc nulls last)
            filter (where g.provider_credits ? 'remaining'))[1] as ultimo_saldo_informado
    from public.school_book_generations g
   where g.tenant_id = 'school-wise-wolf'
   group by 1;

-- Resumos aprovados (última versão VERIFIED de cada aula) por tema. Texto livre
-- do professor: só aparecem itens vistos com 3+ alunos diferentes, para nenhum
-- detalhe individual vazar.
create or replace view openbot.conteudo_resumos_temas as
  with ult as (
    select distinct on (v.lesson_session_id) v.lesson_session_id, v.status, v.content
      from private.lesson_summary_versions v
     where v.tenant_id = 'school-wise-wolf'
     order by v.lesson_session_id, v.version desc
  ), aprovados as (
    select s.student_id, u.content, s.class_date
      from ult u
      join public.lesson_sessions s on s.id = u.lesson_session_id
     where u.status = 'VERIFIED' and s.tenant_id = 'school-wise-wolf'
  ), itens as (
    select 'conteudo_praticado'::text as tipo, a.student_id, a.class_date,
           lower(btrim(left(split_part(x.item, ':', 1), 80))) as tema
      from aprovados a cross join lateral jsonb_array_elements_text(coalesce(a.content -> 'content_practiced', '[]'::jsonb)) x(item)
    union all
    select 'erro_recorrente', a.student_id, a.class_date, lower(btrim(left(split_part(x.item, ':', 1), 80)))
      from aprovados a cross join lateral jsonb_array_elements_text(coalesce(a.content -> 'recurring_errors', '[]'::jsonb)) x(item)
    union all
    select 'objetivo', a.student_id, a.class_date, lower(btrim(left(a.content ->> 'lesson_objective', 120)))
      from aprovados a
  )
  select tipo, tema,
         count(*)::int as ocorrencias,
         count(distinct student_id)::int as alunos,
         min(class_date) as primeira_aula,
         max(class_date) as ultima_aula
    from itens
   where char_length(tema) >= 3
   group by tipo, tema
  having count(distinct student_id) >= 3;

-- Perfil dos alunos com resumo aprovado, sem nome: profissão e finalidade do
-- inglês (english_for). Valor com menos de 2 alunos vira "outras".
create or replace view openbot.conteudo_alunos_perfil as
  with ult as (
    select distinct on (v.lesson_session_id) v.lesson_session_id, v.status
      from private.lesson_summary_versions v
     where v.tenant_id = 'school-wise-wolf'
     order by v.lesson_session_id, v.version desc
  ), base as (
    select p.id,
           coalesce(nullif(lower(btrim(p.occupation)), ''), 'não informada') as profissao,
           coalesce(nullif(btrim(p.english_for), ''), 'não informada') as finalidade,
           count(distinct s.id) as aulas
      from ult u
      join public.lesson_sessions s on s.id = u.lesson_session_id
      join public.profiles p on p.id = s.student_id
     where u.status = 'VERIFIED' and s.tenant_id = 'school-wise-wolf'
     group by 1, 2, 3
  ), dim as (
    select 'profissao'::text as dimensao, profissao as valor, aulas from base
    union all
    select 'finalidade', finalidade, aulas from base
  ), cont as (
    select dimensao, valor, count(*) as n from dim group by 1, 2
  )
  select d.dimensao,
         case when c.n >= 2 then d.valor else 'outras' end as valor,
         count(*)::int as alunos,
         sum(d.aulas)::int as aulas_com_resumo_aprovado
    from dim d join cont c using (dimensao, valor)
   group by 1, 2;

revoke all on openbot.conteudo_materiais, openbot.conteudo_geracoes_gamma, openbot.conteudo_creditos_gamma_mes,
  openbot.conteudo_resumos_temas, openbot.conteudo_alunos_perfil from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'openbot_ro') then
    grant usage on schema openbot to openbot_ro;
    grant select on openbot.conteudo_materiais, openbot.conteudo_geracoes_gamma, openbot.conteudo_creditos_gamma_mes,
      openbot.conteudo_resumos_temas, openbot.conteudo_alunos_perfil to openbot_ro;
  end if;
end $$;
