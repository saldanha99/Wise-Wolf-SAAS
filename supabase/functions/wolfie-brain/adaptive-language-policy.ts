export type WolfieLearnerLanguage = "pt" | "en";
export type WolfieDetectedLanguage =
  | WolfieLearnerLanguage
  | "mixed"
  | "unknown";
export type WolfieAssistantLanguage = "pt-BR" | "en-US";

export interface WolfieTurnLanguagePolicy {
  assistantLanguage: WolfieAssistantLanguage;
  needsEnglishBridge: boolean;
  immersiveEnglishOnly: boolean;
}

const PORTUGUESE_MARKERS = new Set([
  "agora",
  "ainda",
  "aqui",
  "boa",
  "beleza",
  "bom",
  "certo",
  "claro",
  "como",
  "da",
  "das",
  "de",
  "diga",
  "dizer",
  "do",
  "dos",
  "ela",
  "ele",
  "em",
  "entendi",
  "entender",
  "então",
  "essa",
  "esse",
  "está",
  "estou",
  "eu",
  "inglês",
  "isso",
  "mas",
  "me",
  "meu",
  "minha",
  "moro",
  "na",
  "não",
  "no",
  "nós",
  "obrigada",
  "obrigado",
  "oi",
  "olá",
  "onde",
  "para",
  "pendente",
  "pode",
  "porque",
  "preciso",
  "qual",
  "que",
  "quero",
  "repete",
  "repetir",
  "sim",
  "sou",
  "também",
  "tá",
  "tem",
  "tente",
  "tudo",
  "uma",
  "valeu",
  "vamos",
  "você",
  "vocês",
]);

const ENGLISH_MARKERS = new Set([
  "about",
  "again",
  "am",
  "and",
  "are",
  "backup",
  "because",
  "but",
  "can",
  "complete",
  "could",
  "do",
  "does",
  "explain",
  "for",
  "from",
  "good",
  "have",
  "hello",
  "help",
  "hi",
  "how",
  "i",
  "in",
  "is",
  "it",
  "live",
  "morning",
  "my",
  "no",
  "now",
  "pending",
  "please",
  "ready",
  "say",
  "status",
  "still",
  "thanks",
  "the",
  "this",
  "to",
  "want",
  "we",
  "what",
  "when",
  "where",
  "with",
  "yes",
  "you",
  "your",
]);

const PORTUGUESE_STRONG_PHRASES = [
  /\beu\s+(?:não\s+)?(?:quero|preciso|moro|sou|estou|entendi)\b/iu,
  /\bcomo\s+(?:eu\s+)?(?:digo|dizer|falo|falar)\b/iu,
  /\b(?:bom\s+dia|boa\s+tarde|boa\s+noite|e\s+aí|tudo\s+bem)\b/iu,
  /\b(?:me\s+ajud[ae]|você\s+pode|não\s+entendi)\b/iu,
  /\b(?:pode\s+repetir|repete(?:\s+(?:isso|por\s+favor))?)\b/iu,
];

const ENGLISH_STRONG_PHRASES = [
  /\bi(?:'|’)?m\b/iu,
  /\bi\s+(?:am|live|want|need|said|think|understand)\b/iu,
  /\b(?:good\s+morning|good\s+afternoon|good\s+evening|how\s+are\s+you)\b/iu,
  /\b(?:can|could|would)\s+you\b/iu,
];

const tokenize = (text: string): string[] =>
  text
    .normalize("NFKC")
    .replace(/[’‘]/g, "'")
    .toLocaleLowerCase("pt-BR")
    .match(/[\p{L}']+/gu) ?? [];

export function detectWolfieLearnerLanguage(
  text: string,
): WolfieDetectedLanguage {
  const normalized = text.normalize("NFKC").replace(/[’‘]/g, "'");
  const words = tokenize(normalized);
  if (words.length === 0) return "unknown";

  let portugueseScore = 0;
  let englishScore = 0;

  for (const phrase of PORTUGUESE_STRONG_PHRASES) {
    if (phrase.test(normalized)) portugueseScore += 4;
  }
  for (const phrase of ENGLISH_STRONG_PHRASES) {
    if (phrase.test(normalized)) englishScore += 4;
  }
  for (const word of words) {
    if (PORTUGUESE_MARKERS.has(word)) portugueseScore += 1;
    if (ENGLISH_MARKERS.has(word)) englishScore += 1;
  }
  // Diacritics strengthen actual Portuguese syntax, but a proper noun such
  // as "Nova Iguaçu" must not select the conversation language by itself.
  if (portugueseScore > 0 && /[áàâãéêíóôõúç]/iu.test(normalized)) {
    portugueseScore += 3;
  }

  if (portugueseScore === 0 && englishScore === 0) return "unknown";
  if (portugueseScore >= 3 && englishScore >= 3) {
    return "mixed";
  }
  if (portugueseScore > englishScore) return "pt";
  if (englishScore > portugueseScore) return "en";
  return "unknown";
}

export function resolveWolfieLearnerLanguage(
  text: string,
  fallback: WolfieLearnerLanguage = "en",
): WolfieLearnerLanguage {
  const detected = detectWolfieLearnerLanguage(text);
  if (detected === "pt" || detected === "en") return detected;

  if (detected === "mixed") {
    const normalized = text
      .normalize("NFKC")
      .replace(/[’‘]/g, "'")
      .toLocaleLowerCase("pt-BR");
    // Portuguese framing around an English example is a request for support.
    if (
      PORTUGUESE_STRONG_PHRASES.some((phrase) => phrase.test(normalized)) ||
      /[áàâãéêíóôõúç]/iu.test(normalized)
    ) {
      return "pt";
    }
  }
  return fallback;
}

export function resolveWolfieTurnLanguagePolicy(
  studentLanguage: WolfieLearnerLanguage | undefined,
  languageMode: string,
): WolfieTurnLanguagePolicy {
  // The learner's current speech is stronger evidence than an interface mode.
  // Even an immersive session must recover naturally when the learner asks for
  // help in Portuguese, then bridge them straight back into English.
  if (studentLanguage === "pt") {
    return {
      assistantLanguage: "pt-BR",
      needsEnglishBridge: true,
      immersiveEnglishOnly: false,
    };
  }
  return {
    assistantLanguage: "en-US",
    needsEnglishBridge: false,
    immersiveEnglishOnly: languageMode === "immersive",
  };
}

export const WOLFIE_ADAPTIVE_LANGUAGE_POLICY = `
# ADAPTIVE PORTUGUESE/ENGLISH — MANDATORY
- Detect the language of every learner turn independently. Never infer it from a microphone setting.
- If the learner speaks mainly Portuguese or frames a code-switched request in Portuguese, reply first in concise natural PT-BR. Put one short, useful American-English formulation or next-step prompt in the separate translation field so the learner can immediately continue in English.
- If the learner speaks English, reply naturally in American English. Use the translation field for concise PT-BR support only when it genuinely helps or is enabled.
- A quoted English phrase inside a Portuguese question does not make the turn English. Preserve the quoted phrase and answer the Portuguese request first.
- A name, city, state, number, or other proper noun never determines the language and must be preserved exactly.
- For an isolated Portuguese greeting, give only a brief Portuguese greeting plus a brief English equivalent/invitation. Do not evaluate or generate lesson feedback.
- For an isolated English greeting, reply only with a brief natural English greeting. Do not evaluate or generate lesson feedback.
`.trim();

export const WOLFIE_REALTIME_ADAPTIVE_LANGUAGE_POLICY = `
# ADAPTIVE PORTUGUESE/ENGLISH — MANDATORY
- Detect the language of every learner turn independently. Never infer it from an interface or microphone setting.
- If the learner speaks mainly Portuguese or frames a code-switched request in Portuguese, speak one concise natural PT-BR response first. Then say "Em inglês:" and immediately give one short, useful American-English formulation or next-step prompt.
- If the learner speaks English, reply naturally in American English. Do not add Portuguese unless the learner asks for clarification or cannot continue.
- A quoted English phrase inside a Portuguese question does not make the turn English. Preserve the quoted phrase and answer the Portuguese request first.
- A name, city, state, number, or other proper noun never determines the language and must be preserved exactly.
- For an isolated Portuguese greeting, give only a brief Portuguese greeting followed by one brief English equivalent or invitation. Do not evaluate or generate lesson feedback.
- For an isolated English greeting, reply only with a brief natural English greeting. Do not evaluate or generate lesson feedback.
`.trim();
