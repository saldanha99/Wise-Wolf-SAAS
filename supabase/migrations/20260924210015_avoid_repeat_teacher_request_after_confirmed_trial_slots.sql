-- A student accepting an exact teacher-confirmed counterproposal must not
-- trigger another teacher availability question while the due day is pending.
do $patch$
declare
  v_definition text;
  v_old text := $$
        v_plan -> 'teacher_requested_slots' is distinct from v_plan -> 'slots'
        and v_plan -> 'teacher_rejected_slots' is distinct from v_plan -> 'slots'
    );$$;
  v_new text := $$
        v_plan -> 'teacher_requested_slots' is distinct from v_plan -> 'slots'
        and v_plan -> 'teacher_rejected_slots' is distinct from v_plan -> 'slots'
        and v_plan -> 'teacher_confirmed_slots' is distinct from v_plan -> 'slots'
    );$$;
begin
  select pg_catalog.pg_get_functiondef(
    'public.trial_closing_student_terms(text,text,integer,integer,jsonb,date,integer,text)'::pg_catalog.regprocedure
  ) into v_definition;

  if v_definition is null then
    raise exception 'trial_closing_student_terms_missing';
  end if;
  if pg_catalog.strpos(v_definition, v_new) > 0 then
    return;
  end if;
  if pg_catalog.strpos(v_definition, v_old) = 0 then
    raise exception 'trial_closing_student_terms_definition_changed';
  end if;

  execute pg_catalog.replace(v_definition, v_old, v_new);
end;
$patch$;
