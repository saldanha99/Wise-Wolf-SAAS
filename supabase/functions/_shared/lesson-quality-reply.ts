/** Deliberately deterministic. No LLM adjudicates attendance or payroll. */
export function classifyLessonQualityReply(
  text: string,
  quoted: boolean,
): string | null {
  const normalized = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().trim();
  if (quoted && /^[123]$/.test(normalized)) {
    return { "1": "OK", "2": "OTHER", "3": "UNKNOWN" }[normalized] || null;
  }
  // Without a quoted message, only an explicit lesson-quality phrase is routed.
  if (!quoted && !/\baula\b/.test(normalized)) return null;
  if (/\b(atraso|atrasou|atrasado)\b/.test(normalized)) return "LATE_START";
  if (
    /terminou (mais cedo|antes)|encerrou (mais cedo|antes)/.test(normalized)
  ) return "EARLY_END";
  if (
    /pediu (para |pra )?(mudar|trocar|remarcar)|professor.*(remarc|mudou.*horario)/
      .test(normalized)
  ) return "SCHEDULE_CHANGE";
  if (
    /nao (houve|teve|aconteceu).*aula|professor nao (veio|compareceu|entrou)/
      .test(normalized)
  ) return "DID_NOT_HAPPEN";
  if (/nao acompanhei|nao sei se.*aula/.test(normalized)) return "UNKNOWN";
  if (
    quoted &&
    /^(tudo (certo|no horario)|aula (ok|no horario))\.?$/.test(normalized)
  ) return "OK";
  return null;
}

export function quotedLessonMessageId(
  message: Record<string, any>,
): string | null {
  const context = message.extendedTextMessage?.contextInfo ||
    message.imageMessage?.contextInfo || message.audioMessage?.contextInfo ||
    message.contextInfo;
  return typeof context?.stanzaId === "string"
    ? context.stanzaId.slice(0, 320)
    : null;
}

export async function routeLessonQualityReply(
  client: any,
  input: {
    tenantId: string;
    instance: string;
    phone: string;
    messageId: string;
    text: string;
    quotedId: string | null;
  },
) {
  // Número solto não comprova aula nem identidade do responsável. Mas, havendo
  // auditoria recente para este destino, também não pode cair num check-in/SDR.
  // Só pedimos contexto; o registro continua pela RPC com as cercas originais.
  if (!input.quotedId && /^[123]$/.test(input.text.trim())) {
    const now = new Date();
    const { data: audits, error: auditError } = await client
      .from("attendance_confirmations")
      .select("id,canonical_confirmation_id")
      .eq("tenant_id", input.tenantId)
      .eq("provider_instance_name", input.instance.trim().toLowerCase())
      .eq("quality_recipient_phone", input.phone)
      .eq("delivery_status", "SENT")
      .neq("status", "CANCELLED")
      .gte("sent_at", new Date(now.getTime() - 48 * 3600000).toISOString())
      .gt("token_expires_at", now.toISOString());
    if (auditError) throw new Error("lesson_quality_context_failed");
    if (
      (audits || []).some((
        a: { id: string; canonical_confirmation_id: string | null },
      ) => !a.canonical_confirmation_id || a.canonical_confirmation_id === a.id)
    ) return { handled: true, needs_context: true };
    return { handled: false };
  }
  const category = classifyLessonQualityReply(input.text, !!input.quotedId);
  if (!category) return { handled: false };
  const { data, error } = await client.rpc("ingest_lesson_quality_whatsapp", {
    p_tenant: input.tenantId,
    p_instance: input.instance,
    p_phone: input.phone,
    p_message_id: input.messageId,
    p_quoted_id: input.quotedId,
    p_category: category,
    p_text: input.text.slice(0, 2000),
  });
  if (error) throw new Error("lesson_quality_reply_failed");
  return data || { handled: false };
}
