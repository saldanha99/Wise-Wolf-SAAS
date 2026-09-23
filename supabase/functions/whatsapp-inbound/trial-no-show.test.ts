// A diretiva existe porque o `tsconfig.json` da raiz (lib DOM, para o Vite) é
// lido pelo Deno e apaga `deno.ns` quando este arquivo roda sozinho.
/// <reference lib="deno.ns" />
import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  mentionsTrialNoShow,
  trialNoShowChannelMessage,
  trialNoShowLeadMessage,
} from "./trial-no-show.ts";

Deno.test("professora avisando que o lead não apareceu", () => {
  const sim = [
    "o aluno não compareceu",
    "a aluna da experimental não apareceu",
    "esperei 10 minutos e ninguém entrou",
    "aguardei e ela não veio",
    "o lead faltou na experimental",
    "nao compareceu a aula experimental",
    "fiquei sozinha na sala, o aluno não entrou",
    "no show do aluno de hoje",
  ];
  for (const t of sim) {
    assert(mentionsTrialNoShow(t), `deveria reconhecer: ${t}`);
  }
});

Deno.test("o que NÃO é falta do lead na experimental", () => {
  const nao = [
    "a aula foi ótima", // aconteceu
    "consegui dar a aula",
    "ela veio sim, deu certo",
    "o aluno compareceu",
    "não vou conseguir dar a aula", // falta da PROFESSORA — outro fluxo
    "bom dia",
    "quanto eu recebo pela experimental?",
    "",
  ];
  for (const t of nao) {
    assert(!mentionsTrialNoShow(t), `não deveria reconhecer: ${t}`);
  }
});

Deno.test("a mensagem ao lead abre a porta em vez de cobrar", () => {
  const msg = trialNoShowLeadMessage({
    leadName: "Ana Carolina Sena",
    teacherName: "Bruna",
    whenText: "23/09 às 18:30",
  });
  assert(msg.includes("Ana"), msg);
  assert(msg.includes("Bruna"), msg);
  assert(msg.includes("23/09 às 18:30"), msg);
  assert(msg.includes("remarco"), msg);
  assert(!/falt|ausente|perdeu/i.test(msg), "não pode cobrar o lead");
});

Deno.test("o aviso ao canal leva o contato clicável", () => {
  const msg = trialNoShowChannelMessage({
    leadName: "Ana Carolina",
    leadPhone: "5527999884619",
    teacherName: "Bruna",
    whenText: "23/09 às 18:30",
  });
  assert(msg.includes("wa.me/5527999884619"), msg);
  assert(msg.includes("Bruna"), msg);
});
