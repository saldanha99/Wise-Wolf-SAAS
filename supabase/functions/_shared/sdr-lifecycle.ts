export type SdrFollowupStage =
  | "qualification"
  | "after_trial"
  | "enrollment_pending";

export function followupStage(
  leadStatus: string,
  trialStatus: string | null,
  enrollmentPending: boolean,
): SdrFollowupStage | null {
  if (["WON", "LOST"].includes(leadStatus)) return null;
  if (enrollmentPending) return "enrollment_pending";
  if (
    leadStatus === "TRIAL_DONE" &&
    ["DONE", "COMPLETED"].includes(String(trialStatus).toUpperCase())
  ) return "after_trial";
  if (["NEW", "CONTACTED"].includes(leadStatus) && !trialStatus) {
    return "qualification";
  }
  return null; // The existing class-reminder flow owns confirmed appointments.
}

export function stageFollowupMessage(
  stage: SdrFollowupStage,
  name: string,
  brand: string,
  touch: number,
  goal = "",
): string {
  const first = name.trim().split(/\s+/)[0];
  const greeting = `Oi${first ? ", " + first : ""}!`;
  if (stage === "enrollment_pending") {
    return touch === 0
      ? `${greeting} Vi que sua matrícula na ${brand} está em andamento. Ficou alguma dúvida ou dificuldade para concluir? Posso chamar a equipe para ajudar.`
      : `${greeting} Se precisar de ajuda com a matrícula que iniciou, pode me chamar por aqui. Vou pausar os lembretes para não incomodar.`;
  }
  if (stage === "after_trial") {
    return touch === 0
      ? `${greeting} Como foi sua aula experimental na ${brand}? Queria saber se ela atendeu ao que você procura${
        goal ? " com o inglês" : ""
      } e se ficou alguma dúvida sobre os próximos passos.`
      : `${greeting} Ficou alguma dúvida sobre continuar as aulas depois da experimental? Posso ajudar por aqui; vou pausar os lembretes até você querer retomar.`;
  }
  return touch === 0
    ? `${greeting} Quer continuar de onde paramos na ${brand}? ${
      goal
        ? "Posso ajudar a escolher um dia e horário para sua experimental."
        : "Qual é seu objetivo com o inglês? Assim consigo orientar sua aula experimental."
    }`
    : `${greeting} Vou pausar os lembretes para não incomodar. Quando quiser retomar sua aula experimental, é só me chamar por aqui.`;
}

export async function claimSdrEvent(sb: any, kind: string, subject: string) {
  const key = { kind, subject_id: subject, ref_date: "1970-01-01" };
  const { error } = await sb.from("automation_sent").insert(key);
  if (error && error.code !== "23505") {
    throw new Error("sdr_event_claim_failed");
  }
  return {
    ok: !error,
    undo: async () => {
      const { error } = await sb.from("automation_sent").delete().match(key);
      if (error) throw new Error("sdr_event_release_failed");
    },
  };
}

export function teacherReminderDue(
  createdAt: string,
  expiresAt: string,
  status: string,
  now = Date.now(),
): boolean {
  const age = now - Date.parse(createdAt);
  return status === "PENDING" && age >= 30 * 60000 && age < 60 * 60000 &&
    Date.parse(expiresAt) > now;
}
