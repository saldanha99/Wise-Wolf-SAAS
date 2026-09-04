import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'LeadsKanban.tsx'),
    'utf8',
);

describe('LeadsKanban — experimental autoritativa', () => {
    it('agenda pelo comando seguro e nunca fabrica perfil ou reposição', () => {
        expect(source).toContain("'schedule_manual_trial_secure'");
        expect(source).toContain('leadId: schedulingLead.id');
        expect(source).toContain('teacherConfirmationUrl');
        expect(source).not.toContain(".from('reschedules')");
        expect(source).not.toMatch(/\.from\('profiles'\)[\s\S]{0,300}\.insert\(/);
    });

    it('conclui e converte somente pela opportunity_id persistida', () => {
        expect(source).toContain("'update_trial_outcome_secure'");
        expect(source).toContain("data?.error === 'appointment_not_ended'");
        expect(source).toContain("String(convertingLead.opportunity_id || '').trim()");
        expect(source).not.toContain('canonicalPhone');
        expect(source).not.toMatch(/matchingOpportunities|student_phone\) ===/);
    });
});
