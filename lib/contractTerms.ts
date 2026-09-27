/**
 * Versão do texto dos contratos de aluno e de professor.
 *
 * O texto dos contratos é montado na tela (`components/ContractDocument.tsx` e
 * `components/TeacherContractDocument.tsx`) a partir dos dados do perfil. Sem
 * versão, qualquer mudança no texto mudaria também o que quem JÁ assinou vê —
 * e contrato assinado não pode mudar de texto.
 *
 * Decisão da direção (27/09/2026): as aulas da escola são registradas por
 * decisão da escola (transcrição e anotações automáticas do Google Meet,
 * resumo pedagógico com IA revisado pelo professor, relatório de presença), e
 * os NOVOS contratos trazem a cláusula que diz isso. A versão 2 é a primeira
 * com essa cláusula.
 *
 * A regra de leitura é uma só:
 *   - contrato ainda não assinado → versão atual (é o que a pessoa vai assinar);
 *   - contrato assinado com versão gravada no aceite → a versão gravada;
 *   - contrato assinado sem versão gravada → versão 1, o texto de antes.
 *
 * A versão é gravada pelo servidor no aceite (migration
 * `20260927150000_versao_do_contrato_no_aceite`): tabela
 * `contract_terms_acceptances`, e no contrato do professor por convite também
 * em `tenant_contract_records.commercial_snapshot.contractTermsVersion`.
 * ⚠️ Versão nova de texto = número novo AQUI, na migration (tabela
 * `contract_terms_versions`) e na edge `register-teacher`
 * (`contract-terms.ts`). `lib/contractTerms.test.ts` confere os três.
 */

export type ContractKind = 'STUDENT' | 'TEACHER';

/** Texto de antes da cláusula do registro das aulas. */
export const LEGACY_CONTRACT_TERMS_VERSION = 1;

/** Versão que um contrato ainda não assinado mostra (e que a pessoa assina). */
export const CURRENT_CONTRACT_TERMS_VERSION: Readonly<Record<ContractKind, number>> = {
  STUDENT: 2,
  TEACHER: 2,
};

/** Primeira versão de cada contrato que traz a cláusula do registro das aulas. */
export const LESSON_RECORDING_CLAUSE_SINCE: Readonly<Record<ContractKind, number>> = {
  STUDENT: 2,
  TEACHER: 2,
};

/** Versão conhecida por esta tela (inteira, de 1 até a atual). */
export function isKnownContractTermsVersion(kind: ContractKind, value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= LEGACY_CONTRACT_TERMS_VERSION
    && value <= CURRENT_CONTRACT_TERMS_VERSION[kind];
}

/** Aceita o que vem do banco/edge (número ou texto numérico); o resto vira `null`. */
export function parseContractTermsVersion(kind: ContractKind, value: unknown): number | null {
  const parsed = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  return isKnownContractTermsVersion(kind, parsed) ? parsed : null;
}

export interface ContractTermsVersionInput {
  /** O contrato já foi aceito (assinado, ou marcado como aceito sem data). */
  signed: boolean;
  /** Versão gravada no aceite, quando existe. */
  recordedVersion?: unknown;
}

/**
 * Versão do texto que o documento mostra. Contrato assinado sem versão gravada
 * é SEMPRE o texto de antes — é o que garante que contrato antigo não ganha
 * cláusula que a pessoa nunca leu.
 */
export function resolveContractTermsVersion(kind: ContractKind, input: ContractTermsVersionInput): number {
  const recorded = parseContractTermsVersion(kind, input.recordedVersion);
  if (recorded !== null) return recorded;
  return input.signed ? LEGACY_CONTRACT_TERMS_VERSION : CURRENT_CONTRACT_TERMS_VERSION[kind];
}

/** O texto desta versão traz a cláusula do registro das aulas? */
export function contractIncludesLessonRecording(kind: ContractKind, version: number): boolean {
  return version >= LESSON_RECORDING_CLAUSE_SINCE[kind];
}

/** Rótulo curto para a direção conferir o que cada pessoa assinou. */
export function contractTermsLabel(kind: ContractKind, version: number): string {
  return contractIncludesLessonRecording(kind, version)
    ? `Versão ${version} — com a cláusula do registro das aulas`
    : `Versão ${version} — texto anterior, sem a cláusula do registro das aulas`;
}
