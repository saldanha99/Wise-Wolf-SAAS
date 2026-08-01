import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("../../lib/supabase", () => ({
  supabase: { functions: { invoke } },
}));

import {
  handoffWolfieRealtimeToClassic,
  WolfieRealtimeHandoffError,
} from "./wolfieRealtimeHandoff";

const functionError = (code: string) => ({
  message: "Edge Function returned a non-2xx status code",
  context: new Response(JSON.stringify({ error: code, code }), {
    status: 409,
    headers: { "content-type": "application/json" },
  }),
});

describe("Realtime to classic handoff", () => {
  beforeEach(() => invoke.mockReset());

  it("waits for the Realtime flush and retries idempotently with the same conversation id", async () => {
    invoke
      .mockResolvedValueOnce({
        data: null,
        error: functionError("REALTIME_HANDOFF_PENDING"),
      })
      .mockResolvedValueOnce({
        data: {
          success: true,
          handedOff: true,
          conversationId: "conversation-1",
          currentStage: "objection_handling",
          scenarioStatus: "awaiting_retry",
          requiresRetry: true,
          reused: true,
        },
        error: null,
      });

    const result = await handoffWolfieRealtimeToClassic("conversation-1", {
      retryDelaysMs: [0, 0],
    });

    expect(result).toEqual(
      expect.objectContaining({
        conversationId: "conversation-1",
        currentStage: "objection_handling",
        requiresRetry: true,
      }),
    );
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls.map(([, options]) => options.body)).toEqual([
      {
        action: "handoff_realtime_to_classic",
        conversationId: "conversation-1",
      },
      {
        action: "handoff_realtime_to_classic",
        conversationId: "conversation-1",
      },
    ]);
  });

  it("reports a terminal session without replacing its id locally", async () => {
    invoke.mockResolvedValue({
      data: null,
      error: functionError("CONVERSATION_FINISHED"),
    });

    await expect(
      handoffWolfieRealtimeToClassic("conversation-1", {
        retryDelaysMs: [0],
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<WolfieRealtimeHandoffError>>({
        code: "CONVERSATION_FINISHED",
      }),
    );
  });
});
