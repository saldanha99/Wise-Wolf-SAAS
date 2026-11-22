/**
 * White label: cada escola escolhe a voz do tutor (decisão do Vinícius, 22/11/2026).
 * `tenants.branding.tutorVoice` guarda o id da voz; sem ela (ou inválida) vale a voz
 * atual do Wolfie (cedar, masculina) e o texto das instruções não muda.
 * Arquivo sem dependência de Deno: também é importado pelo front (tela de marca).
 */
export type TutorVoiceGender = "female" | "male";

export interface TutorVoiceOption {
  id: string;
  label: string;
  description: string;
  gender: TutorVoiceGender;
}

// Só vozes aceitas pelo GPT Realtime E pelo gpt-4o-mini-tts (a voz clássica usa a mesma).
export const TUTOR_VOICES: readonly TutorVoiceOption[] = [
  {
    id: "marin",
    label: "Marin",
    description: "calorosa e natural",
    gender: "female",
  },
  {
    id: "coral",
    label: "Coral",
    description: "alegre e próxima",
    gender: "female",
  },
  {
    id: "shimmer",
    label: "Shimmer",
    description: "leve e clara",
    gender: "female",
  },
  {
    id: "cedar",
    label: "Cedar",
    description: "voz atual do Wolfie",
    gender: "male",
  },
  { id: "ash", label: "Ash", description: "firme e animada", gender: "male" },
  {
    id: "echo",
    label: "Echo",
    description: "tranquila e grave",
    gender: "male",
  },
];

export const DEFAULT_TUTOR_VOICE = "cedar";

export interface TutorVoice {
  voice: string;
  gender: TutorVoiceGender;
  /** true quando veio da marca da escola (e não do padrão). */
  fromBranding: boolean;
}

export function tutorVoiceOption(id: unknown): TutorVoiceOption | null {
  if (typeof id !== "string") return null;
  return TUTOR_VOICES.find((option) => option.id === id) ?? null;
}

export function tutorVoiceFromBranding(branding: unknown): TutorVoice | null {
  const record =
    branding && typeof branding === "object" && !Array.isArray(branding)
      ? branding as Record<string, unknown>
      : {};
  const option = tutorVoiceOption(record.tutorVoice);
  return option
    ? { voice: option.id, gender: option.gender, fromBranding: true }
    : null;
}
