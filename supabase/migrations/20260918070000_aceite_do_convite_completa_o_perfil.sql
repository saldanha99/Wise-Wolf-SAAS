-- Assentos de aluno no Hub — o aceite do convite deixa o aluno pronto para a mesa.
--
-- O primeiro aluno convidado em produção (18/09/2026) caiu no formulário de
-- personalização do Wolfie ("Aluno, aqui nada precisa ser genérico") em vez
-- de ver os materiais: `hub_accept_learner_invite` inseria o perfil de membro
-- com `onboarding_completed = true` e o objetivo do professor, mas o trigger
-- `hub_memberships_seed_member_profile` já tinha criado o perfil no insert da
-- membership, e o ramo `on conflict` só copiava nome e nível.
--
-- A migration 20260918060000 já foi aplicada; o release recusa editá-la
-- (checksum), então a função é recriada aqui com o `on conflict` completo, e
-- os alunos que já aceitaram são consertados uma vez (schema_one_shots).
-- Re-executável: `create or replace` + one-shot.

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
  -- O insert da membership dispara `hub_memberships_seed_member_profile`, que
  -- cria o perfil ANTES desta linha — então este insert cai sempre no conflito.
  -- O update precisa carregar tudo: objetivo do professor e onboarding feito.
  -- Sem isso o aluno via o formulário genérico do Wolfie em vez da mesa
  -- (medido em produção em 18/09/2026, primeiro aluno convidado).
  on conflict (account_id, user_id) do update
     set display_name = excluded.display_name,
         level = coalesce(excluded.level, public.hub_member_profiles.level),
         goal = case when excluded.goal <> '' then excluded.goal else public.hub_member_profiles.goal end,
         preferred_modality = coalesce(public.hub_member_profiles.preferred_modality, excluded.preferred_modality),
         onboarding_completed = true,
         personalized_at = coalesce(public.hub_member_profiles.personalized_at, excluded.personalized_at),
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

-- Conserto único de quem já aceitou antes desta migration.
do $one_shot$
begin
  if exists (select 1 from public.schema_one_shots where key = '20260918070000_aceite_do_convite_completa_o_perfil') then
    return;
  end if;
  update public.hub_member_profiles as profile
     set goal = case when profile.goal is null or profile.goal = '' then pg_catalog.left(coalesce(learner.objective, ''), 320) else profile.goal end,
         onboarding_completed = true,
         personalized_at = coalesce(profile.personalized_at, pg_catalog.now()),
         updated_at = pg_catalog.now()
    from public.hub_educator_learners as learner
   where learner.member_user_id = profile.user_id
     and learner.account_id = profile.account_id
     and profile.onboarding_completed = false;
  insert into public.schema_one_shots (key) values ('20260918070000_aceite_do_convite_completa_o_perfil');
end
$one_shot$;
