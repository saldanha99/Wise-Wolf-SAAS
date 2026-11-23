// Catálogo das ferramentas de IA do Hub, por habilidade (Fase 2, 23/11/2026).
// Fonte única: o front mostra a grade a partir daqui e o `pedagogical-content`
// aplica o preset da ferramenta pelo id (o preset nunca vem do navegador).
// Sem dependência de Deno nem de React: importado pelos dois lados.

export const HUB_TOOL_SKILLS = [
  "reading",
  "vocabulary",
  "speaking",
  "writing",
  "grammar",
] as const;
export type HubToolSkill = typeof HUB_TOOL_SKILLS[number];

export const HUB_TOOL_SKILL_LABEL: Record<HubToolSkill, string> = {
  reading: "Leitura",
  vocabulary: "Vocabulário",
  speaking: "Fala",
  writing: "Escrita",
  grammar: "Gramática",
};

// Campos que o formulário da ferramenta mostra além de nível/nicho/faixa.
export type HubToolField = "topic" | "targetWords" | "sourceText" | "count";

export interface HubTool {
  id: string;
  skill: HubToolSkill;
  // Tipo de saída do motor (`HUB_MATERIAL_KINDS` em hub-material.ts).
  kind: string;
  name: string;
  summary: string;
  // Como usar, em pt-BR, mostrado no formulário.
  howTo: string;
  fields: HubToolField[];
  // Quantidade padrão de itens (o professor pode mudar quando `count` está nos campos).
  defaultCount: number;
  // Instrução extra que o servidor põe no prompt. Nunca vem do navegador.
  preset: string;
  sourceTextRequired?: boolean;
  topicPlaceholder?: string;
}

export const HUB_TOOLS: readonly HubTool[] = [
  // ── Leitura ──
  {
    id: "reading-target-vocab",
    skill: "reading",
    kind: "reading",
    name: "Texto com o vocabulário que você escolher",
    summary: "Um texto no nível do aluno usando as palavras que você listar.",
    howTo:
      "Escreva o tema e as palavras que o texto precisa usar (separadas por vírgula). Sai o texto com glossário, perguntas e estratégias de leitura.",
    fields: ["topic", "targetWords", "count"],
    defaultCount: 5,
    preset:
      "Texto de leitura que usa TODAS as palavras do vocabulário obrigatório de forma natural; destaque o uso delas nas perguntas.",
    topicPlaceholder: "Ex.: primeiro dia num emprego novo",
  },
  {
    id: "reading-your-text",
    skill: "reading",
    kind: "text_questions",
    name: "Perguntas sobre um texto seu",
    summary: "Cole um texto e receba perguntas de compreensão com gabarito.",
    howTo:
      "Cole o texto (notícia, e-mail, trecho de livro). As perguntas e o glossário saem sobre ele; o texto não é reescrito.",
    fields: ["topic", "sourceText", "count"],
    defaultCount: 6,
    preset:
      "Perguntas que cobrem ideia geral, detalhe, vocabulário no contexto e inferência, nessa ordem.",
    sourceTextRequired: true,
    topicPlaceholder: "Ex.: notícia sobre trabalho remoto",
  },
  {
    id: "reading-true-false",
    skill: "reading",
    kind: "true_false",
    name: "Verdadeiro ou falso",
    summary: "Afirmações para o aluno julgar, sobre um texto seu ou gerado.",
    howTo:
      "Cole um texto ou deixe em branco para gerar um sobre o tema. Cada afirmação vem com a explicação que cita o trecho.",
    fields: ["topic", "sourceText", "count"],
    defaultCount: 8,
    preset:
      "Afirmações falsas plausíveis (troca de detalhe, de número ou de quem fez o quê), nunca absurdas.",
    topicPlaceholder: "Ex.: a rotina de um chef de cozinha",
  },
  {
    id: "reading-main-idea",
    skill: "reading",
    kind: "reading",
    name: "Ideia principal e resumo",
    summary: "Leitura com foco em achar a ideia principal e resumir.",
    howTo:
      "Escreva o tema. As perguntas treinam ideia principal, título, resumo em uma frase e intenção do autor.",
    fields: ["topic", "sourceText", "count"],
    defaultCount: 5,
    preset:
      "As perguntas de compreensão treinam ideia principal, melhor título, resumo em uma frase e intenção do autor (não detalhes isolados).",
    topicPlaceholder: "Ex.: por que dormimos menos hoje",
  },
  // ── Vocabulário ──
  {
    id: "vocab-cards",
    skill: "vocabulary",
    kind: "vocab_cards",
    name: "Cartões de vocabulário",
    summary: "Termo, tradução, definição e exemplo no contexto do aluno.",
    howTo:
      "Escreva o tema ou liste as palavras. Bom para revisar antes da aula ou montar flashcards.",
    fields: ["topic", "targetWords", "count"],
    defaultCount: 10,
    preset:
      "Se houver vocabulário obrigatório, os cartões são exatamente essas palavras; senão, as mais úteis do tema no nível.",
    topicPlaceholder: "Ex.: entrevista de emprego",
  },
  {
    id: "vocab-matching",
    skill: "vocabulary",
    kind: "matching",
    name: "Associação palavra–definição",
    summary: "Duas colunas para ligar, com gabarito.",
    howTo:
      'Escreva o tema ou as palavras. Peça em "instruções extras" se quiser tradução em vez de definição.',
    fields: ["topic", "targetWords", "count"],
    defaultCount: 8,
    preset: "Definições curtas, no nível, sem repetir a palavra definida.",
    topicPlaceholder: "Ex.: verbos de escritório",
  },
  {
    id: "vocab-gap-fill",
    skill: "vocabulary",
    kind: "gap_fill",
    name: "Lacunas com banco de palavras",
    summary: "Frases com lacuna e as palavras para escolher.",
    howTo:
      "Escreva o tema ou liste as palavras que devem cair nas lacunas. O banco já vem com 2 palavras extras para despistar.",
    fields: ["topic", "targetWords", "sourceText", "count"],
    defaultCount: 8,
    preset:
      "Se houver vocabulário obrigatório, cada resposta é uma dessas palavras; se houver texto-base, as frases saem dele.",
    topicPlaceholder: "Ex.: fazer check-in no hotel",
  },
  {
    id: "vocab-false-friends",
    skill: "vocabulary",
    kind: "error_correction",
    name: "Falsos cognatos e erros de brasileiro",
    summary: "Frases com os erros que o brasileiro mais comete, para corrigir.",
    howTo:
      "Escreva o tema. Sai uma lista de frases com o erro típico (pretend, actually, push…) e a explicação do porquê.",
    fields: ["topic", "count"],
    defaultCount: 8,
    preset:
      "Foque em falsos cognatos e em vocabulário traduzido ao pé da letra do português (ex.: pretend, actually, assist, push, library, parents, make x do).",
    topicPlaceholder: "Ex.: falsos cognatos no trabalho",
  },
  // ── Fala ──
  {
    id: "speaking-discussion",
    skill: "speaking",
    kind: "discussion",
    name: "Perguntas de discussão",
    summary: "Perguntas abertas com aprofundamento e frases para opinar.",
    howTo:
      'Escreva o tema. Use para os 10–15 minutos de conversa da aula; cada pergunta tem um "e se…" para o aluno ir além.',
    fields: ["topic", "count"],
    defaultCount: 8,
    preset:
      "Perguntas que pedem experiência pessoal e opinião, nunca de sim/não.",
    topicPlaceholder: "Ex.: redes sociais e saúde mental",
  },
  {
    id: "speaking-roleplay",
    skill: "speaking",
    kind: "conversation",
    name: "Diálogo e roleplay",
    summary: "Situação, papéis, frases úteis e diálogo-modelo.",
    howTo:
      "Escreva a situação (reunião, consulta, restaurante). O aluno lê o modelo, faz o shadowing e depois improvisa.",
    fields: ["topic", "count"],
    defaultCount: 8,
    preset: "",
    topicPlaceholder: "Ex.: reclamar de um pedido errado",
  },
  {
    id: "speaking-situation-cards",
    skill: "speaking",
    kind: "discussion",
    name: "Cartões de situação e debate",
    summary: "Situações para defender ponto de vista, negociar e argumentar.",
    howTo:
      "Escreva o tema polêmico ou a situação. Bom para B1 em diante e para preparar entrevistas.",
    fields: ["topic", "count"],
    defaultCount: 6,
    preset:
      "Dê prioridade aos situation_cards (gere 4) com papéis opostos para debate; as perguntas trazem prós e contras.",
    topicPlaceholder: "Ex.: semana de 4 dias de trabalho",
  },
  // ── Escrita ──
  {
    id: "writing-prompt",
    skill: "writing",
    kind: "writing_prompt",
    name: "Proposta de redação com rubrica",
    summary: "Tarefa, critérios de correção e um texto-modelo.",
    howTo:
      "Escreva o gênero e o tema (opinião, história, relatório). A rubrica serve para você corrigir e para o aluno se autoavaliar.",
    fields: ["topic", "count"],
    defaultCount: 6,
    preset: "",
    topicPlaceholder: "Ex.: texto de opinião sobre home office",
  },
  {
    id: "writing-email",
    skill: "writing",
    kind: "writing_prompt",
    name: "E-mail ou mensagem modelo",
    summary: "Uma tarefa de e-mail real com modelo e expressões prontas.",
    howTo:
      "Diga para quem e para quê (pedir prazo, reclamar, apresentar-se). Sai a tarefa, o modelo e as expressões de abertura e fechamento.",
    fields: ["topic", "count"],
    defaultCount: 8,
    preset:
      "A tarefa é um e-mail ou mensagem de trabalho/vida real; useful_language traz abertura, pedido, fechamento e assinatura no registro certo.",
    topicPlaceholder: "Ex.: pedir mais prazo ao cliente",
  },
  {
    id: "writing-error-correction",
    skill: "writing",
    kind: "error_correction",
    name: "Correção de erros",
    summary: "Frases com erros de gramática típicos para o aluno corrigir.",
    howTo:
      "Escreva o tema ou o ponto gramatical. Cada frase tem um erro só, a correção e a explicação em português.",
    fields: ["topic", "count"],
    defaultCount: 10,
    preset:
      "Foque em erros de gramática do nível (tempo verbal, preposição, ordem, artigos, -s da 3ª pessoa).",
    topicPlaceholder: "Ex.: present perfect x past simple",
  },
  // ── Gramática ──
  {
    id: "grammar-drill",
    skill: "grammar",
    kind: "grammar_drill",
    name: "Drill de gramática",
    summary: "Regra em português, exemplos e exercícios de lacuna.",
    howTo:
      "Escreva o ponto gramatical ou o tema. A regra vem curta e os exercícios têm uma resposta certa só.",
    fields: ["topic", "count"],
    defaultCount: 8,
    preset: "",
    topicPlaceholder: "Ex.: comparativos",
  },
  {
    id: "grammar-quiz",
    skill: "grammar",
    kind: "quiz",
    name: "Quiz de múltipla escolha",
    summary: "Perguntas com 4 alternativas e explicação de cada resposta.",
    howTo:
      "Escreva o tema ou o ponto. Bom para revisão rápida no início ou fim da aula.",
    fields: ["topic", "count"],
    defaultCount: 8,
    preset: "",
    topicPlaceholder: "Ex.: revisão de past simple",
  },
  {
    id: "grammar-transformation",
    skill: "grammar",
    kind: "sentence_transformation",
    name: "Transformação de frases",
    summary: "Reescrever frases usando a estrutura pedida.",
    howTo:
      "Escreva a estrutura (voz passiva, condicional, reported speech). Formato de prova de Cambridge, com gabarito.",
    fields: ["topic", "count"],
    defaultCount: 8,
    preset: "",
    topicPlaceholder: "Ex.: voz passiva",
  },
];

const BY_ID = new Map(HUB_TOOLS.map((tool) => [tool.id, tool]));

export function findHubTool(id: unknown): HubTool | null {
  return typeof id === "string" ? BY_ID.get(id) ?? null : null;
}

export function hubToolsBySkill(): Record<HubToolSkill, HubTool[]> {
  const grouped = Object.fromEntries(
    HUB_TOOL_SKILLS.map((skill) => [skill, [] as HubTool[]]),
  ) as Record<HubToolSkill, HubTool[]>;
  for (const tool of HUB_TOOLS) grouped[tool.skill].push(tool);
  return grouped;
}
