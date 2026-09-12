import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('telas de experimental preservam o bloqueio de conclusão antecipada', () => {
  it.each(['TrialsToContracts.tsx', 'TrialFeedbackForm.tsx', 'marketing/LeadsKanban.tsx'])(
    '%s traduz horário inválido/fim pendente e exige confirmação JSON verdadeira', file => {
      const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), file), 'utf8');
      expect(source).toContain('appointment_not_ended');
      expect(source).toContain('appointment_time_missing');
      expect(source).toContain('data?.ok !== true');
      expect(source).not.toContain('overrideBeforeEnd');
    },
  );
});
