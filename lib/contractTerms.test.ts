import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CURRENT_CONTRACT_TERMS_VERSION,
  LEGACY_CONTRACT_TERMS_VERSION,
  LESSON_RECORDING_CLAUSE_SINCE,
  contractIncludesLessonRecording,
  contractTermsLabel,
  parseContractTermsVersion,
  resolveContractTermsVersion,
  signedContractEvidence,
  type ContractKind,
} from './contractTerms';

const ROOT = join(__dirname, '..');
const KINDS: ContractKind[] = ['STUDENT', 'TEACHER'];

describe('versão do texto do contrato', () => {
  it.each(KINDS)('%s: contrato ainda não assinado mostra a versão que a escola oferece', (kind) => {
    // Escola que decidiu registrar as aulas: a versão com a cláusula.
    const withClause = resolveContractTermsVersion(kind, { signed: false, offeredVersion: 2 });
    expect(withClause).toBe(CURRENT_CONTRACT_TERMS_VERSION[kind]);
    expect(contractIncludesLessonRecording(kind, withClause)).toBe(true);
    // Escola que não decidiu: o texto sem a cláusula — o contrato não afirma
    // que ela grava aulas no Meet nem que contrata o provedor de IA.
    const withoutClause = resolveContractTermsVersion(kind, { signed: false, offeredVersion: 1 });
    expect(withoutClause).toBe(LEGACY_CONTRACT_TERMS_VERSION);
    expect(contractIncludesLessonRecording(kind, withoutClause)).toBe(false);
  });

  it.each(KINDS)('%s: sem saber o que a escola oferece, o texto de antes (nunca uma cláusula não decidida)', (kind) => {
    for (const offeredVersion of [undefined, null, 'x', 99, 0]) {
      expect(resolveContractTermsVersion(kind, { signed: false, offeredVersion }), JSON.stringify(offeredVersion))
        .toBe(LEGACY_CONTRACT_TERMS_VERSION);
    }
  });

  it.each(KINDS)('%s: o que a escola oferece hoje nunca muda o contrato já assinado', (kind) => {
    expect(resolveContractTermsVersion(kind, { signed: true, offeredVersion: 2 })).toBe(LEGACY_CONTRACT_TERMS_VERSION);
    expect(resolveContractTermsVersion(kind, { signed: true, recordedVersion: 2, offeredVersion: 1 })).toBe(2);
  });

  it.each(KINDS)('%s: contrato assinado sem versão gravada é o texto de antes', (kind) => {
    for (const recordedVersion of [undefined, null, '', 'abc', 0, -1, 1.5, 99, {}]) {
      const version = resolveContractTermsVersion(kind, { signed: true, recordedVersion });
      expect(version, JSON.stringify(recordedVersion)).toBe(LEGACY_CONTRACT_TERMS_VERSION);
      expect(contractIncludesLessonRecording(kind, version)).toBe(false);
    }
  });

  it.each(KINDS)('%s: a versão gravada no aceite vale, venha como número ou texto', (kind) => {
    expect(resolveContractTermsVersion(kind, { signed: true, recordedVersion: 2 })).toBe(2);
    expect(resolveContractTermsVersion(kind, { signed: true, recordedVersion: ' 2 ' })).toBe(2);
    expect(resolveContractTermsVersion(kind, { signed: true, recordedVersion: 1 })).toBe(1);
    // Versão gravada vale mesmo para o que ainda aparece como "não assinado".
    expect(resolveContractTermsVersion(kind, { signed: false, recordedVersion: 1 })).toBe(1);
  });

  it('só aceita versão que esta tela conhece', () => {
    expect(parseContractTermsVersion('STUDENT', 2)).toBe(2);
    expect(parseContractTermsVersion('STUDENT', CURRENT_CONTRACT_TERMS_VERSION.STUDENT + 1)).toBeNull();
    expect(parseContractTermsVersion('TEACHER', null)).toBeNull();
  });

  it('assinatura normal: data e IP do perfil (o aceite gravado tem a mesma data)', () => {
    expect(signedContractEvidence({
      profileAcceptedAt: '2026-09-28T13:00:00.123Z',
      profileIp: '203.0.113.9',
      recordedAcceptedAt: '2026-09-28T13:00:00.123+00:00',
    })).toEqual({ acceptedAt: '2026-09-28T13:00:00.123Z', userIp: '203.0.113.9', fromRecordedAcceptance: false });
    // Contrato de antes, sem aceite gravado: como sempre foi.
    expect(signedContractEvidence({ profileAcceptedAt: '2026-02-10T12:00:00Z', profileIp: '198.51.100.1' }))
      .toEqual({ acceptedAt: '2026-02-10T12:00:00Z', userIp: '198.51.100.1', fromRecordedAcceptance: false });
  });

  it('rematrícula: vale a data do aceite da versão nova, e o IP da assinatura antiga não é repetido', () => {
    expect(signedContractEvidence({
      profileAcceptedAt: '2026-02-10T12:00:00Z',
      profileIp: '198.51.100.1',
      recordedAcceptedAt: '2026-09-28T13:00:00Z',
    })).toEqual({ acceptedAt: '2026-09-28T13:00:00Z', userIp: undefined, fromRecordedAcceptance: true });
    // Matrícula migrada (aceite sem data no perfil) que assina de novo.
    expect(signedContractEvidence({ profileAcceptedAt: null, recordedAcceptedAt: '2026-09-28T13:00:00Z' }).acceptedAt)
      .toBe('2026-09-28T13:00:00Z');
    // Data gravada inválida não substitui nada.
    expect(signedContractEvidence({ profileAcceptedAt: '2026-02-10T12:00:00Z', recordedAcceptedAt: 'lixo' }).acceptedAt)
      .toBe('2026-02-10T12:00:00Z');
  });

  it('rótulo diz se o texto assinado tem ou não a cláusula', () => {
    expect(contractTermsLabel('STUDENT', 2)).toMatch(/com a cláusula do registro das aulas/);
    expect(contractTermsLabel('STUDENT', 1)).toMatch(/texto anterior, sem a cláusula/);
  });
});

/**
 * O número da versão vive em três lugares que não podem divergir: esta tela,
 * a tabela contract_terms_versions (migration) e a edge register-teacher.
 */
describe('versão do contrato: tela, banco e edge contam a mesma história', () => {
  const migration = readFileSync(
    join(ROOT, 'supabase/migrations/20260927150000_versao_do_contrato_no_aceite.sql'),
    'utf8',
  );
  const seeded = [...migration.matchAll(/\('(STUDENT|TEACHER)',\s*(\d+),\s*(true|false),/g)]
    .map(([, kind, version, includes]) => ({ kind: kind as ContractKind, version: Number(version), includes: includes === 'true' }));

  it('a varredura enxerga as versões cadastradas (âncora do teste)', () => {
    expect(seeded.length).toBeGreaterThanOrEqual(4);
  });

  it.each(KINDS)('%s: a versão atual da tela está cadastrada e é a mais nova do banco', (kind) => {
    const versions = seeded.filter(row => row.kind === kind);
    expect(Math.max(...versions.map(row => row.version))).toBe(CURRENT_CONTRACT_TERMS_VERSION[kind]);
    expect(versions.some(row => row.version === LEGACY_CONTRACT_TERMS_VERSION && !row.includes)).toBe(true);
  });

  it.each(KINDS)('%s: a primeira versão com a cláusula é a mesma na tela e no banco', (kind) => {
    const withClause = seeded.filter(row => row.kind === kind && row.includes).map(row => row.version);
    expect(Math.min(...withClause)).toBe(LESSON_RECORDING_CLAUSE_SINCE[kind]);
    for (const row of seeded.filter(r => r.kind === kind)) {
      expect(contractIncludesLessonRecording(kind, row.version), `${kind} v${row.version}`).toBe(row.includes);
    }
  });

  it('a edge register-teacher conhece a mesma versão mais nova e grava o aceite', () => {
    const edge = readFileSync(join(ROOT, 'supabase/functions/register-teacher/contract-terms.ts'), 'utf8');
    const match = edge.match(/TEACHER_CONTRACT_TERMS_VERSION\s*=\s*(\d+)/);
    expect(match, 'constante da edge não encontrada').not.toBeNull();
    expect(Number(match?.[1])).toBe(CURRENT_CONTRACT_TERMS_VERSION.TEACHER);
    expect(edge).toContain('from("contract_terms_acceptances")');
    expect(edge).toContain('"contract_terms_offered_version"');
    const index = readFileSync(join(ROOT, 'supabase/functions/register-teacher/index.ts'), 'utf8');
    expect(index).toMatch(/contractTermsVersion,\s*\n\s*}/);
    expect(index).toContain('await recordTeacherContractTerms(admin, {');
  });

  it('a migration só dá a versão com a cláusula à escola que decidiu (sem decisão = 1)', () => {
    expect(migration).toMatch(/create table if not exists public\.tenant_contract_terms/);
    expect(migration).toMatch(/coalesce\(\s*\(select offer\.terms_version[\s\S]*?\),\s*1\s*\)/);
    // A semente da Wise Wolf é one-shot, não roda de novo a cada release.
    expect(migration).toContain("key = 'contrato_registro_das_aulas_wise_wolf_20260927'");
  });
});
