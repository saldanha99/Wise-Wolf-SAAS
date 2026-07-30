export type WolfieRealtimePhase =
  | "idle"
  | "requesting_permission"
  | "connecting"
  | "connected"
  | "listening"
  | "thinking"
  | "speaking"
  | "closing"
  | "fallback"
  | "error";

export interface WolfieRealtimeServerEvent {
  type: string;
  [key: string]: unknown;
}

export interface WolfieRealtimeProtocolState {
  phase: WolfieRealtimePhase;
  isUserSpeaking: boolean;
  isAssistantSpeaking: boolean;
  userTranscript: string;
  assistantTranscript: string;
  lastUserTranscript: string;
  lastAssistantTranscript: string;
  /**
   * A rough, uncalibrated ASR signal derived from token log probabilities.
   * It must never be used as evidence that a personal fact is true.
   */
  userTranscriptConfidence: number | null;
  inputTranscriptIsRoughGuide: true;
  lastEventType: string | null;
  responseId: string | null;
  error: string | null;
  inputLogprobSum: number;
  inputLogprobCount: number;
  activeInputItemId: string | null;
  inputDrafts: Record<
    string,
    { text: string; logprobSum: number; logprobCount: number }
  >;
}

export type WolfieRealtimeProtocolAction =
  | { type: "local.phase"; phase: WolfieRealtimePhase }
  | { type: "local.reset" }
  | { type: "local.error"; message: string }
  | { type: "server.event"; event: WolfieRealtimeServerEvent };

export const initialWolfieRealtimeProtocolState =
  (): WolfieRealtimeProtocolState => ({
    phase: "idle",
    isUserSpeaking: false,
    isAssistantSpeaking: false,
    userTranscript: "",
    assistantTranscript: "",
    lastUserTranscript: "",
    lastAssistantTranscript: "",
    userTranscriptConfidence: null,
    inputTranscriptIsRoughGuide: true,
    lastEventType: null,
    responseId: null,
    error: null,
    inputLogprobSum: 0,
    inputLogprobCount: 0,
    activeInputItemId: null,
    inputDrafts: {},
  });

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const stringField = (
  record: Record<string, unknown>,
  name: string,
): string => typeof record[name] === "string" ? record[name] as string : "";

const responseId = (event: Record<string, unknown>): string | null => {
  const response = asRecord(event.response);
  return stringField(event, "response_id") ||
    (response ? stringField(response, "id") : "") ||
    null;
};

function eventErrorMessage(event: Record<string, unknown>): string {
  const error = asRecord(event.error);
  const message = error ? stringField(error, "message") : "";
  return message.slice(0, 500) || "O modo de voz encontrou um erro.";
}

function appendTranscript(current: string, delta: string): string {
  if (!delta) return current;
  return `${current}${delta}`.slice(-8_000);
}

export function wolfieRealtimeEventLogprobs(
  event: Record<string, unknown>,
): number[] {
  if (!Array.isArray(event.logprobs)) return [];
  return event.logprobs.flatMap((entry) => {
    const record = asRecord(entry);
    const value = record?.logprob;
    return typeof value === "number" && Number.isFinite(value)
      ? [Math.min(0, Math.max(-20, value))]
      : [];
  });
}

function roughConfidence(sum: number, count: number): number | null {
  if (!count) return null;
  return Math.min(1, Math.max(0, Math.exp(sum / count)));
}

/**
 * Returns an uncalibrated token-probability guide in the 0..1 range.
 * This is useful for deciding whether to ask the learner to repeat audio, but
 * is not a factual-confidence score.
 */
export function estimateRoughAsrConfidence(
  event: WolfieRealtimeServerEvent,
): number | null {
  const values = wolfieRealtimeEventLogprobs(event);
  return roughConfidence(
    values.reduce((sum, value) => sum + value, 0),
    values.length,
  );
}

function inputItemId(
  event: Record<string, unknown>,
  fallback: string | null,
): string {
  return stringField(event, "item_id") || fallback || "__unmatched_input__";
}

function withoutDraft(
  drafts: WolfieRealtimeProtocolState["inputDrafts"],
  itemId: string,
): WolfieRealtimeProtocolState["inputDrafts"] {
  if (!(itemId in drafts)) return drafts;
  const next = { ...drafts };
  delete next[itemId];
  return next;
}

function responseStatus(event: Record<string, unknown>): string {
  const response = asRecord(event.response);
  return response ? stringField(response, "status") : "";
}

/**
 * Extracts the final text/audio transcript from a response.done payload.
 * Realtime returns the completed output tree on response.done, which is the
 * safest fallback when a transcript-done event was delayed or omitted.
 */
export function extractWolfieRealtimeResponseTranscript(
  event: WolfieRealtimeServerEvent,
): string {
  const response = asRecord(event.response);
  if (!response || !Array.isArray(response.output)) return "";

  const fragments: string[] = [];
  for (const output of response.output) {
    const item = asRecord(output);
    if (!item || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      const part = asRecord(content);
      if (!part) continue;
      const text = stringField(part, "transcript") || stringField(part, "text");
      if (text) fragments.push(text);
    }
  }
  return fragments.join(" ").replace(/\s+/g, " ").trim().slice(0, 8_000);
}

export type WolfieRealtimeTurnInputMethod = "audio_transcription" | "text";

export interface WolfieRealtimeTurnInput {
  key: string;
  text: string;
  inputMethod: WolfieRealtimeTurnInputMethod;
  asrConfidence: number | null;
}

export interface WolfieRealtimeTurnPair {
  id: string;
  input: WolfieRealtimeTurnInput;
  responseId: string;
  assistantTranscript: string;
}

interface CompletedAssistant {
  text: string;
  status: string;
}

const MAX_TRACKED_REALTIME_TURNS = 128;

/**
 * Pairs default-conversation inputs and responses without assuming that ASR
 * completion events arrive in turn order. Audio is committed in conversation
 * order, while transcription is asynchronous and keyed by item_id.
 */
export class WolfieRealtimeTurnAssembler {
  private readonly inputs = new Map<string, WolfieRealtimeTurnInput>();
  private readonly pendingInputKeys: string[] = [];
  private readonly waitingResponseIds: string[] = [];
  private readonly responseToInput = new Map<string, string>();
  private readonly completedAssistants = new Map<string, CompletedAssistant>();
  private readonly assistantDrafts = new Map<string, string>();
  private readonly committedInputs = new Set<string>();
  private readonly knownResponses = new Set<string>();
  private readonly discardedInputs = new Set<string>();
  private readonly completedPairs = new Set<string>();

  reset(): void {
    this.inputs.clear();
    this.pendingInputKeys.length = 0;
    this.waitingResponseIds.length = 0;
    this.responseToInput.clear();
    this.completedAssistants.clear();
    this.assistantDrafts.clear();
    this.committedInputs.clear();
    this.knownResponses.clear();
    this.discardedInputs.clear();
    this.completedPairs.clear();
  }

  commitInput(key: string): WolfieRealtimeTurnPair[] {
    const normalizedKey = key.trim().slice(0, 200);
    if (
      !normalizedKey || this.committedInputs.has(normalizedKey) ||
      this.discardedInputs.has(normalizedKey)
    ) {
      return [];
    }
    this.committedInputs.add(normalizedKey);

    const waitingResponse = this.waitingResponseIds.shift();
    if (waitingResponse) {
      this.responseToInput.set(waitingResponse, normalizedKey);
    } else {
      this.pendingInputKeys.push(normalizedKey);
    }
    this.prune();
    return this.flushReadyPairs();
  }

  completeInput(input: WolfieRealtimeTurnInput): WolfieRealtimeTurnPair[] {
    const key = input.key.trim().slice(0, 200);
    const text = input.text.trim().slice(0, 8_000);
    if (!key || !text || this.discardedInputs.has(key)) return [];
    this.inputs.set(key, { ...input, key, text });
    this.prune();
    return this.flushReadyPairs();
  }

  beginResponse(responseId: string): WolfieRealtimeTurnPair[] {
    const id = responseId.trim().slice(0, 200);
    if (!id || this.knownResponses.has(id)) return [];
    this.knownResponses.add(id);

    const inputKey = this.pendingInputKeys.shift();
    if (inputKey) {
      this.responseToInput.set(id, inputKey);
    } else {
      this.waitingResponseIds.push(id);
    }
    this.prune();
    return this.flushReadyPairs();
  }

  appendAssistant(responseId: string, delta: string): void {
    const id = responseId.trim().slice(0, 200);
    if (!id || !delta) return;
    const current = this.assistantDrafts.get(id) ?? "";
    this.assistantDrafts.set(id, `${current}${delta}`.slice(-8_000));
    this.prune();
  }

  setAssistant(
    responseId: string,
    text: string,
  ): WolfieRealtimeTurnPair[] {
    const id = responseId.trim().slice(0, 200);
    const completed = text.trim().slice(0, 8_000);
    if (!id || !completed) return [];
    this.assistantDrafts.set(id, completed);
    return this.flushReadyPairs();
  }

  finishResponse(
    responseId: string,
    status: string,
    finalText = "",
  ): WolfieRealtimeTurnPair[] {
    const id = responseId.trim().slice(0, 200);
    if (!id) return [];
    if (!this.knownResponses.has(id)) this.beginResponse(id);

    const normalizedStatus = status.trim().toLowerCase() || "completed";
    if (normalizedStatus !== "completed") {
      this.discardResponse(id);
      return [];
    }

    const text = (finalText || this.assistantDrafts.get(id) || "")
      .trim()
      .slice(0, 8_000);
    this.completedAssistants.set(id, {
      text,
      status: normalizedStatus,
    });
    this.prune();
    return this.flushReadyPairs();
  }

  discardResponse(responseId: string): void {
    const id = responseId.trim().slice(0, 200);
    if (!id) return;
    const inputKey = this.responseToInput.get(id);
    if (inputKey) {
      this.inputs.delete(inputKey);
      this.discardedInputs.add(inputKey);
      this.responseToInput.delete(id);
    }
    const waitingIndex = this.waitingResponseIds.indexOf(id);
    if (waitingIndex >= 0) this.waitingResponseIds.splice(waitingIndex, 1);
    this.completedAssistants.delete(id);
    this.assistantDrafts.delete(id);
    this.prune();
  }

  private flushReadyPairs(): WolfieRealtimeTurnPair[] {
    const ready: WolfieRealtimeTurnPair[] = [];
    for (const [responseId, assistant] of this.completedAssistants) {
      if (assistant.status !== "completed" || !assistant.text) continue;
      const inputKey = this.responseToInput.get(responseId);
      if (!inputKey) continue;
      const input = this.inputs.get(inputKey);
      if (!input) continue;

      const pairId = `${inputKey}:${responseId}`.slice(0, 400);
      if (!this.completedPairs.has(pairId)) {
        this.completedPairs.add(pairId);
        ready.push({
          id: pairId,
          input,
          responseId,
          assistantTranscript: assistant.text,
        });
      }
      this.inputs.delete(inputKey);
      this.completedAssistants.delete(responseId);
      this.assistantDrafts.delete(responseId);
      this.responseToInput.delete(responseId);
    }
    this.prune();
    return ready;
  }

  private prune(): void {
    while (this.pendingInputKeys.length > MAX_TRACKED_REALTIME_TURNS) {
      const key = this.pendingInputKeys.shift();
      if (key) {
        this.inputs.delete(key);
        this.committedInputs.delete(key);
      }
    }
    while (this.waitingResponseIds.length > MAX_TRACKED_REALTIME_TURNS) {
      const id = this.waitingResponseIds.shift();
      if (id) {
        this.knownResponses.delete(id);
        this.assistantDrafts.delete(id);
        this.completedAssistants.delete(id);
      }
    }
    const trimSet = (set: Set<string>) => {
      while (set.size > MAX_TRACKED_REALTIME_TURNS * 2) {
        const oldest = set.values().next().value as string | undefined;
        if (!oldest) break;
        set.delete(oldest);
      }
    };
    trimSet(this.committedInputs);
    trimSet(this.knownResponses);
    trimSet(this.discardedInputs);
    trimSet(this.completedPairs);
  }
}

function completeTranscript(
  current: string,
  completed: string,
): { current: string; last: string } {
  const finalText = (completed || current).trim().slice(0, 8_000);
  return { current: finalText, last: finalText };
}

export function parseWolfieRealtimeServerEvent(
  value: unknown,
): WolfieRealtimeServerEvent | null {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }

  const record = asRecord(parsed);
  if (!record || typeof record.type !== "string" || !record.type.trim()) {
    return null;
  }
  return record as WolfieRealtimeServerEvent;
}

export function reduceWolfieRealtimeProtocol(
  state: WolfieRealtimeProtocolState,
  action: WolfieRealtimeProtocolAction,
): WolfieRealtimeProtocolState {
  if (action.type === "local.reset") {
    return initialWolfieRealtimeProtocolState();
  }
  if (action.type === "local.phase") {
    return {
      ...state,
      phase: action.phase,
      error: action.phase === "error" ? state.error : null,
    };
  }
  if (action.type === "local.error") {
    return {
      ...state,
      phase: "error",
      isUserSpeaking: false,
      isAssistantSpeaking: false,
      error: action.message.slice(0, 500),
    };
  }

  const event = action.event;
  const next = {
    ...state,
    lastEventType: event.type,
  };

  switch (event.type) {
    case "session.created":
    case "session.updated":
      return {
        ...next,
        phase: "connected",
        error: null,
      };

    case "input_audio_buffer.speech_started": {
      const itemId = stringField(event, "item_id") || null;
      return {
        ...next,
        phase: "listening",
        isUserSpeaking: true,
        isAssistantSpeaking: false,
        userTranscript: "",
        userTranscriptConfidence: null,
        inputLogprobSum: 0,
        inputLogprobCount: 0,
        activeInputItemId: itemId,
      };
    }

    case "input_audio_buffer.speech_stopped":
    case "input_audio_buffer.committed":
      return {
        ...next,
        phase: "thinking",
        isUserSpeaking: false,
      };

    case "conversation.item.input_audio_transcription.delta": {
      const itemId = inputItemId(event, state.activeInputItemId);
      const existing = state.inputDrafts[itemId] ?? {
        text: "",
        logprobSum: 0,
        logprobCount: 0,
      };
      const logprobs = wolfieRealtimeEventLogprobs(event);
      const logprobSum = existing.logprobSum +
        logprobs.reduce((sum, value) => sum + value, 0);
      const logprobCount = existing.logprobCount + logprobs.length;
      const text = appendTranscript(
        existing.text,
        stringField(event, "delta"),
      );
      const isActive = !state.activeInputItemId ||
        itemId === state.activeInputItemId;
      return {
        ...next,
        userTranscript: isActive ? text : state.userTranscript,
        inputLogprobSum: isActive ? logprobSum : state.inputLogprobSum,
        inputLogprobCount: isActive ? logprobCount : state.inputLogprobCount,
        userTranscriptConfidence: isActive
          ? roughConfidence(logprobSum, logprobCount)
          : state.userTranscriptConfidence,
        inputDrafts: {
          ...state.inputDrafts,
          [itemId]: { text, logprobSum, logprobCount },
        },
      };
    }

    case "conversation.item.input_audio_transcription.completed": {
      const itemId = inputItemId(event, state.activeInputItemId);
      const draft = state.inputDrafts[itemId];
      const completed = completeTranscript(
        draft?.text ?? state.userTranscript,
        stringField(event, "transcript"),
      );
      const finalLogprobs = wolfieRealtimeEventLogprobs(event);
      const logprobSum = finalLogprobs.length
        ? finalLogprobs.reduce((sum, value) => sum + value, 0)
        : draft?.logprobSum ?? state.inputLogprobSum;
      const logprobCount = finalLogprobs.length
        ? finalLogprobs.length
        : draft?.logprobCount ?? state.inputLogprobCount;
      const isActive = !state.activeInputItemId ||
        itemId === state.activeInputItemId;
      return {
        ...next,
        userTranscript: isActive ? completed.current : state.userTranscript,
        lastUserTranscript: completed.last,
        inputLogprobSum: isActive ? logprobSum : state.inputLogprobSum,
        inputLogprobCount: isActive ? logprobCount : state.inputLogprobCount,
        userTranscriptConfidence: isActive
          ? roughConfidence(logprobSum, logprobCount)
          : state.userTranscriptConfidence,
        activeInputItemId: isActive ? null : state.activeInputItemId,
        inputDrafts: withoutDraft(state.inputDrafts, itemId),
      };
    }

    case "conversation.item.input_audio_transcription.failed": {
      const itemId = inputItemId(event, state.activeInputItemId);
      const isActive = !state.activeInputItemId ||
        itemId === state.activeInputItemId;
      return {
        ...next,
        userTranscript: isActive ? "" : state.userTranscript,
        userTranscriptConfidence: isActive
          ? null
          : state.userTranscriptConfidence,
        inputLogprobSum: isActive ? 0 : state.inputLogprobSum,
        inputLogprobCount: isActive ? 0 : state.inputLogprobCount,
        activeInputItemId: isActive ? null : state.activeInputItemId,
        inputDrafts: withoutDraft(state.inputDrafts, itemId),
      };
    }

    case "response.created":
      return {
        ...next,
        phase: "thinking",
        responseId: responseId(event),
        assistantTranscript: "",
        isAssistantSpeaking: false,
      };

    case "output_audio_buffer.started":
    case "response.output_audio.started":
      return {
        ...next,
        phase: "speaking",
        isAssistantSpeaking: true,
        responseId: responseId(event) ?? state.responseId,
      };

    case "response.output_audio_transcript.delta":
      return {
        ...next,
        phase: "speaking",
        isAssistantSpeaking: true,
        responseId: responseId(event) ?? state.responseId,
        assistantTranscript: appendTranscript(
          state.assistantTranscript,
          stringField(event, "delta"),
        ),
      };

    case "response.output_text.delta":
      return {
        ...next,
        phase: state.isAssistantSpeaking ? "speaking" : state.phase,
        responseId: responseId(event) ?? state.responseId,
        assistantTranscript: appendTranscript(
          state.assistantTranscript,
          stringField(event, "delta"),
        ),
      };

    case "response.output_audio_transcript.done":
    case "response.output_text.done": {
      const completed = completeTranscript(
        state.assistantTranscript,
        stringField(event, "transcript") || stringField(event, "text"),
      );
      return {
        ...next,
        assistantTranscript: completed.current,
        lastAssistantTranscript: completed.last,
      };
    }

    case "output_audio_buffer.stopped":
    case "output_audio_buffer.cleared":
      return {
        ...next,
        phase: state.isUserSpeaking ? "listening" : "connected",
        isAssistantSpeaking: false,
      };

    case "response.done": {
      const status = responseStatus(event);
      return {
        ...next,
        phase: state.isAssistantSpeaking ? "speaking" : "connected",
        responseId: null,
        error: status === "failed"
          ? "O Wolfie não conseguiu concluir a resposta."
          : null,
      };
    }

    case "response.cancelled":
      return {
        ...next,
        phase: state.isUserSpeaking ? "listening" : "connected",
        isAssistantSpeaking: false,
        responseId: null,
      };

    case "error":
      return {
        ...next,
        phase: "error",
        isUserSpeaking: false,
        isAssistantSpeaking: false,
        error: eventErrorMessage(event),
      };

    default:
      return next;
  }
}

export function serializeWolfieRealtimeEvent(
  type: string,
  payload: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    event_id: typeof crypto?.randomUUID === "function"
      ? crypto.randomUUID()
      : `wolfie_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    type,
    ...payload,
  });
}
