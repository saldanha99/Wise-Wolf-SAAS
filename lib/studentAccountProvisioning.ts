import { parseFunctionError } from './functionInvokeErrors';

export interface StudentAccountProvisioningInput {
  name: string;
  email: string;
  tenantId: string;
  phone?: string | null;
  professorId?: string | null;
  monthlyFee?: number;
  dueDay?: number;
}

type FunctionClient = {
  functions: {
    invoke: (
      name: string,
      options: { body: Record<string, unknown> },
    ) => Promise<{ data: any; error: unknown }>;
  };
};

export interface ProvisionedStudentAccount {
  userId: string;
  created: boolean;
  activationSent: boolean;
}

/**
 * Provisiona a conta pelo servidor sem alterar a sessão atual do diretor.
 * A Edge Function usa Auth Admin, senha inicial aleatória e convite individual.
 */
export async function provisionStudentAccount(
  client: FunctionClient,
  input: StudentAccountProvisioningInput,
): Promise<ProvisionedStudentAccount> {
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  const tenantId = input.tenantId.trim();

  if (!name || !email || !tenantId) {
    throw new Error('Nome, e-mail e escola são obrigatórios para criar o acesso.');
  }

  const { data, error } = await client.functions.invoke('create-student-account', {
    body: {
      name,
      email,
      tenantId,
      phone: input.phone?.trim() || null,
      professorId: input.professorId?.trim() || null,
      monthlyFee: input.monthlyFee ?? 0,
      dueDay: input.dueDay ?? 10,
    },
  });

  if (error || data?.error) {
    const parsed = parseFunctionError({
      error,
      data,
      fallbackMessage: 'Não foi possível criar o acesso seguro do aluno.',
    });
    throw new Error(parsed.message);
  }

  const userId = typeof data?.user?.id === 'string' ? data.user.id.trim() : '';
  if (!userId) {
    throw new Error('O servidor não confirmou a criação do acesso do aluno.');
  }

  return {
    userId,
    created: data?.created !== false,
    activationSent: data?.activationSent === true,
  };
}
