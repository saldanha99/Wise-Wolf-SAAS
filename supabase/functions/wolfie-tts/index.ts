/**
 * wolfie-tts — Text-to-Speech via Microsoft Edge Neural TTS
 * Vozes neurais de alta qualidade, sem custo, sem API key.
 *
 * Vozes disponíveis:
 *   en-US-JennyNeural   — inglês americano, feminina, natural (padrão)
 *   en-US-AriaNeural    — inglês americano, feminina, expressiva
 *   en-US-GuyNeural     — inglês americano, masculino
 *   pt-BR-FranciscaNeural — português brasileiro, feminina
 *   pt-BR-AntonioNeural — português brasileiro, masculino
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Token público do Microsoft Edge TTS (não requer chave de API)
const EDGE_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const EDGE_WSS = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${EDGE_TOKEN}`;

// Remove markdown e prepara texto para TTS natural
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
    .trim()
    .slice(0, 2000); // Microsoft Edge TTS aceita até ~3000 chars
}

// Gera UUID simples sem crypto (compatível com Deno)
function randomUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { text, voice = "en-US-JennyNeural", speed = 1.0 } = await req.json();

    if (!text || typeof text !== "string") {
      return new Response(JSON.stringify({ error: "text is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const cleaned = cleanText(text);

    // Converte speed (0.25–2.0) para formato SSML da Microsoft (+/-nn%)
    // 1.0 = normal, 1.2 = +20%, 0.8 = -20%
    const ratePct = Math.round((speed - 1.0) * 100);
    const rateStr = ratePct >= 0 ? `+${ratePct}%` : `${ratePct}%`;

    // CRÍTICO: xml:lang DEVE corresponder ao idioma da voz
    // xml:lang errado = motor usa fonética errada = sotaque estrangeiro
    // pt-BR-ThalitaNeural → pt-BR | en-US-JennyNeural → en-US
    const langCode = voice.match(/^([a-z]{2}-[A-Z]{2})/)?.[1] ?? "en-US";

    // SSML para o Microsoft Neural TTS
    const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${langCode}'>
      <voice name='${voice}'>
        <prosody rate='${rateStr}' pitch='+0Hz'>${cleaned}</prosody>
      </voice>
    </speak>`;

    const requestId = randomUUID().replace(/-/g, "");
    const timestamp = new Date().toUTCString();

    // Conecta ao WebSocket da Microsoft
    const ws = new WebSocket(EDGE_WSS, [
      "chat",
      `TrustedClientToken=${EDGE_TOKEN}`,
    ]);

    const audioChunks: Uint8Array[] = [];
    let resolved = false;

    const result = await new Promise<string>((resolve, reject) => {
      // Timeout de segurança — 20 segundos
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          ws.close();
          reject(new Error("Microsoft TTS timeout"));
        }
      }, 20_000);

      ws.onopen = () => {
        // 1. Envia configuração de sintetização
        const configMsg =
          `X-Timestamp:${timestamp}\r\n` +
          `Content-Type:application/json; charset=utf-8\r\n` +
          `Path:speech.config\r\n\r\n` +
          JSON.stringify({
            context: {
              synthesis: {
                audio: {
                  metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false },
                  outputFormat: "audio-24khz-48kbitrate-mono-mp3",
                },
              },
            },
          });

        ws.send(configMsg);

        // 2. Envia o SSML para sintetização
        const ssmlMsg =
          `X-RequestId:${requestId}\r\n` +
          `Content-Type:application/ssml+xml\r\n` +
          `X-Timestamp:${timestamp}\r\n` +
          `Path:ssml\r\n\r\n` +
          ssml;

        ws.send(ssmlMsg);
      };

      ws.onmessage = (event) => {
        if (typeof event.data === "string") {
          // Mensagem de controle — verifica se é turn.end (fim do áudio)
          if (event.data.includes("Path:turn.end")) {
            clearTimeout(timeout);
            ws.close();

            if (audioChunks.length === 0) {
              resolved = true;
              reject(new Error("Nenhum áudio recebido do Microsoft TTS"));
              return;
            }

            // Concatena todos os chunks de áudio
            const totalLength = audioChunks.reduce((a, c) => a + c.length, 0);
            const merged = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of audioChunks) {
              merged.set(chunk, offset);
              offset += chunk.length;
            }

            // Converte para base64
            const base64 = btoa(String.fromCharCode(...merged));
            resolved = true;
            resolve(base64);
          }
        } else if (event.data instanceof ArrayBuffer) {
          // Mensagem binária — contém o áudio MP3
          // Formato: cabeçalho de texto + \r\n\r\n + dados binários MP3
          const buffer = new Uint8Array(event.data);

          // Encontra o separador \r\n\r\n (bytes: 13, 10, 13, 10)
          let separatorIdx = -1;
          for (let i = 0; i < buffer.length - 3; i++) {
            if (buffer[i] === 13 && buffer[i + 1] === 10 && buffer[i + 2] === 13 && buffer[i + 3] === 10) {
              separatorIdx = i + 4;
              break;
            }
          }

          if (separatorIdx !== -1 && separatorIdx < buffer.length) {
            audioChunks.push(buffer.slice(separatorIdx));
          }
        }
      };

      ws.onerror = (error) => {
        clearTimeout(timeout);
        if (!resolved) {
          resolved = true;
          reject(new Error(`WebSocket error: ${error}`));
        }
      };

      ws.onclose = (event) => {
        clearTimeout(timeout);
        if (!resolved && audioChunks.length > 0) {
          // Fechou com dados — processa mesmo assim
          const totalLength = audioChunks.reduce((a, c) => a + c.length, 0);
          const merged = new Uint8Array(totalLength);
          let offset = 0;
          for (const chunk of audioChunks) {
            merged.set(chunk, offset);
            offset += chunk.length;
          }
          const base64 = btoa(String.fromCharCode(...merged));
          resolved = true;
          resolve(base64);
        } else if (!resolved) {
          resolved = true;
          reject(new Error(`WebSocket fechou sem áudio (code: ${event.code})`));
        }
      };
    });

    return new Response(
      JSON.stringify({ audio: result, format: "mp3" }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[wolfie-tts] Error:", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
