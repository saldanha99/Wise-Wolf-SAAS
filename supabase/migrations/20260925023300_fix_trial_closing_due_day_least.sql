-- LEAST is a SQL expression, not a pg_catalog function. The qualified call
-- raises undefined_function before enrollment-offer validation can run.
begin;

do $fix_trial_closing_due_day_least$
declare
  v_definition text;
  v_wrong text := 'pg_catalog.least(v_due_day, extract(day from';
begin
  select pg_catalog.pg_get_functiondef(
    'private.trial_closing_create_offer(uuid,text)'::pg_catalog.regprocedure
  ) into v_definition;

  if v_definition is null
     or pg_catalog.strpos(v_definition, 'commercial_terms_incomplete') = 0
     or pg_catalog.strpos(v_definition, 'teacher_confirmation_required') = 0 then
    raise exception 'trial_closing_create_offer_definition_changed';
  end if;

  if pg_catalog.strpos(v_definition, v_wrong) = 0 then
    if pg_catalog.strpos(v_definition, 'least(v_due_day, extract(day from') > 0 then
      return;
    end if;
    raise exception 'trial_closing_due_day_expression_changed';
  end if;

  v_definition := pg_catalog.replace(
    v_definition,
    v_wrong,
    'least(v_due_day, extract(day from'
  );
  execute v_definition;
end;
$fix_trial_closing_due_day_least$;

commit;
