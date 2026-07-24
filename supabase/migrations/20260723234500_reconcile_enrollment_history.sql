BEGIN;

-- Reparos históricos confirmados por: mesmo tenant, contrato aceito e criação/
-- aceite imediatamente após o link. Não sobrescreve oportunidade já atribuída
-- a outro aluno.
WITH expected(link_id, opportunity_id, student_id) AS (
  VALUES
    (
      '4946a222-d21a-48b0-8130-077634aa5382'::uuid,
      'ce23d55d-8c1d-4e06-82ea-8e8d275b18e5'::uuid,
      'b1041538-a749-430e-8da3-b370850d9d09'::uuid
    ),
    (
      '32a2cd4b-033d-40dc-953f-8d13a3f185fd'::uuid,
      '0597f896-5930-492f-888a-b9a220863f76'::uuid,
      'b4b47324-6195-465d-b2dd-a6fdeb816543'::uuid
    ),
    (
      '3f4228d9-4221-4680-8b5d-9d96af7fdb7b'::uuid,
      'f9d7cfab-0f4d-458f-9b93-bfbdd155abfb'::uuid,
      'a24533d7-a92a-4d64-bf51-5e382475b234'::uuid
    )
),
verified AS (
  SELECT e.*, p.accepted_at
    FROM expected e
    JOIN public.enrollment_links el
      ON el.id = e.link_id
     AND el.opportunity_id = e.opportunity_id
    JOIN public.opportunities op
      ON op.id = e.opportunity_id
     AND (op.student_id IS NULL OR op.student_id = e.student_id)
    JOIN public.profiles p
      ON p.id = e.student_id
     AND p.tenant_id = el.tenant_id
     AND p.contract_accepted IS TRUE
)
UPDATE public.opportunities op
   SET conversion_status = 'WON',
       student_id = v.student_id
  FROM verified v
 WHERE op.id = v.opportunity_id;

WITH expected(link_id, opportunity_id, student_id) AS (
  VALUES
    (
      '4946a222-d21a-48b0-8130-077634aa5382'::uuid,
      'ce23d55d-8c1d-4e06-82ea-8e8d275b18e5'::uuid,
      'b1041538-a749-430e-8da3-b370850d9d09'::uuid
    ),
    (
      '32a2cd4b-033d-40dc-953f-8d13a3f185fd'::uuid,
      '0597f896-5930-492f-888a-b9a220863f76'::uuid,
      'b4b47324-6195-465d-b2dd-a6fdeb816543'::uuid
    ),
    (
      '3f4228d9-4221-4680-8b5d-9d96af7fdb7b'::uuid,
      'f9d7cfab-0f4d-458f-9b93-bfbdd155abfb'::uuid,
      'a24533d7-a92a-4d64-bf51-5e382475b234'::uuid
    )
),
verified AS (
  SELECT e.*, p.accepted_at
    FROM expected e
    JOIN public.enrollment_links el
      ON el.id = e.link_id
     AND el.opportunity_id = e.opportunity_id
    JOIN public.opportunities op
      ON op.id = e.opportunity_id
     AND op.student_id = e.student_id
     AND op.conversion_status = 'WON'
    JOIN public.profiles p
      ON p.id = e.student_id
     AND p.tenant_id = el.tenant_id
     AND p.contract_accepted IS TRUE
)
UPDATE public.enrollment_links el
   SET status = 'USED',
       used_at = COALESCE(el.used_at, v.accepted_at)
  FROM verified v
 WHERE el.id = v.link_id;

COMMIT;
