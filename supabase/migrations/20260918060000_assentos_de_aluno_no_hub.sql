-- =============================================================================
-- Assentos de aluno no Hub (18/09/2026, pedido da direção).
--
-- O aluno do professor autônomo entra no ambiente do professor — sem tenant —
-- como membro MEMBER/LEARNER da conta do Hub. Ele recebe os materiais e a
-- jornada que o professor lhe atribui (sempre na versão do aluno, sem gabarito),
-- marca o que fez, e usa o Wolfie pela cota do professor. É a peça de retenção
-- que o Hub não tinha: material que chega ao aluno dentro da plataforma.
--
-- Como funciona:
--   1. `team.seats` do plano = quantos alunos o professor pode ter dentro
--      (Descoberta 1 · Essencial 2 · Pro 8 · Studio 25 · Institucional 100).
--   2. `hub_invite_learner` gera um link único por perfil de aluno
--      (`hub_educator_learners.invite_token`, 14 dias) — o professor manda pelo
--      WhatsApp. `hub_accept_learner_invite` cria a membership e o perfil de
--      membro; o mesmo e-mail nunca vira dois assentos.
--   3. `hub_assign_material` liga um material gerado a um aluno;
--      `hub_learner_desk` devolve ao aluno o que é dele com
--      `private.hub_strip_answer_keys` — o gabarito nunca sai do servidor.
--
-- ⚠️ Roda a cada release: tudo re-executável, sem begin/commit.
-- ⚠️ Cota de plano muda por migration (o seed da fundação roda a cada release).
-- =============================================================================

-- 1) Assentos por plano ----------------------------------------------------------
update public.hub_plan_entitlements as entitlement
   set limit_value = seats.limit_value,
       reset_period = 'SUBSCRIPTION'
  from public.hub_plans as plan
  join (values
    ('DISCOVERY', 1),
    ('LIBRARY_SOLO', 2),
    ('EDUCATOR_PRO', 8),
    ('HUB_COMPLETE', 25),
    ('INSTITUTIONAL', 100)
  ) as seats(code, limit_value) on seats.code = plan.code
 where plan.id = entitlement.plan_id
   and entitlement.feature_key = 'team.seats'
   and (entitlement.limit_value is distinct from seats.limit_value or entitlement.reset_period <> 'SUBSCRIPTION');

-- 2) O perfil de aluno passa a poder ter um usuário (assento) e um convite ----------
alter table public.hub_educator_learners
  add column if not exists member_user_id uuid references auth.users(id) on delete set null;
alter table public.hub_educator_learners
  add column if not exists invite_token text;
alter table public.hub_educator_learners
  add column if not exists invite_expires_at timestamptz;
alter table public.hub_educator_learners
  add column if not exists joined_at timestamptz;

alter table public.hub_educator_learners
  drop constraint if exists hub_educator_learners_invite_token_check;
alter table public.hub_educator_learners
  add constraint hub_educator_learners_invite_token_check
  check (invite_token is null or invite_token ~ '^[0-9a-f]{64}$');

create unique index if not exists hub_educator_learners_member_unique
  on public.hub_educator_learners(account_id, member_user_id)
  where member_user_id is not null;
create unique index if not exists hub_educator_learners_invite_token_unique
  on public.hub_educator_learners(invite_token)
  where invite_token is not null;

-- 3) Atribuições: material gerado → aluno --------------------------------------------
create table if not exists public.hub_learner_assignments (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  account_id uuid not null references public.hub_accounts(id) on delete cascade,
  learner_id uuid not null,
  material_id uuid not null references public.hub_educator_materials(id) on delete cascade,
  assigned_by uuid not null references auth.users(id) on delete restrict,
  note text not null default '' check (pg_catalog.char_length(note) <= 600),
  status text not null default 'ASSIGNED' check (status in ('ASSIGNED', 'DONE')),
  student_note text not null default '' check (pg_catalog.char_length(student_note) <= 1200),
  done_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  constraint hub_learner_assignments_learner_fkey
    foreign key (account_id, learner_id)
    references public.hub_educator_learners(account_id, id)
    on delete cascade,
  unique (learner_id, material_id)
);

create index if not exists hub_learner_assignments_learner_idx
  on public.hub_learner_assignments(account_id, learner_id, created_at desc);

alter table public.hub_learner_assignments enable row level security;
alter table public.hub_learner_assignments force row level security;
revoke all on table public.hub_learner_assignments from public, anon, authenticated;
grant select on table public.hub_learner_assignments to authenticated;
grant all on table public.hub_learner_assignments to service_role;

-- O professor lê as atribuições dos alunos que ele enxerga; o aluno recebe as
-- dele pela RPC `hub_learner_desk` (que tira o gabarito), não por select direto.

-- 4) Helpers -------------------------------------------------------------------------
-- Quem pode gerir um perfil de aluno: professor com acesso ao Educador IA na conta
-- e que é manager ou criou o perfil.
create or replace function private.hub_can_manage_learner(p_account_id uuid, p_learner_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select private.hub_has_educator_planner_access(p_account_id)
    and exists (
      select 1
      from public.hub_educator_learners as learner
      where learner.id = p_learner_id
        and learner.account_id = p_account_id
        and (
          private.hub_is_account_manager(p_account_id)
          or learner.created_by = (select auth.uid())
        )
    );
$function$;
alter function private.hub_can_manage_learner(uuid, uuid) owner to postgres;
revoke all on function private.hub_can_manage_learner(uuid, uuid) from public, anon, service_role;
-- A policy abaixo roda como `authenticated`; a tabela de perfis é RPC-only, então
-- a checagem tem de ser por esta função definer (como faz hub_has_educator_planner_access).
grant execute on function private.hub_can_manage_learner(uuid, uuid) to authenticated;

drop policy if exists hub_learner_assignments_educator_select on public.hub_learner_assignments;
create policy hub_learner_assignments_educator_select
on public.hub_learner_assignments
for select
to authenticated
using ((select private.hub_can_manage_learner(account_id, learner_id)));

-- Assentos: usados = alunos com usuário + convites vivos; limite = team.seats do
-- plano da assinatura viva (null = ilimitado).
create or replace function private.hub_learner_seats(p_account_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'used', (
      select pg_catalog.count(*)::int
      from public.hub_educator_learners as learner
      where learner.account_id = p_account_id
        and (
          learner.member_user_id is not null
          or (learner.invite_token is not null and learner.invite_expires_at > pg_catalog.now())
        )
    ),
    'limit', (
      select entitlement.limit_value
      from public.hub_subscriptions as subscription
      join public.hub_plan_entitlements as entitlement
        on entitlement.plan_id = subscription.plan_id
       and entitlement.feature_key = 'team.seats'
      where subscription.account_id = p_account_id
        and subscription.product_family = 'HUB_CORE'
        and (
          (subscription.status = 'TRIALING' and subscription.trial_ends_at > pg_catalog.now())
          or (subscription.status = 'ACTIVE' and coalesce(subscription.current_period_ends_at, '-infinity'::timestamptz) > pg_catalog.now())
        )
      order by subscription.created_at desc
      limit 1
    )
  );
$function$;
alter function private.hub_learner_seats(uuid) owner to postgres;
revoke all on function private.hub_learner_seats(uuid) from public, anon, authenticated, service_role;

-- O gabarito nunca chega ao aluno: tira as chaves do professor de qualquer tipo.
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
  -- Chaves de topo que são só do professor
  v := v - 'teacher_notes_pt' - 'retention_moves_pt';

  -- Listas de questões/itens: some com resposta, explicação e resposta-modelo
  foreach v_key in array array['questions', 'exercises', 'multiple_choice', 'fill_blanks', 'open_questions', 'ai_homework', 'cards']
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

-- 5) RPCs do professor ---------------------------------------------------------------
create or replace function public.hub_invite_learner(p_account_id uuid, p_learner_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_learner public.hub_educator_learners%rowtype;
  v_seats jsonb;
  v_token text;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = 'P0001';
  end if;
  if not private.hub_can_manage_learner(p_account_id, p_learner_id) then
    raise exception 'hub_account_access_denied' using errcode = '42501';
  end if;
  select * into v_learner from public.hub_educator_learners where id = p_learner_id and account_id = p_account_id;
  if v_learner.member_user_id is not null then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'LEARNER_ALREADY_JOINED');
  end if;

  v_seats := private.hub_learner_seats(p_account_id);
  -- Um convite vivo deste aluno não conta duas vezes: só barra se ele ainda não ocupa assento.
  if (v_seats ->> 'limit') is not null
     and (v_learner.invite_token is null or v_learner.invite_expires_at <= pg_catalog.now())
     and (v_seats ->> 'used')::int >= (v_seats ->> 'limit')::int then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'SEATS_EXHAUSTED', 'seats', v_seats);
  end if;

  -- 64 hex de dois UUIDs aleatórios: sem depender do pgcrypto e sem caractere que quebre em URL.
  v_token := pg_catalog.replace(pg_catalog.gen_random_uuid()::text || pg_catalog.gen_random_uuid()::text, '-', '');
  update public.hub_educator_learners
     set invite_token = v_token,
         invite_expires_at = pg_catalog.now() + interval '14 days',
         updated_at = pg_catalog.now()
   where id = p_learner_id and account_id = p_account_id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'token', v_token,
    'expires_at', pg_catalog.now() + interval '14 days',
    'seats', private.hub_learner_seats(p_account_id)
  );
end;
$function$;
alter function public.hub_invite_learner(uuid, uuid) owner to postgres;
revoke all on function public.hub_invite_learner(uuid, uuid) from public, anon;
grant execute on function public.hub_invite_learner(uuid, uuid) to authenticated, service_role;

create or replace function public.hub_learner_seats(p_account_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when private.hub_has_educator_planner_access(p_account_id) then private.hub_learner_seats(p_account_id)
    else pg_catalog.jsonb_build_object('used', 0, 'limit', 0)
  end;
$function$;
alter function public.hub_learner_seats(uuid) owner to postgres;
revoke all on function public.hub_learner_seats(uuid) from public, anon;
grant execute on function public.hub_learner_seats(uuid) to authenticated, service_role;

create or replace function public.hub_assign_material(
  p_account_id uuid,
  p_learner_id uuid,
  p_material_id uuid,
  p_note text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_id uuid;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = 'P0001';
  end if;
  if not private.hub_can_manage_learner(p_account_id, p_learner_id) then
    raise exception 'hub_account_access_denied' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.hub_educator_materials as material
    where material.id = p_material_id
      and material.account_id = p_account_id
      and (private.hub_is_account_manager(p_account_id) or material.created_by = v_user_id)
  ) then
    raise exception 'hub_material_access_denied' using errcode = '42501';
  end if;

  insert into public.hub_learner_assignments (account_id, learner_id, material_id, assigned_by, note)
  values (p_account_id, p_learner_id, p_material_id, v_user_id, pg_catalog.left(coalesce(p_note, ''), 600))
  on conflict (learner_id, material_id) do update
     set note = excluded.note,
         assigned_by = excluded.assigned_by
  returning id into v_id;

  return pg_catalog.jsonb_build_object('ok', true, 'assignment_id', v_id);
end;
$function$;
alter function public.hub_assign_material(uuid, uuid, uuid, text) owner to postgres;
revoke all on function public.hub_assign_material(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.hub_assign_material(uuid, uuid, uuid, text) to authenticated, service_role;

-- 6) RPCs do aluno -------------------------------------------------------------------
-- Prévia do convite (antes de entrar): só nome do professor/ambiente e do aluno.
create or replace function public.hub_learner_invite_preview(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce((
    select pg_catalog.jsonb_build_object(
      'ok', true,
      'learner_name', learner.display_name,
      'account_name', account.name,
      'teacher_name', coalesce(profile.display_name, account.name),
      'expires_at', learner.invite_expires_at
    )
    from public.hub_educator_learners as learner
    join public.hub_accounts as account on account.id = learner.account_id
    left join public.hub_member_profiles as profile
      on profile.account_id = learner.account_id and profile.user_id = learner.created_by
    where learner.invite_token = p_token
      and learner.invite_expires_at > pg_catalog.now()
      and learner.member_user_id is null
  ), pg_catalog.jsonb_build_object('ok', false, 'code', 'INVITE_INVALID'));
$function$;
alter function public.hub_learner_invite_preview(text) owner to postgres;
revoke all on function public.hub_learner_invite_preview(text) from public;
grant execute on function public.hub_learner_invite_preview(text) to anon, authenticated, service_role;

create or replace function public.hub_accept_learner_invite(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_learner public.hub_educator_learners%rowtype;
  v_seats jsonb;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = 'P0001';
  end if;
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'INVITE_INVALID');
  end if;

  select * into v_learner
  from public.hub_educator_learners
  where invite_token = p_token
  for update;
  if not found or v_learner.member_user_id is not null or v_learner.invite_expires_at <= pg_catalog.now() then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'INVITE_INVALID');
  end if;
  if v_learner.created_by = v_user_id then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'CANNOT_ACCEPT_OWN_INVITE');
  end if;
  -- Professor/dono da conta não vira aluno dela; assento é para gente de fora.
  if exists (
    select 1 from public.hub_memberships as membership
    where membership.account_id = v_learner.account_id
      and membership.user_id = v_user_id
      and (membership.membership_role in ('OWNER', 'ADMIN') or membership.subject_role = 'EDUCATOR')
  ) then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'ALREADY_EDUCATOR_HERE');
  end if;
  -- O mesmo usuário já ocupa outro perfil de aluno nesta conta? Não duplica assento.
  if exists (
    select 1 from public.hub_educator_learners as other
    where other.account_id = v_learner.account_id
      and other.member_user_id = v_user_id
  ) then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'ALREADY_SEATED');
  end if;

  v_seats := private.hub_learner_seats(v_learner.account_id);
  if (v_seats ->> 'limit') is not null and (v_seats ->> 'used')::int > (v_seats ->> 'limit')::int then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'SEATS_EXHAUSTED');
  end if;

  insert into public.hub_memberships (account_id, user_id, membership_role, subject_role, status)
  values (v_learner.account_id, v_user_id, 'MEMBER', 'LEARNER', 'ACTIVE')
  on conflict (account_id, user_id) do update
     set status = 'ACTIVE',
         subject_role = 'LEARNER',
         updated_at = pg_catalog.now();

  insert into public.hub_member_profiles (account_id, user_id, display_name, level, goal, preferred_modality, onboarding_completed, personalized_at)
  values (
    v_learner.account_id, v_user_id, v_learner.display_name, v_learner.level_tag,
    pg_catalog.left(coalesce(v_learner.objective, ''), 320), 'mixed', true, pg_catalog.now()
  )
  on conflict (account_id, user_id) do update
     set display_name = excluded.display_name,
         level = coalesce(excluded.level, public.hub_member_profiles.level),
         updated_at = pg_catalog.now();

  update public.hub_educator_learners
     set member_user_id = v_user_id,
         joined_at = pg_catalog.now(),
         invite_token = null,
         invite_expires_at = null,
         updated_at = pg_catalog.now()
   where id = v_learner.id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'account_id', v_learner.account_id,
    'learner_id', v_learner.id
  );
end;
$function$;
alter function public.hub_accept_learner_invite(text) owner to postgres;
revoke all on function public.hub_accept_learner_invite(text) from public, anon;
grant execute on function public.hub_accept_learner_invite(text) to authenticated, service_role;

-- A mesa do aluno: perfil, jornada e materiais atribuídos — sempre sem gabarito.
create or replace function public.hub_learner_desk(p_account_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_learner public.hub_educator_learners%rowtype;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = 'P0001';
  end if;
  select * into v_learner
  from public.hub_educator_learners
  where account_id = p_account_id and member_user_id = v_user_id;
  if not found then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'NOT_A_LEARNER_HERE');
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'learner', pg_catalog.jsonb_build_object(
      'id', v_learner.id,
      'display_name', v_learner.display_name,
      'level_tag', v_learner.level_tag,
      'objective', v_learner.objective,
      'joined_at', v_learner.joined_at
    ),
    'teacher_name', (
      select coalesce(profile.display_name, account.name)
      from public.hub_accounts as account
      left join public.hub_member_profiles as profile
        on profile.account_id = account.id and profile.user_id = v_learner.created_by
      where account.id = p_account_id
    ),
    'assignments', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', assignment.id,
          'note', assignment.note,
          'status', assignment.status,
          'student_note', assignment.student_note,
          'done_at', assignment.done_at,
          'created_at', assignment.created_at,
          'material', pg_catalog.jsonb_build_object(
            'id', material.id,
            'kind', material.kind,
            'niche', material.niche,
            'level_tag', material.level_tag,
            'topic', material.topic,
            'goal', material.goal,
            'title', material.title,
            'created_at', material.created_at,
            'material', private.hub_strip_answer_keys(material.material)
          )
        )
        order by (material.kind = 'journey') desc, assignment.created_at desc
      )
      from public.hub_learner_assignments as assignment
      join public.hub_educator_materials as material on material.id = assignment.material_id
      where assignment.learner_id = v_learner.id
        and assignment.account_id = p_account_id
    ), '[]'::jsonb)
  );
end;
$function$;
alter function public.hub_learner_desk(uuid) owner to postgres;
revoke all on function public.hub_learner_desk(uuid) from public, anon;
grant execute on function public.hub_learner_desk(uuid) to authenticated, service_role;

create or replace function public.hub_complete_assignment(p_assignment_id uuid, p_note text default '')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_rows int;
begin
  if v_user_id is null then
    raise exception 'authentication_required' using errcode = 'P0001';
  end if;
  update public.hub_learner_assignments as assignment
     set status = 'DONE',
         done_at = pg_catalog.now(),
         student_note = pg_catalog.left(coalesce(p_note, ''), 1200)
    from public.hub_educator_learners as learner
   where assignment.id = p_assignment_id
     and learner.id = assignment.learner_id
     and learner.account_id = assignment.account_id
     and learner.member_user_id = v_user_id;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return pg_catalog.jsonb_build_object('ok', false, 'code', 'ASSIGNMENT_NOT_FOUND');
  end if;
  return pg_catalog.jsonb_build_object('ok', true);
end;
$function$;
alter function public.hub_complete_assignment(uuid, text) owner to postgres;
revoke all on function public.hub_complete_assignment(uuid, text) from public, anon;
grant execute on function public.hub_complete_assignment(uuid, text) to authenticated, service_role;

-- 7) O professor enxerga o assento de cada aluno (a tabela de perfis é RPC-only) ------
create or replace function public.hub_list_learner_seats(p_account_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when not private.hub_has_educator_planner_access(p_account_id) then '[]'::jsonb
    else coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', learner.id,
          'display_name', learner.display_name,
          'level_tag', learner.level_tag,
          'objective', learner.objective,
          'seat', case
            when learner.member_user_id is not null then 'ACTIVE'
            when learner.invite_token is not null and learner.invite_expires_at > pg_catalog.now() then 'INVITED'
            else 'NONE'
          end,
          'invite_token', case
            when learner.member_user_id is null and learner.invite_token is not null and learner.invite_expires_at > pg_catalog.now()
              then learner.invite_token else null end,
          'invite_expires_at', case when learner.member_user_id is null then learner.invite_expires_at else null end,
          'joined_at', learner.joined_at,
          'assignments', coalesce((
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'id', assignment.id,
                'material_id', assignment.material_id,
                'title', material.title,
                'kind', material.kind,
                'status', assignment.status,
                'note', assignment.note,
                'student_note', assignment.student_note,
                'done_at', assignment.done_at,
                'created_at', assignment.created_at
              ) order by assignment.created_at desc)
            from public.hub_learner_assignments as assignment
            join public.hub_educator_materials as material on material.id = assignment.material_id
            where assignment.learner_id = learner.id and assignment.account_id = learner.account_id
          ), '[]'::jsonb)
        ) order by learner.display_name, learner.id)
      from public.hub_educator_learners as learner
      where learner.account_id = p_account_id
        and (private.hub_is_account_manager(p_account_id) or learner.created_by = (select auth.uid()))
    ), '[]'::jsonb)
  end;
$function$;
alter function public.hub_list_learner_seats(uuid) owner to postgres;
revoke all on function public.hub_list_learner_seats(uuid) from public, anon;
grant execute on function public.hub_list_learner_seats(uuid) to authenticated, service_role;
