-- Reativar aluno pausado que não tem nada no Asaas (12/11/2026).
--
-- Par da correção da pausa no school-admin: aluno sem cliente e sem assinatura
-- no Asaas (pagou o curso integral ou por fora) agora pode ser pausado só na
-- plataforma. Sem esta porta ele ficava preso: begin_student_reactivation exige
-- assinatura (subscription_binding_missing) para religar a cobrança, e aqui não
-- há cobrança a religar. Só volta o status; a agenda segue a regra de sempre
-- da reativação (a pausa cancelou as aulas fixas; a direção remarca).
--
-- Somente service_role (a edge school-admin chama depois de conferir que quem
-- pede é a direção/coordenação da escola). Re-executável.

create or replace function public.reactivate_student_without_billing(
  p_tenant_id text,
  p_student_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  profile_row public.profiles%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'student-billing-lifecycle:' || p_tenant_id || ':' || p_student_id::text,
      0
    )
  );

  select profile.* into profile_row
    from public.profiles as profile
   where profile.id = p_student_id
   for update;
  if not found
     or profile_row.tenant_id is distinct from p_tenant_id
     or profile_row.role is distinct from 'STUDENT'
  then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'profile_scope_changed');
  end if;
  if lower(pg_catalog.btrim(coalesce(profile_row.lifecycle_status, ''))) = 'active' then
    return pg_catalog.jsonb_build_object('ok', true, 'action', 'ALREADY_COMPLETED');
  end if;
  if lower(pg_catalog.btrim(coalesce(profile_row.lifecycle_status, ''))) <> 'suspended' then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'new_enrollment_required');
  end if;
  if nullif(pg_catalog.btrim(coalesce(profile_row.asaas_customer_id, '')), '') is not null
     or nullif(pg_catalog.btrim(coalesce(profile_row.subscription_id, '')), '') is not null
  then
    -- Tem vínculo no Asaas: a reativação passa pelo fluxo com o provedor.
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'provider_binding_present');
  end if;
  if exists (
    select 1 from public.student_offboarding_operations as operation
     where operation.student_id = p_student_id
       and operation.status in ('CLAIMED', 'PROVIDER_MUTATING', 'PROVIDER_COMPLETE', 'UNKNOWN', 'BLOCKED')
  ) then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'operation_in_progress');
  end if;
  if (
    select pg_catalog.count(*) from public.tenant_memberships as membership
     where membership.user_id = p_student_id
  ) <> 1 or not exists (
    select 1 from public.tenant_memberships as membership
     where membership.user_id = p_student_id
       and membership.tenant_id = p_tenant_id
       and membership.role = 'STUDENT'
       and membership.status = 'ACTIVE'
  ) then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'membership_scope_changed');
  end if;

  update public.profiles as profile
     set status = 'Ativo',
         lifecycle_status = 'active',
         suspended_at = null,
         suspended_reason = null,
         offboarding_status = null,
         offboarding_requested_at = null,
         offboarding_completed_at = null,
         offboarding_last_day = null,
         offboarding_reason = null
   where profile.id = p_student_id;

  perform public.recompute_student_financial_status(p_tenant_id, p_student_id);
  return pg_catalog.jsonb_build_object('ok', true, 'action', 'COMPLETED');
end;
$function$;

alter function public.reactivate_student_without_billing(text, uuid) owner to postgres;
revoke all on function public.reactivate_student_without_billing(text, uuid)
  from public, anon, authenticated;
grant execute on function public.reactivate_student_without_billing(text, uuid)
  to service_role;
