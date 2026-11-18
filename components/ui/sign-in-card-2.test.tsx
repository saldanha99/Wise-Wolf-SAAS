import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SignInCard2 } from './sign-in-card-2';

// "Recuperar senha?" era um link morto (href="#"): quem esquecia a senha não
// tinha como sair do lugar. Agora envia o e-mail de redefinição.
describe('SignInCard2 — recuperar senha', () => {
    it('pede o e-mail antes de enviar', async () => {
        const onForgotPassword = vi.fn().mockResolvedValue(undefined);
        render(<SignInCard2 onLogin={vi.fn()} isLoading={false} onForgotPassword={onForgotPassword} />);
        fireEvent.click(screen.getByRole('button', { name: 'Recuperar senha?' }));
        expect(await screen.findByRole('status')).toHaveTextContent('Digite seu e-mail');
        expect(onForgotPassword).not.toHaveBeenCalled();
    });

    it('envia para o e-mail digitado e confirma sem revelar se a conta existe', async () => {
        const onForgotPassword = vi.fn().mockResolvedValue(undefined);
        render(<SignInCard2 onLogin={vi.fn()} isLoading={false} onForgotPassword={onForgotPassword} />);
        fireEvent.change(screen.getByPlaceholderText(/e-?mail/i), { target: { value: ' aluna@example.com ' } });
        fireEvent.click(screen.getByRole('button', { name: 'Recuperar senha?' }));
        await waitFor(() => expect(onForgotPassword).toHaveBeenCalledWith('aluna@example.com'));
        expect(await screen.findByRole('status')).toHaveTextContent('Se aluna@example.com tiver acesso');
    });

    it('avisa quando o envio falha', async () => {
        const onForgotPassword = vi.fn().mockRejectedValue(new Error('rate limit'));
        render(<SignInCard2 onLogin={vi.fn()} isLoading={false} onForgotPassword={onForgotPassword} />);
        fireEvent.change(screen.getByPlaceholderText(/e-?mail/i), { target: { value: 'aluna@example.com' } });
        fireEvent.click(screen.getByRole('button', { name: 'Recuperar senha?' }));
        expect(await screen.findByRole('status')).toHaveTextContent('Não foi possível enviar agora');
    });
});
