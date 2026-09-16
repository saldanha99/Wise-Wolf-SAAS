/// <reference lib="deno.ns" />
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  absenceConfirmationAnswer,
  absenceDateFromText,
  detectTeacherAbsenceIntent,
} from "./teacher-absence.ts";

const HOJE = "2026-09-16";

Deno.test("reconhece o aviso de ausência nas formas mais comuns", () => {
  for (
    const msg of [
      "Bom dia! Não vou conseguir dar aula hoje, acordei com a garganta inflamada",
      "nao consigo dar as aulas de hoje",
      "Estou doente, preciso faltar amanhã",
      "não vou poder dar aula dia 18",
      "Tô de cama, não dou aula hoje",
      "Não vou conseguir trabalhar hoje",
    ]
  ) {
    assertEquals(detectTeacherAbsenceIntent(msg, HOJE).matched, true, msg);
  }
});

Deno.test("não dispara em conversa normal de professor", () => {
  for (
    const msg of [
      "Bom dia! A aula do Theo foi ótima",
      "Consigo dar aula amanhã sim",
      "Vou dar aula hoje às 18h",
      "Pode me mandar o link da sala?",
      "A aluna faltou hoje",
    ]
  ) {
    assertEquals(detectTeacherAbsenceIntent(msg, HOJE).matched, false, msg);
  }
});

Deno.test("resolve a data: hoje, amanhã, dia DD, DD/MM (próximo ano se já passou)", () => {
  assertEquals(
    absenceDateFromText("não vou dar aula hoje", HOJE),
    "2026-09-16",
  );
  assertEquals(
    absenceDateFromText("amanhã não consigo dar aula", HOJE),
    "2026-09-17",
  );
  assertEquals(
    absenceDateFromText("dia 18 não vou poder dar aula", HOJE),
    "2026-09-18",
  );
  assertEquals(absenceDateFromText("não dou aula 02/10", HOJE), "2026-10-02");
  assertEquals(absenceDateFromText("não dou aula 05/01", HOJE), "2027-01-05");
  assertEquals(absenceDateFromText("não vou conseguir dar aula", HOJE), null);
});

Deno.test("extrai um motivo curto, com fallback honesto", () => {
  assertEquals(
    detectTeacherAbsenceIntent(
      "Não vou conseguir dar aula hoje porque estou com febre",
      HOJE,
    ).reason,
    "estou com febre",
  );
  assertEquals(
    detectTeacherAbsenceIntent(
      "acordei com dor de garganta, não dou aula hoje",
      HOJE,
    ).reason,
    "com dor de garganta",
  );
  assertEquals(
    detectTeacherAbsenceIntent("não vou conseguir dar aula hoje", HOJE).reason,
    "imprevisto",
  );
});

Deno.test("confirmação: sim/não/nada", () => {
  assertEquals(absenceConfirmationAnswer("Sim"), "yes");
  assertEquals(absenceConfirmationAnswer("pode sim, obrigado"), "yes");
  assertEquals(absenceConfirmationAnswer("Não, era só um aviso"), "no");
  assertEquals(absenceConfirmationAnswer("quem vai cobrir?"), null);
});
