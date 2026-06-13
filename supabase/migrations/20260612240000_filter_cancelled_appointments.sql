-- (a) trial_followups() disparava "que bom ter você na aula experimental!" para
--     appointments CANCELADOS (sem filtro de status).
-- (b) a view upcoming_classes incluía appointments cancelados → lembrete de 30min
--     + confirmação de presença para aula que não aconteceu.
-- Ambos passam a excluir cancelled/no_show.

CREATE OR REPLACE FUNCTION public.trial_followups()
 RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('appointment_id',a.id,'student_name',a.student_name,'phone',a.student_phone,'tenant_id',a.tenant_id)), '[]'::jsonb)
  FROM appointments a
  WHERE a.type = 'experimental'
    AND a.start_time::date = current_date - 2
    AND COALESCE(a.status,'scheduled') NOT IN ('cancelled','no_show')
    AND a.student_phone IS NOT NULL AND a.student_phone <> ''
    AND NOT EXISTS (
      SELECT 1 FROM profiles p WHERE p.role='STUDENT' AND p.tenant_id = a.tenant_id
        AND regexp_replace(p.phone,'\D','','g') = regexp_replace(a.student_phone,'\D','','g')
    );
$function$;

CREATE OR REPLACE VIEW public.upcoming_classes AS
 WITH _days AS (
         SELECT generate_series(CURRENT_DATE - '1 day'::interval, CURRENT_DATE + '14 days'::interval, '1 day'::interval)::date AS class_date
        ), _bookings_expanded AS (
         SELECT b.id AS source_id, 'booking'::text AS source_type, b.tenant_id, b.teacher_id, b.student_id,
            NULL::text AS student_name_override, NULL::text AS student_phone_override,
            d.class_date, b.time_slot AS time_text,
            (((d.class_date::text || ' ') || b.time_slot) || ':00')::timestamp AT TIME ZONE 'America/Sao_Paulo' AS start_at
           FROM bookings b CROSS JOIN _days d
          WHERE public.dow_name_to_int(b.day_of_week) = EXTRACT(DOW FROM d.class_date)::int
            AND (b.start_date IS NULL OR d.class_date >= b.start_date)
            AND b.time_slot ~ '^[0-9]{2}:[0-9]{2}$'::text
            AND COALESCE(b.status, 'SCHEDULED') = 'SCHEDULED'
            AND b.student_id IS NOT NULL
        ), _reschedules AS (
         SELECT r.id AS source_id, 'reschedule'::text AS source_type, r.tenant_id, r.teacher_id, r.student_id,
            NULL::text AS student_name_override, NULL::text AS student_phone_override,
            r.date::date AS class_date, r."time" AS time_text,
            (((r.date::text || ' ') || r."time") || ':00')::timestamp AT TIME ZONE 'America/Sao_Paulo' AS start_at
           FROM reschedules r
          WHERE r."time" ~ '^[0-9]{2}:[0-9]{2}$'::text
        ), _appointments AS (
         SELECT a.id AS source_id, 'appointment'::text AS source_type, a.tenant_id, a.teacher_id,
            NULL::uuid AS student_id, a.student_name AS student_name_override, a.student_phone AS student_phone_override,
            a.start_time::date AS class_date, to_char(a.start_time, 'HH24:MI'::text) AS time_text, a.start_time AS start_at
           FROM appointments a
          WHERE a.start_time IS NOT NULL
            AND COALESCE(a.status,'scheduled') NOT IN ('cancelled','no_show')
        )
 SELECT source_id, source_type, tenant_id, teacher_id, student_id, student_name_override, student_phone_override, class_date, time_text, start_at FROM _bookings_expanded
 UNION ALL
 SELECT source_id, source_type, tenant_id, teacher_id, student_id, student_name_override, student_phone_override, class_date, time_text, start_at FROM _reschedules
 UNION ALL
 SELECT source_id, source_type, tenant_id, teacher_id, student_id, student_name_override, student_phone_override, class_date, time_text, start_at FROM _appointments;

REVOKE ALL ON public.upcoming_classes FROM anon, authenticated;
