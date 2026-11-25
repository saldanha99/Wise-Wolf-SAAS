-- Saída do professor: aluno que já tem troca de professor marcada (transferência
-- PENDING/ACCEPTED saindo deste professor) não volta a ser oferecido. Caso real:
-- na saída da Teacher Bruna (25/11/2026) a direção transferiu três alunos à mão
-- antes de abrir a saída; oferecê-los de novo criaria uma segunda transferência.
create or replace function private.departure_student_slots(p_tenant text, p_teacher uuid)
returns table(student_id uuid, slots jsonb)
language sql stable security definer set search_path = '' as $$
  select booking.student_id,
         jsonb_agg(jsonb_build_object(
           'day_of_week', public.canonical_weekday_name(booking.day_of_week),
           'time_slot', left(booking.time_slot, 5))
           order by public.dow_name_to_int(booking.day_of_week), left(booking.time_slot, 5))
    from public.bookings booking
    join public.profiles student on student.id = booking.student_id
   where booking.tenant_id = p_tenant
     and booking.teacher_id = p_teacher
     and student.professor_id = p_teacher
     and booking.status = 'SCHEDULED'
     and booking.date is null
     and booking.student_id is not null
     and student.lifecycle_status = 'active'
     and not exists (
       select 1 from public.teacher_transfers transfer
        where transfer.tenant_id = p_tenant
          and transfer.student_id = booking.student_id
          and transfer.from_teacher_id = p_teacher
          and transfer.status in ('PENDING', 'ACCEPTED'))
   group by booking.student_id;
$$;
alter function private.departure_student_slots(text, uuid) owner to postgres;
revoke all on function private.departure_student_slots(text, uuid) from public, anon, authenticated, service_role;

-- Mesma regra no aceite: a troca pode ter sido feita à mão depois de abrir a saída.
do $patch$
declare definition text; anchor text;
begin
  definition := pg_get_functiondef('private.departure_take_offer(uuid,uuid,text,uuid)'::regprocedure);
  if position('troca_ja_marcada' in definition) = 0 then
    anchor := '  v_cutover := greatest(d.cutover_date, v_today);';
    if position(anchor in definition) = 0 then raise exception 'departure_take_offer_anchor_missing'; end if;
    definition := replace(definition, anchor, $guard$
  -- troca_ja_marcada: outra transferência deste aluno já saiu deste professor.
  if exists (select 1 from public.teacher_transfers transfer
              where transfer.tenant_id = o.tenant_id and transfer.student_id = o.student_id
                and transfer.from_teacher_id = d.teacher_id and transfer.status in ('PENDING', 'ACCEPTED')) then
    return jsonb_build_object('ok', false, 'error', 'aluno_ja_atribuido');
  end if;
$guard$ || anchor);
    execute definition;
  end if;
end $patch$;
