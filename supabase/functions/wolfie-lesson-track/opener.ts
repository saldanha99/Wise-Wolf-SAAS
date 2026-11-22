// Abertura personalizada do tutor (pedido do Vinícius, 22/11/2026).
//
// UMA frase: chama o aluno pelo PRIMEIRO nome (como está no perfil) e retoma o
// último assunto da aula aprovada; sem aula, só o nome e o objetivo dele. Nunca
// cita erro nem nota. Com aula, a frase é gerada pela IA 1x por aula (cache em
// wolfie_openers); sem aula, ou se a IA falhar, sai de moldes naturais variados.
// White label: o texto não diz o nome do tutor; a tela usa o de tenants.branding.

export interface OpenerLesson {
  classDate: string | null; // YYYY-MM-DD
  topic: string; // tema/objetivo da aula, em linguagem natural
  context: string; // o que foi praticado / rotina (curto)
}

const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

/** Primeiro nome com a grafia do perfil (sem forçar maiúsculas/minúsculas). */
export function firstNameOf(fullName: unknown): string {
  const first = String(fullName ?? "").trim().split(/\s+/)[0] ?? "";
  return /^[\p{L}][\p{L}'’-]{0,39}$/u.test(first) ? first : "";
}

/** "Hoje", "Ontem", "Na terça", "No sábado" ou "Na sua última aula" (mais de 6 dias). */
export function whenPhrase(classDate: string | null, today: string): string {
  if (!classDate || !/^\d{4}-\d{2}-\d{2}$/.test(classDate)) return "Na sua última aula";
  const day = Date.parse(`${classDate}T12:00:00Z`);
  const now = Date.parse(`${today}T12:00:00Z`);
  const diff = Math.round((now - day) / 86_400_000);
  if (diff === 0) return "Hoje";
  if (diff === 1) return "Ontem";
  if (diff < 0 || diff > 6) return "Na sua última aula";
  const weekday = WEEKDAYS[new Date(day).getUTCDay()];
  return weekday === "sábado" || weekday === "domingo" ? `No ${weekday}` : `Na ${weekday}`;
}

function seedIndex(seed: string, size: number): number {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % size;
}

const LESSON_TEMPLATES = [
  (n: string, w: string, t: string) => `Oi, ${n}! ${w} você praticou ${t}. Bora usar isso hoje?`,
  (n: string, w: string, t: string) => `E aí, ${n}! ${w} a aula foi sobre ${t}. Vamos colocar isso na prática agora?`,
  (n: string, w: string, t: string) => `Olá, ${n}! ${w} você trabalhou ${t}. Que tal treinar mais um pouco?`,
  (n: string, w: string, t: string) => `Oi, ${n}! ${w} vimos ${t}. Vamos falar disso de novo para fixar?`,
  (n: string, w: string, t: string) => `${n}, que bom te ver! ${w} você praticou ${t}. Bora continuar daí?`,
  (n: string, w: string, t: string) => `Oi, ${n}! ${w} foi dia de ${t}. Vamos usar isso numa conversa?`,
];

const GOAL_TEMPLATES = [
  (n: string, g: string) => `Oi, ${n}! Bora dar mais um passo no inglês para ${g}?`,
  (n: string, g: string) => `E aí, ${n}! Vamos treinar o inglês que você vai usar para ${g}?`,
  (n: string, g: string) => `Olá, ${n}! Pronto para praticar o inglês de ${g} hoje?`,
  (n: string, g: string) => `${n}, que bom te ver! Vamos conversar pensando em ${g}?`,
  (n: string, g: string) => `Oi, ${n}! Hoje a prática é pensando em ${g}. Bora?`,
  (n: string, g: string) => `E aí, ${n}! Que tal uma conversa rápida rumo a ${g}?`,
];

const GENERIC_TEMPLATES = [
  (n: string) => `Oi, ${n}! Bora praticar um pouco de inglês hoje?`,
  (n: string) => `E aí, ${n}! Vamos conversar em inglês por alguns minutos?`,
  (n: string) => `Olá, ${n}! Pronto para mais uma conversa em inglês?`,
];

function clip(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim().replace(/[.!?;:,]+$/, "");
  if (clean.length <= max) return clean;
  return clean.slice(0, max).replace(/\s+\S*$/, "").trim();
}

function lowerFirst(value: string): string {
  // "Present perfect" → "present perfect"; mantém siglas ("IELTS").
  return /^[A-ZÀ-Ý][a-zà-ÿ]/.test(value) ? value[0].toLowerCase() + value.slice(1) : value;
}

/** Abertura sem IA. `seed` varia o molde por aula/dia, para não soar robótico. */
export function templateOpener(input: {
  firstName: string;
  lesson: OpenerLesson | null;
  goal: string;
  today: string;
  seed: string;
}): string {
  const name = input.firstName;
  let text: string;
  if (input.lesson && clip(input.lesson.topic, 90)) {
    const pick = LESSON_TEMPLATES[seedIndex(input.seed, LESSON_TEMPLATES.length)];
    text = pick(name, whenPhrase(input.lesson.classDate, input.today), lowerFirst(clip(input.lesson.topic, 90)));
  } else if (clip(input.goal, 70)) {
    text = GOAL_TEMPLATES[seedIndex(input.seed, GOAL_TEMPLATES.length)](name, lowerFirst(clip(input.goal, 70)));
  } else {
    text = GENERIC_TEMPLATES[seedIndex(input.seed, GENERIC_TEMPLATES.length)](name);
  }
  // Perfil sem primeiro nome utilizável: tira a vírgula órfã ("Oi, !" → "Oi!").
  return name ? text : text.replace(/^(Oi|Olá|E aí), !/, "$1!").replace(/^, que bom te ver!/, "Que bom te ver!");
}

export const OPENER_SYSTEM_PROMPT = [
  "Você escreve a primeira frase de um tutor de inglês para um aluno brasileiro, em português do Brasil.",
  "Responda só JSON: {\"opener\": \"...\"}.",
  "Regras: UMA frase curta (até 180 caracteres), calorosa e natural, começando pelo primeiro nome do aluno",
  "exatamente como foi dado (ex.: \"Oi, Mariana!\"). Retome o assunto da última aula com o quando informado",
  "(ex.: \"Na terça você praticou o present perfect falando das suas viagens\") e termine convidando a usar",
  "isso hoje. Não cite erro, dificuldade, nota, pontuação nem números. Não diga o nome do tutor.",
  "Não invente nada além do que foi informado.",
].join(" ");

export function openerUserPrompt(input: {
  firstName: string;
  lesson: OpenerLesson;
  today: string;
}): string {
  return JSON.stringify({
    primeiro_nome: input.firstName,
    quando: whenPhrase(input.lesson.classDate, input.today),
    assunto_da_aula: clip(input.lesson.topic, 160),
    contexto: clip(input.lesson.context, 200),
  });
}

const FORBIDDEN = /\b(err(o|os|ou|ar|ando)|dificuldade|nota|pontua|acert|score|wolfie|tutor)\b|\d/iu;

/** Aceita a frase da IA só se segue as regras; senão volta null (o chamador usa o molde). */
export function validateOpener(raw: unknown, firstName: string): string | null {
  const text = String((raw as { opener?: unknown })?.opener ?? "").replace(/\s+/g, " ").trim();
  if (text.length < 20 || text.length > 200) return null;
  if (/[\n\r]/.test(text)) return null;
  if (firstName && !text.includes(firstName)) return null;
  if (FORBIDDEN.test(text)) return null;
  if ((text.match(/[.!?]/g) ?? []).length > 3) return null;
  return text;
}
