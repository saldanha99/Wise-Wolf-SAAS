import { afterEach, describe, expect, it, vi } from 'vitest';
import { openGoogleAuthorization } from './googleAuthorizationWindow';
afterEach(() => vi.restoreAllMocks());
const url = 'https://accounts.google.com/o/oauth2/auth?fixture=1';
describe('openGoogleAuthorization', () => {
  it('reserva a aba antes do pedido assíncrono e navega sem opener', async () => {
    const tab = { opener: window, closed: false, location: { href: '' }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    const prepare = vi.fn(async () => { expect(open).toHaveBeenCalled(); return { authorization_url: url }; });
    expect((await openGoogleAuthorization(prepare)).opened).toBe(true);
    expect(tab.location.href).toBe(url);
    expect(tab.opener).toBeNull();
  });
  it('retorna o link para um botão de fallback quando bloqueado', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    expect(await openGoogleAuthorization(async () => ({ authorization_url: url }))).toEqual({ result: { authorization_url: url }, opened: false });
  });
  it('fecha a aba se o servidor falhar ou fornecer URL inesperada', async () => {
    const tab = { opener: null, closed: false, location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    await expect(openGoogleAuthorization(async () => ({ authorization_url: 'https://example.com' }))).rejects.toThrow();
    expect(tab.close).toHaveBeenCalled();
    await expect(openGoogleAuthorization(async () => { throw new Error('indisponível'); })).rejects.toThrow('indisponível');
    expect(tab.close).toHaveBeenCalledTimes(2);
  });
});
