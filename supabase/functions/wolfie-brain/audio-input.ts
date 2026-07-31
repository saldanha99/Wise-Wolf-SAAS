const ALLOWED_AUDIO_MIME_TYPES = new Set([
  "audio/webm",
  "audio/mp4",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/aac",
]);

export function normalizeWolfieAudioMimeType(
  value: unknown,
): string | null {
  if (typeof value !== "string") return null;
  const baseType = value
    .split(";", 1)[0]
    .trim()
    .toLocaleLowerCase("en-US");
  return ALLOWED_AUDIO_MIME_TYPES.has(baseType) ? baseType : null;
}

export function isWolfieSpeechDerivedTranscript(input: {
  hasAudio: boolean;
  speechDerivedTranscript: boolean;
  transcriptionConfidence: number | null;
  transcriptionAlternatives: string[];
}): boolean {
  return input.hasAudio ||
    input.speechDerivedTranscript ||
    input.transcriptionConfidence !== null ||
    input.transcriptionAlternatives.length > 0;
}
