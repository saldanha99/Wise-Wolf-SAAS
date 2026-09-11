import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isStudentBillingMethodChangeIntent,
  studentBillingMethodChangeReply,
} from "./billing-method-intent.ts";

Deno.test("detecta pedidos de troca de forma de pagamento com variações reais", () => {
  const pedidosReais = [
    "Quero trocar minha forma de pagamento",
    "Gostaria de mudar minha forma de pagamento para cartão",
    "Como faço para mudar de pix para cartão de crédito?",
    "Posso cadastrar meu cartão de crédito?",
    "Tem como colocar no cartão em vez de pix?",
    "Queria passar para cartão recorrente",
    "Da pra mudar a forma de pagamento?",
    "Quero cadastrar cartão para as mensalidades",
    "Como faço pra pagar com cartão?",
    "Quero trocar o pix por cartão de crédito",
    "Tem como trocar a forma de pagamento?",
    "Quero mudar pro cartão",
    "Posso pagar no cartão?",
    "Gostaria de cadastrar meu cartão",
    "Tem opção de cartão recorrente?",
    "ola boa tarde queria ver como faco pra trocar de pix pra cartao",
    "posso pagar as mensalidades no cartao em vez de pix",
    "onde eu cadastro meu cartao de credito?",
    "quero passar a mensalidade pro cartao",
    "tem como mudar o pagamento pra cartao",
    "quero alterar a forma de pagamento das minhas aulas",
  ];

  for (const frase of pedidosReais) {
    assertEquals(
      isStudentBillingMethodChangeIntent(frase),
      true,
      `Deveria detectar: "${frase}"`,
    );
  }
});

Deno.test("ignora mensagens que NÃO são pedidos de troca de pagamento", () => {
  const outrasMensagens = [
    "Oi, bom dia!",
    "Já paguei a mensalidade de agosto",
    "Mandei o pix do mês",
    "Segue o comprovante de pagamento",
    "Qual é o horário da minha aula hoje?",
    "O professor avisou que vai atrasar?",
    "Quero remarcar minha aula de amanhã",
    "Quanto custa o plano anual?",
    "Vocês aceitam crianças de 8 anos?",
    "Qual é a matéria da aula de ontem?",
    "Não vou conseguir entrar na aula hoje",
  ];

  for (const frase of outrasMensagens) {
    assertEquals(
      isStudentBillingMethodChangeIntent(frase),
      false,
      `NÃO deveria detectar como troca: "${frase}"`,
    );
  }
});

Deno.test("gera resposta personalizada com links e orientações de segurança", () => {
  const reply = studentBillingMethodChangeReply({
    studentName: "Gabriela Valani Giuriato",
    portalUrl: "https://system.wisewolflanguage.com.br",
  });

  assertStringIncludes(reply, "Oi, Gabriela!");
  assertStringIncludes(reply, "https://system.wisewolflanguage.com.br");
  assertStringIncludes(reply, "Financeiro");
  assertStringIncludes(reply, "Forma de pagamento");
  assertStringIncludes(reply, "Cartão de crédito");
  assertStringIncludes(reply, "nunca envie o número, validade ou código");
  assertStringIncludes(reply, "próximas mensalidades");
  assertStringIncludes(reply, "processada na hora");
});
