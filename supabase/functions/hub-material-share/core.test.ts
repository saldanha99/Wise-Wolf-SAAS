import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  isShareToken,
  newShareToken,
  sha256Hex,
  shareUrl,
  statusForCode,
} from "./core.ts";

Deno.test("token aleatório em base64url e reconhecido", () => {
  const a = newShareToken();
  const b = newShareToken();
  assert(a !== b);
  assert(isShareToken(a));
  assert(!isShareToken("curto"));
  assert(!isShareToken("x".repeat(43) + "/"));
});

Deno.test("link só https (ou localhost) e com o token escapado", () => {
  assertEquals(
    shareUrl("abc", undefined),
    "https://hub.wisewolflanguage.com.br/?atividade=abc",
  );
  assertEquals(
    shareUrl("abc", "http://evil.example"),
    "https://hub.wisewolflanguage.com.br/?atividade=abc",
  );
  assertEquals(
    shareUrl("abc", "https://user:pw@hub.example.com"),
    "https://hub.wisewolflanguage.com.br/?atividade=abc",
  );
  assertEquals(
    shareUrl("abc", "http://localhost:5173/x"),
    "http://localhost:5173/?atividade=abc",
  );
});

Deno.test("hash e status", async () => {
  assertEquals((await sha256Hex("a")).length, 64);
  assertEquals(statusForCode("LINK_EXPIRED"), 410);
  assertEquals(statusForCode("LINK_INVALID"), 404);
  assertEquals(statusForCode("MATERIAL_ACCESS_DENIED"), 403);
});
