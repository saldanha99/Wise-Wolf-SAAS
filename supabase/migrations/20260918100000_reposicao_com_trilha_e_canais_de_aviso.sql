-- Reposição com trilha, aviso automático e atestado da direção; canais de aviso
-- por grupo de WhatsApp.
--
-- O caso (18/09/2026, Flávio): a reposição "marcada para hoje" nunca existiu no
-- sistema — as 13 dele estão "Pendente". Quando passou, não havia o que mudar e
-- a direção não sabia horário nem motivo. Medido nos últimos 60 dias: 138
-- reposições criadas, 16 ganharam data (12%), 11 foram dadas; 122 abertas sem
-- data (Mateus 127, Lais 34, Flávio 13, Débora 10). A tela "Reposições" só
-- gravava data/hora (`schedule_reschedule`), sem motivo, sem histórico, sem
-- aviso — e não havia linha nenhuma em `audit_logs`.
--
-- Decisões da direção (18/09/2026):
--   • família recebe aviso automático em toda marcação/remarcação/desmarcação;
--   • remarcar em cima da hora (< 3 h) é permitido com motivo e sai destacado;
--   • reposição sem data não expira, mas fica visível (resumo semanal);
--   • 4 grupos: Direção·Financeiro, Coordenação·Aulas, Comercial·Leads e
--     Professores — canal sem grupo configurado cai no grupo da Gestão.
--
-- O que muda aqui:
--   1. `tenant_notice_channels` + `private.tenant_notice_destination(tenant,
--      canal)` (fallback: grupo da Gestão). RPCs `get_notice_channels` e
--      `save_notice_channel`.
--   2. `reschedule_events`: trigger em `reschedules` grava criada / marcada /
--      remarcada / desmarcada / professor_trocado / atestada / dada, com ator,
--      origem (app, WhatsApp do professor, aluno via acompanhamento, direção,
--      sistema), motivo e "em cima da hora"; e enfileira o aviso ao grupo de
--      coordenação e à família (idempotente por evento). Venha de onde vier a
--      mudança — tela, RPC, bot ou SQL — a trilha existe.
--   3. `schedule_reschedule` ganha `p_reason` (obrigatório na remarcação);
--      `unschedule_reschedule` (volta a "Pendente" com motivo).
--   4. Reposição de falta do PROFESSOR dada por OUTRO professor: a prova
--      financeira (`teacher_reschedule_financial_origin_is_proven`) só conhecia o
--      lançamento de falta do mesmo professor — a substituta nunca receberia. A
--      direção agora ATESTA (`attest_teacher_fault_reschedule`), como na
--      cobertura de aula já dada. Colunas de atestado são só do servidor.
--   5. `coverage_briefing_enqueue` e `teacher_apply_student_schedule_change`
--      passam a mandar o aviso ao canal de coordenação.
--   6. `reschedule_backlog_summary` para o resumo semanal e o comando do grupo.

-- ---------------------------------------------------------------------------
-- 1) Canais de aviso
-- ---------------------------------------------------------------------------
create table if not exists public.tenant_notice_channels (
  tenant_id text not null references public.tenants(id) on delete cascade,
  channel text not null,
  group_jid text,
  enabled boolean not null default true,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, channel),
  constraint tenant_notice_channels_channel_check
    check (channel in ('direcao', 'coordenacao', 'comercial', 'professores')),
  constraint tenant_notice_channels_group_jid_check
    check (group_jid is null or group_jid ~ '^[0-9]{10,25}(-[0-9]+)?@g[.]us$')
);
comment on table public.tenant_notice_channels is
  'Grupo de WhatsApp por canal de aviso (direcao, coordenacao, comercial, professores). Canal sem linha ou sem grupo cai no grupo da Gestão (private.tenant_notice_destination).';

alter table public.tenant_notice_channels enable row level security;
drop policy if exists tenant_notice_channels_admin_read on public.tenant_notice_channels;
create policy tenant_notice_channels_admin_read
  on public.tenant_notice_channels for select to authenticated
  using (
    tenant_id = (select public._my_tenant_id())
    and (select public._my_role()) in ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN')
  );
revoke all on public.tenant_notice_channels from public, anon;
grant select on public.tenant_notice_channels to authenticated;
grant select, insert, update, delete on public.tenant_notice_channels to service_role;

create or replace function private.tenant_notice_destination(p_tenant text, p_channel text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select c.group_jid
       from public.tenant_notice_channels c
      where c.tenant_id = p_tenant and c.channel = p_channel
        and c.enabled and c.group_jid is not null),
    case when p_channel = 'professores' then
      (select nullif(btrim(p.teachers_group_id), '')
         from public.profiles p
        where p.tenant_id = p_tenant and p.role in ('SCHOOL_ADMIN', 'SUPER_ADMIN')
          and nullif(btrim(p.teachers_group_id), '') is not null
        order by case when p.role = 'SCHOOL_ADMIN' then 0 else 1 end, p.created_at
        limit 1)
    end,
    private.management_group_destination(p_tenant)
  );
$$;
alter function private.tenant_notice_destination(text, text) owner to postgres;
revoke all on function private.tenant_notice_destination(text, text) from public, anon, authenticated;
grant execute on function private.tenant_notice_destination(text, text) to service_role, postgres;
comment on function private.tenant_notice_destination(text, text) is
  'JID do grupo para um canal de aviso; sem configuração cai no grupo da Gestão (dre_report_settings.destino).';

create or replace function public.get_notice_channels()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant text := public._my_tenant_id();
  v_role text := public._my_role();
  v_gestao text;
begin
  if auth.uid() is null or v_tenant is null
     or coalesce(v_role, '') not in ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN') then
    raise exception using errcode = '42501', message = 'sem_permissao';
  end if;
  v_gestao := private.management_group_destination(v_tenant);
  return (
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'channel', ch.channel,
      'group_jid', cfg.group_jid,
      'enabled', coalesce(cfg.enabled, true),
      'effective_jid', private.tenant_notice_destination(v_tenant, ch.channel),
      'fallback', case
        when cfg.group_jid is not null and coalesce(cfg.enabled, true) then 'configurado'
        when ch.channel = 'professores'
             and private.tenant_notice_destination(v_tenant, ch.channel) is distinct from v_gestao then 'grupo_dos_professores'
        else 'gestao' end
    ) order by ch.ord)
    from (values ('direcao', 1), ('coordenacao', 2), ('comercial', 3), ('professores', 4)) as ch(channel, ord)
    left join public.tenant_notice_channels cfg
      on cfg.tenant_id = v_tenant and cfg.channel = ch.channel
  );
end;
$$;
alter function public.get_notice_channels() owner to postgres;
revoke all on function public.get_notice_channels() from public, anon;
grant execute on function public.get_notice_channels() to authenticated;

create or replace function public.save_notice_channel(p_channel text, p_group_jid text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant text := public._my_tenant_id();
  v_role text := public._my_role();
  v_jid text := nullif(btrim(coalesce(p_group_jid, '')), '');
begin
  if auth.uid() is null or v_tenant is null
     or coalesce(v_role, '') not in ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN') then
    raise exception using errcode = '42501', message = 'sem_permissao';
  end if;
  if p_channel not in ('direcao', 'coordenacao', 'comercial', 'professores') then
    raise exception using errcode = '22023', message = 'canal_invalido';
  end if;
  if v_jid is not null and v_jid !~ '^[0-9]{10,25}(-[0-9]+)?@g[.]us$' then
    raise exception using errcode = '22023', message = 'grupo_invalido';
  end if;
  insert into public.tenant_notice_channels (tenant_id, channel, group_jid, enabled, updated_by, updated_at)
  values (v_tenant, p_channel, v_jid, true, auth.uid(), pg_catalog.now())
  on conflict (tenant_id, channel) do update
    set group_jid = excluded.group_jid, enabled = true,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  return pg_catalog.jsonb_build_object('ok', true, 'channel', p_channel, 'group_jid', v_jid,
    'effective_jid', private.tenant_notice_destination(v_tenant, p_channel));
end;
$$;
alter function public.save_notice_channel(text, text) owner to postgres;
revoke all on function public.save_notice_channel(text, text) from public, anon;
grant execute on function public.save_notice_channel(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Atestado da direção em reposição de falta do professor
-- ---------------------------------------------------------------------------
alter table public.reschedules
  add column if not exists attested_by uuid references auth.users(id) on delete set null,
  add column if not exists attested_at timestamptz,
  add column if not exists attestation_reason text;
comment on column public.reschedules.attested_by is
  'Direção atestou que esta reposição de falta do PROFESSOR é devida (dada por outro professor, sem lançamento de falta do titular). Só o servidor grava (app.reschedule_attest).';

-- Colunas de atestado e a origem financeira (fault_type) não mudam por PostgREST
-- na mão: um professor com update na própria linha poderia "provar" a si mesmo.
create or replace function private.reschedule_server_fields_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := public._my_role();
begin
  if (new.attested_by is distinct from old.attested_by
      or new.attested_at is distinct from old.attested_at
      or new.attestation_reason is distinct from old.attestation_reason)
     and coalesce(pg_catalog.current_setting('app.reschedule_attest', true), '') <> 'on' then
    raise exception using errcode = '42501', message = 'reschedule_attestation_is_server_only';
  end if;
  if new.fault_type is distinct from old.fault_type
     and coalesce(auth.role(), '') <> 'service_role'
     -- session_user é forma especial do SQL (como nullif): sem prefixo pg_catalog.
     and session_user not in ('postgres', 'supabase_admin')
     and coalesce(v_role, '') not in ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN') then
    raise exception using errcode = '42501', message = 'reschedule_fault_type_is_server_only';
  end if;
  return new;
end;
$$;
alter function private.reschedule_server_fields_guard() owner to postgres;
revoke all on function private.reschedule_server_fields_guard() from public, anon, authenticated, service_role;
drop trigger if exists trg_aa_reschedule_server_fields_guard on public.reschedules;
create trigger trg_aa_reschedule_server_fields_guard
  before update on public.reschedules
  for each row execute function private.reschedule_server_fields_guard();

-- A prova financeira ganha o ramo "direção atestou".
create or replace function private.teacher_reschedule_financial_origin_is_proven(
  p_reschedule_id uuid, p_tenant_id text, p_teacher_id uuid, p_student_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
      from public.reschedules as reschedule
     where reschedule.id = p_reschedule_id
       and reschedule.tenant_id = p_tenant_id
       and reschedule.teacher_id = p_teacher_id
       and reschedule.student_id = p_student_id
       and reschedule.fault_type = 'TEACHER'
       and (
         -- Direção atestou: reposição da falta de um professor dada por outro
         -- (o lançamento de falta, quando existe, é do titular — nunca casaria).
         reschedule.attested_by is not null
         or (
           reschedule.original_booking_id is not null
           and exists (
             select 1
               from public.class_logs as origin_log
              where origin_log.tenant_id = reschedule.tenant_id
                and origin_log.teacher_id = reschedule.teacher_id
                and origin_log.student_id = reschedule.student_id
                and origin_log.booking_id = reschedule.original_booking_id::text
                and origin_log.presence in ('TEACHER_ABSENCE', 'Falta do Professor')
           )
         )
         or (
           reschedule.attendance_session_key is not null
           and exists (
             select 1
               from public.attendance_confirmations as confirmation
              where confirmation.session_key = reschedule.attendance_session_key
                and confirmation.tenant_id = reschedule.tenant_id
                and confirmation.teacher_id = reschedule.teacher_id
                and confirmation.student_id is not distinct from reschedule.student_id
                and confirmation.status = 'RESOLVED_UNPAID'
                and confirmation.resolution_verdict = 'TEACHER_ABSENT'
           )
         )
       )
  );
$function$;

-- ---------------------------------------------------------------------------
-- 3) Trilha de eventos + avisos
-- ---------------------------------------------------------------------------
create table if not exists public.reschedule_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  reschedule_id uuid not null references public.reschedules(id) on delete cascade,
  student_id uuid,
  teacher_id uuid,
  action text not null,
  from_date text,
  from_time text,
  to_date text,
  to_time text,
  actor_id uuid,
  actor_role text,
  source text not null default 'sistema',
  reason text,
  em_cima_da_hora boolean not null default false,
  -- clock_timestamp: dois eventos na mesma transação precisam de ordem real.
  created_at timestamptz not null default clock_timestamp(),
  constraint reschedule_events_action_check check (action in
    ('criada', 'marcada', 'remarcada', 'desmarcada', 'professor_trocado', 'atestada', 'dada')),
  constraint reschedule_events_source_check check (source in
    ('app', 'whatsapp_professor', 'whatsapp_aluno', 'direcao', 'sistema'))
);
alter table public.reschedule_events alter column created_at set default clock_timestamp();
create index if not exists reschedule_events_reschedule_idx on public.reschedule_events (reschedule_id, created_at desc);
create index if not exists reschedule_events_tenant_created_idx on public.reschedule_events (tenant_id, created_at desc);
comment on table public.reschedule_events is
  'Trilha da reposição: quem marcou/remarcou/desmarcou, de onde (app, WhatsApp, acompanhamento, direção), por quê, e se foi em cima da hora. Gravada por trigger — nenhuma mudança escapa.';

alter table public.reschedule_events enable row level security;
drop policy if exists reschedule_events_read on public.reschedule_events;
create policy reschedule_events_read
  on public.reschedule_events for select to authenticated
  using (
    tenant_id = (select public._my_tenant_id())
    and (
      teacher_id = (select auth.uid())
      or student_id = (select auth.uid())
      or (select public._my_role()) in ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN')
    )
  );
revoke all on public.reschedule_events from public, anon;
grant select on public.reschedule_events to authenticated;
grant select, insert on public.reschedule_events to service_role;

create or replace function private.reschedule_slot_start(p_date text, p_time text)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select case
    when coalesce(p_date, '') ~ '^\d{4}-\d{2}-\d{2}$'
         and coalesce(p_time, '') ~ '^([01]\d|2[0-3]):[0-5]\d'
    then (p_date || ' ' || left(p_time, 5) || ':00-03')::timestamptz
  end;
$$;
-- Dono postgres + grant explícito: função de `private` criada pelo release nasce
-- com dono supabase_admin e ACL só dele; quem a chama com dono postgres
-- (schedule_reschedule, reschedule_backlog_summary) levava "permission denied".
alter function private.reschedule_slot_start(text, text) owner to postgres;
revoke all on function private.reschedule_slot_start(text, text) from public, anon, authenticated;
grant execute on function private.reschedule_slot_start(text, text) to postgres, service_role;

create or replace function private.reschedule_events_capture()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action text;
  v_source text;
  v_reason text;
  v_actor uuid := auth.uid();
  v_role text;
  v_old_start timestamptz;
  v_new_start timestamptz;
  v_urgent boolean := false;
  v_event_id uuid;
  v_student public.profiles%rowtype;
  v_teacher public.profiles%rowtype;
  v_other_teacher public.profiles%rowtype;
  v_group text;
  v_family_phone text;
  v_director uuid;
  v_when_old text;
  v_when_new text;
  v_first_student text;
  v_first_teacher text;
  v_group_msg text;
  v_family_msg text;
  v_actor_name text;
begin
  if tg_op = 'INSERT' then
    v_action := case when private.reschedule_slot_start(new.date, new.time) is not null then 'marcada' else 'criada' end;
  else
    if old.used_at is null and new.used_at is not null then
      v_action := 'dada';
    elsif new.teacher_id is distinct from old.teacher_id then
      v_action := 'professor_trocado';
    elsif (new.attested_by is not null and old.attested_by is null) then
      v_action := 'atestada';
    elsif new.date is distinct from old.date or left(coalesce(new.time, ''), 5) is distinct from left(coalesce(old.time, ''), 5) then
      v_old_start := private.reschedule_slot_start(old.date, old.time);
      v_new_start := private.reschedule_slot_start(new.date, new.time);
      v_action := case
        when v_new_start is not null and v_old_start is null then 'marcada'
        when v_new_start is not null and v_old_start is not null then 'remarcada'
        when v_new_start is null and v_old_start is not null then 'desmarcada'
        else null end;
    end if;
  end if;
  if v_action is null then return new; end if;

  v_role := public._my_role();
  v_source := coalesce(nullif(pg_catalog.current_setting('app.reschedule_source', true), ''),
    case
      when coalesce(auth.role(), '') = 'service_role' then 'sistema'
      when coalesce(v_role, '') in ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN') then 'direcao'
      when coalesce(v_role, '') = 'TEACHER' then 'app'
      else 'sistema' end);
  if v_source not in ('app', 'whatsapp_professor', 'whatsapp_aluno', 'direcao', 'sistema') then v_source := 'sistema'; end if;
  v_reason := nullif(left(btrim(coalesce(pg_catalog.current_setting('app.reschedule_reason', true), '')), 300), '');
  if v_action = 'atestada' then v_reason := coalesce(v_reason, new.attestation_reason); end if;

  -- Em cima da hora: mexer numa reposição que começa (ou começava) em menos de 3 h.
  if v_action in ('remarcada', 'desmarcada') then
    v_urgent := v_old_start is not null and v_old_start > pg_catalog.now() - interval '3 hours'
                and v_old_start < pg_catalog.now() + interval '3 hours';
  elsif v_action = 'marcada' then
    v_new_start := private.reschedule_slot_start(new.date, new.time);
    v_urgent := v_new_start is not null and v_new_start < pg_catalog.now() + interval '3 hours';
  end if;

  insert into public.reschedule_events (tenant_id, reschedule_id, student_id, teacher_id, action,
      from_date, from_time, to_date, to_time, actor_id, actor_role, source, reason, em_cima_da_hora)
  values (new.tenant_id, new.id, new.student_id, new.teacher_id, v_action,
      case when tg_op = 'UPDATE' then old.date end, case when tg_op = 'UPDATE' then old.time end,
      new.date, new.time,
      case when coalesce(auth.role(), '') = 'service_role' then null else v_actor end, v_role, v_source, v_reason, v_urgent)
  returning id into v_event_id;

  -- Avisos: grupo de coordenação + família. Só o que muda a agenda de alguém;
  -- "criada" e "dada" já têm o lançamento como registro. Reparo em massa por
  -- SQL pode silenciar com set_config('app.reschedule_silent','on',true).
  if v_action not in ('marcada', 'remarcada', 'desmarcada', 'professor_trocado', 'atestada')
     or coalesce(pg_catalog.current_setting('app.reschedule_silent', true), '') = 'on' then
    return new;
  end if;

  select * into v_student from public.profiles where id = new.student_id;
  select * into v_teacher from public.profiles where id = new.teacher_id;
  if v_action = 'professor_trocado' then
    select * into v_other_teacher from public.profiles where id = old.teacher_id;
  end if;
  v_director := private.management_group_default_actor(new.tenant_id);
  v_first_student := split_part(btrim(coalesce(v_student.full_name, 'aluno')), ' ', 1);
  v_first_teacher := split_part(btrim(coalesce(v_teacher.full_name, 'professor')), ' ', 1);
  select p.full_name into v_actor_name from public.profiles p where p.id = v_actor;
  v_when_old := case when tg_op = 'UPDATE' and private.reschedule_slot_start(old.date, old.time) is not null
    then format('%s %s às %s', private.weekday_label_pt(old.date::date), to_char(old.date::date, 'DD/MM'), left(old.time, 5)) end;
  v_when_new := case when private.reschedule_slot_start(new.date, new.time) is not null
    then format('%s %s às %s', private.weekday_label_pt(new.date::date), to_char(new.date::date, 'DD/MM'), left(new.time, 5)) end;

  v_group_msg := case v_action
    when 'marcada' then format('📅 *Reposição marcada* · %s · %s%s%s', coalesce(v_student.full_name, 'aluno'),
      coalesce(v_when_new, '—'), case when v_urgent then ' ⚠️ em cima da hora' else '' end,
      case when new.fault_type = 'TEACHER' then ' · falta do professor' else '' end)
    when 'remarcada' then format('🔁 *Reposição remarcada* · %s · %s → %s%s', coalesce(v_student.full_name, 'aluno'),
      coalesce(v_when_old, '—'), coalesce(v_when_new, '—'), case when v_urgent then ' ⚠️ em cima da hora' else '' end)
    when 'desmarcada' then format('❌ *Reposição desmarcada* · %s · era %s%s', coalesce(v_student.full_name, 'aluno'),
      coalesce(v_when_old, '—'), case when v_urgent then ' ⚠️ em cima da hora' else '' end)
    when 'professor_trocado' then format('👥 *Reposição passou de professor* · %s · de %s para %s%s', coalesce(v_student.full_name, 'aluno'),
      coalesce(v_other_teacher.full_name, '?'), coalesce(v_teacher.full_name, '?'),
      case when v_when_new is not null then ' · ' || v_when_new else '' end)
    when 'atestada' then format('✔️ *Reposição de falta do professor atestada* · %s · com %s%s', coalesce(v_student.full_name, 'aluno'),
      coalesce(v_teacher.full_name, '?'), case when v_when_new is not null then ' · ' || v_when_new else '' end)
    end
    || E'\n' || format('👨‍🏫 %s · por %s (%s)%s', coalesce(v_teacher.full_name, 'professor'),
      coalesce(v_actor_name, case v_source when 'whatsapp_aluno' then 'aluno' when 'sistema' then 'sistema' else 'escola' end),
      case v_source when 'app' then 'plataforma' when 'whatsapp_professor' then 'WhatsApp do professor'
        when 'whatsapp_aluno' then 'WhatsApp do aluno' when 'direcao' then 'direção' else 'sistema' end,
      case when v_reason is not null then ' · motivo: ' || v_reason else '' end);

  v_group := private.tenant_notice_destination(new.tenant_id, 'coordenacao');
  if v_group is not null then
    insert into public.notification_queue (tenant_id, teacher_id, student_id, student_name, student_phone, message_body,
        scheduled_for, status, source_type, notification_kind, idempotency_key)
    values (new.tenant_id, coalesce(v_director, new.teacher_id), new.student_id, 'Coordenação', v_group, v_group_msg,
        pg_catalog.now(), 'pending', 'MANAGEMENT_NOTICE', 'MANAGEMENT_NOTICE', format('reschedule-event:%s:group', v_event_id))
    on conflict (tenant_id, idempotency_key) where idempotency_key is not null do nothing;
  end if;

  -- Família: marcada, remarcada e desmarcada (atestado e troca de professor são internos).
  if v_action in ('marcada', 'remarcada', 'desmarcada') and public.is_student_notifiable(new.student_id) then
    v_family_phone := private.whatsapp_digits(coalesce(nullif(v_student.attendance_phone, ''), nullif(v_student.phone, ''), nullif(v_student.guardian_phone, '')));
    if v_family_phone is not null then
      v_family_msg := case v_action
        when 'marcada' then format('Oi, %s! 🐺 Sua reposição com o teacher %s ficou marcada para %s. Qualquer imprevisto, é só responder aqui.', v_first_student, v_first_teacher, v_when_new)
        when 'remarcada' then format('Oi, %s! 🐺 Sua reposição com o teacher %s mudou: era %s e passou para %s. Qualquer dúvida, é só responder aqui.', v_first_student, v_first_teacher, v_when_old, v_when_new)
        else format('Oi, %s! 🐺 A reposição com o teacher %s que estava marcada para %s foi desmarcada. A escola vai combinar uma nova data com você.', v_first_student, v_first_teacher, v_when_old)
        end;
      insert into public.notification_queue (tenant_id, teacher_id, student_id, student_name, student_phone, message_body,
          scheduled_for, status, source_type, notification_kind, idempotency_key)
      values (new.tenant_id, coalesce(v_director, new.teacher_id), new.student_id, v_student.full_name, v_family_phone, v_family_msg,
          pg_catalog.now(), 'pending', 'MANAGEMENT_NOTICE', 'MANAGEMENT_NOTICE', format('reschedule-event:%s:family', v_event_id))
      on conflict (tenant_id, idempotency_key) where idempotency_key is not null do nothing;
    end if;
  end if;
  return new;
end;
$$;
alter function private.reschedule_events_capture() owner to postgres;
revoke all on function private.reschedule_events_capture() from public, anon, authenticated, service_role;
drop trigger if exists trg_zz_reschedule_events_capture on public.reschedules;
create trigger trg_zz_reschedule_events_capture
  after insert or update on public.reschedules
  for each row execute function private.reschedule_events_capture();

-- ---------------------------------------------------------------------------
-- 4) RPCs: marcar/remarcar com motivo, desmarcar, atestar
-- ---------------------------------------------------------------------------
-- A assinatura de 3 argumentos sai: com as duas, o PostgREST recusaria a
-- chamada por ambiguidade (a de 4 tem default).
drop function if exists public.schedule_reschedule(uuid, date, time without time zone);
create or replace function public.schedule_reschedule(
  p_reschedule_id uuid, p_date date, p_time time without time zone, p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid := auth.uid();
  v_actor_role text := public._my_role();
  v_actor_tenant text := public._my_tenant_id();
  v_reschedule public.reschedules%rowtype;
  v_result jsonb;
  v_had_slot boolean;
  v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 300), '');
begin
  if v_actor_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if v_actor_tenant is null
     or not coalesce(v_actor_role in ('TEACHER', 'SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN'), false)
     or not coalesce(public._my_tenant_is_operational(), false) then
    raise exception using errcode = '42501', message = 'reschedule_schedule_not_authorized';
  end if;
  if p_reschedule_id is null or p_date is null or p_time is null then
    raise exception using errcode = '22023', message = 'invalid_reschedule_slot';
  end if;

  select reschedule.* into v_reschedule
    from public.reschedules as reschedule
   where reschedule.id = p_reschedule_id
     and reschedule.tenant_id = v_actor_tenant
     and reschedule.used_at is null
   for update of reschedule;
  if not found then
    raise exception using errcode = 'P0002', message = 'reschedule_not_found_or_consumed';
  end if;
  if v_actor_role = 'TEACHER' and v_reschedule.teacher_id is distinct from v_actor_id then
    raise exception using errcode = '42501', message = 'reschedule_schedule_not_authorized';
  end if;
  if v_actor_role = 'TEACHER'
     and (p_date + p_time) <= (pg_catalog.now() at time zone 'America/Sao_Paulo') then
    raise exception using errcode = '22023', message = 'teacher_reschedule_slot_must_be_future';
  end if;
  if not private.reschedule_participants_are_active(
    v_reschedule.id, v_reschedule.tenant_id, v_reschedule.teacher_id, v_reschedule.student_id
  ) then
    raise exception using errcode = '55000', message = 'reschedule_participant_inactive';
  end if;

  -- Remarcação (já tinha data) exige motivo: é o que a direção não tinha.
  v_had_slot := private.reschedule_slot_start(v_reschedule.date, v_reschedule.time) is not null;
  if v_had_slot
     and (v_reschedule.date <> pg_catalog.to_char(p_date, 'YYYY-MM-DD')
          or left(coalesce(v_reschedule.time, ''), 5) <> pg_catalog.to_char(p_time, 'HH24:MI'))
     and (v_reason is null or length(v_reason) < 3) then
    raise exception using errcode = '22023', message = 'motivo_obrigatorio';
  end if;

  perform pg_catalog.set_config('app.reschedule_source',
    case when v_actor_role = 'TEACHER' then 'app' else 'direcao' end, true);
  perform pg_catalog.set_config('app.reschedule_reason', coalesce(v_reason, ''), true);

  update public.reschedules as reschedule
     set date = pg_catalog.to_char(p_date, 'YYYY-MM-DD'),
         time = pg_catalog.to_char(p_time, 'HH24:MI')
   where reschedule.id = v_reschedule.id;

  select pg_catalog.jsonb_build_object(
           'id', reschedule.id, 'date', reschedule.date, 'time', reschedule.time,
           'notification_revision', reschedule.notification_revision,
           'event', (select pg_catalog.jsonb_build_object('action', e.action, 'em_cima_da_hora', e.em_cima_da_hora)
                       from public.reschedule_events e where e.reschedule_id = reschedule.id
                      order by e.created_at desc limit 1))
    into v_result
    from public.reschedules as reschedule
   where reschedule.id = v_reschedule.id;
  return v_result;
end;
$function$;
alter function public.schedule_reschedule(uuid, date, time without time zone, text) owner to postgres;
revoke all on function public.schedule_reschedule(uuid, date, time without time zone, text) from public, anon;
grant execute on function public.schedule_reschedule(uuid, date, time without time zone, text) to authenticated;

create or replace function public.unschedule_reschedule(p_reschedule_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid := auth.uid();
  v_actor_role text := public._my_role();
  v_actor_tenant text := public._my_tenant_id();
  v_reschedule public.reschedules%rowtype;
  v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 300), '');
begin
  if v_actor_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if v_actor_tenant is null
     or not coalesce(v_actor_role in ('TEACHER', 'SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN'), false) then
    raise exception using errcode = '42501', message = 'reschedule_schedule_not_authorized';
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception using errcode = '22023', message = 'motivo_obrigatorio';
  end if;
  select reschedule.* into v_reschedule
    from public.reschedules as reschedule
   where reschedule.id = p_reschedule_id and reschedule.tenant_id = v_actor_tenant and reschedule.used_at is null
   for update of reschedule;
  if not found then
    raise exception using errcode = 'P0002', message = 'reschedule_not_found_or_consumed';
  end if;
  if v_actor_role = 'TEACHER' and v_reschedule.teacher_id is distinct from v_actor_id then
    raise exception using errcode = '42501', message = 'reschedule_schedule_not_authorized';
  end if;
  if private.reschedule_slot_start(v_reschedule.date, v_reschedule.time) is null then
    return pg_catalog.jsonb_build_object('ok', true, 'already', true);
  end if;
  perform pg_catalog.set_config('app.reschedule_source',
    case when v_actor_role = 'TEACHER' then 'app' else 'direcao' end, true);
  perform pg_catalog.set_config('app.reschedule_reason', v_reason, true);
  update public.reschedules set date = 'Pendente', time = 'Pendente' where id = v_reschedule.id;
  return pg_catalog.jsonb_build_object('ok', true, 'id', v_reschedule.id);
end;
$function$;
alter function public.unschedule_reschedule(uuid, text) owner to postgres;
revoke all on function public.unschedule_reschedule(uuid, text) from public, anon;
grant execute on function public.unschedule_reschedule(uuid, text) to authenticated;

create or replace function public.attest_teacher_fault_reschedule(p_reschedule_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid := auth.uid();
  v_actor_role text := public._my_role();
  v_reschedule public.reschedules%rowtype;
  v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 300), '');
  v_attester uuid;
begin
  select reschedule.* into v_reschedule from public.reschedules as reschedule
   where reschedule.id = p_reschedule_id for update of reschedule;
  if not found then
    raise exception using errcode = 'P0002', message = 'reschedule_not_found';
  end if;
  if coalesce(auth.role(), '') = 'service_role' then
    v_attester := private.management_group_default_actor(v_reschedule.tenant_id);
  elsif v_actor_id is not null
        and coalesce(v_actor_role, '') in ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN')
        and (v_actor_role = 'SUPER_ADMIN' or public._my_tenant_id() = v_reschedule.tenant_id) then
    v_attester := v_actor_id;
  else
    raise exception using errcode = '42501', message = 'sem_permissao';
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception using errcode = '22023', message = 'motivo_obrigatorio';
  end if;
  if v_reschedule.fault_type is distinct from 'TEACHER' then
    raise exception using errcode = '22023', message = 'reposicao_nao_e_falta_do_professor';
  end if;
  if v_reschedule.attested_by is not null then
    return pg_catalog.jsonb_build_object('ok', true, 'already', true, 'attested_by', v_reschedule.attested_by);
  end if;
  perform pg_catalog.set_config('app.reschedule_attest', 'on', true);
  perform pg_catalog.set_config('app.reschedule_source', 'direcao', true);
  perform pg_catalog.set_config('app.reschedule_reason', v_reason, true);
  update public.reschedules
     set attested_by = v_attester, attested_at = pg_catalog.now(), attestation_reason = v_reason
   where id = v_reschedule.id;
  perform pg_catalog.set_config('app.reschedule_attest', '', true);
  return pg_catalog.jsonb_build_object('ok', true, 'id', v_reschedule.id, 'attested_by', v_attester);
end;
$function$;
alter function public.attest_teacher_fault_reschedule(uuid, text) owner to postgres;
revoke all on function public.attest_teacher_fault_reschedule(uuid, text) from public, anon;
grant execute on function public.attest_teacher_fault_reschedule(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5) Quem marca pelo acompanhamento (aluno no WhatsApp) fica identificado.
-- ---------------------------------------------------------------------------
do $care_source$
declare d text;
begin
  select pg_get_functiondef('public.care_set_reschedule_slot(text,uuid,uuid,date,text)'::regprocedure) into d;
  if strpos(d, 'app.reschedule_source') = 0 then
    if strpos(d, $a$  update public.reschedules set date = pg_catalog.to_char(p_date, 'YYYY-MM-DD'), time = v_time where id = r.id;$a$) = 0 then
      raise exception 'care_set_reschedule_slot: âncora do update não encontrada';
    end if;
    execute replace(d,
      $a$  update public.reschedules set date = pg_catalog.to_char(p_date, 'YYYY-MM-DD'), time = v_time where id = r.id;$a$,
      $b$  perform pg_catalog.set_config('app.reschedule_source', 'whatsapp_aluno', true);
  perform pg_catalog.set_config('app.reschedule_reason', 'aluno escolheu o horário pelo WhatsApp', true);
  update public.reschedules set date = pg_catalog.to_char(p_date, 'YYYY-MM-DD'), time = v_time where id = r.id;$b$);
  end if;
end;
$care_source$;

-- ---------------------------------------------------------------------------
-- 6) Avisos de cobertura e de troca de horário vão ao canal de coordenação.
-- ---------------------------------------------------------------------------
do $route_coverage$
declare d text; a text; b text;
begin
  select pg_get_functiondef('public.coverage_briefing_enqueue(uuid,boolean)'::regprocedure) into d;
  if strpos(d, 'tenant_notice_destination') = 0 then
    a := $a$    select s.destino into v_group_jid from public.dre_report_settings s
     where s.tenant_id = c.tenant_id and s.is_active and s.destino ~ '^[0-9]{10,25}@g[.]us$';$a$;
    b := $b$    v_group_jid := private.tenant_notice_destination(c.tenant_id, 'coordenacao');$b$;
    if strpos(d, a) = 0 then raise exception 'coverage_briefing_enqueue: âncora do destino não encontrada'; end if;
    execute replace(d, a, b);
  end if;
end;
$route_coverage$;

do $route_schedule_change$
declare d text; s int; e int; a text := '  -- Grupo da Gestão = o mesmo destino que a escola configurou para o DRE.'; z text := '  v_message := format(';
begin
  select pg_get_functiondef('public.teacher_apply_student_schedule_change'::regproc) into d;
  if strpos(d, 'tenant_notice_destination') = 0 then
    s := strpos(d, a); e := strpos(d, z);
    if s = 0 or e = 0 or e < s then raise exception 'teacher_apply_student_schedule_change: âncoras do destino não encontradas'; end if;
    d := left(d, s - 1)
      || E'  -- Troca de agenda vai ao canal de coordenação (sem grupo configurado, cai na Gestão).\n'
      || E'  v_group := private.tenant_notice_destination(v_tenant, ''coordenacao'');\n\n'
      || substr(d, e);
    execute d;
  end if;
end;
$route_schedule_change$;

-- ---------------------------------------------------------------------------
-- 7) Passivo visível: resumo por professor (semanal e sob demanda).
-- ---------------------------------------------------------------------------
create or replace function public.reschedule_backlog_summary(p_tenant text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := (pg_catalog.now() at time zone 'America/Sao_Paulo')::date;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not (auth.uid() is not null and public._my_tenant_id() = p_tenant
              and coalesce(public._my_role(), '') in ('SCHOOL_ADMIN', 'COORDINATOR', 'SUPER_ADMIN')) then
    raise exception using errcode = '42501', message = 'sem_permissao';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(row_to_json(x) order by x.sem_data desc, x.vencidas desc, x.professor)
    from (
      select t.full_name as professor, t.id as teacher_id,
        count(*) filter (where private.reschedule_slot_start(r.date, r.time) is null) as sem_data,
        count(*) filter (where private.reschedule_slot_start(r.date, r.time) is not null
                           and public.parse_lesson_date(r.date) < v_today) as vencidas,
        count(*) filter (where private.reschedule_slot_start(r.date, r.time) is not null
                           and public.parse_lesson_date(r.date) between v_today and v_today + 7) as marcadas_7d,
        min(r.created_at)::date as mais_antiga,
        count(*) filter (where r.fault_type = 'TEACHER') as por_falta_do_professor
      from public.reschedules r
      join public.profiles t on t.id = r.teacher_id
      where r.tenant_id = p_tenant and r.used_at is null and t.role = 'TEACHER'
        and lower(coalesce(t.lifecycle_status, 'active')) not in ('suspended', 'offboarded')
      group by t.id, t.full_name
    ) x
  ), '[]'::jsonb);
end;
$$;
alter function public.reschedule_backlog_summary(text) owner to postgres;
revoke all on function public.reschedule_backlog_summary(text) from public, anon;
grant execute on function public.reschedule_backlog_summary(text) to authenticated, service_role;

notify pgrst, 'reload schema';
