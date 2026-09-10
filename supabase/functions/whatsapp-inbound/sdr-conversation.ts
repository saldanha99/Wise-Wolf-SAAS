/** Replies to acknowledgements must not create another scheduling request. */
export function isWaitingAcknowledgement(text: string): boolean {
  const normalized = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[.,!😊👍🙏✅🆗]/gu, " ").trim().replace(
      /\s+/g,
      " ",
    );
  return /^(?:(?:ok|okay|certo|ta bom|tudo bem|combinado|beleza|obrigad[oa]|perfeito)\s*)?(?:(?:eu )?(?:fico|ficarei|estou|to|vou ficar) (?:no aguardo|aguardando)|no aguardo|aguardo)?(?:\s*(?:ok|obrigad[oa]))?$/
    .test(normalized) &&
    (normalized.length > 0 || /[👍🙏✅🆗]/u.test(text));
}

export interface WaitingRequest {
  status: string;
  created_at: string;
  expires_at: string;
}

export function waitingReply(
  request: WaitingRequest,
  now = Date.now(),
): string | null {
  const created = Date.parse(request.created_at);
  const deadline = Math.min(
    Date.parse(request.expires_at),
    created + 60 * 60_000,
  );
  if (request.status === "EXPIRED" || deadline <= now) {
    return "Ainda não recebi o aceite do professor para o horário solicitado. Vamos verificar outra opção? Qual outro dia e horário funciona para você? A mudança depende de uma nova confirmação do professor.";
  }
  // An acknowledgement immediately after our promise doesn't need another bubble.
  if (now - created < 2 * 60_000) return null;
  return "O pedido já foi enviado e ainda aguardo o aceite do professor. Se não houver confirmação em até 60 minutos do pedido, volto por aqui para combinarmos outra opção.";
}

/** Fail closed on lookup failures. The newest turn includes previous inbound text. */
export async function isLatestSdrTurn(
  sb: any,
  tenantId: string,
  phone: string,
  msgId: string,
): Promise<boolean> {
  if (!msgId) return false;
  const { data, error } = await sb.from("ai_wa_messages")
    .select("meta").eq("tenant_id", tenantId).eq("phone", phone)
    .eq("agent", "sdr").eq("direction", "in")
    .not("meta->>msg_id", "is", null)
    .order("created_at", { ascending: false }).order("id", { ascending: false })
    .limit(1).maybeSingle();
  return !error && data?.meta?.msg_id === msgId;
}

export function sameReply(a: string, b: string): boolean {
  const normalize = (s: string) =>
    s.normalize("NFKC").toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return Boolean(normalize(a)) && normalize(a) === normalize(b);
}
