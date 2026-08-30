import { describe, expect, it, vi } from 'vitest';
import { provisionStudentAccount } from './studentAccountProvisioning';

describe('provisionStudentAccount', () => {
  it('cria o acesso pelo servidor sem chamar Auth no navegador', async () => {
    const invoke = vi.fn().mockResolvedValue({
      data: {
        user: { id: 'student-1' },
        created: true,
        activationSent: true,
      },
      error: null,
    });

    const result = await provisionStudentAccount(
      { functions: { invoke } },
      {
        name: '  Aluna Teste  ',
        email: ' ALUNA@EXAMPLE.COM ',
        tenantId: ' tenant-1 ',
        monthlyFee: 169,
      },
    );

    expect(invoke).toHaveBeenCalledWith('create-student-account', {
      body: expect.objectContaining({
        name: 'Aluna Teste',
        email: 'aluna@example.com',
        tenantId: 'tenant-1',
        monthlyFee: 169,
      }),
    });
    expect(result).toEqual({
      userId: 'student-1',
      created: true,
      activationSent: true,
    });
  });

  it('aceita retry idempotente de uma conta já provisionada', async () => {
    const result = await provisionStudentAccount(
      {
        functions: {
          invoke: vi.fn().mockResolvedValue({
            data: {
              user: { id: 'student-existing' },
              created: false,
              activationSent: false,
            },
            error: null,
          }),
        },
      },
      { name: 'Aluno', email: 'aluno@example.com', tenantId: 'tenant-1' },
    );

    expect(result.created).toBe(false);
    expect(result.userId).toBe('student-existing');
  });

  it('falha fechado quando o servidor não confirma um usuário', async () => {
    await expect(provisionStudentAccount(
      {
        functions: {
          invoke: vi.fn().mockResolvedValue({ data: {}, error: null }),
        },
      },
      { name: 'Aluno', email: 'aluno@example.com', tenantId: 'tenant-1' },
    )).rejects.toThrow('não confirmou');
  });
});
