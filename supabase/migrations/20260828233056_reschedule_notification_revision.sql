-- Keeps every material reschedule edit addressable by a fresh, monotonic
-- notification identity. The value is owned by the database: callers cannot
-- replay an old revision or jump it forward themselves.

alter table public.reschedules
  add column if not exists notification_revision bigint not null default 1;

comment on column public.reschedules.notification_revision is
  'Monotonic database-owned revision. Increments when date, time, teacher or student changes.';

create or replace function private.bump_reschedule_notification_revision()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' then
    new.notification_revision := 1;
    return new;
  end if;

  if row(new.date, new.time, new.teacher_id, new.student_id)
       is distinct from
     row(old.date, old.time, old.teacher_id, old.student_id) then
    new.notification_revision := old.notification_revision + 1;
  else
    -- Also neutralizes an explicit UPDATE of notification_revision by a caller.
    new.notification_revision := old.notification_revision;
  end if;

  return new;
end;
$function$;

alter function private.bump_reschedule_notification_revision()
  owner to postgres;
revoke all on function private.bump_reschedule_notification_revision()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_reschedule_notification_revision
  on public.reschedules;
create trigger trg_reschedule_notification_revision
before insert or update
on public.reschedules
for each row
execute function private.bump_reschedule_notification_revision();

notify pgrst, 'reload schema';
