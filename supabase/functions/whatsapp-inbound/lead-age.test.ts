/// <reference lib="deno.ns" />
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  asksAge,
  asksGuardian,
  normalizeAge,
  parseGuardianPhone,
  parseLeadAge,
  trialAgeGate,
} from "./lead-age.ts";

Deno.test("idade dita pelo lead (lead menor de idade, 10/11)", () => {
  assertEquals(
    parseLeadAge(
      "Tenho 15 anos por enquanto não tenho um objetivo profissional",
    ),
    15,
  );
  assertEquals(parseLeadAge("tenho 32 anos"), 32);
  assertEquals(parseLeadAge("17 anos de idade"), 17);
});

Deno.test("número solto só é idade quando a escola perguntou", () => {
  assertEquals(parseLeadAge("15"), null);
  assertEquals(parseLeadAge("15", true), 15);
  assertEquals(parseLeadAge("16 anos"), null);
  assertEquals(parseLeadAge("16 anos", true), 16);
  assertEquals(parseLeadAge("estudei 5 anos de inglês"), null);
  assertEquals(parseLeadAge("3 a 4 vezes na semana", true), null);
  assertEquals(parseLeadAge("3 vezes na semana", true), null);
});

Deno.test("idade do modelo normalizada", () => {
  assertEquals(normalizeAge(15), 15);
  assertEquals(normalizeAge("15 anos"), 15);
  assertEquals(normalizeAge(null), null);
  assertEquals(normalizeAge("abc"), null);
  assertEquals(normalizeAge(300), null);
});

Deno.test("telefone do responsável (lead menor de idade, 10/11)", () => {
  assertEquals(
    parseGuardianPhone("11987650000 telefone da minha mãe", "5511912340000"),
    "5511987650000",
  );
  assertEquals(parseGuardianPhone("(11) 98765-4321"), "5511987654321");
  assertEquals(parseGuardianPhone("+55 11 98765-4321"), "5511987654321");
  // O próprio número do lead não é o do responsável.
  assertEquals(parseGuardianPhone("1191234-0000", "5511912340000"), null);
  assertEquals(parseGuardianPhone("3 vezes na semana"), null);
});

Deno.test("gate: sem idade pergunta a idade", () => {
  const g = trialAgeGate({ age: null, guardianPhone: null });
  assertEquals(g.ok, false);
  if (!g.ok) assertEquals(g.reason, "age_unknown");
  if (!g.ok) assertEquals(asksAge(g.ask), true);
});

Deno.test("gate: menor sem responsável pede o contato", () => {
  const g = trialAgeGate({ age: 15, guardianPhone: null });
  assertEquals(g.ok, false);
  if (!g.ok) assertEquals(g.reason, "guardian_missing");
  if (!g.ok) assertEquals(asksGuardian(g.ask), true);
});

Deno.test("gate: menor com responsável e adulto passam", () => {
  assertEquals(
    trialAgeGate({ age: 15, guardianPhone: "5511987650000" }),
    { ok: true, minor: true },
  );
  assertEquals(trialAgeGate({ age: 18, guardianPhone: null }), {
    ok: true,
    minor: false,
  });
});
