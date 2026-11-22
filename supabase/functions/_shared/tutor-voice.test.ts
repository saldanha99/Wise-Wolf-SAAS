// deno-lint-ignore no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEFAULT_TUTOR_VOICE,
  TUTOR_VOICES,
  tutorVoiceFromBranding,
} from "./tutor-voice.ts";

Deno.test("sem tutorVoice (Wise Wolf) não há voz da escola", () => {
  assertEquals(tutorVoiceFromBranding({}), null);
  assertEquals(tutorVoiceFromBranding(null), null);
  assertEquals(tutorVoiceFromBranding({ tutorVoice: "nova" }), null);
  assertEquals(tutorVoiceFromBranding({ tutorVoice: 42 }), null);
});

Deno.test("voz da lista volta com o gênero", () => {
  assertEquals(tutorVoiceFromBranding({ tutorVoice: "marin" }), {
    voice: "marin",
    gender: "female",
    fromBranding: true,
  });
  assertEquals(tutorVoiceFromBranding({ tutorVoice: "ash" })?.gender, "male");
});

Deno.test("lista curta: 3 femininas, 3 masculinas, padrão cedar masculina", () => {
  assertEquals(TUTOR_VOICES.filter((v) => v.gender === "female").length, 3);
  assertEquals(TUTOR_VOICES.filter((v) => v.gender === "male").length, 3);
  assertEquals(
    TUTOR_VOICES.find((v) => v.id === DEFAULT_TUTOR_VOICE)?.gender,
    "male",
  );
});
