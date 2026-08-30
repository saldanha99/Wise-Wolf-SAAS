import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SUPABASE_URL } from '../lib/supabase-config';
import ContractModal from './ContractModal';
import { type SchoolInfo } from './ContractDocument';

const signedSignatureUrl = (tenantId: string) =>
    `${SUPABASE_URL}/storage/v1/object/sign/tenant-legal-assets/${tenantId}/legal-representative-signature/00000000-0000-4000-8000-000000000001.png?token=short-lived-token`;

const readySchool = (overrides: SchoolInfo = {}): SchoolInfo => ({
    legalName: 'Escola Tenant Exemplo',
    cnpj: '11.222.333/0001-81',
    address: 'Rua da Fábrica, 100',
    email: 'contato@tenant.example',
    phone: '(11) 90000-0000',
    city: 'Cidade Exemplo',
    state: 'sp',
    legalRepresentativeName: 'Diretora Exemplo',
    legalRepresentativeSignatureUrl: signedSignatureUrl('tenant-a'),
    ...overrides,
});

describe('Contrato: fluxo de assinatura digital', () => {
    const onConfirm = vi.fn();

    beforeEach(() => {
        onConfirm.mockReset();
    });

    const renderContract = () => render(
        <ContractModal
            isOpen
            onClose={vi.fn()}
            onConfirm={onConfirm}
            studentName="Maria da Silva"
            studentCPF="123.456.789-00"
            studentAddress="Rua Exemplo, 100"
            studentEmail="maria@exemplo.com"
            studentPhone="(11) 99999-0000"
            planName="Plano Premium"
            planValue="197,00"
            totalValue="197,00"
            planDuration={1}
            startDate="01/01/2026"
            endDate="01/02/2026"
            dueDay={10}
            classFrequency={2}
            school={readySchool()}
        />
    );

    const setupIntersectionObserverMock = () => {
        if (!window.IntersectionObserver) {
            window.IntersectionObserver = vi.fn().mockImplementation(() => ({
                observe: vi.fn(),
                unobserve: vi.fn(),
                disconnect: vi.fn(),
            }));
        }
    };

    it('habilita a confirmação no modo digitado somente quando o nome confere', () => {
        setupIntersectionObserverMock();
        renderContract();
        expect(screen.getByRole('button', { name: /finalizar matrícula/i })).toBeDisabled();

        const typedInput = screen.getByPlaceholderText('Maria da Silva');

        fireEvent.change(typedInput, { target: { value: 'Nome errado' } });
        fireEvent.click(screen.getByRole('checkbox', { name: /Li e concordo com os termos/i }));
        expect(screen.getByRole('button', { name: /finalizar matrícula/i })).toBeDisabled();

        fireEvent.change(typedInput, { target: { value: 'maria da silva' } });
        const confirmButton = screen.getByRole('button', { name: /finalizar matrícula/i });
        expect(confirmButton).not.toBeDisabled();
        fireEvent.click(confirmButton);

        expect(onConfirm).toHaveBeenCalledTimes(1);
        expect(onConfirm).toHaveBeenCalledWith({ type: 'DIGITAL', typedName: 'maria da silva' });
    });

    it('não oferece rabisco sem persistência e exige uma assinatura digitada', () => {
        setupIntersectionObserverMock();
        renderContract();

        expect(screen.queryByRole('button', { name: /rabisco no app/i })).not.toBeInTheDocument();
        expect(document.querySelector('canvas')).toBeNull();

        fireEvent.click(screen.getByRole('checkbox', { name: /Li e concordo com os termos/i }));
        const confirmButton = screen.getByRole('button', { name: /finalizar matrícula/i });
        expect(confirmButton).toBeDisabled();
        fireEvent.click(confirmButton);
        expect(onConfirm).not.toHaveBeenCalled();
    });
});
