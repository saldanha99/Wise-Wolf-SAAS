import { describe, expect, it, vi } from 'vitest';
import { changeStudentLifecycle } from './studentLifecycleRequest';

const request = { studentId: 'student-fixture', status: 'suspended' as const, reason: 'Pausa solicitada' };

describe('student lifecycle and billing confirmation', () => {
  it('returns only the confirmed server result, including billing evidence', async () => {
    const response = { ok: true, billing: { paymentsCancelled: 2 } };
    const invoke = vi.fn().mockResolvedValue({ data: response, error: null });
    await expect(changeStudentLifecycle({ functions: { invoke } }, request)).resolves.toEqual(response);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('school-admin', {
      body: { action: 'setStudentLifecycle', ...request },
    });
  });

  it('surfaces a billing conflict from an HTTP error before the caller can report success', async () => {
    const invoke = vi.fn().mockResolvedValue({
      data: null,
      error: { context: new Response(JSON.stringify({ error: 'Concilie a cobrança antes de pausar.' }), { status: 409 }) },
    });
    await expect(changeStudentLifecycle({ functions: { invoke } }, request)).rejects.toThrow('Concilie a cobrança');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it.each([null, {}, { ok: false }, { ok: 'true' }])('rejects an unconfirmed result %j without a fallback write', async data => {
    const invoke = vi.fn().mockResolvedValue({ data, error: null });
    const rpc = vi.fn();
    const client = { functions: { invoke }, rpc };
    await expect(changeStudentLifecycle(client, request)).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('does not retry an uncertain transport result', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('network unavailable'));
    await expect(changeStudentLifecycle({ functions: { invoke } }, request)).rejects.toThrow('network unavailable');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
