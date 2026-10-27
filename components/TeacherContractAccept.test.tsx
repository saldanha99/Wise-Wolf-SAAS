import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SUPABASE_URL } from '../lib/supabase-config';

const { rpc, from, offeredTerms } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), offeredTerms: { version: 3 } }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc, from } }));
vi.mock('../lib/profilePrivacy', () => ({ loadAuthorizedProfilePrivate: async () => ({ cpf: '52998224725', address: 'Rua Particular, 1' }) }));
vi.mock('../services/contractTermsService', () => ({ loadContractTerms: async () => ({ offeredVersion: offeredTerms.version }) }));
vi.mock('../lib/schoolInfo', () => ({ getSchoolInfo: async () => ({
  legalName: 'Escola Fixture Ltda.', cnpj: '11.222.333/0001-81', address: 'Rua Escola, 1',
  email: 'escola@example.invalid', phone: '5511999999999', city: 'Cidade Fixture', state: 'SP', legalRepresentativeName: 'Direção Fixture',
  legalRepresentativeSignatureUrl: `${SUPABASE_URL}/storage/v1/object/sign/tenant-legal-assets/tenant-a/legal-representative-signature/00000000-0000-4000-8000-000000000001.png?token=fixture`,
}) }));
import TeacherContractAccept from './TeacherContractAccept';

describe('assinatura v3 pela própria conta do professor', () => {
  beforeEach(() => {
    rpc.mockReset(); from.mockReset(); offeredTerms.version = 3;
    const query = { select: vi.fn(), eq: vi.fn(), single: vi.fn(async () => ({ data: {
      id: 'prof-fixture', tenant_id: 'tenant-a', full_name: 'Representante Fixture', cnpj: '', cnpj_company_name: '',
    }, error: null })) };
    query.select.mockReturnValue(query); query.eq.mockReturnValue(query); from.mockReturnValue(query);
    rpc.mockImplementation(async name => name === 'get_my_pay' ? { data: { hourly_rate: 8 }, error: null } : { data: { ok: true }, error: null });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ setTransform: vi.fn(), clearRect: vi.fn() } as unknown as CanvasRenderingContext2D);
  });

  it('mantém o aceite v2 pela porta legada sem exigir identidade PJ da v3', async () => {
    offeredTerms.version = 2;
    const accepted = vi.fn();
    render(<TeacherContractAccept userId="prof-fixture" onAccepted={accepted} />);
    const consent = await screen.findByRole('checkbox');
    await waitFor(() => expect(consent).not.toBeDisabled());
    expect(screen.queryByLabelText('CNPJ da empresa')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /digitar nome/i }));
    fireEvent.click(consent);
    fireEvent.click(screen.getByRole('button', { name: /aceitar e assinar contrato/i }));
    await waitFor(() => expect(accepted).toHaveBeenCalledOnce());
    expect(rpc).toHaveBeenCalledWith('accept_teacher_contract', {
      p_typed_signature: 'Representante Fixture', p_terms_version: 2,
    });
    expect(rpc.mock.calls.some(([name]) => name === 'accept_teacher_pj_contract')).toBe(false);
  });

  const chooseCompany = async () => {
    fireEvent.click(await screen.findByRole('radio', { name: /tenho cnpj/i }));
  };

  it('professor sem CNPJ assina o contrato de pessoa física (v2) mesmo com a v3 oferecida', async () => {
    const accepted = vi.fn();
    render(<TeacherContractAccept userId="prof-fixture" onAccepted={accepted} />);
    expect(await screen.findByRole('radio', { name: /sou autônomo/i })).toBeChecked();
    expect(screen.queryByLabelText('CNPJ da empresa')).not.toBeInTheDocument();
    const consent = screen.getByRole('checkbox');
    await waitFor(() => expect(consent).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /digitar nome/i }));
    fireEvent.click(consent);
    fireEvent.click(screen.getByRole('button', { name: /aceitar e assinar contrato/i }));
    await waitFor(() => expect(accepted).toHaveBeenCalledOnce());
    expect(rpc).toHaveBeenCalledWith('accept_teacher_contract', {
      p_typed_signature: 'Representante Fixture', p_terms_version: 2,
    });
    expect(rpc.mock.calls.some(([name]) => name === 'accept_teacher_pj_contract')).toBe(false);
  });

  const fillProvider = async () => {
    await chooseCompany();
    await screen.findByLabelText('Razão social / nome empresarial');
    fireEvent.change(screen.getByLabelText('Razão social / nome empresarial'), { target: { value: 'Empresa Fixture Ltda.' } });
    fireEvent.change(screen.getByLabelText('CNPJ da empresa'), { target: { value: '12.ABC.345/01DE-35' } });
    fireEvent.change(screen.getByLabelText('Endereço completo da empresa'), { target: { value: 'Rua da Empresa, 99' } });
  };

  it('bloqueia empresa incompleta, mostra a parte PJ e só então envia a identidade lida à RPC própria', async () => {
    const accepted = vi.fn(); render(<TeacherContractAccept userId="prof-fixture" onAccepted={accepted} />);
    await chooseCompany();
    await screen.findByLabelText('Razão social / nome empresarial');
    expect(screen.getByRole('button', { name: /aceitar e assinar contrato/i })).toBeDisabled();
    expect(screen.getByRole('checkbox')).toBeDisabled();
    await fillProvider();
    expect(screen.getByText(/inscrita no CNPJ sob nº 12ABC34501DE35/)).toHaveTextContent('Empresa Fixture Ltda.');
    fireEvent.click(screen.getByRole('button', { name: /digitar nome/i }));
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /aceitar e assinar contrato/i }));
    await waitFor(() => expect(accepted).toHaveBeenCalledOnce());
    expect(rpc).toHaveBeenCalledWith('accept_teacher_pj_contract', {
      p_typed_signature: 'Representante Fixture', p_terms_version: 3, p_provider_identity: {
        companyName: 'Empresa Fixture Ltda.', cnpj: '12ABC34501DE35', companyAddress: 'Rua da Empresa, 99',
        representativeCpf: '52998224725', representativeHasAuthority: true,
      },
    });
    expect(rpc.mock.calls.some(([name]) => name === 'accept_teacher_contract')).toBe(false);
  });

  it('uma alteração da empresa exige novo aceite, e erro do servidor não anuncia assinatura concluída', async () => {
    rpc.mockImplementation(async name => name === 'get_my_pay' ? { data: { hourly_rate: 8 }, error: null } : { data: { ok: false, error: 'versao_invalida' }, error: null });
    const accepted = vi.fn(); render(<TeacherContractAccept userId="prof-fixture" onAccepted={accepted} />);
    await fillProvider();
    fireEvent.click(screen.getByRole('button', { name: /digitar nome/i }));
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('Razão social / nome empresarial'), { target: { value: 'Empresa Corrigida Ltda.' } });
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByRole('button', { name: /aceitar e assinar contrato/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /aceitar e assinar contrato/i }));
    await screen.findByText(/O contrato foi atualizado. Recarregue a página/);
    expect(accepted).not.toHaveBeenCalled();
  });
});
