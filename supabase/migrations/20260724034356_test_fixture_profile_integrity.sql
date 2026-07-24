begin;

-- Identidade de teste é uma propriedade explícita do registro, nunca inferida
-- apenas pelo CPF. Isso permite uma limpeza precisa sem ampliar o hard delete
-- para alunos reais.
alter table public.profiles
  add column if not exists is_test_account boolean not null default false,
  add column if not exists test_fixture_key text;

create unique index if not exists profiles_test_fixture_key_idx
  on public.profiles (test_fixture_key)
  where is_test_account and test_fixture_key is not null;

-- Somente superadmin/service_role pode criar uma oferta de teste. O marcador é
-- propagado no próprio payload autoritativo, para que navegador e integrações
-- suprimam notificações externas.
create or replace function public.guard_enrollment_test_offer()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $function$
declare
  v_is_test boolean := coalesce((new.payload ->> 'testMode')::boolean, false);
  v_was_test boolean := case
    when tg_op = 'UPDATE' then coalesce((old.payload ->> 'testMode')::boolean, false)
    else false
  end;
  v_jwt_role text := coalesce(auth.jwt() ->> 'role', '');
begin
  if new.kind = 'ENROLLMENT' and v_is_test and not v_was_test then
    if v_jwt_role <> 'service_role'
       and public._my_role() is distinct from 'SUPER_ADMIN' then
      raise exception 'forbidden: testMode exige SUPER_ADMIN';
    end if;

    new.payload := coalesce(new.payload, '{}'::jsonb) || jsonb_build_object(
      'testMode', true,
      'testFixtureKey', 'wise-wolf-primary-student:' || new.id::text
    );
  end if;

  return new;
exception
  when invalid_text_representation then
    raise exception 'testMode invalido';
end;
$function$;

drop trigger if exists trg_guard_enrollment_test_offer on public.offers;
create trigger trg_guard_enrollment_test_offer
before insert or update of payload on public.offers
for each row
execute function public.guard_enrollment_test_offer();

-- Impede que um aluno transforme a própria conta em fixture por update direto.
create or replace function public.guard_profile_test_fixture()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $function$
declare
  v_jwt_role text := coalesce(auth.jwt() ->> 'role', '');
begin
  if row(new.is_test_account, new.test_fixture_key)
     is distinct from row(old.is_test_account, old.test_fixture_key)
     and coalesce(current_setting('app.enrollment_claim', true), '') <> '1'
     and v_jwt_role <> 'service_role'
     and public._my_role() is distinct from 'SUPER_ADMIN' then
    raise exception 'forbidden: marcador de fixture protegido';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_guard_profile_test_fixture on public.profiles;
create trigger trg_guard_profile_test_fixture
before update of is_test_account, test_fixture_key on public.profiles
for each row
execute function public.guard_profile_test_fixture();

-- begin_enrollment_offer já grava o perfil antes de mover a oferta para
-- PROFILE_READY. Este trigger aproveita a mesma transação e marca apenas a
-- identidade ligada à oferta autorizada testMode.
create or replace function public.propagate_enrollment_test_fixture()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_fixture_key text;
begin
  if new.kind <> 'ENROLLMENT'
     or new.processing_by is null
     or not coalesce((new.payload ->> 'testMode')::boolean, false) then
    return new;
  end if;

  v_fixture_key := coalesce(
    nullif(new.payload ->> 'testFixtureKey', ''),
    'wise-wolf-primary-student:' || new.id::text
  );

  update public.profiles
     set is_test_account = true,
         test_fixture_key = v_fixture_key
   where id = new.processing_by
     and role = 'STUDENT';

  return new;
end;
$function$;

drop trigger if exists trg_propagate_enrollment_test_fixture on public.offers;
create trigger trg_propagate_enrollment_test_fixture
after insert or update of processing_by, processing_state on public.offers
for each row
execute function public.propagate_enrollment_test_fixture();

-- O cutover anterior deixou produção sem a relação profiles.id -> auth.users.id.
-- NOT VALID protege todas as novas escritas e reativa ON DELETE CASCADE sem
-- apagar automaticamente órfãos históricos desconhecidos.
do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.profiles'::regclass
       and conname = 'profiles_id_fkey'
  ) then
    alter table public.profiles
      add constraint profiles_id_fkey
      foreign key (id) references auth.users(id) on delete cascade
      not valid;
  end if;
end
$$;

-- O trigger pertence a auth.users e, por isso, não veio no dump isolado de
-- public. Recriá-lo torna novos cadastros consistentes novamente.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_user();

revoke all on function public.guard_enrollment_test_offer() from public, anon, authenticated;
revoke all on function public.guard_profile_test_fixture() from public, anon, authenticated;
revoke all on function public.propagate_enrollment_test_fixture() from public, anon, authenticated;

commit;
