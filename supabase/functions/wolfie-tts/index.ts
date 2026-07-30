/// <reference lib="deno.ns" />

/**
 * Wolfie TTS
 *
 * Fallback oficial para os fluxos que ainda não estiverem em uma sessão
 * speech-to-speech da Realtime API. A chave permanente nunca sai do servidor.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  authorizeRequest,
  methodNotAllowed,
} from "../_shared/request-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";
const DEFAULT_MODEL = "gpt-4o-mini-tts";
const MAX_REQUEST_BYTES = 32_000;
const ALLOWED_VOICES = new Set([
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "fable",
  "marin",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
]);

const cleanText = (text: string): string =>
  text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/`(.*?)`/g, "$1")
    .replace(/#{1,6}\s/g, "")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/---+/g, ".")
    .replace(/\s+/g, " ")
    .trim();

const uint8ToBase64 = (bytes: Uint8Array): string => {
  const chunkSize = 8192;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
};

const normalizeSpeed = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.max(0.25, Math.min(4, value));
};

const inferLanguage = (voice: unknown): "pt" | "en" =>
  typeof voice === "string" && voice.toLocaleLowerCase().startsWith("pt")
    ? "pt"
    : "en";

const resolveVoice = (language: "pt" | "en"): string => {
  const configured = (
    language === "pt"
      ? Deno.env.get("WOLFIE_TTS_VOICE_PT")
      : Deno.env.get("WOLFIE_TTS_VOICE_EN")
  )?.trim().toLocaleLowerCase();

  return configured && ALLOWED_VOICES.has(configured) ? configured : "marin";
};

const speakingInstructions = (language: "pt" | "en"): string =>
  language === "pt"
    ? "Fale em português brasileiro natural, acolhedor e claro. Preserve exatamente nomes próprios, cidades, estados e números. Não acrescente nem corrija conteúdo."
    : "Speak in natural, warm, clear English for a language learner. Preserve proper names, Brazilian place names, and numbers exactly. Do not add or correct content.";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  try {
    const auth = await authorizeRequest(req, {
      allowService: false,
      allowedRoles: ["STUDENT"],
      corsHeaders,
    });
    if (auth.ok === false) return auth.response;

    const apiKey = Deno.env.get("OPENAI_API_KEY")?.trim();
    if (!apiKey) {
      return new Response(
        JSON.stringify({
          error: "WOLFIE_TTS_UNAVAILABLE",
          fallback: "browser_speech",
        }),
        {
          status: 503,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const declaredLength = Number(req.headers.get("content-length") ?? "0");
    if (
      Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES
    ) {
      return new Response(JSON.stringify({ error: "PAYLOAD_TOO_LARGE" }), {
        status: 413,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const rawBody = await req.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_REQUEST_BYTES) {
      return new Response(JSON.stringify({ error: "PAYLOAD_TOO_LARGE" }), {
        status: 413,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rawBody);
      body = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      body = {};
    }
    const text = typeof body?.text === "string" ? cleanText(body.text) : "";
    if (!text) {
      return new Response(JSON.stringify({ error: "text is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const language = inferLanguage(body.voice);
    const voice = resolveVoice(language);
    const model = Deno.env.get("WOLFIE_TTS_MODEL")?.trim() || DEFAULT_MODEL;
    const speed = normalizeSpeed(body.speed);

    const response = await fetch(OPENAI_SPEECH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        voice,
        input: text.slice(0, 4096),
        instructions: speakingInstructions(language),
        response_format: "mp3",
        speed,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const requestId = response.headers.get("x-request-id");
      await response.body?.cancel().catch(() => undefined);
      console.error("[wolfie-tts] OpenAI error", {
        status: response.status,
        requestId,
      });
      return new Response(
        JSON.stringify({
          error: "WOLFIE_TTS_PROVIDER_ERROR",
          fallback: "browser_speech",
          requestId,
        }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength < 50) {
      throw new Error("WOLFIE_TTS_EMPTY_AUDIO");
    }

    return new Response(
      JSON.stringify({
        audio: uint8ToBase64(bytes),
        format: "mp3",
        model,
        voice,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[wolfie-tts] Error:", message);
    return new Response(
      JSON.stringify({
        error: "WOLFIE_TTS_FAILED",
        fallback: "browser_speech",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
