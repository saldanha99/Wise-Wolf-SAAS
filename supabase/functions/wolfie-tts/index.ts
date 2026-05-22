/**
 * wolfie-tts v9 — Text-to-Speech via Google Translate TTS
 *
 * Usa o endpoint não-oficial do Google Translate TTS.
 * Sem API key, sem WebSocket, simples HTTPS GET.
 * Retorna audio/mpeg (MP3). Testado e funcionando via curl.
 *
 * Limite: ~200 chars por request — textos maiores são divididos
 * em sentenças e os chunks concatenados.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// User-Agent de browser real — Google bloqueia UA de servidor/bot
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Remove markdown e prepara texto para TTS
function cleanText(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/`(.*?)`/g, "$1")
    .replace(/#{1,6}\s/g, "")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/---+/g, ".")
    .replace(/\n{2,}/g, " ")
    .replace(/\n/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Divide texto em chunks de até maxLen chars,
 * quebrando apenas em limites de sentença/vírgula/espaço.
 */
function splitText(text: string, maxLen = 180): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text.trim();

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Tenta quebrar na última pontuação dentro do limite
    let cutAt = -1;
    const slice = remaining.slice(0, maxLen);

    // Ordem de preferência: . ! ? , ; " ' espaço
    for (const sep of [".", "!", "?", ",", ";", " "]) {
      const idx = slice.lastIndexOf(sep);
      if (idx > 0) {
        cutAt = idx + 1;
        break;
      }
    }

    if (cutAt <= 0) cutAt = maxLen; // fallback: corta no limite duro

    chunks.push(remaining.slice(0, cutAt).trim());
    remaining = remaining.slice(cutAt).trim();
  }

  return chunks.filter(c => c.length > 0);
}

/**
 * Converte Uint8Array para base64 em chunks (evita stack overflow em buffers grandes).
 */
function uint8ToBase64(bytes: Uint8Array): string {
  const CHUNK = 8192;
  let str = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    str += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(str);
}

/**
 * Extrai o locale (tl) a partir do nome da voz Microsoft Edge.
 * pt-BR-ThalitaNeural → pt-BR
 * en-US-JennyNeural  → en-US
 */
function voiceToLocale(voice: string): string {
  const m = voice.match(/^([a-z]{2}-[A-Z]{2})/);
  return m ? m[1] : "en-US";
}

/**
 * Busca TTS para um único chunk de texto.
 * Retorna Uint8Array com o MP3.
 */
async function fetchTTSChunk(text: string, locale: string): Promise<Uint8Array> {
  const url =
    `https://translate.google.com/translate_tts` +
    `?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${locale}&client=gtx&ttsspeed=1`;

  const resp = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept": "audio/mpeg, audio/*, */*",
      "Referer": "https://translate.google.com/",
    },
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Google TTS ${resp.status}: ${body.slice(0, 120)}`);
  }

  const buf = await resp.arrayBuffer();
  if (buf.byteLength < 50) {
    throw new Error(`Google TTS retornou áudio muito pequeno (${buf.byteLength} bytes)`);
  }

  return new Uint8Array(buf);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { text, voice = "en-US-JennyNeural" } = await req.json();

    if (!text || typeof text !== "string") {
      return new Response(JSON.stringify({ error: "text is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const cleaned = cleanText(text).slice(0, 1000);
    const locale = voiceToLocale(voice);
    const chunks = splitText(cleaned, 180);

    console.log(`[wolfie-tts] voice=${voice} locale=${locale} chunks=${chunks.length} totalChars=${cleaned.length}`);

    // Busca todos os chunks em paralelo (mais rápido que sequencial)
    const audioArrays = await Promise.all(
      chunks.map(chunk => fetchTTSChunk(chunk, locale))
    );

    // Concatena os chunks de MP3
    const totalBytes = audioArrays.reduce((sum, a) => sum + a.length, 0);
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of audioArrays) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    console.log(`[wolfie-tts] Áudio final: ${totalBytes} bytes`);

    const base64 = uint8ToBase64(merged);

    return new Response(
      JSON.stringify({ audio: base64, format: "mp3" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[wolfie-tts] Error:", message);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
