/// <reference lib="deno.ns" />
import { applyTutorPersona, tutorPersonaFromTenant } from "./tutor-persona.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const base =
  "You are WOLFIE, the Wise Wolf Languages AI tutor. You are transparent.\nSESSION VOICE: x. Keep the Wise Wolf personality stable.";

Deno.test("Wise Wolf keeps Wolfie", () => {
  assert(
    tutorPersonaFromTenant("Wise Wolf Languages", {}) === null,
    "no tutorName",
  );
  assert(
    tutorPersonaFromTenant("X", { tutorName: "Wolfie" }) === null,
    "Wolfie",
  );
  assert(applyTutorPersona(base, null) === base, "unchanged");
});

Deno.test("white label renames the tutor", () => {
  const persona = tutorPersonaFromTenant("Escola Demo", {
    tutorName: " Luna ",
  });
  assert(
    persona?.tutorName === "Luna" && persona.schoolName === "Escola Demo",
    "persona",
  );
  const out = applyTutorPersona(base, persona);
  assert(
    out.startsWith(
      "IDENTITY: Your name is Luna, the AI English tutor of Escola Demo.",
    ),
    "identity",
  );
  assert(out.includes("You are Luna, the Escola Demo AI tutor."), "first line");
  assert(!/WOLFIE|Wise Wolf personality/.test(out), "old name left");
});

Deno.test("names are sanitized", () => {
  const persona = tutorPersonaFromTenant("A", {
    tutorName: 'Lu"na`\n',
    appName: "Escola\u0000 Y",
  });
  assert(
    persona?.tutorName === "Lu na" && persona.schoolName === "Escola Y",
    "sanitized",
  );
});
