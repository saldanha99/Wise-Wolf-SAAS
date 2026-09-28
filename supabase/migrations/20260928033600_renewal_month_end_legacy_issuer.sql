-- Legacy issuer must use the same monthly progression as the table checks
-- and the newer issuer. No existing offer or provider billing is changed.
do $patch$
declare
  definition text;
  last_due text := 'public.fim_do_servico(public.fim_do_servico(public.fim_do_servico(public.fim_do_servico(public.fim_do_servico(p_contract_start)))))';
begin
  select pg_get_functiondef('private.issue_student_course_renewal_offer(uuid,date,date,text,text,text,text,timestamptz)'::regprocedure) into definition;
  if strpos(definition,'(p_contract_start+interval ''5 months'')::date')>0
    and strpos(definition,'(p_contract_start+interval ''6 months'')::date')>0 then
    definition := replace(definition,'(p_contract_start+interval ''5 months'')::date',last_due);
    definition := replace(definition,'(p_contract_start+interval ''6 months'')::date','public.fim_do_servico('||last_due||')');
    execute definition;
  elsif strpos(definition,last_due)=0 then
    raise exception 'Unexpected legacy renewal issuer; month end patch not applied';
  end if;
end;
$patch$;
