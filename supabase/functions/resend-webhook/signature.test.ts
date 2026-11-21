import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { verifySvixSignature } from "./signature.ts";

// Vetor de teste publicado pelo Svix
// (https://docs.svix.com/receiving/verifying-payloads/how-manual).
const vector = {
  secret: "whsec_plJ3nmyCDGBKInavdOK15jsl",
  id: "msg_loFOjxBNrRLzqYUf",
  timestamp: "1731705121",
  body: '{"event_type":"ping","data":{"success":true}}',
  signature: "v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=",
  nowSeconds: 1731705121,
};

Deno.test("Svix signature: the published test vector is valid", async () => {
  assert(await verifySvixSignature(vector));
  // Lista com outra versão/assinatura antes da válida continua valendo.
  assert(
    await verifySvixSignature({
      ...vector,
      signature: `v1,AAAA ${vector.signature}`,
    }),
  );
});

Deno.test("Svix signature: tampered body, signature or secret is rejected", async () => {
  assertEquals(
    await verifySvixSignature({ ...vector, body: vector.body + " " }),
    false,
  );
  assertEquals(
    await verifySvixSignature({
      ...vector,
      signature: "v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD1=",
    }),
    false,
  );
  assertEquals(
    await verifySvixSignature({
      ...vector,
      signature: vector.signature.replace("v1,", "v2,"),
    }),
    false,
  );
  assertEquals(
    await verifySvixSignature({ ...vector, secret: "whsec_b3V0cm8=" }),
    false,
  );
  assertEquals(
    await verifySvixSignature({
      ...vector,
      secret: vector.secret.replace("whsec_", ""),
    }),
    false,
  );
});

Deno.test("Svix signature: missing headers or secret fail closed", async () => {
  for (
    const change of [
      { secret: undefined },
      { secret: "" },
      { id: null },
      { timestamp: null },
      { signature: null },
      { signature: "" },
      { timestamp: "não-é-número" },
    ]
  ) {
    assertEquals(await verifySvixSignature({ ...vector, ...change }), false);
  }
});

Deno.test("Svix signature: timestamp outside 5 minutes is a replay", async () => {
  assertEquals(
    await verifySvixSignature({ ...vector, nowSeconds: 1731705121 + 301 }),
    false,
  );
  assertEquals(
    await verifySvixSignature({ ...vector, nowSeconds: 1731705121 - 301 }),
    false,
  );
  assert(
    await verifySvixSignature({ ...vector, nowSeconds: 1731705121 + 299 }),
  );
});
