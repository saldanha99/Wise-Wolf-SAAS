/// <reference lib="deno.ns" />

// Healthcheck funcional da IA do Wolfie.
//
// Por que existe: a chamada ao vivo ficou 100% quebrada e ninguém soube até um
// aluno reclamar. O `notify_cron_failures` não pegou porque nenhum cron falhou
// — a edge function rodava perfeitamente e a OpenAI é que recusava a sessão
// (400 no cabeçalho OpenAI-Safety-Identifier), virando 502 para o aluno.
//
// Vigiar processo não basta: é preciso exercitar o caminho real. Aqui montamos
// a MESMA sessão que o wolfie-realtime-session monta e mandamos para a OpenAI.
// Se a configuração deixar de ser aceita, isto acusa em minutos.

// deno-lint-ignore no-import-prefix
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const OPENAI_REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const DEFAULT_REALTIME_MODEL = "gpt-realtime-2.1";
const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const DEFAULT_VOICE = "cedar";
const CONTEXT_RETENTION_RATIO = 0.6;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Cache-Control": "no-store", "Content-Type": "application/json" },
  });

/**
 * Oferta SDP mínima e válida. Precisa ser real: com SDP inválido a OpenAI para
 * em "invalid_offer" ANTES de validar a sessão, e o teste passaria a não provar
 * nada — foi exatamente o que me enganou ao diagnosticar o bug original.
 */
const PROBE_SDP = [
  "v=0",
  "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "a=msid-semantic: WMS",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "c=IN IP4 0.0.0.0",
  "a=rtcp:9 IN IP4 0.0.0.0",
  "a=ice-ufrag:x1Kd",
  "a=ice-pwd:0m0aQ1bVhTBOa3aVXQTfLZmB",
  "a=ice-options:trickle",
  "a=fingerprint:sha-256 4A:AD:B9:B1:3F:82:18:3B:54:02:12:DF:3E:5D:49:6B:19:E5:7C:AB:3A:6C:2B:6D:36:3D:D9:1A:8F:E4:23:87",
  "a=setup:actpass",
  "a=mid:0",
  "a=sendrecv",
  "a=rtcp-mux",
  "a=rtpmap:111 opus/48000/2",
  "",
].join("\n");

function configured(name: string, fallback: string, pattern: RegExp): string {
  const value = Deno.env.get(name)?.trim() ?? "";
  return pattern.test(value) ? value : fallback;
}

/** Espelha `openAiSession` do wolfie-realtime-session. */
function probeSession() {
  return {
    type: "realtime",
    model: configured("OPENAI_REALTIME_MODEL", DEFAULT_REALTIME_MODEL, /^[a-zA-Z0-9._:-]{1,100}$/),
    include: ["item.input_audio_transcription.logprobs"],
    output_modalities: ["audio"],
    instructions: "Healthcheck probe. Do not respond.",
    reasoning: { effort: "low" },
    max_output_tokens: 512,
    truncation: { type: "retention_ratio", retention_ratio: CONTEXT_RETENTION_RATIO },
    audio: {
      input: {
        transcription: {
          model: configured("OPENAI_REALTIME_TRANSCRIPTION_MODEL", DEFAULT_TRANSCRIPTION_MODEL, /^[a-zA-Z0-9._:-]{1,100}$/),
          prompt: "healthcheck",
        },
        noise_reduction: { type: "near_field" },
        turn_detection: {
          type: "semantic_vad",
          eagerness: "medium",
          create_response: true,
          interrupt_response: true,
        },
      },
      output: { voice: configured("OPENAI_REALTIME_VOICE", DEFAULT_VOICE, /^[a-zA-Z0-9_-]{1,40}$/), speed: 1 },
    },
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const apiKey = Deno.env.get("OPENAI_API_KEY")?.trim() ?? "";
  if (!apiKey) {
    return json({ healthy: false, check: "realtime", reason: "OPENAI_API_KEY ausente" }, 200);
  }

  const form = new FormData();
  form.set("sdp", PROBE_SDP);
  form.set("session", JSON.stringify(probeSession()));

  try {
    const upstream = await fetch(OPENAI_REALTIME_CALLS_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        // Mesmo formato do runtime, dentro do limite de 64 caracteres.
        "OpenAI-Safety-Identifier": "ww_healthcheck_probe",
      },
      body: form,
      signal: AbortSignal.timeout(25_000),
    });

    if (upstream.status === 201) {
      // A chamada nasce e é abandonada sem WebRTC: nenhum áudio trafega, então
      // não há token de áudio cobrado. É o preço de saber que funciona.
      const callId = upstream.headers.get("location")?.split("/").filter(Boolean).at(-1) ?? "";
      await upstream.body?.cancel().catch(() => undefined);
      return json({ healthy: true, check: "realtime", callId });
    }

    let detail = "";
    try {
      const payload = await upstream.json();
      detail = String(payload?.error?.message ?? "").slice(0, 300);
    } catch {
      await upstream.body?.cancel().catch(() => undefined);
    }
    console.error("Wolfie healthcheck failed", { status: upstream.status, detail });
    return json({ healthy: false, check: "realtime", status: upstream.status, reason: detail }, 200);
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    console.error("Wolfie healthcheck transport failed", { name });
    return json({ healthy: false, check: "realtime", reason: `transporte: ${name}` }, 200);
  }
});
