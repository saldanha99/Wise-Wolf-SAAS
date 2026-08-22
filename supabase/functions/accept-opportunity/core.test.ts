/// <reference lib="deno.ns" />

import { claimErrorStatus, normalizeAcceptOpportunityInput } from "./core.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function rejects(callback: () => unknown, message: string): void {
  let rejected = false;
  try {
    callback();
  } catch {
    rejected = true;
  }
  assert(rejected, message);
}

Deno.test("accept opportunity aceita somente ID opaco e geracao", () => {
  const input = normalizeAcceptOpportunityInput({
    opportunityId: "00000000-0000-4000-8000-000000000001",
    generation: 1,
  });
  assert(
    input.opportunityId === "00000000-0000-4000-8000-000000000001",
    "ID valido nao foi normalizado",
  );
  assert(input.generation === 1, "geracao valida nao foi normalizada");
});

Deno.test("accept opportunity rejeita slot tenant professor e PII do cliente", () => {
  for (
    const field of [
      "selectedSlot",
      "tenantId",
      "teacherId",
      "studentName",
      "studentPhone",
      "kind",
    ]
  ) {
    rejects(
      () =>
        normalizeAcceptOpportunityInput({
          opportunityId: "00000000-0000-4000-8000-000000000001",
          generation: 1,
          [field]: "adulterado",
        }),
      `${field} deveria ser rejeitado`,
    );
  }
});

Deno.test("accept opportunity rejeita UUID invalido e payload legado", () => {
  rejects(
    () =>
      normalizeAcceptOpportunityInput({
        opportunityId: "tenant-a",
        generation: 1,
      }),
    "ID arbitrario deveria ser rejeitado",
  );
  rejects(
    () =>
      normalizeAcceptOpportunityInput({
        opportunity_id: "00000000-0000-4000-8000-000000000001",
        generation: 1,
      }),
    "payload snake_case legado deveria ser rejeitado",
  );
  for (const generation of [0, -1, 1.5, "1", 2147483648]) {
    rejects(
      () =>
        normalizeAcceptOpportunityInput({
          opportunityId: "00000000-0000-4000-8000-000000000001",
          generation,
        }),
      `geracao ${generation} deveria ser rejeitada`,
    );
  }
});

Deno.test("accept opportunity classifica conflitos sem retornar sucesso", () => {
  assert(
    claimErrorStatus("teacher_schedule_conflict") === 409,
    "conflito deve ser 409",
  );
  assert(
    claimErrorStatus("opportunity_already_claimed") === 409,
    "corrida deve ser 409",
  );
  assert(
    claimErrorStatus("teacher_not_active_for_tenant") === 403,
    "membership deve ser 403",
  );
  assert(
    claimErrorStatus("opportunity_slot_expired") === 410,
    "expirado deve ser 410",
  );
  assert(
    claimErrorStatus("claim_link_expired") === 410,
    "rodada expirada deve ser 410",
  );
  assert(
    claimErrorStatus("unknown") === 500,
    "erro desconhecido deve falhar fechado",
  );
});
