import { describe, expect, it } from 'vitest';
import { clearHubInviteToken, readHubInviteToken } from './HubApp';

const memoryStorage = () => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
};

describe('Token de convite do aluno', () => {
  it('lê o token da URL, guarda para sobreviver ao login e limpa ao consumir', () => {
    const token = 'c'.repeat(64);
    const storage = memoryStorage();
    expect(readHubInviteToken(`?convite=${token.toUpperCase()}`, storage)).toBe(token);
    // Sem o parâmetro na URL (depois do redirect do login), vem do storage.
    expect(readHubInviteToken('', storage)).toBe(token);
    clearHubInviteToken(storage);
    expect(readHubInviteToken('', storage)).toBeNull();
  });

  it('ignora token fora do formato e storage indisponível', () => {
    expect(readHubInviteToken('?convite=abc', memoryStorage())).toBeNull();
    expect(readHubInviteToken(`?convite=${'d'.repeat(64)}`, null)).toBe('d'.repeat(64));
  });
});
