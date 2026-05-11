-- 1. Create Notification Queue Table
create table if not exists public.notification_queue (
  id uuid default gen_random_uuid() primary key,
  tenant_id text not null,
  teacher_id uuid references public.profiles(id),
  student_id uuid references public.profiles(id),
  student_name text,
  student_phone text not null,
  message_body text not null,
  scheduled_for timestamptz not null,
  status text default 'pending' check (status in ('pending', 'processing', 'sent', 'failed')),
  attempts int default 0,
  last_error text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 2. Add Automation Preferences to Profiles (if not exists)
-- We'll use a jsonb column for flexibility
alter table public.profiles 
add column if not exists date_automation_enabled boolean default true;

-- 3. RLS Policies for Queue (Admin/Teacher access)
alter table public.notification_queue enable row level security;

create policy "Admins can manage queue"
  on public.notification_queue for all
  using (
    tenant_id = (select tenant_id from profiles where id = auth.uid())
    and 
    exists (select 1 from profiles where id = auth.uid() and role in ('SUPER_ADMIN', 'SCHOOL_ADMIN'))
  );

create policy "Teachers can view their own queue"
  on public.notification_queue for select
  using (
    teacher_id = auth.uid()
  );

-- 4. Index for performance
create index if not exists idx_queue_poll 
on public.notification_queue (status, scheduled_for)
where status = 'pending';
