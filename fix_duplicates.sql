
-- Find duplicate class logs
SELECT 
    teacher_id, 
    student_id, 
    (created_at AT TIME ZONE 'UTC')::date as log_date, 
    presence, 
    COUNT(*)
FROM class_logs
GROUP BY teacher_id, student_id, log_date, presence
HAVING COUNT(*) > 1;

-- To delete them (keeping the newest one)
DELETE FROM class_logs a
USING class_logs b
WHERE a.id < b.id
  AND a.teacher_id = b.teacher_id
  AND a.student_id = b.student_id
  AND (a.created_at AT TIME ZONE 'UTC')::date = (b.created_at AT TIME ZONE 'UTC')::date
  AND a.presence = b.presence;
