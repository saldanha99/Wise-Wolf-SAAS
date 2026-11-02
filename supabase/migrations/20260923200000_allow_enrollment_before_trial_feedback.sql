begin;

-- Feedback continua sendo uma pendencia pedagogica do professor, mas nao pode
-- bloquear a decisao comercial do aluno. Mantemos todas as demais travas do
-- grafo autoritativo (tenant, experimental concluida, estado aberto e
-- matricula concorrente) e retiramos somente a dependencia de trial_feedback.
do $required_offer_contracts$
begin
  if pg_catalog.to_regprocedure(
       'public.create_enrollment_offer_pre_trial_offer_authority_impl(jsonb)'
     ) is null
     or pg_catalog.to_regprocedure(
       'public.create_enrollment_offer_pre_trial_lifecycle_impl(jsonb)'
     ) is null
     or pg_catalog.to_regprocedure(
       'private.lock_trial_conversion_graph(uuid)'
     ) is null
  then
    raise exception 'required enrollment offer predecessor is missing';
  end if;
end;
$required_offer_contracts$;

create or replace function
  public.create_enrollment_offer_pre_trial_offer_authority_impl(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_id uuid := (select auth.uid());
  v_tenant_id text := private.active_tenant_id(v_actor_id);
  v_opportunity_id uuid;
  v_opportunity public.opportunities%rowtype;
  v_offer_id uuid;
begin
  if pg_catalog.jsonb_typeof(coalesce(p_payload, '{}'::jsonb))
       is distinct from 'object' then
    return public.create_enrollment_offer_pre_trial_lifecycle_impl(p_payload);
  end if;

  begin
    v_opportunity_id := nullif(
      pg_catalog.btrim(coalesce(p_payload ->> 'opportunityId', '')),
      ''
    )::uuid;
  exception when invalid_text_representation then
    return public.create_enrollment_offer_pre_trial_lifecycle_impl(p_payload);
  end;

  if v_opportunity_id is null then
    return public.create_enrollment_offer_pre_trial_lifecycle_impl(p_payload);
  end if;
  if v_actor_id is null or v_tenant_id is null then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  perform private.lock_trial_conversion_graph(v_opportunity_id);
  select opportunity.*
    into v_opportunity
    from public.opportunities as opportunity
   where opportunity.id = v_opportunity_id;

  if v_opportunity.tenant_id is distinct from v_tenant_id
     or v_opportunity.kind is distinct from 'TRIAL'
     or v_opportunity.status is distinct from 'CLAIMED'
     or v_opportunity.conversion_status is distinct from 'OPEN'
     or v_opportunity.trial_status is distinct from 'DONE' then
    raise exception 'trial_opportunity_not_eligible'
      using errcode = '23514';
  end if;

  if exists (
    select 1
      from public.offers as offer
     where offer.opportunity_id = v_opportunity_id
       and offer.kind = 'ENROLLMENT'
       and offer.revoked_at is null
       and offer.consumed_at is null
       and (
         offer.processing_by is not null
         or offer.processing_state <> 'NOT_STARTED'
       )
  ) or exists (
    select 1
      from public.enrollment_links as link
     where link.opportunity_id = v_opportunity_id
       and link.status = 'PROCESSING'
  ) then
    raise exception 'enrollment_in_progress' using errcode = '55000';
  end if;

  v_offer_id := public.create_enrollment_offer_pre_trial_lifecycle_impl(
    p_payload
  );
  if not exists (
    select 1
      from public.offers as offer
     where offer.id = v_offer_id
       and offer.opportunity_id = v_opportunity_id
       and offer.tenant_id = v_tenant_id
       and offer.kind = 'ENROLLMENT'
       and offer.revoked_at is null
  ) then
    raise exception 'enrollment_offer_scope_mismatch' using errcode = '23514';
  end if;
  return v_offer_id;
end;
$function$;

alter function
  public.create_enrollment_offer_pre_trial_offer_authority_impl(jsonb)
  owner to postgres;
revoke all on function
  public.create_enrollment_offer_pre_trial_offer_authority_impl(jsonb)
  from public, anon, authenticated, service_role;

commit;
