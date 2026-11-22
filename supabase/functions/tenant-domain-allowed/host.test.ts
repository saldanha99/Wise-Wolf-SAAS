/// <reference lib="deno.ns" />
import { normalizeAskHost } from "./host.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("ask host normalization", () => {
  assert(
    normalizeAskHost("Demo-Escola.WiseWolfLanguage.com.br.") ===
      "demo-escola.wisewolflanguage.com.br",
    "normalize",
  );
  assert(normalizeAskHost(null) === null, "null");
  assert(normalizeAskHost("") === null, "empty");
  assert(normalizeAskHost("localhost") === null, "single label");
  assert(normalizeAskHost("a..b.com") === null, "empty label");
  assert(normalizeAskHost("x_y.com") === null, "underscore");
  assert(normalizeAskHost("1.2.3.4") !== undefined, "ip handled by db");
  assert(normalizeAskHost("-bad.com") === null, "leading hyphen");
});
