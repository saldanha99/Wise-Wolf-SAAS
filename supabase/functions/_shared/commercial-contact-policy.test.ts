/// <reference lib="deno.ns" />

import {
  commercialPhonesMatch,
  evaluateCommercialSuppression,
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
