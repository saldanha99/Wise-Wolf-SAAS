-- Migration: Permitir que Diretor e Professor Responsável alterem Status e Nível Pedagógico
-- com blindagem estrita de dados sensíveis (CPF, e-mail, preço) para professores.

create table if not exists public.pedagogical_placement_audit (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  actor_id uuid not null references public.profiles(id) on delete cascade,
  previous_module text,
  previous_book_part text,
  new_module text not null,
  new_book_part text not null,
  reason text not null,
  created_at timestamptz not null default now()
);

alter table public.pedagogical_placement_audit enable row level security;
grant all on table public.pedagogical_placement_audit to service_role;
grant select on table public.pedagogical_placement_audit to authenticated;

create or replace function public.set_student_pedagogical_placement(
  p_student_id uuid,
  p_module text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid := auth.uid();
  v_actor record;
  v_student record;
  v_module text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_module, '')));
  v_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  v_book_part text;
begin
  if v_actor_id is null or p_student_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if v_module not in ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')
     or v_reason is null
     or pg_catalog.length(v_reason) not between 5 and 500 then
    raise exception using errcode = '22023', message = 'invalid_pedagogical_placement';
  end if;

  select profile.role, profile.tenant_id
    into v_actor
    from public.profiles as profile
   where profile.id = v_actor_id;
  if not found
     or v_actor.role not in (
       'TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR'
     ) then
    raise exception using errcode = '42501', message = 'staff_role_required';
  end if;

  select
    profile.id,
    profile.role,
    profile.tenant_id,
    profile.module,
    profile.current_book_part,
    profile.lifecycle_status,
    profile.status
    into v_student
    from public.profiles as profile
   where profile.id = p_student_id
   for update;
  if not found
     or v_student.role <> 'STUDENT'
     or v_student.tenant_id is null then
    raise exception using errcode = '42501', message = 'student_not_available';
  end if;

  if v_actor.role = 'SUPER_ADMIN' then
    null;
  elsif v_actor.tenant_id is null
        or v_actor.tenant_id <> v_student.tenant_id then
    raise exception using errcode = '42501', message = 'student_not_available';
  elsif v_actor.role = 'TEACHER'
        and not public._teacher_can_access_student(
          p_student_id,
          v_student.tenant_id
        ) then
    raise exception using errcode = '42501', message = 'teacher_student_link_required';
  end if;

  -- Reapplying the same placement is a true no-op: ordinary profile edits must
  -- never send a student from part 2 back to part 1 or clear an evaluation that
  -- was already released. Only a real module change starts its first published
  -- milestone. Advanced CEFR badges without a published milestone keep the
  -- existing COMPLETED convention instead of inventing `${module}-1`.
  if pg_catalog.upper(pg_catalog.btrim(coalesce(v_student.module, ''))) = v_module
     and nullif(
       pg_catalog.btrim(coalesce(v_student.current_book_part, '')),
       ''
     ) is not null then
    v_book_part := pg_catalog.btrim(v_student.current_book_part);
  else
    select catalog.book_part
      into v_book_part
      from public.pedagogical_evaluation_catalog as catalog
     where catalog.module = v_module
       and catalog.active is true
     order by catalog.part asc
     limit 1;
    if not found then
      v_book_part := 'COMPLETED';
    end if;
  end if;

  if pg_catalog.upper(pg_catalog.btrim(coalesce(v_student.module, ''))) = v_module
     and coalesce(v_student.current_book_part, '') = v_book_part then
    return pg_catalog.jsonb_build_object(
      'studentId', p_student_id,
      'module', v_module,
      'bookPart', v_book_part,
      'alreadyApplied', true
    );
  end if;

  update public.profiles
     set module = v_module,
         current_book_part = v_book_part,
         evaluation_unlocked = false,
         unlocked_tests = '{}'::text[]
   where id = p_student_id;

  insert into public.pedagogical_placement_audit (
    tenant_id,
    student_id,
    actor_id,
    previous_module,
    previous_book_part,
    new_module,
    new_book_part,
    reason
  ) values (
    v_student.tenant_id,
    p_student_id,
    v_actor_id,
    v_student.module,
    v_student.current_book_part,
    v_module,
    v_book_part,
    v_reason
  );

  return pg_catalog.jsonb_build_object(
    'studentId', p_student_id,
    'module', v_module,
    'bookPart', v_book_part,
    'alreadyApplied', false
  );
end;
$function$;

alter function public.set_student_pedagogical_placement(uuid, text, text) owner to postgres;
revoke all on function public.set_student_pedagogical_placement(uuid, text, text) from public, anon;
grant execute on function public.set_student_pedagogical_placement(uuid, text, text) to authenticated;

-- RPC para alteração de status do aluno por Diretor ou Professor Responsável
create or replace function public.set_student_academic_status(
  p_student_id uuid,
  p_status text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid := auth.uid();
  v_actor record;
  v_student record;
  v_clean_status text := pg_catalog.btrim(coalesce(p_status, ''));
  v_target_status text;
  v_target_lifecycle text;
begin
  if v_actor_id is null or p_student_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  -- Normaliza status aceitos
  if pg_catalog.lower(v_clean_status) in ('ativo', 'active') then
    v_target_status := 'Ativo';
    v_target_lifecycle := 'active';
  elsif pg_catalog.lower(v_clean_status) in ('inativo', 'inactive', 'pausado', 'suspended', 'pausa temporária') then
    v_target_status := 'Inativo';
    v_target_lifecycle := 'suspended';
  elsif pg_catalog.lower(v_clean_status) in ('trancado', 'locked') then
    v_target_status := 'Inativo';
    v_target_lifecycle := 'suspended';
  else
    raise exception using errcode = '22023', message = 'invalid_student_status';
  end if;

  select profile.role, profile.tenant_id
    into v_actor
    from public.profiles as profile
   where profile.id = v_actor_id;

  if not found or v_actor.role not in ('TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR') then
    raise exception using errcode = '42501', message = 'staff_role_required';
  end if;

  select
    profile.id,
    profile.role,
    profile.tenant_id,
    profile.status,
    profile.lifecycle_status
    into v_student
    from public.profiles as profile
   where profile.id = p_student_id
   for update;

  if not found or v_student.role <> 'STUDENT' or v_student.tenant_id is null then
    raise exception using errcode = '42501', message = 'student_not_found';
  end if;

  if v_actor.role = 'SUPER_ADMIN' then
    null;
  elsif v_actor.tenant_id is null or v_actor.tenant_id <> v_student.tenant_id then
    raise exception using errcode = '42501', message = 'student_not_available';
  elsif v_actor.role = 'TEACHER' and not public._teacher_can_access_student(p_student_id, v_student.tenant_id) then
    raise exception using errcode = '42501', message = 'teacher_student_link_required';
  end if;

  -- Se for pausar/inativar, cancela bookings futuros agendados para liberar os horários
  if v_target_lifecycle = 'suspended' then
    update public.bookings
       set status = 'CANCELLED'
     where student_id = p_student_id
       and tenant_id = v_student.tenant_id
       and status in ('SCHEDULED', 'scheduled')
       and start_date >= CURRENT_DATE;
  end if;

  update public.profiles
     set status = v_target_status,
         lifecycle_status = v_target_lifecycle
   where id = p_student_id;

  return pg_catalog.jsonb_build_object(
    'studentId', p_student_id,
    'status', v_target_status,
    'lifecycleStatus', v_target_lifecycle,
    'updatedBy', v_actor_id,
    'actorRole', v_actor.role
  );
end;
$function$;

alter function public.set_student_academic_status(uuid, text, text) owner to postgres;
revoke all on function public.set_student_academic_status(uuid, text, text) from public, anon;
grant execute on function public.set_student_academic_status(uuid, text, text) to authenticated;

-- RPC para atualização unificada pedagógica do perfil do aluno
-- Professores têm acesso a Nome, WhatsApp, Status, Nível, Interesses, Ocupação, Notas Pedagógicas e Horário.
-- Dados sensíveis (CPF, e-mail, preço/mensalidade, endereço) são estritamente bloqueados para professores.
create or replace function public.update_student_pedagogical_profile(
  p_student_id uuid,
  p_data jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid := auth.uid();
  v_actor record;
  v_student record;
  v_is_director boolean;
  v_status_res jsonb;
  v_placement_res jsonb;
  v_requested_module text;
  v_requested_status text;
begin
  if v_actor_id is null or p_student_id is null or p_data is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  select profile.role, profile.tenant_id
    into v_actor
    from public.profiles as profile
   where profile.id = v_actor_id;

  if not found or v_actor.role not in ('TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN', 'COORDINATOR') then
    raise exception using errcode = '42501', message = 'staff_role_required';
  end if;

  select
    profile.id,
    profile.role,
    profile.tenant_id,
    profile.module,
    profile.status,
    profile.lifecycle_status,
    profile.accepted_at,
    profile.documentation_status
    into v_student
    from public.profiles as profile
   where profile.id = p_student_id
   for update;

  if not found or v_student.role <> 'STUDENT' or v_student.tenant_id is null then
    raise exception using errcode = '42501', message = 'student_not_found';
  end if;

  v_is_director := v_actor.role in ('SCHOOL_ADMIN', 'SUPER_ADMIN');

  if not v_is_director then
    if v_actor.tenant_id is null or v_actor.tenant_id <> v_student.tenant_id then
      raise exception using errcode = '42501', message = 'student_not_available';
    end if;
    if not public._teacher_can_access_student(p_student_id, v_student.tenant_id) then
      raise exception using errcode = '42501', message = 'teacher_student_link_required';
    end if;

    -- Blindagem estrita: Professor NÃO PODE alterar CPF, Email, Preço ou Endereço
    if p_data ? 'cpf' or p_data ? 'email' or p_data ? 'monthly_fee' or p_data ? 'due_day' 
       or p_data ? 'address' or p_data ? 'postal_code' or p_data ? 'guardian_cpf' 
       or p_data ? 'guardian_email' or p_data ? 'status_financial' or p_data ? 'professor_id' then
      raise exception using errcode = '42501', message = 'teachers_cannot_modify_sensitive_or_financial_fields';
    end if;
  end if;

  -- 1. Atualizar campos pedagógicos seguros e permitidos
  update public.profiles
     set full_name = case 
           when p_data ? 'full_name' and pg_catalog.length(pg_catalog.btrim(p_data ->> 'full_name')) > 0 
           then pg_catalog.btrim(p_data ->> 'full_name')
           else public.profiles.full_name 
         end,
         phone = case 
           when p_data ? 'phone' then nullif(pg_catalog.btrim(p_data ->> 'phone'), '')
           else public.profiles.phone 
         end,
         attendance_phone = case 
           when p_data ? 'attendance_phone' then nullif(pg_catalog.btrim(p_data ->> 'attendance_phone'), '')
           else public.profiles.attendance_phone 
         end,
         meeting_link = case 
           when p_data ? 'meeting_link' then nullif(pg_catalog.btrim(p_data ->> 'meeting_link'), '')
           else public.profiles.meeting_link 
         end,
         occupation = case 
           when p_data ? 'occupation' then nullif(pg_catalog.btrim(p_data ->> 'occupation'), '')
           else public.profiles.occupation 
         end,
         interests = case 
           when p_data ? 'interests' and jsonb_typeof(p_data -> 'interests') = 'array'
           then (select array_agg(value::text) from jsonb_array_elements_text(p_data -> 'interests'))
           else public.profiles.interests 
         end,
         private_notes = case 
           when p_data ? 'private_notes' then nullif(pg_catalog.btrim(p_data ->> 'private_notes'), '')
           else public.profiles.private_notes 
         end,
         fixed_schedule = case 
           when p_data ? 'fixed_schedule' then nullif(pg_catalog.btrim(p_data ->> 'fixed_schedule'), '')
           else public.profiles.fixed_schedule 
         end,
         is_kids = case 
           when p_data ? 'is_kids' then (p_data ->> 'is_kids')::boolean
           else public.profiles.is_kids 
         end
   where id = p_student_id;

  -- 2. Atualizar campos exclusivos de Diretor (se enviados)
  if v_is_director then
    -- Se contrato não foi aprovado/aceito, permite editar dados cadastrais e financeiros
    if not (coalesce(v_student.accepted_at, null) is not null or v_student.documentation_status = 'APPROVED') then
      update public.profiles
         set cpf = case when p_data ? 'cpf' then nullif(regexp_replace(p_data ->> 'cpf', '[^0-9]', '', 'g'), '') else public.profiles.cpf end,
             postal_code = case when p_data ? 'postal_code' then nullif(p_data ->> 'postal_code', '') else public.profiles.postal_code end,
             address = case when p_data ? 'address' then nullif(p_data ->> 'address', '') else public.profiles.address end,
             address_number = case when p_data ? 'address_number' then nullif(p_data ->> 'address_number', '') else public.profiles.address_number end,
             monthly_fee = case when p_data ? 'monthly_fee' then (p_data ->> 'monthly_fee')::numeric else public.profiles.monthly_fee end,
             due_day = case when p_data ? 'due_day' then (p_data ->> 'due_day')::integer else public.profiles.due_day end
       where id = p_student_id;
    end if;

    if p_data ? 'professor_id' then
      update public.profiles
         set professor_id = nullif(p_data ->> 'professor_id', '')::uuid
       where id = p_student_id;
    end if;
  end if;

  -- 3. Atualizar Status se solicitado
  if p_data ? 'status' and pg_catalog.btrim(coalesce(p_data ->> 'status', '')) <> '' then
    v_requested_status := pg_catalog.btrim(p_data ->> 'status');
    v_status_res := public.set_student_academic_status(
      p_student_id,
      v_requested_status,
      coalesce(p_data ->> 'status_reason', 'Atualizado no perfil do aluno')
    );
  end if;

  -- 4. Atualizar Nível se solicitado
  if p_data ? 'module' and pg_catalog.btrim(coalesce(p_data ->> 'module', '')) <> '' then
    v_requested_module := pg_catalog.upper(pg_catalog.btrim(p_data ->> 'module'));
    if v_requested_module is distinct from v_student.module then
      v_placement_res := public.set_student_pedagogical_placement(
        p_student_id,
        v_requested_module,
        coalesce(p_data ->> 'placement_reason', 'Ajuste de nível autorizado no perfil do aluno')
      );
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'success', true,
    'studentId', p_student_id,
    'statusUpdate', v_status_res,
    'placementUpdate', v_placement_res
  );
end;
$function$;

alter function public.update_student_pedagogical_profile(uuid, jsonb) owner to postgres;
revoke all on function public.update_student_pedagogical_profile(uuid, jsonb) from public, anon;
grant execute on function public.update_student_pedagogical_profile(uuid, jsonb) to authenticated;
