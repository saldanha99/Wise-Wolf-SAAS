// deno-lint-ignore no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyVoiceGender, brandRealtimeInstructions } from "./tutor-brand.ts";
import { tutorPersonaFromTenant } from "../_shared/tutor-persona.ts";

const base = `
# ROLE
You are Wolfie Tutor, Wise Wolf's warm, patient, concise real-time English tutor.
# APPROVED WOLFIE_TUTOR KNOWLEDGE EXCERPTS
`;

Deno.test("Wise Wolf (sem tutorName) não muda", () => {
  assertEquals(
    brandRealtimeInstructions(base, tutorPersonaFromTenant("Wise Wolf", {})),
    base,
  );
  assertEquals(
    brandRealtimeInstructions(
      base,
      tutorPersonaFromTenant("Wise Wolf", { tutorName: "Wolfie" }),
    ),
    base,
  );
});

Deno.test("escola com tutorName se apresenta com o nome dela", () => {
  const persona = tutorPersonaFromTenant("Escola Demo", { tutorName: "Luna" });
  const out = brandRealtimeInstructions(base, persona);
  assert(
    out.startsWith(
      "IDENTITY: Your name is Luna, the AI English tutor of Escola Demo.",
    ),
  );
  assert(out.includes("You are Luna, Escola Demo's warm, patient"));
  assert(!out.includes("You are Wolfie Tutor"));
  assert(!out.includes("Wise Wolf's"));
});

const voiceBlock =
  `- Keep one consistent adult male identity with a warm medium-low register.
- Avoid announcer, synthetic, exaggerated, childish, or feminine delivery.`;

Deno.test("voz masculina (padrão) não muda a identidade de voz", () => {
  assertEquals(applyVoiceGender(voiceBlock, "male"), voiceBlock);
});

Deno.test("voz feminina troca a identidade de voz", () => {
  const out = applyVoiceGender(voiceBlock, "female");
  assert(out.includes("adult female identity"));
  assert(out.includes("childish, or masculine delivery."));
  assert(!out.includes("adult male identity"));
});

Deno.test("as frases que a voz feminina troca existem no prompt real", async () => {
  const realtime = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );
  assert(realtime.includes(voiceBlock.split("\n")[0].slice(2)));
  assert(realtime.includes("childish, or feminine delivery."));
  const tts = await Deno.readTextFile(
    new URL("../wolfie-tts/index.ts", import.meta.url),
  );
  for (
    const phrase of [
      "the same warm adult male voice with a medium-low register",
      "voz adulta masculina, acolhedora, natural e segura, em registro médio-grave",
      "the same warm adult male identity in a natural medium-low register",
    ]
  ) {
    // aparece 2x: no texto-base e no replace da versão feminina
    assert(
      tts.split(phrase).length - 1 >= 2,
      `frase ausente no wolfie-tts: ${phrase}`,
    );
  }
});
