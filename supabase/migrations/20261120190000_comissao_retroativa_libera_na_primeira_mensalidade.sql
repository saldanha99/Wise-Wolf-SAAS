-- Comissão de indicação atribuída retroativamente pela direção (offers.metadata.affiliate_attribution =
-- 'DIRECTOR_RETROACTIVE'): a oferta fica sem vendor_id (o gatilho trg_sync_offer_affiliate_commission ignora a
-- oferta) e a regra combinada é "saque só depois da liquidação da PRIMEIRA MENSALIDADE no Asaas"
-- (metadata.affiliate_first_monthly_payment_id). Até aqui essa liberação era manual: duas comissões foram
-- liberadas em 30/09/2026 e a terceira, cuja mensalidade foi liquidada em 30/10/2026, ficou PENDING e fora do
-- saldo sacável da afiliada.
--
-- Este gatilho libera sozinho, uma única vez, apenas a comissão da oferta cuja primeira mensalidade marcada foi
-- liquidada (RECEIVED/RECEIVED_IN_CASH). Não paga nada: CONFIRMED só torna o valor sacável; o saque continua
-- passando por request_vendor_withdrawal + autorização.
create or replace function private.release_retroactive_affiliate_commission()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.status not in ('RECEIVED', 'RECEIVED_IN_CASH') then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status in ('RECEIVED', 'RECEIVED_IN_CASH') then
    return new;
  end if;
  if coalesce(new.asaas_payment_id, new.asaas_id) is null then
    return new;
  end if;

  update public.vendor_commissions as commission
     set status = 'CONFIRMED',
         confirmed_at = coalesce(commission.confirmed_at, new.credited_at, new.paid_at, pg_catalog.now())
    from public.offers as offer
   where offer.id = commission.offer_id
     and offer.tenant_id = new.tenant_id
     and offer.metadata ->> 'affiliate_attribution' = 'DIRECTOR_RETROACTIVE'
     and offer.metadata ->> 'affiliate_first_monthly_payment_id' in (new.asaas_payment_id, new.asaas_id)
     and commission.vendor_id::text = offer.metadata ->> 'affiliate_retroactive_vendor_id'
     and commission.tenant_id = new.tenant_id
     and commission.status = 'PENDING'
     and commission.withdrawal_request_id is null;
  return new;
end;
$function$;

alter function private.release_retroactive_affiliate_commission() owner to postgres;
revoke all on function private.release_retroactive_affiliate_commission()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_release_retroactive_affiliate_commission on public.student_payments;
create trigger trg_release_retroactive_affiliate_commission
after insert or update of status on public.student_payments
for each row execute function private.release_retroactive_affiliate_commission();

-- Reparo único do que já foi liquidado antes deste gatilho existir (em 20/11/2026: 1 comissão, R$ 109,00,
-- primeira mensalidade liquidada em 30/10/2026).
update public.vendor_commissions as commission
   set status = 'CONFIRMED',
       confirmed_at = coalesce(commission.confirmed_at, payment.credited_at, payment.paid_at, pg_catalog.now())
  from public.offers as offer
  join public.student_payments as payment
    on payment.tenant_id = offer.tenant_id
   and offer.metadata ->> 'affiliate_first_monthly_payment_id' in (payment.asaas_payment_id, payment.asaas_id)
 where offer.id = commission.offer_id
   and offer.metadata ->> 'affiliate_attribution' = 'DIRECTOR_RETROACTIVE'
   and commission.vendor_id::text = offer.metadata ->> 'affiliate_retroactive_vendor_id'
   and commission.tenant_id = offer.tenant_id
   and commission.status = 'PENDING'
   and commission.withdrawal_request_id is null
   and payment.status in ('RECEIVED', 'RECEIVED_IN_CASH');
