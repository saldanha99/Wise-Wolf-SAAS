-- A criação da oferta já separa feedback pedagógico de matrícula comercial.
-- A conclusão ainda continha a trava antiga: contrato assinado e taxa liquidada
-- ficavam em BILLING_READY, sem avisos de conclusão. Preserve a definição viva
-- e todas as guardas financeiras/CRM, retirando somente esse veto pedagógico.
do $completion_without_feedback$
declare
  definition text;
  anchor text := $anchor$  if v_opportunity.feedback_required
     and not private.trial_feedback_is_complete(v_opportunity_id) then
    return pg_catalog.jsonb_build_object(
      'success', false, 'error', 'TRIAL_FEEDBACK_REQUIRED'
    );
  end if;
$anchor$;
begin
  select pg_catalog.pg_get_functiondef(
    'public.complete_enrollment_offer_pre_crm_won_impl(uuid,uuid)'::regprocedure
  ) into definition;
  if pg_catalog.strpos(definition, 'TRIAL_FEEDBACK_REQUIRED') > 0 then
    if pg_catalog.strpos(definition, anchor) = 0 then
      raise exception 'completion_feedback_guard_anchor_changed';
    end if;
    execute pg_catalog.replace(definition, anchor, '');
  end if;
end;
$completion_without_feedback$;
