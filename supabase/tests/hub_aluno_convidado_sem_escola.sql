-- Aluno convidado vira NON_STUDENT ao entrar na conta do professor (migration 20261123190000).
begin;
create or replace function pg_temp.assert_true(p_ok boolean, p_message text) returns void
language plpgsql as $$ begin if p_ok is not true then raise exception 'assertion failed: %', p_message; end if; end $$;
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values ('7b000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'conv-prof@exemplo.invalid', '{}', now(), now()),
       ('7b000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'conv-aluno@exemplo.invalid', '{}', now(), now());
update public.profiles set lifecycle_status = 'active', status = 'Ativo' where id in ('7b000000-0000-4000-8000-000000000001', '7b000000-0000-4000-8000-000000000002');
select set_config('request.jwt.claims', '{"sub":"7b000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
create temp table c as select private.hub_claim_trial_internal('EDUCATOR', 'Prof Convite') as r;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select pg_temp.assert_true((select role = 'STUDENT' and tenant_id is null from public.profiles where id = '7b000000-0000-4000-8000-000000000002'), 'aluno nasce STUDENT sem escola');
insert into public.hub_memberships (account_id, user_id, membership_role, status, subject_role)
select (r ->> 'accountId')::uuid, '7b000000-0000-4000-8000-000000000002', 'MEMBER', 'ACTIVE', 'LEARNER' from c;
select pg_temp.assert_true((select role = 'NON_STUDENT' from public.profiles where id = '7b000000-0000-4000-8000-000000000002'), 'membro ativo vira NON_STUDENT');
-- Aluno de escola não muda.
select pg_temp.assert_true(
  (select count(*) = 0 from public.profiles p join public.hub_memberships m on m.user_id = p.id
    where m.status = 'ACTIVE' and p.role = 'STUDENT' and p.tenant_id is null),
  'nenhum membro ativo sem escola continua STUDENT');
rollback;
