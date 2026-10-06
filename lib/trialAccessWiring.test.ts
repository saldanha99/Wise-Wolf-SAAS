import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');
describe('experimental: acesso não vira SDR comercial', () => {
  it('pedido de acesso retorna antes do modelo, com fence e handoff revalidado', () => {
    const source = read('supabase/functions/whatsapp-inbound/index.ts');
    const handler = source.slice(source.indexOf('async function handleSDR('));
    const access = handler.slice(handler.indexOf('if (!isMedia && asksLessonAccess(text))'), handler.indexOf('const hoursAnswer'));
    expect(access).toContain('loadTrialAccess(');
    expect(access).toContain('isLatestSdrTurn(');
    expect(access).toContain('handoffAtivo(current)');
    expect(access).toContain('await beginEffects()');
    expect(access).toContain('ai_handoff: true');
    expect(access).toContain('return;');
    expect(access).not.toMatch(/callAI\(|dispatchTrial\(|schedule_trial/);
    expect(handler.indexOf('asksLessonAccess(text)')).toBeLessThan(handler.indexOf('const ai = await callAI('));
    expect(handler).not.toContain('online e presenciais');
    expect(handler).not.toContain('tenantIdentity.location');
    expect(handler).toContain('afterTrial || modalityVeto ? null : ai.schedule_trial');
  });
  it('agenda e lançamento respeitam link do appointment e a régua da sala oficial', () => {
    const dashboard = read('components/TeacherDashboard.tsx');
    const launcher = read('components/LessonLauncher.tsx');
    expect(dashboard).toContain('t.meeting_link || user.meeting_link');
    expect(dashboard).toContain('Sem link de acesso cadastrado.');
    expect(launcher).toContain('t.meeting_link || teacherMeetLink');
    expect(launcher).toContain('type, status, meeting_link');
  });
  it('release registra os testes dinâmicos do acesso', () => {
    const release = read('deploy/vps/release.sh');
    const tests = release.slice(release.indexOf('npx --yes deno@2.9.5 test --allow-env='), release.indexOf('npx --yes deno@2.9.5 test --allow-read'));
    expect(tests).toContain('supabase/functions/whatsapp-inbound/trial-access.test.ts');
  });
});
