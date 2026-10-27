-- Re-executable. No business records or signed contracts are rewritten.
-- Student lifecycle and teacher assignment belong exclusively to Direction.
-- Coordinators keep operational/pedagogical access but cannot perform these
-- administrative transitions.
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

  if pg_catalog.lower(v_clean_status) in ('ativo', 'active') then
    v_target_status := 'Ativo';
    v_target_lifecycle := 'active';
  elsif pg_catalog.lower(v_clean_status) in (
    'inativo', 'inactive', 'pausado', 'suspended',
    'pausa temporária', 'trancado', 'locked'
  ) then
    v_target_status := 'Inativo';
    v_target_lifecycle := 'suspended';
  else
    raise exception using errcode = '22023', message = 'invalid_student_status';
  end if;

  select profile.role, profile.tenant_id
  into v_actor
  from public.profiles as profile
  where profile.id = v_actor_id;

  if not found or v_actor.role not in ('SCHOOL_ADMIN', 'SUPER_ADMIN') then
    raise exception using errcode = '42501', message = 'student_status_requires_direction';
  end if;

  select profile.id, profile.role, profile.tenant_id,
         profile.status, profile.lifecycle_status
  into v_student
  from public.profiles as profile
  where profile.id = p_student_id
  for update;

  if not found or v_student.role <> 'STUDENT' or v_student.tenant_id is null then
    raise exception using errcode = '42501', message = 'student_not_found';
  end if;
  if v_actor.role <> 'SUPER_ADMIN'
     and (v_actor.tenant_id is null or v_actor.tenant_id <> v_student.tenant_id) then
    raise exception using errcode = '42501', message = 'student_not_available';
  end if;

  -- Financial lifecycle is finalized only by the fenced school-admin flow.
  -- Keep the old RPC as an idempotent compatibility read; never let a form,
  -- a nested pedagogical update, or an older browser bypass provider work.
  if v_student.lifecycle_status is distinct from v_target_lifecycle
     or v_student.status is distinct from v_target_status then
    raise exception using errcode = '55000',
      message = 'student_lifecycle_requires_school_admin',
      detail = 'Use Pausar, Encerrar ou Reativar e aguarde a confirmação do financeiro.';
  end if;

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


notify pgrst, 'reload schema';
