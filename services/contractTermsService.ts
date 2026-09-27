import { supabase } from '../lib/supabase';
import {
  CURRENT_CONTRACT_TERMS_VERSION,
  parseContractTermsVersion,
  type ContractKind,
} from '../lib/contractTerms';

/**
 * Versão do texto do contrato no servidor (migration
 * 20260927150000_versao_do_contrato_no_aceite). As regras de leitura moram em
 * `lib/contractTerms.ts`; aqui só as duas chamadas.
 */

export class ContractTermsRecordError extends Error {
  constructor(readonly code: string) {
    super('Não foi possível registrar a versão do contrato assinado. Tente novamente — nenhuma cobrança foi feita.');
    this.name = 'ContractTermsRecordError';
  }
}

/**
 * Versão gravada no aceite de uma pessoa. `null` quando nada foi gravado (a
 * tela mostra o texto de antes) ou quando quem pergunta não pode ver.
 * Falha de rede/servidor LANÇA: mostrar o texto errado de um contrato
 * assinado é pior do que pedir para tentar de novo.
 */
export async function loadContractTermsVersion(userId: string, kind: ContractKind): Promise<number | null> {
  const { data, error } = await supabase.rpc('get_contract_terms_version', {
    p_user_id: userId,
    p_contract_kind: kind,
  });
  if (error) throw error;
  return parseContractTermsVersion(kind, data);
}

/**
 * A página de matrícula grava a versão que mostrou, logo depois de
 * `begin_enrollment_offer` e ANTES da cobrança. Devolve a versão que ficou
 * gravada (numa segunda tentativa, a da primeira).
 *
 * Matrícula já concluída (`alreadyCompleted`) não grava: ela terminou antes,
 * com o texto que a página daquela vez mostrou — só lê o que ficou.
 */
export async function recordEnrollmentContractTerms(input: {
  offerId: string;
  userId: string;
  alreadyCompleted: boolean;
}): Promise<number | null> {
  if (input.alreadyCompleted) {
    try {
      return await loadContractTermsVersion(input.userId, 'STUDENT');
    } catch {
      // Só serve para a via impressa desta tela; o contrato no portal lê de novo.
      return null;
    }
  }
  const { data, error } = await supabase.rpc('record_enrollment_contract_terms', {
    p_offer_id: input.offerId,
    p_terms_version: CURRENT_CONTRACT_TERMS_VERSION.STUDENT,
  });
  const result = (data ?? null) as { ok?: boolean; error?: string; terms_version?: unknown } | null;
  if (error || !result?.ok) {
    throw new ContractTermsRecordError(result?.error || error?.message || 'unknown');
  }
  return parseContractTermsVersion('STUDENT', result.terms_version);
}
