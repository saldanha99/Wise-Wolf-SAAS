-- A teacher's counterproposal resolves the question about the student's old
-- slots. Do not re-ask those slots or treat a later bare "sim" as approval.
-- Preserve the installed functions' other behavior, ownership and grants.
do $migration$
declare
  r record;
  v_definition text;
begin
  for r in
    select * from (values
      (
        'public.trial_closing_pending_teacher_slots(integer)',
        $old$and flow.plan -> 'teacher_requested_slots' is distinct from flow.plan -> 'slots'$old$,
        $new$and not flow.plan ? 'teacher_counterproposal_slots'
      and flow.plan -> 'teacher_requested_slots' is distinct from flow.plan -> 'slots'$new$
      ),
      (
        'public.trial_closing_mark_teacher_slots_asked(uuid)',
        $old$and stage in ('ASK_TEACHER', 'ASK_STUDENT')$old$,
        $new$and stage in ('ASK_TEACHER', 'ASK_STUDENT')
     and not plan ? 'teacher_counterproposal_slots'$new$
      ),
      (
        'public.trial_closing_teacher_slots_reply_for_flow(text,uuid,uuid,boolean,text)',
        $old$and plan ? 'slots' and plan ? 'teacher_requested_slots'$old$,
        $new$and plan ? 'slots' and plan ? 'teacher_requested_slots'
     and not plan ? 'teacher_counterproposal_slots'$new$
      ),
      (
        'public.trial_closing_teacher_counterproposal_for_flow(text,uuid,uuid,jsonb)',
        $old$and plan ? 'teacher_requested_slots'$old$,
        $new$and plan ? 'teacher_requested_slots'
     and not plan ? 'teacher_counterproposal_slots'$new$
      )
    ) as changes(signature, old_clause, new_clause)
  loop
    select pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(r.signature))
      into v_definition;
    if v_definition is null then
      raise exception 'trial_closing_function_missing:%', r.signature;
    end if;
    if pg_catalog.strpos(v_definition, r.new_clause) > 0 then
      continue;
    end if;
    if pg_catalog.strpos(v_definition, r.old_clause) = 0 then
      raise exception 'trial_closing_function_definition_changed:%', r.signature;
    end if;
    execute pg_catalog.replace(v_definition, r.old_clause, r.new_clause);
  end loop;
end;
$migration$;
