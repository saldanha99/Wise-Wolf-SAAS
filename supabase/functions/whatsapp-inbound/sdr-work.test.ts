/// <reference lib="deno.ns" />
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runSdrWork } from "./sdr-work.ts";

Deno.test("busy conversation doesn't run a second responder", async () => {
  const sb = { rpc: () => Promise.resolve({ data: { claimed: false } }) };
  let calls = 0;
  assertEquals(
    await runSdrWork(sb, "t", "p", async () => {
      calls++;
    }),
    false,
  );
  assertEquals(calls, 0);
});

Deno.test("obsolete response cannot start effects and completion retains the newer input", async () => {
  const calls: string[] = [];
  const sb = {
    rpc: (name: string) => {
      calls.push(name);
      return Promise.resolve({
        data: name === "claim_sdr_work"
          ? { claimed: true, token: "token", payload: {} }
          : false,
      });
    },
  };
  await runSdrWork(sb, "t", "p", async (_input, begin) => {
    assertEquals(await begin(), false);
  });
  assertEquals(calls, [
    "claim_sdr_work",
    "begin_sdr_effects",
    "finish_sdr_work",
  ]);
});

Deno.test("failed side effects finalize as uncertain instead of re-running the response", async () => {
  const completions: boolean[] = [];
  const sb = {
    rpc: (name: string, args: any) => {
      if (name === "finish_sdr_work") completions.push(args.p_success);
      return Promise.resolve({
        data: name === "claim_sdr_work"
          ? { claimed: true, token: "t", payload: {} }
          : true,
      });
    },
  };
  await assertRejects(() =>
    runSdrWork(sb, "t", "p", async (_input, begin) => {
      assertEquals(await begin(), true);
      throw new Error("transport interruption");
    })
  );
  assertEquals(completions, [false]);
});

Deno.test("a turn authorizes effects once and finishes once", async () => {
  let effects = 0;
  let finished = 0;
  const sb = {
    rpc: (name: string) => {
      if (name === "begin_sdr_effects") effects++;
      if (name === "finish_sdr_work") finished++;
      return Promise.resolve({
        data: name === "claim_sdr_work"
          ? { claimed: true, token: "t", payload: {} }
          : true,
      });
    },
  };
  await runSdrWork(sb, "t", "p", async (_input, begin) => {
    await begin();
    await begin();
  });
  assertEquals(effects, 1);
  assertEquals(finished, 1);
});
