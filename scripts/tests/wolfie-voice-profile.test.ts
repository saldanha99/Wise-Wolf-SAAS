/// <reference lib="deno.ns" />

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const read = (path: string) => Deno.readTextFile(path);

Deno.test("Realtime, TTS and healthcheck share the Cedar male voice profile", async () => {
  const [realtime, tts, healthcheck, envExample] = await Promise.all([
    read("supabase/functions/wolfie-realtime-session/index.ts"),
    read("supabase/functions/wolfie-tts/index.ts"),
    read("supabase/functions/wolfie-healthcheck/index.ts"),
    read(".env.example"),
  ]);

  assert(
    realtime.includes('const DEFAULT_VOICE = "cedar";'),
    "Realtime precisa usar Cedar por padrão",
  );
  assert(
    tts.includes('ALLOWED_VOICES.has(configured) ? configured : "cedar"'),
    "TTS precisa cair em Cedar quando não houver override válido",
  );
  assert(
    healthcheck.includes('const DEFAULT_VOICE = "cedar";'),
    "healthcheck precisa validar a mesma voz do runtime",
  );
  for (const requiredInstruction of [
    "adult male",
    "neutral Brazilian Portuguese",
    "never use European Portuguese",
    "personal video call",
  ]) {
    assert(
      realtime.includes(requiredInstruction),
      `Realtime não contém a instrução: ${requiredInstruction}`,
    );
  }
  for (const assignment of [
    "OPENAI_REALTIME_VOICE=cedar",
    "WOLFIE_TTS_VOICE_EN=cedar",
    "WOLFIE_TTS_VOICE_PT=cedar",
  ]) {
    assert(envExample.includes(assignment), `configuração ausente: ${assignment}`);
  }
});
