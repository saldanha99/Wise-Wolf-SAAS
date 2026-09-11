import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TeacherPixKey from './TeacherPixKey';
const load = vi.hoisted(() => vi.fn());
vi.mock('../lib/profilePrivacy', () => ({ loadAuthorizedProfilePrivate: load }));
describe('director Pix lookup', () => {
    beforeEach(() => { load.mockReset(); });
    it('loads only on request and copies the registered value', async () => {
        load.mockResolvedValue({ pix_key: 'fixture@example.test', pix_key_type: 'EMAIL' });
        const copy = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', { value: { writeText: copy }, configurable: true });
        render(<TeacherPixKey teacherId="fixture-teacher" />);
        expect(load).not.toHaveBeenCalled();
        fireEvent.click(screen.getByText('Ver chave Pix'));
        expect(await screen.findByText('fixture@example.test')).toBeInTheDocument();
        fireEvent.click(screen.getByText('Copiar Pix'));
        await waitFor(() => expect(copy).toHaveBeenCalledWith('fixture@example.test'));
    });
    it('distinguishes an unauthorized lookup from an absent key', async () => {
        load.mockRejectedValue(new Error('unauthorized'));
        render(<TeacherPixKey teacherId="other-tenant" />);
        fireEvent.click(screen.getByText('Ver chave Pix'));
        expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível consultar');
        expect(screen.queryByText('Professor sem chave Pix cadastrada.')).not.toBeInTheDocument();
    });
});
