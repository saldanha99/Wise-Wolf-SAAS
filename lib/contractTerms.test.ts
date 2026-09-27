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
  type ContractKind,
} from './contractTerms';

const ROOT = join(__dirname, '..');
const KINDS: ContractKind[] = ['STUDENT', 'TEACHER'];

describe('versão do texto do contrato', () => {
  it.each(KINDS)('%s: contrato ainda não assinado mostra a versão atual, com a cláusula do registro', (kind) => {
    const version = resolveContractTermsVersion(kind, { signed: false });
    expect(version).toBe(CURRENT_CONTRACT_TERMS_VERSION[kind]);
    expect(contractIncludesLessonRecording(kind, version)).toBe(true);
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

  it('a edge register-teacher grava a versão atual do contrato do professor', () => {
    const edge = readFileSync(join(ROOT, 'supabase/functions/register-teacher/contract-terms.ts'), 'utf8');
    const match = edge.match(/TEACHER_CONTRACT_TERMS_VERSION\s*=\s*(\d+)/);
    expect(match, 'constante da edge não encontrada').not.toBeNull();
    expect(Number(match?.[1])).toBe(CURRENT_CONTRACT_TERMS_VERSION.TEACHER);
    const index = readFileSync(join(ROOT, 'supabase/functions/register-teacher/index.ts'), 'utf8');
    expect(index).toMatch(/contractTermsVersion,\s*\n\s*}/);
    expect(index).toContain('from("contract_terms_acceptances")');
  });
});
