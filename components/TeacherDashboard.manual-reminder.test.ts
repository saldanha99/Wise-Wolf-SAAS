import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'components/TeacherDashboard.tsx'), 'utf8');

describe('TeacherDashboard manual reminder safety', () => {
  it('sends the canonical occurrence identity to the server', () => {
    expect(source).toContain('source_id: aula.source_id');
    expect(source).toContain('source_type: aula.source_type');
    expect(source).toContain('class_date: aula.class_date');
    expect(source).toContain("source_type: 'BOOKING'");
    expect(source).toContain("source_type: 'RESCHEDULE'");
    expect(source).toContain("source_type: 'APPOINTMENT'");
  });

  it('keeps manual dispatch hidden until AUTO is explicitly disabled', () => {
    expect(source).toContain('teacherWa.automation === false && (');
    expect(source).toContain('setTeacherWa(previous => ({ ...previous, automation: null }))');
  });

  it('reads scheduled appointments from canonical start_time in São Paulo', () => {
    expect(source).toContain("id, start_time, student_name, student_phone, type, status");
    expect(source).toContain(".eq('status', 'scheduled')");
    expect(source).toContain("timeZone: 'America/Sao_Paulo'");
    expect(source).not.toContain('id, time, date, student_name');
  });

  it('only marks the button sent after a traceable provider receipt', () => {
    expect(source).toContain("fnData?.delivery !== 'accepted'");
    expect(source).toContain("typeof fnData?.provider_message_id !== 'string'");
    expect(source).toContain("notification_already_claimed");
  });
});
