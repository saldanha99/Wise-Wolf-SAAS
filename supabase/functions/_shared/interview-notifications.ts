export type InterviewNotificationAudience = "CANDIDATE" | "MANAGEMENT";
export type InterviewNotificationEvent = "BOOKED" | "REMINDER";

export type InterviewQueueOutcome = {
  ok: boolean;
  queued: boolean;
  duplicate: boolean;
  reason: string | null;
};

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || "candidato(a)";
}

export function normalizeInterviewPhone(raw: string): string {
  let phone = String(raw || "").replace(/\D/g, "");
  if (phone.length === 10 || phone.length === 11) phone = `55${phone}`;
  return phone;
}

export function interviewNotificationKind(
  event: InterviewNotificationEvent,
  audience: InterviewNotificationAudience,
): string {
  return `INTERVIEW_${event}_${audience}`;
}

export function buildInterviewBookedMessages(input: {
  candidateName: string;
  candidatePhone: string;
  brandName: string;
  date: string;
  dayOfWeek: string;
  time: string;
  aiScore?: number | string | null;
}): { candidate: string; management: string } {
  const candidatePhone = normalizeInterviewPhone(input.candidatePhone);
  const score = input.aiScore == null || String(input.aiScore).trim() === ""
    ? ""
    : ` Score da triagem: ${String(input.aiScore).trim()}.`;
  return {
    candidate: `✅ Entrevista confirmada, ${
      firstName(input.candidateName)
    }! ${input.date} (${input.dayOfWeek}) às ${input.time}, horário de Brasília. A direção da ${input.brandName} vai te chamar aqui no WhatsApp no horário combinado. A Michelle te lembra no dia 😉 Boa sorte!`,
    management:
      `📅 *RH (IA):* entrevista AGENDADA — *${input.candidateName}* (${
        candidatePhone || "sem tel"
      }), ${input.date} às ${input.time}.${score} Detalhes no painel RH.`,
  };
}

export function buildInterviewReminderMessages(input: {
  candidateName: string;
  candidatePhone: string;
  brandName: string;
  time: string;
}): { candidate: string; management: string } {
  return {
    candidate: `Oi, ${
      firstName(input.candidateName)
    }! Michelle da ${input.brandName}. Lembrete: sua entrevista com a direção é HOJE às ${input.time}. Até já! 😊`,
    management:
      `📅 *RH (IA):* lembrete — entrevista HOJE às ${input.time} com *${input.candidateName}* (${
        normalizeInterviewPhone(input.candidatePhone)
      }).`,
  };
}

export function parseInterviewQueueOutcome(
  data: unknown,
): InterviewQueueOutcome {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {
      ok: false,
      queued: false,
      duplicate: false,
      reason: "invalid_result",
    };
  }
  const value = data as Record<string, unknown>;
  return {
    ok: value.ok === true,
    queued: value.queued === true,
    duplicate: value.duplicate === true,
    reason: typeof value.reason === "string" ? value.reason : null,
  };
}
