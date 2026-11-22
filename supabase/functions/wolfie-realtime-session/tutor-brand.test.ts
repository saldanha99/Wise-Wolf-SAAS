// deno-lint-ignore no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { brandRealtimeInstructions } from "./tutor-brand.ts";
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
