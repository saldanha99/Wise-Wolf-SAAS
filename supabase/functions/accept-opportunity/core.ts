export interface AcceptOpportunityInput {
  opportunityId: string;
  generation: number;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeAcceptOpportunityInput(
  body: unknown,
): AcceptOpportunityInput {
  if (!isRecord(body)) throw new Error("INVALID_BODY");
  const keys = Object.keys(body);
  if (
    keys.length !== 2 || !keys.includes("opportunityId") ||
    !keys.includes("generation")
  ) {
    throw new Error("UNEXPECTED_FIELD");
  }
  const opportunityId = typeof body.opportunityId === "string"
    ? body.opportunityId.trim()
    : "";
  if (!UUID_PATTERN.test(opportunityId)) {
    throw new Error("INVALID_OPPORTUNITY_ID");
  }
  if (
    typeof body.generation !== "number" ||
    !Number.isInteger(body.generation) ||
    body.generation < 1 ||
    body.generation > 2147483647
  ) {
    throw new Error("INVALID_CLAIM_GENERATION");
  }
  return { opportunityId, generation: body.generation };
}

export function claimErrorStatus(error: unknown): number {
  switch (error) {
    case "opportunity_not_found":
      return 404;
    case "teacher_not_active_for_tenant":
    case "tenant_not_operational":
      return 403;
    case "opportunity_slot_expired":
    case "claim_link_expired":
      return 410;
    case "opportunity_already_claimed":
    case "opportunity_not_open":
    case "opportunity_inconsistent":
    case "teacher_schedule_conflict":
      return 409;
    case "invalid_request":
    case "invalid_opportunity_kind":
    case "invalid_opportunity_slot":
    case "opportunity_slot_too_far":
      return 400;
    default:
      return 500;
  }
}

export function claimErrorMessage(error: unknown): string {
  switch (error) {
    case "opportunity_not_found":
      return "Esta oportunidade não foi encontrada.";
    case "teacher_not_active_for_tenant":
      return "Seu acesso como professor desta escola não está ativo.";
    case "tenant_not_operational":
      return "Esta escola não está disponível para novos agendamentos.";
    case "opportunity_slot_expired":
      return "O horário desta oportunidade já passou.";
    case "claim_link_expired":
      return "Este link pertence a uma rodada anterior da oportunidade.";
    case "opportunity_already_claimed":
      return "Esta oportunidade já foi aceita por outro professor.";
    case "teacher_schedule_conflict":
      return "Este horário conflita com outro compromisso da sua agenda.";
    case "invalid_opportunity_slot":
    case "invalid_opportunity_kind":
    case "opportunity_slot_too_far":
    case "opportunity_inconsistent":
      return "Esta oportunidade precisa ser revisada pela escola.";
    case "opportunity_not_open":
      return "Esta oportunidade não está mais aberta.";
    default:
      return "Não foi possível aceitar esta oportunidade agora.";
  }
}
