/// <reference lib="deno.ns" />

import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test({
  name: "retired sync-payments is authenticated, immutable and returns 410",
  permissions: { read: true },
  async fn() {
    const source = await Deno.readTextFile(
      new URL("./index.ts", import.meta.url),
    );

    assertStringIncludes(source, "authorizeRequest(req");
    assertStringIncludes(source, "status: 410");
    assertStringIncludes(source, 'error: "sync_payments_retired"');
    assert(
      source.indexOf("authorizeRequest(req") <
        source.indexOf("retiredResponse()"),
      "authorization must happen before the retired response",
    );

    for (
      const forbiddenMutation of [
        ".from(",
        ".rpc(",
        ".insert(",
        ".update(",
        ".upsert(",
        ".delete(",
        "auth.context.admin",
      ]
    ) {
      assert(
        !source.includes(forbiddenMutation),
        `retired endpoint must not contain ${forbiddenMutation}`,
      );
    }
  },
});
