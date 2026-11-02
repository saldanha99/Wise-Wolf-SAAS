import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const source = (relativePath: string) =>
  readFileSync(path.join(repositoryRoot, relativePath), 'utf8');

describe('matrícula não depende do feedback da experimental', () => {
  it('mantém o botão de matrícula liberado e trata o feedback só como pendência', () => {
    const screen = source('components/TrialsToContracts.tsx');

    expect(screen).toContain('Feedback do professor pendente. A matrícula já está liberada.');
    expect(screen).not.toContain('disabled={feedbackPending}');
    expect(screen).not.toContain('Aguardando feedback');
    expect(screen).not.toContain('trial_feedback_required');
  });

  it.each([
    'supabase/functions/school-admin/index.ts',
    'supabase/functions/post-trial-pipeline/index.ts',
    'supabase/functions/school-ai-team/index.ts',
  ])('%s não usa feedback como condição comercial', relativePath => {
    const implementation = source(relativePath);

    expect(implementation).not.toContain('TRIAL_FEEDBACK_REQUIRED');
    expect(implementation).not.toContain('feedback_required');
  });
});
