import { supabase } from '../lib/supabase';
import {
  LEGACY_CONTRACT_TERMS_VERSION,
  parseContractTermsVersion,
  type ContractKind,
} from '../lib/contractTerms';

/**
 * Versão do texto do contrato no servidor (migration
 * 20260927150000_versao_do_contrato_no_aceite). As regras de leitura moram em
 * `lib/contractTerms.ts`; aqui só as chamadas.
 */

export class ContractTermsRecordError extends Error {
  constructor(readonly code: string) {
    super(code === 'versao_desatualizada'
      ? 'O contrato desta escola foi atualizado. Recarregue a página e leia a versão atual antes de assinar — nenhuma cobrança foi feita.'
      : 'Não foi possível registrar a versão do contrato assinado. Tente novamente — nenhuma cobrança foi feita.');
    this.name = 'ContractTermsRecordError';
  }
}

export interface ContractTermsRecord {
  /** Versão gravada no aceite; `null` = nada gravado (o texto de antes). */
  recordedVersion: number | null;
  /** Data do aceite que definiu a versão (na rematrícula, não a do perfil). */
  recordedAcceptedAt: string | null;
  /** Versão que a escola oferece hoje aos contratos novos. */
  offeredVersion: number | null;
}

const EMPTY_RECORD: ContractTermsRecord = {
  recordedVersion: null,
  recordedAcceptedAt: null,
  offeredVersion: null,
};

/**
 * O que a pessoa assinou e o que a escola dela oferece. Tudo nulo quando
 * quem pergunta não pode ver (a tela mostra o texto de antes).
 * Falha de rede/servidor LANÇA: mostrar o texto errado de um contrato
 * assinado é pior do que pedir para tentar de novo.
 */
export async function loadContractTerms(userId: string, kind: ContractKind): Promise<ContractTermsRecord> {
  const { data, error } = await supabase.rpc('get_contract_terms', {
    p_user_id: userId,
    p_contract_kind: kind,
  });
  if (error) throw error;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return EMPTY_RECORD;
  const row = data as Record<string, unknown>;
  const acceptedAt = typeof row.accepted_at === 'string' && row.accepted_at ? row.accepted_at : null;
  return {
    recordedVersion: parseContractTermsVersion(kind, row.recorded_version),
    recordedAcceptedAt: acceptedAt,
    offeredVersion: parseContractTermsVersion(kind, row.offered_version),
  };
}

/**
 * Versão que a página de matrícula e o convite do professor mostram: a que a
 * escola oferece, entregue pela edge `tenant-legal-assets` junto da oferta.
 * Sem ela (edge antiga, resposta estranha), o texto de antes — e o servidor
 * recusa gravá-lo se a escola oferece outra, antes de qualquer cobrança.
 */
export function offeredContractTermsVersion(kind: ContractKind, payload: unknown): number {
  const value = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).contractTermsVersion
    : undefined;
  return parseContractTermsVersion(kind, value) ?? LEGACY_CONTRACT_TERMS_VERSION;
}

/**
 * A página de matrícula grava a versão que mostrou (`termsVersion`, a que a
 * escola oferece), logo depois de `begin_enrollment_offer` e ANTES da
 * cobrança. Devolve a versão que ficou gravada (numa segunda tentativa, a da
 * primeira).
 *
 * Matrícula já concluída (`alreadyCompleted`) não grava: ela terminou antes,
 * com o texto que a página daquela vez mostrou — só lê o que ficou.
 */
export async function recordEnrollmentContractTerms(input: {
  offerId: string;
  userId: string;
  alreadyCompleted: boolean;
  termsVersion: number;
}): Promise<number | null> {
  if (input.alreadyCompleted) {
    try {
      return (await loadContractTerms(input.userId, 'STUDENT')).recordedVersion;
    } catch {
      // Só serve para a via impressa desta tela; o contrato no portal lê de novo.
      return null;
    }
  }
  const { data, error } = await supabase.rpc('record_enrollment_contract_terms', {
    p_offer_id: input.offerId,
    p_terms_version: input.termsVersion,
  });
  const result = (data ?? null) as { ok?: boolean; error?: string; terms_version?: unknown } | null;
  if (error || !result?.ok) {
    throw new ContractTermsRecordError(result?.error || error?.message || 'unknown');
  }
  return parseContractTermsVersion('STUDENT', result.terms_version);
}
