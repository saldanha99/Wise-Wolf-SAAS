import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ContractTermsRecordError,
  loadContractTermsVersion,
  recordEnrollmentContractTerms,
} from '../services/contractTermsService';

// O serviço mora em services/ (fora do include do vitest); o teste fica aqui.
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('./supabase', () => ({ supabase: { rpc } }));

describe('gravação da versão do contrato na matrícula', () => {
  beforeEach(() => rpc.mockReset());

  it('grava a versão atual da página, pela oferta, antes da cobrança', async () => {
    rpc.mockResolvedValue({ data: { ok: true, terms_version: 2, already: false }, error: null });
    await expect(recordEnrollmentContractTerms({ offerId: 'oferta-1', userId: 'aluna-1', alreadyCompleted: false }))
      .resolves.toBe(2);
    expect(rpc).toHaveBeenCalledWith('record_enrollment_contract_terms', {
      p_offer_id: 'oferta-1',
      p_terms_version: 2,
    });
  });

  it('recusa do servidor ou falha de rede interrompe a matrícula (nada foi cobrado ainda)', async () => {
    rpc.mockResolvedValueOnce({ data: { ok: false, error: 'oferta_de_outra_pessoa' }, error: null });
    await expect(recordEnrollmentContractTerms({ offerId: 'o', userId: 'u', alreadyCompleted: false }))
      .rejects.toBeInstanceOf(ContractTermsRecordError);
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'Failed to fetch' } });
    await expect(recordEnrollmentContractTerms({ offerId: 'o', userId: 'u', alreadyCompleted: false }))
      .rejects.toThrow(/nenhuma cobrança foi feita/);
  });

  it('matrícula já concluída não grava: só lê a versão que ficou', async () => {
    rpc.mockResolvedValue({ data: 1, error: null });
    await expect(recordEnrollmentContractTerms({ offerId: 'o', userId: 'aluna-1', alreadyCompleted: true }))
      .resolves.toBe(1);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('get_contract_terms_version', { p_user_id: 'aluna-1', p_contract_kind: 'STUDENT' });
  });
});

describe('leitura da versão do contrato', () => {
  beforeEach(() => rpc.mockReset());

  it('nada gravado (ou sem permissão) volta nulo; versão desconhecida também', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(loadContractTermsVersion('u', 'STUDENT')).resolves.toBeNull();
    rpc.mockResolvedValueOnce({ data: 42, error: null });
    await expect(loadContractTermsVersion('u', 'TEACHER')).resolves.toBeNull();
  });

  it('falha de leitura lança: a tela pede para tentar de novo em vez de adivinhar o texto', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: new Error('timeout') });
    await expect(loadContractTermsVersion('u', 'STUDENT')).rejects.toThrow('timeout');
  });
});
