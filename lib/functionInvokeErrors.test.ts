import { describe, expect, it } from 'vitest';
import { parseFunctionError, parseFunctionErrorAsync } from './functionInvokeErrors';

// Reproduz o que o supabase-js entrega em functions.invoke quando a edge
// function responde non-2xx: data vem null e error.context e o Response cru,
// com o corpo ainda por ler.
class FunctionsHttpError extends Error {
  context: Response;
  constructor(context: Response) {
    super('Edge Function returned a non-2xx status code');
    this.name = 'FunctionsHttpError';
    this.context = context;
  }
}

const httpError = (status: number, body: unknown) =>
  new FunctionsHttpError(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );

describe('parseFunctionError (sincrono)', () => {
  it('nao enxerga o corpo da resposta e cai na mensagem generica', () => {
    const parsed = parseFunctionError({
      error: httpError(400, { error: 'Opportunity time must be a valid future slot' }),
      data: null,
      fallbackMessage: 'Falha ao divulgar oportunidade.',
    });
    expect(parsed.message).toBe('Edge Function returned a non-2xx status code');
  });
});

describe('parseFunctionErrorAsync', () => {
  it('le o corpo do Response e expoe a mensagem real do servidor', async () => {
    const parsed = await parseFunctionErrorAsync({
      error: httpError(400, { error: 'Opportunity time must be a valid future slot' }),
      data: null,
      fallbackMessage: 'Falha ao divulgar oportunidade.',
    });
    expect(parsed.message).toBe('Opportunity time must be a valid future slot');
    expect(parsed.status).toBe(400);
  });

  it('preserva error_code e details para o mapa de mensagens amigaveis', async () => {
    const parsed = await parseFunctionErrorAsync({
      error: httpError(409, {
        error: 'conflito',
        error_code: 'targeted_opportunity',
        details: 'Professor ja vinculado.',
      }),
      data: null,
      fallbackMessage: 'Falha ao divulgar oportunidade.',
    });
    expect(parsed.code).toBe('targeted_opportunity');
    expect(parsed.details).toBe('Professor ja vinculado.');
    expect(parsed.status).toBe(409);
  });

  it('nao consome o corpo original, que segue legivel para outro leitor', async () => {
    const error = httpError(409, { error: 'Aluno possui cobranca em aberto.' });
    const parsed = await parseFunctionErrorAsync({
      error,
      data: null,
      fallbackMessage: 'Não foi possível alterar o status do aluno.',
    });
    expect(parsed.message).toBe('Aluno possui cobranca em aberto.');
    await expect(error.context.json()).resolves.toEqual({
      error: 'Aluno possui cobranca em aberto.',
    });
  });

  it('cai no fallback quando o corpo nao e JSON', async () => {
    const parsed = await parseFunctionErrorAsync({
      error: new FunctionsHttpError(new Response('502 Bad Gateway', { status: 502 })),
      data: null,
      fallbackMessage: 'Falha temporaria.',
    });
    expect(parsed.status).toBe(502);
    expect(parsed.retryable).toBe(true);
  });

  it('mantem o comportamento quando data traz o erro em uma resposta 2xx', async () => {
    const parsed = await parseFunctionErrorAsync({
      error: null,
      data: { error: 'Falha declarada no corpo 200.' },
      fallbackMessage: 'Falha generica.',
    });
    expect(parsed.message).toBe('Falha declarada no corpo 200.');
  });
});
