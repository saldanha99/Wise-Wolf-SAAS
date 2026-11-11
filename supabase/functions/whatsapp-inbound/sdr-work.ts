/** One database lease per tenant/contact, shared by webhook and recovery worker. */
import type { WhatsappEntry } from "./lead-entry.ts";

export interface SdrInput {
  instance: string;
  text: string;
  pushName: string;
  isMedia: boolean;
  msgId: string;
  // Pista de origem da 1ª mensagem; o banco a preserva nas seguintes.
  entry?: WhatsappEntry | null;
}

/**
 * A atendente pode pedir para a mesma mensagem ser tentada de novo mais tarde
 * (IA fora do ar). A mensagem continua pendente na fila; nada é dado como
 * respondido.
 */
export interface SdrDeferral {
  deferSeconds: number;
}

export async function enqueueSdrInput(
  sb: any,
  tenantId: string,
  phone: string,
  payload: SdrInput,
) {
  const { error } = await sb.rpc("enqueue_sdr_work", {
    p_tenant_id: tenantId,
    p_phone: phone,
    p_payload: payload,
  });
  if (error) throw new Error("sdr_enqueue_failed");
}

export async function runSdrWork(
  sb: any,
  tenantId: string,
  phone: string,
  respond: (
    input: SdrInput,
    beginEffects: () => Promise<boolean>,
  ) => Promise<SdrDeferral | void>,
): Promise<boolean> {
  const { data: work, error } = await sb.rpc("claim_sdr_work", {
    p_tenant_id: tenantId,
    p_phone: phone,
  });
  if (error) throw new Error("sdr_claim_failed");
  if (!work?.claimed) return false;
  let applying = false;
  const args = { p_tenant_id: tenantId, p_phone: phone, p_token: work.token };
  const beginEffects = async () => {
    if (applying) return true;
    const { data, error } = await sb.rpc("begin_sdr_effects", args);
    if (error) throw new Error("sdr_effects_fence_failed");
    applying = data === true;
    return applying;
  };
  try {
    const outcome = await respond(work.payload, beginEffects);
    if (outcome && outcome.deferSeconds > 0) {
      const { error } = await sb.rpc("defer_sdr_work", {
        ...args,
        p_delay_seconds: Math.round(outcome.deferSeconds),
      });
      if (error) throw new Error("sdr_defer_failed");
      // Adiada não conta como "rodou": quem drena não deve insistir agora.
      return false;
    }
    const { error } = await sb.rpc("finish_sdr_work", {
      ...args,
      p_success: true,
    });
    if (error) throw new Error("sdr_finish_failed");
  } catch (error) {
    // Once effects started, an uncertain crash must never replay the whole turn.
    await sb.rpc("finish_sdr_work", { ...args, p_success: false });
    throw error;
  }
  return true;
}
