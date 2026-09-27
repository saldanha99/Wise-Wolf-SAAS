/// <reference lib="deno.ns" />

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";

/**
 * Versão do texto do contrato do professor que a página de cadastro mostrou e
 * congelou no PDF assinado.
 *
 * A versão 2 traz a Cláusula 11ª — Registro das Aulas (decisão da direção de
 * 27/09/2026: as aulas são registradas por decisão da escola, o registro
 * integra a execução do contrato e quem assina fica ciente, com o direito de
 * pedir para não ser registrado). A cláusula diz que a CONTRATANTE grava as
 * aulas no Google Meet e contrata o provedor de IA, então só a escola que decidiu isso
 * a oferece (`public.contract_terms_offered_version`, tabela
 * `tenant_contract_terms`; sem decisão = versão 1). A página recebe a versão
 * oferecida junto do convite (edge `tenant-legal-assets`) e devolve a que
 * mostrou; aqui ela tem de ser a que a escola do convite oferece AGORA.
 * Página antiga (sem versão) ou desatualizada é recusada com 409 ("recarregue
 * a página"), como já é feito com o valor por aula (`rateUnit`).
 *
 * ⚠️ `TEACHER_CONTRACT_TERMS_VERSION` é a mais nova que esta função conhece:
 * mesmo número em `lib/contractTerms.ts` (CURRENT_CONTRACT_TERMS_VERSION) e na
 * tabela `contract_terms_versions` (migration 20260927150000).
 * `lib/contractTerms.test.ts` confere os três.
 */
export const TEACHER_CONTRACT_TERMS_VERSION = 2;

/**
 * A versão que a página diz ter mostrado, se for uma que esta função conhece
 * (inteira, de 1 até a mais nova). Página antiga, sem versão → `null` (409).
 */
export function requestedTeacherContractTermsVersion(
  value: unknown,
): number | null {
  return typeof value === "number" && Number.isInteger(value) &&
      value >= 1 && value <= TEACHER_CONTRACT_TERMS_VERSION
    ? value
    : null;
}

/** A página mostrou uma versão que a escola do convite não oferece mais. */
export class ContractTermsVersionMismatchError extends Error {
  constructor(readonly requested: number, readonly offered: number) {
    super("contract_terms_version_mismatch");
    this.name = "ContractTermsVersionMismatchError";
  }
}

/**
 * Versão que a escola do convite oferece aos contratos novos. Falha de leitura
 * ou resposta estranha LANÇA: sem saber o texto, o cadastro não conclui.
 */
export async function offeredTeacherContractTermsVersion(
  admin: SupabaseClient,
  tenantId: string,
): Promise<number> {
  const { data, error } = await admin.rpc("contract_terms_offered_version", {
    p_tenant: tenantId,
    p_contract_kind: "TEACHER",
  });
  if (
    error || typeof data !== "number" || !Number.isInteger(data) || data < 1 ||
    data > TEACHER_CONTRACT_TERMS_VERSION
  ) {
    throw new Error("contract_terms_offer_unavailable");
  }
  return data;
}

/** O contrato só nasce com a versão que a escola do convite oferece. */
export function assertOfferedTeacherContractTermsVersion(
  requested: number,
  offered: number,
): number {
  if (requested !== offered) {
    throw new ContractTermsVersionMismatchError(requested, offered);
  }
  return offered;
}

/**
 * Grava o aceite na tabela de aceites (migration 20260927150000), onde aluno
 * e professor ficam com a mesma regra de leitura. Falhou → o cadastro inteiro
 * é desfeito pelo chamador (usuário apagado, convite liberado).
 */
export async function recordTeacherContractTerms(
  admin: SupabaseClient,
  input: {
    tenantId: string;
    userId: string;
    offerId: string;
    termsVersion: number;
    acceptedAt: string;
  },
): Promise<void> {
  const { error } = await admin
    .from("contract_terms_acceptances")
    .insert({
      tenant_id: input.tenantId,
      user_id: input.userId,
      contract_kind: "TEACHER",
      terms_version: input.termsVersion,
      source: "TEACHER_INVITE",
      source_id: input.offerId,
      accepted_at: input.acceptedAt,
    });
  if (error) throw new Error("contract_terms_record_failed");
}
