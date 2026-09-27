import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ContractTermsRecordError,
  loadContractTerms,
  offeredContractTermsVersion,
  recordEnrollmentContractTerms,
} from '../services/contractTermsService';

// O serviço mora em services/ (fora do include do vitest); o teste fica aqui.
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('./supabase', () => ({ supabase: { rpc } }));

describe('gravação da versão do contrato na matrícula', () => {
  beforeEach(() => rpc.mockReset());

  it('grava a versão que a página mostrou (a que a escola oferece), pela oferta, antes da cobrança', async () => {
    rpc.mockResolvedValue({ data: { ok: true, terms_version: 2, already: false }, error: null });
    await expect(recordEnrollmentContractTerms({
      offerId: 'oferta-1', userId: 'aluna-1', alreadyCompleted: false, termsVersion: 2,
    })).resolves.toBe(2);
    expect(rpc).toHaveBeenCalledWith('record_enrollment_contract_terms', {
      p_offer_id: 'oferta-1',
      p_terms_version: 2,
    });
  });

  it('escola sem a cláusula: grava a versão 1 que a página mostrou', async () => {
    rpc.mockResolvedValue({ data: { ok: true, terms_version: 1, already: false }, error: null });
    await expect(recordEnrollmentContractTerms({
      offerId: 'oferta-2', userId: 'aluno-2', alreadyCompleted: false, termsVersion: 1,
    })).resolves.toBe(1);
    expect(rpc).toHaveBeenCalledWith('record_enrollment_contract_terms', {
      p_offer_id: 'oferta-2',
      p_terms_version: 1,
    });
  });

  it('recusa do servidor ou falha de rede interrompe a matrícula (nada foi cobrado ainda)', async () => {
    const input = { offerId: 'o', userId: 'u', alreadyCompleted: false, termsVersion: 2 };
    rpc.mockResolvedValueOnce({ data: { ok: false, error: 'oferta_de_outra_pessoa' }, error: null });
    await expect(recordEnrollmentContractTerms(input)).rejects.toBeInstanceOf(ContractTermsRecordError);
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'Failed to fetch' } });
    await expect(recordEnrollmentContractTerms(input)).rejects.toThrow(/nenhuma cobrança foi feita/);
    // A escola mudou a versão depois que a página abriu: recarregar.
    rpc.mockResolvedValueOnce({ data: { ok: false, error: 'versao_desatualizada' }, error: null });
    await expect(recordEnrollmentContractTerms(input)).rejects.toThrow(/Recarregue a página/);
  });

  it('matrícula já concluída não grava: só lê a versão que ficou', async () => {
    rpc.mockResolvedValue({ data: { recorded_version: 1, accepted_at: '2026-02-10T12:00:00Z', offered_version: 2 }, error: null });
    await expect(recordEnrollmentContractTerms({
      offerId: 'o', userId: 'aluna-1', alreadyCompleted: true, termsVersion: 2,
    })).resolves.toBe(1);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('get_contract_terms', { p_user_id: 'aluna-1', p_contract_kind: 'STUDENT' });
  });
});

describe('leitura do contrato assinado e da versão da escola', () => {
  beforeEach(() => rpc.mockReset());

  it('devolve a versão gravada, a data desse aceite e a versão que a escola oferece', async () => {
    rpc.mockResolvedValueOnce({
      data: { recorded_version: 2, accepted_at: '2026-09-28T13:00:00Z', offered_version: 2 },
      error: null,
    });
    await expect(loadContractTerms('u', 'STUDENT')).resolves.toEqual({
      recordedVersion: 2,
      recordedAcceptedAt: '2026-09-28T13:00:00Z',
      offeredVersion: 2,
    });
  });

  it('nada gravado, sem permissão ou versão desconhecida volta nulo', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(loadContractTerms('u', 'STUDENT')).resolves.toEqual({
      recordedVersion: null, recordedAcceptedAt: null, offeredVersion: null,
    });
    rpc.mockResolvedValueOnce({ data: { recorded_version: 42, accepted_at: null, offered_version: 1 }, error: null });
    await expect(loadContractTerms('u', 'TEACHER')).resolves.toEqual({
      recordedVersion: null, recordedAcceptedAt: null, offeredVersion: 1,
    });
  });

  it('falha de leitura lança: a tela pede para tentar de novo em vez de adivinhar o texto', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: new Error('timeout') });
    await expect(loadContractTerms('u', 'STUDENT')).rejects.toThrow('timeout');
  });
});

describe('versão que a página de matrícula e o convite mostram', () => {
  it('é a que a escola oferece, entregue junto da oferta', () => {
    expect(offeredContractTermsVersion('STUDENT', { contractTermsVersion: 2 })).toBe(2);
    expect(offeredContractTermsVersion('TEACHER', { contractTermsVersion: 1 })).toBe(1);
  });

  it('sem a versão na oferta (edge antiga, resposta estranha): o texto de antes', () => {
    for (const payload of [null, undefined, {}, { contractTermsVersion: 99 }, { contractTermsVersion: 'x' }, []]) {
      expect(offeredContractTermsVersion('STUDENT', payload), JSON.stringify(payload)).toBe(1);
    }
  });
});
