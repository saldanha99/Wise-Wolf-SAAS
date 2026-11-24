-- Feriado nacional e recesso de fim de ano: escola fechada, aula remunerada
-- (decisão do Vinícius, 24/11/2026).
--
--   1. Nos feriados NACIONAIS (public.national_holidays, calculada pela Páscoa) e
--      nos períodos de RECESSO (public.school_recess_periods, configurável) não
--      há aula para ninguém. Vale só para a escola que adotou a regra
--      (private.school_closure_settings) e só a partir de `effective_from`:
--      feriado que já passou não muda.
--   2. A agenda (public.booking_schedule_on_date) passa a dizer que a aula
--      daquele dia NÃO acontece (`valid = false`, `school_closed`). Tudo o que lê
--      a agenda para (lembrete de 30 min, confirmação/link de auditoria, sala do
--      Meet, pendentes do professor, cobertura, remarcação para o dia). A leitura
--      crua (private.booking_schedule_on_date_raw) é o corpo anterior, intacto.
--   3. Toda aula que ESTAVA na agenda (com aluno) entra sozinha como lançada:
--      presence = 'SCHOOL_HOLIDAY', subtype 'FERIADO' ou 'RECESSO', APPROVED.
--      Conta no pagamento do professor (v_payable_class_logs só tira falta do
--      professor), conta como aula do período para o aluno (sem reposição nem
--      abatimento), não é presença (não é COMPLETED), não aprova resumo, não gera
--      trilha do Wolfie, não é falta (não é STUDENT_ABSENCE: sem reposição nem
--      cobrança de falta). Só o job grava essa marca (gatilho de guarda).
--   4. Relatórios do professor separam a marca: fechamento (`feriados_remunerados`,
--      fora de `faltas_aluno`) e relatório de atividade (`school_closed_paid`).
--
-- Reexecutável. Rollback: seção no CLAUDE.md (24/11/2026, feriados e recesso).

-- ---------------------------------------------------------------------------
-- 1. Quem adota a regra e desde quando
-- ---------------------------------------------------------------------------
create table if not exists private.school_closure_settings (
  tenant_id text primary key references public.tenants(id),
  enabled boolean not null default true,
  effective_from date not null,
  decided_by text not null check (length(btrim(decided_by)) between 8 and 500),
  created_at timestamptz not null default now()
);
alter table private.school_closure_settings owner to postgres;
revoke all on private.school_closure_settings from public, anon, authenticated, service_role;

insert into private.school_closure_settings (tenant_id, enabled, effective_from, decided_by)
select 'school-wise-wolf', true, date '2026-11-24',
       'Vinícius, 24/11/2026: feriado nacional e recesso sem aula, aula da agenda lançada como remunerada; daqui para a frente'
where exists (select 1 from public.tenants where id = 'school-wise-wolf')
on conflict (tenant_id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Recesso configurável (períodos por escola, os dois dias incluídos)
-- ---------------------------------------------------------------------------
create table if not exists public.school_recess_periods (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id),
  starts_on date not null,
  ends_on date not null,
  name text not null check (length(btrim(name)) between 3 and 120),
  decided_by text not null check (length(btrim(decided_by)) between 8 and 500),
  created_at timestamptz not null default now(),
  constraint school_recess_periods_range check (ends_on >= starts_on and ends_on - starts_on <= 45)
);
alter table public.school_recess_periods owner to postgres;
create unique index if not exists school_recess_periods_tenant_start_uq
  on public.school_recess_periods (tenant_id, starts_on);
alter table public.school_recess_periods enable row level security;
revoke all on public.school_recess_periods from public, anon, authenticated, service_role;
grant select on public.school_recess_periods to authenticated, service_role;
drop policy if exists school_recess_periods_read on public.school_recess_periods;
create policy school_recess_periods_read on public.school_recess_periods
  for select to authenticated using (tenant_id = public._my_tenant_id());

-- Período que já começou não muda nem some (o lançamento do dia já existe).
create or replace function private.school_recess_periods_guard()
returns trigger language plpgsql set search_path = '' as $$
declare v_today date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  if tg_op in ('UPDATE', 'DELETE') and old.starts_on <= v_today then
    raise exception using errcode = '23514', message = 'recesso_ja_comecou_nao_muda';
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.starts_on <= v_today then
    raise exception using errcode = '23514', message = 'recesso_so_para_o_futuro';
  end if;
  if tg_op in ('INSERT', 'UPDATE') and exists (
    select 1 from public.school_recess_periods r
     where r.tenant_id = new.tenant_id and r.id <> new.id
       and daterange(r.starts_on, r.ends_on, '[]') && daterange(new.starts_on, new.ends_on, '[]')) then
    raise exception using errcode = '23514', message = 'recesso_sobreposto';
  end if;
  return coalesce(new, old);
end $$;
alter function private.school_recess_periods_guard() owner to postgres;
drop trigger if exists school_recess_periods_guard on public.school_recess_periods;
create trigger school_recess_periods_guard before insert or update or delete on public.school_recess_periods
  for each row execute function private.school_recess_periods_guard();

insert into public.school_recess_periods (tenant_id, starts_on, ends_on, name, decided_by)
select 'school-wise-wolf', date '2026-12-24', date '2027-01-01', 'Recesso de fim de ano',
       'Vinícius, 24/11/2026: recesso de 24/12/2026 a 01/01/2027, os dois dias incluídos'
where exists (select 1 from public.tenants where id = 'school-wise-wolf')
  and (now() at time zone 'America/Sao_Paulo')::date < date '2026-12-24'
on conflict (tenant_id, starts_on) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Dia de escola fechada: feriado nacional vence o recesso no rótulo
-- ---------------------------------------------------------------------------
create or replace function private.school_closed_day(p_tenant text, p_date date)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case
    when p_tenant is null or p_date is null then null
    when not exists (select 1 from private.school_closure_settings s
                      where s.tenant_id = p_tenant and s.enabled and p_date >= s.effective_from) then null
    else coalesce(
      (select jsonb_build_object('kind', 'HOLIDAY', 'name', h.name)
         from public.national_holidays h where h.holiday_date = p_date),
      (select jsonb_build_object('kind', 'RECESS', 'name', r.name)
         from public.school_recess_periods r
        where r.tenant_id = p_tenant and p_date between r.starts_on and r.ends_on
        order by r.starts_on limit 1))
  end;
$$;
alter function private.school_closed_day(text, date) owner to postgres;
revoke all on function private.school_closed_day(text, date) from public, anon;
grant execute on function private.school_closed_day(text, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Agenda: cópia crua do corpo atual + a pública passa a respeitar o fechamento
-- ---------------------------------------------------------------------------
do $copy$
declare d text;
begin
  if to_regprocedure('private.booking_schedule_on_date_raw(uuid,date)') is not null then return; end if;
  select pg_get_functiondef('public.booking_schedule_on_date(uuid,date)'::regprocedure) into d;
  if strpos(d, 'school_closed_day') > 0 then
    raise exception 'booking_schedule_on_date_ja_embrulhada_sem_copia_crua';
  end if;
  if strpos(d, 'CREATE OR REPLACE FUNCTION public.booking_schedule_on_date(') <> 1 then
    raise exception 'unexpected_booking_schedule_on_date_definition';
  end if;
  execute replace(d, 'CREATE OR REPLACE FUNCTION public.booking_schedule_on_date(',
                     'CREATE OR REPLACE FUNCTION private.booking_schedule_on_date_raw(');
end $copy$;
alter function private.booking_schedule_on_date_raw(uuid, date) owner to postgres;
revoke all on function private.booking_schedule_on_date_raw(uuid, date) from public, anon;
grant execute on function private.booking_schedule_on_date_raw(uuid, date) to authenticated, service_role;

create or replace function public.booking_schedule_on_date(p_booking_id uuid, p_date date)
returns jsonb language plpgsql stable set search_path = '' as $$
declare v_slot jsonb; v_tenant text; v_closed jsonb;
begin
  v_slot := private.booking_schedule_on_date_raw(p_booking_id, p_date);
  if not coalesce((v_slot->>'valid')::boolean, false) then return v_slot; end if;
  select b.tenant_id into v_tenant from public.bookings b where b.id = p_booking_id;
  v_closed := private.school_closed_day(v_tenant, p_date);
  if v_closed is null then return v_slot; end if;
  -- Escola fechada: a aula não acontece. Dia e horário continuam no retorno
  -- (quem compara horário de agenda segue funcionando).
  return v_slot || jsonb_build_object('valid', false, 'school_closed', v_closed->>'kind',
                                      'school_closed_name', v_closed->>'name');
end $$;

-- Leitura para o guarda do lançamento: a marca do sistema lê a agenda crua.
create or replace function private.booking_schedule_for_class_log(p_booking_id uuid, p_date date, p_presence text)
returns jsonb language sql stable set search_path = '' as $$
  select case when p_presence = 'SCHOOL_HOLIDAY'
              then private.booking_schedule_on_date_raw(p_booking_id, p_date)
              else public.booking_schedule_on_date(p_booking_id, p_date) end;
$$;
alter function private.booking_schedule_for_class_log(uuid, date, text) owner to postgres;
revoke all on function private.booking_schedule_for_class_log(uuid, date, text) from public, anon;
grant execute on function private.booking_schedule_for_class_log(uuid, date, text) to authenticated, service_role;

-- Remendo por âncora no guarda do lançamento (função longa, recriada por outras migrations).
do $patch$
declare d text; anchor text := 'public.booking_schedule_on_date(b.id, new.class_date)';
begin
  select pg_get_functiondef('public.fill_class_log_occurrence_time()'::regprocedure) into d;
  if strpos(d, 'booking_schedule_for_class_log') > 0 then return; end if;
  if (length(d) - length(replace(d, anchor, ''))) / length(anchor) <> 4 then
    raise exception 'unexpected_fill_class_log_occurrence_time_definition';
  end if;
  execute replace(d, anchor, 'private.booking_schedule_for_class_log(b.id, new.class_date, new.presence)');
end $patch$;

-- Aviso de feriado (D7/D1) continua achando quem tinha aula: lê a agenda crua.
do $patch$
declare d text; anchor text := 'public.booking_schedule_on_date(b.id, p_date)';
begin
  select pg_get_functiondef('private.national_holiday_recipients(text,date)'::regprocedure) into d;
  if strpos(d, 'booking_schedule_on_date_raw') > 0 then return; end if;
  if (length(d) - length(replace(d, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'unexpected_national_holiday_recipients_definition';
  end if;
  execute replace(d, anchor, 'private.booking_schedule_on_date_raw(b.id, p_date)');
end $patch$;

-- ---------------------------------------------------------------------------
-- 5. Só o sistema grava a marca "Feriado/Recesso (remunerada)"
-- ---------------------------------------------------------------------------
create or replace function private.guard_school_closed_class_log()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.presence = 'SCHOOL_HOLIDAY' or (tg_op = 'UPDATE' and old.presence = 'SCHOOL_HOLIDAY'))
     and coalesce(current_setting('wisewolf.school_closure_job', true), '') <> 'on' then
    raise exception using errcode = '42501', message = 'feriado_remunerado_so_pelo_sistema';
  end if;
  if new.presence = 'SCHOOL_HOLIDAY' and (
       new.booking_id is null or new.class_date is null
       or private.school_closed_day(new.tenant_id, new.class_date) is null
       or new.subtype is distinct from case (private.school_closed_day(new.tenant_id, new.class_date)->>'kind')
                                         when 'HOLIDAY' then 'FERIADO' else 'RECESSO' end) then
    raise exception using errcode = '23514', message = 'feriado_remunerado_fora_de_dia_fechado';
  end if;
  return new;
end $$;
alter function private.guard_school_closed_class_log() owner to postgres;
drop trigger if exists trg_a_guard_school_closed_class_log on public.class_logs;
create trigger trg_a_guard_school_closed_class_log before insert or update on public.class_logs
  for each row execute function private.guard_school_closed_class_log();

-- ---------------------------------------------------------------------------
-- 6. Lançamento automático (job de hora em hora; idempotente por agendamento × dia)
-- ---------------------------------------------------------------------------
create or replace function private.log_school_closed_classes(p_tenant text default null, p_until timestamptz default now())
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_today date := (p_until at time zone 'America/Sao_Paulo')::date;
  s record; d date; v_closed jsonb; b record; v_slot jsonb; v_time time; v_teacher uuid;
  v_kind text; v_label text; v_count int := 0; v_rows int;
begin
  perform set_config('wisewolf.school_closure_job', 'on', true);
  perform set_config('app.lesson_history_reason', 'Escola fechada (feriado nacional/recesso): aula da agenda lançada como remunerada pelo sistema', true);
  for s in select * from private.school_closure_settings x
            where x.enabled and (p_tenant is null or x.tenant_id = p_tenant) loop
    for d in select g::date from generate_series(greatest(s.effective_from, v_today - 7), v_today, interval '1 day') g loop
      v_closed := private.school_closed_day(s.tenant_id, d);
      continue when v_closed is null;
      v_kind := case v_closed->>'kind' when 'HOLIDAY' then 'FERIADO' else 'RECESSO' end;
      v_label := case v_kind when 'FERIADO' then 'Feriado (remunerada)' else 'Recesso (remunerada)' end;
      for b in select bk.id, bk.teacher_id, bk.student_id from public.bookings bk
                where bk.tenant_id = s.tenant_id and upper(coalesce(bk.status, '')) = 'SCHEDULED'
                  and bk.student_id is not null loop
        begin
          v_slot := private.booking_schedule_on_date_raw(b.id, d);
          continue when not coalesce((v_slot->>'valid')::boolean, false);
          continue when coalesce(btrim(v_slot->>'time_slot'), '') !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]';
          v_time := left(btrim(v_slot->>'time_slot'), 5)::time;
          -- Mesma regra do guarda: só depois do fim previsto da aula.
          continue when ((d + v_time) at time zone 'America/Sao_Paulo') + interval '30 minutes' > p_until;
          continue when exists (select 1 from public.class_logs cl
                                 where cl.booking_id = b.id::text and cl.class_date = d);
          select coalesce((select c.cover_teacher_id from public.class_coverages c
                            where c.booking_id = b.id and c.tenant_id = s.tenant_id and c.class_date = d
                              and c.status = 'confirmed' and c.cover_teacher_id is not null
                            order by c.created_at desc limit 1), b.teacher_id)
            into v_teacher;
          insert into public.class_logs (tenant_id, teacher_id, student_id, date, class_date, start_time,
              presence, subtype, approval_status, verification_status, booking_id, content, notes)
          values (s.tenant_id, v_teacher, b.student_id, d, d, v_time,
              'SCHOOL_HOLIDAY', v_kind, 'APPROVED', 'SCHOOL_CLOSED', b.id::text,
              v_label || ' — ' || (v_closed->>'name'),
              'Sem aula: escola fechada. Lançada pelo sistema; conta no pagamento do professor e como aula do período, sem reposição.')
          on conflict do nothing;
          get diagnostics v_rows = row_count;
          v_count := v_count + v_rows;
        exception when others then
          raise warning '[escola fechada] % % agendamento %: % (%)', s.tenant_id, d, b.id, sqlerrm, sqlstate;
        end;
      end loop;
    end loop;
  end loop;
  -- A marca só vale dentro do job: o resto da transação volta a ser barrado.
  perform set_config('wisewolf.school_closure_job', '', true);
  return v_count;
end $$;
alter function private.log_school_closed_classes(text, timestamptz) owner to postgres;
revoke all on function private.log_school_closed_classes(text, timestamptz) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Relatórios do professor: a marca fica separada
-- ---------------------------------------------------------------------------
do $patch$
declare d text;
  a1 text := 'count(*) FILTER (WHERE pg.presence <> ''COMPLETED'') AS faltas_aluno,';
  a2 text := '''faltas_aluno'', l.faltas_aluno,';
begin
  select pg_get_functiondef('public.get_teacher_closing_report_unchecked'::regproc) into d;
  if strpos(d, 'feriados_remunerados') > 0 then return; end if;
  if (length(d) - length(replace(d, a1, ''))) / length(a1) <> 1
     or (length(d) - length(replace(d, a2, ''))) / length(a2) <> 1 then
    raise exception 'unexpected_get_teacher_closing_report_unchecked_definition';
  end if;
  d := replace(d, a1, 'count(*) FILTER (WHERE pg.presence NOT IN (''COMPLETED'', ''SCHOOL_HOLIDAY'')) AS faltas_aluno,
      count(*) FILTER (WHERE pg.presence = ''SCHOOL_HOLIDAY'') AS feriados_remunerados,');
  d := replace(d, a2, '''faltas_aluno'', l.faltas_aluno,
      ''feriados_remunerados'', l.feriados_remunerados,');
  execute d;
end $patch$;

do $patch$
declare d text; a1 text := '''student_absences'', count(*) FILTER (WHERE lesson.presence = ''STUDENT_ABSENCE''),';
begin
  select pg_get_functiondef('public.get_teacher_activity_report'::regproc) into d;
  if strpos(d, 'school_closed_paid') > 0 then return; end if;
  if (length(d) - length(replace(d, a1, ''))) / length(a1) <> 1 then
    raise exception 'unexpected_get_teacher_activity_report_definition';
  end if;
  execute replace(d, a1, a1 || '
        ''school_closed_paid'', count(*) FILTER (WHERE lesson.presence = ''SCHOOL_HOLIDAY''),');
end $patch$;

-- Histórico operacional: a marca cai em "Feriados" (não em "não finalizados").
do $patch$
declare d text; a1 text := 'when l.presence=''TEACHER_ABSENCE'' then ''TEACHER_ABSENCE''';
begin
  select pg_get_functiondef('private.lesson_history_rows'::regproc) into d;
  if strpos(d, 'SCHOOL_HOLIDAY') > 0 then return; end if;
  if (length(d) - length(replace(d, a1, ''))) / length(a1) <> 1 then
    raise exception 'unexpected_lesson_history_rows_definition';
  end if;
  execute replace(d, a1, a1 || ' when l.presence=''SCHOOL_HOLIDAY'' then ''HOLIDAY''');
end $patch$;

-- ---------------------------------------------------------------------------
-- 8. Leitura para a tela (dia fechado da escola de quem consulta)
-- ---------------------------------------------------------------------------
create or replace function public.my_school_closed_day(p_date date)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when auth.uid() is null then null
              else private.school_closed_day(public._my_tenant_id(), p_date) end;
$$;
alter function public.my_school_closed_day(date) owner to postgres;
revoke all on function public.my_school_closed_day(date) from public, anon, service_role;
grant execute on function public.my_school_closed_day(date) to authenticated;

select cron.schedule('wisewolf-school-closed-classes', '20 * * * *', 'select private.log_school_closed_classes();');

-- ---------------------------------------------------------------------------
-- 9. Contrato do aluno v3: cláusula dos feriados e do recesso (só contratos NOVOS)
-- ---------------------------------------------------------------------------
-- Quem já assinou continua com a versão gravada no aceite (o texto não muda nem
-- é reassinado). A Wise Wolf passa a oferecer a v3 a matrículas e rematrículas
-- feitas pela página de matrícula. Publicar DEPOIS do front que conhece a v3.
insert into public.contract_terms_versions (contract_kind, version, includes_lesson_recording, description)
values ('STUDENT', 3, true, 'Inclui a Cláusula 9 — Dos Feriados e do Recesso (aulas desses dias são parte regular do período, sem reposição nem abatimento); o Foro passa a ser a Cláusula 10.')
on conflict (contract_kind, version) do nothing;

update public.tenant_contract_terms
   set terms_version = 3, decided_at = now(),
       note = 'Vinícius, 24/11/2026: contratos novos com a cláusula de feriados nacionais e recesso (v3).'
 where tenant_id = 'school-wise-wolf' and contract_kind = 'STUDENT' and terms_version = 2;
