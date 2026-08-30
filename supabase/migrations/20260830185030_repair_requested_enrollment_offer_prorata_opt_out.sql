-- Repara a oferta apontada pelo proprietario depois que a versao anterior do
-- normalizador ignorou enableProRata=false. A alteracao e deliberadamente
-- restrita a uma oferta ainda nao iniciada e sem qualquer efeito financeiro.

do $repair_requested_offer$
declare
  v_offer public.offers%rowtype;
  v_updated_count integer := 0;
  v_offer_id constant uuid :=
    'c03279ff-1bde-400e-a0ca-e580e823c793'::uuid;
begin
  select offer.*
    into v_offer
    from public.offers as offer
   where offer.id = v_offer_id
   for update;

  -- A migracao continua portavel para instalacoes que nunca receberam esta
  -- oferta operacional especifica.
  if not found then
    return;
  end if;

  if v_offer.tenant_id is distinct from 'school-wise-wolf'
     or v_offer.kind is distinct from 'ENROLLMENT'
  then
    raise exception 'requested_prorata_offer_identity_mismatch';
  end if;

  if v_offer.payload ->> 'enableProRata' = 'false'
     and coalesce(
           nullif(v_offer.payload ->> 'proRataValue', '')::numeric,
           0
         ) = 0
     and coalesce(
           nullif(v_offer.metadata ->> 'pro_rata_value', '')::numeric,
           0
         ) = 0
  then
    return;
  end if;

  if v_offer.processing_state is distinct from 'NOT_STARTED'
     or v_offer.processing_by is not null
     or v_offer.processing_started_at is not null
     or v_offer.processing_completed_at is not null
     or v_offer.consumed_at is not null
     or v_offer.consumed_by is not null
     or v_offer.revoked_at is not null
     or v_offer.payload ->> 'enableProRata' is distinct from 'true'
     or coalesce(
          nullif(v_offer.payload ->> 'proRataValue', '')::numeric,
          0
        ) <> 84.52
     or coalesce(
          nullif(v_offer.metadata ->> 'pro_rata_value', '')::numeric,
          0
        ) <> 84.52
     or nullif(v_offer.metadata ->> 'pro_rata_charge_id', '') is not null
     or nullif(v_offer.metadata ->> 'enrollment_payment_id', '') is not null
     or nullif(v_offer.metadata ->> 'one_time_payment_id', '') is not null
     or nullif(v_offer.metadata ->> 'subscription_id', '') is not null
     or coalesce(
          nullif(
            v_offer.metadata ->> 'subscription_activation_payment_id',
            ''
          ),
          nullif(v_offer.metadata ->> 'activation_payment_id', '')
        ) is not null
     or v_offer.metadata ? 'pro_rata_paid_at'
     or exists (
       select 1
         from public.asaas_provider_creation_attempts as attempt
        where attempt.tenant_id = v_offer.tenant_id
          and attempt.external_reference =
            'enrollment:' || v_offer_id::text || ':pro-rata'
     )
  then
    raise exception 'requested_prorata_offer_is_not_safe_to_repair';
  end if;

  update public.offers as offer
     set payload = pg_catalog.jsonb_set(
           pg_catalog.jsonb_set(
             offer.payload,
             '{enableProRata}',
             'false'::jsonb,
             false
           ),
           '{proRataValue}',
           '0'::jsonb,
           false
         ),
         metadata = pg_catalog.jsonb_set(
           coalesce(offer.metadata, '{}'::jsonb),
           '{pro_rata_value}',
           '0'::jsonb,
           true
         ) || pg_catalog.jsonb_build_object(
           'pro_rata_opt_out_corrected_at', pg_catalog.clock_timestamp(),
           'pro_rata_opt_out_correction', 'owner_requested_2026_08_30'
         )
   where offer.id = v_offer_id;

  get diagnostics v_updated_count = row_count;
  if v_updated_count <> 1 then
    raise exception 'requested_prorata_offer_repair_lost';
  end if;

  select offer.*
    into strict v_offer
    from public.offers as offer
   where offer.id = v_offer_id;

  if v_offer.payload ->> 'enableProRata' <> 'false'
     or (v_offer.payload ->> 'proRataValue')::numeric <> 0
     or (v_offer.metadata ->> 'pro_rata_value')::numeric <> 0
  then
    raise exception 'requested_prorata_offer_repair_failed';
  end if;
end;
$repair_requested_offer$;
