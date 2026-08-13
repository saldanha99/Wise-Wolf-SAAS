/// <reference lib="deno.ns" />

import {
  commercialPhonesMatch,
  distanciaNome,
  evaluateCommercialSuppression,
  provavelSosiaDeAluno,
  type CommercialContactFacts,
} from "./commercial-contact-policy.ts";

const emptyFacts = (): CommercialContactFacts => ({
  students: [], contracts: [], opportunities: [], enrollmentLinks: [],
});

Deno.test("phone matching tolerates Brazilian ninth digit but preserves area code", () => {
  if (!commercialPhonesMatch("+55 (11) 98765-4321", "11 8765-4321")) throw new Error("should match");
  if (commercialPhonesMatch("+55 (12) 98765-4321", "11 8765-4321")) throw new Error("must not cross DDD");
});

Deno.test("terminal CRM lead is never commercially contacted", () => {
  const result = evaluateCommercialSuppression({ tenantId: "t1", phone: "5511987654321", leadStatus: "CONVERTED" }, emptyFacts());
  if (!result.suppressed || result.reason !== "terminal_lead_status") throw new Error("terminal status escaped");
});

Deno.test("accepted contract wins over stale NEW lead", () => {
  const facts = emptyFacts();
  facts.students.push({ id: "student-1", phone: "(11) 98765-4321", contract_accepted: true });
  const result = evaluateCommercialSuppression({ tenantId: "t1", phone: "5511987654321", leadStatus: "NEW" }, facts);
  if (!result.suppressed || result.reason !== "contract_accepted" || result.studentId !== "student-1") throw new Error("contract was ignored");
});

Deno.test("converted opportunity blocks post-trial sales even with stale lead", () => {
  const facts = emptyFacts();
  facts.opportunities.push({ id: "opp-1", student_phone: "11987654321", conversion_status: "WON", student_id: "student-1" });
  const result = evaluateCommercialSuppression({ tenantId: "t1", phone: "5511987654321", opportunityId: "opp-1" }, facts);
  if (!result.suppressed || result.reason !== "opportunity_converted") throw new Error("won opportunity escaped");
});

Deno.test("used enrollment link is completion, not absence of proposal", () => {
  const facts = emptyFacts();
  facts.enrollmentLinks.push({ id: "link-1", opportunity_id: "opp-1", student_phone: "5511987654321", status: "USED" });
  const result = evaluateCommercialSuppression({ tenantId: "t1", phone: "11987654321", opportunityId: "opp-1" }, facts);
  if (!result.suppressed || result.reason !== "enrollment_completed") throw new Error("used link escaped");
});

Deno.test("an unrelated prospect remains contactable", () => {
  const facts = emptyFacts();
  facts.students.push({ id: "student-1", phone: "5511987654321", contract_accepted: true });
  const result = evaluateCommercialSuppression({ tenantId: "t1", phone: "5512987654321", leadStatus: "NEW" }, facts);
  if (result.suppressed) throw new Error("unrelated DDD was suppressed");
});


// ── TRAVA DE SÓSIA ──────────────────────────────────────────────────────────
// Caso real de 13/08/2026: a aluna matriculada Penha Vilani (27 99924792)
// recebeu "ainda tem interesse na aula experimental?" porque o CRM tinha
// "Penha Valani" com 27 999247902 — um dígito de diferença.
const ALUNA_PENHA = {
  id: "aluna-penha", full_name: "Penha Vilani", phone: "2799924792",
  contract_accepted: true,
};

Deno.test("REGRESSÃO: aluna matriculada com telefone divergente NÃO recebe venda", () => {
  const facts = emptyFacts();
  facts.students.push(ALUNA_PENHA);
  const r = evaluateCommercialSuppression(
    { tenantId: "t1", phone: "5527999247902", name: "Penha Valani", leadStatus: "CONTACTED" },
    facts,
  );
  if (!r.suppressed) throw new Error("deveria bloquear a mensagem de venda");
  if (r.reason !== "nome_e_ddd_de_aluno") throw new Error("motivo errado: " + r.reason);
  // Bloqueia sem vincular: semelhança de nome não pode mexer em cadastro.
  if (r.studentId !== null) throw new Error("não pode vincular por semelhança");
});

Deno.test("DDD diferente derruba a trava — homônimo de outro estado é lead de verdade", () => {
  if (provavelSosiaDeAluno({ tenantId: "t1", phone: "5511999247902", name: "Penha Valani" }, ALUNA_PENHA)) {
    throw new Error("não pode bloquear com DDD diferente");
  }
});

Deno.test("nome curto fica fora da regra", () => {
  const aluno = { full_name: "Ana", phone: "2799924792", contract_accepted: true };
  if (provavelSosiaDeAluno({ tenantId: "t1", phone: "27999247902", name: "Ane" }, aluno)) {
    throw new Error("nome curto não pode acionar a trava");
  }
});

Deno.test("nome distante demais não bloqueia", () => {
  if (provavelSosiaDeAluno({ tenantId: "t1", phone: "27999247902", name: "Roberto Carlos" }, ALUNA_PENHA)) {
    throw new Error("nomes diferentes não podem bloquear");
  }
});

Deno.test("acento e caixa não atrapalham a comparação", () => {
  if (distanciaNome("Verônica Souza", "veronica souza") !== 0) throw new Error("deveria ser idêntico");
  if (distanciaNome("Penha Valani", "Penha Vilani") !== 1) throw new Error("distância errada");
});

Deno.test("aluno SEM contrato aceito não aciona a trava de sósia", () => {
  const facts = emptyFacts();
  facts.students.push({ ...ALUNA_PENHA, contract_accepted: false });
  const r = evaluateCommercialSuppression(
    { tenantId: "t1", phone: "5527999247902", name: "Penha Valani" },
    facts,
  );
  if (r.suppressed) throw new Error("interessado ainda não matriculado pode receber venda");
});

Deno.test("casamento por telefone continua tendo precedência e vincula o aluno", () => {
  const facts = emptyFacts();
  facts.students.push(ALUNA_PENHA);
  const r = evaluateCommercialSuppression(
    { tenantId: "t1", phone: "2799924792", name: "Penha Valani" },
    facts,
  );
  if (r.reason !== "contract_accepted") throw new Error("motivo errado: " + r.reason);
  if (r.studentId !== "aluna-penha") throw new Error("deveria vincular pelo telefone");
});


// ── ALUNO SEM A FLAG DE CONTRATO ────────────────────────────────────────────
// Auditoria de 13/08/2026: 8 alunos ativos e pagantes com contract_accepted
// = false, e `student_contracts` vazia. Só não receberam venda porque nenhum
// estava no CRM naquele dia.
Deno.test("REGRESSÃO: aluno com aula/pagamento é aluno, mesmo sem contrato marcado", () => {
  const facts = emptyFacts();
  facts.students.push({ id: "aluno-ativo", full_name: "Nicolas de Sousa Costa", phone: "11999998888", contract_accepted: false });
  facts.studentsWithActivity = ["aluno-ativo"];
  const r = evaluateCommercialSuppression(
    { tenantId: "t1", phone: "11999998888", name: "Nicolas de Sousa Costa" },
    facts,
  );
  if (!r.suppressed) throw new Error("aluno pagante não pode receber venda");
  if (r.reason !== "aluno_em_atividade") throw new Error("motivo errado: " + r.reason);
  if (r.studentId !== "aluno-ativo") throw new Error("deveria vincular: o casamento foi por telefone");
});

Deno.test("interessado SEM aula e SEM pagamento continua sendo lead", () => {
  const facts = emptyFacts();
  facts.students.push({ id: "so-cadastro", full_name: "Fulano de Tal", phone: "11999998888", contract_accepted: false });
  facts.studentsWithActivity = [];
  const r = evaluateCommercialSuppression({ tenantId: "t1", phone: "11999998888" }, facts);
  if (r.suppressed) throw new Error("cadastro sem atividade não pode bloquear a prospecção");
});

Deno.test("a trava de sósia também vale para aluno em atividade sem contrato marcado", () => {
  const facts = emptyFacts();
  facts.students.push({ id: "aluno-ativo", full_name: "Penha Vilani", phone: "2799924792", contract_accepted: false });
  facts.studentsWithActivity = ["aluno-ativo"];
  const r = evaluateCommercialSuppression(
    { tenantId: "t1", phone: "5527999247902", name: "Penha Valani" },
    facts,
  );
  if (r.reason !== "nome_e_ddd_de_aluno") throw new Error("motivo errado: " + r.reason);
});
