import { claimSdrEvent } from "./sdr-lifecycle.ts";
import type { EvolutionSendResult } from "./evolution-send.ts";

export async function deliverTeacherReminder(sb: any, input: {
  tenantId: string;
  subject: string;
  phone: string;
  message: string;
  stillPending: () => Promise<boolean>;
  send: () => Promise<EvolutionSendResult>;
}): Promise<"sent" | "skipped" | "failed"> {
  if (!await input.stillPending()) return "skipped";
  const event = await claimSdrEvent(
    sb,
    "SDR_TEACHER_REMINDER_30M",
    `${input.tenantId}:${input.subject}:${input.phone}`,
  );
  if (!event.ok) return "skipped";
  // Revalidate after claiming: a teacher may have accepted while this run queued.
  if (!await input.stillPending()) return "skipped";
  const delivery = await input.send();
  const { error } = await sb.from("ai_wa_messages").insert({
    tenant_id: input.tenantId,
    phone: input.phone,
    agent: "trial_reschedule",
    direction: "out",
    content: input.message,
    meta: {
      kind: "teacher_reminder_30m",
      subject: input.subject,
      entregue: delivery.outcome === "accepted",
      delivery_outcome: delivery.outcome,
    },
  });
  // An uncertain delivery is deliberately never replayed automatically.
  if (delivery.outcome === "rejected") await event.undo();
  if (error) throw new Error("teacher_reminder_log_failed");
  return delivery.outcome === "accepted" ? "sent" : "failed";
}
