alter table public.ai_conversations
  add column if not exists product_family text,
  add column if not exists hub_account_id uuid;

update public.ai_conversations
set product_family = 'SCHOOL'
where product_family is null;

alter table public.ai_conversations
  alter column product_family set default 'SCHOOL',
  alter column product_family set not null;

do $migration$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.ai_conversations'::regclass
      and conname = 'ai_conversations_hub_account_id_fkey'
  ) then
    alter table public.ai_conversations
      add constraint ai_conversations_hub_account_id_fkey
      foreign key (hub_account_id)
      references public.hub_accounts(id)
      on delete restrict
      not valid;
  end if;
end;
$migration$;

alter table public.ai_conversations
  validate constraint ai_conversations_hub_account_id_fkey;

do $migration$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.ai_conversations'::regclass
      and conname = 'ai_conversations_product_scope_check'
  ) then
    alter table public.ai_conversations
      add constraint ai_conversations_product_scope_check
      check (
        (
          product_family = 'SCHOOL'
          and hub_account_id is null
        )
        or (
          product_family = 'HUB_CORE'
          and hub_account_id is not null
        )
      )
      not valid;
  end if;
end;
$migration$;

alter table public.ai_conversations
  validate constraint ai_conversations_product_scope_check;

create index if not exists idx_ai_conversations_hub_account_student_recent
  on public.ai_conversations (hub_account_id, student_id, created_at desc)
  where product_family = 'HUB_CORE';

comment on column public.ai_conversations.product_family is
  'Immutable persistence boundary. Legacy and school conversations use SCHOOL; Hub conversations use HUB_CORE.';

comment on column public.ai_conversations.hub_account_id is
  'Server-resolved Hub account for HUB_CORE conversations. Never accepted as conversation authority from the client.';

create or replace function private.enforce_ai_conversation_scope_immutable()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $function$
begin
  if new.student_id is distinct from old.student_id
     or new.product_family is distinct from old.product_family
     or new.hub_account_id is distinct from old.hub_account_id then
    raise exception 'ai conversation ownership and product scope are immutable'
      using errcode = '42501';
  end if;

  return new;
end;
$function$;

revoke all on function private.enforce_ai_conversation_scope_immutable()
  from public, anon, authenticated;

drop trigger if exists enforce_ai_conversation_scope_immutable
  on public.ai_conversations;

create trigger enforce_ai_conversation_scope_immutable
before update of student_id, product_family, hub_account_id
on public.ai_conversations
for each row
execute function private.enforce_ai_conversation_scope_immutable();

alter table public.ai_conversations enable row level security;

drop policy if exists "Alunos veem suas proprias conversas"
  on public.ai_conversations;
drop policy if exists ai_conversations_school_owner_read
  on public.ai_conversations;
drop policy if exists ai_conversations_private_hub_guard
  on public.ai_conversations;

create policy ai_conversations_school_owner_read
on public.ai_conversations
for select
to authenticated
using (
  student_id = (select auth.uid())
  and product_family = 'SCHOOL'
  and hub_account_id is null
);

create policy ai_conversations_private_hub_guard
on public.ai_conversations
as restrictive
for select
to authenticated
using (
  product_family = 'SCHOOL'
  and hub_account_id is null
);

alter table public.ai_messages enable row level security;

drop policy if exists "Users can view messages" on public.ai_messages;
drop policy if exists "Alunos veem mensagens" on public.ai_messages;
drop policy if exists ai_messages_owner_read on public.ai_messages;
drop policy if exists ai_messages_private_hub_guard on public.ai_messages;

create policy ai_messages_owner_read
on public.ai_messages
for select
to authenticated
using (
  exists (
    select 1
    from public.ai_conversations as conversation
    where conversation.id = ai_messages.conversation_id
      and conversation.student_id = (select auth.uid())
      and conversation.product_family = 'SCHOOL'
      and conversation.hub_account_id is null
  )
);

create policy ai_messages_private_hub_guard
on public.ai_messages
as restrictive
for select
to authenticated
using (
  exists (
    select 1
    from public.ai_conversations as conversation
    where conversation.id = ai_messages.conversation_id
      and conversation.product_family = 'SCHOOL'
      and conversation.hub_account_id is null
  )
);

revoke all on table public.ai_conversations from anon;
revoke all on table public.ai_messages from anon;
grant select on table public.ai_conversations to authenticated;
grant select on table public.ai_messages to authenticated;
