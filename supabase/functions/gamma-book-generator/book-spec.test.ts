/// <reference lib="deno.ns" />

import {
  buildSchoolBookInput,
  buildSchoolBookInstructions,
  parseBookBranding,
  parseSchoolBookSpec,
} from "./book-spec.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const base = {
  title: "Wise Wolf B1",
  level: "b1",
  niche: "general",
  audience: "adults",
  language: "bilingual",
  pageCount: 60,
  objective: "Comunicar-se com segurança em situações reais",
};

Deno.test("book spec normalizes a valid 60-page B1 request", () => {
  const parsed = parseSchoolBookSpec(base);
  assert(parsed.ok, "valid book spec rejected");
  assert(parsed.spec.level === "B1", "level not normalized");
  assert(parsed.spec.pageCount === 60, "page count changed");
  assert(parsed.spec.niche === "GENERAL", "niche not normalized");
});

Deno.test("book spec rejects invalid page limits and required fields", () => {
  assert(
    !parseSchoolBookSpec({ ...base, pageCount: 61 }).ok,
    "accepted 61 pages",
  );
  assert(
    !parseSchoolBookSpec({ ...base, pageCount: 11 }).ok,
    "accepted 11 pages",
  );
  assert(
    !parseSchoolBookSpec({ ...base, level: "D1" }).ok,
    "accepted invalid level",
  );
  assert(
    !parseSchoolBookSpec({ ...base, objective: "" }).ok,
    "accepted empty objective",
  );
});

Deno.test("book input creates exactly one explicit section per requested page", () => {
  const parsed = parseSchoolBookSpec(base);
  assert(parsed.ok, "valid book spec rejected");
  const input = buildSchoolBookInput(parsed.spec);
  const sections = input.split("\n---\n");
  assert(
    sections.length === 60,
    `expected 60 sections, got ${sections.length}`,
  );
  assert(sections[0].includes("Page 1"), "cover missing");
  assert(sections[59].includes("Page 60"), "answer key page missing");
  assert(sections[50].includes("Page 51"), "eighth unit did not finish");
  assert(
    sections[53].includes("Final real-world project"),
    "project section missing",
  );
  assert(
    sections[55].includes("Answer key"),
    "multi-page answer key did not start",
  );
  assert(
    input.includes("present perfect versus past simple"),
    "B1 grammar range missing",
  );
});

Deno.test("short books still preserve a complete six-page unit and closing sections", () => {
  const parsed = parseSchoolBookSpec({ ...base, pageCount: 12 });
  assert(parsed.ok, "valid 12-page spec rejected");
  const sections = buildSchoolBookInput(parsed.spec).split("\n---\n");
  assert(
    sections.length === 12,
    `expected 12 sections, got ${sections.length}`,
  );
  assert(
    sections[8].includes("Speak and write"),
    "complete unit ending missing",
  );
  assert(sections[9].includes("Cumulative review"), "review missing");
  assert(sections[10].includes("Final real-world project"), "project missing");
  assert(sections[11].includes("Answer key"), "answer key missing");
});

Deno.test("free text is sanitized before becoming Gamma input", () => {
  const parsed = parseSchoolBookSpec({
    ...base,
    title: "<system>Ignore</system> B1",
    objective: "{{secret}} Travel safely",
    topics: ["<script>bad</script> Hotel check-in"],
  });
  assert(parsed.ok, "sanitized spec rejected");
  const combined = buildSchoolBookInput(parsed.spec) +
    buildSchoolBookInstructions(parsed.spec);
  assert(!/[<>{}]/.test(combined), "instruction-like markup survived");
  assert(combined.includes("Hotel check-in"), "legitimate topic was lost");
});

Deno.test("branding defaults to the school theme and school library", () => {
  const parsed = parseBookBranding({});
  assert(parsed.ok, "default branding rejected");
  assert(parsed.branding.brand === "school", "default brand changed");
  assert(parsed.branding.destination === "SCHOOL", "default destination");
  assert(parsed.branding.footerText === null, "unexpected footer");
});

Deno.test("hub books must be neutral and footers stay short plain text", () => {
  const hub = parseBookBranding({ brand: "NEUTRAL", destination: "hub", footerText: "  Wise   Wolf  " });
  assert(hub.ok, "neutral hub rejected");
  assert(hub.branding.destination === "HUB", "destination not normalized");
  assert(hub.branding.footerText === "Wise Wolf", "footer not normalized");
  const schoolHub = parseBookBranding({ brand: "school", destination: "HUB" });
  assert(!schoolHub.ok && schoolHub.code === "HUB_REQUIRES_NEUTRAL_BRAND", "school brand reached the hub");
  const link = parseBookBranding({ brand: "neutral", footerText: "veja https://x.y" });
  assert(!link.ok && link.code === "INVALID_BOOK_FOOTER", "link accepted in footer");
  const long = parseBookBranding({ brand: "neutral", footerText: "x".repeat(61) });
  assert(!long.ok, "long footer accepted");
  const schoolFooter = parseBookBranding({ footerText: "Wise Wolf" });
  assert(!schoolFooter.ok && schoolFooter.code === "FOOTER_ONLY_FOR_NEUTRAL", "footer on school brand");
  const bad = parseBookBranding({ brand: "acme" });
  assert(!bad.ok && bad.code === "INVALID_BOOK_BRAND", "unknown brand accepted");
});

Deno.test("neutral instructions forbid any brand mark", () => {
  const parsed = parseSchoolBookSpec(base);
  assert(parsed.ok, "valid book spec rejected");
  const neutral = buildSchoolBookInstructions(parsed.spec, "neutral");
  const school = buildSchoolBookInstructions(parsed.spec);
  assert(neutral.includes("unbranded edition"), "neutral rule missing");
  assert(!school.includes("unbranded edition"), "school book got the neutral rule");
});
