begin;

create schema if not exists private;
revoke all on schema private from public, anon;

-- Campos usados pelos agentes comerciais existiam no ambiente, mas não estavam
-- integralmente representados no histórico de migrations.
alter table public.crm_leads
  add column if not exists student_id uuid references public.profiles(id) on delete set null,
  add column if not exists ai_handled boolean not null default false,
  add column if not exists ai_handoff boolean not null default false,
  add column if not exists last_inbound_at timestamptz,
  add column if not exists last_outbound_at timestamptz,
  add column if not exists followup_count integer not null default 0,
  add column if not exists goal text,
  add column if not exists level text;

alter table public.tenants
  add column if not exists ai_team_config jsonb not null default '{}'::jsonb;

create table if not exists public.automation_sent (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  subject_id text not null,
  ref_date date not null default current_date,
  created_at timestamptz not null default now(),
  unique (kind, subject_id, ref_date)
);

create table if not exists public.ai_wa_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  phone text not null,
  agent text not null,
  direction text not null check (direction in ('in', 'out')),
  content text not null default '',
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ai_wa_messages_contact_history_idx
  on public.ai_wa_messages (tenant_id, phone, agent, created_at desc);

create table if not exists public.wa_inbound_seen (
  msg_id text primary key,
  phone text not null,
  created_at timestamptz not null default now()
);

create index if not exists wa_inbound_seen_created_at_idx
  on public.wa_inbound_seen (created_at);

alter table public.automation_sent enable row level security;
alter table public.ai_wa_messages enable row level security;
alter table public.wa_inbound_seen enable row level security;
revoke all on table public.automation_sent, public.ai_wa_messages,
  public.wa_inbound_seen from anon, authenticated;

create or replace function private.commercial_phones_match(
  left_phone text,
  right_phone text
)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  left_digits text := regexp_replace(coalesce(left_phone, ''), '\D', '', 'g');
  right_digits text := regexp_replace(coalesce(right_phone, ''), '\D', '', 'g');
  left_prefix text;
  right_prefix text;
  left_ddd text;
  right_ddd text;
begin
  if length(left_digits) < 10 or length(right_digits) < 10 then
    return false;
  end if;
  if right(left_digits, 8) <> right(right_digits, 8) then
    return false;
  end if;

  left_prefix := left(left_digits, length(left_digits) - 8);
  right_prefix := left(right_digits, length(right_digits) - 8);
  left_prefix := regexp_replace(left_prefix, '^55', '');
  right_prefix := regexp_replace(right_prefix, '^55', '');
  left_prefix := regexp_replace(left_prefix, '9$', '');
  right_prefix := regexp_replace(right_prefix, '9$', '');
  left_ddd := right(left_prefix, 2);
  right_ddd := right(right_prefix, 2);

  return length(left_ddd) = 2
    and length(right_ddd) = 2
    and left_ddd = right_ddd;
end;
$function$;

revoke all on function private.commercial_phones_match(text, text)
  from public, anon, authenticated;

create or replace function private.reconcile_student_commercial_state()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $function$
begin
  if upper(coalesce(new.role, '')) <> 'STUDENT'
     or new.contract_accepted is not true
     or new.tenant_id is null then
    return new;
  end if;

  update public.crm_leads as lead
     set status = 'WON',
         student_id = new.id,
         ai_handoff = true,
         last_status_change = clock_timestamp()
   where lead.tenant_id = new.tenant_id
     and (
       lead.student_id = new.id
       or (
         nullif(lower(btrim(lead.email)), '') is not null
         and lower(btrim(lead.email)) = lower(btrim(new.email))
       )
       or private.commercial_phones_match(lead.phone, new.phone)
     )
     and upper(coalesce(lead.status, '')) not in ('CONVERTED', 'WON');

  return new;
end;
$function$;

revoke all on function private.reconcile_student_commercial_state()
  from public, anon, authenticated;

drop trigger if exists reconcile_student_commercial_state on public.profiles;
create trigger reconcile_student_commercial_state
after insert or update of role, tenant_id, phone, email, contract_accepted
on public.profiles
for each row
execute function private.reconcile_student_commercial_state();

-- Repara cartões históricos que ficaram em NEW/CONTACTED/TRIAL_DONE mesmo após
-- a assinatura. Essa divergência era a principal origem do contexto falso do SDR.
update public.crm_leads as lead
   set status = 'WON',
       student_id = student.id,
       ai_handoff = true,
       last_status_change = clock_timestamp()
  from public.profiles as student
 where student.tenant_id = lead.tenant_id
   and upper(coalesce(student.role, '')) = 'STUDENT'
   and student.contract_accepted is true
   and (
     lead.student_id = student.id
     or (
       nullif(lower(btrim(lead.email)), '') is not null
       and lower(btrim(lead.email)) = lower(btrim(student.email))
     )
     or private.commercial_phones_match(lead.phone, student.phone)
   )
   and upper(coalesce(lead.status, '')) not in ('CONVERTED', 'WON');

-- Consolida o vocabulário do funil: WON é o estado canônico no CRM principal.
update public.crm_leads
   set status = 'WON',
       last_status_change = coalesce(last_status_change, clock_timestamp())
 where upper(coalesce(status, '')) = 'CONVERTED';

create or replace function public.set_ai_team_config(p_config jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  actor public.profiles%rowtype;
begin
  select * into actor
    from public.profiles
   where id = (select auth.uid());

  if actor.id is null
     or actor.tenant_id is null
     or actor.role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN') then
    return jsonb_build_object('ok', false, 'error', 'SEM_PERMISSAO');
  end if;
  if p_config is null
     or jsonb_typeof(p_config) <> 'object'
     or pg_column_size(p_config) > 30000 then
    return jsonb_build_object('ok', false, 'error', 'CONFIG_INVALIDA');
  end if;

  update public.tenants
     set ai_team_config = p_config
   where id = actor.tenant_id;

  return jsonb_build_object('ok', found);
end;
$function$;

revoke all on function public.set_ai_team_config(jsonb) from public, anon;
grant execute on function public.set_ai_team_config(jsonb) to authenticated;

commit;
