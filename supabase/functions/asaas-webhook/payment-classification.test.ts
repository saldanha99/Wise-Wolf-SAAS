/// <reference lib="deno.ns" />

import { assertEquals } from "jsr:@std/assert@1";
import { classifyStudentPaymentType } from "./payment-classification.ts";

Deno.test("classifies enrollment fee from its idempotency reference", () => {
  assertEquals(
    classifyStudentPaymentType(
      "",
      "enrollment:00000000-0000-4000-8000-000000000001:fee",
    ),
    "ENROLLMENT",
  );
});

Deno.test("classifies enrollment fee from an unaccented description", () => {
  assertEquals(
    classifyStudentPaymentType("Taxa de Matricula Wise Wolf School", ""),
    "ENROLLMENT",
  );
});

Deno.test("classifies pro-rata and ordinary subscription payments", () => {
  assertEquals(
    classifyStudentPaymentType(
      "Pro-rata - Wise Wolf School",
      "enrollment:00000000-0000-4000-8000-000000000001:pro-rata",
    ),
    "PRO_RATA",
  );
  assertEquals(
    classifyStudentPaymentType(
      "Mensalidade Wise Wolf School - Plano Anual",
      "enrollment:00000000-0000-4000-8000-000000000001:subscription",
    ),
    "SUBSCRIPTION",
  );
});
