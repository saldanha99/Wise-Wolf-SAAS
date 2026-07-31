import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { FUNCTIONS_URL, supabase, SUPABASE_ANON_KEY } from "../../lib/supabase";
import {
  estimateRoughAsrConfidence,
  extractWolfieRealtimeResponseTranscript,
  extractWolfieRealtimeUsage,
  initialWolfieRealtimeProtocolState,
  parseWolfieRealtimeServerEvent,
  reduceWolfieRealtimeProtocol,
  serializeWolfieRealtimeEvent,
  wolfieRealtimeEventLogprobs,
  type WolfieRealtimePhase,
  type WolfieRealtimeServerEvent,
  WolfieRealtimeTurnAssembler,
  type WolfieRealtimeTurnPair,
  type WolfieRealtimeUsage,
} from "./wolfieRealtimeProtocol";

const DEFAULT_FUNCTION_URL = `${FUNCTIONS_URL}/wolfie-realtime-session`;
const SESSION_SETUP_TIMEOUT_MS = 25_000;
const TRANSPORT_READY_TIMEOUT_MS = 12_000;
const DISCONNECTED_GRACE_MS = 5_000;
const MAX_TEXT_INPUT_LENGTH = 4_000;
// Custo: a OpenAI cobra pela conversa acumulada a cada turno. Sem teto, um
// aluno esquecido com a aba aberta queima dinheiro sozinho. Estes são os
// freios do cliente; a cota mensal é verificada no servidor.
const MAX_SESSION_DURATION_MS = 10 * 60_000;
const SESSION_WARNING_BEFORE_MS = 2 * 60_000;
// Silêncio absoluto: ninguém falando e o Wolfie sem responder.
const IDLE_TIMEOUT_MS = 90_000;

export type WolfieRealtimeFallbackReason =
  | "disabled"
  | "unsupported_browser"
  | "missing_configuration"
  | "authentication_required"
  | "microphone_unavailable"
  | "service_unavailable"
  | "connection_failed"
  | "session_limit_reached"
  | "idle_timeout"
  | "quota_exceeded";

export interface WolfieRealtimeOptions {
  /**
   * Explicit feature flag. The hook never requests microphone permission or
   * opens a paid Realtime call while this is false.
   */
  enabled: boolean;
  topic?: string;
  goal?: string;
  language?: "pt-BR" | "en-US" | "auto";
  ragQuery?: string;
  functionUrl?: string;
  onFallback?: (
    reason: WolfieRealtimeFallbackReason,
    message: string,
  ) => void;
  onEvent?: (event: WolfieRealtimeServerEvent) => void;
  /**
   * Fires only in memory when a final learner transcript and final Wolfie
   * transcript form a turn. The consumer may decide whether to persist it.
   */
  onTurnComplete?: (turn: WolfieRealtimeCompletedTurn) => void;
  /** Avisa que faltam N minutos para o teto de duração da sessão. */
  onSessionWarning?: (minutesLeft: number) => void;
}

export interface WolfieRealtimeCompletedTurn {
  id: string;
  userTranscript: string;
  assistantTranscript: string;
  inputMethod: "audio_transcription" | "text";
  /**
   * Uncalibrated ASR guidance derived from logprobs. Null for typed input.
   * It is never evidence that the content is factually true.
   */
  asrConfidence: number | null;
  transcriptIsRoughGuide: true;
  completedAt: string;
  /** Consumo cobrado neste turno; null quando a OpenAI não reportou. */
  usage: WolfieRealtimeUsage | null;
}

export interface WolfieRealtimeConnectResult {
  ok: boolean;
  fallback: boolean;
  reason?: WolfieRealtimeFallbackReason;
  message?: string;
}

export interface WolfieRealtimeController {
  phase: WolfieRealtimePhase;
  connected: boolean;
  isUserSpeaking: boolean;
  isAssistantSpeaking: boolean;
  userTranscript: string;
  assistantTranscript: string;
  lastUserTranscript: string;
  lastAssistantTranscript: string;
  lastCompletedTurn: WolfieRealtimeCompletedTurn | null;
  userTranscriptConfidence: number | null;
  inputTranscriptIsRoughGuide: true;
  localAudioLevel: number;
  remoteAudioLevel: number;
  muted: boolean;
  error: string | null;
  fallbackReason: WolfieRealtimeFallbackReason | null;
  connect: () => Promise<WolfieRealtimeConnectResult>;
  disconnect: () => void;
  interrupt: () => boolean;
  sendText: (text: string) => boolean;
  setMuted: (muted: boolean) => void;
  toggleMuted: () => void;
  resumeAudio: () => Promise<boolean>;
}

interface FallbackPayload {
  fallback?: unknown;
  error?: unknown;
  code?: unknown;
  message?: unknown;
}

interface AudioMeterResources {
  context: AudioContext;
  localSource: MediaStreamAudioSourceNode | null;
  remoteSource: MediaStreamAudioSourceNode | null;
  localAnalyser: AnalyserNode | null;
  remoteAnalyser: AnalyserNode | null;
  localSilencer: GainNode | null;
  remoteSilencer: GainNode | null;
  localBuffer: Uint8Array<ArrayBuffer> | null;
  remoteBuffer: Uint8Array<ArrayBuffer> | null;
  animationFrame: number | null;
}

const emptyAudioMeters = (): AudioMeterResources => ({
  context: new AudioContext(),
  localSource: null,
  remoteSource: null,
  localAnalyser: null,
  remoteAnalyser: null,
  localSilencer: null,
  remoteSilencer: null,
  localBuffer: null,
  remoteBuffer: null,
  animationFrame: null,
});

function browserSupportsRealtime(): boolean {
  return typeof window !== "undefined" &&
    typeof RTCPeerConnection !== "undefined" &&
    typeof navigator?.mediaDevices?.getUserMedia === "function";
}

function boundedQueryValue(value: string | undefined, maxLength: number) {
  return value?.trim().slice(0, maxLength) ?? "";
}

function buildSessionUrl(
  functionUrl: string,
  options: Pick<
    WolfieRealtimeOptions,
    "topic" | "goal" | "language" | "ragQuery"
  >,
): string {
  const url = new URL(functionUrl);
  const values: Array<[string, string]> = [
    ["topic", boundedQueryValue(options.topic, 300)],
    ["goal", boundedQueryValue(options.goal, 500)],
    ["language", boundedQueryValue(options.language, 30)],
    ["ragQuery", boundedQueryValue(options.ragQuery, 1_500)],
  ];
  for (const [key, value] of values) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

async function readFallbackPayload(response: Response): Promise<{
  message: string;
  fallback: boolean;
}> {
  try {
    const payload = await response.clone().json() as FallbackPayload;
    const message = typeof payload.message === "string"
      ? payload.message
      : "O modo em tempo real está indisponível.";
    return {
      message: message.slice(0, 500),
      fallback: payload.fallback === true,
    };
  } catch {
    return {
      message: "O modo em tempo real está indisponível.",
      fallback: false,
    };
  }
}

function rmsLevel(
  analyser: AnalyserNode | null,
  buffer: Uint8Array<ArrayBuffer> | null,
): number {
  if (!analyser || !buffer) return 0;
  analyser.getByteTimeDomainData(buffer);
  let squared = 0;
  for (const sample of buffer) {
    const normalized = (sample - 128) / 128;
    squared += normalized * normalized;
  }
  const rms = Math.sqrt(squared / buffer.length);
  return Math.min(1, Math.max(0, rms * 3.2));
}

function attachAnalyser(
  context: AudioContext,
  stream: MediaStream,
): {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  silencer: GainNode;
  buffer: Uint8Array<ArrayBuffer>;
} {
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  const silencer = context.createGain();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.72;
  silencer.gain.value = 0;
  source.connect(analyser);
  analyser.connect(silencer);
  silencer.connect(context.destination);
  return {
    source,
    analyser,
    silencer,
    buffer: new Uint8Array(new ArrayBuffer(analyser.fftSize)),
  };
}

function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

function dataChannelIsOpen(
  channel: RTCDataChannel | null,
): channel is RTCDataChannel {
  return channel?.readyState === "open";
}

function waitForRealtimeTransport(
  peer: RTCPeerConnection,
  channel: RTCDataChannel,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      window.clearTimeout(timeout);
      peer.removeEventListener("connectionstatechange", check);
      channel.removeEventListener("open", check);
      channel.removeEventListener("close", check);
      channel.removeEventListener("error", check);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      if (channel.readyState === "open") {
        finish();
        return;
      }
      if (
        channel.readyState === "closing" ||
        channel.readyState === "closed" ||
        peer.connectionState === "failed" ||
        peer.connectionState === "closed"
      ) {
        finish(new Error("realtime_transport_failed"));
      }
    };
    const timeout = window.setTimeout(
      () =>
        finish(
          new DOMException(
            "Realtime transport did not become ready",
            "TimeoutError",
          ),
        ),
      timeoutMs,
    );
    peer.addEventListener("connectionstatechange", check);
    channel.addEventListener("open", check);
    channel.addEventListener("close", check);
    channel.addEventListener("error", check);
    check();
  });
}

function eventString(
  event: WolfieRealtimeServerEvent,
  field: string,
): string {
  return typeof event[field] === "string" ? event[field] as string : "";
}

function localId(_prefix: string): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === "function") {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"))
    .join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function realtimeInputItemId(
  event: WolfieRealtimeServerEvent,
  fallback = "",
): string {
  return eventString(event, "item_id") || fallback;
}

function realtimeResponseId(
  event: WolfieRealtimeServerEvent,
  fallback = "",
): string {
  const response = event.response &&
      typeof event.response === "object" &&
      !Array.isArray(event.response)
    ? event.response as Record<string, unknown>
    : null;
  return eventString(event, "response_id") ||
    (response && typeof response.id === "string" ? response.id : "") ||
    fallback;
}

function realtimeResponseStatus(event: WolfieRealtimeServerEvent): string {
  const response = event.response &&
      typeof event.response === "object" &&
      !Array.isArray(event.response)
    ? event.response as Record<string, unknown>
    : null;
  return response && typeof response.status === "string" ? response.status : "";
}

interface InputTranscriptDraft {
  text: string;
  logprobSum: number;
  logprobCount: number;
}

export function useWolfieRealtime(
  options: WolfieRealtimeOptions,
): WolfieRealtimeController {
  const [protocol, dispatch] = useReducer(
    reduceWolfieRealtimeProtocol,
    undefined,
    initialWolfieRealtimeProtocolState,
  );
  const [levels, setLevels] = useState({ local: 0, remote: 0 });
  const [muted, setMutedState] = useState(false);
  const [fallbackReason, setFallbackReason] = useState<
    WolfieRealtimeFallbackReason | null
  >(null);
  const [lastCompletedTurn, setLastCompletedTurn] = useState<
    WolfieRealtimeCompletedTurn | null
  >(null);

  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const microphoneRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const metersRef = useRef<AudioMeterResources | null>(null);
  const setupAbortRef = useRef<AbortController | null>(null);
  const disconnectedTimeoutRef = useRef<number | null>(null);
  const connectingRef = useRef(false);
  const connectionAttemptRef = useRef(0);
  const mountedRef = useRef(true);
  const latestOptionsRef = useRef(options);
  const turnAssemblerRef = useRef(new WolfieRealtimeTurnAssembler());
  const committedInputIdsRef = useRef(new Set<string>());
  const inputDraftsRef = useRef(new Map<string, InputTranscriptDraft>());
  const activeInputItemIdRef = useRef("");
  const activeResponseIdRef = useRef("");
  const realtimeUsageRef = useRef(new Map<string, WolfieRealtimeUsage>());
  const sessionLimitTimerRef = useRef<number | null>(null);
  const sessionWarningTimerRef = useRef<number | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  const sessionStartedAtRef = useRef<number | null>(null);
  latestOptionsRef.current = options;

  const publishCompletedTurns = useCallback((
    pairs: WolfieRealtimeTurnPair[],
  ) => {
    for (const pair of pairs) {
      const turn: WolfieRealtimeCompletedTurn = {
        // The persistence API expects a UUID idempotency key.
        id: localId("turn"),
        userTranscript: pair.input.text,
        assistantTranscript: pair.assistantTranscript,
        inputMethod: pair.input.inputMethod,
        asrConfidence: pair.input.asrConfidence,
        transcriptIsRoughGuide: true,
        completedAt: new Date().toISOString(),
        usage: realtimeUsageRef.current.get(pair.responseId) ?? null,
      };
      realtimeUsageRef.current.delete(pair.responseId);
      if (mountedRef.current) setLastCompletedTurn(turn);
      latestOptionsRef.current.onTurnComplete?.(turn);
    }
  }, []);

  /**
   * Debita os minutos consumidos ao encerrar. Roda em qualquer saída — teto,
   * ociosidade, queda ou desligar manual — senão a sessão que cai sem avisar
   * seria gratuita e a cota nunca fecharia.
   */
  const settleLiveSeconds = useCallback(() => {
    const startedAt = sessionStartedAtRef.current;
    sessionStartedAtRef.current = null;
    if (!startedAt) return;
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    if (seconds <= 0) return;
    void supabase.rpc("record_wolfie_live_seconds", {
      p_session_id: null,
      p_seconds: seconds,
    }).then(({ error }) => {
      if (error) console.warn("[wolfie] minutos ao vivo não registrados");
    });
  }, []);

  const clearCostTimers = useCallback(() => {
    for (
      const ref of [sessionLimitTimerRef, sessionWarningTimerRef, idleTimerRef]
    ) {
      if (ref.current !== null) {
        window.clearTimeout(ref.current);
        ref.current = null;
      }
    }
  }, []);

  const resetTurnPairing = useCallback(() => {
    turnAssemblerRef.current.reset();
    committedInputIdsRef.current.clear();
    inputDraftsRef.current.clear();
    realtimeUsageRef.current.clear();
    activeInputItemIdRef.current = "";
    activeResponseIdRef.current = "";
  }, []);

  const stopMeters = useCallback(() => {
    const meters = metersRef.current;
    if (!meters) return;
    if (meters.animationFrame !== null) {
      cancelAnimationFrame(meters.animationFrame);
    }
    meters.localSource?.disconnect();
    meters.remoteSource?.disconnect();
    meters.localAnalyser?.disconnect();
    meters.remoteAnalyser?.disconnect();
    meters.localSilencer?.disconnect();
    meters.remoteSilencer?.disconnect();
    void meters.context.close().catch(() => undefined);
    metersRef.current = null;
    if (mountedRef.current) setLevels({ local: 0, remote: 0 });
  }, []);

  const cleanupResources = useCallback((updatePhase: boolean) => {
    connectionAttemptRef.current += 1;
    setupAbortRef.current?.abort();
    setupAbortRef.current = null;
    settleLiveSeconds();
    clearCostTimers();
    if (disconnectedTimeoutRef.current !== null) {
      window.clearTimeout(disconnectedTimeoutRef.current);
      disconnectedTimeoutRef.current = null;
    }
    connectingRef.current = false;

    const channel = dataChannelRef.current;
    if (channel) {
      channel.onopen = null;
      channel.onclose = null;
      channel.onerror = null;
      channel.onmessage = null;
      channel.close();
    }
    dataChannelRef.current = null;

    const peer = peerRef.current;
    if (peer) {
      peer.ontrack = null;
      peer.onconnectionstatechange = null;
      peer.close();
    }
    peerRef.current = null;

    stopStream(microphoneRef.current);
    microphoneRef.current = null;
    stopStream(remoteStreamRef.current);
    remoteStreamRef.current = null;

    const remoteAudio = remoteAudioRef.current;
    if (remoteAudio) {
      remoteAudio.pause();
      remoteAudio.srcObject = null;
      remoteAudio.remove();
    }
    remoteAudioRef.current = null;
    stopMeters();
    resetTurnPairing();

    if (updatePhase && mountedRef.current) {
      dispatch({ type: "local.reset" });
      setFallbackReason(null);
      setMutedState(false);
    }
  }, [clearCostTimers, resetTurnPairing, settleLiveSeconds, stopMeters]);

  const markFallback = useCallback((
    reason: WolfieRealtimeFallbackReason,
    message: string,
  ): WolfieRealtimeConnectResult => {
    cleanupResources(false);
    if (mountedRef.current) {
      setFallbackReason(reason);
      dispatch({ type: "local.phase", phase: "fallback" });
    }
    latestOptionsRef.current.onFallback?.(reason, message);
    return { ok: false, fallback: true, reason, message };
  }, [cleanupResources]);

  /**
   * Reinicia a contagem de ociosidade. Chamado quando há atividade real —
   * aluno falando ou Wolfie respondendo. Uma aba aberta e silenciosa não
   * conta como atividade: é exatamente o caso que queremos encerrar.
   */
  const touchActivity = useCallback(() => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
    }
    idleTimerRef.current = window.setTimeout(() => {
      idleTimerRef.current = null;
      if (!mountedRef.current) return;
      markFallback(
        "idle_timeout",
        "Encerramos a conversa ao vivo por inatividade. Toque para começar de novo.",
      );
    }, IDLE_TIMEOUT_MS);
  }, [markFallback]);

  const startCostTimers = useCallback(() => {
    clearCostTimers();
    sessionStartedAtRef.current = Date.now();
    sessionWarningTimerRef.current = window.setTimeout(() => {
      sessionWarningTimerRef.current = null;
      if (!mountedRef.current) return;
      latestOptionsRef.current.onSessionWarning?.(
        Math.round(SESSION_WARNING_BEFORE_MS / 60_000),
      );
    }, Math.max(0, MAX_SESSION_DURATION_MS - SESSION_WARNING_BEFORE_MS));

    sessionLimitTimerRef.current = window.setTimeout(() => {
      sessionLimitTimerRef.current = null;
      if (!mountedRef.current) return;
      markFallback(
        "session_limit_reached",
        "A conversa ao vivo chegou ao tempo máximo. Continue no modo clássico ou inicie outra.",
      );
    }, MAX_SESSION_DURATION_MS);
    touchActivity();
  }, [clearCostTimers, markFallback, touchActivity]);

  const startMeters = useCallback((
    microphone: MediaStream,
  ): AudioMeterResources | null => {
    try {
      const meters = emptyAudioMeters();
      const local = attachAnalyser(meters.context, microphone);
      meters.localSource = local.source;
      meters.localAnalyser = local.analyser;
      meters.localSilencer = local.silencer;
      meters.localBuffer = local.buffer;

      let previousLocal = 0;
      let previousRemote = 0;
      let lastUpdate = 0;
      const animate = (timestamp: number) => {
        const activeMeters = metersRef.current;
        if (activeMeters !== meters) return;

        if (timestamp - lastUpdate >= 50) {
          const localLevel = rmsLevel(
            meters.localAnalyser,
            meters.localBuffer,
          );
          const remoteLevel = rmsLevel(
            meters.remoteAnalyser,
            meters.remoteBuffer,
          );
          if (
            Math.abs(localLevel - previousLocal) >= 0.01 ||
            Math.abs(remoteLevel - previousRemote) >= 0.01
          ) {
            previousLocal = localLevel;
            previousRemote = remoteLevel;
            if (mountedRef.current) {
              setLevels({ local: localLevel, remote: remoteLevel });
            }
          }
          lastUpdate = timestamp;
        }
        meters.animationFrame = requestAnimationFrame(animate);
      };
      metersRef.current = meters;
      meters.animationFrame = requestAnimationFrame(animate);
      void meters.context.resume().catch(() => undefined);
      return meters;
    } catch {
      return null;
    }
  }, []);

  const attachRemoteStream = useCallback((
    event: RTCTrackEvent,
  ) => {
    const stream = event.streams[0] ?? new MediaStream([event.track]);
    remoteStreamRef.current = stream;

    let audio = remoteAudioRef.current;
    if (!audio) {
      audio = document.createElement("audio");
      audio.autoplay = true;
      audio.setAttribute("playsinline", "true");
      audio.setAttribute("aria-hidden", "true");
      audio.style.display = "none";
      document.body.appendChild(audio);
      remoteAudioRef.current = audio;
    }
    audio.srcObject = stream;
    void audio.play().catch(() => {
      // `resumeAudio` lets the UI recover if the browser requires another tap.
    });

    const meters = metersRef.current;
    if (!meters || meters.remoteSource) return;
    try {
      const remote = attachAnalyser(meters.context, stream);
      meters.remoteSource = remote.source;
      meters.remoteAnalyser = remote.analyser;
      meters.remoteSilencer = remote.silencer;
      meters.remoteBuffer = remote.buffer;
    } catch {
      // Audio playback remains functional even if metering is unsupported.
    }
  }, []);

  const handleServerEvent = useCallback((raw: unknown) => {
    const event = parseWolfieRealtimeServerEvent(raw);
    if (!event) return;

    if (event.type === "input_audio_buffer.speech_started") {
      touchActivity();
      activeInputItemIdRef.current = realtimeInputItemId(event);
    } else if (event.type === "input_audio_buffer.committed") {
      const itemId = realtimeInputItemId(
        event,
        activeInputItemIdRef.current,
      );
      if (itemId && !committedInputIdsRef.current.has(itemId)) {
        committedInputIdsRef.current.add(itemId);
        publishCompletedTurns(
          turnAssemblerRef.current.commitInput(itemId),
        );
      }
    } else if (
      event.type === "conversation.item.input_audio_transcription.delta"
    ) {
      const itemId = realtimeInputItemId(
        event,
        activeInputItemIdRef.current,
      );
      if (itemId) {
        const current = inputDraftsRef.current.get(itemId) ?? {
          text: "",
          logprobSum: 0,
          logprobCount: 0,
        };
        const logprobs = wolfieRealtimeEventLogprobs(event);
        inputDraftsRef.current.set(itemId, {
          text: `${current.text}${eventString(event, "delta")}`.slice(-8_000),
          logprobSum: current.logprobSum +
            logprobs.reduce((sum, value) => sum + value, 0),
          logprobCount: current.logprobCount + logprobs.length,
        });
      }
    } else if (
      event.type === "conversation.item.input_audio_transcription.completed"
    ) {
      const itemId = realtimeInputItemId(
        event,
        activeInputItemIdRef.current,
      );
      const draft = itemId ? inputDraftsRef.current.get(itemId) : undefined;
      const text = (
        eventString(event, "transcript") || draft?.text || ""
      ).trim().slice(0, 8_000);
      const finalLogprobs = wolfieRealtimeEventLogprobs(event);
      const logprobSum = finalLogprobs.length
        ? finalLogprobs.reduce((sum, value) => sum + value, 0)
        : draft?.logprobSum ?? 0;
      const logprobCount = finalLogprobs.length
        ? finalLogprobs.length
        : draft?.logprobCount ?? 0;
      const asrConfidence = logprobCount
        ? Math.min(1, Math.max(0, Math.exp(logprobSum / logprobCount)))
        : estimateRoughAsrConfidence(event);
      if (itemId) {
        publishCompletedTurns(
          turnAssemblerRef.current.completeInput({
            key: itemId,
            text,
            inputMethod: "audio_transcription",
            asrConfidence,
          }),
        );
        inputDraftsRef.current.delete(itemId);
        if (activeInputItemIdRef.current === itemId) {
          activeInputItemIdRef.current = "";
        }
      }
    } else if (
      event.type === "conversation.item.input_audio_transcription.failed"
    ) {
      const itemId = realtimeInputItemId(
        event,
        activeInputItemIdRef.current,
      );
      if (itemId) inputDraftsRef.current.delete(itemId);
    } else if (event.type === "response.created") {
      touchActivity();
      const responseId = realtimeResponseId(event);
      activeResponseIdRef.current = responseId;
      if (responseId) {
        publishCompletedTurns(
          turnAssemblerRef.current.beginResponse(responseId),
        );
      }
    } else if (
      event.type === "response.output_audio_transcript.delta" ||
      event.type === "response.output_text.delta"
    ) {
      const responseId = realtimeResponseId(
        event,
        activeResponseIdRef.current,
      );
      if (responseId) {
        turnAssemblerRef.current.appendAssistant(
          responseId,
          eventString(event, "delta"),
        );
      }
    } else if (
      event.type === "response.output_audio_transcript.done" ||
      event.type === "response.output_text.done"
    ) {
      const responseId = realtimeResponseId(
        event,
        activeResponseIdRef.current,
      );
      const text = (
        eventString(event, "transcript") ||
        eventString(event, "text")
      ).trim().slice(0, 8_000);
      if (responseId && text) {
        publishCompletedTurns(
          turnAssemblerRef.current.setAssistant(responseId, text),
        );
      }
    } else if (event.type === "response.done") {
      const responseId = realtimeResponseId(
        event,
        activeResponseIdRef.current,
      );
      // Grava o consumo ANTES de finishResponse: é ele que publica o turno,
      // e o turno já precisa sair com o custo anexado.
      const usage = extractWolfieRealtimeUsage(event);
      if (responseId && usage) {
        realtimeUsageRef.current.set(responseId, usage);
      }
      if (responseId) {
        publishCompletedTurns(
          turnAssemblerRef.current.finishResponse(
            responseId,
            realtimeResponseStatus(event),
            extractWolfieRealtimeResponseTranscript(event),
          ),
        );
        if (activeResponseIdRef.current === responseId) {
          activeResponseIdRef.current = "";
        }
      }
    } else if (event.type === "response.cancelled") {
      const responseId = realtimeResponseId(
        event,
        activeResponseIdRef.current,
      );
      if (responseId) {
        turnAssemblerRef.current.discardResponse(responseId);
        if (activeResponseIdRef.current === responseId) {
          activeResponseIdRef.current = "";
        }
      }
    }

    dispatch({ type: "server.event", event });
    latestOptionsRef.current.onEvent?.(event);
  }, [publishCompletedTurns, touchActivity]);

  const connect = useCallback(async (): Promise<
    WolfieRealtimeConnectResult
  > => {
    if (connectingRef.current) {
      return {
        ok: false,
        fallback: false,
        message: "A conexão já está sendo iniciada.",
      };
    }

    const currentOptions = latestOptionsRef.current;
    if (!currentOptions.enabled) {
      return markFallback(
        "disabled",
        "O modo OpenAI Realtime não está habilitado.",
      );
    }
    if (!browserSupportsRealtime()) {
      return markFallback(
        "unsupported_browser",
        "Este navegador não oferece os recursos de voz em tempo real.",
      );
    }

    const endpoint = currentOptions.functionUrl?.trim() ||
      DEFAULT_FUNCTION_URL;
    if (!endpoint || !SUPABASE_ANON_KEY) {
      return markFallback(
        "missing_configuration",
        "O modo em tempo real ainda não foi configurado.",
      );
    }

    cleanupResources(false);
    const connectionAttempt = connectionAttemptRef.current;
    connectingRef.current = true;
    setLastCompletedTurn(null);
    setFallbackReason(null);
    dispatch({ type: "local.reset" });
    dispatch({ type: "local.phase", phase: "requesting_permission" });

    let microphone: MediaStream;
    try {
      microphone = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch {
      if (connectionAttemptRef.current !== connectionAttempt) {
        return {
          ok: false,
          fallback: false,
          message: "A conexão foi cancelada.",
        };
      }
      connectingRef.current = false;
      return markFallback(
        "microphone_unavailable",
        "Não foi possível acessar o microfone. Verifique a permissão do navegador.",
      );
    }

    if (
      connectionAttemptRef.current !== connectionAttempt ||
      !mountedRef.current
    ) {
      stopStream(microphone);
      return {
        ok: false,
        fallback: false,
        message: "A conexão foi cancelada.",
      };
    }

    microphoneRef.current = microphone;
    startMeters(microphone);
    dispatch({ type: "local.phase", phase: "connecting" });

    const peer = new RTCPeerConnection();
    peerRef.current = peer;
    microphone.getTracks().forEach((track) => peer.addTrack(track, microphone));
    peer.ontrack = attachRemoteStream;
    peer.onconnectionstatechange = () => {
      if (
        peer.connectionState === "connected" &&
        channel.readyState === "open"
      ) {
        if (disconnectedTimeoutRef.current !== null) {
          window.clearTimeout(disconnectedTimeoutRef.current);
          disconnectedTimeoutRef.current = null;
        }
        connectingRef.current = false;
        dispatch({ type: "local.phase", phase: "connected" });
      } else if (peer.connectionState === "disconnected") {
        if (disconnectedTimeoutRef.current === null) {
          disconnectedTimeoutRef.current = window.setTimeout(() => {
            disconnectedTimeoutRef.current = null;
            if (
              mountedRef.current &&
              peerRef.current === peer &&
              peer.connectionState === "disconnected"
            ) {
              markFallback(
                "connection_failed",
                "A conexão em tempo real não se recuperou. Voltamos ao modo de voz clássico.",
              );
            }
          }, DISCONNECTED_GRACE_MS);
        }
      } else if (
        peer.connectionState === "failed" ||
        peer.connectionState === "closed"
      ) {
        if (disconnectedTimeoutRef.current !== null) {
          window.clearTimeout(disconnectedTimeoutRef.current);
          disconnectedTimeoutRef.current = null;
        }
        if (mountedRef.current && peerRef.current === peer) {
          markFallback(
            "connection_failed",
            "A conversa em tempo real foi interrompida. Voltamos ao modo de voz clássico.",
          );
        }
      }
    };

    const channel = peer.createDataChannel("oai-events");
    dataChannelRef.current = channel;
    channel.onopen = () => {
      if (mountedRef.current) {
        if (disconnectedTimeoutRef.current !== null) {
          window.clearTimeout(disconnectedTimeoutRef.current);
          disconnectedTimeoutRef.current = null;
        }
        connectingRef.current = false;
        dispatch({ type: "local.phase", phase: "connected" });
      }
    };
    channel.onclose = () => {
      if (mountedRef.current && peerRef.current === peer) {
        markFallback(
          "connection_failed",
          "O canal da conversa em tempo real foi fechado. Voltamos ao modo de voz clássico.",
        );
      }
    };
    channel.onerror = () => {
      if (mountedRef.current && peerRef.current === peer) {
        markFallback(
          "connection_failed",
          "O canal da conversa em tempo real encontrou um erro. Voltamos ao modo de voz clássico.",
        );
      }
    };
    channel.onmessage = (event) => handleServerEvent(event.data);

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      if (
        connectionAttemptRef.current !== connectionAttempt ||
        !mountedRef.current
      ) {
        return {
          ok: false,
          fallback: false,
          message: "A conexão foi cancelada.",
        };
      }
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) {
        connectingRef.current = false;
        return markFallback(
          "authentication_required",
          "Sua sessão expirou. Entre novamente para conversar com o Wolfie.",
        );
      }

      const offer = await peer.createOffer();
      if (connectionAttemptRef.current !== connectionAttempt) {
        return {
          ok: false,
          fallback: false,
          message: "A conexão foi cancelada.",
        };
      }
      await peer.setLocalDescription(offer);
      const offerSdp = peer.localDescription?.sdp;
      if (!offerSdp) throw new Error("missing_local_sdp");

      const abort = new AbortController();
      setupAbortRef.current = abort;
      const timeout = window.setTimeout(
        () => abort.abort(),
        SESSION_SETUP_TIMEOUT_MS,
      );
      let response: Response;
      try {
        response = await fetch(buildSessionUrl(endpoint, currentOptions), {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "apikey": SUPABASE_ANON_KEY,
            "Content-Type": "application/sdp",
          },
          body: offerSdp,
          signal: abort.signal,
        });
      } finally {
        window.clearTimeout(timeout);
        if (setupAbortRef.current === abort) setupAbortRef.current = null;
      }

      if (
        connectionAttemptRef.current !== connectionAttempt ||
        !mountedRef.current
      ) {
        return {
          ok: false,
          fallback: false,
          message: "A conexão foi cancelada.",
        };
      }

      const responseType = response.headers.get("content-type") ?? "";
      if (!response.ok || !responseType.includes("application/sdp")) {
        const failure = await readFallbackPayload(response);
        connectingRef.current = false;
        return markFallback(
          "service_unavailable",
          failure.message,
        );
      }

      const answerSdp = await response.text();
      if (!answerSdp.startsWith("v=0")) {
        throw new Error("invalid_remote_sdp");
      }
      await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
      if (connectionAttemptRef.current !== connectionAttempt) {
        return {
          ok: false,
          fallback: false,
          message: "A conexão foi cancelada.",
        };
      }
      await waitForRealtimeTransport(
        peer,
        channel,
        TRANSPORT_READY_TIMEOUT_MS,
      );
      if (
        connectionAttemptRef.current !== connectionAttempt ||
        !mountedRef.current
      ) {
        return {
          ok: false,
          fallback: false,
          message: "A conexão foi cancelada.",
        };
      }
      connectingRef.current = false;
      dispatch({ type: "local.phase", phase: "connected" });
      // A conversa (e a cobrança) só começa aqui: os freios de duração e
      // ociosidade valem a partir da conexão de fato, não da tentativa.
      startCostTimers();
      return { ok: true, fallback: false };
    } catch (error) {
      if (
        connectionAttemptRef.current !== connectionAttempt ||
        !mountedRef.current
      ) {
        return {
          ok: false,
          fallback: false,
          message: "A conexão foi cancelada.",
        };
      }
      connectingRef.current = false;
      if (
        error instanceof DOMException &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      ) {
        return markFallback(
          "service_unavailable",
          "O modo em tempo real demorou para conectar. Voltamos ao modo de voz clássico.",
        );
      }
      return markFallback(
        "connection_failed",
        "Não foi possível iniciar a conversa em tempo real. Use o modo de voz atual.",
      );
    }
  }, [
    attachRemoteStream,
    cleanupResources,
    handleServerEvent,
    markFallback,
    startCostTimers,
    startMeters,
  ]);

  const disconnect = useCallback(() => {
    if (mountedRef.current) {
      dispatch({ type: "local.phase", phase: "closing" });
    }
    cleanupResources(true);
  }, [cleanupResources]);

  const sendEvent = useCallback((
    type: string,
    payload: Record<string, unknown> = {},
  ): boolean => {
    const channel = dataChannelRef.current;
    if (!dataChannelIsOpen(channel)) return false;
    try {
      channel.send(serializeWolfieRealtimeEvent(type, payload));
      return true;
    } catch {
      return false;
    }
  }, []);

  const interrupt = useCallback((): boolean => {
    if (!protocol.responseId && !protocol.isAssistantSpeaking) return false;
    const cancelled = protocol.responseId
      ? sendEvent("response.cancel")
      : false;
    const cleared = protocol.isAssistantSpeaking
      ? sendEvent("output_audio_buffer.clear")
      : false;
    if (cancelled || cleared) {
      dispatch({ type: "local.phase", phase: "listening" });
    }
    return cancelled || cleared;
  }, [protocol.isAssistantSpeaking, protocol.responseId, sendEvent]);

  const sendText = useCallback((rawText: string): boolean => {
    const text = rawText.trim().slice(0, MAX_TEXT_INPUT_LENGTH);
    if (!text) return false;
    const itemSent = sendEvent("conversation.item.create", {
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    if (!itemSent) return false;
    const responseSent = sendEvent("response.create");
    if (responseSent) {
      const inputKey = localId("text");
      publishCompletedTurns(turnAssemblerRef.current.completeInput({
        key: inputKey,
        text,
        inputMethod: "text",
        asrConfidence: null,
      }));
      publishCompletedTurns(turnAssemblerRef.current.commitInput(inputKey));
    }
    return responseSent;
  }, [publishCompletedTurns, sendEvent]);

  const setMuted = useCallback((nextMuted: boolean) => {
    microphoneRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
    setMutedState(nextMuted);
  }, []);

  const toggleMuted = useCallback(() => {
    setMuted(!muted);
  }, [muted, setMuted]);

  const resumeAudio = useCallback(async (): Promise<boolean> => {
    try {
      const meters = metersRef.current;
      if (meters?.context.state === "suspended") {
        await meters.context.resume();
      }
      const audio = remoteAudioRef.current;
      if (audio) await audio.play();
      return true;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cleanupResources(false);
    };
  }, [cleanupResources]);

  useEffect(() => {
    if (
      !options.enabled &&
      (connectingRef.current || peerRef.current || microphoneRef.current)
    ) {
      cleanupResources(true);
    }
  }, [cleanupResources, options.enabled]);

  return {
    phase: protocol.phase,
    connected: protocol.phase === "connected" ||
      protocol.phase === "listening" ||
      protocol.phase === "thinking" ||
      protocol.phase === "speaking",
    isUserSpeaking: protocol.isUserSpeaking,
    isAssistantSpeaking: protocol.isAssistantSpeaking,
    userTranscript: protocol.userTranscript,
    assistantTranscript: protocol.assistantTranscript,
    lastUserTranscript: protocol.lastUserTranscript,
    lastAssistantTranscript: protocol.lastAssistantTranscript,
    lastCompletedTurn,
    userTranscriptConfidence: protocol.userTranscriptConfidence,
    inputTranscriptIsRoughGuide: true,
    localAudioLevel: levels.local,
    remoteAudioLevel: levels.remote,
    muted,
    error: protocol.error,
    fallbackReason,
    connect,
    disconnect,
    interrupt,
    sendText,
    setMuted,
    toggleMuted,
    resumeAudio,
  };
}
