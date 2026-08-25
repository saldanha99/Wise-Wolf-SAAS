/**
 * Lógica pura da camada de áudio do Wolfie.
 *
 * Extraído de `components/WolfieTutor.tsx`, que concentrava ~3.600 linhas num
 * único componente. Aqui mora só o que NÃO depende de React, DOM ou estado —
 * justamente a parte que dá para testar. A orquestração de playback (unlock
 * iOS, keepalive, ordem de fallback) continua no componente de propósito:
 * é o trecho mais frágil do sistema e move-lo pede deploy isolado.
 *
 * `prepareForTTS` estava sendo redefinida a cada render dentro do componente.
 */

/** Idiomas aceitos pelo TTS do Wolfie. */
export type WolfieTtsLanguage = "en" | "pt" | "mixed";
export type WolfieSpeechLanguage = "en" | "pt";

export interface WolfieSpeechSegment {
  text: string;
  language: WolfieSpeechLanguage;
}

export interface WolfieSpeechSentence {
  sentence: string;
  language: WolfieSpeechLanguage;
}

export interface WolfieBrowserVoice {
  name: string;
  lang: string;
}

export const WOLFIE_OPENAI_VOICE = "cedar";

const WOLFIE_BROWSER_VOICE_NAMES: Record<
  WolfieSpeechLanguage,
  readonly string[]
> = {
  pt: ["Felipe", "Antonio", "Antônio", "Thiago", "Rafael", "Ricardo", "Paulo"],
  en: ["Guy", "Daniel", "Alex", "Aaron", "Arthur", "Fred", "Tom", "Rishi"],
};

/**
 * iOS bloqueia play() fora de um handler de toque síncrono, então o caminho de
 * playback é totalmente diferente. Inclui iPad moderno, que se apresenta como
 * "MacIntel" com touch.
 */
export const IS_IOS = typeof navigator !== "undefined" && (
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
);

/**
 * WAV mínimo válido (44 bytes, 0 samples, 8000Hz mono 8-bit).
 * Pré-ativa o HTMLAudioElement no iOS: play() com src VÁLIDO registra a
 * gesture no elemento; play() com src vazio não funciona.
 */
export const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

/** Aluno iniciante precisa de fala mais lenta para acompanhar. */
export function getTTSSpeed(level: string): number {
  switch (level) {
    case "A1":
      return 0.92;
    case "A2":
      return 0.95;
    case "B1":
      return 0.98;
    case "B2":
      return 1.0;
    default:
      return 1.0; // C1, C2
  }
}

/** Identidade vocal enviada ao wolfie-tts em qualquer idioma. */
export function resolveTtsVoice(_language: WolfieTtsLanguage): string {
  return WOLFIE_OPENAI_VOICE;
}

export function selectWolfieBrowserVoice<T extends WolfieBrowserVoice>(
  voices: T[],
  language: WolfieSpeechLanguage,
): T | null {
  const languagePrefix = language === "pt" ? "pt" : "en";
  const candidates = voices.filter((voice) =>
    voice.lang.toLocaleLowerCase().startsWith(languagePrefix)
  );
  const preferredNames = WOLFIE_BROWSER_VOICE_NAMES[language];

  for (const preferredName of preferredNames) {
    const normalizedPreference = preferredName.toLocaleLowerCase();
    const match = candidates.find((voice) =>
      voice.name.toLocaleLowerCase().includes(normalizedPreference)
    );
    if (match) return match;
  }

  return null;
}

/**
 * Limpa markdown e adiciona pausas para o texto soar natural falado.
 * Sem isto o TTS lê asteriscos, crases e cabeçalhos em voz alta.
 */
export function prepareForTTS(raw: string): string {
  return raw
    .replace(/\*\*(.*?)\*\*/g, "$1") // bold → texto puro
    .replace(/\*(.*?)\*/g, "$1") // itálico → texto puro
    .replace(/`(.*?)`/g, "$1") // code → texto puro
    .replace(/#{1,6}\s+/g, "") // headings
    .replace(/\[(.*?)\]\(.*?\)/g, "$1") // links → só o label
    .replace(/---+/g, ".") // separadores → ponto
    .replace(/\n{2,}/g, ", ") // parágrafos → pausa curta
    .replace(/\n/g, " ") // linha única → espaço
    .replace(/([a-z])([A-Z])/g, "$1 $2") // camelCase → palavras separadas
    .replace(/\s{2,}/g, " ") // espaços duplos
    .trim();
}

/**
 * Quebra a fala em frases preservando o idioma de cada trecho. O Web Speech
 * troca de voz por utterance, então uma resposta bilíngue precisa sair
 * frase a frase — senão o inglês sai com sotaque português, ou vice-versa.
 */
export function splitSpeechSentences(
  text: string,
  segments?: WolfieSpeechSegment[],
  fallbackLanguage: WolfieSpeechLanguage = "en",
): WolfieSpeechSentence[] {
  const sourceSegments = segments?.length
    ? segments
    : [{ text, language: fallbackLanguage }];

  return sourceSegments.flatMap((segment) => {
    const clean = prepareForTTS(segment.text);
    const parts = clean.match(/[^.!?]+(?:[.!?]+|$)/g) || [clean];
    return parts
      .map((sentence) => ({
        sentence: sentence.trim(),
        language: segment.language,
      }))
      .filter((item) => item.sentence);
  });
}

/** Decodifica o MP3 base64 devolvido pelo wolfie-tts. */
export function decodeBase64Audio(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
