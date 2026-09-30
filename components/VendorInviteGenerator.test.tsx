import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import VendorInviteGenerator from './VendorInviteGenerator';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));

beforeEach(() => {
    rpc.mockReset();
    rpc.mockResolvedValue({ data: '11111111-2222-4333-8444-555555555555', error: null });
});

describe('convites de afiliado', () => {
    it('mantém a conta própria como caminho padrão', async () => {
        render(<VendorInviteGenerator tenantId="school-wise-wolf" />);
        fireEvent.click(screen.getByRole('button', { name: 'Gerar link de convite' }));
        await waitFor(() => expect(rpc).toHaveBeenCalledWith('create_affiliate_invite', expect.objectContaining({
            p_commission_cents: 4900,
        })));
    });

    it('exige e-mail exato e cria convite vinculado sem enviar mensagem', async () => {
        render(<VendorInviteGenerator tenantId="school-wise-wolf" />);
        fireEvent.click(screen.getByLabelText('Vincular à conta de aluno existente'));
        fireEvent.click(screen.getByRole('button', { name: 'Gerar link de convite' }));
        expect(screen.getByRole('alert')).toHaveTextContent('e-mail exato');
        expect(rpc).not.toHaveBeenCalled();
        fireEvent.change(screen.getByLabelText('E-mail da conta de aluno'), {
            target: { value: ' Aluna@Example.com ' },
        });
        fireEvent.click(screen.getByRole('button', { name: 'Gerar link de convite' }));
        await waitFor(() => expect(rpc).toHaveBeenCalledWith('create_linked_affiliate_invite', expect.objectContaining({
            p_student_email: 'aluna@example.com',
            p_commission_cents: 4900,
        })));
        expect((screen.getByLabelText('Link de convite do afiliado') as HTMLInputElement).value)
            .toContain('/vendor-onboarding?offer=11111111-2222-4333-8444-555555555555');
    });
});
