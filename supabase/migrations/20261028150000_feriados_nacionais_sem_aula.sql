-- Feriado NACIONAL não tem aula (regra da escola; ponto facultativo — Carnaval,
-- Corpus Christi, Dia do Servidor, vésperas — tem aula normal). Esta migration:
--   1. calendário de feriados nacionais calculado por ano (fixos + Paixão de Cristo);
--   2. aviso por WhatsApp a alunos e professores que têm aula no dia, 7 dias antes
--      e 1 dia antes, pela fila oficial (instância central, cerca de sempre);
--   3. o lembrete de 30 min e a confirmação de presença não saem para aula da
--      agenda fixa em feriado (a reposição/experimental marcada nesse dia foi
--      escolha explícita e segue igual);
--   4. leitura para o pop-up da plataforma.
-- Reexecutável: o release ensaia duas vezes antes de valer.

create table if not exists public.national_holidays (
  holiday_date date primary key,
  name text not null check (length(btrim(name)) between 3 and 120),
  created_at timestamptz not null default now()
);
alter table public.national_holidays enable row level security;
revoke all on public.national_holidays from public, anon, authenticated, service_role;
grant select on public.national_holidays to authenticated, service_role;
drop policy if exists national_holidays_read on public.national_holidays;
create policy national_holidays_read on public.national_holidays for select to authenticated using (true);

-- Lei 662/1949, Lei 6.802/1980, Lei 14.759/2023 e a Paixão de Cristo, que o
-- calendário federal (Portaria MGI) lista como feriado nacional todo ano.
create or replace function private.brazil_national_holidays_for(p_year integer)
returns table (holiday_date date, name text)
language plpgsql immutable set search_path = '' as $$
declare a int; b int; c int; d int; e int; f int; g int; h int; i int; k int; l int; m int; v_month int; v_day int; v_easter date;
begin
  -- Páscoa pelo algoritmo gregoriano anônimo (Meeus/Jones/Butcher).
  a := p_year % 19; b := p_year / 100; c := p_year % 100; d := b / 4; e := b % 4;
  f := (b + 8) / 25; g := (b - f + 1) / 3; h := (19 * a + b - d - g + 15) % 30;
  i := c / 4; k := c % 4; l := (32 + 2 * e + 2 * i - h - k) % 7; m := (a + 11 * h + 22 * l) / 451;
  v_month := (h + l - 7 * m + 114) / 31; v_day := ((h + l - 7 * m + 114) % 31) + 1;
  v_easter := pg_catalog.make_date(p_year, v_month, v_day);
  return query values
    (pg_catalog.make_date(p_year, 1, 1), 'Confraternização Universal'),
    (v_easter - 2, 'Paixão de Cristo'),
    (pg_catalog.make_date(p_year, 4, 21), 'Tiradentes'),
    (pg_catalog.make_date(p_year, 5, 1), 'Dia Mundial do Trabalho'),
    (pg_catalog.make_date(p_year, 9, 7), 'Independência do Brasil'),
    (pg_catalog.make_date(p_year, 10, 12), 'Nossa Senhora Aparecida'),
    (pg_catalog.make_date(p_year, 11, 2), 'Finados'),
    (pg_catalog.make_date(p_year, 11, 15), 'Proclamação da República'),
    (pg_catalog.make_date(p_year, 11, 20), 'Dia Nacional de Zumbi e da Consciência Negra'),
    (pg_catalog.make_date(p_year, 12, 25), 'Natal');
end $$;

-- Ano corrente e seguinte sempre no calendário (o job diário chama de novo).
-- Data mexida à mão na tabela não é sobrescrita.
create or replace function private.ensure_national_holidays()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_year int := extract(year from (now() at time zone 'America/Sao_Paulo'))::int; v_count int;
begin
  insert into public.national_holidays (holiday_date, name)
  select h.holiday_date, h.name from private.brazil_national_holidays_for(v_year) h
  union all
  select h.holiday_date, h.name from private.brazil_national_holidays_for(v_year + 1) h
  on conflict (holiday_date) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
select private.ensure_national_holidays();

-- Quais escolas avisam. Nasce só com a Wise Wolf (decisão da direção, 28/10/2026);
-- desligar é enabled = false, não apagar a linha.
create table if not exists private.national_holiday_notice_settings (
  tenant_id text primary key references public.tenants(id),
  enabled boolean not null default true,
  decided_by text not null,
  created_at timestamptz not null default now()
);
revoke all on private.national_holiday_notice_settings from public, anon, authenticated, service_role;
insert into private.national_holiday_notice_settings (tenant_id, enabled, decided_by)
select 'school-wise-wolf', true, 'Direção, 28/10/2026: feriado nacional sem aula, aviso 7 dias e 1 dia antes'
where exists (select 1 from public.tenants where id = 'school-wise-wolf')
on conflict (tenant_id) do nothing;

-- Quem tem aula da agenda fixa no dia (a régua da agenda vigente, com versões,
-- remarcações e exclusões). Aluno só se notificável; professor só se elegível.
create or replace function private.national_holiday_recipients(p_tenant text, p_date date)
returns table (person_id uuid, person_kind text, full_name text, phone text, teacher_id uuid)
language sql stable security definer set search_path = '' as $$
  with occ as (
    select b.student_id, b.teacher_id
    from public.bookings b
    where b.tenant_id = p_tenant and upper(coalesce(b.status, '')) = 'SCHEDULED'
      and coalesce((public.booking_schedule_on_date(b.id, p_date)->>'valid')::boolean, false)
  ), students as (
    select distinct on (p.id) p.id, 'STUDENT'::text kind, p.full_name,
      private.whatsapp_digits(coalesce(nullif(p.attendance_phone, ''), nullif(p.phone, ''), nullif(p.guardian_phone, ''))) phone,
      o.teacher_id
    from occ o join public.profiles p on p.id = o.student_id
    where p.tenant_id = p_tenant and coalesce(public.is_student_notifiable(p.id), false)
    order by p.id, o.teacher_id
  ), teachers as (
    select distinct p.id, 'TEACHER'::text kind, p.full_name, private.whatsapp_digits(nullif(p.phone, '')) phone, p.id teacher_id
    from occ o join public.profiles p on p.id = o.teacher_id
    where p.tenant_id = p_tenant and coalesce(public.teacher_opportunity_recipient_eligible(p_tenant, p.id), false)
  )
  select id, kind, full_name, phone, teacher_id from students where phone is not null
  union all
  select id, kind, full_name, phone, teacher_id from teachers where phone is not null;
$$;

create or replace function private.national_holiday_message(p_kind text, p_stage text, p_name text, p_holiday text, p_date date)
returns text language sql immutable set search_path = '' as $$
  select format(
    case
      when p_kind = 'STUDENT' and p_stage = 'D7' then
        E'Oi, %1$s! 🐺 Aviso da escola: %2$s (%3$s) é feriado nacional — %4$s — e *não haverá aula*. Feriado nacional não tem reposição; na semana seguinte suas aulas seguem normalmente.'
      when p_kind = 'STUDENT' then
        E'Oi, %1$s! 🐺 Lembrete: amanhã, %2$s (%3$s), é feriado nacional — %4$s — e *não haverá aula*. Bom feriado e até a próxima aula!'
      when p_stage = 'D7' then
        E'Oi, %1$s! 🐺 Aviso da escola: %2$s (%3$s) é feriado nacional — %4$s — e *não haverá aulas*. Não é preciso dar nem lançar as aulas desse dia; seus alunos também estão sendo avisados.'
      else
        E'Oi, %1$s! 🐺 Lembrete: amanhã, %2$s (%3$s), é feriado nacional — %4$s — e *não haverá aulas*. Bom feriado!'
    end,
    coalesce(nullif(split_part(btrim(coalesce(p_name, '')), ' ', 1), ''), 'tudo bem'),
    (array['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'])[extract(dow from p_date)::int + 1],
    to_char(p_date, 'DD/MM'),
    p_holiday);
$$;

-- Job diário (09:00 BRT). D7 vale de 7 a 2 dias antes — se o calendário entrou
-- atrasado, o aviso da semana sai assim mesmo, uma vez; D1 na véspera.
-- Idempotente por pessoa × feriado × etapa.
create or replace function private.queue_national_holiday_notices()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_today date := (now() at time zone 'America/Sao_Paulo')::date; h record; s record; r record; v_stage text; v_count int := 0; v_rows int;
begin
  perform private.ensure_national_holidays();
  for h in select n.holiday_date, n.name from public.national_holidays n
           where n.holiday_date between v_today + 1 and v_today + 7 order by n.holiday_date loop
    v_stage := case when h.holiday_date = v_today + 1 then 'D1' else 'D7' end;
    for s in select tenant_id from private.national_holiday_notice_settings where enabled loop
      begin
        for r in select * from private.national_holiday_recipients(s.tenant_id, h.holiday_date) loop
          insert into public.notification_queue (tenant_id, teacher_id, student_id, student_name, student_phone, message_body,
              scheduled_for, status, source_type, notification_kind, idempotency_key, class_date)
          values (s.tenant_id, r.teacher_id, case when r.person_kind = 'STUDENT' then r.person_id end, r.full_name, r.phone,
              private.national_holiday_message(r.person_kind, v_stage, r.full_name, h.name, h.holiday_date),
              now(), 'pending', 'MANAGEMENT_NOTICE', 'MANAGEMENT_NOTICE',
              format('national-holiday:%s:%s:%s', h.holiday_date, v_stage, r.person_id), h.holiday_date)
          on conflict (tenant_id, idempotency_key) where idempotency_key is not null do nothing;
          get diagnostics v_rows = row_count;
          v_count := v_count + v_rows;
        end loop;
      exception when others then
        raise warning '[feriado nacional] avisos de % para % não enfileirados: %', h.holiday_date, s.tenant_id, sqlerrm;
      end;
    end loop;
  end loop;
  return v_count;
end $$;

-- Pop-up: próximo feriado nacional em até 7 dias, só para escola que adotou a regra.
create or replace function public.my_upcoming_national_holiday()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_today date := (now() at time zone 'America/Sao_Paulo')::date; v_tenant text := public._my_tenant_id(); h record;
begin
  if auth.uid() is null or v_tenant is null
     or not exists (select 1 from private.national_holiday_notice_settings where tenant_id = v_tenant and enabled) then
    return null;
  end if;
  select n.holiday_date, n.name into h from public.national_holidays n
  where n.holiday_date between v_today and v_today + 7 order by n.holiday_date limit 1;
  if not found then return null; end if;
  return jsonb_build_object('date', h.holiday_date, 'name', h.name, 'days_until', h.holiday_date - v_today);
end $$;

do $$ declare r record; begin
  for r in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'private' and p.proname in ('brazil_national_holidays_for','ensure_national_holidays','national_holiday_recipients','national_holiday_message','queue_national_holiday_notices'))
       or (n.nspname = 'public' and p.proname = 'my_upcoming_national_holiday') loop
    execute format('alter function %s owner to postgres', r.sig);
    execute format('revoke all on function %s from public, anon, authenticated, service_role', r.sig);
  end loop;
end $$;
grant execute on function public.my_upcoming_national_holiday() to authenticated;

-- Confirmação de presença: aula da agenda fixa em feriado nacional não existiu.
-- Remendo por âncora (a função é longa e recriada por outras migrations).
do $patch$ declare d text; anchor text := 'from public.upcoming_classes uc'; begin
  select pg_get_functiondef('public.enqueue_attendance_confirmations()'::regprocedure) into d;
  if strpos(d, 'national_holidays') > 0 then return; end if;
  if (length(d) - length(replace(d, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'unexpected_enqueue_attendance_confirmations_definition';
  end if;
  execute replace(d, anchor,
    'from (select x.* from public.upcoming_classes x where not (x.source_type = ''booking'' and exists (select 1 from public.national_holidays nh where nh.holiday_date = x.class_date))) uc');
end $patch$;

select cron.schedule('wisewolf-national-holiday-notices', '0 12 * * *', 'select private.queue_national_holiday_notices();');
