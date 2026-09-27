import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SUPABASE_URL } from '../lib/supabase-config';

/**
 * As telas que MOSTRAM contrato assinado (aluno em "Meu contrato", direção em
 * "Contratos") leem a versão gravada no aceite e nunca mostram a cláusula do
 * registro das aulas a quem assinou o texto de antes.
 */

const { rpc, from, getSession } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), getSession: vi.fn() }));
vi.mock('../lib/supabase', () => ({
  supabase: { rpc, from, storage: { from: vi.fn() }, auth: { getSession } },
}));

const school = {
  legalName: 'Escola Tenant Exemplo Ltda.', cnpj: '11.222.333/0001-81', address: 'Rua da Escola, 1',
  email: 'juridico@tenant.example', phone: '(11) 90000-0000', city: 'Cidade Exemplo', state: 'SP',
  legalRepresentativeName: 'Responsável do Tenant',
  legalRepresentativeSignatureUrl: `${SUPABASE_URL}/storage/v1/object/sign/tenant-legal-assets/tenant-a/legal-representative-signature/00000000-0000-4000-8000-000000000001.png?token=t`,
};
vi.mock('../lib/schoolInfo', () => ({ getSchoolInfo: vi.fn(async () => school) }));

import ContractView from './ContractView';
import ContractManagement from './ContractManagement';

/** Consulta encadeada do supabase-js que resolve com `result` no fim. */
const chain = (result: unknown) => {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'order', 'in', 'is']) builder[method] = vi.fn(() => builder);
  builder.single = vi.fn(async () => result);
  builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
};

const studentProfile = (overrides: Record<string, unknown> = {}) => ({
  id: 'aluna-1', full_name: 'Aluna Fixture', email: 'aluna@example.test', tenant_id: 'tenant-a',
  role: 'STUDENT', fidelity_plan: 'SEMESTRAL', due_day: 10, monthly_fee: 261, class_frequency: '2x',
  created_at: '2026-01-10T12:00:00Z', contract_accepted: true, accepted_at: '2026-01-10T12:00:00Z',
  ...overrides,
});

describe('Meu contrato (ContractView)', () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
  });

  /** Resposta de get_contract_terms: o que a pessoa assinou e o que a escola oferece. */
  const terms = (recorded: number | null, acceptedAt: string | null = null, offered = 2) => ({
    recorded_version: recorded, accepted_at: acceptedAt, offered_version: offered,
  });

  const renderFor = (profile: Record<string, unknown>, termsData: unknown, termsError: unknown = null) => {
    from.mockImplementation(() => chain({ data: profile, error: null }));
    rpc.mockImplementation(async (name: string) => {
      if (name === 'get_authorized_profile_private') return { data: {}, error: null };
      if (name === 'get_contract_terms') return { data: termsData, error: termsError };
      return { data: null, error: null };
    });
    return render(<ContractView userId="aluna-1" showDownloadButton={false} />);
  };

  it('aluna que assinou antes da cláusula vê o contrato que assinou, sem o registro das aulas', async () => {
    const { container } = renderFor(studentProfile(), terms(null));
    await waitFor(() => expect(container.textContent).toContain('Cláusula 8 — Do Foro'));
    expect(container.textContent).not.toContain('Do Registro das Aulas');
    expect(rpc).toHaveBeenCalledWith('get_contract_terms', { p_user_id: 'aluna-1', p_contract_kind: 'STUDENT' });
  });

  it('matrícula migrada (aceita sem data) também é contrato assinado: não ganha a cláusula', async () => {
    const { container } = renderFor(studentProfile({ accepted_at: null }), terms(null));
    await waitFor(() => expect(container.textContent).toContain('Cláusula 8 — Do Foro'));
    expect(container.textContent).not.toContain('Do Registro das Aulas');
  });

  it('aluna que assinou a versão 2 vê a Cláusula 8 do registro das aulas', async () => {
    const { container } = renderFor(studentProfile(), terms(2, '2026-01-10T12:00:00Z'));
    await waitFor(() => expect(container.textContent).toContain('Cláusula 8 — Do Registro das Aulas'));
    expect(container.textContent).toContain('Cláusula 9 — Do Foro');
  });

  it('rematrícula: o contrato da versão 2 sai com a data do aceite novo, não com a assinatura de fevereiro', async () => {
    const { container } = renderFor(
      studentProfile({ accepted_at: '2026-02-10T15:00:00Z', signature_ip: '198.51.100.7' }),
      terms(2, '2026-09-28T15:00:00Z'),
    );
    await waitFor(() => expect(container.textContent).toContain('Cláusula 8 — Do Registro das Aulas'));
    const seal = container.textContent || '';
    expect(seal).toContain(`Assinado em: ${new Date('2026-09-28T15:00:00Z').toLocaleString('pt-BR')}`);
    expect(seal).not.toContain(new Date('2026-02-10T15:00:00Z').toLocaleString('pt-BR'));
    // O IP é da assinatura antiga: não é apresentado como o desta.
    expect(seal).not.toContain('198.51.100.7');
    expect(seal).toContain('Versão do texto: 2');
  });

  it('contrato ainda não assinado mostra a versão que a escola oferece', async () => {
    const unsigned = studentProfile({ accepted_at: null, contract_accepted: false });
    const offered = renderFor(unsigned, terms(null, null, 2));
    await waitFor(() => expect(offered.container.textContent).toContain('Cláusula 8 — Do Registro das Aulas'));
    offered.unmount();
    // Escola que não decidiu registrar as aulas: sem a cláusula.
    const plain = renderFor(unsigned, terms(null, null, 1));
    await waitFor(() => expect(plain.container.textContent).toContain('Cláusula 8 — Do Foro'));
    expect(plain.container.textContent).not.toContain('Do Registro das Aulas');
  });

  it('sem conseguir ler a versão, pede para tentar de novo em vez de adivinhar o texto', async () => {
    renderFor(studentProfile(), null, new Error('timeout'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Não foi possível carregar o contrato.'));
  });
});

describe('Contratos da direção (ContractManagement)', () => {
  beforeEach(() => {
    rpc.mockReset();
    from.mockReset();
    getSession.mockReset();
    getSession.mockResolvedValue({ data: { session: { user: { id: 'diretora-1' } } } });
  });

  /** A escola da diretora oferece `offered` aos contratos novos. */
  const schoolOffers = (offered: number) => rpc.mockImplementation(async (name: string) => (
    name === 'get_contract_terms'
      ? { data: { recorded_version: null, accepted_at: null, offered_version: offered }, error: null }
      : { data: null, error: null }
  ));

  const row = (overrides: Record<string, unknown>) => ({
    user_id: 'x', student_name: 'Aluno', student_email: 'a@example.test', plan_value: 261, due_day: 10,
    class_frequency: '2x', contract_accepted: true, accepted_at: '2026-01-10T12:00:00Z',
    student_signature_url: null, signed_document_url: null, documentation_status: 'APPROVED',
    signature_ip: '203.0.113.1', tenant_id: 'tenant-a', ...overrides,
  });

  it('mostra a versão de cada contrato e abre cada um com o texto que foi assinado', async () => {
    schoolOffers(2);
    from.mockImplementation(() => chain({
      data: [
        row({ user_id: 'nova', student_name: 'Aluna Nova', contract_terms_version: 2 }),
        row({ user_id: 'antiga', student_name: 'Aluna Antiga', contract_terms_version: null }),
      ],
      error: null,
    }));
    const { container } = render(<ContractManagement tenantId="tenant-a" />);
    await waitFor(() => expect(container.textContent).toContain('v2 · com registro das aulas'));
    expect(container.textContent).toContain('v1 · texto anterior');
    expect(container.querySelector('[data-tour="contracts-recording-clause"]')).not.toBeNull();
    await waitFor(() => expect(container.textContent).toContain('Os contratos novos desta escola trazem a Cláusula 8'));
    expect(rpc).toHaveBeenCalledWith('get_contract_terms', { p_user_id: 'diretora-1', p_contract_kind: 'STUDENT' });

    fireEvent.click(screen.getByLabelText('Inspecionar contrato de Aluna Antiga'));
    const oldDialog = await screen.findByRole('dialog');
    expect(oldDialog.textContent).toContain('Cláusula 8 — Do Foro');
    expect(oldDialog.textContent).not.toContain('Do Registro das Aulas');
    expect(oldDialog.textContent).toContain('texto anterior, sem a cláusula do registro das aulas');
    fireEvent.click(screen.getByLabelText('Fechar auditoria do contrato'));

    fireEvent.click(screen.getByLabelText('Inspecionar contrato de Aluna Nova'));
    const newDialog = await screen.findByRole('dialog');
    expect(newDialog.textContent).toContain('Cláusula 8 — Do Registro das Aulas');
    expect(newDialog.textContent).toContain('com a cláusula do registro das aulas');
  });
  it('rematrícula: "Data Matrícula" e o contrato mostram a data do aceite da versão 2', async () => {
    schoolOffers(2);
    from.mockImplementation(() => chain({
      data: [row({
        user_id: 'volta', student_name: 'Aluna que Voltou', accepted_at: '2026-02-10T15:00:00Z',
        signature_ip: '198.51.100.7', contract_terms_version: 2,
        contract_terms_accepted_at: '2026-09-28T15:00:00Z',
      })],
      error: null,
    }));
    const { container } = render(<ContractManagement tenantId="tenant-a" />);
    await waitFor(() => expect(container.textContent).toContain('v2 · com registro das aulas'));
    expect(container.textContent).toContain(new Date('2026-09-28T15:00:00Z').toLocaleDateString('pt-BR'));
    expect(container.textContent).not.toContain(new Date('2026-02-10T15:00:00Z').toLocaleDateString('pt-BR'));

    fireEvent.click(screen.getByLabelText('Inspecionar contrato de Aluna que Voltou'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain(`Assinado em: ${new Date('2026-09-28T15:00:00Z').toLocaleString('pt-BR')}`);
    expect(dialog.textContent).not.toContain('198.51.100.7');
  });

  it('escola que não decidiu registrar as aulas: o aviso não promete a cláusula', async () => {
    schoolOffers(1);
    from.mockImplementation(() => chain({ data: [row({ user_id: 'x', student_name: 'Aluno' })], error: null }));
    const { container } = render(<ContractManagement tenantId="tenant-b" />);
    await waitFor(() => expect(container.textContent).toContain('Os contratos novos desta escola não trazem a cláusula'));
    expect(container.textContent).not.toContain('Os contratos novos desta escola trazem a Cláusula 8');
  });
});
