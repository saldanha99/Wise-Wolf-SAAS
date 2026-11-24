-- Feriado nacional (25/12/2026) e recesso (24/12/2026 a 01/01/2027) na Wise Wolf.
-- Roda numa transação com ROLLBACK, depois da migration 20261124120000.
-- Simula o tempo pelo parâmetro p_until do job; o guarda "aula ainda não terminou"
-- (que lê now()) é desligado SÓ dentro desta transação.
\set ON_ERROR_STOP on
\pset footer off

create temp table ff_before as
select (select count(*) from public.notification_queue) nq,
       (select count(*) from public.reschedules) rs,
       (select count(*) from public.attendance_confirmations) ac,
       (select count(*) from public.wolfie_lesson_tracks) wt;

do $t$
declare v_b uuid; v jsonb; v_raw jsonb; v_other uuid;
begin
  -- Agenda do dia 25/12: a aula não acontece; a leitura crua ainda a vê.
  select b.id into v_b from public.bookings b
   where b.tenant_id = 'school-wise-wolf' and b.status = 'SCHEDULED' and b.student_id is not null
     and (private.booking_schedule_on_date_raw(b.id, date '2026-12-25')->>'valid')::boolean limit 1;
  if v_b is null then raise exception 'fixture: nenhuma aula da Wise Wolf em 25/12'; end if;
  v := public.booking_schedule_on_date(v_b, date '2026-12-25');
  v_raw := private.booking_schedule_on_date_raw(v_b, date '2026-12-25');
  if (v->>'valid')::boolean or v->>'school_closed' <> 'HOLIDAY' or not (v_raw->>'valid')::boolean
     or v->>'time_slot' is distinct from v_raw->>'time_slot' then
    raise exception 'agenda de 25/12 errada: % / %', v, v_raw;
  end if;
  -- Feriado que já passou não muda (20/11/2026, antes de effective_from).
  select b.id into v_b from public.bookings b
   where b.tenant_id = 'school-wise-wolf' and b.status = 'SCHEDULED' and b.student_id is not null
     and (private.booking_schedule_on_date_raw(b.id, date '2026-11-20')->>'valid')::boolean limit 1;
  if v_b is not null and public.booking_schedule_on_date(v_b, date '2026-11-20')
       is distinct from private.booking_schedule_on_date_raw(v_b, date '2026-11-20') then
    raise exception 'feriado passado (20/11) mudou';
  end if;
  -- Outra escola não muda.
  select b.id into v_other from public.bookings b
   where b.tenant_id <> 'school-wise-wolf' and b.status = 'SCHEDULED'
     and (private.booking_schedule_on_date_raw(b.id, date '2026-12-25')->>'valid')::boolean limit 1;
  if v_other is not null and not (public.booking_schedule_on_date(v_other, date '2026-12-25')->>'valid')::boolean then
    raise exception 'outra escola perdeu a aula de 25/12';
  end if;
  -- Aviso de feriado (D7/D1) continua achando quem tinha aula.
  if (select count(*) from private.national_holiday_recipients('school-wise-wolf', date '2026-12-25')) = 0 then
    raise exception 'aviso de feriado perdeu os destinatários';
  end if;
  -- Recesso: 28/12 fechado; 02/01 volta ao normal.
  if private.school_closed_day('school-wise-wolf', date '2026-12-28')->>'kind' <> 'RECESS'
     or private.school_closed_day('school-wise-wolf', date '2026-12-24')->>'kind' <> 'RECESS'
     or private.school_closed_day('school-wise-wolf', date '2027-01-01')->>'kind' <> 'HOLIDAY'
     or private.school_closed_day('school-wise-wolf', date '2027-01-02') is not null
     or private.school_closed_day('school-wise-wolf', date '2026-12-23') is not null then
    raise exception 'calendário do recesso errado';
  end if;
end $t$;

-- Contrato: um aluno de contrato antigo (v2 gravada ou sem versão) e um de contrato novo (v3).
create temp table ff_students as
with dec25 as (
  select distinct b.student_id from public.bookings b
   where b.tenant_id = 'school-wise-wolf' and b.status = 'SCHEDULED' and b.student_id is not null
     and (private.booking_schedule_on_date_raw(b.id, date '2026-12-25')->>'valid')::boolean)
select student_id, row_number() over (order by student_id) n from dec25 limit 2;

insert into public.contract_terms_acceptances (tenant_id, user_id, contract_kind, terms_version, source, source_id, accepted_at)
select 'school-wise-wolf', s.student_id, 'STUDENT', 3, 'ENROLLMENT_OFFER', gen_random_uuid(), now()
  from ff_students s where s.n = 2;

-- Simula o tempo: depois de 25/12 e depois de 01/01.
alter table public.class_logs disable trigger trg_zy_require_finished_lesson_slot;
select 'lancadas_ate_26_12' etapa, private.log_school_closed_classes('school-wise-wolf', timestamptz '2026-12-26 12:00-03') n;
select 'lancadas_ate_02_01' etapa, private.log_school_closed_classes('school-wise-wolf', timestamptz '2027-01-02 12:00-03') n;
select 'rodada_repetida' etapa, private.log_school_closed_classes('school-wise-wolf', timestamptz '2027-01-02 12:00-03') n;
alter table public.class_logs enable trigger trg_zy_require_finished_lesson_slot;

-- Por dia: aulas que estavam na agenda × lançadas.
select d::date dia, cl.subtype, count(cl.id) lancadas,
       (select count(*) from public.bookings b where b.tenant_id = 'school-wise-wolf' and b.status = 'SCHEDULED'
          and b.student_id is not null and (private.booking_schedule_on_date_raw(b.id, d::date)->>'valid')::boolean) agenda
  from generate_series(date '2026-12-23', date '2027-01-02', interval '1 day') d
  left join public.class_logs cl on cl.class_date = d::date and cl.tenant_id = 'school-wise-wolf' and cl.presence = 'SCHOOL_HOLIDAY'
 group by d, cl.subtype order by d;

-- Os dois alunos de 25/12: contrato antigo e novo, a aula conta nos dois casos.
select s.n, case s.n when 1 then 'contrato antigo' else 'contrato novo (v3)' end contrato,
       (select max(a.terms_version) from public.contract_terms_acceptances a where a.user_id = s.student_id and a.contract_kind = 'STUDENT') versao,
       cl.class_date, cl.presence, cl.subtype, cl.approval_status, cl.content,
       exists (select 1 from public.v_payable_class_logs v where v.id = cl.id) paga_ao_professor
  from ff_students s join public.class_logs cl on cl.student_id = s.student_id and cl.class_date = date '2026-12-25'
   and cl.presence = 'SCHOOL_HOLIDAY' order by s.n;

-- Professor com aula e sem aula em 25/12.
with t as (
  select p.id, p.full_name,
         (select count(*) from public.bookings b where b.teacher_id = p.id and b.status = 'SCHEDULED' and b.student_id is not null
            and (private.booking_schedule_on_date_raw(b.id, date '2026-12-25')->>'valid')::boolean) agenda_25
    from public.profiles p where p.tenant_id = 'school-wise-wolf' and p.role = 'TEACHER'
     and exists (select 1 from public.bookings b where b.teacher_id = p.id and b.status = 'SCHEDULED'))
select case when agenda_25 > 0 then 'com aula em 25/12' else 'sem aula em 25/12' end caso, left(full_name, 1) || '.' professor, agenda_25,
       (select count(*) from public.class_logs cl where cl.teacher_id = t.id and cl.class_date = date '2026-12-25') lancadas_25,
       (select count(*) from public.v_payable_class_logs v where v.teacher_id = t.id and v.class_date = date '2026-12-25') pagas_25,
       (select coalesce(sum(v.rate_efetivo), 0) from public.v_payable_class_logs v where v.teacher_id = t.id
          and v.presence = 'SCHOOL_HOLIDAY' and v.class_date between date '2026-12-24' and date '2027-01-01') valor_fechado_rs
  from t order by agenda_25 desc, full_name limit 1;
-- Professor sem aula na agenda num dia de recesso (30/12): nada é lançado para ele.
select 'sem aula em 30/12' caso, left(p.full_name, 1) || '.' professor,
       (select count(*) from public.class_logs cl where cl.teacher_id = p.id and cl.class_date = date '2026-12-30') lancadas_30
  from public.profiles p where p.tenant_id = 'school-wise-wolf' and p.role = 'TEACHER'
   and exists (select 1 from public.bookings b where b.teacher_id = p.id and b.status = 'SCHEDULED' and b.student_id is not null)
   and not exists (select 1 from public.bookings b where b.teacher_id = p.id and b.status = 'SCHEDULED' and b.student_id is not null
                    and (private.booking_schedule_on_date_raw(b.id, date '2026-12-30')->>'valid')::boolean)
 limit 1;

-- Fechamento de dezembro do professor com mais aulas no recesso: feriado separado da falta.
with t as (select cl.teacher_id from public.class_logs cl where cl.presence = 'SCHOOL_HOLIDAY' and cl.class_date between date '2026-12-01' and date '2026-12-31'
            group by 1 order by count(*) desc limit 1)
select 'fechamento_2026_12' item, l->>'student' aluno, l->>'aulas' aulas, l->>'faltas_aluno' faltas_aluno, l->>'feriados_remunerados' feriados_remunerados, l->>'valor' valor
  from t, jsonb_array_elements(public.get_teacher_closing_report_unchecked(t.teacher_id, '2026-12')->'students') l limit 3;

do $t$
declare v_b record; v_err text;
begin
  -- Ninguém grava a marca à mão.
  select b.id, b.teacher_id, b.student_id into v_b from public.bookings b
   where b.tenant_id = 'school-wise-wolf' and b.status = 'SCHEDULED' and b.student_id is not null
     and (private.booking_schedule_on_date_raw(b.id, date '2026-12-23')->>'valid')::boolean limit 1;
  begin
    insert into public.class_logs (tenant_id, teacher_id, student_id, date, class_date, presence, subtype, approval_status, booking_id)
    values ('school-wise-wolf', v_b.teacher_id, v_b.student_id, date '2026-12-23', date '2026-12-23', 'SCHOOL_HOLIDAY', 'FERIADO', 'APPROVED', v_b.id::text);
    raise exception 'guarda falhou: marca gravada à mão';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err <> 'feriado_remunerado_so_pelo_sistema' then raise; end if;
  end;
  -- Aula normal lançada à mão num dia fechado é recusada (a agenda diz que não houve aula).
  select b.id, b.teacher_id, b.student_id into v_b from public.bookings b
   where b.tenant_id = 'school-wise-wolf' and b.status = 'SCHEDULED' and b.student_id is not null
     and (private.booking_schedule_on_date_raw(b.id, date '2026-12-30')->>'valid')::boolean limit 1;
  delete from public.class_logs where booking_id = v_b.id::text and class_date = date '2026-12-30';
  begin
    insert into public.class_logs (tenant_id, teacher_id, student_id, date, class_date, presence, approval_status, booking_id, start_time)
    values ('school-wise-wolf', v_b.teacher_id, v_b.student_id, date '2026-12-30', date '2026-12-30', 'COMPLETED', 'APPROVED', v_b.id::text, '10:00');
    raise exception 'aula normal entrou em dia de recesso';
  exception when others then
    get stacked diagnostics v_err = message_text;
    if v_err not in ('class_log_booking_origin_invalid', 'class_log_occurrence_time_mismatch', 'aula_ainda_nao_terminou') then raise; end if;
  end;
end $t$;

-- Nada saiu para aluno ou professor; nenhuma reposição, confirmação ou trilha do Wolfie.
select 'efeitos' item,
       (select count(*) from public.notification_queue) - b.nq fila_whatsapp,
       (select count(*) from public.reschedules) - b.rs reposicoes,
       (select count(*) from public.attendance_confirmations) - b.ac confirmacoes,
       (select count(*) from public.wolfie_lesson_tracks) - b.wt trilhas_wolfie
  from ff_before b;
