/// <reference lib="deno.ns" />

import {
  decodeBase64Audio,
  getTTSSpeed,
  prepareForTTS,
  resolveTtsVoice,
  SILENT_WAV,
  splitSpeechSentences,
} from "../../lib/wolfieAudio.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("prepareForTTS não deixa markdown ser lido em voz alta", () => {
  const falado = prepareForTTS(
    "## Título\n\n**Muito bem!** Use o `present perfect`.\n---\nVeja [aqui](http://x.com).",
  );
  for (const lixo of ["#", "**", "`", "---", "](", "http"]) {
    assert(
      !falado.includes(lixo),
      `markdown "${lixo}" vazou para a fala: ${falado}`,
    );
  }
  assert(falado.includes("Muito bem!"), "o conteúdo precisa sobreviver");
  assert(falado.includes("aqui"), "o label do link deve permanecer");
});

Deno.test("prepareForTTS separa camelCase e colapsa espaços", () => {
  assert(
    prepareForTTS("presentPerfect") === "present Perfect",
    "camelCase precisa virar palavras separadas para o TTS não emendar",
  );
  assert(
    prepareForTTS("  muito    espaço  ") === "muito espaço",
    "espaços duplicados devem ser colapsados",
  );
});

Deno.test("splitSpeechSentences preserva o idioma de cada trecho", () => {
  const frases = splitSpeechSentences("", [
    { text: "Você disse isso. Agora repita.", language: "pt" },
    { text: "I live here. Do you?", language: "en" },
  ]);
  assert(frases.length === 4, `esperava 4 frases, veio ${frases.length}`);
  // Sem isto o inglês sairia com voz portuguesa: o Web Speech troca de voz
  // por utterance, então cada frase precisa carregar seu próprio idioma.
  assert(
    frases[0].language === "pt" && frases[3].language === "en",
    "cada frase deve manter o idioma do seu segmento",
  );
  assert(
    frases.every((f) => f.sentence.length > 0),
    "nenhuma frase vazia pode ser enfileirada",
  );
});

Deno.test("splitSpeechSentences cai no texto solto quando não há segmentos", () => {
  const frases = splitSpeechSentences("Hello there. How are you?", undefined);
  assert(frases.length === 2, `esperava 2 frases, veio ${frases.length}`);
  assert(
    frases.every((f) => f.language === "en"),
    "sem segmentos, o idioma padrão deve valer",
  );
  assert(
    splitSpeechSentences("   ", undefined).length === 0,
    "texto em branco não deve gerar utterance",
  );
});

Deno.test("velocidade do TTS é mais lenta para iniciante", () => {
  assert(getTTSSpeed("A1") < getTTSSpeed("B1"), "A1 precisa ser mais lento");
  assert(getTTSSpeed("B1") < getTTSSpeed("B2"), "B1 mais lento que B2");
  assert(getTTSSpeed("C2") === 1.0, "nível avançado fala em velocidade normal");
  assert(
    getTTSSpeed("desconhecido") === 1.0,
    "nível inesperado não pode quebrar a fala",
  );
});

Deno.test("voz corresponde ao idioma pedido", () => {
  assert(resolveTtsVoice("pt").startsWith("pt-BR"), "português → voz pt-BR");
  assert(resolveTtsVoice("en").startsWith("en-US"), "inglês → voz en-US");
  assert(
    resolveTtsVoice("mixed") === "auto-Bilingual",
    "bilíngue precisa da voz automática",
  );
});

Deno.test("SILENT_WAV é um data URI de áudio válido (exigência do iOS)", () => {
  // src vazio NÃO ativa o elemento no iOS; precisa ser um WAV decodificável.
  assert(
    SILENT_WAV.startsWith("data:audio/wav;base64,"),
    "precisa ser data URI de WAV",
  );
  const bytes = decodeBase64Audio(SILENT_WAV.split(",")[1]);
  assert(bytes.length >= 44, `cabeçalho WAV incompleto: ${bytes.length} bytes`);
  const marca = String.fromCharCode(...bytes.slice(0, 4));
  const tipo = String.fromCharCode(...bytes.slice(8, 12));
  assert(marca === "RIFF" && tipo === "WAVE", "não é um WAV bem formado");
});

Deno.test("decodeBase64Audio devolve os bytes originais", () => {
  const bytes = decodeBase64Audio(btoa("wolfie"));
  assert(
    String.fromCharCode(...bytes) === "wolfie",
    "o áudio decodificado precisa bater byte a byte",
  );
  assert(decodeBase64Audio("").length === 0, "vazio não pode quebrar");
});
