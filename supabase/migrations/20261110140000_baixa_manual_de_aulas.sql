-- Baixa manual de aulas (pedido da direção, 10/11/2026).
--
-- Aula que aconteceu fora dos fluxos normais — prova oral de quem não é aluno,
-- experimental sem oportunidade no sistema, reposição deixada por outro
-- professor — entra na folha por um LANÇAMENTO DE AULA, não por um ajuste em
-- reais. O lançamento é um class_log comum, sem origem (booking/reschedule/
-- appointment), presença COMPLETED. Assim:
--   * o valor é a tarifa de quem deu a aula pela régua de sempre
--     (v_payable_class_logs → teacher_student_rate), com o Turbo quando vale;
--     a direção pode fixar outro valor por 30 min (rate_override);
--   * entra na prévia, no fechamento, no histórico e no relatório do professor
--     como as outras aulas;
--   * a trava contra duplicata olha os lançamentos que já existem.
-- Ajuste em reais (set_closing_adjustment) continua para o que não é aula.
--
-- O motivo é obrigatório e fica numa tabela própria (só RPC); o professor vê no
-- lançamento apenas "Baixa manual pela direção" e o tipo.
-- Reexecutável: create if not exists / create or replace / drop if exists.

create table if not exists public.manual_lesson_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id),
  teacher_id uuid not null references public.profiles(id),
  kind text not null,
  class_date date not null,
  start_time time not null,
  units integer not null default 1,
  student_id uuid references public.profiles(id),
  guest_name text,
  reason text not null,
  rate_override numeric(10,2),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancel_reason text,
  constraint manual_lesson_entries_kind_check
    check (kind in ('EXPERIMENTAL', 'TESTE_ORAL', 'REPOSICAO', 'OUTRO')),
  constraint manual_lesson_entries_units_check check (units between 1 and 4),
  constraint manual_lesson_entries_who_check
    check ((student_id is null) <> (nullif(btrim(coalesce(guest_name, '')), '') is null)),
  constraint manual_lesson_entries_reason_check check (length(btrim(reason)) >= 10),
  constraint manual_lesson_entries_rate_check
    check (rate_override is null or (rate_override >= 0 and rate_override <= 200)),
  constraint manual_lesson_entries_cancel_check
    check ((cancelled_at is null) = (cancel_reason is null))
);

create table if not exists public.manual_lesson_entry_logs (
  entry_id uuid not null references public.manual_lesson_entries(id),
  class_log_id uuid not null,
  unit_number integer not null,
  primary key (entry_id, unit_number)
);
create unique index if not exists uq_manual_lesson_entry_logs_class_log
  on public.manual_lesson_entry_logs(class_log_id);
create index if not exists ix_manual_lesson_entries_tenant_date
  on public.manual_lesson_entries(tenant_id, class_date);

alter table public.manual_lesson_entries owner to postgres;
alter table public.manual_lesson_entry_logs owner to postgres;
alter table public.manual_lesson_entries enable row level security;
alter table public.manual_lesson_entry_logs enable row level security;
revoke all on table public.manual_lesson_entries from public, anon, authenticated, service_role;
revoke all on table public.manual_lesson_entry_logs from public, anon, authenticated, service_role;
-- Funções de dono supabase_admin que as RPCs (dono postgres) chamam.
grant execute on function private.quality_school_manager(text) to postgres;
grant execute on function private.lock_teacher_closing_pair(text, text, uuid, uuid) to postgres;
grant execute on function private.refresh_teacher_closing_snapshot(text, uuid, text, boolean) to postgres;

-- Tipo → subtype do class_log. Experimental e teste oral usam o subtype que os
-- relatórios já contam; reposição NÃO usa REPOSIÇÃO/REPOSIÇÃO_PROF, que exigem
-- uma reposição de origem (sem ela o fechamento marcaria "revisar").
create or replace function private.manual_lesson_subtype(p_kind text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_kind
    when 'EXPERIMENTAL' then 'AULA EXPERIMENTAL'
    when 'TESTE_ORAL' then 'Teste Oral'
    when 'REPOSICAO' then 'REPOSIÇÃO MANUAL'
    else 'BAIXA MANUAL'
  end;
$$;

create or replace function private.manual_lesson_kind_label(p_kind text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_kind
    when 'EXPERIMENTAL' then 'aula experimental'
    when 'TESTE_ORAL' then 'teste oral'
    when 'REPOSICAO' then 'reposição'
    else 'outra aula'
  end;
$$;

-- Direção e coordenação ativas da escola de quem chama.
create or replace function private.manual_lesson_require_manager()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant text := public._my_tenant_id();
begin
  if auth.uid() is null or v_tenant is null
     or not coalesce(private.quality_school_manager(v_tenant), false)
     or not coalesce(public._my_tenant_is_operational(), false) then
    raise exception using errcode = '42501', message = 'sem_permissao';
  end if;
  return v_tenant;
end;
$$;

create or replace function public.manual_lesson_options()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant text := private.manual_lesson_require_manager();
  v_test boolean;
begin
  select coalesce(actor.is_test_account, false) into v_test
    from public.profiles as actor where actor.id = auth.uid();
  return pg_catalog.jsonb_build_object(
    'teachers', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', t.id, 'name', t.full_name) order by t.full_name)
        from public.profiles as t
       where t.tenant_id = v_tenant and t.role = 'TEACHER'
         and pg_catalog.lower(coalesce(t.lifecycle_status, 'active')) = 'active'
         and coalesce(t.is_test_account, false) = v_test
         and exists (select 1 from public.tenant_memberships as m
                      where m.user_id = t.id and m.tenant_id = v_tenant
                        and m.role = 'TEACHER' and m.status = 'ACTIVE')), '[]'::jsonb),
    -- Aluno ativo ou pausado: a aula pode ser de quem está em pausa.
    'students', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', s.id, 'name', s.full_name) order by s.full_name)
        from public.profiles as s
       where s.tenant_id = v_tenant and s.role = 'STUDENT'
         and pg_catalog.lower(coalesce(s.lifecycle_status, 'active')) <> 'offboarded'
         and coalesce(s.is_test_account, false) = v_test), '[]'::jsonb));
end;
$$;

create or replace function public.create_manual_lesson_entry(
  p_teacher_id uuid,
  p_kind text,
  p_class_date date,
  p_start_time time,
  p_units integer,
  p_student_id uuid,
  p_guest_name text,
  p_reason text,
  p_rate_override numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant text := private.manual_lesson_require_manager();
  v_actor uuid := auth.uid();
  v_today date := (pg_catalog.now() at time zone 'America/Sao_Paulo')::date;
  v_month text := pg_catalog.to_char(p_class_date, 'YYYY-MM');
  v_guest text := nullif(pg_catalog.btrim(coalesce(p_guest_name, '')), '');
  v_reason text := pg_catalog.btrim(coalesce(p_reason, ''));
  v_units integer := coalesce(p_units, 1);
  v_closing_status text;
  v_entry uuid;
  v_log uuid;
  v_time time;
  v_end time;
  v_subtype text := private.manual_lesson_subtype(p_kind);
  v_note text;
  v_valor numeric;
  i integer;
begin
  if p_kind is null or p_kind not in ('EXPERIMENTAL', 'TESTE_ORAL', 'REPOSICAO', 'OUTRO') then
    raise exception using errcode = '22023', message = 'tipo_invalido';
  end if;
  if pg_catalog.length(v_reason) < 10 then
    raise exception using errcode = '22023', message = 'motivo_obrigatorio';
  end if;
  if v_units < 1 or v_units > 4 then
    raise exception using errcode = '22023', message = 'duracao_invalida';
  end if;
  if p_class_date is null or p_start_time is null
     or pg_catalog.date_part('minute', p_start_time)::int not in (0, 30)
     or pg_catalog.date_part('second', p_start_time) <> 0 then
    raise exception using errcode = '22023', message = 'data_ou_horario_invalido';
  end if;
  if p_start_time > time '23:30' - ((v_units - 1) * interval '30 minutes') then
    raise exception using errcode = '22023', message = 'data_ou_horario_invalido';
  end if;
  if p_class_date < v_today - 120 then
    raise exception using errcode = '22023', message = 'data_muito_antiga';
  end if;
  if ((p_class_date + p_start_time) at time zone 'America/Sao_Paulo')
       + v_units * interval '30 minutes' > pg_catalog.now() then
    raise exception using errcode = '22023', message = 'aula_ainda_nao_terminou';
  end if;
  if (p_student_id is null) = (v_guest is null) then
    raise exception using errcode = '22023', message = 'aluno_ou_nome';
  end if;
  if v_guest is not null and pg_catalog.length(v_guest) > 120 then
    raise exception using errcode = '22023', message = 'nome_muito_longo';
  end if;
  if p_rate_override is not null and (p_rate_override < 0 or p_rate_override > 200) then
    raise exception using errcode = '22023', message = 'valor_invalido';
  end if;

  if not exists (
    select 1 from public.profiles as t
     where t.id = p_teacher_id and t.tenant_id = v_tenant and t.role = 'TEACHER'
       and pg_catalog.lower(coalesce(t.lifecycle_status, 'active')) = 'active'
       and exists (select 1 from public.tenant_memberships as m
                    where m.user_id = t.id and m.tenant_id = v_tenant
                      and m.role = 'TEACHER' and m.status = 'ACTIVE')
  ) then
    raise exception using errcode = 'P0002', message = 'professor_nao_encontrado';
  end if;
  if p_student_id is not null and not exists (
    select 1 from public.profiles as s
     where s.id = p_student_id and s.tenant_id = v_tenant and s.role = 'STUDENT'
  ) then
    raise exception using errcode = 'P0002', message = 'aluno_nao_encontrado';
  end if;
  if p_student_id is not null and not public.is_billable_student(p_student_id) then
    raise exception using errcode = '22023', message = 'aluno_nao_faturavel';
  end if;

  -- Serializa com o fechamento e com outros lançamentos do mesmo professor/mês.
  perform private.lock_teacher_closing_pair(v_tenant, v_month, p_teacher_id, null);
  select closing.status into v_closing_status
    from public.teacher_closings as closing
   where closing.tenant_id = v_tenant and closing.teacher_id = p_teacher_id
     and closing.month_year = v_month
   order by closing.created_at limit 1;
  if v_closing_status is not null and v_closing_status <> 'PENDENTE' then
    raise exception using errcode = '22023', message = 'mes_fechado';
  end if;

  v_end := p_start_time + v_units * interval '30 minutes';

  -- Professor já tem aula lançada nesse horário (qualquer aluno, inclusive
  -- outra baixa manual). Falta do professor não ocupa o horário.
  if exists (
    select 1 from public.class_logs as cl
     where cl.tenant_id = v_tenant and cl.teacher_id = p_teacher_id
       and cl.class_date = p_class_date and cl.start_time is not null
       and cl.start_time < v_end and cl.start_time + interval '30 minutes' > p_start_time
       and cl.presence not in ('TEACHER_ABSENCE', 'Falta do Professor')
  ) then
    raise exception using errcode = '23505', message = 'professor_ja_tem_aula_no_horario';
  end if;

  if p_student_id is not null then
    -- Aluno com aula lançada nesse horário, com qualquer professor.
    if exists (
      select 1 from public.class_logs as cl
       where cl.tenant_id = v_tenant and cl.student_id = p_student_id
         and cl.class_date = p_class_date and cl.start_time is not null
         and cl.start_time < v_end and cl.start_time + interval '30 minutes' > p_start_time
         and cl.presence not in ('TEACHER_ABSENCE', 'Falta do Professor')
    ) then
      raise exception using errcode = '23505', message = 'aluno_ja_tem_aula_no_horario';
    end if;
    -- A regra de pagamento (v_payable_class_logs) não paga aula sem origem do
    -- mesmo professor e aluno num dia em que houve aula da agenda; o teste oral
    -- também não é pago com outra aula do mesmo par no dia. Recusar aqui evita
    -- uma baixa que entraria na tela com R$ 0.
    if exists (
      select 1 from public.class_logs as cl
       where cl.tenant_id = v_tenant and cl.teacher_id = p_teacher_id
         and cl.student_id = p_student_id and cl.class_date = p_class_date
         and cl.presence not in ('TEACHER_ABSENCE', 'Falta do Professor')
         and coalesce(cl.payment_hold, false) = false
         and (cl.booking_id is not null or p_kind = 'TESTE_ORAL')
    ) and p_kind <> 'EXPERIMENTAL' then
      raise exception using errcode = '23505', message = 'mesmo_dia_ja_lancado';
    end if;
  else
    -- Mesma pessoa de fora, mesmo dia e tipo: é a mesma aula.
    if exists (
      select 1 from public.manual_lesson_entries as e
       where e.tenant_id = v_tenant and e.cancelled_at is null
         and e.student_id is null and e.class_date = p_class_date and e.kind = p_kind
         and public.fold_accents(pg_catalog.lower(pg_catalog.btrim(e.guest_name)))
             = public.fold_accents(pg_catalog.lower(v_guest))
    ) then
      raise exception using errcode = '23505', message = 'ja_lancado_para_esta_pessoa';
    end if;
  end if;

  insert into public.manual_lesson_entries(
    tenant_id, teacher_id, kind, class_date, start_time, units, student_id,
    guest_name, reason, rate_override, created_by)
  values (
    v_tenant, p_teacher_id, p_kind, p_class_date, p_start_time, v_units, p_student_id,
    v_guest, v_reason, p_rate_override, v_actor)
  returning id into v_entry;

  v_note := 'Baixa manual pela direção · ' || private.manual_lesson_kind_label(p_kind)
            || coalesce(' · ' || v_guest, '');

  for i in 1..v_units loop
    v_time := p_start_time + (i - 1) * interval '30 minutes';
    insert into public.class_logs(
      tenant_id, teacher_id, student_id, date, class_date, start_time, end_time,
      presence, subtype, notes, rate_override, approval_status)
    values (
      v_tenant, p_teacher_id, p_student_id, p_class_date, p_class_date, v_time,
      v_time + interval '30 minutes', 'COMPLETED', v_subtype, v_note,
      p_rate_override, 'APPROVED')
    returning id into v_log;
    insert into public.manual_lesson_entry_logs(entry_id, class_log_id, unit_number)
      values (v_entry, v_log, i);
  end loop;

  perform private.refresh_teacher_closing_snapshot(v_tenant, p_teacher_id, v_month, false);

  select pg_catalog.round(coalesce(sum(v.rate_efetivo), 0), 2) into v_valor
    from public.v_payable_class_logs as v
    join public.manual_lesson_entry_logs as l on l.class_log_id = v.id
   where l.entry_id = v_entry;

  return pg_catalog.jsonb_build_object('ok', true, 'id', v_entry, 'aulas', v_units, 'valor', v_valor);
end;
$$;

create or replace function public.cancel_manual_lesson_entry(p_entry_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant text := private.manual_lesson_require_manager();
  v_entry public.manual_lesson_entries%rowtype;
  v_month text;
  v_closing_status text;
  v_reason text := pg_catalog.btrim(coalesce(p_reason, ''));
begin
  if pg_catalog.length(v_reason) < 10 then
    raise exception using errcode = '22023', message = 'motivo_obrigatorio';
  end if;
  select * into v_entry from public.manual_lesson_entries
   where id = p_entry_id and tenant_id = v_tenant;
  if not found then
    raise exception using errcode = 'P0002', message = 'baixa_nao_encontrada';
  end if;
  if v_entry.cancelled_at is not null then
    return pg_catalog.jsonb_build_object('ok', true, 'id', p_entry_id, 'ja_cancelada', true);
  end if;
  v_month := pg_catalog.to_char(v_entry.class_date, 'YYYY-MM');
  perform private.lock_teacher_closing_pair(v_tenant, v_month, v_entry.teacher_id, null);
  select closing.status into v_closing_status
    from public.teacher_closings as closing
   where closing.tenant_id = v_tenant and closing.teacher_id = v_entry.teacher_id
     and closing.month_year = v_month
   order by closing.created_at limit 1;
  if v_closing_status is not null and v_closing_status <> 'PENDENTE' then
    raise exception using errcode = '22023', message = 'mes_fechado';
  end if;

  select * into v_entry from public.manual_lesson_entries where id = p_entry_id for update;
  if v_entry.cancelled_at is not null then
    return pg_catalog.jsonb_build_object('ok', true, 'id', p_entry_id, 'ja_cancelada', true);
  end if;

  -- O lançamento sai da folha; a baixa fica, com quem cancelou e por quê.
  -- O histórico de aulas registra a remoção do class_log.
  delete from public.class_logs as cl
   using public.manual_lesson_entry_logs as l
   where l.entry_id = p_entry_id and cl.id = l.class_log_id;
  update public.manual_lesson_entries
     set cancelled_at = pg_catalog.now(), cancelled_by = auth.uid(), cancel_reason = v_reason
   where id = p_entry_id;

  perform private.refresh_teacher_closing_snapshot(v_tenant, v_entry.teacher_id, v_month, false);
  return pg_catalog.jsonb_build_object('ok', true, 'id', p_entry_id);
end;
$$;

create or replace function public.list_manual_lesson_entries(p_month text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant text := private.manual_lesson_require_manager();
begin
  if p_month is null or p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception using errcode = '22023', message = 'mes_invalido';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', e.id,
        'kind', e.kind,
        'teacher_id', e.teacher_id,
        'teacher_name', t.full_name,
        'student_id', e.student_id,
        'student_name', s.full_name,
        'guest_name', e.guest_name,
        'class_date', e.class_date,
        'start_time', pg_catalog.to_char(e.start_time, 'HH24:MI'),
        'units', e.units,
        'reason', e.reason,
        'rate_override', e.rate_override,
        'created_by_name', c.full_name,
        'created_at', e.created_at,
        'cancelled_at', e.cancelled_at,
        'cancelled_by_name', x.full_name,
        'cancel_reason', e.cancel_reason,
        'month_closed', exists (
          select 1 from public.teacher_closings as tc
           where tc.tenant_id = e.tenant_id and tc.teacher_id = e.teacher_id
             and tc.month_year = p_month and tc.status <> 'PENDENTE'),
        -- Valor que a folha paga hoje por esta baixa (zero se cancelada).
        'valor', (
          select pg_catalog.round(coalesce(sum(v.rate_efetivo), 0), 2)
            from public.manual_lesson_entry_logs as l
            join public.v_payable_class_logs as v on v.id = l.class_log_id
           where l.entry_id = e.id))
      order by e.class_date desc, e.start_time desc, e.created_at desc)
      from public.manual_lesson_entries as e
      join public.profiles as t on t.id = e.teacher_id
      left join public.profiles as s on s.id = e.student_id
      left join public.profiles as c on c.id = e.created_by
      left join public.profiles as x on x.id = e.cancelled_by
     where e.tenant_id = v_tenant
       and pg_catalog.to_char(e.class_date, 'YYYY-MM') = p_month), '[]'::jsonb);
end;
$$;

alter function private.manual_lesson_subtype(text) owner to postgres;
alter function private.manual_lesson_kind_label(text) owner to postgres;
alter function private.manual_lesson_require_manager() owner to postgres;
alter function public.manual_lesson_options() owner to postgres;
alter function public.create_manual_lesson_entry(uuid, text, date, time, integer, uuid, text, text, numeric) owner to postgres;
alter function public.cancel_manual_lesson_entry(uuid, text) owner to postgres;
alter function public.list_manual_lesson_entries(text) owner to postgres;

revoke all on function private.manual_lesson_subtype(text) from public, anon, authenticated;
revoke all on function private.manual_lesson_kind_label(text) from public, anon, authenticated;
revoke all on function private.manual_lesson_require_manager() from public, anon, authenticated;
revoke all on function public.manual_lesson_options() from public, anon, service_role;
revoke all on function public.create_manual_lesson_entry(uuid, text, date, time, integer, uuid, text, text, numeric) from public, anon, service_role;
revoke all on function public.cancel_manual_lesson_entry(uuid, text) from public, anon, service_role;
revoke all on function public.list_manual_lesson_entries(text) from public, anon, service_role;
grant execute on function public.manual_lesson_options() to authenticated;
grant execute on function public.create_manual_lesson_entry(uuid, text, date, time, integer, uuid, text, text, numeric) to authenticated;
grant execute on function public.cancel_manual_lesson_entry(uuid, text) to authenticated;
grant execute on function public.list_manual_lesson_entries(text) to authenticated;
