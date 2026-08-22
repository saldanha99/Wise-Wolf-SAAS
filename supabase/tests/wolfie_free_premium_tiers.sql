-- Fronteira gratuito x premium do Wolfie.
--
-- O que importa provar aqui: franquia NÃO CONFIGURADA não pode virar premium.
-- Se virasse, toda a escola ganharia voz paga de graça — que é exatamente o
-- custo invisível que esta separação veio fechar.

\set ON_ERROR_STOP on

begin;

create or replace function pg_temp.assert_true(value boolean, message text)
returns void
language plpgsql
as $$
begin
  if not coalesce(value, false) then
    raise exception 'assertion failed: %', message;
  end if;
end;
$$;

insert into public.tenants (id, name)
values ('wolfie-tier-school', 'Wolfie Tier School');

insert into auth.users (
  id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '00000000-0000-4000-8000-000000000931', 'authenticated', 'authenticated',
    'wolfie-tier-free@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Tier Free"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-000000000932', 'authenticated', 'authenticated',
    'wolfie-tier-plan@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Tier Plano"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-000000000933', 'authenticated', 'authenticated',
    'wolfie-tier-credits@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Tier Credito"}', now(), now()
  );

set local app.enrollment_claim = '1';
update public.profiles
   set tenant_id = 'wolfie-tier-school',
       role = 'STUDENT',
       lifecycle_status = 'active',
       is_test_account = false,
       test_fixture_key = 'wolfie-free-premium-tiers-sql'
 where id in (
   '00000000-0000-4000-8000-000000000931',
   '00000000-0000-4000-8000-000000000932',
   '00000000-0000-4000-8000-000000000933'
 );
set local app.enrollment_claim = '';

-- ---------------------------------------------------------------------------
-- 1. Escola sem franquia configurada: gratuito e sem consumo pago ao vivo.
-- ---------------------------------------------------------------------------
select pg_temp.assert_true(
  (private.wolfie_tier_snapshot('00000000-0000-4000-8000-000000000931')
    ->> 'tier') = 'FREE',
  'sem franquia configurada deveria ser FREE');

select pg_temp.assert_true(
  (private.wolfie_tier_snapshot('00000000-0000-4000-8000-000000000931')
    ->> 'voice_replies')::boolean is false,
  'sem franquia configurada nao pode liberar voz paga');

select pg_temp.assert_true(
  (private.wolfie_tier_snapshot('00000000-0000-4000-8000-000000000931')
    ->> 'live_allowed')::boolean is false
  and (private.wolfie_tier_snapshot('00000000-0000-4000-8000-000000000931')
    ->> 'live_enforced')::boolean is true,
  'sem franquia configurada liberou consumo pago ao vivo');

select pg_temp.assert_true(
  (private.wolfie_tier_snapshot('00000000-0000-4000-8000-000000000931')
    ->> 'reason') in ('franquia_nao_configurada', 'franquia_esgotada'),
  'motivo deveria manter a escola sem acesso premium');

-- ---------------------------------------------------------------------------
-- 2. Franquia do tenant com saldo: premium, com voz.
-- ---------------------------------------------------------------------------
insert into public.student_plan_entitlements
  (tenant_id, plan_id, feature_key, limit_value)
values ('wolfie-tier-school', null, 'wolfie.live_minutes', 60);

select pg_temp.assert_true(
  (private.wolfie_tier_snapshot('00000000-0000-4000-8000-000000000932')
    ->> 'tier') = 'PREMIUM',
  'franquia com saldo deveria ser PREMIUM');

select pg_temp.assert_true(
  (private.wolfie_tier_snapshot('00000000-0000-4000-8000-000000000932')
    ->> 'voice_replies')::boolean is true,
  'premium deveria liberar a voz do Wolfie');

-- ---------------------------------------------------------------------------
-- 3. Franquia esgotada no mês: volta a gratuito (texto), sem voz.
-- ---------------------------------------------------------------------------
insert into public.student_live_minutes
  (
    tenant_id,
    student_id,
    seconds,
    plan_seconds,
    credit_seconds,
    created_at
  )
values (
  'wolfie-tier-school', '00000000-0000-4000-8000-000000000932',
  60 * 60, 60 * 60, 0,
  date_trunc('month', current_date) + interval '1 hour'
);

select pg_temp.assert_true(
  (private.wolfie_tier_snapshot('00000000-0000-4000-8000-000000000932')
    ->> 'reason') = 'franquia_esgotada',
  'consumo igual a franquia deveria esgotar');

select pg_temp.assert_true(
  (private.wolfie_tier_snapshot('00000000-0000-4000-8000-000000000932')
    ->> 'voice_replies')::boolean is false,
  'franquia esgotada nao pode continuar gastando voz paga');

-- ---------------------------------------------------------------------------
-- 4. Crédito comprado sustenta o premium: o aluno pagou por ele.
-- ---------------------------------------------------------------------------
insert into public.student_minute_credits
  (tenant_id, student_id, minutes)
values ('wolfie-tier-school', '00000000-0000-4000-8000-000000000932', 30);

select pg_temp.assert_true(
  (private.wolfie_tier_snapshot('00000000-0000-4000-8000-000000000932')
    ->> 'voice_replies')::boolean is true,
  'credito comprado deveria devolver o premium');

-- ---------------------------------------------------------------------------
-- 5. Um aluno não pode perguntar pelo tier de outro.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"00000000-0000-4000-8000-000000000931","role":"authenticated"}';

do $$
begin
  perform public.wolfie_tier_for_student(
    '00000000-0000-4000-8000-000000000932');
  raise exception 'assertion failed: aluno leu o tier de outro aluno';
exception
  when sqlstate 'P0001' then
    if sqlerrm not like '%sem_permissao%' then
      raise;
    end if;
end;
$$;

-- Neste ponto a franquia do passo 2 é do TENANT (plan_id nulo), então vale
-- também para este aluno: o esperado aqui é premium, não gratuito.
select pg_temp.assert_true(
  (public.my_wolfie_tier() ->> 'reason') = 'franquia_disponivel',
  'my_wolfie_tier deveria responder pelo proprio aluno');

reset role;

rollback;
