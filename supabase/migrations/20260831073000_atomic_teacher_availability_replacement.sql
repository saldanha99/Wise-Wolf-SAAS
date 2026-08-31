-- Publicar a grade de disponibilidade deve ser uma única operação. O cliente
-- antigo apagava todas as linhas e só depois tentava recriá-las; uma falha na
-- segunda chamada deixava o professor sem agenda publicada.

create or replace function public.replace_teacher_availability(
  p_teacher_id uuid,
  p_slots jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, private
as $$
declare
  v_tenant_id text;
  v_inserted integer := 0;
begin
  if p_teacher_id is null then
    raise exception 'Professor é obrigatório.' using errcode = '22023';
  end if;

  if p_slots is null or jsonb_typeof(p_slots) <> 'array' then
    raise exception 'A disponibilidade deve ser uma lista.' using errcode = '22023';
  end if;

  select profile.tenant_id
    into v_tenant_id
    from public.profiles as profile
   where profile.id = p_teacher_id;

  if v_tenant_id is null then
    raise exception 'Professor não encontrado.' using errcode = 'P0002';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(p_slots) as slot(value)
     where jsonb_typeof(slot.value) <> 'object'
        or not (slot.value ? 'day_of_week')
        or not (slot.value ? 'start_time')
        or coalesce(slot.value ->> 'day_of_week', '') !~ '^[0-6]$'
        or coalesce(slot.value ->> 'start_time', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        or (
          slot.value ? 'end_time'
          and nullif(slot.value ->> 'end_time', '') is not null
          and (slot.value ->> 'end_time') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        )
  ) then
    raise exception 'Há um horário inválido na disponibilidade.' using errcode = '22023';
  end if;

  -- DELETE + INSERT vivem na mesma chamada e, portanto, na mesma transação.
  -- As políticas RLS existentes continuam sendo a fonte de autorização.
  delete from public.teacher_availability as availability
   where availability.teacher_id = p_teacher_id;

  insert into public.teacher_availability (
    teacher_id,
    tenant_id,
    day_of_week,
    start_time,
    end_time
  )
  select
    p_teacher_id,
    v_tenant_id,
    parsed.day_of_week,
    parsed.start_time,
    parsed.end_time
  from (
    select distinct
      (slot.value ->> 'day_of_week')::integer as day_of_week,
      (slot.value ->> 'start_time')::time as start_time,
      nullif(slot.value ->> 'end_time', '')::time as end_time
    from jsonb_array_elements(p_slots) as slot(value)
  ) as parsed;

  get diagnostics v_inserted = row_count;

  return jsonb_build_object(
    'ok', true,
    'teacherId', p_teacher_id,
    'publishedSlots', v_inserted
  );
end;
$$;

revoke all on function public.replace_teacher_availability(uuid, jsonb)
  from public, anon;
grant execute on function public.replace_teacher_availability(uuid, jsonb)
  to authenticated, service_role;

comment on function public.replace_teacher_availability(uuid, jsonb) is
  'Substitui atomicamente a disponibilidade semanal do professor, preservando as políticas RLS de tenant e função.';

notify pgrst, 'reload schema';
