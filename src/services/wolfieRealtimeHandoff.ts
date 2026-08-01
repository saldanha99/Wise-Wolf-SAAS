import { supabase } from "../../lib/supabase";

export interface WolfieRealtimeHandoffResult {
  conversationId: string;
  currentStage: string;
  scenarioStatus: string;
  requiresRetry: boolean | null;
  reused: boolean;
}

export class WolfieRealtimeHandoffError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "WolfieRealtimeHandoffError";
  }
}

interface HandoffOptions {
  signal?: AbortSignal;
  retryDelaysMs?: readonly number[];
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const readString = (
  record: Record<string, unknown>,
  ...keys: string[]
): string => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
};

async function handoffErrorCode(
  payload: Record<string, unknown>,
  error: unknown,
): Promise<string> {
  const direct = readString(payload, "code", "error");
  if (direct) return direct;
  const context = asRecord(error).context;
  if (context instanceof Response) {
    try {
      const responsePayload = asRecord(await context.clone().json());
      const responseCode = readString(responsePayload, "code", "error");
      if (responseCode) return responseCode;
    } catch {
      // Fall through to the SDK message when the response is not JSON.
    }
  }
  return error instanceof Error && error.message
    ? error.message
    : "REALTIME_HANDOFF_FAILED";
}

const waitForRetry = async (
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> => {
  if (delayMs <= 0) return;
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      globalThis.clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timeoutId = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

/**
 * Atomically changes only the transport of an existing pedagogical session.
 * A pending flush is retried with the exact same conversation id, so a
 * network ambiguity can never create a second Wolfie session.
 */
export async function handoffWolfieRealtimeToClassic(
  conversationId: string,
  options: HandoffOptions = {},
): Promise<WolfieRealtimeHandoffResult> {
  const stableConversationId = conversationId.trim();
  if (!stableConversationId) {
    throw new WolfieRealtimeHandoffError("CONVERSATION_ID_REQUIRED");
  }
  const retryDelaysMs = options.retryDelaysMs ?? [0, 250, 750, 1_500];
  let lastCode = "REALTIME_HANDOFF_FAILED";

  for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
    await waitForRetry(retryDelaysMs[attempt] ?? 0, options.signal);
    const { data, error } = await supabase.functions.invoke("wolfie-brain", {
      body: {
        action: "handoff_realtime_to_classic",
        conversationId: stableConversationId,
      },
      signal: options.signal,
    });
    const payload = asRecord(data);
    const returnedConversationId = readString(
      payload,
      "conversationId",
      "conversation_id",
    );
    if (
      !error &&
      payload.success === true &&
      payload.handedOff === true &&
      returnedConversationId === stableConversationId
    ) {
      return {
        conversationId: stableConversationId,
        currentStage: readString(payload, "currentStage", "current_stage"),
        scenarioStatus: readString(
          payload,
          "scenarioStatus",
          "scenario_status",
        ),
        requiresRetry: typeof payload.requiresRetry === "boolean"
          ? payload.requiresRetry
          : typeof payload.requires_retry === "boolean"
          ? payload.requires_retry
          : null,
        reused: payload.reused === true,
      };
    }

    lastCode = await handoffErrorCode(payload, error);
    if (
      lastCode === "REALTIME_HANDOFF_PENDING" &&
      attempt < retryDelaysMs.length - 1
    ) continue;
    throw new WolfieRealtimeHandoffError(lastCode);
  }

  throw new WolfieRealtimeHandoffError(lastCode);
}
