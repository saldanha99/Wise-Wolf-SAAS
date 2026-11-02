/// <reference lib="deno.ns" />
// Regras puras das sugestões do cartão: lista de exclusão, citação conferida
// contra a fonte, campos por idade e o schema estrito. Sem rede, sem banco.
import {
  ALL_CARD_FIELDS,
  estimateSuggestionCost,
  foldForMatch,
  MINOR_CARD_FIELDS,
  normalizeSuggestions,
  quoteInSource,
  speakerNames,
  suggestionInstructions,
  suggestionJsonSchema,
  suggestionMessages,
  suggestionsModelId,
  textBlocked,
} from "./core.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
const equal = (actual: unknown, expected: unknown, message: string) =>
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`,
  );

const TRANSCRIPT = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "TRANSCRIPT",
  provider_name: "conferenceRecords/a/transcripts/t",
  source_text: [
    "[10:00:01] Aluno Adulto: I want to present my results in meetings with the US team.",
    "[10:00:20] Aluno Adulto: I love talking about football and science fiction series.",
    "[10:00:40] Aluno Adulto: Please correct me only at the end, I lose my train of thought.",
    "[10:01:00] Aluno Adulto: My mother is sick and I am worried.",
    "[10:01:30] Aluno Adulto: Please do not spoil the series for me.",
    "[10:01:45] Joana Prado: Hi, I am the teacher today.",
  ].join("\n"),
};
const NOTES = {
  id: "22222222-2222-4222-8222-222222222222",
  kind: "SMART_NOTES",
  provider_name: "conferenceRecords/a/smartNotes/n",
  source_text: "Resumo\nO aluno quer viajar para o Canadá no ano que vem.",
};

Deno.test("dobra: minúsculas, sem acento, só letras e números", () => {
  equal(
    foldForMatch("  Mãe, SAÚDE & política!! R$ 200 "),
    "mae saude politica r 200",
    "texto dobrado errado",
  );
});

Deno.test("lista de exclusão: saúde, religião, política, família, dinheiro, terceiros", () => {
  for (
    const blocked of [
      "Minha mãe está doente",
      "My mother is sick and I am worried.",
      "Conversar sobre religião",
      "I pray every day",
      "as eleições do ano",
      "quer aumentar o salário",
      "ansiedade antes das provas",
      "viajar com o namorado",
      "meu amigo João gosta de rock",
      "o chefe dele cobra inglês",
      "my boyfriend lives in Dublin",
      "orientação sexual",
      "I have two kids",
    ]
  ) assert(textBlocked(blocked), `passou pela lista: ${blocked}`);
});

Deno.test("lista de exclusão: namoro, luto, doença e droga que o prompt proíbe também caem", () => {
  // O prompt classifica namoro como família e proíbe saúde; a lista por
  // palavras tinha só "namorad*" e deixava "namoro"/"dating" passar.
  for (
    const blocked of [
      "namoro",
      "Please, I don't want to talk about dating anymore.",
      "não gosta de falar de namoro",
      "relacionamentos",
      "My relationship ended last month.",
      "we broke up",
      "after the breakup",
      "HIV",
      "Covid-19",
      "a morte do cachorro",
      "My dog died last week.",
      "my grandma passed away",
      "está de luto",
      "funerals",
      "falecimento",
      "alcohol",
      "álcool",
      "drogas",
      "drugs",
      "rehab",
    ]
  ) assert(textBlocked(blocked), `passou pela lista: ${blocked}`);
  // A sugestão do caso real (valor "namoro", citação com "dating") é descartada.
  const source = {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "TRANSCRIPT",
    provider_name: "conferenceRecords/a/transcripts/t",
    imported_at: "2026-09-26T10:00:00Z",
    source_text:
      "[10:00:01] Aluno: Please, I don't want to talk about dating anymore.",
  };
  const result = normalizeSuggestions(
    {
      suggestions: [{
        field: "avoid_topics",
        value: "namoro",
        artifact_id: source.id,
        quote: "Please, I don't want to talk about dating anymore.",
      }],
    },
    [source],
    ["avoid_topics"],
    [],
  );
  assert(
    result.kept.length === 0 && result.reasons.blocked === 1,
    JSON.stringify(result),
  );
});

Deno.test("lista de exclusão: identificadores e nomes de pessoas da aula", () => {
  assert(textBlocked("ligar para 11 98765-4321"), "telefone passou");
  assert(textBlocked("fulano@exemplo.com"), "e-mail passou");
  assert(textBlocked("custa R$ 200"), "valor em dinheiro passou");
  assert(textBlocked("veja em www.exemplo.com"), "site passou");
  assert(textBlocked("segue @perfil_do_aluno"), "perfil passou");
  assert(
    textBlocked("Conversar com a Bruna", ["Bruna Souza"]),
    "nome de pessoa da aula passou",
  );
  assert(
    !textBlocked("Conversar sobre futebol", ["Bruna Souza"]),
    "nome bloqueou texto sem nome",
  );
  assert(
    !textBlocked("aulas com a professora", ["Professora Joana"]),
    "título (professora) virou nome",
  );
});

Deno.test("lista de exclusão: texto pedagógico comum passa", () => {
  for (
    const allowed of [
      "Apresentar resultados em reuniões com o time dos EUA",
      "futebol",
      "séries de ficção científica",
      "[10:00:01] Aluno Adulto: I love football.",
      "motherboard e hardware",
      "painting and drawing",
      "professor pediu roleplay",
      "turn left at the corner",
      "Please correct me only at the end, I lose my train of thought.",
    ]
  ) assert(!textBlocked(allowed), `bloqueou texto pedagógico: ${allowed}`);
});

Deno.test("citação: literal ou com espaços colapsados; inventada não", () => {
  assert(
    quoteInSource(
      "correct me   only at the end",
      "[10:00:40] Aluno: Please correct me\nonly at the end.",
    ),
    "citação com quebra de linha não conferiu",
  );
  assert(
    !quoteInSource("I hate grammar drills", TRANSCRIPT.source_text),
    "citação que não está na aula conferiu",
  );
  assert(!quoteInSource("", TRANSCRIPT.source_text), "citação vazia conferiu");
});

Deno.test("rótulos de quem falou saem da transcrição (não das anotações)", () => {
  equal(
    speakerNames([TRANSCRIPT, NOTES]).sort(),
    ["Aluno Adulto", "Joana Prado"],
    "rótulos da transcrição errados",
  );
});

Deno.test("conferência: guarda o que tem frase da aula, descarta o resto", () => {
  const names = ["Aluno Adulto", "Joana Prado"];
  const result = normalizeSuggestions(
    {
      suggestions: [
        {
          field: "real_goal",
          value: "  Apresentar resultados   em reuniões ",
          artifact_id: TRANSCRIPT.id,
          quote: "I want to present my results in meetings with the US team.",
        },
        {
          field: "engaging_topics",
          value: "futebol",
          artifact_id: TRANSCRIPT.id,
          quote: "I love talking about football and science fiction series.",
        },
        {
          field: "correction_style",
          value: "END",
          artifact_id: TRANSCRIPT.id,
          quote: "Please correct me only at the end",
        },
        {
          field: "engaging_topics",
          value: "viagens",
          artifact_id: NOTES.id,
          quote: "O aluno quer viajar para o Canadá no ano que vem.",
        },
        // Família/saúde na citação, valor limpo.
        {
          field: "avoid_topics",
          value: "assuntos pessoais",
          artifact_id: TRANSCRIPT.id,
          quote: "My mother is sick and I am worried.",
        },
        // Citação que não está na fonte.
        {
          field: "avoid_topics",
          value: "gramática",
          artifact_id: TRANSCRIPT.id,
          quote: "I hate grammar drills so much.",
        },
        // Citação da fonte ERRADA (a frase é da transcrição).
        {
          field: "engaging_topics",
          value: "séries",
          artifact_id: NOTES.id,
          quote: "I love talking about football and science fiction series.",
        },
        // Nome de quem falou no valor.
        {
          field: "engaging_topics",
          value: "aulas com a Joana",
          artifact_id: TRANSCRIPT.id,
          quote: "I love talking about football and science fiction series.",
        },
        // Estilo fora da lista.
        {
          field: "correction_style",
          value: "gentle",
          artifact_id: TRANSCRIPT.id,
          quote: "Please correct me only at the end",
        },
        // Repetida.
        {
          field: "engaging_topics",
          value: "Futebol",
          artifact_id: TRANSCRIPT.id,
          quote: "I love talking about football and science fiction series.",
        },
        // Campo que não existe no cartão.
        {
          field: "notes",
          value: "observação",
          artifact_id: TRANSCRIPT.id,
          quote: "Please do not spoil the series for me.",
        },
        // Tema longo demais.
        {
          field: "avoid_topics",
          value: "x".repeat(61),
          artifact_id: TRANSCRIPT.id,
          quote: "Please do not spoil the series for me.",
        },
      ],
    },
    [TRANSCRIPT, NOTES],
    ALL_CARD_FIELDS,
    names,
  );
  equal(
    result.kept.map((item) => [item.field, item.value]),
    [
      ["real_goal", "Apresentar resultados em reuniões"],
      ["engaging_topics", "futebol"],
      ["correction_style", "end"],
      ["engaging_topics", "viagens"],
    ],
    "sugestões guardadas erradas",
  );
  equal(result.dropped, 8, "contagem de descartadas");
  equal(
    result.reasons,
    {
      blocked: 2,
      evidence: 2,
      value: 2,
      duplicate: 1,
      field: 1,
    },
    "motivos de descarte",
  );
  assert(
    result.kept.every((item) =>
      [TRANSCRIPT, NOTES].some((source) =>
        source.id === item.artifact_id &&
        quoteInSource(item.quote, source.source_text)
      )
    ),
    "sugestão guardada sem a frase da aula",
  );
});

Deno.test("menor: só objetivo e temas, mesmo que a IA devolva outro campo", () => {
  const result = normalizeSuggestions(
    {
      suggestions: [
        {
          field: "correction_style",
          value: "end",
          artifact_id: TRANSCRIPT.id,
          quote: "Please correct me only at the end",
        },
        {
          field: "avoid_topics",
          value: "spoilers",
          artifact_id: TRANSCRIPT.id,
          quote: "Please do not spoil the series for me.",
        },
        {
          field: "engaging_topics",
          value: "futebol",
          artifact_id: TRANSCRIPT.id,
          quote: "I love talking about football and science fiction series.",
        },
      ],
    },
    [TRANSCRIPT],
    MINOR_CARD_FIELDS,
    [],
  );
  equal(
    result.kept.map((item) => item.field),
    ["engaging_topics"],
    "menor ganhou campo pessoal",
  );
  equal(result.reasons, { field: 2 }, "motivo do descarte do menor");
});

Deno.test("no máximo 8 guardadas; resposta fora do formato reprova a leitura", () => {
  const many = Array.from({ length: 10 }, (_, index) => ({
    field: "engaging_topics",
    value: `tema ${index}`,
    artifact_id: TRANSCRIPT.id,
    quote: "I love talking about football and science fiction series.",
  }));
  const result = normalizeSuggestions(
    { suggestions: many },
    [TRANSCRIPT],
    ALL_CARD_FIELDS,
    [],
  );
  equal(result.kept.length, 8, "passou do teto de 8");
  equal(result.reasons, { limit: 2 }, "motivo do teto");
  let failed = "";
  try {
    normalizeSuggestions({ items: [] }, [TRANSCRIPT], ALL_CARD_FIELDS, []);
  } catch (error) {
    failed = error instanceof Error ? error.message : "";
  }
  equal(failed, "card_suggestions_response_invalid", "formato errado passou");
});

Deno.test("schema estrito: o campo é enum só com os permitidos", () => {
  const schema = suggestionJsonSchema(MINOR_CARD_FIELDS) as {
    additionalProperties: boolean;
    required: string[];
    properties: {
      suggestions: {
        items: {
          additionalProperties: boolean;
          required: string[];
          properties: { field: { enum: string[] } };
        };
      };
    };
  };
  equal(schema.required, ["suggestions"], "raiz sem required");
  assert(schema.additionalProperties === false, "raiz aceita chave extra");
  const item = schema.properties.suggestions.items;
  assert(item.additionalProperties === false, "item aceita chave extra");
  equal(
    item.required,
    ["field", "value", "artifact_id", "quote"],
    "item sem required completo",
  );
  equal(
    item.properties.field.enum,
    ["real_goal", "engaging_topics"],
    "menor com enum de campos pessoais",
  );
});

Deno.test("instruções: proíbem o sensível, avisam menor e isolam a aula", () => {
  const adult = suggestionInstructions(ALL_CARD_FIELDS, false);
  const minor = suggestionInstructions(MINOR_CARD_FIELDS, true);
  for (
    const word of [
      "saúde",
      "religião",
      "política",
      "família",
      "dinheiro",
      "outras pessoas",
      "dados não confiáveis",
      "quote",
    ]
  ) assert(adult.includes(word), `instrução sem "${word}"`);
  assert(adult.includes("correction_style"), "adulto sem estilo de correção");
  assert(
    minor.includes("menor de idade") && !minor.includes("correction_style:"),
    "instrução do menor pede campo pessoal",
  );
  const messages = suggestionMessages([TRANSCRIPT], ALL_CARD_FIELDS, false);
  assert(
    messages[1].content.startsWith("<artefatos>") &&
      messages[1].content.endsWith("</artefatos>"),
    "aula fora do bloco de dados",
  );
  assert(
    !messages[0].content.includes("present my results"),
    "texto da aula na instrução",
  );
});

Deno.test("estimativa arredonda para cima; modelo cai no do resumo", () => {
  const estimate = estimateSuggestionCost(3000, {
    input_usd_per_1m: 0.3,
    output_usd_per_1m: 2.5,
    cached_usd_per_1m: 0.03,
  });
  equal(estimate.inputTokens, 1000, "tokens de entrada");
  // 1000 × 0,3 + 3000 × 2,5 = 7.800 micro-dólares.
  equal(estimate.usd, 0.0078, "estimativa");
  equal(
    suggestionsModelId("", "openai/gpt-5-mini"),
    "openai/gpt-5-mini",
    "não caiu no modelo do resumo",
  );
  equal(
    suggestionsModelId("", ""),
    "google/gemini-3.6-flash",
    "sem modelo nenhum, o padrão do resumo",
  );
  equal(
    suggestionsModelId("google/gemini-3.6-flash:free", ""),
    null,
    "variante gratuita (treina com o conteúdo) aceita",
  );
});
