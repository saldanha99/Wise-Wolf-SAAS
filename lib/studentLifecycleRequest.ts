import { parseFunctionErrorAsync } from './functionInvokeErrors';
import type { StudentOffboardingPolicy } from './studentLifecycleUi';

type LifecycleRequest = {
  studentId: string;
  reason: string | null;
} & (
  | { status: 'active' | 'suspended' }
  | { status: 'offboarded'; billingPolicy: StudentOffboardingPolicy; effectiveEndDate: string }
);

interface LifecycleClient {
  functions: {
    invoke(name: string, options: { body: unknown }): Promise<{ data: unknown; error: unknown }>;
  };
}

export interface StudentLifecycleResult {
  ok: true;
  billing?: Record<string, unknown>;
}

/** A status change is complete only after the server confirms its billing workflow. */
export async function changeStudentLifecycle(
  client: LifecycleClient,
  request: LifecycleRequest,
): Promise<StudentLifecycleResult> {
  const { data, error } = await client.functions.invoke('school-admin', {
    body: { action: 'setStudentLifecycle', ...request },
  });
  if (error || !data || typeof data !== 'object' || (data as { ok?: unknown }).ok !== true) {
    const parsed = await parseFunctionErrorAsync({
      error,
      data,
      fallbackMessage: 'Não foi possível concluir a mudança da matrícula e do financeiro. O status não foi confirmado.',
    });
    throw new Error(parsed.message + (parsed.details ? `\n\n${parsed.details}` : ''));
  }
  return data as StudentLifecycleResult;
}
