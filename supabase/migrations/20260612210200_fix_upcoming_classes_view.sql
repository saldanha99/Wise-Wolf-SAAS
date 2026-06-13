-- CAUSA-RAIZ das automacoes de aula nunca funcionarem para aulas regulares.
-- A view upcoming_classes (lida por prepare-daily-reminders E por
-- enqueue_attendance_confirmations) mantinha os 106 bookings recorrentes INVISIVEIS
-- por DOIS bugs encadeados:
--
--   (a) IDIOMA: o JOIN comparava bookings.day_of_week (gravado em portugues:
--       "Segunda","Terca","Sabado"...) contra to_char(data,'TMDay') que, com
--       lc_time=en_US.UTF-8, produz ingles ("Monday","Saturday"). Nunca casava.
--
--   (b) FUSO: start_at era (data || ' ' || time_slot)::timestamptz, interpretado no
--       fuso da sessao (UTC). Uma aula 20:30 BRT virava 20:30 UTC (= 17:30 BRT),
--       3h adiantada -> lembrete 3h cedo e confirmacao antes da aula terminar.
--
-- Prova: a view passou de 0 -> 225 ocorrencias de booking. Antes, notification_queue
-- so tinha 2 LESSON_REMINDER (ambos de appointment), 0 de booking, em todo o historico.
--
-- Correcao (a): funcao IMMUTABLE dow_name_to_int(text) imune a idioma e acento
-- (PT com/sem -feira + EN -> 0..6, 0=Domingo igual JS getDay()), comparada com
-- EXTRACT(DOW FROM data).
-- Correcao (b): horario de bookings/reschedules interpretado em America/Sao_Paulo
-- (UTC-3 fixo desde 2019; AT TIME ZONE trata DST futuro automaticamente).
-- Appointments usam start_time (timestamptz real) -> ja corretos, mantidos.

CREATE OR REPLACE FUNCTION public.dow_name_to_int(p text)
RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE lower(split_part(
           translate(coalesce(p, ''), 'áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ', 'aaaaeeiooouucAAAAEEIOOOUUC'),
           '-', 1))
    WHEN 'domingo'  THEN 0  WHEN 'sunday'    THEN 0
    WHEN 'segunda'  THEN 1  WHEN 'monday'    THEN 1
    WHEN 'terca'    THEN 2  WHEN 'tuesday'   THEN 2
    WHEN 'quarta'   THEN 3  WHEN 'wednesday' THEN 3
    WHEN 'quinta'   THEN 4  WHEN 'thursday'  THEN 4
    WHEN 'sexta'    THEN 5  WHEN 'friday'    THEN 5
    WHEN 'sabado'   THEN 6  WHEN 'saturday'  THEN 6
    ELSE -1
  END
$$;

CREATE OR REPLACE VIEW public.upcoming_classes AS
 WITH _days AS (
         SELECT generate_series(CURRENT_DATE - '1 day'::interval, CURRENT_DATE + '14 days'::interval, '1 day'::interval)::date AS class_date
        ), _bookings_expanded AS (
         SELECT b.id AS source_id,
            'booking'::text AS source_type,
            b.tenant_id,
            b.teacher_id,
            b.student_id,
            NULL::text AS student_name_override,
            NULL::text AS student_phone_override,
            d.class_date,
            b.time_slot AS time_text,
            (((d.class_date::text || ' ') || b.time_slot) || ':00')::timestamp
              AT TIME ZONE 'America/Sao_Paulo' AS start_at
           FROM bookings b
             CROSS JOIN _days d
          WHERE public.dow_name_to_int(b.day_of_week) = EXTRACT(DOW FROM d.class_date)::int
            AND (b.start_date IS NULL OR d.class_date >= b.start_date)
            AND b.time_slot ~ '^[0-9]{2}:[0-9]{2}$'::text
            AND COALESCE(b.status, 'SCHEDULED') = 'SCHEDULED'
            AND b.student_id IS NOT NULL
        ), _reschedules AS (
         SELECT r.id AS source_id,
            'reschedule'::text AS source_type,
            r.tenant_id,
            r.teacher_id,
            r.student_id,
            NULL::text AS student_name_override,
            NULL::text AS student_phone_override,
            r.date::date AS class_date,
            r."time" AS time_text,
            (((r.date::text || ' ') || r."time") || ':00')::timestamp
              AT TIME ZONE 'America/Sao_Paulo' AS start_at
           FROM reschedules r
          WHERE r."time" ~ '^[0-9]{2}:[0-9]{2}$'::text
        ), _appointments AS (
         SELECT a.id AS source_id,
            'appointment'::text AS source_type,
            a.tenant_id,
            a.teacher_id,
            NULL::uuid AS student_id,
            a.student_name AS student_name_override,
            a.student_phone AS student_phone_override,
            a.start_time::date AS class_date,
            to_char(a.start_time, 'HH24:MI'::text) AS time_text,
            a.start_time AS start_at
           FROM appointments a
          WHERE a.start_time IS NOT NULL
        )
 SELECT source_id, source_type, tenant_id, teacher_id, student_id,
        student_name_override, student_phone_override, class_date, time_text, start_at
   FROM _bookings_expanded
 UNION ALL
 SELECT source_id, source_type, tenant_id, teacher_id, student_id,
        student_name_override, student_phone_override, class_date, time_text, start_at
   FROM _reschedules
 UNION ALL
 SELECT source_id, source_type, tenant_id, teacher_id, student_id,
        student_name_override, student_phone_override, class_date, time_text, start_at
   FROM _appointments;
