/**
 * Versão do texto do contrato do professor que a página de cadastro mostrou e
 * congelou no PDF assinado.
 *
 * A versão 2 traz a Cláusula 11ª — Registro das Aulas (decisão da direção de
 * 27/09/2026: as aulas são registradas por decisão da escola e quem assina o
 * contrato já concorda). A página antiga não mandava a versão e mostrava o
 * texto de antes: ela é recusada com 409 ("recarregue a página"), como já é
 * feito com o valor por aula (`rateUnit`), para que nenhum contrato novo
 * nasça sem a cláusula.
 *
 * ⚠️ Mesmo número em `lib/contractTerms.ts` (CURRENT_CONTRACT_TERMS_VERSION)
 * e na tabela `contract_terms_versions` (migration 20260927150000).
 * `lib/contractTerms.test.ts` confere os três.
 */
export const TEACHER_CONTRACT_TERMS_VERSION = 2;

/** A versão pedida é a que esta função sabe gravar? */
export function acceptedTeacherContractTermsVersion(
  value: unknown,
): number | null {
  return value === TEACHER_CONTRACT_TERMS_VERSION
    ? TEACHER_CONTRACT_TERMS_VERSION
    : null;
}
