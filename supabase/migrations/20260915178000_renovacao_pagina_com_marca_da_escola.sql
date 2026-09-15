-- ─────────────────────────────────────────────────────────────────────────────
-- Página de renovação com a marca da escola (15/09/2026)
--
-- A página pública de assinatura passa a mostrar a logo e as cores da escola.
-- Elas vêm de `tenants.branding` (logoUrl, primaryColor, secondaryColor), o
-- mesmo lugar que o painel já usa. A página é anônima, então a função só
-- devolve o que é seguro exibir: URL https e cores no formato #RRGGBB — valor
-- fora disso vira null e a página cai no visual padrão.
-- Mesma função de 20260915174000, com os três campos a mais.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.get_student_course_renewal_public(p_token text)
returns jsonb language plpgsql stable security definer set search_path='' as $fn$
declare o private.student_course_renewal_offers%rowtype; r private.student_course_renewal_proposals%rowtype;
  p public.profiles%rowtype; v_school text; v_branding jsonb;
begin
  if p_token is null or p_token!~'^[a-f0-9]{64}$' then return jsonb_build_object('ok',false,'error','Link inválido.'); end if;
  select * into o from private.student_course_renewal_offers where token=p_token;
  if not found then return jsonb_build_object('ok',false,'error','Link inválido.'); end if;
  select * into r from private.student_course_renewal_proposals where id=o.proposal_id;
  select * into p from public.profiles where id=o.student_id and tenant_id=o.tenant_id;
  select coalesce(nullif(btrim(name),''),'Wise Wolf'), coalesce(branding,'{}'::jsonb)
    into v_school, v_branding from public.tenants where id=o.tenant_id;
  if p.id is null or r.id is null or r.monthly_fee_cents<>o.monthly_fee_cents or r.classes_per_week<>o.classes_per_week
    or r.term_months<>o.term_months or o.status='CANCELLED' then return jsonb_build_object('ok',false,'error','Esta proposta não está disponível.'); end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('student_name',p.full_name,'school_name',v_school,
    'term_months',o.term_months,'monthly_fee_cents',o.monthly_fee_cents,'classes_per_week',o.classes_per_week,
    'contract_start',o.contract_start,'first_due_date',o.first_due_date,'last_due_date',o.last_due_date,
    'service_end_date',o.service_end_date,'status',o.status,'billing_status',o.billing_status,
    'signed_at',o.signed_at,'expired',(o.expires_at<clock_timestamp() and o.status='PENDING_SIGNATURE'),
    'schedule',case when o.schedule_plan is null then null else jsonb_build_object(
      'teacher_first_name',split_part(btrim(coalesce(o.schedule_plan->>'teacher_name','')),' ',1),
      'slots',o.schedule_plan->'slots') end,
    'school_logo_url',case when v_branding->>'logoUrl' ~ '^https://[^\s"<>]+$' then v_branding->>'logoUrl' end,
    'brand_primary',case when v_branding->>'primaryColor' ~ '^#[0-9a-fA-F]{6}$' then v_branding->>'primaryColor' end,
    'brand_secondary',case when v_branding->>'secondaryColor' ~ '^#[0-9a-fA-F]{6}$' then v_branding->>'secondaryColor' end));
end $fn$;
