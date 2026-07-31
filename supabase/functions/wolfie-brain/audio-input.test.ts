/// <reference lib="deno.ns" />

import {
  isWolfieSpeechDerivedTranscript,
  normalizeWolfieAudioMimeType,
} from "./audio-input.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("accepts recorder MIME types with codec parameters", () => {
  assertEquals(
    normalizeWolfieAudioMimeType("audio/webm;codecs=opus"),
    "audio/webm",
  );
  assertEquals(
    normalizeWolfieAudioMimeType("audio/ogg; codecs=opus"),
    "audio/ogg",
  );
  assertEquals(normalizeWolfieAudioMimeType("audio/mp4"), "audio/mp4");
});

Deno.test("rejects non-audio and unsupported MIME types", () => {
  assertEquals(normalizeWolfieAudioMimeType("video/webm"), null);
  assertEquals(normalizeWolfieAudioMimeType("audio/svg+xml"), null);
  assertEquals(normalizeWolfieAudioMimeType(""), null);
  assertEquals(normalizeWolfieAudioMimeType(null), null);
});

Deno.test("server ASR remains speech-derived without confidence or alternatives", () => {
  assertEquals(
    isWolfieSpeechDerivedTranscript({
      hasAudio: false,
      speechDerivedTranscript: true,
      transcriptionConfidence: null,
      transcriptionAlternatives: [],
    }),
    true,
  );
  assertEquals(
    isWolfieSpeechDerivedTranscript({
      hasAudio: false,
      speechDerivedTranscript: false,
      transcriptionConfidence: null,
      transcriptionAlternatives: [],
    }),
    false,
  );
});
