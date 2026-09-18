-- Etapa 2 da reposição e dos grupos por canal (direção, 18/09/2026).
--
--   1. Professor marca/remarca/desmarca reposição pelo WhatsApp da escola
--      ("a reposição do Theo passou para terça 15h"): proposta + "confirma?" +
--      aplicação agindo como o professor, pela MESMA RPC da tela
--      (`schedule_reschedule` / `unschedule_reschedule`), com origem
--      `whatsapp_professor` na trilha. Uma proposta pendente por professor,
--      2 h de validade — mesmo desenho da troca de horário (20260917190000).
--   2. Grupos por canal também RECEBEM comandos: o bot passa a ouvir o grupo de
--      Coordenação (cobertura, cobertura do dia, transferência, reposições) e o
--      de Comercial (só consulta), além do da Gestão. A autorização de execução
--      (`management_group_execution_authorized`) e a inbox
--      (`whatsapp_inbox_remote_jid_is_allowed`) reconhecem os canais.
--   3. Passivo de reposição: `reschedule_overdue_rows` (data passou, sem
--      lançamento) para a cobrança diária e `reschedule_backlog_summary` para o
--      resumo de segunda.
--   4. `comercial` cai em `profiles.directors_group_id` ("EXPERIMENTAL
--      CONFIRMADAS") antes de cair na Gestão — é o grupo que já recebe aceite
--      de experimental.

-- ---------------------------------------------------------------------------
-- 1) Proposta do professor (reposição) pelo WhatsApp
-- ---------------------------------------------------------------------------
create table if not exists public.teacher_reschedule_prompts (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  teacher_id uuid not null,
  phone text not null,
  proposal jsonb not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'APPLIED', 'FAILED', 'CANCELLED', 'EXPIRED')),
  result jsonb,
  expires_at timestamptz not null default now() + interval '2 hours',
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create unique index if not exists uq_teacher_reschedule_prompt_pending
  on public.teacher_reschedule_prompts (tenant_id, teacher_id) where status = 'PENDING';
alter table public.teacher_reschedule_prompts enable row level security;
alter table public.teacher_reschedule_prompts owner to postgres;
revoke all on public.teacher_reschedule_prompts from public, anon, authenticated;
grant select, insert, update on public.teacher_reschedule_prompts to service_role;

-- Reposições ABERTAS do professor cujo aluno bate com o nome escrito (prefixo de
-- qualquer nome, sem acento). Dois alunos com o mesmo nome voltam os dois e o
-- bot pergunta qual. Sem nome ("minha reposição de hoje") devolve todas.
create or replace function public.teacher_reschedule_candidates(p_tenant text, p_teacher uuid, p_names jsonb)
returns jsonb language sql stable security definer set search_path = '' as $$
  with pedidos as (
    select ordinality as idx, public.fold_accents(btrim(value #>> '{}')) as nome
      from pg_catalog.jsonb_array_elements(coalesce(p_names, '[]'::jsonb)) with ordinality
  ),
  reposicoes as (
    select r.id, r.student_id, s.full_name, public.fold_accents(s.full_name) as nome_norm,
           r.date, left(coalesce(r.time, ''), 5) as time, r.fault_type,
           private.reschedule_slot_start(r.date, r.time) is not null as marcada
      from public.reschedules r
      join public.profiles s on s.id = r.student_id
     where r.tenant_id = p_tenant and r.teacher_id = p_teacher and r.used_at is null
       and lower(coalesce(s.lifecycle_status, 'active')) = 'active'
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'idx', p.idx, 'name', p.nome,
    'matches', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'student_id', x.student_id, 'student_name', x.full_name,
        'reschedules', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', y.id, 'date', y.date, 'time', y.time, 'fault_type', y.fault_type, 'marcada', y.marcada)
            order by y.marcada desc, y.date, y.time)
          from reposicoes y where y.student_id = x.student_id)
      ) order by x.full_name)
      from (select distinct r.student_id, r.full_name, r.nome_norm from reposicoes r) x
      where p.nome = '' or x.nome_norm = p.nome or x.nome_norm like p.nome || '%' or x.nome_norm like '% ' || p.nome || '%'
    ), '[]'::jsonb)
  ) order by p.idx), '[]'::jsonb)
  from pedidos p;
$$;
alter function public.teacher_reschedule_candidates(text, uuid, jsonb) owner to postgres;
revoke all on function public.teacher_reschedule_candidates(text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.teacher_reschedule_candidates(text, uuid, jsonb) to service_role;

create or replace function public.teacher_reschedule_prompt_open(p_tenant text, p_teacher uuid, p_phone text, p_proposal jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.role() <> 'service_role' then raise exception using errcode = '42501', message = 'service_role_required'; end if;
  update public.teacher_reschedule_prompts set status = 'CANCELLED', resolved_at = pg_catalog.now()
   where tenant_id = p_tenant and teacher_id = p_teacher and status = 'PENDING';
  insert into public.teacher_reschedule_prompts (tenant_id, teacher_id, phone, proposal)
  values (p_tenant, p_teacher, p_phone, p_proposal) returning id into v_id;
  return v_id;
end $$;
create or replace function public.teacher_reschedule_prompt_pending(p_tenant text, p_teacher uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object('id', t.id, 'proposal', t.proposal, 'expires_at', t.expires_at)
    from public.teacher_reschedule_prompts t
   where t.tenant_id = p_tenant and t.teacher_id = p_teacher and t.status = 'PENDING' and t.expires_at > pg_catalog.now()
   order by t.created_at desc limit 1;
$$;
create or replace function public.teacher_reschedule_prompt_cancel(p_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() <> 'service_role' then raise exception using errcode = '42501', message = 'service_role_required'; end if;
  update public.teacher_reschedule_prompts set status = 'CANCELLED', resolved_at = pg_catalog.now() where id = p_id and status = 'PENDING';
  return found;
end $$;

-- Aplica agindo como o professor (mesmo truque da troca de horário): a RPC da
-- tela lê auth.uid(). A origem na trilha fica `whatsapp_professor`; o motivo é o
-- que ele escreveu ("sim, aluno pediu") ou, se não escreveu, o texto do pedido.
create or replace function public.teacher_reschedule_prompt_apply(p_id uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  t public.teacher_reschedule_prompts%rowtype;
  v_item jsonb;
  v_results jsonb := '[]'::jsonb;
  v_errors jsonb := '[]'::jsonb;
  v_result jsonb;
  v_reason text;
begin
  if auth.role() <> 'service_role' then raise exception using errcode = '42501', message = 'service_role_required'; end if;
  select * into t from public.teacher_reschedule_prompts where id = p_id and status = 'PENDING' for update;
  if not found then return pg_catalog.jsonb_build_object('ok', false, 'error', 'proposta_nao_encontrada'); end if;
  if t.expires_at <= pg_catalog.now() then
    update public.teacher_reschedule_prompts set status = 'EXPIRED', resolved_at = pg_catalog.now() where id = t.id;
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'proposta_expirada');
  end if;
  if not exists (select 1 from public.tenant_memberships m join public.profiles p on p.id = m.user_id
                  where m.user_id = t.teacher_id and m.tenant_id = t.tenant_id and m.role = 'TEACHER' and m.status = 'ACTIVE'
                    and lower(coalesce(p.lifecycle_status, 'active')) = 'active') then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'professor_inativo');
  end if;
  v_reason := left(btrim(coalesce(nullif(btrim(p_reason), ''), t.proposal ->> 'reason', 'pedido do professor pelo WhatsApp da escola')), 300);

  perform private.trial_closing_act_as(t.teacher_id);
  for v_item in select value from pg_catalog.jsonb_array_elements(t.proposal -> 'items') loop
    begin
      perform pg_catalog.set_config('app.reschedule_source', 'whatsapp_professor', true);
      if (v_item ->> 'action') = 'desmarcar' then
        v_result := public.unschedule_reschedule((v_item ->> 'reschedule_id')::uuid, v_reason);
      else
        v_result := public.schedule_reschedule((v_item ->> 'reschedule_id')::uuid,
          (v_item ->> 'date')::date, (v_item ->> 'time')::time, v_reason);
      end if;
      v_results := v_results || pg_catalog.jsonb_build_array(v_item || pg_catalog.jsonb_build_object('result', v_result));
    exception when others then
      v_errors := v_errors || pg_catalog.jsonb_build_array(v_item || pg_catalog.jsonb_build_object('error', left(sqlerrm, 200)));
    end;
  end loop;
  perform pg_catalog.set_config('app.reschedule_source', '', true);

  update public.teacher_reschedule_prompts
     set status = case when pg_catalog.jsonb_array_length(v_results) > 0 then 'APPLIED' else 'FAILED' end,
         result = pg_catalog.jsonb_build_object('applied', v_results, 'errors', v_errors, 'reason', v_reason),
         resolved_at = pg_catalog.now()
   where id = t.id;
  return pg_catalog.jsonb_build_object('ok', pg_catalog.jsonb_array_length(v_results) > 0,
    'applied', v_results, 'errors', v_errors, 'reason', v_reason);
end $$;
alter function public.teacher_reschedule_prompt_open(text, uuid, text, jsonb) owner to postgres;
alter function public.teacher_reschedule_prompt_pending(text, uuid) owner to postgres;
alter function public.teacher_reschedule_prompt_cancel(uuid) owner to postgres;
alter function public.teacher_reschedule_prompt_apply(uuid, text) owner to postgres;
revoke all on function public.teacher_reschedule_prompt_open(text, uuid, text, jsonb),
  public.teacher_reschedule_prompt_pending(text, uuid), public.teacher_reschedule_prompt_cancel(uuid),
  public.teacher_reschedule_prompt_apply(uuid, text) from public, anon, authenticated;
grant execute on function public.teacher_reschedule_prompt_open(text, uuid, text, jsonb),
  public.teacher_reschedule_prompt_pending(text, uuid), public.teacher_reschedule_prompt_cancel(uuid),
  public.teacher_reschedule_prompt_apply(uuid, text) to service_role;

-- `schedule_reschedule` respeita origem já definida na transação (o bot marca
-- `whatsapp_professor`); sem ela, continua `app` (professor) ou `direcao`.
do $respect_source$
declare d text;
begin
  select pg_get_functiondef('public.schedule_reschedule(uuid,date,time without time zone,text)'::regprocedure) into d;
  if strpos(d, $a$coalesce(nullif(pg_catalog.current_setting('app.reschedule_source', true), ''),$a$) = 0 then
    if strpos(d, $b$  perform pg_catalog.set_config('app.reschedule_source',
    case when v_actor_role = 'TEACHER' then 'app' else 'direcao' end, true);$b$) = 0 then
      raise exception 'schedule_reschedule: âncora da origem não encontrada';
    end if;
    execute replace(d,
      $b$  perform pg_catalog.set_config('app.reschedule_source',
    case when v_actor_role = 'TEACHER' then 'app' else 'direcao' end, true);$b$,
      $c$  perform pg_catalog.set_config('app.reschedule_source',
    coalesce(nullif(pg_catalog.current_setting('app.reschedule_source', true), ''),
      case when v_actor_role = 'TEACHER' then 'app' else 'direcao' end), true);$c$);
  end if;
  select pg_get_functiondef('public.unschedule_reschedule(uuid,text)'::regprocedure) into d;
  if strpos(d, $a$coalesce(nullif(pg_catalog.current_setting('app.reschedule_source', true), ''),$a$) = 0 then
    if strpos(d, $b$  perform pg_catalog.set_config('app.reschedule_source',
    case when v_actor_role = 'TEACHER' then 'app' else 'direcao' end, true);$b$) = 0 then
      raise exception 'unschedule_reschedule: âncora da origem não encontrada';
    end if;
    execute replace(d,
      $b$  perform pg_catalog.set_config('app.reschedule_source',
    case when v_actor_role = 'TEACHER' then 'app' else 'direcao' end, true);$b$,
      $c$  perform pg_catalog.set_config('app.reschedule_source',
    coalesce(nullif(pg_catalog.current_setting('app.reschedule_source', true), ''),
      case when v_actor_role = 'TEACHER' then 'app' else 'direcao' end), true);$c$);
  end if;
end;
$respect_source$;

-- ---------------------------------------------------------------------------
-- 2) Canais: comercial cai no grupo de avisos de leads; grupos por canal
--    recebem comandos (autorização e inbox)
-- ---------------------------------------------------------------------------
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
    when p_channel = 'comercial' then
      -- "Grupo de Avisos (Leads / Aceites)": já recebe experimental aceita.
      (select nullif(btrim(p.directors_group_id), '')
         from public.profiles p
        where p.tenant_id = p_tenant and p.role in ('SCHOOL_ADMIN', 'SUPER_ADMIN')
          and nullif(btrim(p.directors_group_id), '') ~ '^[0-9]{10,25}(-[0-9]+)?@g[.]us$'
        order by case when p.role = 'SCHOOL_ADMIN' then 0 else 1 end, p.created_at
        limit 1)
    end,
    private.management_group_destination(p_tenant)
  );
$$;

-- Os JIDs por canal, para o bot decidir de onde aceita comandos e qual o escopo.
create or replace function public.notice_channel_jids(p_tenant text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when coalesce(auth.role(), '') = 'service_role' then pg_catalog.jsonb_build_object(
    'gestao', private.management_group_destination(p_tenant),
    'direcao', private.tenant_notice_destination(p_tenant, 'direcao'),
    'coordenacao', private.tenant_notice_destination(p_tenant, 'coordenacao'),
    'comercial', private.tenant_notice_destination(p_tenant, 'comercial'),
    'professores', private.tenant_notice_destination(p_tenant, 'professores')
  ) end;
$$;
alter function public.notice_channel_jids(text) owner to postgres;
revoke all on function public.notice_channel_jids(text) from public, anon, authenticated;
grant execute on function public.notice_channel_jids(text) to service_role;

create or replace function public.notice_channel_destination(p_tenant text, p_channel text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when coalesce(auth.role(), '') = 'service_role'
    then private.tenant_notice_destination(p_tenant, p_channel) end;
$$;
alter function public.notice_channel_destination(text, text) owner to postgres;
revoke all on function public.notice_channel_destination(text, text) from public, anon, authenticated;
grant execute on function public.notice_channel_destination(text, text) to service_role;

-- Grupo autorizado a falar com o bot: o da Gestão (como sempre) ou um canal
-- configurado (coordenação, comercial, direção).
create or replace function private.management_group_jid_is_authorized(p_tenant text, p_jid text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select nullif(btrim(coalesce(p_jid, '')), '') is not null and (
    exists (select 1 from public.dre_report_settings s
             where s.tenant_id = p_tenant and s.is_active is true
               and lower(btrim(s.destino)) = lower(btrim(p_jid)))
    or exists (select 1 from public.tenant_notice_channels c
                where c.tenant_id = p_tenant and c.enabled and c.group_jid is not null
                  and lower(btrim(c.group_jid)) = lower(btrim(p_jid))
                  and c.channel in ('direcao', 'coordenacao', 'comercial'))
  );
$$;
alter function private.management_group_jid_is_authorized(text, text) owner to postgres;
revoke all on function private.management_group_jid_is_authorized(text, text) from public, anon, authenticated;
grant execute on function private.management_group_jid_is_authorized(text, text) to postgres, service_role;

create or replace function private.management_group_execution_authorized(
  p_tenant text, p_actor_id uuid, p_request_id text, p_expected jsonb, p_group_jid text default null
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(auth.role(), '') = 'service_role' and exists (
    select 1 from public.gestao_acao_pendente p
    join public.dre_report_settings c on c.tenant_id = p.tenant_id
    where c.is_active and c.allow_group_member_actions
      and private.management_group_jid_is_authorized(p.tenant_id, p.group_jid)
      and p.tenant_id = p_tenant and p.request_id = p_request_id
      and (p_group_jid is null or p.group_jid = p_group_jid)
      and p.status = 'executing' and p.schema_version = 1
      and p.requested_by_user_id is not distinct from p_actor_id
      and p.confirmed_by_user_id is not distinct from p_actor_id
      and p.requested_by_jid ~ '^[0-9]{6,20}@(lid|s\.whatsapp\.net)$'
      and p.confirmed_by_jid = p.requested_by_jid
      and p.confirmed_at <= p.expires_at
      and p.updated_at > now() - interval '2 minutes'
      and p.acao @> p_expected
  );
$function$;

create or replace function private.whatsapp_inbox_remote_jid_is_allowed(p_tenant_id text, p_remote_jid text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when nullif(pg_catalog.btrim(p_tenant_id), '') is null
      or nullif(pg_catalog.btrim(p_remote_jid), '') is null then false
    when lower(pg_catalog.btrim(p_remote_jid)) ~ '^[0-9]{10,15}@s[.]whatsapp[.]net$' then true
    when lower(pg_catalog.btrim(p_remote_jid)) like '%@g.us'
      then private.management_group_jid_is_authorized(p_tenant_id, p_remote_jid)
    else false
  end;
$function$;

-- ---------------------------------------------------------------------------
-- 3) Reposição vencida: data passou (ontem ou antes) e ninguém lançou.
-- ---------------------------------------------------------------------------
create or replace function public.reschedule_overdue_rows(p_tenant text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when coalesce(auth.role(), '') = 'service_role' then coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'reschedule_id', r.id, 'date', r.date, 'time', left(r.time, 5), 'fault_type', r.fault_type,
      'teacher_id', t.id, 'teacher_name', t.full_name,
      'teacher_phone', private.whatsapp_digits(coalesce(nullif(t.attendance_phone, ''), t.phone)),
      'student_id', s.id, 'student_name', s.full_name
    ) order by t.full_name, r.date, r.time)
    from public.reschedules r
    join public.profiles t on t.id = r.teacher_id
    join public.profiles s on s.id = r.student_id
    where r.tenant_id = p_tenant and r.used_at is null
      and private.reschedule_slot_start(r.date, r.time) is not null
      and public.parse_lesson_date(r.date) < (pg_catalog.now() at time zone 'America/Sao_Paulo')::date
      and public.parse_lesson_date(r.date) >= (pg_catalog.now() at time zone 'America/Sao_Paulo')::date - 30
      and t.role = 'TEACHER' and lower(coalesce(t.lifecycle_status, 'active')) = 'active'
      and coalesce(t.is_test_account, false) = false
      and not exists (select 1 from public.class_logs l where l.reschedule_id = r.id::text)
  ), '[]'::jsonb) end;
$$;
alter function public.reschedule_overdue_rows(text) owner to postgres;
revoke all on function public.reschedule_overdue_rows(text) from public, anon, authenticated;
grant execute on function public.reschedule_overdue_rows(text) to service_role;

notify pgrst, 'reload schema';
