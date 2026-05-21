/**
 * wolfie-tts — Text-to-Speech via OpenAI TTS
 * Retorna áudio MP3 como base64 para o WolfieTutor.
 *
 * Vozes disponíveis: alloy, echo, fable, onyx, nova, shimmer
 * Modelos: tts-1 (rápido) | tts-1-hd (alta qualidade)
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Remove markdown e prepara texto para TTS natural
function cleanForTTS(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")          // bold
    .replace(/\*(.*?)\*/g, "$1")              // itálico
    .replace(/`(.*?)`/g, "$1")               // code inline
    .replace(/#{1,6}\s/g, "")                // headings
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")      // links
    .replace(/---+/g, ".")                   // separadores
    .replace(/\n{2,}/g, " ... ")             // parágrafos → pausa
    .replace(/\n/g, " ")                     // quebras de linha
    .replace(/([.!?])\s+/g, "$1 ")           // normaliza espaços pós-pontuação
    .replace(/\s{2,}/g, " ")                 // espaços duplos
    .trim();
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { text, voice = "nova", model = "tts-1", speed = 1.0 } = await req.json();

    if (!text || typeof text !== "string") {
      return new Response(JSON.stringify({ error: "text is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "OPENAI_API_KEY not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const cleaned = cleanForTTS(text);

    // Trunca em 4096 chars (limite OpenAI TTS)
    const truncated = cleaned.slice(0, 4096);

    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,           // tts-1 ou tts-1-hd
        input: truncated,
        voice,           // nova, shimmer, alloy, echo, fable, onyx
        response_format: "mp3",
        speed,           // 0.25 – 4.0 (1.0 = normal)
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("[wolfie-tts] OpenAI error:", err);
      return new Response(JSON.stringify({ error: `OpenAI TTS error: ${response.status}` }), {
        status: response.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Converte o MP3 para base64 para enviar ao cliente
    const audioBuffer = await response.arrayBuffer();
    const base64Audio = btoa(String.fromCharCode(...new Uint8Array(audioBuffer)));

    return new Response(
      JSON.stringify({ audio: base64Audio, format: "mp3" }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error: any) {
    console.error("[wolfie-tts] Error:", error.message);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
