/// <reference lib="deno.ns" />

/**
 * Wolfie TTS
 *
 * Fallback oficial para os fluxos que ainda não estiverem em uma sessão
 * speech-to-speech da Realtime API. A chave permanente nunca sai do servidor.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { recordAiUsage } from "../_shared/ai-usage.ts";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";
import { requireWolfieProductAccess } from "../_shared/wolfie-product-access.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";
const DEFAULT_MODEL = "gpt-4o-mini-tts";
const MAX_REQUEST_BYTES = 32_000;
type TtsLanguage = "pt" | "en" | "mixed";
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

const inferLanguage = (
  language: unknown,
  voice: unknown,
): TtsLanguage => {
  if (language === "pt" || language === "en" || language === "mixed") {
    return language;
  }
  return typeof voice === "string" &&
      voice.toLocaleLowerCase().startsWith("pt")
    ? "pt"
    : "en";
};

const resolveVoice = (language: TtsLanguage): string => {
  const configured = (
    language === "pt"
      ? Deno.env.get("WOLFIE_TTS_VOICE_PT")
      : Deno.env.get("WOLFIE_TTS_VOICE_EN")
  )?.trim().toLocaleLowerCase();

  return configured && ALLOWED_VOICES.has(configured) ? configured : "marin";
};

/**
 * O tier premium é a fronteira da VOZ. No gratuito o Wolfie responde por
 * escrito, então esta função nem chega a chamar a OpenAI.
 *
 * Nenhuma resposta daqui carrega `fallback: "browser_speech"`: o cliente cairia
 * na voz do navegador e o aluno continuaria ouvindo o Wolfie — exatamente o que
 * a separação de tiers veio impedir. Falha de leitura do tier também não libera
 * voz: sem certeza de premium, não se gasta áudio pago.
 */
const voiceDeniedResponse = (
  corsHeaders: Record<string, string>,
  status: number,
  code: string,
  reason?: string,
) =>
  new Response(
    JSON.stringify({
      error: code,
      code,
      reason,
      tier: "FREE",
      upgradeUrl: "https://wolfie.wisewolflanguage.com.br/planos",
    }),
    {
      status,
      headers: {
        ...corsHeaders,
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
      },
    },
  );

const speakingInstructions = (language: TtsLanguage): string =>
  language === "mixed"
    ? "Speak each labeled segment in its labeled language. Use natural Brazilian Portuguese for Português segments and natural American English for English segments, switching smoothly without translating, adding, correcting, or omitting content. Preserve names, cities, states, and numbers exactly."
    : language === "pt"
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
      allowWolfieDirect: true,
      allowedRoles: ["STUDENT"],
      corsHeaders,
    });
    if (auth.ok === false) return auth.response;
    const accessError = await requireWolfieProductAccess(
      auth.context,
      corsHeaders,
    );
    if (accessError) return accessError;

    const { data: tier, error: tierError } = await auth.context.admin
      .rpc("wolfie_tier_for_student", { p_student_id: auth.context.userId });
    if (tierError) {
      console.error("[wolfie-tts] leitura de tier falhou", {
        code: tierError.code,
      });
      return voiceDeniedResponse(
        corsHeaders,
        503,
        "VOICE_TIER_UNAVAILABLE",
        "tier_indisponivel",
      );
    }
    const tierSnapshot = tier && typeof tier === "object" && !Array.isArray(tier)
      ? tier as Record<string, unknown>
      : null;
    if (tierSnapshot?.voice_replies !== true) {
      return voiceDeniedResponse(
        corsHeaders,
        403,
        "VOICE_IS_PREMIUM",
        typeof tierSnapshot?.reason === "string"
          ? tierSnapshot.reason
          : undefined,
      );
    }

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

    const language = inferLanguage(body.language, body.voice);
    const voice = resolveVoice(language);
    const model = Deno.env.get("WOLFIE_TTS_MODEL")?.trim() || DEFAULT_MODEL;
    const speed = normalizeSpeed(body.speed);
    const spokenText = text.slice(0, 4096);

    const response = await fetch(OPENAI_SPEECH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        voice,
        input: spokenText,
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

    // A API de fala não devolve bloco `usage` — o custo é por token do texto de
    // entrada. Registramos a ESTIMATIVA (~4 caracteres por token) porque o
    // painel do diretor ignorava 100% do áudio: aparecia só o texto, e a conta
    // da voz não existia em lugar nenhum. O rótulo no painel diz "estimado".
    await recordAiUsage(auth.context.admin, {
      tenantId: auth.context.profile?.tenant_id ?? null,
      userId: auth.context.userId,
      feature: "wolfie_tts",
      provider: "openai",
      model,
      usage: {
        inputTokens: Math.max(1, Math.ceil(spokenText.length / 4)),
        outputTokens: 0,
        cachedTokens: 0,
      },
    });

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
