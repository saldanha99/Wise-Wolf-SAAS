import { beforeEach, describe, expect, it, vi } from "vitest";
import { recommendQuizExperience, type CompleteQuizAnswers } from "./quizModel";
import { submitWolfieLead } from "./leadIntake";

vi.mock("../../../../lib/supabase-config", () => ({
  SUPABASE_URL: "https://api.wisewolflanguage.com.br",
  SUPABASE_ANON_KEY: "public-anon-test-key-with-safe-length",
}));

const requestId = "019c1234-5678-4abc-9def-0123456789ab";
const answers: CompleteQuizAnswers = {
  goal: "global_meeting",
  context: "technology",
  participation: "lead",
  declaredAbility: "routine_conversations",
  obstacle: "thinking_time",
  modality: "voice",
  urgency: "next_7_days",
  practiceMinutes: "10",
};
const recommendation = recommendQuizExperience(answers);
const lead = {
  name: "Pessoa de Teste",
  email: "pessoa@example.invalid",
  phone: "11999999999",
  consent: true,
};

describe("intake público do quiz Wolfie", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("envia a chave idempotente com credencial estritamente anônima", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await submitWolfieLead(lead, answers, recommendation, requestId);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({
      Authorization: "Bearer public-anon-test-key-with-safe-length",
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      tenant_id: "school-wise-wolf",
      source: "wolfie_quiz",
      public_intake_idempotency_key: requestId,
    });
  });

  it("considera sucesso apenas a duplicidade da constraint idempotente", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: "23505",
      message: 'duplicate key violates "crm_leads_public_intake_idempotency_uniq"',
    }), { status: 409, headers: { "Content-Type": "application/json" } })));

    await expect(submitWolfieLead(lead, answers, recommendation, requestId))
      .resolves.toBeUndefined();
  });

  it("não mascara outra violação unique como sucesso", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: "23505",
      message: 'duplicate key violates "crm_leads_email_key"',
    }), { status: 409, headers: { "Content-Type": "application/json" } })));

    await expect(submitWolfieLead(lead, answers, recommendation, requestId))
      .rejects.toThrow(/Não foi possível enviar/);
  });

  it("bloqueia uma chave manipulada antes da chamada de rede", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitWolfieLead(lead, answers, recommendation, "invalida"))
      .rejects.toThrow(/Reinicie o diagnóstico/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
