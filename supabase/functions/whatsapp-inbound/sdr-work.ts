/** One database lease per tenant/contact, shared by webhook and recovery worker. */
export interface SdrInput {
  instance: string;
  text: string;
  pushName: string;
  isMedia: boolean;
  msgId: string;
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
  ) => Promise<void>,
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
    await respond(work.payload, beginEffects);
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
