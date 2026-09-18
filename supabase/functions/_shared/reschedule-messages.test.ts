/// <reference lib="deno.ns" />
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  rescheduleBacklogMessage,
  rescheduleOverdueGroupMessage,
  rescheduleOverdueTeacherMessage,
} from "./reschedule-messages.ts";

Deno.test("resumo por professor: quem tem passivo aparece; totais no fim; vazio é uma linha", () => {
  const msg = rescheduleBacklogMessage([
    {
      professor: "Mateus Ebenezer",
      teacher_id: "m",
      sem_data: 127,
      vencidas: 2,
      marcadas_7d: 0,
      mais_antiga: "2026-03-04",
      por_falta_do_professor: 3,
    },
    {
      professor: "Bruna Barros",
      teacher_id: "b",
      sem_data: 0,
      vencidas: 4,
      marcadas_7d: 1,
      mais_antiga: "2026-09-14",
      por_falta_do_professor: 4,
    },
    {
      professor: "Beatrís Seus",
      teacher_id: "x",
      sem_data: 0,
      vencidas: 0,
      marcadas_7d: 0,
      mais_antiga: null,
      por_falta_do_professor: 0,
    },
  ]);
  assert(
    msg.includes(
      "*Mateus*: 127 sem data · ⚠️ 2 vencidas sem lançamento · 3 por falta do professor · mais antiga 04/03",
    ),
  );
  assert(
    msg.includes(
      "*Bruna*: ⚠️ 4 vencidas sem lançamento · 1 marcada nos próximos 7 dias",
    ),
  );
  assert(!msg.includes("Beatrís"));
  assert(
    msg.includes("Total: 127 sem data · 6 vencidas · 1 marcada na semana."),
  );
  assertEquals(
    rescheduleBacklogMessage([]).split("\n").pop(),
    "Nenhuma reposição em aberto. 🐺",
  );
});

const rows = [
  {
    reschedule_id: "1",
    date: "2026-09-17",
    time: "16:00",
    fault_type: "TEACHER",
    teacher_id: "b",
    teacher_name: "Bruna Barros Feitosa",
    teacher_phone: "556492342896",
    student_id: "a",
    student_name: "Ana Clara Matedi",
  },
  {
    reschedule_id: "2",
    date: "2026-09-17",
    time: "19:30",
    fault_type: "TEACHER",
    teacher_id: "b",
    teacher_name: "Bruna Barros Feitosa",
    teacher_phone: "556492342896",
    student_id: "v",
    student_name: "Vinicius Oliveira chaves",
  },
];

Deno.test("cobrança ao professor lista as vencidas e diz o que fazer", () => {
  const msg = rescheduleOverdueTeacherMessage("Bruna Barros Feitosa", rows);
  assert(msg.startsWith("Oi, Bruna! 🐺 2 reposições passaram da data"));
  assert(msg.includes("• qui 17/09 16:00 — Ana Clara Matedi"));
  assert(msg.includes("Lançar Aula"));
});

Deno.test("linha do grupo agrupa por professor", () => {
  const msg = rescheduleOverdueGroupMessage(rows);
  assert(msg.includes("(2)"));
  assert(
    msg.includes("*Bruna*: qui 17/09 16:00 Ana; qui 17/09 19:30 Vinicius"),
  );
  assertEquals(rescheduleOverdueGroupMessage([]), "");
});
