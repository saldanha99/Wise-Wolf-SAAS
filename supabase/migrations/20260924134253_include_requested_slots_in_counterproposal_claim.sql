-- O texto da contraproposta deve explicar qual horário pedido não foi aceito.
-- A função já mantém a trava e o handoff; apenas devolve a grade original.
do $migration$
declare
  definition text;
  old_fragment text := '''slots'',v_flow.plan->''teacher_counterproposal_slots''';
  new_fragment text := '''original_slots'',v_flow.plan->''slots'',
    ''slots'',v_flow.plan->''teacher_counterproposal_slots''';
begin
  select pg_get_functiondef(
    'public.trial_closing_claim_teacher_counterproposal_student(uuid)'::regprocedure
  ) into definition;
  if definition is null then
    raise exception 'trial_closing_counterproposal_claim_missing';
  end if;
  if position('''original_slots'',v_flow.plan->''slots''' in definition) > 0 then
    return;
  end if;
  if position(old_fragment in definition) = 0 then
    raise exception 'trial_closing_counterproposal_claim_definition_changed';
  end if;
  execute replace(definition, old_fragment, new_fragment);
end;
$migration$;
