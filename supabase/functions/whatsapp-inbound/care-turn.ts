export interface CareInboxMessage {
  provider_message_id: string | null;
  direction: string;
  message_type: string;
  body: string | null;
  created_at: string;
}

/** Only the newest inbound turn may answer; all its fragments follow the last reply. */
export function mergeCareTurn(
  rows: CareInboxMessage[],
  msgId: string,
): string | null {
  const latest = rows.find((row) => row.direction === "in");
  if (!msgId || latest?.provider_message_id !== msgId) return null;
  const fragments: string[] = [];
  for (const row of rows) {
    if (row.direction === "out") break;
    if (row.direction !== "in") continue;
    // An untranscribed file must never become invented text for the model.
    if (row.message_type !== "text" && row.message_type !== "audio") {
      return null;
    }
    if (!row.body || /^\[(?:Áudio|Audio|mídia)\]$/i.test(row.body)) return null;
    if (Date.parse(latest.created_at) - Date.parse(row.created_at) > 120_000) {
      break;
    }
    fragments.unshift(row.body);
  }
  return fragments.length ? fragments.join("\n").slice(0, 4096) : null;
}

export async function loadCareTurn(
  sb: any,
  tenantId: string,
  instance: string,
  phone: string,
  msgId: string,
  fallback: string,
): Promise<string | null> {
  const { data: conversation, error } = await sb.from("whatsapp_conversations")
    .select("id,handoff_active").eq("tenant_id", tenantId)
    .eq("instance_name", instance).eq("remote_jid", `${phone}@s.whatsapp.net`)
    .maybeSingle();
  if (error) throw new Error("care_conversation_lookup_failed");
  if (!conversation) return fallback; // Legacy tenants without canonical inbox.
  if (conversation.handoff_active) return null;
  const result = await sb.from("whatsapp_messages")
    .select("provider_message_id,direction,message_type,body,created_at")
    .eq("tenant_id", tenantId).eq("conversation_id", conversation.id)
    .order("created_at", { ascending: false }).order("id", { ascending: false })
    .limit(20);
  if (result.error) throw new Error("care_turn_lookup_failed");
  return mergeCareTurn(result.data || [], msgId);
}
