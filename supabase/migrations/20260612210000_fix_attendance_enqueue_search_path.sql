-- Religa o anti-fraude de presenca.
-- O cron wisewolf-send-attendance-confirmations (job 10) falhava 100% desde 31/05
-- (1207 falhas) com "function gen_random_bytes(integer) does not exist": pgcrypto
-- vive no schema "extensions", mas a funcao tinha SET search_path TO 'public'.
-- Por isso attendance_confirmations ficou com 0 linhas (nenhuma confirmacao criada).
-- Correcao: qualificar extensions.gen_random_bytes + ampliar o search_path.

CREATE OR REPLACE FUNCTION public.enqueue_attendance_confirmations()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_count int;
  r record;
BEGIN
  INSERT INTO attendance_confirmations
    (tenant_id, source_id, source_type, teacher_id, student_id, student_name, student_phone,
     class_date, class_time, teacher_name, token, status)
  SELECT
    uc.tenant_id, uc.source_id::text, uc.source_type, uc.teacher_id, uc.student_id,
    COALESCE(sp.full_name, uc.student_name_override),
    COALESCE(sp.phone, uc.student_phone_override),
    uc.class_date, uc.time_text, tp.full_name,
    encode(extensions.gen_random_bytes(12), 'hex'), 'PENDING'
  FROM upcoming_classes uc
  LEFT JOIN profiles sp ON sp.id = uc.student_id
  LEFT JOIN profiles tp ON tp.id = uc.teacher_id
  WHERE uc.start_at <= now() - INTERVAL '40 minutes'   -- aula ja terminou
    AND uc.start_at >= now() - INTERVAL '8 hours'        -- janela de captura (idempotencia cobre overlap)
    AND COALESCE(sp.phone, uc.student_phone_override) IS NOT NULL
    AND length(regexp_replace(COALESCE(sp.phone, uc.student_phone_override), '\D', '', 'g')) >= 10
  ON CONFLICT (source_id, source_type, class_date) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- religa com lancamentos que porventura ja existam (professor lancou antes da confirmacao ser criada)
  FOR r IN
    SELECT id FROM attendance_confirmations
     WHERE status = 'PENDING' AND class_date >= CURRENT_DATE - 2
  LOOP
    PERFORM reconcile_attendance_confirmation(r.id);
  END LOOP;

  RETURN v_count;
END;
$function$;
