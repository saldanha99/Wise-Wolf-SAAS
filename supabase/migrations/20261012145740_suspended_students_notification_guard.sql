-- PostgreSQL da VPS: preserva a autorização e as cercas atuais. Não altera
-- matrículas, cobranças ou recibos já aceitos; somente endurece elegibilidade.
do $patch$
declare
  definition text;
  anchor text;
begin
  definition := pg_get_functiondef('public.is_student_notifiable(uuid)'::regprocedure);
  if position('SUSPENDED' in definition) = 0 then
    anchor := ') <> ''ARCHIVED''';
    if position(anchor in definition) = 0 then raise exception 'notifiable_guard_anchor_missing'; end if;
    definition := replace(definition, anchor, ') not in (''ARCHIVED'', ''SUSPENDED'')');
    definition := replace(definition,
      '''inativo'', ''inactive'', ''arquivado'', ''cancelado'', ''trancado''',
      '''inativo'', ''inactive'', ''arquivado'', ''cancelado'', ''trancado'', ''suspenso'', ''suspended'', ''pausado''');
    execute definition;
  end if;

  definition := pg_get_functiondef('public.claim_attendance_confirmation_deliveries(integer)'::regprocedure);
  if position('public.is_student_notifiable(ac.student_id)' in definition) = 0 then
    anchor := 'and ac.send_attempts < 8';
    if position(anchor in definition) = 0 then raise exception 'attendance_claim_guard_anchor_missing'; end if;
    execute replace(definition, anchor, anchor || E'\n       and public.is_student_notifiable(ac.student_id)');
  end if;

  definition := pg_get_functiondef('public.birthdays_today()'::regprocedure);
  if position('public.is_student_notifiable(profile.id)' in definition) = 0 then
    anchor := 'and profile.birth_date is not null';
    if position(anchor in definition) = 0 then raise exception 'birthday_guard_anchor_missing'; end if;
    execute replace(definition, anchor, anchor || E'\n    and (profile.role <> ''STUDENT'' or public.is_student_notifiable(profile.id))');
  end if;

  definition := pg_get_functiondef('public.bind_attendance_quality_delivery(uuid,uuid,text,text,boolean)'::regprocedure);
  if position('public.is_student_notifiable(student_id)' in definition) = 0 then
    anchor := 'and delivery_status=''PROCESSING''';
    if position(anchor in definition) = 0 then raise exception 'attendance_bind_guard_anchor_missing'; end if;
    execute replace(definition, anchor, anchor || ' and public.is_student_notifiable(student_id)');
  end if;

  definition := pg_get_functiondef('public.begin_notification_delivery_submission(uuid,uuid,text,text,text,text,uuid,bigint)'::regprocedure);
  if position('student_notifications_suppressed' in definition) = 0 then
    anchor := '  if v_kind=''ENROLLMENT_STUDENT_CONFIRMED'' then';
    if position(anchor in definition) = 0 then raise exception 'queue_submission_guard_anchor_missing'; end if;
    execute replace(definition, anchor, $guard$
  -- Também no replay: status alterado depois do claim impede novo POST.
  -- Avisos oficiais de suspensão/saída permanecem no fluxo específico.
  if v_notification.student_id is not null and v_kind in (
    'LESSON_REMINDER', 'BIRTHDAY', 'ORAL_TEST_STUDENT', 'ORAL_TEST_REMINDER_STUDENT',
    'LESSON_RECORDING_NOTICE_STUDENT', 'LESSON_RECORDING_CONSENT_REQUEST',
    'SCHEDULE_CHANGE_FAMILY_ACCEPTANCE', 'ENROLLMENT_STUDENT_CONFIRMED',
    'TEACHER_MEET_ROOM'
  ) and not public.is_student_notifiable(v_notification.student_id) then
    return pg_catalog.jsonb_build_object('ok',false,'action','REVIEW_REQUIRED',
      'reason','student_notifications_suppressed');
  end if;
$guard$ || anchor);
  end if;
end;
$patch$;

notify pgrst, 'reload schema';
