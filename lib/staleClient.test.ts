import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isStaleClientError, reloadStaleClient } from './staleClient';

describe('isStaleClientError', () => {
  it('reconhece o 42501 do PostgREST (grant de coluna revogado)', () => {
    expect(isStaleClientError({ code: '42501', message: 'permission denied for table profiles' })).toBe(true);
  });

  it('reconhece "permission denied" mesmo sem código', () => {
    expect(isStaleClientError({ message: 'Permission denied for function x' })).toBe(true);
  });

  it('não confunde com perfil inexistente, credencial inválida ou rede', () => {
    expect(isStaleClientError({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' })).toBe(false);
    expect(isStaleClientError({ code: 'invalid_credentials', message: 'Invalid login credentials' })).toBe(false);
    expect(isStaleClientError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isStaleClientError(null)).toBe(false);
    expect(isStaleClientError(undefined)).toBe(false);
  });
});

describe('reloadStaleClient', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });
  afterEach(() => {
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('recarrega na primeira vez e registra a marca', () => {
    const reload = vi.fn();
    const now = vi.fn().mockReturnValue(1_000_000);
    expect(reloadStaleClient({ reload, now })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem('ww:stale-client-reload-at')).toBe('1000000');
  });

  it('não recarrega de novo dentro de um minuto — evita loop quando o bundle novo não veio', () => {
    const reload = vi.fn();
    const now = vi.fn().mockReturnValue(1_000_000);
    expect(reloadStaleClient({ reload, now })).toBe(true);

    now.mockReturnValue(1_000_000 + 30_000);
    expect(reloadStaleClient({ reload, now })).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('volta a recarregar depois que a janela passa', () => {
    const reload = vi.fn();
    const now = vi.fn().mockReturnValue(1_000_000);
    reloadStaleClient({ reload, now });

    now.mockReturnValue(1_000_000 + 61_000);
    expect(reloadStaleClient({ reload, now })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
