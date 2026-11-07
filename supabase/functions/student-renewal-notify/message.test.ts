import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { renewalCondition, renewalMessage } from "./message.ts";

const base = {
  recipient_name: "  Aluna  Sintetica ",
  student_name: " Aluna  Sintetica Renovacao",
  term_months: 12,
  monthly_fee_cents: 18700,
  classes_per_week: 3,
  contract_start: "2027-02-17",
  service_end_date: "2028-02-17",
};

Deno.test("parcelada mantém o texto de sempre, com o prazo da oferta", () => {
  assertEquals(
    renewalCondition({ ...base, term_months: 6 }),
    "6 meses, R$ 187,00 por mês e 3 aulas por semana",
  );
});

Deno.test("pagamento integral no Asaas diz o total e a mensalidade equivalente", () => {
  assertEquals(
    renewalCondition({
      ...base,
      billing_strategy: "UPFRONT_CHARGE",
      upfront_total_cents: 224400,
    }),
    "12 meses, pagamento único de R$ 2.244,00 (R$ 187,00 por mês) e 3 aulas por semana",
  );
});

Deno.test("recebido por fora não pede pagamento nenhum", () => {
  const text = renewalCondition({
    ...base,
    billing_strategy: "UPFRONT_EXTERNAL",
    upfront_total_cents: 224400,
  });
  assertStringIncludes(text, "já recebido pela escola");
  assertStringIncludes(text, "R$ 2.244,00");
});

Deno.test("mensagem completa arruma espaços do cadastro e leva o link e as datas", () => {
  const message = renewalMessage(
    base,
    "https://portal.example/renovar-curso?token=a",
  );
  assertStringIncludes(message, "Olá, Aluna Sintetica!");
  assertStringIncludes(
    message,
    "curso de Aluna Sintetica Renovacao está pronta",
  );
  assertStringIncludes(message, "Vigência: 17/02/2027 a 17/02/2028");
  assertStringIncludes(message, "https://portal.example/renovar-curso?token=a");
});
