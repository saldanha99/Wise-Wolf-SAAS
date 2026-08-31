-- Modo Turbo prospectivo: carteira tenant-safe, ofensiva de 30 dias, penalidade
-- somente apos decisao final da direcao e preservacao financeira
-- anterior a 20/08/2026. Todos os fixtures sao revertidos ao final.

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

grant execute on function pg_temp.assert_true(boolean, text) to public;
do $$
begin
  if to_regprocedure('pg_temp.assert_sqlstate(text, text, text)') is not null then
    execute 'grant execute on function pg_temp.assert_sqlstate(text, text, text) to public';
  end if;
end
$$;

insert into public.tenants (id, name)
values
  ('turbo-streak-school-a', 'Turbo Streak School A'),
  ('turbo-streak-school-b', 'Turbo Streak School B');

insert into auth.users (
  id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  (
    '00000000-0000-4000-8000-000000000971', 'authenticated', 'authenticated',
    'turbo-streak-admin-a@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Diretora Turbo A"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-000000000972', 'authenticated', 'authenticated',
    'turbo-streak-admin-b@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Diretora Turbo B"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-000000000973', 'authenticated', 'authenticated',
    'turbo-streak-teacher-a@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Professor Turbo A"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-000000000974', 'authenticated', 'authenticated',
    'turbo-streak-teacher-b@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Professor Turbo B"}', now(), now()
  ),
  (
    '00000000-0000-4000-8000-000000000977', 'authenticated', 'authenticated',
    'turbo-streak-without-profile@example.invalid',
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Conta Sem Perfil"}', now(), now()
  );

insert into auth.users (
  id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
select md5('turbo-streak-student-a-' || g::text)::uuid,
       'authenticated', 'authenticated',
       'turbo-streak-student-a-' || g::text || '@example.invalid',
       '{"provider":"email","providers":["email"]}'::jsonb,
       jsonb_build_object('full_name', 'Aluno Turbo A ' || g::text),
       now(), now()
from generate_series(1, 10) g;

insert into auth.users (
  id, aud, role, email,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
select md5('turbo-streak-student-b-' || g::text)::uuid,
       'authenticated', 'authenticated',
       'turbo-streak-student-b-' || g::text || '@example.invalid',
       '{"provider":"email","providers":["email"]}'::jsonb,
       jsonb_build_object('full_name', 'Aluno Turbo B ' || g::text),
       now(), now()
from generate_series(1, 10) g;

update public.profiles
   set tenant_id = 'turbo-streak-school-a',
       role = 'SCHOOL_ADMIN',
       full_name = 'Diretora Turbo A'
 where id = '00000000-0000-4000-8000-000000000971';

update public.profiles
   set tenant_id = 'turbo-streak-school-b',
       role = 'SCHOOL_ADMIN',
       full_name = 'Diretora Turbo B'
 where id = '00000000-0000-4000-8000-000000000972';

update public.profiles
   set tenant_id = 'turbo-streak-school-a',
       role = 'TEACHER',
       full_name = 'Professor Turbo A',
       start_date = date '2026-06-01'
 where id = '00000000-0000-4000-8000-000000000973';

update public.profiles
   set tenant_id = 'turbo-streak-school-b',
       role = 'TEACHER',
       full_name = 'Professor Turbo B',
       start_date = public.teacher_turbo_business_date() - 15
where id = '00000000-0000-4000-8000-000000000974';

delete from public.teacher_turbo_state
 where teacher_id = '00000000-0000-4000-8000-000000000974';
select public.teacher_turbo_ensure_state('00000000-0000-4000-8000-000000000974');
select public.teacher_turbo_refresh_eligibility('00000000-0000-4000-8000-000000000974');

update public.profiles p
   set tenant_id = 'turbo-streak-school-a',
       role = 'STUDENT',
       lifecycle_status = 'active',
       full_name = 'Aluno Turbo A ' || g::text
  from generate_series(1, 10) g
 where p.id = md5('turbo-streak-student-a-' || g::text)::uuid;

update public.profiles p
   set tenant_id = 'turbo-streak-school-b',
       role = 'STUDENT',
       lifecycle_status = 'active',
       full_name = 'Aluno Turbo B ' || g::text
  from generate_series(1, 10) g
 where p.id = md5('turbo-streak-student-b-' || g::text)::uuid;

-- Mantem uma identidade auth valida sem profile para provar que role NULL
-- sempre falha fechado nas RPCs SECURITY DEFINER.
delete from public.profiles
 where id = '00000000-0000-4000-8000-000000000977';

insert into public.bookings (
  id, tenant_id, teacher_id, student_id,
  day_of_week, time_slot, status, start_date
)
select md5('turbo-streak-booking-a-' || g::text)::uuid,
       'turbo-streak-school-a',
       '00000000-0000-4000-8000-000000000973',
       md5('turbo-streak-student-a-' || g::text)::uuid,
       to_char(
         public.teacher_turbo_business_date() -
           case when g = 1 then 2 when g = 2 then 1 else 0 end,
         'FMDay'
       ),
       '08:00', 'SCHEDULED', date '2026-06-01'
from generate_series(1, 10) g;

insert into public.bookings (
  id, tenant_id, teacher_id, student_id,
  day_of_week, time_slot, status, start_date
)
select md5('turbo-streak-booking-b-' || g::text)::uuid,
       'turbo-streak-school-b',
       '00000000-0000-4000-8000-000000000974',
       md5('turbo-streak-student-b-' || g::text)::uuid,
       to_char(public.teacher_turbo_business_date(), 'FMDay'),
       '09:00', 'SCHEDULED', public.teacher_turbo_business_date() - 15
from generate_series(1, 10) g;

-- Um booking corrompido entre escolas ainda aparece na carteira financeira
-- antiga, mas nao pode inflar a elegibilidade tenant-safe do Turbo.
-- A protecao atual bloqueia essa corrupcao na escrita. Ignore os triggers
-- ordinarios apenas neste insert rollback-only, sem bloquear a tabela no deploy.
set local session_replication_role = replica;
insert into public.bookings (
  id, tenant_id, teacher_id, student_id,
  day_of_week, time_slot, status, start_date
)
values (
  md5('turbo-streak-cross-tenant-booking')::uuid,
  'turbo-streak-school-a',
  '00000000-0000-4000-8000-000000000973',
  md5('turbo-streak-student-b-1')::uuid,
  'Quarta', '10:00', 'SCHEDULED', date '2026-06-01'
);
set local session_replication_role = origin;

select pg_temp.assert_true(
  public.teacher_turbo_student_count('00000000-0000-4000-8000-000000000973') = 10,
  'booking de aluno de outro tenant inflou a carteira do Turbo'
);

select pg_temp.assert_true(
  (select count(*) = 11 from public.teacher_carteira('00000000-0000-4000-8000-000000000973')),
  'fixture nao demonstrou a diferenca entre carteira legada e contagem tenant-safe'
);

-- Reconstroi datas conhecidas para provar as fronteiras sem depender do dia em
-- que o teste for executado.
update public.teacher_turbo_state
   set initial_anchor_on = date '2026-06-01',
       streak_anchor_on = date '2026-06-01',
       students_eligible_since = date '2026-06-01',
       last_confirmed_absence_on = null
 where teacher_id = '00000000-0000-4000-8000-000000000973';

update public.teacher_turbo_events
   set effective_on = date '2026-07-15'
 where teacher_id = '00000000-0000-4000-8000-000000000973'
   and event_type = 'STUDENT_THRESHOLD_REACHED';

update public.teacher_turbo_state
   set initial_anchor_on = public.teacher_turbo_business_date() - 15,
       streak_anchor_on = public.teacher_turbo_business_date() - 15,
       students_eligible_since = public.teacher_turbo_business_date() - 15,
       last_confirmed_absence_on = null
 where teacher_id = '00000000-0000-4000-8000-000000000974';

update public.teacher_turbo_events
   set effective_on = public.teacher_turbo_business_date() - 15
 where teacher_id = '00000000-0000-4000-8000-000000000974'
   and event_type = 'STUDENT_THRESHOLD_REACHED';

select pg_temp.assert_true(
  public.teacher_turbo_status_at(
    '00000000-0000-4000-8000-000000000973', date '2026-07-10'
  )->>'status' = 'INELIGIBLE_STUDENTS'
  and not (public.teacher_turbo_status_at(
    '00000000-0000-4000-8000-000000000973', date '2026-07-10'
  )->>'active')::boolean
  and public.teacher_turbo_status_at(
    '00000000-0000-4000-8000-000000000973', date '2026-07-10'
  )->>'blocked_by' = 'carteira',
  'data historica sem evento de limiar caiu em ACTIVE por boolean NULL'
);

-- A falta de julho desliga a regra mensal historica em agosto, mas ja teria
-- completado 30 dias na nova regra. Isso prova que o cutoff realmente despacha
-- para a semantica antiga antes de 20/08 e para a nova a partir da vigencia.
insert into public.class_logs (
  id, tenant_id, teacher_id, student_id, presence, date, class_date
)
values
  (
    '00000000-0000-4000-8000-00000000097a', 'turbo-streak-school-a',
    '00000000-0000-4000-8000-000000000973', md5('turbo-streak-student-a-1')::uuid,
    'COMPLETED', date '2026-06-15', date '2026-06-15'
  ),
  (
    '00000000-0000-4000-8000-00000000097b', 'turbo-streak-school-a',
    '00000000-0000-4000-8000-000000000973', md5('turbo-streak-student-a-1')::uuid,
    'TEACHER_ABSENCE', date '2026-07-01', date '2026-07-01'
  ),
  (
    '00000000-0000-4000-8000-00000000097c', 'turbo-streak-school-a',
    '00000000-0000-4000-8000-000000000973', md5('turbo-streak-student-a-1')::uuid,
    'COMPLETED', date '2026-08-10', date '2026-08-10'
  );

select pg_temp.assert_true(
  not public.teacher_turbo_on_legacy_monthly(
    '00000000-0000-4000-8000-000000000973', date '2026-08-19'
  ),
  'fixture mensal historico deveria estar sem Turbo por falta em julho'
);

select pg_temp.assert_true(
  (public.teacher_turbo_status_at(
    '00000000-0000-4000-8000-000000000973', date '2026-08-19'
  )->>'active')::boolean,
  'fixture rolling deveria ter recuperado o Turbo apos 30 dias'
);

select pg_temp.assert_true(
  not public.teacher_turbo_on(
    '00000000-0000-4000-8000-000000000973', date '2026-08-19'
  ),
  'teacher_turbo_on recalculou uma tarifa anterior ao cutoff com a regra nova'
);

select pg_temp.assert_true(
  public.teacher_turbo_on(
    '00000000-0000-4000-8000-000000000973', date '2026-08-20'
  ),
  'nova ofensiva nao entrou em vigor exatamente no cutoff'
);

select pg_temp.assert_true(
  public.teacher_turbo_status_at(
    '00000000-0000-4000-8000-000000000973', date '2026-07-30'
  )->>'status' = 'BUILDING'
  and (public.teacher_turbo_status_at(
    '00000000-0000-4000-8000-000000000973', date '2026-07-30'
  )->>'days_to_activate')::integer = 1,
  'dia 29 da ofensiva nao ficou com um dia restante'
);

select pg_temp.assert_true(
  public.teacher_turbo_status_at(
    '00000000-0000-4000-8000-000000000973', date '2026-07-31'
  )->>'status' = 'ACTIVE'
  and public.teacher_turbo_status_at(
    '00000000-0000-4000-8000-000000000973', date '2026-07-31'
  )->>'active_since' = '2026-07-31',
  'Turbo nao ativou ao completar 30 dias corridos'
);

-- Dois relatos simultaneos ainda pendentes sao apenas sinais para a direcao:
-- nao suspendem o Turbo, nao abrem disputa e nao alteram a ofensiva. A decisao
-- final continua auditavel, mas so TEACHER_ABSENT pode aplicar penalidade.
insert into public.attendance_confirmations (
  id, tenant_id, teacher_id, student_id, student_name,
  class_date, class_time, teacher_name, token,
  student_response, responded_at, status, source_id, source_type
)
values
  (
    '00000000-0000-4000-8000-00000000097d', 'turbo-streak-school-a',
    '00000000-0000-4000-8000-000000000973', md5('turbo-streak-student-a-1')::uuid,
    'Aluno Turbo A 1', public.teacher_turbo_business_date() - 2, '08:00',
    'Professor Turbo A', 'turbo-streak-no-show-a-1',
    'TEACHER_NO_SHOW',
    ((public.teacher_turbo_business_date() - 2)::timestamp + interval '12 hours') AT TIME ZONE 'America/Sao_Paulo',
    'AWAITING_TEACHER',
    (md5('turbo-streak-booking-a-1')::uuid)::text, 'booking'
  ),
  (
    '00000000-0000-4000-8000-00000000097e', 'turbo-streak-school-a',
    '00000000-0000-4000-8000-000000000973', md5('turbo-streak-student-a-2')::uuid,
    'Aluno Turbo A 2', public.teacher_turbo_business_date() - 1, '08:00',
    'Professor Turbo A', 'turbo-streak-no-show-a-2',
    'TEACHER_NO_SHOW',
    ((public.teacher_turbo_business_date() - 1)::timestamp + interval '12 hours') AT TIME ZONE 'America/Sao_Paulo',
    'AWAITING_TEACHER',
    (md5('turbo-streak-booking-a-2')::uuid)::text, 'booking'
  );

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000971","role":"authenticated"}';

select pg_temp.assert_true(
  public.teacher_turbo_status('00000000-0000-4000-8000-000000000973')->>'status' = 'ACTIVE'
  and (public.teacher_turbo_status('00000000-0000-4000-8000-000000000973')->>'suspensions_open')::integer = 0
  and (public.teacher_turbo_status('00000000-0000-4000-8000-000000000973')->>'active_days')::integer
      = public.teacher_turbo_business_date() - date '2026-07-31',
  'relatos TEACHER_NO_SHOW ainda pendentes penalizaram o Turbo'
);

select pg_temp.assert_true(
  public.teacher_turbo_status_at(
    '00000000-0000-4000-8000-000000000973',
    public.teacher_turbo_business_date() - 2
  )->>'status' = 'ACTIVE'
  and (public.teacher_turbo_status_at(
    '00000000-0000-4000-8000-000000000973',
    public.teacher_turbo_business_date() - 2
  )->>'active')::boolean,
  'relato pendente alterou retroativamente o Turbo na data em que foi feito'
);

select pg_temp.assert_true(
  not exists (
    select 1
      from public.teacher_turbo_disputes
     where confirmation_id in (
       '00000000-0000-4000-8000-00000000097d',
       '00000000-0000-4000-8000-00000000097e'
     )
  )
  and not exists (
    select 1
      from public.teacher_turbo_events
     where source_type = 'attendance_confirmation'
       and source_id in (
         '00000000-0000-4000-8000-00000000097d',
         '00000000-0000-4000-8000-00000000097e'
       )
  ),
  'relatos pendentes abriram disputa ou evento preventivo'
);

select pg_temp.assert_true(
  (select streak_anchor_on = date '2026-07-01'
     from public.teacher_turbo_state
    where teacher_id = '00000000-0000-4000-8000-000000000973'),
  'relato ainda nao decidido destruiu a ofensiva'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000971","role":"authenticated"}';

select pg_temp.assert_true(
  public.resolve_attendance_conflict_v2(
    '00000000-0000-4000-8000-00000000097d', 'TEACHER_PRESENT', 'Professor comprovou presenca'
  )->>'turbo_action' = 'RESTORED',
  'primeira inocentacao nao preservou o Turbo ativo'
);

select pg_temp.assert_true(
  public.teacher_turbo_status('00000000-0000-4000-8000-000000000973')->>'status' = 'ACTIVE'
  and (public.teacher_turbo_status('00000000-0000-4000-8000-000000000973')->>'suspensions_open')::integer = 0
  and (select status = 'DISMISSED' and verdict = 'TEACHER_PRESENT'
         from public.teacher_turbo_disputes
        where confirmation_id = '00000000-0000-4000-8000-00000000097d')
  and not exists (
    select 1
      from public.teacher_turbo_disputes
     where confirmation_id = '00000000-0000-4000-8000-00000000097e'
  ),
  'primeira inocentacao penalizou o professor ou materializou o segundo relato pendente'
);

select pg_temp.assert_true(
  (public.resolve_attendance_conflict_v2(
    '00000000-0000-4000-8000-00000000097d', 'TEACHER_ABSENT', 'Repeticao nao pode reverter absolvimento'
  )->>'already')::boolean,
  'primeira inocentacao nao foi idempotente'
);

select pg_temp.assert_true(
  public.resolve_attendance_conflict(
    '00000000-0000-4000-8000-00000000097e', true, 'Compatibilidade: professor presente'
  )->>'turbo_action' = 'RESTORED',
  'wrapper legado nao preservou o Turbo na segunda inocentacao'
);

select pg_temp.assert_true(
  (public.resolve_attendance_conflict(
    '00000000-0000-4000-8000-00000000097e', false, 'Repeticao legada nao pode reverter absolvimento'
  )->>'already')::boolean,
  'segunda inocentacao nao foi idempotente no wrapper legado'
);

select pg_temp.assert_true(
  (select turbo_active and turbo_status = 'ACTIVE'
          and days_to_activate = 0 and active_since = date '2026-07-31'
          and active_days = (now() at time zone 'America/Sao_Paulo')::date - date '2026-07-31'
     from public.list_teacher_turbo_overview()
    where teacher_id = '00000000-0000-4000-8000-000000000973'),
  'visao da diretoria nao mostrou ofensiva/tempo ativo restaurados'
);

reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000971","role":"authenticated"}';

select pg_temp.assert_true(
  public.teacher_turbo_status('00000000-0000-4000-8000-000000000973')->>'status' = 'ACTIVE'
  and (select streak_anchor_on = date '2026-07-01'
         from public.teacher_turbo_state
        where teacher_id = '00000000-0000-4000-8000-000000000973'),
  'inocentacao nao devolveu exatamente o ciclo anterior'
);

select pg_temp.assert_true(
  public.teacher_turbo_status_at(
    '00000000-0000-4000-8000-000000000973',
    public.teacher_turbo_business_date() - 2
  )->>'status' = 'ACTIVE'
  and (public.teacher_turbo_status_at(
    '00000000-0000-4000-8000-000000000973',
    public.teacher_turbo_business_date() - 2
  )->>'active')::boolean,
  'inocentacao nao devolveu retroativamente o Turbo na data do relato'
);

select pg_temp.assert_true(
  (select count(*) = 2
     from public.teacher_turbo_disputes
    where teacher_id = '00000000-0000-4000-8000-000000000973'
      and confirmation_id in (
        '00000000-0000-4000-8000-00000000097d',
        '00000000-0000-4000-8000-00000000097e'
      )
      and status = 'DISMISSED'
      and verdict = 'TEACHER_PRESENT')
  and (select count(*) = 2
         from public.teacher_turbo_events
        where teacher_id = '00000000-0000-4000-8000-000000000973'
          and event_type = 'DISPUTE_REPORTED'
          and source_id in (
            '00000000-0000-4000-8000-00000000097d',
            '00000000-0000-4000-8000-00000000097e'
          ))
  and (select count(*) = 2
         from public.teacher_turbo_events
        where teacher_id = '00000000-0000-4000-8000-000000000973'
          and event_type = 'DISPUTE_DISMISSED'
          and source_id in (
            '00000000-0000-4000-8000-00000000097d',
            '00000000-0000-4000-8000-00000000097e'
          ))
  and not exists (
    select 1
      from public.teacher_turbo_events
     where teacher_id = '00000000-0000-4000-8000-000000000973'
       and event_type = 'ABSENCE_CONFIRMED'
       and source_id in (
         '00000000-0000-4000-8000-00000000097d',
         '00000000-0000-4000-8000-00000000097e'
       )
  ),
  'inocentacoes nao ficaram auditaveis uma vez ou criaram penalidade'
);

-- Perder a carteira corta o Turbo; recuperar o decimo aluno reabre a
-- elegibilidade, sem apagar a ofensiva limpa que ja existia.
update public.bookings
   set status = 'CANCELLED'
 where id = md5('turbo-streak-booking-a-1')::uuid;

select pg_temp.assert_true(
  public.teacher_turbo_status('00000000-0000-4000-8000-000000000973')->>'status' = 'INELIGIBLE_STUDENTS'
  and (public.teacher_turbo_status('00000000-0000-4000-8000-000000000973')->>'students_active')::integer = 9,
  'carteira abaixo de dez nao cortou o Turbo'
);

update public.bookings
   set status = 'SCHEDULED'
 where id = md5('turbo-streak-booking-a-1')::uuid;

select pg_temp.assert_true(
  public.teacher_turbo_status('00000000-0000-4000-8000-000000000973')->>'status' = 'ACTIVE'
  and public.teacher_turbo_status('00000000-0000-4000-8000-000000000973')->>'active_since'
      = public.teacher_turbo_business_date()::text
  and (select students_eligible_since = public.teacher_turbo_business_date()
         from public.teacher_turbo_state
        where teacher_id = '00000000-0000-4000-8000-000000000973'),
  'recuperar o decimo aluno nao preservou a data real da nova elegibilidade'
);

-- Falta confirmada pela direcao: decisao final, reset no dia da aula e evento
-- unico, mesmo com trigger + chamada explicita de sincronizacao.
set local role postgres;
insert into public.attendance_confirmations (
  id, tenant_id, teacher_id, student_id, student_name,
  class_date, class_time, teacher_name, token,
  student_response, responded_at, status, source_id, source_type
)
values (
  '00000000-0000-4000-8000-00000000097f', 'turbo-streak-school-a',
  '00000000-0000-4000-8000-000000000973', md5('turbo-streak-student-a-3')::uuid,
  'Aluno Turbo A 3', public.teacher_turbo_business_date(), '08:00',
  'Professor Turbo A', 'turbo-streak-no-show-a-confirmed',
  'TEACHER_NO_SHOW', now(), 'AWAITING_TEACHER',
  (md5('turbo-streak-booking-a-3')::uuid)::text, 'booking'
);
set local role authenticated;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000971","role":"authenticated"}';

select pg_temp.assert_true(
  public.teacher_turbo_status('00000000-0000-4000-8000-000000000973')->>'status' = 'ACTIVE'
  and (public.teacher_turbo_status('00000000-0000-4000-8000-000000000973')->>'suspensions_open')::integer = 0
  and not exists (
    select 1
      from public.teacher_turbo_disputes
     where confirmation_id = '00000000-0000-4000-8000-00000000097f'
  ),
  'relato final ainda pendente penalizou o Turbo antes da decisao'
);

select pg_temp.assert_true(
  public.resolve_attendance_conflict_v2(
    '00000000-0000-4000-8000-00000000097f', 'TEACHER_ABSENT', 'Falta confirmada pela direcao'
  )->>'turbo_action' = 'RESET',
  'falta confirmada nao retornou a acao RESET'
);

select pg_temp.assert_true(
  (public.resolve_attendance_conflict_v2(
    '00000000-0000-4000-8000-00000000097f', 'TEACHER_PRESENT', 'Tentativa de reverter decisao final'
  )->>'already')::boolean,
  'decisao final nao foi idempotente'
);

reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000971","role":"authenticated"}';

select pg_temp.assert_true(
  public.teacher_turbo_status('00000000-0000-4000-8000-000000000973')->>'status' = 'BUILDING'
  and (public.teacher_turbo_status('00000000-0000-4000-8000-000000000973')->>'days_clean')::integer = 0
  and (public.teacher_turbo_status('00000000-0000-4000-8000-000000000973')->>'days_to_activate')::integer = 30,
  'falta confirmada nao zerou a ofensiva atual'
);

select pg_temp.assert_true(
  (select status = 'CONFIRMED_ABSENCE' and verdict = 'TEACHER_ABSENT'
     from public.teacher_turbo_disputes
    where confirmation_id = '00000000-0000-4000-8000-00000000097f')
  and
  (select count(*) = 1
     from public.teacher_turbo_events
    where event_type = 'ABSENCE_CONFIRMED'
      and source_id = '00000000-0000-4000-8000-00000000097f')
  and (select count(*) = 1
         from public.teacher_turbo_events
        where event_type = 'DISPUTE_REPORTED'
          and source_id = '00000000-0000-4000-8000-00000000097f'),
  'decisao de falta nao ficou auditavel/idempotente'
);

-- Professor ainda construindo a ofensiva: uma falta direta tambem volta a zero.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000972","role":"authenticated"}';

select pg_temp.assert_true(
  public.teacher_turbo_status('00000000-0000-4000-8000-000000000974')->>'status' = 'BUILDING'
  and (public.teacher_turbo_status('00000000-0000-4000-8000-000000000974')->>'days_clean')::integer = 15,
  'fixture do professor com 15 dias nao foi montado'
);

set local role postgres;
insert into public.class_logs (
  id, tenant_id, teacher_id, student_id, presence, date, class_date
)
values (
  '00000000-0000-4000-8000-000000000975', 'turbo-streak-school-b',
  '00000000-0000-4000-8000-000000000974', md5('turbo-streak-student-b-1')::uuid,
  'Falta do Professor', public.teacher_turbo_business_date(), public.teacher_turbo_business_date()
);
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000972","role":"authenticated"}';

select pg_temp.assert_true(
  (public.teacher_turbo_status('00000000-0000-4000-8000-000000000974')->>'days_clean')::integer = 0
  and (public.teacher_turbo_status('00000000-0000-4000-8000-000000000974')->>'days_to_activate')::integer = 30,
  'falta direta nao zerou uma ofensiva parcial de 15 dias'
);

-- Isolamento: diretora A nao lista, le nem decide dados da escola B.
set local role postgres;
insert into public.attendance_confirmations (
  id, tenant_id, teacher_id, student_id, student_name,
  class_date, class_time, teacher_name, token,
  student_response, responded_at, status, source_id, source_type
)
values (
  '00000000-0000-4000-8000-000000000976', 'turbo-streak-school-b',
  '00000000-0000-4000-8000-000000000974', md5('turbo-streak-student-b-2')::uuid,
  'Aluno Turbo B 2', public.teacher_turbo_business_date(), '09:00',
  'Professor Turbo B', 'turbo-streak-no-show-b',
  'TEACHER_NO_SHOW', now(), 'AWAITING_TEACHER',
  (md5('turbo-streak-booking-b-2')::uuid)::text, 'booking'
);
set local role authenticated;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000971","role":"authenticated"}';

select pg_temp.assert_true(
  (select count(*) = 1 from public.list_teacher_turbo_overview())
  and not exists (
    select 1 from public.list_teacher_turbo_overview()
     where tenant_id = 'turbo-streak-school-b'
  ),
  'visao em lote da diretora A vazou professor da escola B'
);

select pg_temp.assert_true(
  not exists (
    select 1 from public.teacher_turbo_state
     where tenant_id = 'turbo-streak-school-b'
  ),
  'RLS das tabelas Turbo vazou estado da escola B'
);

select pg_temp.assert_true(
  public.resolve_attendance_conflict_v2(
    '00000000-0000-4000-8000-000000000976', 'TEACHER_PRESENT', 'Tentativa entre escolas'
  )->>'error' = 'sem_permissao',
  'diretora A decidiu relato da escola B'
);

select pg_temp.assert_true(
  public.resolve_attendance_conflict(
    '00000000-0000-4000-8000-000000000976', null, 'Booleano ausente'
  )->>'error' = 'p_pay_obrigatorio',
  'wrapper legado aceitou p_pay NULL'
);

reset role;

select pg_temp.assert_true(
  (select status = 'AWAITING_TEACHER'
     from public.attendance_confirmations
    where id = '00000000-0000-4000-8000-000000000976'),
  'p_pay NULL alterou o conflito'
);

-- O contexto ativo e soberano: a mesma conta primeiro administra a escola B e
-- deve enxergar apenas B; ao perder esse role ativo, o role legado de A nao pode
-- continuar concedendo poderes na escola selecionada.
insert into public.tenant_memberships (
  user_id, tenant_id, role, status, is_primary
)
values (
  '00000000-0000-4000-8000-000000000971',
  'turbo-streak-school-b', 'SCHOOL_ADMIN', 'ACTIVE', false
)
on conflict (user_id, tenant_id) do update
set role = excluded.role, status = 'ACTIVE', is_primary = false;

insert into public.tenant_user_contexts (user_id, tenant_id)
values ('00000000-0000-4000-8000-000000000971', 'turbo-streak-school-b')
on conflict (user_id) do update
set tenant_id = excluded.tenant_id, updated_at = now();

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000971","role":"authenticated"}';

select pg_temp.assert_true(
  public._my_role() = 'SCHOOL_ADMIN'
  and public._my_tenant_id() = 'turbo-streak-school-b'
  and (select count(*) = 1 from public.list_teacher_turbo_overview())
  and not exists (
    select 1 from public.list_teacher_turbo_overview()
     where tenant_id <> 'turbo-streak-school-b'
  )
  and (select count(*) = 1 from public.teacher_turbo_state)
  and public.resolve_attendance_conflict_v2(
    '00000000-0000-4000-8000-000000000976', 'VEREDITO_INVALIDO', 'Gate da escola ativa'
  )->>'error' = 'veredito_invalido',
  'RPCs ignoraram tenant/role da escola ativa'
);

reset role;

update public.tenant_memberships
   set role = 'TEACHER', updated_at = now()
 where user_id = '00000000-0000-4000-8000-000000000971'
   and tenant_id = 'turbo-streak-school-b';

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000971","role":"authenticated"}';

select pg_temp.assert_true(
  public._my_role() = 'TEACHER'
  and (select count(*) = 0 from public.list_teacher_turbo_overview())
  and public.resolve_attendance_conflict_v2(
    '00000000-0000-4000-8000-000000000976', 'TEACHER_PRESENT', 'Role legado nao pode prevalecer'
  )->>'error' = 'sem_permissao',
  'RPCs confiaram no role SCHOOL_ADMIN legado em vez do role ativo TEACHER'
);

reset role;

update public.tenant_user_contexts
   set tenant_id = 'turbo-streak-school-a', updated_at = now()
 where user_id = '00000000-0000-4000-8000-000000000971';

-- Conta authenticated sem profile: _my_role() e tenant sao NULL. O teste
-- captura especificamente a semantica NULL NOT IN, que antes falhava aberta.
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000977","role":"authenticated"}';

select pg_temp.assert_true(
  (select count(*) = 0 from public.list_teacher_turbo_overview())
  and (select count(*) = 0 from public.teacher_turbo_state)
  and public.resolve_attendance_conflict_v2(
    '00000000-0000-4000-8000-000000000976', 'TEACHER_PRESENT', 'Conta sem profile'
  )->>'error' = 'sem_permissao',
  'authenticated sem profile atravessou autorizacao NULL'
);

-- RESET de custom setting pode produzir string vazia. A leitura de claims nao
-- pode tentar converter '' diretamente para jsonb nem liberar a operacao.
set local request.jwt.claims = '';

select pg_temp.assert_true(
  (select count(*) = 0 from public.list_teacher_turbo_overview())
  and public.resolve_attendance_conflict_v2(
    '00000000-0000-4000-8000-000000000976', 'TEACHER_PRESENT', 'Claims vazio'
  )->>'error' = 'sem_permissao',
  'request.jwt.claims vazio gerou erro ou falhou aberto'
);

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000973","role":"authenticated"}';

select pg_temp.assert_true(
  (select count(*) = 0 from public.list_teacher_turbo_overview()),
  'professor obteve a visao ampla exclusiva da diretoria'
);

select pg_temp.assert_true(
  (select count(*) = 1 from public.teacher_turbo_state),
  'professor nao conseguiu ler o proprio estado ou leu estado alheio'
);

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000972","role":"authenticated"}';

select pg_temp.assert_true(
  public.resolve_attendance_conflict_v2(
    '00000000-0000-4000-8000-000000000976', 'TEACHER_PRESENT', 'Diretora da escola B inocentou'
  )->>'turbo_action' = 'DISPUTE_CLEARED',
  'diretora B nao conseguiu decidir seu proprio relato'
);

reset role;

-- Transicoes administrativas so existem enquanto a confirmacao esta em
-- analise. Veredito de presenca exige especificamente TEACHER_NO_SHOW.
insert into public.attendance_confirmations (
  id, tenant_id, teacher_id, student_id, student_name,
  class_date, class_time, teacher_name, token,
  student_response, responded_at, status, source_id, source_type
)
values
  (
    '00000000-0000-4000-8000-000000000978', 'turbo-streak-school-b',
    '00000000-0000-4000-8000-000000000974', md5('turbo-streak-student-b-3')::uuid,
    'Aluno Turbo B 3', public.teacher_turbo_business_date(), '09:00',
    'Professor Turbo B', 'turbo-streak-invalid-response',
    'STUDENT_PRESENT', now(), 'CONFLICT',
    (md5('turbo-streak-booking-b-3')::uuid)::text, 'booking'
  ),
  (
    '00000000-0000-4000-8000-000000000979', 'turbo-streak-school-b',
    '00000000-0000-4000-8000-000000000974', md5('turbo-streak-student-b-4')::uuid,
    'Aluno Turbo B 4', public.teacher_turbo_business_date(), '09:00',
    'Professor Turbo B', 'turbo-streak-invalid-confirmed',
    'STUDENT_PRESENT', now(), 'CONFIRMED',
    (md5('turbo-streak-booking-b-4')::uuid)::text, 'booking'
  ),
  (
    '00000000-0000-4000-8000-000000000980', 'turbo-streak-school-b',
    '00000000-0000-4000-8000-000000000974', md5('turbo-streak-student-b-5')::uuid,
    'Aluno Turbo B 5', public.teacher_turbo_business_date(), '09:00',
    'Professor Turbo B', 'turbo-streak-invalid-cancelled',
    'TEACHER_NO_SHOW', now(), 'CANCELLED',
    (md5('turbo-streak-booking-b-5')::uuid)::text, 'booking'
  ),
  (
    '00000000-0000-4000-8000-000000000981', 'turbo-streak-school-b',
    '00000000-0000-4000-8000-000000000974', md5('turbo-streak-student-b-6')::uuid,
    'Aluno Turbo B 6', public.teacher_turbo_business_date(), '09:00',
    'Professor Turbo B', 'turbo-streak-response-removed',
    'TEACHER_NO_SHOW', now(), 'AWAITING_TEACHER',
    (md5('turbo-streak-booking-b-6')::uuid)::text, 'booking'
  ),
  (
    '00000000-0000-4000-8000-000000000982', 'turbo-streak-school-b',
    '00000000-0000-4000-8000-000000000974', md5('turbo-streak-student-b-7')::uuid,
    'Aluno Turbo B 7', public.teacher_turbo_business_date(), '09:00',
    'Professor Turbo B', 'turbo-streak-confirmation-cancelled',
    'TEACHER_NO_SHOW', now(), 'AWAITING_TEACHER',
    (md5('turbo-streak-booking-b-7')::uuid)::text, 'booking'
  );

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000972","role":"authenticated"}';

select pg_temp.assert_true(
  public.resolve_attendance_conflict_v2(
    '00000000-0000-4000-8000-000000000978', 'TEACHER_PRESENT', 'Resposta incompativel'
  )->>'error' = 'resposta_incompativel',
  'veredito de presenca foi aceito sem TEACHER_NO_SHOW'
);

select pg_temp.assert_true(
  public.resolve_attendance_conflict_v2(
    '00000000-0000-4000-8000-000000000979', 'PAY', 'Confirmacao ja final'
  )->>'error' = 'estado_invalido'
  and public.resolve_attendance_conflict_v2(
    '00000000-0000-4000-8000-000000000980', 'TEACHER_PRESENT', 'Confirmacao cancelada'
  )->>'error' = 'estado_invalido',
  'RPC alterou confirmacao CONFIRMED/CANCELLED fora de analise'
);

reset role;

select pg_temp.assert_true(
  (select status = 'CONFLICT' from public.attendance_confirmations
    where id = '00000000-0000-4000-8000-000000000978')
  and (select status = 'CONFIRMED' from public.attendance_confirmations
    where id = '00000000-0000-4000-8000-000000000979')
  and (select status = 'CANCELLED' from public.attendance_confirmations
    where id = '00000000-0000-4000-8000-000000000980'),
  'tentativa invalida mudou estado da confirmacao'
);

select pg_temp.assert_true(
  public.teacher_turbo_status('00000000-0000-4000-8000-000000000974')->>'status' = 'BUILDING'
  and (public.teacher_turbo_status('00000000-0000-4000-8000-000000000974')->>'suspensions_open')::integer = 0
  and not exists (
    select 1
      from public.teacher_turbo_disputes
     where confirmation_id in (
       '00000000-0000-4000-8000-000000000981',
       '00000000-0000-4000-8000-000000000982'
     )
  ),
  'fixtures ainda pendentes abriram suspensao ou disputa preventiva'
);

update public.attendance_confirmations
   set student_response = 'STUDENT_PRESENT', responded_at = now()
 where id = '00000000-0000-4000-8000-000000000981';

select pg_temp.assert_true(
  not exists (
    select 1
      from public.teacher_turbo_disputes
     where confirmation_id = '00000000-0000-4000-8000-000000000981'
  )
  and not exists (
    select 1
      from public.teacher_turbo_events
     where source_type = 'attendance_confirmation'
       and source_id = '00000000-0000-4000-8000-000000000981'
  )
  and (public.teacher_turbo_status('00000000-0000-4000-8000-000000000974')->>'suspensions_open')::integer = 0,
  'corrigir relato ainda pendente materializou disputa ou penalidade'
);

update public.attendance_confirmations
   set status = 'CANCELLED', resolved_at = now(), admin_resolution = 'Confirmacao cancelada'
 where id = '00000000-0000-4000-8000-000000000982';

select pg_temp.assert_true(
  (select status = 'DISMISSED' and verdict = 'CANCELLED'
     from public.teacher_turbo_disputes
    where confirmation_id = '00000000-0000-4000-8000-000000000982')
  and public.teacher_turbo_status('00000000-0000-4000-8000-000000000974')->>'status' = 'BUILDING'
  and (public.teacher_turbo_status('00000000-0000-4000-8000-000000000974')->>'suspensions_open')::integer = 0,
  'cancelar confirmacao deixou Turbo suspenso'
);

select pg_temp.assert_true(
  (select count(*) = 1
     from public.teacher_turbo_events
    where event_type = 'DISPUTE_DISMISSED'
      and source_id in (
        '00000000-0000-4000-8000-000000000981',
        '00000000-0000-4000-8000-000000000982'
      ))
  and not exists (
    select 1
      from public.teacher_turbo_events
     where source_id = '00000000-0000-4000-8000-000000000981'
  ),
  'cancelamento final nao ficou auditavel uma vez ou correcao pendente criou evento'
);

-- Corrigir a data de uma fonte atualiza o mesmo evento, em vez de manter a data
-- antiga ou duplicar a falta. Vale tanto para class_log direto quanto para uma
-- falta de confirmacao ja resolvida.
update public.class_logs
   set class_date = public.teacher_turbo_business_date() - 1,
       date = public.teacher_turbo_business_date() - 1
 where id = '00000000-0000-4000-8000-000000000975';

select pg_temp.assert_true(
  (select count(*) = 1
          and min(effective_on) = public.teacher_turbo_business_date() - 1
     from public.teacher_turbo_events
    where event_type = 'ABSENCE_RECORDED'
      and source_type = 'class_log'
      and source_id = '00000000-0000-4000-8000-000000000975'),
  'correcao de class_date manteve evento antigo ou duplicou a falta'
);

update public.attendance_confirmations
   set class_date = public.teacher_turbo_business_date() - 2
 where id = '00000000-0000-4000-8000-00000000097f';

select pg_temp.assert_true(
  (select count(*) = 1
          and min(effective_on) = public.teacher_turbo_business_date() - 2
     from public.teacher_turbo_events
    where event_type = 'ABSENCE_CONFIRMED'
      and source_type = 'attendance_confirmation'
      and source_id = '00000000-0000-4000-8000-00000000097f'),
  'correcao de confirmacao resolvida nao atualizou o evento canonico'
);

-- O mesmo mecanismo corrige tenant/data/metadata de uma fonte identificada.
select public.teacher_turbo_add_event(
  '00000000-0000-4000-8000-000000000973',
  'turbo-streak-school-b', 'DISPUTE_REPORTED',
  public.teacher_turbo_business_date() - 3,
  'attendance_confirmation', '00000000-0000-4000-8000-000000000985',
  null, '{"revision":1}'::jsonb
);

select public.teacher_turbo_add_event(
  '00000000-0000-4000-8000-000000000973',
  'turbo-streak-school-a', 'DISPUTE_REPORTED',
  public.teacher_turbo_business_date() - 2,
  'attendance_confirmation', '00000000-0000-4000-8000-000000000985',
  null, '{"revision":2}'::jsonb
);

select pg_temp.assert_true(
  (select count(*) = 1
          and min(tenant_id) = 'turbo-streak-school-a'
          and min(effective_on) = public.teacher_turbo_business_date() - 2
          and min((metadata->>'revision')::integer) = 2
     from public.teacher_turbo_events
    where teacher_id = '00000000-0000-4000-8000-000000000973'
      and event_type = 'DISPUTE_REPORTED'
      and source_id = '00000000-0000-4000-8000-000000000985'),
  'upsert de evento nao refletiu correcao de tenant/data/metadata'
);

-- Confirmacoes corrompidas sao inertes: nem um teacher_id de outro tenant nem
-- um class_log de outra aula/escola pode abrir suspensao, resetar ou ser decidido.
insert into public.attendance_confirmations (
  id, tenant_id, teacher_id, student_id, student_name,
  class_date, class_time, teacher_name, token,
  student_response, responded_at, status, source_id, source_type, class_log_id
)
values
  (
    '00000000-0000-4000-8000-000000000983', 'turbo-streak-school-a',
    '00000000-0000-4000-8000-000000000974', md5('turbo-streak-student-a-4')::uuid,
    'Aluno Turbo A 4', public.teacher_turbo_business_date(), '10:00',
    'Professor Turbo B', 'turbo-streak-corrupt-teacher-tenant',
    'TEACHER_NO_SHOW', now(), 'AWAITING_TEACHER',
    (md5('turbo-streak-booking-a-4')::uuid)::text, 'booking', null
  ),
  (
    '00000000-0000-4000-8000-000000000984', 'turbo-streak-school-b',
    '00000000-0000-4000-8000-000000000974', md5('turbo-streak-student-b-1')::uuid,
    'Aluno Turbo B 1', public.teacher_turbo_business_date(), '10:00',
    'Professor Turbo B', 'turbo-streak-corrupt-class-log',
    'TEACHER_NO_SHOW', now(), 'AWAITING_TEACHER',
    (md5('turbo-streak-booking-b-1')::uuid)::text, 'booking',
    '00000000-0000-4000-8000-00000000097b'
  );

select pg_temp.assert_true(
  not exists (
    select 1 from public.teacher_turbo_disputes
     where confirmation_id in (
       '00000000-0000-4000-8000-000000000983',
       '00000000-0000-4000-8000-000000000984'
     )
  )
  and not exists (
    select 1 from public.teacher_turbo_events
     where source_id in (
       '00000000-0000-4000-8000-000000000983',
       '00000000-0000-4000-8000-000000000984'
     )
  ),
  'confirmacao corrompida alterou disputa/eventos do Turbo'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000971","role":"authenticated"}';

select pg_temp.assert_true(
  public.resolve_attendance_conflict_v2(
    '00000000-0000-4000-8000-000000000983', 'TEACHER_ABSENT', 'Dados cruzados'
  )->>'error' = 'dados_inconsistentes',
  'diretora decidiu confirmacao cujo professor pertence a outro tenant'
);

reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000972","role":"authenticated"}';

select pg_temp.assert_true(
  public.resolve_attendance_conflict_v2(
    '00000000-0000-4000-8000-000000000984', 'TEACHER_ABSENT', 'Class log cruzado'
  )->>'error' = 'dados_inconsistentes',
  'diretora decidiu confirmacao vinculada a class_log de outra aula'
);

reset role;

select pg_temp.assert_true(
  (select status = 'AWAITING_TEACHER'
     from public.attendance_confirmations
    where id = '00000000-0000-4000-8000-000000000983')
  and (select status = 'AWAITING_TEACHER'
         from public.attendance_confirmations
        where id = '00000000-0000-4000-8000-000000000984'),
  'rejeicao por dados inconsistentes alterou as confirmacoes'
);

-- Um relato ainda pendente da escola antiga continua na confirmacao de origem,
-- sem virar disputa ou suspensao. A transferencia mono-tenant abre ciclo novo
-- sem carregar ofensiva ou falta da escola anterior.
insert into public.attendance_confirmations (
  id, tenant_id, teacher_id, student_id, student_name,
  class_date, class_time, teacher_name, token,
  student_response, responded_at, status, source_id, source_type
)
values (
  '00000000-0000-4000-8000-000000000986', 'turbo-streak-school-b',
  '00000000-0000-4000-8000-000000000974', md5('turbo-streak-student-b-8')::uuid,
  'Aluno Turbo B 8', public.teacher_turbo_business_date(), '10:00',
  'Professor Turbo B', 'turbo-streak-before-tenant-transfer',
  'TEACHER_NO_SHOW', now(), 'AWAITING_TEACHER',
  (md5('turbo-streak-booking-b-8')::uuid)::text, 'booking'
);

select pg_temp.assert_true(
  (public.teacher_turbo_status('00000000-0000-4000-8000-000000000974')->>'suspensions_open')::integer = 0
  and not exists (
    select 1
      from public.teacher_turbo_disputes
     where confirmation_id = '00000000-0000-4000-8000-000000000986'
  )
  and not exists (
    select 1
      from public.teacher_turbo_events
     where source_type = 'attendance_confirmation'
       and source_id = '00000000-0000-4000-8000-000000000986'
  ),
  'relato pendente anterior a transferencia abriu disputa ou suspensao'
);

update public.profiles
   set tenant_id = 'turbo-streak-school-a'
 where id = '00000000-0000-4000-8000-000000000974';

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000971","role":"authenticated"}';

select pg_temp.assert_true(
  (select tenant_id = 'turbo-streak-school-a'
          and initial_anchor_on = public.teacher_turbo_business_date()
          and streak_anchor_on = public.teacher_turbo_business_date()
          and students_active = 0
          and students_eligible_since is null
          and last_confirmed_absence_on is null
     from public.teacher_turbo_state
    where teacher_id = '00000000-0000-4000-8000-000000000974')
  and (public.teacher_turbo_status('00000000-0000-4000-8000-000000000974')->>'suspensions_open')::integer = 0
  and public.teacher_turbo_status('00000000-0000-4000-8000-000000000974')->>'last_absence' is null
  and public.teacher_turbo_status('00000000-0000-4000-8000-000000000974')->>'status' = 'INELIGIBLE_STUDENTS',
  'transferencia entre escolas carregou ofensiva/falta/suspensao antiga'
);

set local role postgres;
select pg_temp.assert_true(
  (select count(*) = 1
          and min(tenant_id) = 'turbo-streak-school-a'
          and min(effective_on) = public.teacher_turbo_business_date()
     from public.teacher_turbo_events
    where teacher_id = '00000000-0000-4000-8000-000000000974'
      and event_type = 'STREAK_INITIALIZED'
      and source_type = 'tenant_transfer')
  and not exists (
    select 1
      from public.teacher_turbo_disputes
     where confirmation_id = '00000000-0000-4000-8000-000000000986'
  )
  and (select status = 'AWAITING_TEACHER' and tenant_id = 'turbo-streak-school-b'
         from public.attendance_confirmations
        where id = '00000000-0000-4000-8000-000000000986'),
  'transferencia nao registrou novo ciclo ou materializou relato pendente antigo'
);

-- Os tres gatilhos que podem tocar mais de um professor declaram a aquisicao
-- dos snapshots em ordem UUID deterministica.
select pg_temp.assert_true(
  position('ORDER BY x.teacher_id' in pg_get_functiondef('public.trg_teacher_turbo_booking()'::regprocedure)) > 0
  and position('ORDER BY affected.teacher_id' in pg_get_functiondef('public.trg_teacher_turbo_profile()'::regprocedure)) > 0
  and position('ORDER BY b.teacher_id' in pg_get_functiondef('public.trg_teacher_turbo_non_billable()'::regprocedure)) > 0,
  'gatilhos multi-professor nao mantiveram ordem de locks deterministica'
);

rollback;
