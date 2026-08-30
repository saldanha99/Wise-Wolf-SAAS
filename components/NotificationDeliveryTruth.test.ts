import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('WhatsApp delivery truth in callers', () => {
  it('never labels the schedule confirmation as sent without an occurrence and provider receipt', () => {
    const explorer = source('components/TeacherScheduleExplorer.tsx');
    expect(explorer).toContain("throw new Error('occurrence_identity_unavailable')");
    expect(explorer).toContain("result?.delivery !== 'accepted'");
    expect(explorer).toContain("typeof result?.provider_message_id !== 'string'");
    expect(explorer).toContain('notificationConfirmed = true');
    expect(explorer).toContain('O WhatsApp não confirmou o envio');
  });

  it('requires a confirmed provider message in reminder, reschedule and Wolfie callers', () => {
    for (const path of [
      'components/TeacherDashboard.tsx',
      'components/TeacherReschedules.tsx',
      'components/WolfieAssignButton.tsx',
    ]) {
      const file = source(path);
      expect(file).toContain("delivery !== 'accepted'");
      expect(file).toContain("provider_message_id !== 'string'");
    }
  });

  it('has no legacy browser-side reschedule send', () => {
    const app = source('App.tsx');
    expect(app).not.toContain('whatsappService.sendRescheduleConfirmation');
    expect(app).not.toContain("from './services/whatsappService'");
  });
});
