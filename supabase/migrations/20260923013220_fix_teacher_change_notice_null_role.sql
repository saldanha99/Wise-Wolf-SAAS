-- A new enrollment profile has no active tenant membership until its update
-- completes. A NULL _my_role() must not be treated as a teacher change.
create or replace function private.notify_teacher_student_profile_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_keys text[] := array[
    'full_name', 'phone', 'attendance_phone', 'meeting_link', 'occupation',
    'interests', 'private_notes', 'fixed_schedule', 'is_kids', 'status',
    'lifecycle_status', 'module', 'english_for', 'student_category',
    'learning_objective', 'personality', 'preferred_topics', 'avoided_topics',
    'short_term_goal', 'long_term_goal', 'current_book_part',
    'evaluation_unlocked', 'unlocked_tests'
  ];
  v_labels text[] := array[
    'nome', 'telefone', 'contato de presença', 'link da aula', 'ocupação',
    'interesses', 'notas pedagógicas', 'descrição da agenda',
    'classificação infantil', 'status acadêmico', 'situação acadêmica',
    'nível pedagógico', 'objetivo de inglês', 'categoria do aluno',
    'objetivo de aprendizagem', 'perfil de aprendizagem', 'temas preferidos',
    'temas evitados', 'meta de curto prazo', 'meta de longo prazo',
    'etapa do material', 'liberação de avaliação', 'avaliações liberadas'
  ];
  v_before jsonb := to_jsonb(old);
  v_after jsonb := to_jsonb(new);
  v_fields text[] := '{}';
  v_index integer;
begin
  if new.role <> 'STUDENT'
     or auth.uid() is null
     or public._my_role() is distinct from 'TEACHER'
     or coalesce(current_setting('app.teacher_profile_notice_wrapped', true), '') = '1' then
    return new;
  end if;

  for v_index in 1..array_length(v_keys, 1) loop
    if v_before -> v_keys[v_index] is distinct from v_after -> v_keys[v_index] then
      v_fields := array_append(v_fields, v_labels[v_index]);
    end if;
  end loop;

  if coalesce(array_length(v_fields, 1), 0) > 0 then
    perform private.enqueue_teacher_change_group_notice(
      new.tenant_id, auth.uid(), new.id, 'Perfil pedagógico do aluno',
      'Campos alterados: ' || array_to_string(v_fields, ', ') || '.'
    );
  end if;
  return new;
end;
$function$;

alter function private.notify_teacher_student_profile_update() owner to postgres;
revoke all on function private.notify_teacher_student_profile_update()
  from public, anon, authenticated, service_role;
