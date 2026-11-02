import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('notificações respeitam o status atual do aluno', () => {
  for (const name of ['prepare-daily-reminders', 'send-class-notification', 'send-attendance-confirmations', 'process-notification-queue', 'notify-payment-due']) {
    it(`${name} consulta a porta canônica e exige true explícito`, () => {
      const source = readFileSync(`supabase/functions/${name}/index.ts`, 'utf8');
      expect(source).toMatch(/rpc\(["']is_student_notifiable["']/);
      expect(source).toContain('eligibility.error');
      expect(source).toContain('eligibility.data !== true');
    });
  }
});
