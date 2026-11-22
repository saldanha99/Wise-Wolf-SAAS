import {
  applyTutorPersona,
  type TutorPersona,
} from "../_shared/tutor-persona.ts";
import type { TutorVoiceGender } from "../_shared/tutor-voice.ts";

const REALTIME_ROLE_LINE =
  /You are Wolfie Tutor, Wise Wolf's warm, patient, concise real-time English tutor\./;

/**
 * White label da voz ao vivo: troca a linha de papel e põe a IDENTITY do
 * tutor-persona no topo. Sem persona (Wise Wolf), o texto não muda.
 */
export function brandRealtimeInstructions(
  instructions: string,
  persona: TutorPersona | null,
): string {
  if (!persona) return instructions;
  const { tutorName, schoolName } = persona;
  const roled = instructions.replace(
    REALTIME_ROLE_LINE,
    `You are ${tutorName}, ${schoolName}'s warm, patient, concise real-time English tutor.`,
  );
  return applyTutorPersona(roled, persona);
}

const MALE_IDENTITY_LINE =
  "Keep one consistent adult male identity with a warm medium-low register.";
const MALE_AVOID_TAIL = "childish, or feminine delivery.";

/**
 * Voz escolhida pela escola: com voz feminina, a identidade de voz das
 * instruções passa a ser feminina. Masculina (padrão) não muda o texto.
 */
export function applyVoiceGender(
  instructions: string,
  gender: TutorVoiceGender,
): string {
  if (gender !== "female") return instructions;
  return instructions
    .replace(
      MALE_IDENTITY_LINE,
      "Keep one consistent adult female identity with a warm, natural medium register.",
    )
    .replace(MALE_AVOID_TAIL, "childish, or masculine delivery.");
}
