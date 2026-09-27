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
 *   - contrato ainda não assinado → a versão que a ESCOLA oferece hoje (é o que
 *     a pessoa vai assinar). A cláusula afirma que a escola grava as aulas no
 *     Google Meet e contrata o provedor de IA: só a escola que decidiu isso
 *     oferece a versão 2 (tabela `tenant_contract_terms`; sem decisão = 1).
 *     Sem saber o que a escola oferece, o texto é o de antes — nunca uma
 *     cláusula que a escola não decidiu;
 *   - contrato assinado com versão gravada no aceite → a versão gravada;
 *   - contrato assinado sem versão gravada → versão 1, o texto de antes.
 *
 * A tela que ASSINA mostra e grava a mesma versão (a oferecida): a página de
 * matrícula e o convite do professor recebem da edge `tenant-legal-assets`;
 * o professor que regulariza pelo app lê por `get_contract_terms`. O servidor
 * recusa gravar versão diferente da oferecida (página desatualizada).
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

/**
 * Versão mais nova do texto que esta tela sabe mostrar. NÃO é o que um
 * contrato não assinado mostra: isso é a versão que a escola oferece.
 */
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
  /** Versão que a escola oferece aos contratos novos (vale para o não assinado). */
  offeredVersion?: unknown;
}

/**
 * Versão do texto que o documento mostra. Contrato assinado sem versão gravada
 * é SEMPRE o texto de antes — é o que garante que contrato antigo não ganha
 * cláusula que a pessoa nunca leu. Contrato não assinado mostra a versão que a
 * escola oferece; sem essa informação, o texto de antes.
 */
export function resolveContractTermsVersion(kind: ContractKind, input: ContractTermsVersionInput): number {
  const recorded = parseContractTermsVersion(kind, input.recordedVersion);
  if (recorded !== null) return recorded;
  if (input.signed) return LEGACY_CONTRACT_TERMS_VERSION;
  return parseContractTermsVersion(kind, input.offeredVersion) ?? LEGACY_CONTRACT_TERMS_VERSION;
}

export interface SignedContractEvidenceInput {
  /** `profiles.accepted_at`: a PRIMEIRA assinatura da pessoa naquela escola. */
  profileAcceptedAt?: string | null;
  /** `profiles.signature_ip` (ou `user_ip`) daquela primeira assinatura. */
  profileIp?: string | null;
  /** Data do aceite que definiu a versão (`contract_terms_acceptances`). */
  recordedAcceptedAt?: string | null;
}

export interface SignedContractEvidence {
  acceptedAt?: string;
  userIp?: string;
  /** A data veio do aceite gravado, e não do perfil (rematrícula). */
  fromRecordedAcceptance: boolean;
}

const validTime = (value?: string | null): number | null => {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
};

/**
 * Data e IP que o selo do contrato mostra. Numa rematrícula o perfil MANTÉM a
 * assinatura antiga (`begin_enrollment_offer` faz coalesce), e o aceite da
 * versão nova tem data própria: mostrar a data antiga ao lado de "Versão do
 * texto: 2" diria que a cláusula foi assinada antes de existir. Então, quando
 * o aceite gravado é de OUTRO momento, vale a data dele — e o IP, que é da
 * assinatura antiga, não é repetido como se fosse desta. Na assinatura normal
 * as duas datas são a mesma (o servidor grava a do perfil) e nada muda.
 */
export function signedContractEvidence(input: SignedContractEvidenceInput): SignedContractEvidence {
  const profileTime = validTime(input.profileAcceptedAt);
  const recordedTime = validTime(input.recordedAcceptedAt);
  if (recordedTime !== null && recordedTime !== profileTime) {
    return {
      acceptedAt: input.recordedAcceptedAt ?? undefined,
      userIp: undefined,
      fromRecordedAcceptance: true,
    };
  }
  return {
    acceptedAt: input.profileAcceptedAt ?? undefined,
    userIp: input.profileIp ?? undefined,
    fromRecordedAcceptance: false,
  };
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
