-- Cross-session view for student correction history
CREATE OR REPLACE VIEW student_recent_corrections AS
SELECT c.*, s.student_id
FROM wolfie_corrections c
JOIN wolfie_sessions s ON c.session_id = s.id;
