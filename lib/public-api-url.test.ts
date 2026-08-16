import { describe, expect, it } from 'vitest';
import { normalizePublicApiUrl } from './public-api-url';

describe('normalizePublicApiUrl', () => {
  it('preserva a origem pública canônica', () => {
    expect(normalizePublicApiUrl('https://api.wisewolflanguage.com.br'))
      .toBe('https://api.wisewolflanguage.com.br');
  });

  it('remove o caminho legado de autenticação antes de configurar supabase-js', () => {
    expect(normalizePublicApiUrl('https://api.wisewolflanguage.com.br/auth/v1'))
      .toBe('https://api.wisewolflanguage.com.br');
    expect(normalizePublicApiUrl('https://api.wisewolflanguage.com.br/auth/v1/'))
      .toBe('https://api.wisewolflanguage.com.br');
  });

  it.each([
    'https://api.wisewolflanguage.com.br/rest/v1',
    'https://api.wisewolflanguage.com.br/auth/v1?debug=1',
    'http://api.wisewolflanguage.com.br',
  ])('rejeita uma configuração pública insegura ou ambígua: %s', (value) => {
    expect(() => normalizePublicApiUrl(value)).toThrow();
  });

  it('permite HTTP somente no desenvolvimento local', () => {
    expect(normalizePublicApiUrl('http://localhost:54321/auth/v1'))
      .toBe('http://localhost:54321');
  });
});
