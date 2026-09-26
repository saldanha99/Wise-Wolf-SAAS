-- Keep the health check in sync with the five-minute funnel sweep introduced
-- by 20260905160347, and ignore an optional SQL statement terminator.
-- Patch the installed function rather than replacing unrelated health rules.
do $migration$
declare
  v_definition text;
  v_old text;
  v_new text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.notify_cron_failures()'::pg_catalog.regprocedure
  ) into v_definition;
  if v_definition is null then
    raise exception 'notify_cron_failures_missing';
  end if;

  v_old := $old$('wisewolf-funnel-sweeper', '*/15 * * * *', 'select trigger_funnel_sweeper();')$old$;
  v_new := $new$('wisewolf-funnel-sweeper', '*/5 * * * *', 'select trigger_funnel_sweeper();')$new$;
  if pg_catalog.strpos(v_definition, v_old) = 0 then
    if pg_catalog.strpos(v_definition, v_new) = 0 then
      raise exception 'funnel_sweeper_expectation_not_found';
    end if;
  else
    v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  end if;

  v_old := $old$and lower(pg_catalog.regexp_replace($old$;
  v_new := $new$and pg_catalog.rtrim(lower(pg_catalog.regexp_replace($new$;
  if pg_catalog.strpos(v_definition, v_old) > 0 then
    v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  elsif pg_catalog.strpos(v_definition, v_new) = 0 then
    raise exception 'cron_command_comparison_start_not_found';
  end if;

  v_old := $old$          )) = lower(r.command)$old$;
  v_new := $new$          )), ' ;') = pg_catalog.rtrim(lower(r.command), ' ;')$new$;
  if pg_catalog.strpos(v_definition, v_old) > 0 then
    v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  elsif pg_catalog.strpos(v_definition, v_new) = 0 then
    raise exception 'cron_command_comparison_end_not_found';
  end if;

  execute v_definition;
end;
$migration$;
