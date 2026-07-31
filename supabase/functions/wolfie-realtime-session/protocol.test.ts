/// <reference lib="deno.ns" />

import {
  estimateRoughAsrConfidence,
  initialWolfieRealtimeProtocolState,
  parseWolfieRealtimeServerEvent,
  reduceWolfieRealtimeProtocol,
  type WolfieRealtimeProtocolState,
  WolfieRealtimeTurnAssembler,
} from "../../../src/services/wolfieRealtimeProtocol.ts";
import { WOLFIE_REALTIME_ADAPTIVE_LANGUAGE_POLICY } from "../wolfie-brain/adaptive-language-policy.ts";
import { buildRealtimeCallForm } from "./realtime-call-form.ts";
import { WOLFIE_REALTIME_SOCIAL_TURN_POLICY } from "./social-turn-policy.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("Realtime prompt treats isolated greetings as social, not pedagogical evidence", () => {
  for (
    const requiredRule of [
      "not an exercise answer or pedagogical attempt",
      "Do not evaluate, correct, praise task performance",
      "without implying that they already did",
      "both a greeting and a substantive answer",
      "explicitly asks the learner to practice, say, write, or use a greeting",
      "another character greets the learner is not this exception",
    ]
  ) {
    assert(
      WOLFIE_REALTIME_SOCIAL_TURN_POLICY.includes(requiredRule),
      `missing social-turn rule: ${requiredRule}`,
    );
  }
});

Deno.test("Realtime prompt adapts every turn between PT-BR and English", () => {
  for (
    const requiredRule of [
      "Never infer it from an interface or microphone setting",
      "speak one concise natural PT-BR response first",
      'Then say "Em inglês:"',
      "If the learner speaks English",
      "name, city, state, number",
    ]
  ) {
    assert(
      WOLFIE_REALTIME_ADAPTIVE_LANGUAGE_POLICY.includes(requiredRule),
      `missing realtime adaptive-language rule: ${requiredRule}`,
    );
  }
});

Deno.test("Realtime unified call sends SDP and session as text form fields", () => {
  const form = buildRealtimeCallForm("v=0\r\n", {
    type: "realtime",
    model: "gpt-realtime-2.1",
  });
  const sdp = form.get("sdp");
  const session = form.get("session");
  assert(typeof sdp === "string", "SDP must not be a Blob/File part");
  assert(typeof session === "string", "session must not be a Blob/File part");
  assert(sdp === "v=0\r\n", "SDP text must be preserved exactly");
  assert(
    JSON.parse(session).model === "gpt-realtime-2.1",
    "session JSON must remain valid",
  );
});

Deno.test("Realtime parser rejects invalid or untyped messages", () => {
  assert(
    parseWolfieRealtimeServerEvent("not-json") === null,
    "invalid JSON must be rejected",
  );
  assert(
    parseWolfieRealtimeServerEvent('{"delta":"hello"}') === null,
    "events without type must be rejected",
  );
});

Deno.test("Realtime reducer preserves input transcript deltas and completion", () => {
  let state = initialWolfieRealtimeProtocolState();
  state = reduceWolfieRealtimeProtocol(state, {
    type: "server.event",
    event: { type: "input_audio_buffer.speech_started" },
  });
  assert(state.phase === "listening", "speech must enter listening phase");
  assert(state.isUserSpeaking, "user speech flag must be true");

  for (const delta of ["I live ", "in Nova ", "Iguaçu."]) {
    state = reduceWolfieRealtimeProtocol(state, {
      type: "server.event",
      event: {
        type: "conversation.item.input_audio_transcription.delta",
        delta,
        logprobs: [{ token: delta, logprob: -0.1 }],
      },
    });
  }
  state = reduceWolfieRealtimeProtocol(state, {
    type: "server.event",
    event: {
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "I live in Nova Iguaçu.",
    },
  });

  assert(
    state.userTranscript === "I live in Nova Iguaçu.",
    "the completed transcript must be authoritative",
  );
  assert(
    state.lastUserTranscript === "I live in Nova Iguaçu.",
    "the latest completed input must remain available",
  );
  assert(
    state.userTranscriptConfidence !== null &&
      state.userTranscriptConfidence > 0.8,
    "ASR logprobs should produce only a rough confidence guide",
  );
  assert(
    state.inputTranscriptIsRoughGuide,
    "ASR transcripts must always be labeled as a rough guide",
  );
});

Deno.test("ASR confidence ignores invalid logprobs and is not factual truth", () => {
  const confidence = estimateRoughAsrConfidence({
    type: "conversation.item.input_audio_transcription.completed",
    logprobs: [
      { token: "Nova", logprob: -0.2 },
      { token: "Iguaçu", logprob: -0.4 },
      { token: "ignored", logprob: Number.NaN },
    ],
  });
  assert(
    confidence !== null && confidence > 0 && confidence < 1,
    "finite logprobs should yield bounded rough guidance",
  );
});

Deno.test("Realtime reducer exposes speaking transcript and returns connected", () => {
  let state = initialWolfieRealtimeProtocolState();
  state = reduceWolfieRealtimeProtocol(state, {
    type: "server.event",
    event: { type: "response.created", response: { id: "resp_1" } },
  });
  assert(state.phase === "thinking", "response creation must enter thinking");
  assert(state.responseId === "resp_1", "response id must be retained");

  for (const delta of ["Thanks! ", "Nova Iguaçu ", "is clear now."]) {
    state = reduceWolfieRealtimeProtocol(state, {
      type: "server.event",
      event: { type: "response.output_audio_transcript.delta", delta },
    });
  }
  assert(state.phase === "speaking", "audio transcript must enter speaking");
  assert(state.isAssistantSpeaking, "assistant speech flag must be true");

  state = reduceWolfieRealtimeProtocol(state, {
    type: "server.event",
    event: {
      type: "response.output_audio_transcript.done",
      transcript: "Thanks! Nova Iguaçu is clear now.",
    },
  });
  state = reduceWolfieRealtimeProtocol(state, {
    type: "server.event",
    event: {
      type: "output_audio_buffer.started",
      response_id: "resp_1",
    },
  });
  state = reduceWolfieRealtimeProtocol(state, {
    type: "server.event",
    event: {
      type: "response.done",
      response: { id: "resp_1", status: "completed" },
    },
  });

  assert(
    state.phase === "speaking",
    "response completion must not pretend WebRTC playout already stopped",
  );
  state = reduceWolfieRealtimeProtocol(state, {
    type: "server.event",
    event: {
      type: "output_audio_buffer.stopped",
      response_id: "resp_1",
    },
  });
  assert(state.phase === "connected", "stopped playout must return connected");
  assert(!state.isAssistantSpeaking, "assistant speech must be cleared");
  assert(
    state.lastAssistantTranscript ===
      "Thanks! Nova Iguaçu is clear now.",
    "completed assistant transcript must remain available",
  );
});

Deno.test("A user interruption immediately switches from speaking to listening", () => {
  let state: WolfieRealtimeProtocolState = {
    ...initialWolfieRealtimeProtocolState(),
    phase: "speaking",
    isAssistantSpeaking: true,
  };
  state = reduceWolfieRealtimeProtocol(state, {
    type: "server.event",
    event: { type: "input_audio_buffer.speech_started" },
  });

  assert(state.phase === "listening", "barge-in must enter listening");
  assert(state.isUserSpeaking, "user speech flag must be set");
  assert(!state.isAssistantSpeaking, "assistant speech flag must be cleared");
});

Deno.test("Realtime server errors are bounded and represented safely", () => {
  const state = reduceWolfieRealtimeProtocol(
    initialWolfieRealtimeProtocolState(),
    {
      type: "server.event",
      event: {
        type: "error",
        error: { message: "x".repeat(1_000) },
      },
    },
  );

  assert(state.phase === "error", "server errors must enter error phase");
  assert(state.error?.length === 500, "error text must be bounded");
});

Deno.test("ASR deltas from different item_ids never contaminate each other", () => {
  let state = initialWolfieRealtimeProtocolState();
  state = reduceWolfieRealtimeProtocol(state, {
    type: "server.event",
    event: {
      type: "input_audio_buffer.speech_started",
      item_id: "item_1",
    },
  });
  state = reduceWolfieRealtimeProtocol(state, {
    type: "server.event",
    event: {
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item_1",
      delta: "I live in Nova ",
    },
  });
  state = reduceWolfieRealtimeProtocol(state, {
    type: "server.event",
    event: {
      type: "input_audio_buffer.speech_started",
      item_id: "item_2",
    },
  });
  state = reduceWolfieRealtimeProtocol(state, {
    type: "server.event",
    event: {
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item_2",
      delta: "I am from Bahia.",
    },
  });
  state = reduceWolfieRealtimeProtocol(state, {
    type: "server.event",
    event: {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item_1",
      transcript: "I live in Nova Iguaçu.",
    },
  });

  assert(
    state.userTranscript === "I am from Bahia.",
    "a late completion for item_1 must not replace active item_2 text",
  );
  assert(
    state.lastUserTranscript === "I live in Nova Iguaçu.",
    "the late item still needs its own completed transcript",
  );
});

Deno.test("Turn assembler pairs by commit order despite reversed ASR completion", () => {
  const assembler = new WolfieRealtimeTurnAssembler();
  assembler.commitInput("item_1");
  assembler.beginResponse("resp_1");
  assembler.commitInput("item_2");
  assembler.beginResponse("resp_2");

  assembler.setAssistant("resp_1", "First answer.");
  assembler.finishResponse("resp_1", "completed");
  assembler.setAssistant("resp_2", "Second answer.");
  assembler.finishResponse("resp_2", "completed");

  const secondFirst = assembler.completeInput({
    key: "item_2",
    text: "Second question.",
    inputMethod: "audio_transcription",
    asrConfidence: 0.8,
  });
  assert(
    secondFirst.length === 1 &&
      secondFirst[0].responseId === "resp_2" &&
      secondFirst[0].input.text === "Second question.",
    "item_2 must pair with resp_2 even when its transcript finishes first",
  );

  const firstLater = assembler.completeInput({
    key: "item_1",
    text: "First question.",
    inputMethod: "audio_transcription",
    asrConfidence: 0.9,
  });
  assert(
    firstLater.length === 1 &&
      firstLater[0].responseId === "resp_1" &&
      firstLater[0].input.text === "First question.",
    "item_1 must remain paired with resp_1",
  );
});

Deno.test("Turn assembler never reuses a cancelled response input", () => {
  const assembler = new WolfieRealtimeTurnAssembler();
  assembler.commitInput("item_cancelled");
  assembler.completeInput({
    key: "item_cancelled",
    text: "Interrupted question.",
    inputMethod: "audio_transcription",
    asrConfidence: null,
  });
  assembler.beginResponse("resp_cancelled");
  assembler.setAssistant("resp_cancelled", "Partial answer.");
  const cancelled = assembler.finishResponse("resp_cancelled", "cancelled");
  assert(cancelled.length === 0, "cancelled responses must not emit a turn");

  assembler.commitInput("item_next");
  assembler.completeInput({
    key: "item_next",
    text: "Next question.",
    inputMethod: "audio_transcription",
    asrConfidence: null,
  });
  assembler.beginResponse("resp_next");
  assembler.setAssistant("resp_next", "Next answer.");
  const next = assembler.finishResponse("resp_next", "completed");
  assert(
    next.length === 1 && next[0].input.key === "item_next",
    "the next response must pair only with the next input",
  );
});
