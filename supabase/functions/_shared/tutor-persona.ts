/**
 * White label: o tutor se apresenta com o nome da escola cliente.
 * Para a Wise Wolf (sem tutorName ou "Wolfie") o prompt não muda.
 */
export interface TutorPersona {
  tutorName: string;
  schoolName: string;
}

const clean = (value: unknown, max: number): string =>
  typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f`"\\]/g, " ").replace(/\s+/g, " ")
      .trim().slice(0, max)
    : "";

export function tutorPersonaFromTenant(
  tenantName: unknown,
  branding: unknown,
): TutorPersona | null {
  const record =
    branding && typeof branding === "object" && !Array.isArray(branding)
      ? branding as Record<string, unknown>
      : {};
  const tutorName = clean(record.tutorName, 40);
  if (!tutorName || tutorName.toLowerCase() === "wolfie") return null;
  const schoolName = clean(record.appName, 80) || clean(tenantName, 80) ||
    "the school";
  return { tutorName, schoolName };
}

export function applyTutorPersona(
  prompt: string,
  persona: TutorPersona | null,
): string {
  if (!persona) return prompt;
  const { tutorName, schoolName } = persona;
  const branded = prompt
    .replace(
      /You are WOLFIE, the Wise Wolf Languages AI tutor\./,
      `You are ${tutorName}, the ${schoolName} AI tutor.`,
    )
    .replace(
      /Keep the Wise Wolf personality/g,
      `Keep the ${tutorName} personality`,
    )
    .replace(/\bWOLFIE\b/g, tutorName);
  return `IDENTITY: Your name is ${tutorName}, the AI English tutor of ${schoolName}. Always introduce yourself as ${tutorName}. Never call yourself Wolfie and never mention Wise Wolf.\n\n${branded}`;
}
