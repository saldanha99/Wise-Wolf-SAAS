import {
  applyTutorPersona,
  type TutorPersona,
} from "../_shared/tutor-persona.ts";

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
