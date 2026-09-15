-- ─────────────────────────────────────────────────────────────────────────────
-- Worker de cobrança da renovação falhava a cada minuto (15/09/2026)
--
-- `claim_student_course_renewal_billing` devolve RETURNS TABLE(id, claim_token)
-- e comparava `where id=v_id` sem alias. Em PL/pgSQL o parâmetro de saída `id`
-- colide com a coluna: "column reference id is ambiguous". O erro só aparece
-- quando existe oferta SIGNED/PENDING — ou seja, na primeira assinatura real —
-- e a cobrança da renovação assinada ficava parada.
--
-- Migration nova (e não edição da 20260915030407) porque o release recusa
-- migration já aplicada com checksum diferente. `create or replace` preserva
-- dono e permissões da função.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.claim_student_course_renewal_billing(p_limit integer default 10)
returns table(id uuid,claim_token uuid) language plpgsql security definer set search_path='' as $fn$
declare v_id uuid; v_claim uuid;
begin
  for v_id in select o.id from private.student_course_renewal_offers o where o.status='SIGNED' and o.billing_status='PENDING'
    order by o.signed_at,o.id for update skip locked limit greatest(1,least(coalesce(p_limit,10),25)) loop
    -- `id` é também coluna de saída: toda leitura da tabela usa alias.
    perform pg_advisory_xact_lock(hashtextextended('student-billing-lifecycle:'||(select so.tenant_id from private.student_course_renewal_offers so where so.id=v_id)||':'||(select so.student_id from private.student_course_renewal_offers so where so.id=v_id)::text,0));
    v_claim:=gen_random_uuid();
    update private.student_course_renewal_offers set billing_status='PROCESSING',billing_claim_token=v_claim,
      billing_lease_expires_at=clock_timestamp()+interval '30 minutes',billing_error=null where private.student_course_renewal_offers.id=v_id;
    insert into private.student_course_renewal_events(tenant_id,offer_id,event_type,payload)
      select so.tenant_id,so.id,'BILLING_CLAIMED',jsonb_build_object('strategy',so.billing_strategy) from private.student_course_renewal_offers so where so.id=v_id;
    id:=v_id; claim_token:=v_claim; return next;
  end loop;
end $fn$;
