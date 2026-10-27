import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { teacherPjClauses } from './teacherPjContract';

// A V3 tem número próprio e será reconstruída pelo snapshot das assinaturas.
// Depois de publicada, correção de cláusula exige V4; não atualizar este hash
// para fazer passar uma alteração que reescreva o documento já aceito.
it('preserva o texto das cláusulas 1–10 da versão 3', () => {
  const digest = createHash('sha256').update(JSON.stringify(teacherPjClauses(8))).digest('hex');
  expect(digest).toBe('273cd282441d7279116a8a7bc7597739c1d3ede725d2d281f6c98dd77d51b0f8');
});
