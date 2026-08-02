import {
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
} from "../../../../lib/supabase-config";
import type {
  CompleteQuizAnswers,
  QuizRecommendation,
} from "./quizModel";
import { PUBLIC_QUIZ_VERSION } from "./quizModel";
import {
  WOLFIE_LEAD_RETENTION_DAYS,
  WOLFIE_PRIVACY_NOTICE_VERSION,
} from "../privacy";

export interface WolfieLeadInput {
  name: string;
  email: string;
  phone?: string;
  consent: boolean;
}

const cleanLine = (value: string, maxLength: number) =>
  value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);

const validEmail = (value: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

export async function submitWolfieLead(
  input: WolfieLeadInput,
  answers: CompleteQuizAnswers,
  recommendation: QuizRecommendation,
  requestId: string,
) {
  const name = cleanLine(input.name, 120);
  const email = cleanLine(input.email.toLowerCase(), 254);
  const phone = (input.phone ?? "").replace(/[^\d+()\s-]/g, "").trim().slice(0, 32);
  const phoneDigits = phone.replace(/\D/g, "");

  if (name.length < 2) throw new Error("Informe seu nome.");
  if (!validEmail(email)) throw new Error("Informe um e-mail válido.");
  if (phoneDigits && (phoneDigits.length < 10 || phoneDigits.length > 13)) {
    throw new Error("Confira o número de WhatsApp.");
  }
  if (!input.consent) {
    throw new Error("Confirme o consentimento para receber o contato da equipe.");
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(requestId)
  ) {
    throw new Error("Reinicie o diagnóstico antes de enviar.");
  }

  const goal = cleanLine(
    `Wolfie — ${recommendation.primary.title} — nível declarado ${recommendation.startingLevel}`,
    500,
  );
  const notes = cleanLine([
    `Origem: diagnóstico público Wolfie v${PUBLIC_QUIZ_VERSION}.`,
    `Objetivo: ${answers.goal}.`,
    `Contexto: ${answers.context}.`,
    `Participação: ${answers.participation}.`,
    `Bloqueio: ${answers.obstacle}.`,
    `Formato: ${answers.modality}.`,
    `Urgência: ${answers.urgency}.`,
    `Rotina: ${answers.practiceMinutes} minutos.`,
    `Experiência recomendada: ${recommendation.primary.experienceId}.`,
    `Consentimento: contato comercial solicitado; aviso de privacidade ${WOLFIE_PRIVACY_NOTICE_VERSION}.`,
    `Retenção padrão para lead não convertido: ${WOLFIE_LEAD_RETENTION_DAYS} dias após o último contato.`,
  ].join(" "), 3000);

  const response = await fetch(`${SUPABASE_URL}/rest/v1/crm_leads`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      tenant_id: "school-wise-wolf",
      name,
      email,
      phone,
      status: "NEW",
      source: "wolfie_quiz",
      goal,
      notes,
      public_intake_idempotency_key: requestId,
    }),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null) as
      | { code?: string; details?: string; message?: string }
      | null;
    const duplicateContext = `${payload?.message ?? ""} ${payload?.details ?? ""}`;
    if (
      response.status === 409 &&
      payload?.code === "23505" &&
      duplicateContext.includes(
        "crm_leads_public_intake_idempotency_uniq",
      )
    ) return;
    if (payload?.code === "P0001" || response.status === 429) {
      throw new Error("Muitas tentativas recentes. Aguarde um pouco e tente novamente.");
    }
    throw new Error("Não foi possível enviar agora. Tente novamente em instantes.");
  }
}
