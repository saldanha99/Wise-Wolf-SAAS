begin;
-- Reativação sem Asaas: só service_role, só aluno pausado e sem vínculo no Asaas.
do $test$
begin
  if has_function_privilege('authenticated', 'public.reactivate_student_without_billing(text,uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.reactivate_student_without_billing(text,uuid)', 'EXECUTE') then
    raise exception 'reativar_sem_asaas: função aberta para usuário da API';
  end if;
  if not has_function_privilege('service_role', 'public.reactivate_student_without_billing(text,uuid)', 'EXECUTE') then
    raise exception 'reativar_sem_asaas: service_role sem acesso';
  end if;
  if pg_catalog.strpos(pg_catalog.pg_get_functiondef('public.reactivate_student_without_billing(text,uuid)'::regprocedure),
       'provider_binding_present') = 0 then
    raise exception 'reativar_sem_asaas: aluno com Asaas não é recusado';
  end if;
end;
$test$;

-- Aluno com assinatura no Asaas nunca passa por esta porta.
do $test$
declare
  v_student uuid;
  v_tenant text;
  v_result jsonb;
begin
  select id, tenant_id into v_student, v_tenant from public.profiles
   where role = 'STUDENT' and nullif(btrim(coalesce(subscription_id, '')), '') is not null
   limit 1;
  if v_student is null then return; end if;
  v_result := public.reactivate_student_without_billing(v_tenant, v_student);
  if coalesce(v_result->>'ok', '') = 'true' and coalesce(v_result->>'action', '') <> 'ALREADY_COMPLETED' then
    raise exception 'reativar_sem_asaas: reativou aluno com assinatura (%)', v_result;
  end if;
end;
$test$;
rollback;
