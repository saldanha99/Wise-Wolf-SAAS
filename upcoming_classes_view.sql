-- =====================================================================
-- VIEW: upcoming_classes
-- Unifica bookings (recorrentes), reschedules (one-off) e appointments (trials)
-- em uma timeline única, com start_at em timestamptz pronto pra cálculo.
-- =====================================================================

DROP VIEW IF EXISTS upcoming_classes;

CREATE OR REPLACE VIEW upcoming_classes AS
WITH _days AS (
    SELECT generate_series(
        CURRENT_DATE - INTERVAL '1 day',
        CURRENT_DATE + INTERVAL '14 days',
        INTERVAL '1 day'
    )::date AS class_date
),
-- 1. BOOKINGS recorrentes: gera uma instância por dia (próximos 14d) usando day_of_week
_bookings_expanded AS (
    SELECT
        b.id AS source_id,
        'booking' AS source_type,
        b.tenant_id,
        b.teacher_id,
        b.student_id,
        NULL::text AS student_name_override,
        NULL::text AS student_phone_override,
        d.class_date,
        b.time_slot AS time_text,
        (d.class_date::text || ' ' || b.time_slot || ':00')::timestamptz AS start_at
    FROM bookings b
    CROSS JOIN _days d
    WHERE
        b.day_of_week = TO_CHAR(d.class_date, 'TMDay')::text
        AND (b.start_date IS NULL OR d.class_date >= b.start_date)
        AND b.time_slot ~ '^[0-9]{2}:[0-9]{2}$'  -- só HH:MM valido
),
-- 2. RESCHEDULES one-off
_reschedules AS (
    SELECT
        r.id AS source_id,
        'reschedule' AS source_type,
        r.tenant_id,
        r.teacher_id,
        r.student_id,
        NULL::text AS student_name_override,
        NULL::text AS student_phone_override,
        r.date::date AS class_date,
        r.time AS time_text,
        (r.date::text || ' ' || r.time || ':00')::timestamptz AS start_at
    FROM reschedules r
    WHERE r.time ~ '^[0-9]{2}:[0-9]{2}$'
),
-- 3. APPOINTMENTS (trials, etc.)
_appointments AS (
    SELECT
        a.id AS source_id,
        'appointment' AS source_type,
        a.tenant_id,
        a.teacher_id,
        NULL::uuid AS student_id,
        a.student_name AS student_name_override,
        a.student_phone AS student_phone_override,
        a.start_time::date AS class_date,
        TO_CHAR(a.start_time, 'HH24:MI') AS time_text,
        a.start_time AS start_at
    FROM appointments a
    WHERE a.start_time IS NOT NULL
)
SELECT * FROM _bookings_expanded
UNION ALL
SELECT * FROM _reschedules
UNION ALL
SELECT * FROM _appointments;

COMMENT ON VIEW upcoming_classes IS 'Timeline unificada de aulas para automacoes (lembretes, etc). Gera bookings recorrentes nos proximos 14 dias.';

-- Permitir leitura pelas funcoes/cron jobs
GRANT SELECT ON upcoming_classes TO authenticated, service_role;
