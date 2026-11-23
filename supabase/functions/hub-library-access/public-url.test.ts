import { assertEquals, assertThrows } from "jsr:@std/assert@1";

import { publicHubSignedUrl } from "./public-url.ts";

const INTERNAL =
  "http://kong:8000/storage/v1/object/sign/hub-library/pedagogical/abc/preview.pdf?token=t0k.en";

Deno.test("troca a origem interna pela pública, mantendo caminho e token", () => {
  assertEquals(
    publicHubSignedUrl(INTERNAL, "https://api.wisewolflanguage.com.br"),
    "https://api.wisewolflanguage.com.br/storage/v1/object/sign/hub-library/pedagogical/abc/preview.pdf?token=t0k.en",
  );
});

Deno.test("ignora caminho na URL pública (só a origem conta)", () => {
  assertEquals(
    publicHubSignedUrl(
      INTERNAL,
      "https://api.wisewolflanguage.com.br/qualquer/coisa",
    ),
    "https://api.wisewolflanguage.com.br/storage/v1/object/sign/hub-library/pedagogical/abc/preview.pdf?token=t0k.en",
  );
});

Deno.test("sem URL pública configurada devolve a original", () => {
  assertEquals(publicHubSignedUrl(INTERNAL, undefined), INTERNAL);
  assertEquals(publicHubSignedUrl(INTERNAL, "  "), INTERNAL);
});

Deno.test("recusa URL pública insegura", () => {
  assertThrows(() => publicHubSignedUrl(INTERNAL, "http://api.exemplo.com"));
  assertThrows(() =>
    publicHubSignedUrl(INTERNAL, "https://user:pass@api.exemplo.com")
  );
});
