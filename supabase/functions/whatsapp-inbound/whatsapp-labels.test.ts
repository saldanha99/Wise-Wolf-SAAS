/// <reference lib="deno.ns" />
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { labelKind, mapLabelsByKind } from "./whatsapp-labels.ts";

Deno.test("nome da etiqueta vira tipo de contato", () => {
  assertEquals(labelKind("Aluno"), "student");
  assertEquals(labelKind("ALUNOS"), "student");
  assertEquals(labelKind("Lead"), "lead");
  assertEquals(labelKind("Leads"), "lead");
  assertEquals(labelKind("Professor"), "teacher");
  assertEquals(labelKind("Professores"), "teacher");
});

Deno.test("lead professor é candidato, não professor nem lead", () => {
  assertEquals(labelKind("Lead Professor"), "candidate");
  assertEquals(labelKind("Leads Professores"), "candidate");
  assertEquals(labelKind("Candidato"), "candidate");
});

Deno.test("etiqueta que não é de nenhum tipo é ignorada", () => {
  assertEquals(labelKind("Pagamento pendente"), null);
  assertEquals(labelKind(""), null);
});

Deno.test("uma etiqueta por tipo, a de nome mais geral", () => {
  const mapa = mapLabelsByKind([
    { id: "1", name: "Aluno antigo" },
    { id: "2", name: "Aluno" },
    { id: "3", name: "Lead Professor" },
    { id: "4", name: "Pagamento" },
    { id: "5", name: "" },
  ]);
  assertEquals(mapa.student?.id, "2");
  assertEquals(mapa.candidate?.id, "3");
  assertEquals(mapa.teacher, undefined);
  assertEquals(mapa.lead, undefined);
});
