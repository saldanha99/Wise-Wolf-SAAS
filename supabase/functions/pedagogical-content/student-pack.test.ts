import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  buildStudentPackPrompt,
  STUDENT_PACK_PROVIDER_SCHEMA,
  studentPackLesson,
} from "./student-pack.ts";

const profile = { module: "B1", english_for: "trabalho" };

Deno.test("aula sem conteúdo útil não entra no pacote", () => {
  assertEquals(studentPackLesson(null, null), null);
  assertEquals(
    studentPackLesson({ content: "-", lesson_objective: "General" }, null),
    null,
  );
  assertEquals(
    studentPackLesson({ content_covered: "CONVERSAÇAO" }, null),
    null,
  );
});

Deno.test("aula aprovada entra com a memória verificada da sessão", () => {
  const lesson = studentPackLesson(
    {
      lesson_objective: "Praticar comparativos com produtos eletrônicos",
      content_covered: "Comparativos curtos (-er) e longos (more/less)",
      student_difficulties: "Esquece o than",
    },
    {
      new_vocabulary: ["battery", "durability"],
      recurring_errors: ["more cheap"],
    },
  );
  assert(lesson);
  assertEquals(lesson.new_vocabulary, ["battery", "durability"]);
  assertEquals(lesson.recurring_errors, ["more cheap"]);

  const prompt = buildStudentPackPrompt(profile, null, lesson, [
    "Trabalha com vendas",
  ]);
  assert(prompt.includes("ÚLTIMA AULA APROVADA"));
  assert(prompt.includes("comparativos com produtos eletrônicos"));
  assert(prompt.includes("As quatro atividades praticam o conteúdo"));
  assert(prompt.includes("Trabalha com vendas"));
});

Deno.test("sem aula, o prompt fica como antes", () => {
  const prompt = buildStudentPackPrompt(profile, null, null, []);
  assert(!prompt.includes("ÚLTIMA AULA"));
  assert(!prompt.includes("O QUE O ALUNO CONTOU"));
  assert(prompt.includes("EXATAMENTE quatro atividades"));
});

Deno.test("memória verificada supre aula lançada sem resumo", () => {
  const lesson = studentPackLesson(
    { content: "" },
    {
      lesson_objective: "Rotina diária no presente simples",
      content_practiced: "Daily routine verbs: wake up, commute, have lunch",
    },
  );
  assert(lesson);
  assert(lesson.content_covered.includes("Daily routine"));
});

Deno.test("e-mail e telefone no resumo saem antes do prompt", () => {
  const lesson = studentPackLesson(
    {
      lesson_objective: "Escrever e-mail formal para aluno@exemplo.com",
      content_covered: "Ligar para (11) 98888-7777 e confirmar a reunião",
    },
    null,
  );
  assert(lesson);
  const prompt = buildStudentPackPrompt(profile, null, lesson, []);
  assert(!prompt.includes("aluno@exemplo.com"));
  assert(!prompt.includes("98888-7777"));
});

Deno.test("schema enviado à Anthropic não tem limites que ela recusa", () => {
  const text = JSON.stringify(STUDENT_PACK_PROVIDER_SCHEMA);
  for (const key of ["minLength", "maxLength", "maxItems", "minimum"]) {
    assert(!text.includes(`"${key}"`), key);
  }
  assert(!/"minItems":([2-9]|\d{2,})/.test(text));
  assert(text.includes('"additionalProperties":false'));
});
