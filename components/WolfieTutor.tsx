import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Languages,
  Loader2,
  MessageSquare,
  Mic,
  MicOff,
  Radio,
  RotateCcw,
  Send,
  Volume2,
  VolumeX,
  X,
  Zap,
} from "lucide-react";
import { supabase } from "../lib/supabase";
import {
  decodeBase64Audio,
  getTTSSpeed,
  IS_IOS,
  prepareForTTS,
  resolveTtsVoice,
  selectWolfieBrowserVoice,
  SILENT_WAV,
  splitSpeechSentences,
} from "../lib/wolfieAudio";
import {
  shouldConfirmVoiceTranscript,
  uniqueTranscriptAlternatives,
} from "../lib/wolfieVoiceSafety";
import {
  resolveWolfieLearnerLanguage,
  type WolfieLearnerLanguage,
} from "../supabase/functions/wolfie-brain/adaptive-language-policy";
import {
  classifyWolfieLearnerTurn,
  inferWolfieSocialTurnLanguage,
  isPedagogicallySubstantiveTurn,
} from "../supabase/functions/wolfie-brain/turn-policy";
import {
  useWolfieRealtime,
  type WolfieRealtimeCompletedTurn,
  type WolfieRealtimePreparedSession,
  type WolfieRealtimeServerGuidance,
} from "../src/services/useWolfieRealtime";
import {
  beginRealtimePostTurn,
  finishRealtimePostTurn,
  initialRealtimePostTurnGateState,
  realtimeConversationIdAfterExit,
  realtimePostTurnGateIsBlocked,
  realtimePostTurnTokenIsCurrent,
  realtimeSessionNeedsClassicHandoff,
  reconcileClassicReplayBubble,
  resetRealtimePostTurnGate,
  setRealtimeConfirmationPending,
  type RealtimeConversationExit,
  type RealtimePostTurnGateToken,
} from "../src/services/wolfieConversationState";
import {
  handoffWolfieRealtimeToClassic,
  WolfieRealtimeHandoffError,
} from "../src/services/wolfieRealtimeHandoff";
import { WolfieAvatar } from "./WolfieAvatar";
import { WolfieTranscriptReview } from "./WolfieTranscriptReview";
import { WolfieLiveBalance } from "./WolfieLiveBalance";
import { WolfieCaptionBar } from "../src/components/wolfie/visuals/WolfieCaptionBar";
import { WolfieCharacter } from "../src/components/wolfie/visuals/WolfieCharacter";
import { WolfieCoachSheet } from "../src/components/wolfie/visuals/WolfieCoachSheet";
import { WOLFIE_SCENARIO_UI_V2_ENABLED } from "../src/components/wolfie/visuals/featureFlags";
import { WolfieMeetingHUD } from "../src/components/wolfie/visuals/WolfieMeetingHUD";
import { resolveScene } from "../src/components/wolfie/visuals/resolveScene";
import { WolfieScenarioStage } from "../src/components/wolfie/visuals/WolfieScenarioStage";
import { WolfieSessionHUD } from "../src/components/wolfie/visuals/WolfieSessionHUD";
import { resolveMeetingVisualState } from "../src/components/wolfie/visuals/visualStateResolver";

// ============================================================
// TYPES
// ============================================================
export interface WolfieHubContext {
  accountId: string;
  onUsageCommitted?: () => void | Promise<void>;
}

interface WolfieTutorProps {
  user: any;
  voiceMode?: boolean; // If true, starts directly in voice mode (used by WolfieLiveCall wrapper)
  topic?: string;
  experienceMode?: string;
  correctionMode?: string;
  languageMode?: string;
  difficulty?: string;
  scenario?: string | Record<string, unknown>;
  studentGoal?: string;
  targetSkill?: string;
  experienceId?: string;
  experienceUniverse?: string;
  experienceAudiences?: string[];
  hubContext?: WolfieHubContext;
  onClose?: () => void;
}

interface CorrectionData {
  original: string;
  corrected: string;
  explanation_pt: string;
  naturalVersion?: string;
  priority?: "low" | "medium" | "high";
  usefulChunk?: string;
  retryRequired?: boolean;
}

interface TurnGuidance {
  currentStage: string;
  scenarioStatus: string;
  learnerIntent: string;
  counterpart: string;
  pendingQuestion: string;
  pendingDecision: string;
  strengths: string[];
  priorities: string[];
  nextAction: string;
  needsExternalVerification: boolean;
  verificationReason: string;
  retryRequired: boolean;
  sessionScore: number | null;
}

interface VocabTerm {
  term: string;
  definition: string;
  level: string;
  synonyms: string[];
  example: string;
}

interface VocabData {
  keyTerms: VocabTerm[];
  grammarNote: string;
}

interface QuizData {
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  correction?: CorrectionData | null;
  translation?: string | null;
  vocabulary?: VocabData | null;
  quiz?: QuizData | null;
}

type CallState =
  | "IDLE"
  | "LISTENING"
  | "THINKING"
  | "SYNTHESIZING"
  | "SPEAKING";

type VoiceTransport = "realtime" | "classic" | "text";

const WOLFIE_REALTIME_ENABLED =
  String(import.meta.env.VITE_WOLFIE_REALTIME_ENABLED ?? "true")
    .toLocaleLowerCase("en-US") !== "false";

const HUB_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const hubOpeningMessage = (topic?: string, goal?: string): string =>
  [
    `Welcome to ${topic?.trim() || "your Wise Wolf practice"}.`,
    goal?.trim(),
    "Start with what you would say first in this situation.",
  ].filter(Boolean).join(" ");

const EMPTY_TURN_GUIDANCE: TurnGuidance = {
  currentStage: "",
  scenarioStatus: "active",
  learnerIntent: "perform",
  counterpart: "",
  pendingQuestion: "",
  pendingDecision: "",
  strengths: [],
  priorities: [],
  nextAction: "",
  needsExternalVerification: false,
  verificationReason: "",
  retryRequired: false,
  sessionScore: null,
};

const resolveVisualPressureLabel = (value?: string): string => {
  switch (value) {
    case "supportive":
      return "Apoio alto";
    case "balanced":
      return "Pressão equilibrada";
    case "challenging":
      return "Pressão alta";
    case "adaptive":
      return "Pressão adaptativa";
    default:
      return "Pressão adaptativa";
  }
};

type WolfieLearnerTurnKind = ReturnType<typeof classifyWolfieLearnerTurn>;

const resolveWolfieLearnerTurnKind = (
  value: string,
  fallback: WolfieLearnerTurnKind,
): WolfieLearnerTurnKind => {
  switch (value.trim().toLocaleLowerCase("en-US")) {
    case "opening":
    case "greeting":
    case "noise":
    case "substantive":
      return value.trim().toLocaleLowerCase(
        "en-US",
      ) as WolfieLearnerTurnKind;
    default:
      return fallback;
  }
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const firstString = (
  record: Record<string, unknown>,
  ...keys: string[]
): string => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
};

const firstBoolean = (
  record: Record<string, unknown>,
  ...keys: string[]
): boolean => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
    if (value === "true" || value === 1) return true;
  }
  return false;
};

const firstStringArray = (
  record: Record<string, unknown>,
  ...keys: string[]
): string[] => {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean);
    }
    if (typeof value === "string" && value.trim()) return [value.trim()];
  }
  return [];
};

const firstNumber = (
  record: Record<string, unknown>,
  ...keys: string[]
): number | null => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
};

const normalizeCorrection = (value: unknown): CorrectionData | null => {
  const raw = asRecord(value);
  const original = firstString(
    raw,
    "original",
    "originalText",
    "original_text",
  );
  const corrected = firstString(
    raw,
    "corrected",
    "correctedText",
    "corrected_text",
  );
  const explanation = firstString(
    raw,
    "explanation_pt",
    "explanationPt",
    "explanation",
  );
  const naturalVersion = firstString(
    raw,
    "naturalVersion",
    "natural_version",
    "naturalSentence",
    "natural_sentence",
  );
  const priorityValue = firstString(raw, "priority").toLowerCase();
  const priority = priorityValue === "low" ||
      priorityValue === "medium" ||
      priorityValue === "high"
    ? priorityValue
    : undefined;
  const usefulChunk = firstString(
    raw,
    "usefulChunk",
    "useful_chunk",
    "chunk",
  );
  const retryRequired = firstBoolean(
    raw,
    "retryRequired",
    "retry_required",
    "requiresRetry",
    "requires_retry",
  );

  if (!original && !corrected && !explanation && !naturalVersion) return null;
  return {
    original,
    corrected: corrected || naturalVersion,
    explanation_pt: explanation,
    naturalVersion: naturalVersion || undefined,
    priority,
    usefulChunk: usefulChunk || undefined,
    retryRequired,
  };
};

const normalizeCorrections = (
  payload: Record<string, unknown>,
): CorrectionData[] => {
  const rawCorrections = Array.isArray(payload.corrections)
    ? payload.corrections
    : payload.correction
    ? [payload.correction]
    : [];
  return rawCorrections
    .map(normalizeCorrection)
    .filter((item): item is CorrectionData => Boolean(item));
};

declare global {
  interface Window {
    webkitSpeechRecognition: any;
  }
}

type SpeechLanguage = WolfieLearnerLanguage;
type TtsLanguage = SpeechLanguage | "mixed";

const WOLFIE_BRAIN_TIMEOUT_MS = 40_000;
const WOLFIE_TRANSCRIPTION_TIMEOUT_MS = 25_000;
const WOLFIE_TTS_TIMEOUT_MS = 15_000;
const MAX_CLASSIC_RECORDING_BYTES = 4_900_000;
const MAX_CLASSIC_RECORDING_MS = 90_000;

const classicRecorderMimeType = (): string | undefined => {
  if (
    typeof MediaRecorder === "undefined" ||
    typeof MediaRecorder.isTypeSupported !== "function"
  ) {
    return undefined;
  }
  return [
    "audio/webm;codecs=opus",
    "audio/mp4",
    "audio/ogg;codecs=opus",
    "audio/webm",
  ].find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
};

const audioBlobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("AUDIO_READ_FAILED"));
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      const separator = value.indexOf(",");
      resolve(separator >= 0 ? value.slice(separator + 1) : value);
    };
    reader.readAsDataURL(blob);
  });

function detectSpeechLanguage(
  text: string,
  fallback: SpeechLanguage = "en",
): SpeechLanguage {
  return resolveWolfieLearnerLanguage(text, fallback);
}

function normalizedSpeechLanguage(
  value: unknown,
  fallback: SpeechLanguage,
): SpeechLanguage {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (
    normalized === "pt" || normalized === "pt-br" || normalized === "portuguese"
  ) {
    return "pt";
  }
  if (
    normalized === "en" || normalized === "en-us" || normalized === "english"
  ) {
    return "en";
  }
  return fallback;
}

interface WolfieBrainInput {
  message?: string;
  audioBase64?: string;
  uiMessageId?: string;
  studentLanguage?: SpeechLanguage;
  transcriptionConfidence?: number | null;
  transcriptionAlternatives?: string[];
  speechDerivedTranscript?: boolean;
  transcriptConfirmed?: boolean;
}

interface PendingTranscriptReview {
  transcript: string;
  alternatives: string[];
  confidence: number | null;
  studentLanguage: SpeechLanguage;
  source?: "classic" | "realtime";
  clientTurnId?: string;
}

interface SpeechSegment {
  text: string;
  language: SpeechLanguage;
}

// ============================================================
// INLINE QUIZ COMPONENT
// ============================================================
const InlineQuiz: React.FC<{ quiz: QuizData }> = ({ quiz }) => {
  const [answered, setAnswered] = useState<number | null>(null);

  return (
    <div className="bg-fuchsia-950/30 backdrop-blur-xl border border-fuchsia-500/20 p-4 rounded-2xl mt-3">
      <div className="flex items-center gap-2 mb-3 text-fuchsia-400">
        <BrainCircuit size={14} />
        <span className="text-[10px] uppercase font-bold tracking-wider">
          Mini Quiz
        </span>
      </div>
      <p className="text-sm font-bold text-white mb-3 leading-snug">
        {quiz.question}
      </p>
      <div className="space-y-2">
        {quiz.options.map((opt, idx) => {
          const isCorrect = idx === quiz.correctIndex;
          const isSelected = answered === idx;

          let classes =
            "w-full text-left text-xs p-3 rounded-xl border transition-all ";
          if (answered === null) {
            classes +=
              "bg-white/5 hover:bg-fuchsia-500/20 border-white/5 text-slate-200 cursor-pointer";
          } else if (isSelected && isCorrect) {
            classes +=
              "bg-emerald-500/20 border-emerald-500/30 text-emerald-300";
          } else if (isSelected && !isCorrect) {
            classes += "bg-red-500/20 border-red-500/30 text-red-300";
          } else if (isCorrect) {
            classes +=
              "bg-emerald-500/10 border-emerald-500/20 text-emerald-400";
          } else {
            classes += "bg-white/5 border-white/5 text-slate-400";
          }

          return (
            <button
              key={idx}
              onClick={() => answered === null && setAnswered(idx)}
              className={classes}
              disabled={answered !== null}
            >
              {opt}
            </button>
          );
        })}
      </div>
      {answered !== null && (
        <p className="text-xs text-slate-300 mt-3 pt-3 border-t border-white/10 leading-relaxed">
          {answered === quiz.correctIndex ? "✨ " : "💡 "}
          {quiz.explanation}
        </p>
      )}
    </div>
  );
};

// ============================================================
// MAIN COMPONENT — UNIFIED VOICE + TEXT
// ============================================================
const WolfieTutor: React.FC<WolfieTutorProps> = ({
  user,
  voiceMode = false,
  topic: initialTopic,
  experienceMode,
  correctionMode,
  languageMode,
  difficulty,
  scenario,
  studentGoal,
  targetSkill,
  experienceId,
  experienceUniverse,
  experienceAudiences,
  hubContext,
  onClose,
}) => {
  const hubModeRequested = typeof hubContext !== "undefined";
  const hubAccountId = typeof hubContext?.accountId === "string"
    ? hubContext.accountId.trim()
    : "";
  const hubAccountContextValid = HUB_UUID_PATTERN.test(hubAccountId);
  const initialHubMessage = hubOpeningMessage(initialTopic, studentGoal);

  // --- Core State ---
  const [state, setState] = useState<CallState>("IDLE");
  const [messages, setMessages] = useState<Message[]>(() =>
    hubModeRequested
      ? [{
        id: crypto.randomUUID(),
        role: "assistant",
        content: initialHubMessage,
        timestamp: new Date(),
      }]
      : []
  );
  const [inputText, setInputText] = useState("");
  const [subtitle, setSubtitle] = useState(
    hubModeRequested ? initialHubMessage : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [turnCount, setTurnCount] = useState(0);
  const [conversationId, setConversationId] = useState<string | null>(() =>
    hubModeRequested ? crypto.randomUUID() : null
  );

  /**
   * Fronteira gratuito x premium. A fonte é o servidor (RPC `my_wolfie_tier`);
   * aqui só refletimos: no gratuito o Wolfie responde POR ESCRITO, porque a voz
   * é o recurso pago. `null` = ainda carregando, e carregando vale gratuito —
   * liberar voz na dúvida é exatamente o custo que esta separação fecha.
   */
  const [voiceReplies, setVoiceReplies] = useState<boolean | null>(
    hubModeRequested ? false : null,
  );
  const voiceRepliesRef = useRef<boolean | null>(
    hubModeRequested ? false : null,
  );

  useEffect(() => {
    if (hubModeRequested) {
      voiceRepliesRef.current = false;
      setVoiceReplies(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase.rpc("my_wolfie_tier");
      if (cancelled) return;
      const snapshot = !error && data && typeof data === "object"
        ? data as { voice_replies?: boolean }
        : null;
      // Falha de leitura não é resposta: mantemos `null` (desconhecido) e
      // deixamos o wolfie-tts decidir. Assim um aluno premium não fica mudo por
      // causa de uma falha momentânea de rede, e o gratuito continua bloqueado
      // no servidor de qualquer forma.
      if (!snapshot) return;
      const allowed = snapshot.voice_replies === true;
      voiceRepliesRef.current = allowed;
      setVoiceReplies(allowed);
    })();
    return () => {
      cancelled = true;
    };
  }, [hubModeRequested]);
  const [pendingTranscriptReview, setPendingTranscriptReview] = useState<
    PendingTranscriptReview | null
  >(null);
  const [isRealtimePostTurnPending, setIsRealtimePostTurnPending] = useState(
    false,
  );
  const [isConfirmingRealtimeTranscript, setIsConfirmingRealtimeTranscript] =
    useState(false);
  const [isDisputingCorrection, setIsDisputingCorrection] = useState(false);

  // --- UI State ---
  const [topic, setTopic] = useState<string>(initialTopic || "");
  const [hasSelectedTopic, setHasSelectedTopic] = useState(!!initialTopic);
  const [context, setContext] = useState<string>("");
  const [translationEnabled, setTranslationEnabled] = useState(true);
  const [autoSpeakEnabled, setAutoSpeakEnabled] = useState(
    !hubModeRequested,
  );
  const [showTextInput, setShowTextInput] = useState(!voiceMode);
  const [showTranscript, setShowTranscript] = useState(false);
  const [restartNonce, setRestartNonce] = useState(0);
  const [isRestarting, setIsRestarting] = useState(false);
  const [audioGestureReady, setAudioGestureReady] = useState(
    () => !IS_IOS || !voiceMode,
  );
  const [voiceTransport, setVoiceTransport] = useState<VoiceTransport>(
    () =>
      !hubModeRequested && voiceMode && WOLFIE_REALTIME_ENABLED
        ? "realtime"
        : "text",
  );

  // --- Overlay Cards (from agents) ---
  const [correction, setCorrection] = useState<CorrectionData | null>(null);
  const [translation, setTranslation] = useState<string | null>(null);
  const [assistantLanguage, setAssistantLanguage] = useState<SpeechLanguage>(
    "en",
  );
  const [vocabulary, setVocabulary] = useState<VocabData | null>(null);
  const [quiz, setQuiz] = useState<QuizData | null>(null);
  const [turnGuidance, setTurnGuidance] = useState<TurnGuidance>(
    EMPTY_TURN_GUIDANCE,
  );

  // --- Session Timer ---
  const [sessionStart, setSessionStart] = useState<Date>(new Date());
  const [elapsed, setElapsed] = useState(0);
  const MAX_SESSION_MINUTES = 120; // 2h — antes era 30, encerrava antes da hora

  // --- History from past sessions ---
  const [isLoadingHistory, setIsLoadingHistory] = useState(!hubModeRequested);

  // --- Refs ---
  const recognitionRef = useRef<any>(null); // fallback local Web Speech API
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaRecorderChunksRef = useRef<Blob[]>([]);
  const mediaRecorderStartedAtRef = useRef(0);
  const mediaRecorderMimeTypeRef = useRef("audio/webm");
  const recordingAttemptRef = useRef(0);
  const recordingMaxDurationRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const brainRequestAbortRef = useRef<AbortController | null>(null);
  const pendingClassicRequestRef = useRef<
    {
      fingerprint: string;
      clientTurnId: string;
      optimisticMessageId: string;
    } | null
  >(null);
  const pendingRealtimeClassicHandoffRef = useRef<string | null>(null);
  const transcriptionAbortRef = useRef<AbortController | null>(null);
  const ttsRequestAbortRef = useRef<AbortController | null>(null);
  const lastLearnerLanguageRef = useRef<SpeechLanguage>("en");
  const isProcessingRef = useRef(false); // Previne chamadas duplicadas ao wolfie-brain
  const requestVersionRef = useRef(0); // Invalida respostas antigas após fechar/reiniciar
  const ttsRequestVersionRef = useRef(0); // Impede áudio antigo após interrupções ou nova fala
  const recordingDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null); // Timeout do delay anti-eco
  const finalTranscriptRef = useRef<string>(""); // Acumula transcript enquanto segura o mascote
  const transcriptAlternativesRef = useRef<string[]>([]);
  const transcriptConfidenceRef = useRef<number | null>(null);
  const englishVoiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const ptBrVoiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const lastSpokenTextRef = useRef<string>("");
  const lastSpokenLanguageRef = useRef<TtsLanguage>("en");
  const lastSpokenSegmentsRef = useRef<SpeechSegment[] | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null); // fallback HTMLAudioElement (desktop)
  const audioCtxRef = useRef<AudioContext | null>(null); // AudioContext — funciona em iOS após unlock
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null); // source node ativo (parar mid-play)
  const inputMeterFrameRef = useRef<number | null>(null);
  const outputMeterFrameRef = useRef<number | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);
  // iOS: keepalive toca buffers silenciosos a cada 500ms para impedir que o
  // iOS auto-suspenda o AudioContext durante o fetch assíncrono (~2-4s)
  const iosKeepAliveRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // iOS: elemento HTMLAudio "pré-desbloqueado" durante o toque — pode ser
  // re-usado com outro src em callbacks async (Apple documenta este padrão)
  const preUnlockedAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const audioStreamRequestRef = useRef<Promise<MediaStream> | null>(null);
  const audioStreamRequestVersionRef = useRef(0);
  const isMountedRef = useRef(true);
  const realtimeTurnIdsRef = useRef(new Set<string>());
  const realtimeConversationIdRef = useRef<string | null>(null);
  const realtimePersistenceRef = useRef<Promise<void>>(Promise.resolve());
  const realtimePostTurnGateRef = useRef(
    initialRealtimePostTurnGateState(),
  );
  const isConfirmingRealtimeTranscriptRef = useRef(false);
  const realtimeGuidanceRelayRef = useRef<
    (guidance: WolfieRealtimeServerGuidance) => Promise<boolean>
  >(() => Promise.resolve(false));
  const realtimeMuteRelayRef = useRef<(muted: boolean) => void>(() => {});
  const realtimeDisconnectRelayRef = useRef<
    (forgetPreparedSession?: boolean) => void
  >(() => {});
  const [audioStream, setAudioStream] = useState<MediaStream | null>(null); // energia visual do mascote
  const [inputLevel, setInputLevel] = useState(0);
  const [outputLevel, setOutputLevel] = useState(0);

  const studentLevel = user.levelBadge || "A1";
  const isRealtimeMode = voiceTransport === "realtime";
  const activePedagogicalTask = [
    topic,
    targetSkill,
  ].filter(Boolean).join("\n");

  const publishRealtimePostTurnGate = useCallback(
    (unmuteWhenOpen = true) => {
      const blocked = realtimePostTurnGateIsBlocked(
        realtimePostTurnGateRef.current,
      );
      if (isMountedRef.current) setIsRealtimePostTurnPending(blocked);
      if (blocked) {
        realtimeMuteRelayRef.current(true);
      } else if (unmuteWhenOpen) {
        realtimeMuteRelayRef.current(false);
      }
    },
    [],
  );

  const beginRealtimePostTurnGate = useCallback(() => {
    const transition = beginRealtimePostTurn(
      realtimePostTurnGateRef.current,
    );
    realtimePostTurnGateRef.current = transition.state;
    publishRealtimePostTurnGate();
    return transition.token;
  }, [publishRealtimePostTurnGate]);

  const finishRealtimePostTurnGate = useCallback(
    (token: RealtimePostTurnGateToken) => {
      realtimePostTurnGateRef.current = finishRealtimePostTurn(
        realtimePostTurnGateRef.current,
        token,
      );
      publishRealtimePostTurnGate();
    },
    [publishRealtimePostTurnGate],
  );

  const markRealtimeConfirmationPending = useCallback(
    (pending: boolean) => {
      realtimePostTurnGateRef.current = setRealtimeConfirmationPending(
        realtimePostTurnGateRef.current,
        pending,
      );
      publishRealtimePostTurnGate();
    },
    [publishRealtimePostTurnGate],
  );

  const resetRealtimeGate = useCallback(() => {
    realtimePostTurnGateRef.current = resetRealtimePostTurnGate(
      realtimePostTurnGateRef.current,
    );
    publishRealtimePostTurnGate(false);
  }, [publishRealtimePostTurnGate]);

  const detachTransportSession = useCallback((
    exit: RealtimeConversationExit = "terminal",
  ) => {
    const nextConversationId = realtimeConversationIdAfterExit(
      realtimeConversationIdRef.current,
      exit,
    );
    realtimeConversationIdRef.current = nextConversationId;
    if (exit === "terminal") {
      realtimeTurnIdsRef.current.clear();
      pendingRealtimeClassicHandoffRef.current = null;
    } else if (nextConversationId) {
      pendingRealtimeClassicHandoffRef.current = nextConversationId;
    }
    setConversationId(nextConversationId);
  }, []);

  const applyRealtimeGuidance = useCallback(async (
    payload: Record<string, unknown>,
  ): Promise<boolean> => {
    const guidance = asRecord(
      payload.realtimeGuidance ?? payload.realtime_guidance,
    );
    if (Object.keys(guidance).length === 0) return false;

    const retryRequired = firstBoolean(
      guidance,
      "requiresRetry",
      "requires_retry",
      "retryRequired",
      "retry_required",
    );
    const normalizedCorrections = normalizeCorrections(guidance);
    const nextCorrection = normalizedCorrections[0]
      ? { ...normalizedCorrections[0], retryRequired }
      : null;
    const score = firstNumber(guidance, "sessionScore", "session_score");
    const currentStage = firstString(
      guidance,
      "currentStage",
      "current_stage",
    ) || firstString(payload, "currentStage", "current_stage");
    const scenarioStatus = firstString(
      guidance,
      "scenarioStatus",
      "scenario_status",
    ) || firstString(payload, "scenarioStatus", "scenario_status");
    const learnerIntent = firstString(
      guidance,
      "learnerIntent",
      "learner_intent",
    ) || firstString(payload, "learnerIntent", "learner_intent");
    const counterpart = firstString(guidance, "counterpart") ||
      firstString(payload, "counterpart");
    const pendingQuestion = firstString(
      guidance,
      "pendingQuestion",
      "pending_question",
    ) || firstString(payload, "pendingQuestion", "pending_question");
    const pendingDecision = firstString(
      guidance,
      "pendingDecision",
      "pending_decision",
    ) || firstString(payload, "pendingDecision", "pending_decision");
    const nextAction = firstString(guidance, "nextAction", "next_action");
    const strengths = firstStringArray(
      guidance,
      "studentStrengths",
      "student_strengths",
      "strengths",
    );
    const priorities = firstStringArray(
      guidance,
      "studentPriorities",
      "student_priorities",
      "priorities",
    );
    const needsExternalVerification = firstBoolean(
      guidance,
      "needsExternalVerification",
      "needs_external_verification",
    );
    const verificationReason = firstString(
      guidance,
      "verificationReason",
      "verification_reason",
    );

    if (isMountedRef.current) {
      setCorrection(nextCorrection);
      setTurnGuidance({
        currentStage,
        scenarioStatus: scenarioStatus || "active",
        learnerIntent: learnerIntent || "perform",
        counterpart,
        pendingQuestion,
        pendingDecision,
        strengths,
        priorities,
        nextAction,
        needsExternalVerification,
        verificationReason,
        retryRequired,
        sessionScore: score === null
          ? null
          : Math.max(0, Math.min(100, Math.round(score))),
      });
    }
    return await realtimeGuidanceRelayRef.current({
      currentStage,
      scenarioStatus,
      requiresRetry: retryRequired,
      retryCompleted: firstBoolean(
        guidance,
        "retryCompleted",
        "retry_completed",
      ),
      nextAction,
      counterpart,
      pendingQuestion,
      pendingDecision,
    });
  }, []);

  const handleRealtimeTurnComplete = useCallback(
    (turn: WolfieRealtimeCompletedTurn) => {
      if (realtimeTurnIdsRef.current.has(turn.id)) return;
      realtimeTurnIdsRef.current.add(turn.id);
      const postTurnGateToken = beginRealtimePostTurnGate();

      // O próximo turno só pode começar depois que a análise autoritativa
      // deste turno atualizar a sessão Realtime. Isso evita que o aluno fale
      // sobre um checkpoint antigo enquanto o backend ainda decide retry/etapa.
      const timestamp = new Date(turn.completedAt);
      setMessages((current) => [
        ...current,
        {
          id: `${turn.id}:student`,
          role: "user",
          content: turn.userTranscript,
          timestamp,
        },
        {
          id: `${turn.id}:wolfie`,
          role: "assistant",
          content: turn.assistantTranscript,
          timestamp,
        },
      ]);
      if (
        isPedagogicallySubstantiveTurn(
          classifyWolfieLearnerTurn(
            turn.userTranscript,
            turn.inputMethod === "audio_transcription",
          ),
          activePedagogicalTask,
        )
      ) {
        setTurnCount((current) => current + 1);
      }
      setAssistantLanguage(
        detectSpeechLanguage(turn.assistantTranscript, "en"),
      );

      // Serializa a persistência para que o primeiro turno crie uma única
      // sessão e os seguintes reutilizem o mesmo conversationId.
      realtimePersistenceRef.current = realtimePersistenceRef.current
        .catch(() => undefined)
        .then(async () => {
          const requestBody = {
            action: "record_realtime_turn",
            conversationId: realtimeConversationIdRef.current,
            clientTurnId: turn.id,
            userTranscript: turn.userTranscript,
            assistantTranscript: turn.assistantTranscript,
            inputMethod: turn.inputMethod,
            asrConfidence: turn.asrConfidence,
            transcriptIsRoughGuide: true,
            // Consumo cobrado pela OpenAI neste turno — base do relatório
            // de custo por aluno e, depois, da cota mensal.
            usage: turn.usage,
          };
          const retryDelaysMs = [0, 600, 1_800, 4_000];
          let payload: Record<string, unknown> = {};
          let analysisStatus = "";
          let lastFailure = "REALTIME_TURN_PERSISTENCE_FAILED";

          for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
            const delayMs = retryDelaysMs[attempt];
            if (delayMs > 0) {
              await new Promise<void>((resolve) => {
                window.setTimeout(resolve, delayMs);
              });
            }
            if (
              !isMountedRef.current ||
              !realtimePostTurnTokenIsCurrent(
                realtimePostTurnGateRef.current,
                postTurnGateToken,
              )
            ) return;

            const { data, error: persistenceError } = await supabase.functions
              .invoke("wolfie-brain", { body: requestBody });
            if (
              !isMountedRef.current ||
              !realtimePostTurnTokenIsCurrent(
                realtimePostTurnGateRef.current,
                postTurnGateToken,
              )
            ) return;
            payload = asRecord(data);
            const nextConversationId = firstString(
              payload,
              "conversationId",
              "conversation_id",
            );
            if (nextConversationId) {
              requestBody.conversationId = nextConversationId;
              realtimeConversationIdRef.current = nextConversationId;
              if (isMountedRef.current) setConversationId(nextConversationId);
            }
            analysisStatus = firstString(
              payload,
              "analysisStatus",
              "analysis_status",
            );
            lastFailure = firstString(payload, "error") ||
              persistenceError?.message || lastFailure;
            const retryable = Boolean(persistenceError || payload.error) ||
              analysisStatus === "processing" ||
              analysisStatus === "retryable";
            if (!retryable) break;
            if (attempt === retryDelaysMs.length - 1) {
              throw new Error(
                analysisStatus === "processing" ||
                  analysisStatus === "retryable"
                  ? "REALTIME_ANALYSIS_RETRY_EXHAUSTED"
                  : lastFailure,
              );
            }
          }

          if (analysisStatus === "unavailable") {
            throw new Error("REALTIME_ANALYSIS_UNAVAILABLE");
          }
          if (
            analysisStatus !== "completed" &&
            analysisStatus !== "awaiting_confirmation"
          ) {
            throw new Error("REALTIME_ANALYSIS_RETRY_EXHAUSTED");
          }
          const guidanceApplied = await applyRealtimeGuidance(payload);
          if (!guidanceApplied) {
            throw new Error("REALTIME_GUIDANCE_ACK_FAILED");
          }
          const currentStage = firstString(
            payload,
            "currentStage",
            "current_stage",
          );
          const scenarioStatus = firstString(
            payload,
            "scenarioStatus",
            "scenario_status",
          );
          if (analysisStatus === "awaiting_confirmation") {
            markRealtimeConfirmationPending(true);
            if (isMountedRef.current) {
              setPendingTranscriptReview((current) =>
                current ?? {
                  transcript: turn.userTranscript,
                  alternatives: [],
                  confidence: turn.asrConfidence,
                  studentLanguage: detectSpeechLanguage(
                    turn.userTranscript,
                    "en",
                  ),
                  source: "realtime",
                  clientTurnId: turn.id,
                }
              );
            }
          } else if (
            currentStage === "completed" || scenarioStatus === "completed"
          ) {
            resetRealtimeGate();
            realtimeDisconnectRelayRef.current(true);
            if (isMountedRef.current) {
              detachTransportSession();
              setVoiceTransport("classic");
              setPendingTranscriptReview(null);
              setState("IDLE");
              setSubtitle(
                "Treinamento concluído. Seu relatório já está disponível.",
              );
            }
          }
        })
        .catch((persistenceError) => {
          if (
            !isMountedRef.current ||
            !realtimePostTurnTokenIsCurrent(
              realtimePostTurnGateRef.current,
              postTurnGateToken,
            )
          ) return;
          console.error(
            "[WolfieTutor] Falha ao salvar turno em tempo real:",
            persistenceError,
          );
          const failureCode = persistenceError instanceof Error
            ? persistenceError.message
            : "REALTIME_TURN_PERSISTENCE_FAILED";
          const guidanceFailed = failureCode ===
            "REALTIME_GUIDANCE_ACK_FAILED";
          const analysisUnavailable = failureCode ===
              "REALTIME_ANALYSIS_UNAVAILABLE" ||
            failureCode === "REALTIME_ANALYSIS_RETRY_EXHAUSTED";
          setPendingTranscriptReview((current) =>
            current?.source === "realtime" &&
              current.clientTurnId === turn.id
              ? null
              : current
          );
          resetRealtimeGate();
          realtimeDisconnectRelayRef.current(false);
          detachTransportSession("handoff_to_classic");
          setVoiceTransport("classic");
          setState("IDLE");
          setError(
            guidanceFailed
              ? "O turno foi salvo, mas a orientação ao vivo não foi confirmada. O Wolfie mudou para a voz clássica."
              : analysisUnavailable
              ? "O turno foi preservado, mas a análise não concluiu após novas tentativas. O Wolfie mudou para a voz clássica."
              : "O turno não pôde ser confirmado com segurança. O Wolfie mudou para a voz clássica.",
          );
          window.setTimeout(() => {
            if (isMountedRef.current) setError(null);
          }, 5000);
        })
        .finally(() => {
          finishRealtimePostTurnGate(postTurnGateToken);
        });
    },
    [
      activePedagogicalTask,
      applyRealtimeGuidance,
      beginRealtimePostTurnGate,
      detachTransportSession,
      finishRealtimePostTurnGate,
      markRealtimeConfirmationPending,
      resetRealtimeGate,
    ],
  );

  const handleRealtimeFallback = useCallback(
    (_reason: string, message: string) => {
      resetRealtimeGate();
      detachTransportSession("handoff_to_classic");
      setVoiceTransport("classic");
      setState("IDLE");
      setError(`${message} O Wolfie mudou para a voz clássica.`);
      window.setTimeout(() => {
        if (isMountedRef.current) setError(null);
      }, 6000);
    },
    [detachTransportSession, resetRealtimeGate],
  );

  const handleRealtimeSessionPrepared = useCallback(
    (prepared: WolfieRealtimePreparedSession) => {
      pendingRealtimeClassicHandoffRef.current = null;
      realtimeConversationIdRef.current = prepared.conversationId;
      setConversationId(prepared.conversationId);
      setTurnGuidance((current) => ({
        ...current,
        currentStage: prepared.currentStage,
        scenarioStatus: prepared.scenarioStatus || current.scenarioStatus,
        retryRequired: prepared.requiresRetry,
      }));
    },
    [],
  );

  const realtime = useWolfieRealtime({
    enabled: !hubModeRequested && WOLFIE_REALTIME_ENABLED && isRealtimeMode,
    conversationId,
    sessionPreparationKey: restartNonce,
    studentLevel,
    topic,
    experienceMode,
    correctionMode,
    languageMode,
    difficulty,
    scenario,
    studentGoal,
    targetSkill,
    experienceId,
    experienceUniverse,
    experienceAudiences,
    onFallback: handleRealtimeFallback,
    onSessionPrepared: handleRealtimeSessionPrepared,
    onTurnComplete: handleRealtimeTurnComplete,
  });

  useEffect(() => {
    realtimeGuidanceRelayRef.current = realtime.applyServerGuidance;
    realtimeMuteRelayRef.current = realtime.setMuted;
    realtimeDisconnectRelayRef.current = realtime.disconnect;
    return () => {
      realtimeGuidanceRelayRef.current = () => Promise.resolve(false);
      realtimeMuteRelayRef.current = () => {};
      realtimeDisconnectRelayRef.current = () => {};
    };
  }, [
    realtime.applyServerGuidance,
    realtime.disconnect,
    realtime.setMuted,
  ]);

  useEffect(() => {
    if (pendingTranscriptReview?.source === "realtime") {
      realtime.setMuted(true);
    }
  }, [
    pendingTranscriptReview?.clientTurnId,
    pendingTranscriptReview?.source,
    realtime.setMuted,
  ]);

  const confirmRealtimeTranscript = useCallback(
    async (review: PendingTranscriptReview, confirmedTranscript: string) => {
      const clientTurnId = review.clientTurnId;
      if (!clientTurnId || isConfirmingRealtimeTranscriptRef.current) return;

      isConfirmingRealtimeTranscriptRef.current = true;
      setIsConfirmingRealtimeTranscript(true);
      markRealtimeConfirmationPending(true);
      setSubtitle("Salvando apenas o dado que você confirmou…");
      setMessages((current) =>
        current.map((message) =>
          message.id === `${clientTurnId}:student`
            ? { ...message, content: confirmedTranscript }
            : message
        )
      );

      try {
        // O turno bruto precisa existir antes de receber uma confirmação
        // separada. A fila também garante que a primeira conversa já tenha id.
        await realtimePersistenceRef.current;
        const realtimeConversationId = realtimeConversationIdRef.current;
        if (!realtimeConversationId) {
          throw new Error("REALTIME_CONVERSATION_NOT_SAVED");
        }

        const { data, error: confirmationError } = await supabase.functions
          .invoke("wolfie-brain", {
            body: {
              action: "confirm_realtime_fact",
              conversationId: realtimeConversationId,
              clientTurnId,
              userTranscript: confirmedTranscript,
              asrConfidence: review.confidence,
              transcriptConfirmed: true,
            },
          });
        const payload = asRecord(data);
        if (confirmationError || payload.error) {
          throw new Error(
            firstString(payload, "error") ||
              confirmationError?.message ||
              "REALTIME_FACT_CONFIRMATION_FAILED",
          );
        }
        const analysisStatus = firstString(
          payload,
          "analysisStatus",
          "analysis_status",
        );
        if (
          analysisStatus === "processing" || analysisStatus === "retryable"
        ) {
          throw new Error("REALTIME_ANALYSIS_RETRY_REQUIRED");
        }
        if (analysisStatus === "unavailable") {
          throw new Error("REALTIME_ANALYSIS_UNAVAILABLE");
        }
        const guidanceApplied = await applyRealtimeGuidance(payload);
        if (!guidanceApplied && isRealtimeMode) {
          throw new Error("REALTIME_GUIDANCE_ACK_FAILED");
        }
        if (!isMountedRef.current) return;
        const currentStage = firstString(
          payload,
          "currentStage",
          "current_stage",
        );
        const scenarioStatus = firstString(
          payload,
          "scenarioStatus",
          "scenario_status",
        );
        setPendingTranscriptReview(null);
        if (currentStage === "completed" || scenarioStatus === "completed") {
          resetRealtimeGate();
          realtime.disconnect(true);
          detachTransportSession();
          setVoiceTransport("classic");
          setState("IDLE");
        } else {
          markRealtimeConfirmationPending(false);
        }
        const recordedCount = firstNumber(
          payload,
          "factsRecorded",
          "facts_recorded",
        ) ?? 0;
        setSubtitle(
          recordedCount > 0
            ? "Informação confirmada e salva na memória do Wolfie."
            : "Transcrição confirmada. Nenhum dado pessoal novo foi salvo.",
        );
        window.setTimeout(() => {
          if (isMountedRef.current) setSubtitle("");
        }, 4500);
      } catch (confirmationFailure) {
        console.error(
          "[WolfieTutor] Falha ao confirmar fato do turno ao vivo:",
          confirmationFailure,
        );
        const guidanceFailed = confirmationFailure instanceof Error &&
          confirmationFailure.message === "REALTIME_GUIDANCE_ACK_FAILED";
        if (guidanceFailed) {
          setPendingTranscriptReview(null);
          resetRealtimeGate();
          realtime.disconnect(false);
          detachTransportSession("handoff_to_classic");
          setVoiceTransport("classic");
          setState("IDLE");
        } else {
          // The same modal remains mounted with its edited value. The next
          // confirmation replays the same clientTurnId and is idempotent.
          setPendingTranscriptReview((current) =>
            current ?? { ...review, transcript: confirmedTranscript }
          );
          markRealtimeConfirmationPending(true);
        }
        if (!isMountedRef.current) return;
        setSubtitle("");
        setError(
          guidanceFailed
            ? "A informação foi confirmada, mas a orientação ao vivo não foi aplicada. O Wolfie mudou para a voz clássica."
            : "Ainda não foi possível concluir este turno. Revise e confirme novamente; o microfone continuará pausado.",
        );
        window.setTimeout(() => {
          if (isMountedRef.current) setError(null);
        }, 5000);
      } finally {
        isConfirmingRealtimeTranscriptRef.current = false;
        if (isMountedRef.current) setIsConfirmingRealtimeTranscript(false);
      }
    },
    [
      applyRealtimeGuidance,
      detachTransportSession,
      isRealtimeMode,
      markRealtimeConfirmationPending,
      realtime.disconnect,
      resetRealtimeGate,
    ],
  );

  const releaseAudioStream = useCallback(() => {
    audioStreamRequestVersionRef.current += 1;
    audioStreamRequestRef.current = null;
    const stream = audioStreamRef.current;
    audioStreamRef.current = null;
    stream?.getTracks().forEach((track) => track.stop());
    if (isMountedRef.current) setAudioStream(null);
  }, []);

  const ensureAudioStream = useCallback(
    async (): Promise<MediaStream | null> => {
      if (typeof navigator === "undefined") return null;
      if (audioStreamRef.current) return audioStreamRef.current;
      if (audioStreamRequestRef.current) {
        try {
          return await audioStreamRequestRef.current;
        } catch {
          return null;
        }
      }

      const mediaDevices = navigator.mediaDevices;
      if (!mediaDevices?.getUserMedia) {
        console.warn(
          "Mascot audio stream unavailable (avatar ficará estático)",
        );
        return null;
      }

      const request = mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const requestVersion = ++audioStreamRequestVersionRef.current;
      audioStreamRequestRef.current = request;
      try {
        const stream = await request;
        if (
          !isMountedRef.current ||
          requestVersion !== audioStreamRequestVersionRef.current
        ) {
          stream.getTracks().forEach((track) => track.stop());
          return null;
        }
        audioStreamRef.current = stream;
        setAudioStream(stream);
        return stream;
      } catch (err) {
        console.warn(
          "Mascot audio stream denied (avatar ficará estático):",
          err,
        );
        return null;
      } finally {
        if (audioStreamRequestRef.current === request) {
          audioStreamRequestRef.current = null;
        }
      }
    },
    [],
  );

  // ============================================================
  // EFFECTS
  // ============================================================

  useEffect(() => {
    realtimeConversationIdRef.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    if (!isRealtimeMode) return;

    switch (realtime.phase) {
      case "requesting_permission":
      case "connecting":
      case "thinking":
        setState("THINKING");
        break;
      case "listening":
        setState("LISTENING");
        break;
      case "speaking":
        setState("SPEAKING");
        break;
      case "connected":
      case "idle":
        setState("IDLE");
        break;
      case "closing":
        setState("IDLE");
        break;
      case "error":
        setError(
          realtime.error ||
            "A conversa ao vivo foi interrompida. Mudamos para a voz clássica.",
        );
        resetRealtimeGate();
        realtime.disconnect(false);
        detachTransportSession("handoff_to_classic");
        setVoiceTransport("classic");
        setState("IDLE");
        break;
      case "fallback":
        // O callback de fallback troca o transporte e explica o motivo.
        break;
    }
  }, [
    isRealtimeMode,
    realtime.disconnect,
    realtime.error,
    realtime.phase,
    resetRealtimeGate,
    detachTransportSession,
  ]);

  useEffect(() => {
    if (!audioStream) {
      setInputLevel(0);
      return;
    }

    const ctx = audioCtxRef.current;
    if (!ctx || ctx.state === "closed") {
      setInputLevel(0);
      return;
    }

    const source = ctx.createMediaStreamSource(audioStream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.68;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let smoothed = 0;

    const measure = () => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (let index = 0; index < samples.length; index++) {
        sum += samples[index] * samples[index];
      }
      const rms = Math.sqrt(sum / samples.length);
      smoothed = smoothed * 0.68 + Math.min(1, rms * 7.5) * 0.32;
      if (isMountedRef.current) setInputLevel(smoothed);
      inputMeterFrameRef.current = requestAnimationFrame(measure);
    };

    measure();
    return () => {
      if (inputMeterFrameRef.current !== null) {
        cancelAnimationFrame(inputMeterFrameRef.current);
        inputMeterFrameRef.current = null;
      }
      source.disconnect();
      analyser.disconnect();
      if (isMountedRef.current) setInputLevel(0);
    };
  }, [audioStream]);

  // Pre-load TTS voices (EN + PT-BR) on mount
  useEffect(() => {
    const findVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length === 0) return;

      const enVoice = selectWolfieBrowserVoice(voices, "en");
      englishVoiceRef.current = enVoice;

      const ptVoice = selectWolfieBrowserVoice(voices, "pt");
      ptBrVoiceRef.current = ptVoice;
    };

    findVoices();
    window.speechSynthesis.onvoiceschanged = findVoices;
    return () => {
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, []);

  // O stream visual do mascote só é solicitado no primeiro gesto de gravação.
  // Este efeito cuida apenas do ciclo de vida e da liberação do microfone.
  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      requestVersionRef.current += 1;
      ttsRequestVersionRef.current += 1;
      recordingAttemptRef.current += 1;
      isProcessingRef.current = false;
      brainRequestAbortRef.current?.abort();
      brainRequestAbortRef.current = null;
      transcriptionAbortRef.current?.abort();
      transcriptionAbortRef.current = null;
      stopSpeaking();
      stopIOSKeepAlive();
      if (recordingDelayRef.current) {
        clearTimeout(recordingDelayRef.current);
        recordingDelayRef.current = null;
      }
      if (recordingMaxDurationRef.current) {
        clearTimeout(recordingMaxDurationRef.current);
        recordingMaxDurationRef.current = null;
      }
      const recorder = mediaRecorderRef.current;
      mediaRecorderRef.current = null;
      mediaRecorderChunksRef.current = [];
      if (recorder && recorder.state !== "inactive") {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        try {
          recorder.stop();
        } catch (_) {}
      }
      const recognition = recognitionRef.current;
      recognitionRef.current = null;
      if (recognition) {
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        try {
          recognition.abort();
        } catch (_) {}
      }
      releaseAudioStream();
    };
  }, []);

  // Session timer
  useEffect(() => {
    const timer = setInterval(() => {
      const diff = Math.floor((Date.now() - sessionStart.getTime()) / 1000);
      setElapsed(diff);
      if (diff >= MAX_SESSION_MINUTES * 60) {
        setError(`Sessão encerrada (${MAX_SESSION_MINUTES} min)`);
        clearInterval(timer);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [sessionStart]);

  // Carrega histórico da última sessão do aluno (persiste entre logins)
  useEffect(() => {
    let cancelled = false;
    if (hubModeRequested) {
      setIsLoadingHistory(false);
      return () => {
        cancelled = true;
      };
    }
    const loadLastSession = async () => {
      if (!user?.id) {
        if (!cancelled) setIsLoadingHistory(false);
        return;
      }
      try {
        // Com um briefing explícito, retoma somente uma sessão ativa com
        // o mesmo tema e a mesma configuração pedagógica. Nunca injeta
        // turnos de outro assunto na experiência recém-escolhida.
        let sessionQuery = supabase
          .from("wolfie_sessions")
          .select(
            "id, topic, started_at, last_activity_at, scenario_status, finished_at, student_level, experience_mode, correction_mode, language_mode, difficulty, scenario_context, student_goal, target_skill, current_stage, realtime_first_client_turn_id, classic_handoff_at",
          )
          .eq("student_id", user.id)
          .is("finished_at", null)
          .in("scenario_status", ["active", "awaiting_retry"]);

        if (initialTopic) {
          sessionQuery = sessionQuery
            .eq("topic", initialTopic)
            .eq("student_level", studentLevel);
          if (experienceMode) {
            sessionQuery = sessionQuery.eq(
              "experience_mode",
              experienceMode,
            );
          }
          if (correctionMode) {
            sessionQuery = sessionQuery.eq(
              "correction_mode",
              correctionMode,
            );
          }
          if (languageMode) {
            sessionQuery = sessionQuery.eq(
              "language_mode",
              languageMode,
            );
          }
          if (difficulty) {
            sessionQuery = sessionQuery.eq("difficulty", difficulty);
          }
          const expectedScenario = typeof scenario === "string"
            ? scenario.trim().slice(0, 4_000)
            : scenario
            ? JSON.stringify(scenario).slice(0, 4_000)
            : "";
          if (expectedScenario) {
            sessionQuery = sessionQuery.eq(
              "scenario_context",
              expectedScenario,
            );
          }
          const expectedGoal = studentGoal?.trim().slice(0, 1_000);
          if (expectedGoal) {
            sessionQuery = sessionQuery.eq(
              "student_goal",
              expectedGoal,
            );
          }
          const expectedSkill = targetSkill?.trim().slice(0, 160);
          if (expectedSkill) {
            sessionQuery = sessionQuery.eq(
              "target_skill",
              expectedSkill,
            );
          }
        }

        const { data: lastSession } = await sessionQuery
          .order("last_activity_at", { ascending: false })
          .order("started_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!lastSession) {
          return;
        }

        // 2. Pega os últimos 20 turnos dessa sessão
        const { data: recentTurns } = await supabase
          .from("wolfie_turns")
          .select(
            "id, speaker, content, turn_index, created_at, structured_payload, requires_retry, stage, language_code",
          )
          .eq("session_id", lastSession.id)
          .order("turn_index", { ascending: false })
          .limit(20);

        const { data: activeRetryCorrection } =
          lastSession.scenario_status === "awaiting_retry"
            ? await supabase
              .from("wolfie_corrections")
              .select(
                "wrong_sentence, correct_sentence, natural_sentence, explanation_pt, priority",
              )
              .eq("session_id", lastSession.id)
              .eq("status", "active")
              .eq("requires_retry", true)
              .eq("retry_completed", false)
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle()
            : { data: null };

        if (cancelled) return;
        const turns = [...(recentTurns ?? [])].reverse();
        const latestWolfieTurn = [...turns]
          .reverse()
          .find((turn: any) => turn.speaker !== "student");
        const latestWolfiePayload = asRecord(
          latestWolfieTurn?.structured_payload,
        );
        realtimeConversationIdRef.current = lastSession.id;
        pendingRealtimeClassicHandoffRef.current =
          realtimeSessionNeedsClassicHandoff(
              lastSession.realtime_first_client_turn_id,
              lastSession.classic_handoff_at,
            )
            ? lastSession.id
            : null;
        setConversationId(lastSession.id);
        setTurnGuidance((current) => ({
          ...current,
          currentStage: firstString(
            latestWolfiePayload,
            "currentStage",
            "current_stage",
            "stage",
          ) || lastSession.current_stage || current.currentStage,
          scenarioStatus: firstString(
            latestWolfiePayload,
            "scenarioStatus",
            "scenario_status",
          ) || lastSession.scenario_status || current.scenarioStatus,
          learnerIntent: firstString(
            latestWolfiePayload,
            "learnerIntent",
            "learner_intent",
          ) || current.learnerIntent,
          counterpart: firstString(latestWolfiePayload, "counterpart") ||
            current.counterpart,
          pendingQuestion: firstString(
            latestWolfiePayload,
            "pendingQuestion",
            "pending_question",
          ) || current.pendingQuestion,
          pendingDecision: firstString(
            latestWolfiePayload,
            "pendingDecision",
            "pending_decision",
          ) || current.pendingDecision,
          retryRequired: lastSession.scenario_status === "awaiting_retry",
        }));
        if (turns && turns.length > 0) {
          const restored: Message[] = turns.map((t: any) => {
            const payload = asRecord(t.structured_payload);
            const restoredCorrection = t.speaker === "student"
              ? null
              : normalizeCorrections(payload)[0] ?? null;
            return {
              id: t.id,
              role: t.speaker === "student" ? "user" : "assistant",
              content: t.content || "",
              timestamp: new Date(t.created_at),
              correction: restoredCorrection,
              translation: firstString(payload, "translation") || null,
            };
          });
          setMessages(restored);
          setTurnCount(
            turns.filter((turn: any) => {
              if (turn.speaker !== "student") return false;
              const payload = asRecord(turn.structured_payload);
              const persistedKind = firstString(
                payload,
                "learnerTurnKind",
                "learner_turn_kind",
              );
              const kind = persistedKind
                ? resolveWolfieLearnerTurnKind(
                  persistedKind,
                  classifyWolfieLearnerTurn(turn.content),
                )
                : classifyWolfieLearnerTurn(turn.content);
              return isPedagogicallySubstantiveTurn(
                kind,
                activePedagogicalTask,
              );
            }).length,
          );
          if (lastSession.topic && !initialTopic) {
            setTopic(lastSession.topic);
            setHasSelectedTopic(true);
          }
        }

        if (lastSession.scenario_status === "awaiting_retry") {
          const retryWolfieTurn = [...turns]
            .reverse()
            .find((turn: any) =>
              turn.speaker !== "student" &&
              normalizeCorrections(asRecord(turn.structured_payload)).length > 0
            );
          const retryPayload = asRecord(
            retryWolfieTurn?.structured_payload ??
              latestWolfieTurn?.structured_payload,
          );
          const retryCorrections = normalizeCorrections(retryPayload);
          const pendingRetryPayload = asRecord(activeRetryCorrection);
          const pendingRetryOriginal = firstString(
            pendingRetryPayload,
            "wrong_sentence",
          );
          const pendingRetryCorrected = firstString(
            pendingRetryPayload,
            "correct_sentence",
          );
          const pendingRetryPriority = firstString(
            pendingRetryPayload,
            "priority",
          );
          const retryCorrection: CorrectionData | null =
            pendingRetryOriginal && pendingRetryCorrected
              ? {
                original: pendingRetryOriginal,
                corrected: pendingRetryCorrected,
                naturalVersion: firstString(
                  pendingRetryPayload,
                  "natural_sentence",
                ) || pendingRetryCorrected,
                explanation_pt: firstString(
                  pendingRetryPayload,
                  "explanation_pt",
                ),
                priority: ["low", "medium", "high"].includes(
                    pendingRetryPriority,
                  )
                  ? pendingRetryPriority as CorrectionData["priority"]
                  : "medium",
                retryRequired: true,
              }
              : retryCorrections[0] ?? null;
          const retryText = retryWolfieTurn?.content ||
            latestWolfieTurn?.content || "";

          setCorrection(retryCorrection);
          setTranslation(
            firstString(retryPayload, "translation") || null,
          );
          setAssistantLanguage(
            normalizedSpeechLanguage(
              firstString(
                retryPayload,
                "assistantLanguage",
                "assistant_language",
              ) || latestWolfieTurn?.language_code,
              detectSpeechLanguage(retryText, "en"),
            ),
          );
          setTurnGuidance({
            currentStage: firstString(
              retryPayload,
              "currentStage",
              "current_stage",
              "stage",
            ) || lastSession.current_stage || "retry",
            scenarioStatus: firstString(
              retryPayload,
              "scenarioStatus",
              "scenario_status",
            ) || lastSession.scenario_status || "awaiting_retry",
            learnerIntent: firstString(
              retryPayload,
              "learnerIntent",
              "learner_intent",
            ) || "perform",
            counterpart: firstString(retryPayload, "counterpart"),
            pendingQuestion: firstString(
              retryPayload,
              "pendingQuestion",
              "pending_question",
            ),
            pendingDecision: firstString(
              retryPayload,
              "pendingDecision",
              "pending_decision",
            ),
            strengths: firstStringArray(
              retryPayload,
              "studentStrengths",
              "student_strengths",
              "strengths",
            ),
            priorities: firstStringArray(
              retryPayload,
              "studentPriorities",
              "student_priorities",
              "priorities",
            ),
            nextAction: firstString(
              retryPayload,
              "nextAction",
              "next_action",
            ),
            needsExternalVerification: firstBoolean(
              retryPayload,
              "needsExternalVerification",
              "needs_external_verification",
            ),
            verificationReason: firstString(
              retryPayload,
              "verificationReason",
              "verification_reason",
            ),
            retryRequired: true,
            sessionScore: firstNumber(
              retryPayload,
              "sessionScore",
              "session_score",
            ),
          });
        }
      } catch (err) {
        console.error("[WolfieTutor] Erro ao carregar histórico:", err);
      } finally {
        if (!cancelled) setIsLoadingHistory(false);
      }
    };
    setIsLoadingHistory(true);
    loadLastSession();
    return () => {
      cancelled = true;
    };
  }, [
    hubModeRequested,
    user?.id,
    initialTopic,
    studentLevel,
    experienceMode,
    correctionMode,
    languageMode,
    difficulty,
    scenario,
    studentGoal,
    targetSkill,
  ]);

  // Auto-scroll messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ============================================================
  // TTS FUNCTIONS
  // ============================================================

  /**
   * Desbloqueia áudio para iOS Safari — DEVE ser chamado dentro de um
   * handler de toque/clique síncrono (onTouchStart, onClick, etc).
   *
   * iOS exige que o desbloqueio seja feito em três camadas:
   * 1. AudioContext.resume() + tocar buffer silencioso (obrigatório para neural TTS)
   * 2. SpeechSynthesis unlock (obrigatório para o fallback Web Speech API)
   *
   * Sem isso, qualquer audio.play() ou speechSynthesis.speak() em callbacks
   * assíncronos (após fetch/invoke) é silenciosamente bloqueado pelo iOS.
   */
  const unlockAudio = useCallback(() => {
    try {
      // ── 1. AudioContext: cria + toca buffer silencioso ──
      const AudioCtx = window.AudioContext ||
        (window as any).webkitAudioContext;
      if (AudioCtx) {
        if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
          audioCtxRef.current = new AudioCtx();
        }
        const ctx = audioCtxRef.current;
        const playUnlockBuffer = () => {
          try {
            // 1 sample de silêncio — suficiente para iOS considerar o output "ativo"
            const buf = ctx.createBuffer(1, 1, ctx.sampleRate || 22050);
            const src = ctx.createBufferSource();
            src.buffer = buf;
            src.connect(ctx.destination);
            src.start(0);
          } catch (_) {}
        };
        if (ctx.state === "suspended") {
          ctx.resume().then(playUnlockBuffer).catch(() => {});
        } else {
          playUnlockBuffer();
        }
      }
    } catch (e) {
      console.warn("[WolfieTutor] AudioContext unlock error:", e);
    }
    try {
      // ── 2. Web Speech API unlock (fallback iOS) ──
      if ("speechSynthesis" in window) {
        const u = new SpeechSynthesisUtterance("");
        window.speechSynthesis.speak(u);
        window.speechSynthesis.cancel();
      }
    } catch (_) {}

    // ── 3. iOS: pré-ativa HTMLAudioElement com WAV válido ──
    // CRÍTICO: play() com src VAZIO não ativa o elemento no iOS.
    // É necessário um src válido para que o iOS registre a gesture.
    // Usamos um WAV de 0 samples (toca instantaneamente e silenciosamente).
    if (IS_IOS) {
      try {
        const audio = new Audio(SILENT_WAV);
        audio.volume = 0;
        preUnlockedAudioRef.current = audio;
        // play() aqui → iOS considera o elemento "ativado" para playback futuro
        audio.play().then(() => audio.pause()).catch(() => {});
      } catch (_) {}
    }
  }, []);

  /**
   * iOS AudioContext Keepalive
   * O iOS auto-suspende o AudioContext após ~1-2s de inatividade.
   * Jogamos 1 sample de silêncio a cada 500ms para mantê-lo "running"
   * durante o fetch assíncrono ao wolfie-brain + wolfie-tts (~2-4s).
   */
  const startIOSKeepAlive = useCallback(() => {
    if (!IS_IOS || iosKeepAliveRef.current) return;
    iosKeepAliveRef.current = setInterval(() => {
      const ctx = audioCtxRef.current;
      if (!ctx || ctx.state === "closed") {
        clearInterval(iosKeepAliveRef.current!);
        iosKeepAliveRef.current = null;
        return;
      }
      if (ctx.state !== "running") return; // já suspendeu — não tenta tocar
      try {
        const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(0); // 1 sample de silêncio — iOS não suspende contexto ativo
      } catch (_) {}
    }, 500);
  }, []);

  const stopIOSKeepAlive = useCallback(() => {
    if (iosKeepAliveRef.current) {
      clearInterval(iosKeepAliveRef.current);
      iosKeepAliveRef.current = null;
    }
  }, []);

  const invalidatePendingTTS = useCallback(() => {
    ttsRequestVersionRef.current += 1;
  }, []);

  const stopOutputMeter = useCallback(() => {
    if (outputMeterFrameRef.current !== null) {
      cancelAnimationFrame(outputMeterFrameRef.current);
      outputMeterFrameRef.current = null;
    }
    outputAnalyserRef.current?.disconnect();
    outputAnalyserRef.current = null;
    if (isMountedRef.current) setOutputLevel(0);
  }, []);

  const connectOutputMeter = useCallback((
    source: AudioNode,
    ctx: AudioContext,
  ) => {
    stopOutputMeter();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.58;
    outputAnalyserRef.current = analyser;
    source.connect(analyser);
    analyser.connect(ctx.destination);

    const samples = new Float32Array(analyser.fftSize);
    let smoothed = 0;
    const measure = () => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (let index = 0; index < samples.length; index++) {
        sum += samples[index] * samples[index];
      }
      const rms = Math.sqrt(sum / samples.length);
      smoothed = smoothed * 0.58 + Math.min(1, rms * 5.5) * 0.42;
      if (isMountedRef.current) setOutputLevel(smoothed);
      outputMeterFrameRef.current = requestAnimationFrame(measure);
    };
    measure();
  }, [stopOutputMeter]);

  /** Para a voz (AudioContext + HTMLAudio + Web Speech) e limpa o estado */
  const stopSpeaking = useCallback(() => {
    invalidatePendingTTS();
    ttsRequestAbortRef.current?.abort();
    ttsRequestAbortRef.current = null;
    stopOutputMeter();
    // Para AudioContext source (iOS + desktop)
    if (audioSourceRef.current) {
      try {
        audioSourceRef.current.stop();
      } catch (_) {}
      audioSourceRef.current = null;
    }
    // Para HTMLAudioElement (fallback desktop)
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    // Para Web Speech API (fallback final)
    window.speechSynthesis.cancel();
    setState((prev) =>
      prev === "SPEAKING" || prev === "SYNTHESIZING" ? "IDLE" : prev
    );
    setSubtitle("");
  }, [invalidatePendingTTS, stopOutputMeter]);

  /**
   * Fallback: Web Speech API (local, sem qualidade neural)
   * Usado quando o edge function wolfie-tts falha.
   */
  const speakWebSpeech = useCallback((
    text: string,
    speed?: number,
    forceLang?: TtsLanguage,
    requestVersion = ttsRequestVersionRef.current,
    segments?: SpeechSegment[],
  ) => {
    const isCurrent = () => requestVersion === ttsRequestVersionRef.current;
    if (!isCurrent()) return;
    const fallbackLanguage: SpeechLanguage = forceLang === "pt" ? "pt" : "en";
    const sentences = splitSpeechSentences(text, segments, fallbackLanguage);
    const hasUnavailableVoice = sentences.some(({ language }) =>
      language === "pt" ? !ptBrVoiceRef.current : !englishVoiceRef.current
    );
    if (hasUnavailableVoice) {
      setState("IDLE");
      setSubtitle(text);
      return;
    }

    let idx = 0;
    const speakNext = () => {
      if (!isCurrent()) return;
      if (idx >= sentences.length) {
        setState("IDLE");
        setSubtitle("");
        return;
      }
      const item = sentences[idx++];
      const sentence = item.sentence;
      const lang = item.language;

      const utterance = new SpeechSynthesisUtterance(sentence);

      if (lang === "pt") {
        if (ptBrVoiceRef.current) {
          utterance.voice = ptBrVoiceRef.current;
        }
        utterance.lang = "pt-BR";
        utterance.rate = speed ?? 1.0;
        utterance.pitch = 1.0;
      } else {
        if (englishVoiceRef.current) {
          utterance.voice = englishVoiceRef.current;
          utterance.lang = englishVoiceRef.current.lang;
        } else {
          utterance.lang = "en-US";
        }
        utterance.rate = speed ?? getTTSSpeed(studentLevel);
        utterance.pitch = 1.0;
      }

      utterance.volume = 1.0;
      utterance.onend = () => {
        if (isCurrent()) speakNext();
      };
      utterance.onerror = () => {
        if (!isCurrent()) return;
        setState("IDLE");
        setSubtitle("");
      };
      if (isCurrent()) {
        setState("SPEAKING");
        window.speechSynthesis.speak(utterance);
      }
    };

    window.speechSynthesis.cancel();
    speakNext();
  }, [studentLevel]);

  /**
   * Fallback TTS oficial via edge function wolfie-tts.
   * A Edge Function converte os nomes legados de idioma para vozes OpenAI;
   * Web Speech permanece como último recurso local.
   */
  const speak = useCallback(
    async (
      text: string,
      speed?: number,
      forceLang?: TtsLanguage,
      segments?: SpeechSegment[],
    ) => {
      const requestVersion = ++ttsRequestVersionRef.current;
      const isCurrent = () => requestVersion === ttsRequestVersionRef.current;
      const speechText = segments?.length
        ? segments.map((segment) =>
          `${segment.language === "pt" ? "Português" : "English"}: ${
            prepareForTTS(segment.text)
          }`
        ).join("\n")
        : text;
      // Tier gratuito: o Wolfie responde por escrito. Não chamamos o wolfie-tts
      // (que já recusa no servidor) NEM o Web Speech — o fallback do navegador
      // faria o Wolfie falar assim mesmo e a separação viraria só um rótulo.
      // `null` (tier ainda desconhecido) segue em frente: quem decide é o
      // servidor, e o 403 abaixo silencia sem cair no Web Speech.
      if (voiceRepliesRef.current === false) {
        setSubtitle(speechText);
        lastSpokenTextRef.current = text;
        setState("IDLE");
        return;
      }

      setState("SYNTHESIZING");
      setSubtitle(speechText);
      lastSpokenTextRef.current = text;

      const lang = forceLang ?? "en";
      lastSpokenLanguageRef.current = lang;
      lastSpokenSegmentsRef.current = segments?.length ? segments : null;
      const voice = resolveTtsVoice(lang);
      const rate = speed ??
        (lang === "en" ? getTTSSpeed(studentLevel) : 1.0);

      // Para qualquer áudio anterior
      if (audioSourceRef.current) {
        try {
          audioSourceRef.current.stop();
        } catch (_) {}
        audioSourceRef.current = null;
      }
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = "";
        audioRef.current = null;
      }
      window.speechSynthesis.cancel();

      try {
        ttsRequestAbortRef.current?.abort();
        const controller = new AbortController();
        ttsRequestAbortRef.current = controller;
        const { data, error: fnError } = await supabase.functions.invoke(
          "wolfie-tts",
          {
            body: {
              text: speechText,
              voice,
              language: lang,
              speed: rate,
              segments,
            },
            signal: controller.signal,
            timeout: WOLFIE_TTS_TIMEOUT_MS,
          },
        );
        if (ttsRequestAbortRef.current === controller) {
          ttsRequestAbortRef.current = null;
        }

        if (!isCurrent()) return;
        if (fnError || !data?.audio) {
          // 403/402 = a voz é do tier premium. Isso não é falha técnica: cair
          // no Web Speech aqui faria o navegador falar de graça e furar a
          // separação que o servidor acabou de aplicar.
          const refusalStatus =
            (fnError as { context?: { status?: number } } | null)?.context
              ?.status;
          if (refusalStatus === 403 || refusalStatus === 402) {
            voiceRepliesRef.current = false;
            setVoiceReplies(false);
            stopIOSKeepAlive();
            ttsRequestAbortRef.current = null;
            setState("IDLE");
            return;
          }
          throw new Error(fnError?.message || "wolfie-tts sem áudio");
        }

        // Decodifica base64 → ArrayBuffer
        const rawBase64 = data.audio; // guardamos para data URI fallback
        const bytes = decodeBase64Audio(rawBase64);

        // ── iOS: tenta TODAS as abordagens em sequência ──
        if (IS_IOS) {
          stopIOSKeepAlive();

          const showIOSDebug = (msg: string) => {
            console.warn("[iOS audio]", msg);
          };

          // ── iOS 1: HTMLAudioElement pré-ativado ──
          // O iOS vincula permissão de play ao ELEMENTO que recebeu
          // play() com src VÁLIDO durante o toque (SILENT_WAV).
          if (preUnlockedAudioRef.current) {
            const preAudio = preUnlockedAudioRef.current;
            preUnlockedAudioRef.current = null;
            try {
              const blob = new Blob([bytes], { type: "audio/mpeg" });
              const blobUrl = URL.createObjectURL(blob);
              preAudio.volume = 1.0;
              preAudio.src = blobUrl;
              preAudio.onended = () => {
                stopOutputMeter();
                URL.revokeObjectURL(blobUrl);
                if (audioRef.current === preAudio) {
                  audioRef.current = null;
                }
                if (!isCurrent()) return;
                setState("IDLE");
                setSubtitle("");
              };
              preAudio.onerror = () => {
                URL.revokeObjectURL(blobUrl);
              };
              audioRef.current = preAudio;
              await preAudio.play();
              if (isCurrent()) setState("SPEAKING");
              if (!isCurrent()) {
                preAudio.pause();
                preAudio.src = "";
                URL.revokeObjectURL(blobUrl);
                if (audioRef.current === preAudio) {
                  audioRef.current = null;
                }
              }
              return;
            } catch (e1: any) {
              if (audioRef.current === preAudio) {
                audioRef.current = null;
              }
              if (!isCurrent()) return;
              showIOSDebug(`HTMLAudio blob: ${e1?.message ?? e1}`);
            }

            // ── iOS 1b: data URI (sem blob URL, direto no src) ──
            try {
              preAudio.src = `data:audio/mpeg;base64,${rawBase64}`;
              preAudio.volume = 1.0;
              preAudio.onended = () => {
                stopOutputMeter();
                if (audioRef.current === preAudio) {
                  audioRef.current = null;
                }
                if (!isCurrent()) return;
                setState("IDLE");
                setSubtitle("");
              };
              audioRef.current = preAudio;
              await preAudio.play();
              if (isCurrent()) setState("SPEAKING");
              if (!isCurrent()) {
                preAudio.pause();
                preAudio.src = "";
                if (audioRef.current === preAudio) {
                  audioRef.current = null;
                }
              }
              return;
            } catch (e1b: any) {
              if (audioRef.current === preAudio) {
                audioRef.current = null;
              }
              if (!isCurrent()) return;
              showIOSDebug(`HTMLAudio dataURI: ${e1b?.message ?? e1b}`);
            }
          } else {
            showIOSDebug("preUnlocked=null (toque no mascote primeiro?)");
          }

          // ── iOS 2: AudioContext com keepalive ──
          const ctx = audioCtxRef.current;
          if (ctx && ctx.state !== "closed") {
            if (ctx.state === "suspended") {
              try {
                await ctx.resume();
              } catch (_) {}
            }
            if (!isCurrent()) return;
            try {
              const audioBuffer = await ctx.decodeAudioData(
                bytes.buffer.slice(0),
              );
              if (!isCurrent()) return;
              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              connectOutputMeter(source, ctx);
              source.onended = () => {
                stopOutputMeter();
                if (audioSourceRef.current === source) {
                  audioSourceRef.current = null;
                }
                if (!isCurrent()) return;
                setState("IDLE");
                setSubtitle("");
              };
              audioSourceRef.current = source;
              if (isCurrent()) {
                setState("SPEAKING");
                source.start(0);
              }
              return;
            } catch (e2: any) {
              if (!isCurrent()) return;
              showIOSDebug(
                `AudioContext: ${e2?.message ?? e2} (ctx=${ctx.state})`,
              );
            }
          } else {
            showIOSDebug(`ctx=${ctx?.state ?? "null"}`);
          }

          // ── iOS 3: Web Speech API (último recurso) ──
          showIOSDebug("fallback Web Speech");
          speakWebSpeech(speechText, rate, lang, requestVersion, segments);
          return;
        }

        // ── Desktop: AudioContext primeiro ──
        const ctx = audioCtxRef.current;
        if (ctx && ctx.state !== "closed") {
          if (ctx.state === "suspended") {
            try {
              await ctx.resume();
            } catch (_) {}
          }
          if (!isCurrent()) return;
          try {
            const audioBuffer = await ctx.decodeAudioData(
              bytes.buffer.slice(0),
            );
            if (!isCurrent()) return;
            stopIOSKeepAlive();
            const source = ctx.createBufferSource();
            source.buffer = audioBuffer;
            connectOutputMeter(source, ctx);
            source.onended = () => {
              stopOutputMeter();
              if (audioSourceRef.current === source) {
                audioSourceRef.current = null;
              }
              if (!isCurrent()) return;
              setState("IDLE");
              setSubtitle("");
            };
            audioSourceRef.current = source;
            if (isCurrent()) {
              setState("SPEAKING");
              source.start(0);
            }
            return;
          } catch (decodeErr) {
            if (!isCurrent()) return;
            console.warn(
              "[WolfieTutor] AudioContext decode falhou:",
              decodeErr,
            );
            stopIOSKeepAlive();
          }
        } else {
          stopIOSKeepAlive();
        }

        // ── Fallback desktop: HTMLAudioElement ──
        if (!IS_IOS) {
          const blob = new Blob([bytes], { type: "audio/mpeg" });
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          audioRef.current = audio;
          audio.onended = () => {
            stopOutputMeter();
            URL.revokeObjectURL(url);
            if (audioRef.current === audio) audioRef.current = null;
            if (!isCurrent()) return;
            setState("IDLE");
            setSubtitle("");
          };
          audio.onerror = () => {
            URL.revokeObjectURL(url);
            if (audioRef.current === audio) audioRef.current = null;
            if (!isCurrent()) return;
            speakWebSpeech(speechText, rate, lang, requestVersion, segments);
          };
          try {
            await audio.play();
            if (isCurrent()) setState("SPEAKING");
            if (!isCurrent()) {
              audio.pause();
              audio.src = "";
              URL.revokeObjectURL(url);
              if (audioRef.current === audio) audioRef.current = null;
            }
            return;
          } catch (_) {
            if (!isCurrent()) return;
            speakWebSpeech(speechText, rate, lang, requestVersion, segments);
            return;
          }
        }
      } catch (err: any) {
        if (!isCurrent()) return;
        const errMsg = err?.message ?? String(err);
        console.warn("[WolfieTutor] wolfie-tts erro:", errMsg);
        stopIOSKeepAlive();
        ttsRequestAbortRef.current = null;
        speakWebSpeech(
          speechText,
          speed,
          lang,
          requestVersion,
          segments,
        );
      }
    },
    [
      connectOutputMeter,
      speakWebSpeech,
      stopIOSKeepAlive,
      stopOutputMeter,
      studentLevel,
    ],
  );

  const slowReplay = () => {
    if (lastSpokenTextRef.current) {
      stopSpeaking();
      void speak(
        lastSpokenTextRef.current,
        0.88,
        lastSpokenLanguageRef.current,
        lastSpokenSegmentsRef.current ?? undefined,
      );
    }
  };

  const startRealtimeConversation = async () => {
    if (!isRealtimeMode) return;
    if (isRealtimePostTurnPending) {
      setSubtitle(
        pendingTranscriptReview?.source === "realtime"
          ? "Confirme a transcrição antes de continuar."
          : "O Wolfie está revisando este turno antes de continuar…",
      );
      return;
    }
    if (isLoadingHistory) {
      setSubtitle("Preparando seu histórico para retomar do ponto certo…");
      return;
    }
    unlockAudio();
    setAudioGestureReady(true);
    setError(null);
    setSubtitle("");

    if (realtime.connected) {
      if (realtime.isAssistantSpeaking) {
        realtime.interrupt();
      } else {
        realtime.toggleMuted();
      }
      return;
    }

    const result = await realtime.connect();
    if (result.ok) {
      await realtime.resumeAudio();
    }
  };

  const useClassicVoice = () => {
    if (hubModeRequested) return;
    invalidatePendingRequest();
    abortRecognition();
    resetRealtimeGate();
    realtime.disconnect(false);
    detachTransportSession("handoff_to_classic");
    setVoiceTransport("classic");
    setState("IDLE");
    setSubtitle("");
    setError(null);
  };

  const useRealtimeVoice = () => {
    if (hubModeRequested) return;
    invalidatePendingRequest();
    abortRecognition();
    stopSpeaking();
    resetRealtimeGate();
    pendingRealtimeClassicHandoffRef.current = null;
    setVoiceTransport("realtime");
    setState("IDLE");
    setSubtitle("");
    setError(null);
  };

  const submitVoiceTranscript = (
    review: PendingTranscriptReview,
    transcriptConfirmed = false,
  ) => {
    const transcript = review.transcript.trim();
    if (!transcript || isProcessingRef.current) return;

    setPendingTranscriptReview(null);
    const newUserMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: transcript,
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, newUserMsg]);
    setState("THINKING");
    void sendToWolfieBrain({
      message: transcript,
      uiMessageId: newUserMsg.id,
      studentLanguage: review.studentLanguage,
      transcriptionConfidence: review.confidence,
      transcriptionAlternatives: review.alternatives,
      speechDerivedTranscript: true,
      transcriptConfirmed,
    });
  };

  const submitClassicAudioBlob = async (
    blob: Blob,
    recordingAttempt: number,
  ) => {
    if (
      recordingAttempt !== recordingAttemptRef.current ||
      !isMountedRef.current
    ) return;

    if (blob.size < 200) {
      stopIOSKeepAlive();
      setState("IDLE");
      setSubtitle("");
      setError("Não ouvi nada — segure o mascote e fale");
      setTimeout(() => setError(null), 3000);
      return;
    }
    if (blob.size > MAX_CLASSIC_RECORDING_BYTES) {
      stopIOSKeepAlive();
      setState("IDLE");
      setSubtitle("");
      setError("O áudio ficou muito longo. Tente uma resposta mais curta.");
      setTimeout(() => setError(null), 5000);
      return;
    }

    setState("THINKING");
    setSubtitle("Reconhecendo português e inglês...");
    try {
      const audioBase64 = await audioBlobToBase64(blob);
      if (recordingAttempt !== recordingAttemptRef.current) return;

      transcriptionAbortRef.current?.abort();
      const controller = new AbortController();
      transcriptionAbortRef.current = controller;
      const { data, error: transcriptionError } = await supabase.functions
        .invoke("wolfie-brain", {
          body: {
            action: "transcribe_audio",
            audioBase64,
            audioMimeType: blob.type || mediaRecorderMimeTypeRef.current,
          },
          signal: controller.signal,
          timeout: WOLFIE_TRANSCRIPTION_TIMEOUT_MS,
        });
      if (transcriptionAbortRef.current === controller) {
        transcriptionAbortRef.current = null;
      }
      if (
        recordingAttempt !== recordingAttemptRef.current ||
        !isMountedRef.current
      ) return;

      const payload = asRecord(data);
      const transcript = firstString(
        payload,
        "transcribedText",
        "transcript",
        "text",
      );
      if (transcriptionError || payload.error || !transcript) {
        throw new Error(
          firstString(payload, "error", "code") ||
            transcriptionError?.message ||
            "AUDIO_NOT_UNDERSTOOD",
        );
      }
      const studentLanguage = normalizedSpeechLanguage(
        firstString(payload, "detectedLanguage", "language"),
        detectSpeechLanguage(transcript, lastLearnerLanguageRef.current),
      );
      lastLearnerLanguageRef.current = studentLanguage;
      const review: PendingTranscriptReview = {
        transcript,
        alternatives: [],
        confidence: null,
        studentLanguage,
        source: "classic",
      };

      if (shouldConfirmVoiceTranscript(review)) {
        stopIOSKeepAlive();
        setPendingTranscriptReview(review);
        setState("IDLE");
        setSubtitle("");
        return;
      }
      submitVoiceTranscript(review);
    } catch (cause) {
      if (recordingAttempt !== recordingAttemptRef.current) return;
      transcriptionAbortRef.current = null;
      stopIOSKeepAlive();
      setState("IDLE");
      setSubtitle("");
      const name = cause instanceof Error ? cause.name : "";
      setError(
        name === "AbortError"
          ? "A transcrição demorou mais que o esperado. Tente novamente."
          : "Não consegui entender o áudio agora. Tente novamente.",
      );
      setTimeout(() => setError(null), 5000);
    }
  };

  // ============================================================
  // VOICE INPUT — MediaRecorder + multilingual server ASR.
  // Web Speech remains only as a compatibility fallback.
  // ============================================================
  const startRecording = () => {
    if (hubModeRequested) {
      setShowTextInput(true);
      setError("No Hub, esta assinatura usa a prática por texto.");
      setTimeout(() => setError(null), 4000);
      return;
    }
    // Permite iniciar em IDLE ou SPEAKING (interrompe o Wolfie)
    if (
      state !== "IDLE" &&
      state !== "SPEAKING" &&
      state !== "SYNTHESIZING"
    ) return;
    if (isProcessingRef.current) return;
    setPendingTranscriptReview(null);

    // Qualquer TTS ainda baixando pertence ao turno anterior e não pode
    // começar a tocar depois que o microfone foi aberto.
    invalidatePendingTTS();

    const recordingAttempt = ++recordingAttemptRef.current;
    // Solicita o microfone somente dentro do gesto explícito do aluno.
    const streamPromise = ensureAudioStream();

    // ── Desbloqueia AudioContext no iOS (DEVE ser no handler de toque) ──
    unlockAudio();
    // iOS: inicia keepalive IMEDIATAMENTE após unlock para impedir auto-suspensão
    // O keepalive fica ativo durante gravação + fetch (~5-10s total)
    startIOSKeepAlive();

    // ── Para a voz do Wolfie (neural + Web Speech) ──
    if (audioSourceRef.current) {
      try {
        audioSourceRef.current.stop();
      } catch (_) {}
      audioSourceRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    window.speechSynthesis.cancel();
    setState("IDLE");
    setSubtitle("");
    setTranslation(null);
    setVocabulary(null);
    setQuiz(null);
    if (!turnGuidance.retryRequired) {
      setCorrection(null);
      setTurnGuidance((current) => ({
        ...EMPTY_TURN_GUIDANCE,
        currentStage: current.currentStage,
        scenarioStatus: current.scenarioStatus,
        learnerIntent: current.learnerIntent,
        counterpart: current.counterpart,
        pendingQuestion: current.pendingQuestion,
        pendingDecision: current.pendingDecision,
      }));
    }
    setError(null);

    // Aguarda 400ms para o speaker parar fisicamente antes de ligar o mic
    recordingDelayRef.current = setTimeout(() => {
      recordingDelayRef.current = null;
      void (async () => {
        const stream = await streamPromise;
        if (recordingAttempt !== recordingAttemptRef.current) {
          stream?.getTracks().forEach((track) => track.stop());
          return;
        }

        const preferredMimeType = classicRecorderMimeType();
        if (stream && typeof MediaRecorder !== "undefined") {
          try {
            const recorder = preferredMimeType
              ? new MediaRecorder(stream, {
                mimeType: preferredMimeType,
                audioBitsPerSecond: 64_000,
              })
              : new MediaRecorder(stream, { audioBitsPerSecond: 64_000 });
            mediaRecorderRef.current = recorder;
            mediaRecorderChunksRef.current = [];
            mediaRecorderStartedAtRef.current = Date.now();
            mediaRecorderMimeTypeRef.current = recorder.mimeType ||
              preferredMimeType ||
              "audio/webm";

            recorder.ondataavailable = (event) => {
              if (event.data.size > 0) {
                mediaRecorderChunksRef.current.push(event.data);
              }
            };
            recorder.onerror = () => {
              recordingAttemptRef.current += 1;
              mediaRecorderRef.current = null;
              releaseAudioStream();
              stopIOSKeepAlive();
              setState("IDLE");
              setSubtitle("");
              setError("O microfone falhou. Tente novamente.");
              setTimeout(() => setError(null), 4000);
            };
            recorder.onstop = () => {
              if (recordingMaxDurationRef.current) {
                clearTimeout(recordingMaxDurationRef.current);
                recordingMaxDurationRef.current = null;
              }
              if (mediaRecorderRef.current === recorder) {
                mediaRecorderRef.current = null;
              }
              const chunks = mediaRecorderChunksRef.current;
              mediaRecorderChunksRef.current = [];
              const mimeType = recorder.mimeType ||
                mediaRecorderMimeTypeRef.current;
              releaseAudioStream();
              const blob = new Blob(chunks, { type: mimeType });
              void submitClassicAudioBlob(blob, recordingAttempt);
            };
            recorder.start(250);
            recordingMaxDurationRef.current = setTimeout(() => {
              if (recorder.state !== "inactive") recorder.stop();
            }, MAX_CLASSIC_RECORDING_MS);
            setState("LISTENING");
            setSubtitle("Ouvindo automaticamente em PT e EN...");
            return;
          } catch (recorderError) {
            console.warn(
              "[WolfieTutor] MediaRecorder indisponível:",
              recorderError,
            );
            releaseAudioStream();
          }
        }

        // Compatibilidade para navegadores antigos. O idioma da fala é
        // inferido do texto; nunca é derivado de um botão PT/EN.
        if (stream) releaseAudioStream();
        const SpeechRec = (window as any).webkitSpeechRecognition ||
          (window as any).SpeechRecognition;
        if (!SpeechRec) {
          stopIOSKeepAlive();
          setError(
            "Reconhecimento de voz não suportado. Use o campo de texto.",
          );
          setTimeout(() => setError(null), 5000);
          setShowTextInput(true);
          setState("IDLE");
          return;
        }

        finalTranscriptRef.current = "";
        transcriptAlternativesRef.current = [];
        transcriptConfidenceRef.current = null;
        const recognition = new SpeechRec();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.maxAlternatives = 5;
        recognitionRef.current = recognition;

        recognition.onresult = (event: any) => {
          let finalText = "";
          let interimText = "";
          const finalResults: any[] = [];
          for (let index = 0; index < event.results.length; index++) {
            if (event.results[index].isFinal) {
              finalText += `${event.results[index][0].transcript} `;
              finalResults.push(event.results[index]);
            } else {
              interimText += event.results[index][0].transcript;
            }
          }
          finalTranscriptRef.current = finalText.trim();
          if (finalResults.length > 0) {
            const alternatives = finalResults.flatMap((result) =>
              Array.from(result).slice(0, 5).map((candidate: any) =>
                String(candidate?.transcript ?? "").trim()
              )
            );
            transcriptAlternativesRef.current = uniqueTranscriptAlternatives(
              finalTranscriptRef.current,
              alternatives,
            );
            const confidences = finalResults
              .map((result) => result[0]?.confidence)
              .filter((value): value is number =>
                typeof value === "number" && Number.isFinite(value) &&
                value > 0
              );
            transcriptConfidenceRef.current = confidences.length
              ? confidences.reduce((sum, value) => sum + value, 0) /
                confidences.length
              : null;
          }
          setSubtitle(interimText || finalText.trim());
        };

        recognition.onerror = (event: any) => {
          recognitionRef.current = null;
          recognition.onend = null;
          finalTranscriptRef.current = "";
          stopIOSKeepAlive();
          if (event.error !== "aborted") {
            const messagesByError: Record<string, string> = {
              "no-speech": "Não ouvi nada — segure e fale mais perto",
              "audio-capture": "Microfone não encontrado",
              "not-allowed": "Permissão do microfone negada",
              "network": "Erro de rede no reconhecimento de voz",
            };
            setError(
              messagesByError[event.error] ??
                "O microfone falhou. Tente novamente.",
            );
            setTimeout(() => setError(null), 4000);
          }
          setState("IDLE");
          setSubtitle("");
        };

        recognition.onend = () => {
          const transcript = finalTranscriptRef.current.trim();
          recognitionRef.current = null;
          setSubtitle("");
          if (!transcript) {
            stopIOSKeepAlive();
            setState("IDLE");
            setError("Não ouvi nada — segure o mascote e fale");
            setTimeout(() => setError(null), 3000);
            return;
          }
          const studentLanguage = detectSpeechLanguage(
            transcript,
            lastLearnerLanguageRef.current,
          );
          lastLearnerLanguageRef.current = studentLanguage;
          const review: PendingTranscriptReview = {
            transcript,
            alternatives: transcriptAlternativesRef.current,
            confidence: transcriptConfidenceRef.current,
            studentLanguage,
            source: "classic",
          };
          if (shouldConfirmVoiceTranscript(review)) {
            stopIOSKeepAlive();
            setPendingTranscriptReview(review);
            setState("IDLE");
            return;
          }
          submitVoiceTranscript(review);
        };

        try {
          recognition.start();
          setState("LISTENING");
        } catch {
          recognitionRef.current = null;
          stopIOSKeepAlive();
          setState("IDLE");
          setError("Não foi possível iniciar o microfone. Tente novamente.");
          setTimeout(() => setError(null), 4000);
        }
      })();
    }, 400);
  };

  const stopRecordingAndSend = () => {
    if (recordingDelayRef.current) {
      clearTimeout(recordingDelayRef.current);
      recordingDelayRef.current = null;
      recordingAttemptRef.current += 1;
      releaseAudioStream();
      stopIOSKeepAlive();
      setState("IDLE");
      return;
    }
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      if (IS_IOS) unlockAudio();
      try {
        recorder.stop();
      } catch {
        mediaRecorderRef.current = null;
        releaseAudioStream();
        stopIOSKeepAlive();
        setState("IDLE");
      }
      return;
    }
    if (!recognitionRef.current) {
      recordingAttemptRef.current += 1;
      releaseAudioStream();
      stopIOSKeepAlive();
      setState("IDLE");
      return;
    }
    // iOS: re-bloqueia AudioContext no touchEnd — momento mais próximo do speak()
    // Isso garante que o AudioContext permanece "running" durante o fetch assíncrono
    if (IS_IOS) unlockAudio();
    // stop() termina a sessão → dispara onend com o transcript acumulado
    try {
      recognitionRef.current?.stop();
    } catch {
      recognitionRef.current = null;
      stopIOSKeepAlive();
      setState("IDLE");
    }
  };

  const sendMessage = async (text: string) => {
    if (!text.trim()) return;
    if (hubModeRequested && !hubAccountContextValid) {
      setError("Não foi possível confirmar a conta desta assinatura.");
      return;
    }
    if (!hubModeRequested) unlockAudio();

    if (isRealtimeMode) {
      if (isRealtimePostTurnPending) {
        setError("Aguarde o Wolfie revisar este turno antes de continuar.");
        setTimeout(() => setError(null), 4000);
        return;
      }
      if (!realtime.connected) {
        setError(
          "Toque no Wolfie para iniciar a conversa ao vivo antes de enviar texto.",
        );
        setTimeout(() => setError(null), 5000);
        return;
      }
      if (!realtime.sendText(text)) {
        setError("Não foi possível enviar agora. Tente novamente.");
        setTimeout(() => setError(null), 4000);
        return;
      }
      setInputText("");
      return;
    }

    setInputText("");
    setState("THINKING");
    stopSpeaking();
    setTranslation(null);
    setVocabulary(null);
    setQuiz(null);
    if (!turnGuidance.retryRequired) {
      setCorrection(null);
      setTurnGuidance((current) => ({
        ...EMPTY_TURN_GUIDANCE,
        currentStage: current.currentStage,
        scenarioStatus: current.scenarioStatus,
        learnerIntent: current.learnerIntent,
        counterpart: current.counterpart,
        pendingQuestion: current.pendingQuestion,
        pendingDecision: current.pendingDecision,
      }));
    }

    // Add user message to chat
    const newUserMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, newUserMsg]);

    await sendToWolfieBrain({ message: text, uiMessageId: newUserMsg.id });
  };

  const sendToWolfieBrain = async (input: WolfieBrainInput) => {
    if (isProcessingRef.current) {
      console.warn("[Wolfie] sendToWolfieBrain ignorado — já está processando");
      return;
    }
    isProcessingRef.current = true;
    const requestVersion = ++requestVersionRef.current;
    const classicRequestFingerprint = JSON.stringify({
      message: input.message?.trim() ?? "",
      hasAudio: Boolean(input.audioBase64),
      studentLanguage: input.studentLanguage ?? null,
      speechDerivedTranscript: input.speechDerivedTranscript ?? false,
      transcriptConfirmed: input.transcriptConfirmed ?? false,
      conversationId,
      topic,
      experienceMode,
      targetSkill,
    });
    const replayedClassicRequest = pendingClassicRequestRef.current
      ?.fingerprint === classicRequestFingerprint
      ? pendingClassicRequestRef.current
      : null;
    const classicClientTurnId = replayedClassicRequest?.clientTurnId ??
      crypto.randomUUID();
    const optimisticMessageId = replayedClassicRequest?.optimisticMessageId ||
      input.uiMessageId || "";
    if (
      replayedClassicRequest?.optimisticMessageId &&
      input.uiMessageId &&
      replayedClassicRequest.optimisticMessageId !== input.uiMessageId
    ) {
      setMessages((current) =>
        reconcileClassicReplayBubble(
          current,
          replayedClassicRequest.optimisticMessageId,
          input.uiMessageId as string,
        )
      );
    }
    // Keep this key after timeout/network ambiguity. A deliberate new payload
    // gets a new key; an explicit success clears it so repeating the same text
    // later remains a legitimate new learner turn.
    pendingClassicRequestRef.current = {
      fingerprint: classicRequestFingerprint,
      clientTurnId: classicClientTurnId,
      optimisticMessageId,
    };
    const serverInput = { ...input };
    delete serverInput.uiMessageId;

    // ── Detecta idioma do input para resposta bilíngue ──
    // Se o aluno falou PT → Wolfie responde em PT (FranciscaNeural)
    // Se falou EN → Wolfie responde em EN (JennyNeural)
    const studentLang: SpeechLanguage = input.studentLanguage ??
      inferWolfieSocialTurnLanguage(input.message) ??
      detectSpeechLanguage(
        input.message || "",
        lastLearnerLanguageRef.current,
      );
    if (input.message) lastLearnerLanguageRef.current = studentLang;
    const localLearnerTurnKind = classifyWolfieLearnerTurn(
      input.message,
      Boolean(input.audioBase64),
    );
    const localTurnIsSubstantive = isPedagogicallySubstantiveTurn(
      localLearnerTurnKind,
      activePedagogicalTask,
    );

    try {
      if (hubModeRequested && !hubAccountContextValid) {
        throw new Error("HUB_ACCOUNT_CONTEXT_INVALID");
      }
      if (hubModeRequested && !input.message?.trim()) {
        throw new Error("HUB_TEXT_REQUIRED");
      }
      brainRequestAbortRef.current?.abort();
      const controller = new AbortController();
      brainRequestAbortRef.current = controller;
      const history = messages
        .filter((message) => message.id !== optimisticMessageId)
        .slice(-6)
        .map((message) =>
          `${message.role === "user" ? "Student" : "Wolfie"}: ${message.content}`
        )
        .join("\n");
      const scenarioSummary = typeof scenario === "string"
        ? scenario
        : scenario
        ? JSON.stringify(scenario)
        : "";
      const missionContext = [
        context,
        scenarioSummary ? `SCENARIO: ${scenarioSummary}` : "",
        studentGoal ? `STUDENT GOAL: ${studentGoal}` : "",
        targetSkill ? `TARGET SKILL: ${targetSkill}` : "",
        experienceId ? `EXPERIENCE ID: ${experienceId}` : "",
        experienceUniverse ? `EXPERIENCE UNIVERSE: ${experienceUniverse}` : "",
        difficulty ? `DIFFICULTY: ${difficulty}` : "",
      ].filter(Boolean).join("\n");
      const fullContext = missionContext
        ? `MISSION CONTEXT:\n${missionContext}\n\nCONVERSATION HISTORY:\n${history}`
        : history;

      const modeMap: Record<string, string> = {
        "interview": "job_interview",
        "job": "job_interview",
        "exam": "exam_prep",
        "ielts": "exam_prep",
        "toefl": "exam_prep",
        "grammar": "grammar_focus",
      };
      const topicLower = topic.toLowerCase();
      const mode = Object.entries(modeMap).find(([k]) =>
        topicLower.includes(k)
      )?.[1] || "fluency";

      let activeClassicConversationId = conversationId;
      const pendingHandoffConversationId =
        pendingRealtimeClassicHandoffRef.current;
      if (pendingHandoffConversationId && !hubModeRequested) {
        setSubtitle("Finalizando a passagem para a voz clássica…");
        const handoff = await handoffWolfieRealtimeToClassic(
          pendingHandoffConversationId,
          { signal: controller.signal },
        );
        if (requestVersion !== requestVersionRef.current) return;
        activeClassicConversationId = handoff.conversationId;
        realtimeConversationIdRef.current = handoff.conversationId;
        setConversationId(handoff.conversationId);
        if (
          pendingRealtimeClassicHandoffRef.current === handoff.conversationId
        ) {
          pendingRealtimeClassicHandoffRef.current = null;
        }
        setTurnGuidance((current) => ({
          ...current,
          currentStage: handoff.currentStage || current.currentStage,
          scenarioStatus: handoff.scenarioStatus || current.scenarioStatus,
          retryRequired: handoff.requiresRetry ?? current.retryRequired,
        }));
        setSubtitle("");
      }

      const hubConversationId = activeClassicConversationId ??
        crypto.randomUUID();
      if (hubModeRequested && !activeClassicConversationId) {
        activeClassicConversationId = hubConversationId;
        setConversationId(hubConversationId);
      }
      const functionName = hubModeRequested
        ? "wolf-tutor-api"
        : "wolfie-brain";
      const requestBody = hubModeRequested
        ? {
          hubMode: true,
          accountId: hubAccountId,
          text: input.message!.trim(),
          studentLevel,
          conversationId: hubConversationId,
          requestKey: classicClientTurnId,
          includeAudio: false,
          experience: {
            id: experienceId || null,
            title: topic || initialTopic || null,
            description: scenarioSummary || null,
            realWorldGoal: studentGoal || null,
            mode: experienceMode || null,
            sector: null,
            skills: targetSkill ? [targetSkill] : [],
          },
        }
        : {
          ...serverInput,
          learnerTurnKind: localLearnerTurnKind,
          studentLevel,
          topic,
          experienceMode,
          correctionMode,
          languageMode,
          difficulty,
          scenario,
          studentGoal,
          targetSkill,
          experienceId,
          experienceUniverse,
          experienceAudiences,
          previousContext: fullContext,
          translationEnabled: studentLang === "pt"
            ? true
            : translationEnabled,
          vocabularyEnabled: localTurnIsSubstantive,
          mode,
          correctionStrictness:
            mode === "exam_prep" || mode === "grammar_focus" ? 3 : 1,
          allowPortuguese: true,
          turnCount,
          conversationId: activeClassicConversationId,
          clientTurnId: classicClientTurnId,
          studentLanguage: studentLang,
        };
      const { data, error: supabaseError } = await supabase.functions.invoke(
        functionName,
        {
          body: requestBody,
          signal: controller.signal,
          timeout: WOLFIE_BRAIN_TIMEOUT_MS,
        },
      );
      if (brainRequestAbortRef.current === controller) {
        brainRequestAbortRef.current = null;
      }

      if (requestVersion !== requestVersionRef.current) return;

      if (supabaseError || data?.error) {
        throw new Error(
          data?.error || supabaseError?.message || "Unknown error",
        );
      }

      const rootPayload = asRecord(data);
      const structuredPayload = asRecord(
        rootPayload.structuredPayload ??
          rootPayload.structured_payload ??
          rootPayload.structured ??
          rootPayload.output,
      );
      const responsePayload = {
        ...rootPayload,
        ...structuredPayload,
      };
      const learnerTurnKind = resolveWolfieLearnerTurnKind(
        firstString(
          responsePayload,
          "learnerTurnKind",
          "learner_turn_kind",
        ),
        localLearnerTurnKind,
      );
      const suppressPedagogy = !isPedagogicallySubstantiveTurn(
        learnerTurnKind,
        activePedagogicalTask,
      );
      const suppressTranslation = learnerTurnKind === "noise";
      const chatText = firstString(
        responsePayload,
        "chatResponse",
        "aiText",
        "assistantMessage",
        "assistant_message",
      );
      const responseLang = normalizedSpeechLanguage(
        firstString(
          responsePayload,
          "assistantLanguage",
          "assistant_language",
        ),
        detectSpeechLanguage(chatText, studentLang),
      );
      const nextCorrections = suppressPedagogy
        ? []
        : normalizeCorrections(responsePayload);
      const nextCorrection = nextCorrections[0] ?? null;
      const nextTranslation = suppressTranslation
        ? null
        : firstString(responsePayload, "translation") || null;
      const nextCurrentStage = firstString(
        responsePayload,
        "currentStage",
        "current_stage",
        "stage",
      );
      const nextScenarioStatus = firstString(
        responsePayload,
        "scenarioStatus",
        "scenario_status",
      );
      const nextLearnerIntent = firstString(
        responsePayload,
        "learnerIntent",
        "learner_intent",
      );
      const nextCounterpart = firstString(responsePayload, "counterpart");
      const nextPendingQuestion = firstString(
        responsePayload,
        "pendingQuestion",
        "pending_question",
      );
      const nextPendingDecision = firstString(
        responsePayload,
        "pendingDecision",
        "pending_decision",
      );
      const nextStrengths = suppressPedagogy ? [] : firstStringArray(
        responsePayload,
        "studentStrengths",
        "student_strengths",
        "strengths",
      );
      const nextPriorities = suppressPedagogy ? [] : firstStringArray(
        responsePayload,
        "studentPriorities",
        "student_priorities",
        "priorities",
      );
      const nextAction = suppressPedagogy ? "" : firstString(
        responsePayload,
        "nextAction",
        "next_action",
      );
      const needsExternalVerification = suppressPedagogy ? false : firstBoolean(
        responsePayload,
        "needsExternalVerification",
        "needs_external_verification",
      );
      const verificationReason = suppressPedagogy ? "" : firstString(
        responsePayload,
        "verificationReason",
        "verification_reason",
      );
      const sessionScore = suppressPedagogy ? null : firstNumber(
        responsePayload,
        "sessionScore",
        "session_score",
      );
      const responseRequiresRetry = firstBoolean(
        responsePayload,
        "retryRequired",
        "retry_required",
        "requiresRetry",
        "requires_retry",
      );
      const retryRequired = suppressPedagogy
        ? responseRequiresRetry
        : responseRequiresRetry ||
          nextCorrections.some((item) => item.retryRequired);
      const nextVocabulary = suppressPedagogy
        ? null
        : (responsePayload.vocabulary as VocabData | undefined) ?? null;
      const nextQuiz = suppressPedagogy
        ? null
        : (responsePayload.quiz as QuizData | undefined) ?? null;

      const aiMessage: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: chatText,
        timestamp: new Date(),
        correction: nextCorrection,
        translation: nextTranslation,
        vocabulary: nextVocabulary || null,
        quiz: nextQuiz,
      };

      setMessages((prev) => [...prev, aiMessage]);
      if (
        isPedagogicallySubstantiveTurn(
          learnerTurnKind,
          activePedagogicalTask,
        )
      ) {
        setTurnCount((prev) => prev + 1);
      }
      const nextConversationId = firstString(
        responsePayload,
        "conversationId",
        "conversation_id",
      );
      if (nextConversationId) setConversationId(nextConversationId);
      if (hubModeRequested) {
        void Promise.resolve(hubContext?.onUsageCommitted?.()).catch((cause) => {
          console.warn("[WolfieTutor] Falha ao atualizar o consumo do Hub:", cause);
        });
      }

      setCorrection((current) =>
        suppressPedagogy && retryRequired ? current : nextCorrection
      );
      setTranslation(nextTranslation);
      setAssistantLanguage(responseLang);
      setVocabulary(nextVocabulary?.keyTerms?.length ? nextVocabulary : null);
      setQuiz(nextQuiz);
      setTurnGuidance((current) =>
        suppressPedagogy
          ? retryRequired
            ? {
              ...current,
              currentStage: current.currentStage || nextCurrentStage || "retry",
              scenarioStatus: nextScenarioStatus || current.scenarioStatus,
              learnerIntent: nextLearnerIntent || current.learnerIntent,
              counterpart: nextCounterpart || current.counterpart,
              pendingQuestion: nextPendingQuestion || current.pendingQuestion,
              pendingDecision: nextPendingDecision || current.pendingDecision,
              retryRequired: true,
            }
            : {
              ...EMPTY_TURN_GUIDANCE,
              currentStage: current.currentStage ||
                (learnerTurnKind === "opening" ? nextCurrentStage : ""),
              scenarioStatus: nextScenarioStatus || current.scenarioStatus,
              learnerIntent: nextLearnerIntent || current.learnerIntent,
              counterpart: nextCounterpart || current.counterpart,
              pendingQuestion: nextPendingQuestion || current.pendingQuestion,
              pendingDecision: nextPendingDecision || current.pendingDecision,
            }
          : {
            currentStage: nextCurrentStage,
            scenarioStatus: nextScenarioStatus || current.scenarioStatus,
            learnerIntent: nextLearnerIntent || "perform",
            counterpart: nextCounterpart || current.counterpart,
            pendingQuestion: nextPendingQuestion || current.pendingQuestion,
            pendingDecision: nextPendingDecision || current.pendingDecision,
            strengths: nextStrengths,
            priorities: nextPriorities,
            nextAction,
            needsExternalVerification,
            verificationReason,
            retryRequired,
            sessionScore,
          }
      );
      if (
        pendingClassicRequestRef.current?.clientTurnId === classicClientTurnId
      ) {
        pendingClassicRequestRef.current = null;
      }

      // O backend informa explicitamente o idioma desta fala. A heurística
      // acima existe apenas para compatibilidade durante a implantação.
      if (autoSpeakEnabled && chatText) {
        const bilingualSegments = responseLang === "pt" && nextTranslation
          ? [
            { text: chatText, language: "pt" as const },
            { text: "Agora, em inglês.", language: "pt" as const },
            { text: nextTranslation, language: "en" as const },
          ]
          : undefined;
        void speak(
          chatText,
          undefined,
          bilingualSegments ? "mixed" : responseLang,
          bilingualSegments,
        );
      } else {
        stopIOSKeepAlive();
        setState("IDLE");
      }
    } catch (err: any) {
      if (requestVersion !== requestVersionRef.current) return;
      console.error("Wolfie Brain Error:", err);
      brainRequestAbortRef.current = null;
      stopIOSKeepAlive();
      setSubtitle("");
      const errorName = err?.name ?? "";
      const errorMessage = String(err?.message ?? "");
      const handoffErrorCode = err instanceof WolfieRealtimeHandoffError
        ? err.code
        : "";
      const terminalConversation = [
        "CONVERSATION_FINISHED",
        "CONVERSATION_NOT_FOUND",
      ].includes(handoffErrorCode) ||
        /CONVERSATION_FINISHED|CONVERSATION_NOT_FOUND/i.test(errorMessage);
      if (terminalConversation) {
        pendingRealtimeClassicHandoffRef.current = null;
        realtime.disconnect(true);
        detachTransportSession();
      }
      if (
        /CONVERSATION_FINISHED|CONVERSATION_NOT_FOUND|TRANSPORT_MISMATCH|CLIENT_TURN_ID_REUSED/i.test(
          errorMessage,
        ) &&
        pendingClassicRequestRef.current?.clientTurnId === classicClientTurnId
      ) {
        pendingClassicRequestRef.current = null;
      }
      setError(
        handoffErrorCode === "REALTIME_HANDOFF_PENDING"
          ? "A conversa ao vivo ainda está finalizando este turno. Tente enviar novamente em alguns instantes."
          : errorName === "AbortError" ||
          /abort|timeout|timed out/i.test(errorMessage)
          ? "O Wolfie demorou mais que o esperado. Tente novamente."
          : "Não consegui responder agora. Tente novamente.",
      );
      setState("IDLE");
      setTimeout(() => setError(null), 5000);
    } finally {
      // Libera o lock sempre — seja sucesso ou erro
      if (requestVersion === requestVersionRef.current) {
        isProcessingRef.current = false;
      }
      if (
        brainRequestAbortRef.current?.signal.aborted ||
        requestVersion !== requestVersionRef.current
      ) {
        brainRequestAbortRef.current = null;
      }
    }
  };

  // No tier gratuito nada é reproduzido. Exigir o toque de "liberar a voz" no
  // iOS seria fricção por um áudio que nunca vai tocar — e a tela ainda
  // prometeria uma voz que o aluno não tem.
  useEffect(() => {
    if (voiceReplies === false && !isRealtimeMode) setAudioGestureReady(true);
  }, [voiceReplies, isRealtimeMode]);

  // Auto-start first turn when mode is selected
  useEffect(() => {
    if (
      !hubModeRequested &&
      hasSelectedTopic &&
      !isLoadingHistory &&
      audioGestureReady &&
      messages.length === 0 &&
      state === "IDLE" &&
      !isRealtimeMode
    ) {
      setState("THINKING");
      sendToWolfieBrain({});
    }
  }, [
    hasSelectedTopic,
    isLoadingHistory,
    audioGestureReady,
    hubModeRequested,
    isRealtimeMode,
    messages.length,
    restartNonce,
  ]);

  const invalidatePendingRequest = () => {
    requestVersionRef.current += 1;
    isProcessingRef.current = false;
    brainRequestAbortRef.current?.abort();
    brainRequestAbortRef.current = null;
    transcriptionAbortRef.current?.abort();
    transcriptionAbortRef.current = null;
    pendingClassicRequestRef.current = null;
  };

  const abortRecognition = () => {
    recordingAttemptRef.current += 1;
    transcriptionAbortRef.current?.abort();
    transcriptionAbortRef.current = null;
    if (recordingDelayRef.current) {
      clearTimeout(recordingDelayRef.current);
      recordingDelayRef.current = null;
    }
    if (recordingMaxDurationRef.current) {
      clearTimeout(recordingMaxDurationRef.current);
      recordingMaxDurationRef.current = null;
    }
    const recorder = mediaRecorderRef.current;
    mediaRecorderRef.current = null;
    mediaRecorderChunksRef.current = [];
    if (recorder && recorder.state !== "inactive") {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      try {
        recorder.stop();
      } catch (_) {}
    }
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try {
        recognition.abort();
      } catch (_) {}
    }
    releaseAudioStream();
    stopIOSKeepAlive();
  };

  const handleClose = () => {
    invalidatePendingRequest();
    resetRealtimeGate();
    realtime.disconnect(false);
    stopSpeaking();
    abortRecognition();
    setPendingTranscriptReview(null);
    onClose?.();
  };

  const disputePendingCorrection = async () => {
    if (isDisputingCorrection) return;
    setIsDisputingCorrection(true);
    setError(null);

    try {
      if (conversationId && !hubModeRequested) {
        const { data, error: disputeError } = await supabase.functions.invoke(
          "wolfie-brain",
          {
            body: {
              action: "dispute_correction",
              conversationId,
              reason: "student_reported_transcription_error",
            },
          },
        );
        if (disputeError || data?.success !== true) {
          throw new Error(
            data?.error ||
              disputeError?.message ||
              "DISPUTE_CORRECTION_FAILED",
          );
        }
      }

      setCorrection(null);
      setTurnGuidance((current) => ({
        ...current,
        priorities: current.priorities.filter((priority) =>
          priority !== correction?.corrected &&
          priority !== correction?.original
        ),
        nextAction:
          "Correção descartada. Diga novamente o que você quis informar.",
        retryRequired: false,
      }));
      setState("IDLE");
      setSubtitle("");
    } catch (cause) {
      console.error("[WolfieTutor] Erro ao contestar correção:", cause);
      setError(
        "Não consegui descartar essa correção agora. Tente novamente em instantes.",
      );
      setTimeout(() => setError(null), 5000);
    } finally {
      setIsDisputingCorrection(false);
    }
  };

  const restartConversation = async () => {
    if (isRestarting || state === "THINKING" || state === "LISTENING") return;
    if (!confirm(`Reiniciar a conversa mantendo o tema atual: "${topic}"?`)) {
      return;
    }
    const sessionToAbandon = realtimeConversationIdRef.current ||
      conversationId;

    invalidatePendingRequest();
    resetRealtimeGate();
    realtime.disconnect(true);
    stopSpeaking();
    abortRecognition();
    setError(null);
    setIsRestarting(true);

    try {
      // `disconnect` removes the Realtime listeners. Any completed turn that
      // was already handed to us remains in this serialized queue and must be
      // persisted before the session is marked abandoned.
      await realtimePersistenceRef.current;

      // A sessão precisa ser encerrada no servidor antes de o ID local ser
      // removido; caso contrário, um reload retomaria a conversa antiga.
      if (sessionToAbandon && !hubModeRequested) {
        const { data, error: abandonError } = await supabase.functions.invoke(
          "wolfie-brain",
          {
            body: {
              action: "abandon",
              conversationId: sessionToAbandon,
            },
          },
        );
        if (abandonError || data?.success !== true) {
          throw new Error(
            data?.error ||
              abandonError?.message ||
              "ABANDON_CONVERSATION_FAILED",
          );
        }
      }

      setState("IDLE");
      setMessages(
        hubModeRequested
          ? [{
            id: crypto.randomUUID(),
            role: "assistant",
            content: initialHubMessage,
            timestamp: new Date(),
          }]
          : [],
      );
      setConversationId(hubModeRequested ? crypto.randomUUID() : null);
      realtimeConversationIdRef.current = null;
      realtimeTurnIdsRef.current.clear();
      setTurnCount(0);
      setCorrection(null);
      setTranslation(null);
      setVocabulary(null);
      setQuiz(null);
      setTurnGuidance(EMPTY_TURN_GUIDANCE);
      setPendingTranscriptReview(null);
      setSubtitle(hubModeRequested ? initialHubMessage : "");
      setSessionStart(new Date());
      setElapsed(0);
      setRestartNonce((current) => current + 1);
    } catch (cause) {
      console.error("[WolfieTutor] Erro ao encerrar conversa:", cause);
      setState("IDLE");
      setError(
        "Não consegui encerrar esta conversa agora. Seu histórico foi mantido; tente novamente em instantes.",
      );
    } finally {
      setIsRestarting(false);
    }
  };

  // ============================================================
  // VISUAL HELPERS
  // ============================================================
  const realtimeSubtitle = realtime.isAssistantSpeaking
    ? realtime.assistantTranscript || realtime.lastAssistantTranscript
    : realtime.userTranscript || realtime.lastUserTranscript || subtitle;
  const displaySubtitle = isRealtimeMode ? realtimeSubtitle : subtitle;
  const avatarInputLevel = isRealtimeMode
    ? realtime.localAudioLevel
    : inputLevel;
  const avatarOutputLevel = isRealtimeMode
    ? realtime.remoteAudioLevel
    : outputLevel;

  const getStatusLabel = () => {
    if (error) return "Não foi possível responder";
    if (isRealtimeMode && isRealtimePostTurnPending) {
      return pendingTranscriptReview?.source === "realtime"
        ? "Confirme a Transcrição"
        : "Revisando o Turno...";
    }
    if (isRealtimeMode && realtime.muted) return "Microfone Pausado";
    if (isRealtimeMode && realtime.connected && state === "IDLE") {
      return "Ao Vivo · Pode Falar";
    }
    if (
      isRealtimeMode &&
      (realtime.phase === "requesting_permission" ||
        realtime.phase === "connecting")
    ) {
      return "Conectando ao Vivo...";
    }
    switch (state) {
      case "IDLE":
        return hubModeRequested ? "Pronto para Praticar" : "Pronto para Ouvir";
      case "LISTENING":
        return "Ouvindo...";
      case "THINKING":
        return "Wolfie Pensando...";
      case "SYNTHESIZING":
        return "Preparando a Voz...";
      case "SPEAKING":
        return "Wolfie Falando";
    }
  };

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m.toString().padStart(2, "0")}:${
      sec.toString().padStart(2, "0")
    }`;
  };

  /**
   * Duas imersões distintas, não um modo com toggle escondido:
   *
   * - "free"  → prática livre (escrita e voz clássica). Custa quase nada e é
   *             ilimitada; é onde o aluno deve poder ficar à vontade.
   * - "live"  → chamada ao vivo speech-to-speech. É a cara, medida em minutos.
   *
   * O aluno precisa saber em qual está ANTES de entrar — antes, o ao vivo era
   * um botãozinho dentro do modo voz, e ninguém percebia o que estava gastando.
   */
  const handleModeSelection = (mode: "voice" | "text" | "live") => {
    const selectedMode = hubModeRequested ? "text" : mode;
    // Desbloqueia AudioContext no iOS — esse clique é o primeiro gesto do usuário
    if (!hubModeRequested) unlockAudio();
    setAudioGestureReady(true);

    setTopic("Conversa Livre");
    setContext("");
    setShowTextInput(selectedMode === "text");
    setVoiceTransport(
      selectedMode === "live"
        ? "realtime"
        : selectedMode === "voice"
        ? "classic"
        : "text",
    );
    setHasSelectedTopic(true);

    // Se escolheu voz, podemos até já acionar o áudio, ou deixar ele apertar.
    // O aluno pode pressionar o mascote; o prompt visual explica a interação.
  };

  const normalizedStage = turnGuidance.currentStage.trim().toLowerCase();
  const visualSceneProfile = useMemo(
    () =>
      resolveScene({
        experienceId,
        universeId: experienceUniverse,
        experienceMode,
      }),
    [experienceId, experienceMode, experienceUniverse],
  );
  const isGlobalMeetingScene = visualSceneProfile.universeId ===
      "global-meetings" || visualSceneProfile.hudVariant === "meeting";
  const meetingVisualState = useMemo(
    () =>
      isGlobalMeetingScene && turnGuidance.currentStage
        ? resolveMeetingVisualState({
          stage: turnGuidance.currentStage,
          scenarioStatus: turnGuidance.scenarioStatus,
          learnerIntent: turnGuidance.learnerIntent,
          requiresRetry: turnGuidance.retryRequired,
          counterpart: turnGuidance.counterpart,
          pendingQuestion: turnGuidance.pendingQuestion,
          pendingDecision: turnGuidance.pendingDecision,
        })
        : null,
    [
      isGlobalMeetingScene,
      turnGuidance.counterpart,
      turnGuidance.currentStage,
      turnGuidance.learnerIntent,
      turnGuidance.pendingDecision,
      turnGuidance.pendingQuestion,
      turnGuidance.retryRequired,
      turnGuidance.scenarioStatus,
    ],
  );
  const resumeMeetingFromCoach = useCallback(() => {
    setTurnGuidance((current) => ({
      ...current,
      learnerIntent: "perform",
      scenarioStatus: current.retryRequired ? "awaiting_retry" : "active",
    }));
  }, []);
  const visualCharacterState = error ? "ERROR" : state;
  const visualPressureLabel = resolveVisualPressureLabel(difficulty);
  const showSessionScore = turnGuidance.sessionScore !== null &&
    (normalizedStage === "report" || normalizedStage === "completed");
  const normalizedSessionScore = turnGuidance.sessionScore === null
    ? 0
    : Math.max(0, Math.min(100, Math.round(turnGuidance.sessionScore)));
  const translationLanguage: SpeechLanguage = assistantLanguage === "en"
    ? "pt"
    : "en";

  // iOS exige um gesto dentro deste componente antes do primeiro áudio.
  // Sem esta tela, a saudação automática chega antes do unlock e fica muda.
  if (hasSelectedTopic && !audioGestureReady) {
    return (
      <div className="fixed inset-0 z-[200] grid place-items-center overflow-hidden bg-slate-950 p-6 font-sans">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_15%,_#1e3a8a_0%,_#020617_62%)]" />
        {onClose && (
          <button
            type="button"
            onClick={handleClose}
            aria-label="Fechar Wolfie Tutor"
            className="absolute right-5 top-5 z-20 rounded-full border border-white/10 bg-white/5 p-3 text-white/70"
          >
            <X size={20} />
          </button>
        )}
        <div className="relative z-10 max-w-md text-center">
          <span className="mx-auto inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-indigo-500/20 text-indigo-300">
            <Volume2 size={30} aria-hidden="true" />
          </span>
          <h1 className="mt-6 text-3xl font-black text-white">
            Pronto para conversar?
          </h1>
          <p className="mt-3 text-sm leading-6 text-slate-300">
            Toque abaixo para liberar a voz do Wolfie e começar no tema
            “{topic}”.
          </p>
          <button
            type="button"
            onClick={() => {
              unlockAudio();
              startIOSKeepAlive();
              setAudioGestureReady(true);
            }}
            className="mt-7 inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-indigo-500 px-6 py-3 text-sm font-black text-white shadow-xl transition active:scale-95"
          >
            <Volume2 size={18} aria-hidden="true" />
            Iniciar conversa por voz
          </button>
        </div>
      </div>
    );
  }

  // ============================================================
  // ENTRY SCREEN — CHOOSE MODE
  // ============================================================
  if (!hasSelectedTopic) {
    return (
      <div className="fixed inset-0 z-[200] bg-slate-950 flex flex-col items-center justify-center p-4 sm:p-8 overflow-hidden font-sans">
        {/* Background Atmosphere */}
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,_#1e1b4b_0%,_#020617_60%)] pointer-events-none" />
        <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none">
          <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-indigo-500/10 rounded-full blur-[100px] animate-pulse" />
          <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-purple-500/10 rounded-full blur-[100px] animate-pulse delay-1000" />
        </div>

        {onClose && (
          <button
            onClick={handleClose}
            aria-label="Fechar Wolfie Tutor"
            className="absolute top-4 right-4 sm:top-6 sm:right-6 p-3 rounded-full bg-white/5 text-white/70 hover:bg-white/10 hover:text-white transition-all z-50 backdrop-blur-xl border border-white/10 hover:scale-110 active:scale-95 group"
          >
            <X
              size={20}
              className="group-hover:rotate-90 transition-transform duration-300"
            />
          </button>
        )}

        <div className="relative z-10 max-w-4xl w-full flex flex-col items-center text-center px-4">
          <div className="mb-8 sm:mb-12">
            <div className="inline-flex items-center gap-2 px-3 sm:px-4 py-1.5 rounded-full bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 mb-4 sm:mb-6">
              <BrainCircuit size={14} />
              <span className="text-[10px] sm:text-xs font-bold uppercase tracking-widest">
                Wolfie AI · Wise Wolf
              </span>
            </div>
            <h1 className="text-3xl sm:text-5xl md:text-7xl font-black text-transparent bg-clip-text bg-gradient-to-r from-white via-slate-200 to-indigo-300 drop-shadow-2xl mb-4 sm:mb-6">
              Olá, {(user?.full_name || user?.name)?.split(" ")[0] || "Aluno"}!
            </h1>
            <p className="text-slate-400 text-base sm:text-lg md:text-xl max-w-2xl mx-auto font-light leading-relaxed">
              Como você prefere praticar o seu inglês hoje?
            </p>
          </div>

          {/* ── PRÁTICA LIVRE — ilimitada, custa quase nada ── */}
          <div className="w-full max-w-3xl mx-auto">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-3 text-left">
              {voiceReplies === true
                ? "Prática livre · ilimitada"
                : "Wolfie gratuito · ilimitado"}
            </p>
            <div className="grid grid-cols-2 gap-3 sm:gap-4">
              {!hubModeRequested && <button
                onClick={() => handleModeSelection("voice")}
                className="group relative p-4 sm:p-6 rounded-2xl bg-slate-900/80 backdrop-blur-xl border border-slate-700/80 hover:bg-slate-800/90 active:scale-95 transition-all overflow-hidden flex flex-col items-center text-center"
              >
                <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/20 to-purple-500/0 opacity-0 group-hover:opacity-100 transition-opacity" />
                <div className="w-12 h-12 sm:w-16 sm:h-16 rounded-full bg-indigo-500/20 flex items-center justify-center mb-2 sm:mb-4 group-hover:bg-indigo-500 transition-all">
                  <Mic
                    size={22}
                    className="text-indigo-400 group-hover:text-white transition-colors"
                  />
                </div>
                <h3 className="text-sm sm:text-lg font-bold text-white mb-1">
                  Falar
                </h3>
                <p className="text-slate-400 text-[11px] sm:text-xs hidden sm:block">
                  {voiceReplies === true
                    ? "Você fala, o Wolfie responde por voz e texto."
                    : "Você fala, o Wolfie ouve, corrige e responde por escrito."}
                </p>
              </button>}

              <button
                onClick={() => handleModeSelection("text")}
                className="group relative p-4 sm:p-6 rounded-2xl bg-slate-900/80 backdrop-blur-xl border border-slate-700/80 hover:bg-slate-800/90 active:scale-95 transition-all overflow-hidden flex flex-col items-center text-center"
              >
                <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/20 to-teal-500/0 opacity-0 group-hover:opacity-100 transition-opacity" />
                <div className="w-12 h-12 sm:w-16 sm:h-16 rounded-full bg-emerald-500/20 flex items-center justify-center mb-2 sm:mb-4 group-hover:bg-emerald-500 transition-all">
                  <MessageSquare
                    size={22}
                    className="text-emerald-400 group-hover:text-white transition-colors"
                  />
                </div>
                <h3 className="text-sm sm:text-lg font-bold text-white mb-1">
                  Escrever
                </h3>
                <p className="text-slate-400 text-[11px] sm:text-xs hidden sm:block">
                  Converse por escrito, no seu ritmo.
                </p>
              </button>
            </div>

            {/* ── CHAMADA AO VIVO — premium, medida em minutos ── */}
            {!hubModeRequested && WOLFIE_REALTIME_ENABLED && (
              <>
                <p className="text-[10px] font-black uppercase tracking-widest text-amber-400/80 mb-3 mt-7 text-left">
                  Chamada ao vivo · premium
                </p>
                <button
                  onClick={() => handleModeSelection("live")}
                  className="group relative w-full p-5 sm:p-6 rounded-2xl bg-gradient-to-br from-amber-500/10 via-slate-900/80 to-slate-900/80 backdrop-blur-xl border border-amber-500/30 hover:border-amber-400/60 active:scale-[0.99] transition-all overflow-hidden flex items-center gap-4 text-left"
                >
                  <div className="w-12 h-12 sm:w-16 sm:h-16 shrink-0 rounded-full bg-amber-500/20 flex items-center justify-center group-hover:bg-amber-500 transition-all">
                    <Radio
                      size={22}
                      className="text-amber-300 group-hover:text-white transition-colors"
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-sm sm:text-lg font-bold text-white">
                        Conversa ao vivo
                      </h3>
                      <span className="px-2 py-0.5 rounded-full bg-amber-500/20 border border-amber-500/40 text-[9px] font-black text-amber-300 uppercase tracking-wider">
                        Premium
                      </span>
                    </div>
                    <p className="text-slate-400 text-[11px] sm:text-xs mt-0.5">
                      Fala natural, sem esperar: o Wolfie ouve e responde
                      enquanto você fala.
                      {voiceReplies === true
                        ? " Também é o que dá voz ao Wolfie na prática livre."
                        : " É aqui que o Wolfie fala com você."}
                    </p>
                    {
                      /* Saldo à vista ANTES de entrar — o aluno não pode descobrir
                        o limite só quando for cortado no meio da conversa. */
                    }
                    <div className="mt-2">
                      <WolfieLiveBalance compact />
                    </div>
                  </div>
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (WOLFIE_SCENARIO_UI_V2_ENABLED) {
    const visualControls = (
      <>
        {!hubModeRequested && WOLFIE_REALTIME_ENABLED && (
          <button
            type="button"
            onClick={isRealtimeMode ? useClassicVoice : useRealtimeVoice}
            disabled={isRealtimeMode && isRealtimePostTurnPending}
            aria-pressed={isRealtimeMode}
            aria-label={isRealtimeMode
              ? "Usar a voz clássica"
              : "Usar conversa contínua em tempo real"}
            className={`inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl border px-3 text-xs font-black transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-not-allowed disabled:opacity-50 ${
              isRealtimeMode
                ? "border-emerald-300/35 bg-emerald-400/15 text-emerald-100"
                : "border-white/10 bg-white/5 text-slate-200 hover:bg-white/10"
            }`}
          >
            <Radio
              size={15}
              className={isRealtimeMode && realtime.connected
                ? "animate-pulse motion-reduce:animate-none"
                : ""}
              aria-hidden="true"
            />
            {isRealtimeMode ? "Ao vivo" : "Clássico"}
          </button>
        )}
        {isRealtimeMode && realtime.connected && (
          <button
            type="button"
            onClick={realtime.toggleMuted}
            disabled={isRealtimePostTurnPending}
            aria-pressed={realtime.muted}
            className={`inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl border px-3 text-xs font-black transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-not-allowed disabled:opacity-50 ${
              realtime.muted
                ? "border-amber-300/35 bg-amber-400/15 text-amber-100"
                : "border-cyan-300/30 bg-cyan-400/10 text-cyan-100"
            }`}
          >
            {realtime.muted
              ? <MicOff size={15} aria-hidden="true" />
              : <Mic size={15} aria-hidden="true" />}
            {realtime.muted ? "Retomar" : "Pausar"}
          </button>
        )}
        <button
          type="button"
          onClick={() => setTranslationEnabled((current) => !current)}
          aria-pressed={translationEnabled}
          aria-label={translationEnabled ? "Desativar tradução" : "Ativar tradução"}
          className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 ${
            translationEnabled
              ? "border-sky-300/30 bg-sky-400/10 text-sky-100"
              : "border-white/10 bg-white/5 text-slate-300"
          }`}
        >
          <Languages size={16} aria-hidden="true" />
        </button>
        {!hubModeRequested && !isRealtimeMode && (
          <button
            type="button"
            onClick={() => {
              setAutoSpeakEnabled((current) => !current);
              if (state === "SPEAKING") stopSpeaking();
            }}
            aria-pressed={autoSpeakEnabled}
            aria-label={autoSpeakEnabled
              ? "Desativar reprodução automática"
              : "Ativar reprodução automática"}
            className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 ${
              autoSpeakEnabled
                ? "border-emerald-300/30 bg-emerald-400/10 text-emerald-100"
                : "border-white/10 bg-white/5 text-slate-300"
            }`}
          >
            {autoSpeakEnabled
              ? <Volume2 size={16} aria-hidden="true" />
              : <VolumeX size={16} aria-hidden="true" />}
          </button>
        )}
        {!hubModeRequested && <button
          type="button"
          onClick={() => setShowTextInput((current) => !current)}
          aria-pressed={showTextInput}
          aria-label={showTextInput ? "Ocultar teclado" : "Mostrar teclado"}
          className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 ${
            showTextInput
              ? "border-amber-300/30 bg-amber-400/10 text-amber-100"
              : "border-white/10 bg-white/5 text-slate-300"
          }`}
        >
          <MessageSquare size={16} aria-hidden="true" />
        </button>}
        {!isRealtimeMode && voiceReplies === true && (
          <button
            type="button"
            onClick={slowReplay}
            disabled={!lastSpokenTextRef.current}
            aria-label="Repetir a última fala devagar"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-slate-200 transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-not-allowed disabled:opacity-35"
          >
            <RotateCcw size={16} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          onClick={() => setShowTranscript((current) => !current)}
          aria-expanded={showTranscript}
          aria-label={showTranscript ? "Ocultar histórico" : "Mostrar histórico"}
          className={`inline-flex h-11 shrink-0 items-center gap-2 rounded-xl border px-3 text-xs font-black transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 ${
            showTranscript
              ? "border-cyan-300/30 bg-cyan-400/10 text-cyan-100"
              : "border-white/10 bg-white/5 text-slate-200 hover:bg-white/10"
          }`}
        >
          <BookOpen size={16} aria-hidden="true" />
          <span className="hidden sm:inline">Histórico</span>
          <span aria-hidden="true">{messages.length}</span>
        </button>
        <button
          type="button"
          onClick={restartConversation}
          disabled={isRestarting || state === "THINKING" || state === "LISTENING"}
          className="inline-flex min-h-11 shrink-0 items-center rounded-xl border border-fuchsia-300/25 bg-fuchsia-400/10 px-3 text-xs font-black text-fuchsia-100 transition hover:bg-fuchsia-400/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-300 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isRestarting ? "Reiniciando…" : "Nova conversa"}
        </button>
      </>
    );

    const visualInteraction = (
      <div
        className={`group relative h-full min-h-[15rem] w-full touch-none select-none transition ${
          hubModeRequested ? "cursor-default" : "cursor-pointer"
        } ${
          pendingTranscriptReview || isRealtimePostTurnPending
            ? "pointer-events-none opacity-40"
            : ""
        }`}
        style={{
          WebkitUserSelect: "none",
          WebkitTouchCallout: "none",
        } as React.CSSProperties}
        role={hubModeRequested ? undefined : "button"}
        tabIndex={hubModeRequested || pendingTranscriptReview ||
            isRealtimePostTurnPending
          ? -1
          : 0}
        aria-label={hubModeRequested
          ? "Wolfie Tutor. Use o campo de texto para praticar."
          : isRealtimeMode
          ? realtime.connected
            ? "Wolfie ao vivo. Toque para pausar ou interromper."
            : "Toque no Wolfie para iniciar a conversa ao vivo"
          : "Pressione e segure o Wolfie para falar"}
        onClick={!hubModeRequested && isRealtimeMode
          ? () => void startRealtimeConversation()
          : undefined}
        onPointerDown={hubModeRequested || isRealtimeMode ? undefined : (event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          startRecording();
        }}
        onPointerUp={hubModeRequested || isRealtimeMode ? undefined : (event) => {
          event.preventDefault();
          stopRecordingAndSend();
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onPointerCancel={hubModeRequested || isRealtimeMode ? undefined : (event) => {
          event.preventDefault();
          stopRecordingAndSend();
        }}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={hubModeRequested ? undefined : (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          if (isRealtimeMode) {
            event.preventDefault();
            if (!event.repeat) void startRealtimeConversation();
          } else if (state === "IDLE") {
            event.preventDefault();
            startRecording();
          }
        }}
        onKeyUp={hubModeRequested ? undefined : (event) => {
          if (
            !isRealtimeMode &&
            (event.key === "Enter" || event.key === " ")
          ) {
            event.preventDefault();
            stopRecordingAndSend();
          }
        }}
      >
        <div className="pointer-events-none absolute inset-x-3 top-3 z-30 flex items-start justify-between gap-3 sm:inset-x-5 sm:top-5">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-slate-950/72 px-3 py-2 text-[9px] font-black uppercase tracking-[0.14em] text-white shadow-2xl backdrop-blur-xl sm:text-[10px]">
            <span className="relative flex h-2 w-2" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-70 motion-reduce:animate-none" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-rose-400" />
            </span>
            Wolfie · conversa pessoal
          </span>
          <span className="hidden rounded-full border border-white/15 bg-slate-950/72 px-3 py-2 text-[9px] font-black uppercase tracking-[0.14em] text-white/90 shadow-2xl backdrop-blur-xl sm:inline-flex">
            {getStatusLabel()}
          </span>
        </div>

        <span className="pointer-events-none absolute left-1/2 top-16 z-30 -translate-x-1/2 whitespace-nowrap rounded-full border border-white/15 bg-slate-950/72 px-4 py-2 text-[9px] font-black uppercase tracking-[0.14em] text-white shadow-2xl backdrop-blur-xl sm:top-20 sm:text-[10px]">
          {hubModeRequested
            ? "Use o campo de texto"
            : isRealtimeMode
            ? realtime.connected
              ? realtime.muted
                ? "Toque para retomar"
                : "Conversa ao vivo"
              : "Toque para iniciar"
            : state === "LISTENING"
            ? "Solte para enviar"
            : "Olhe para o Wolfie e segure para falar"}
        </span>
      </div>
    );

    const visualContext = (
      <div className="space-y-3">
        {error && (
          <div
            role="alert"
            className="rounded-2xl border border-red-300/30 bg-red-950/70 p-4 text-sm font-semibold leading-6 text-red-100"
          >
            {error}
          </div>
        )}

        {meetingVisualState
          ? <WolfieMeetingHUD state={meetingVisualState} compact />
          : (
            <section className="rounded-3xl border border-white/10 bg-slate-950/76 p-4 shadow-2xl backdrop-blur-2xl">
              <p className="text-[10px] font-black uppercase tracking-[0.16em] text-cyan-200">
                Contexto da prática
              </p>
              <h2 className="mt-1 text-lg font-black text-white">
                {visualSceneProfile.environmentDescription}
              </h2>
              <p className="mt-2 text-xs leading-5 text-slate-300">
                {studentGoal || "Converse naturalmente e aplique o feedback no próximo turno."}
              </p>
            </section>
          )}

        <section
          aria-label="Foco da prática"
          className="grid gap-2 rounded-2xl border border-white/10 bg-slate-950/72 p-3 text-xs backdrop-blur-xl sm:grid-cols-2 lg:grid-cols-1"
        >
          <div className="rounded-xl bg-white/5 p-3">
            <p className="text-[9px] font-black uppercase tracking-wider text-slate-400">
              Competência em foco
            </p>
            <p className="mt-1 font-semibold leading-5 text-slate-100">
              {targetSkill || "Comunicação clara e natural"}
            </p>
          </div>
          <div className="rounded-xl bg-white/5 p-3">
            <p className="text-[9px] font-black uppercase tracking-wider text-slate-400">
              Nível de pressão
            </p>
            <p className="mt-1 font-semibold leading-5 text-slate-100">
              {visualPressureLabel}
            </p>
          </div>
        </section>

        {translation && (
          <section className="rounded-2xl border border-sky-300/20 bg-sky-950/65 p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[10px] font-black uppercase tracking-wider text-sky-200">
                {translationLanguage === "pt" ? "Tradução" : "Versão em inglês"}
              </p>
              <div className="flex items-center gap-1">
                {!hubModeRequested && <button
                  type="button"
                  onClick={() => void speak(translation, 1, translationLanguage)}
                  aria-label="Ouvir tradução"
                  className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-sky-100 transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
                >
                  <Volume2 size={16} aria-hidden="true" />
                </button>}
                <button
                  type="button"
                  onClick={() => setTranslation(null)}
                  aria-label="Fechar tradução"
                  className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-sky-100 transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </div>
            </div>
            <p className="mt-2 text-sm font-medium leading-6 text-sky-50">
              {translation}
            </p>
          </section>
        )}

        {(correction || turnGuidance.strengths.length > 0 ||
          turnGuidance.priorities.length > 0 || turnGuidance.nextAction ||
          turnGuidance.needsExternalVerification || showSessionScore) && (
          <section className="rounded-3xl border border-white/10 bg-slate-950/80 p-4 shadow-2xl backdrop-blur-2xl">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <p className="text-[10px] font-black uppercase tracking-[0.16em] text-emerald-200">
                  Feedback da rodada
                </p>
                {correction?.priority && (
                  <span
                    className={`rounded-full px-2 py-1 text-[9px] font-black uppercase tracking-wider ${
                      correction.priority === "high"
                        ? "bg-red-400/15 text-red-200"
                        : correction.priority === "medium"
                        ? "bg-amber-400/15 text-amber-200"
                        : "bg-sky-400/15 text-sky-200"
                    }`}
                  >
                    Prioridade {correction.priority === "high"
                      ? "alta"
                      : correction.priority === "medium"
                      ? "média"
                      : "baixa"}
                  </span>
                )}
              </div>
              {!turnGuidance.retryRequired && (
                <button
                  type="button"
                  onClick={() => {
                    setCorrection(null);
                    setTurnGuidance((current) => ({
                      ...EMPTY_TURN_GUIDANCE,
                      currentStage: current.currentStage,
                      scenarioStatus: current.scenarioStatus,
                      learnerIntent: current.learnerIntent,
                      counterpart: current.counterpart,
                      pendingQuestion: current.pendingQuestion,
                      pendingDecision: current.pendingDecision,
                    }));
                  }}
                  aria-label="Fechar feedback"
                  className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-slate-300 transition hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                >
                  <X size={16} aria-hidden="true" />
                </button>
              )}
            </div>

            {showSessionScore && (
              <div className="mt-3 rounded-2xl border border-cyan-300/20 bg-cyan-400/10 p-3">
                <p className="text-[9px] font-black uppercase tracking-wider text-cyan-200">
                  Resultado desta sessão
                </p>
                <p className="mt-1 text-2xl font-black text-white">
                  {normalizedSessionScore}<span className="text-xs text-slate-300">/100</span>
                </p>
              </div>
            )}

            {correction && (
              <div className="mt-3 space-y-2">
                {correction.original && (
                  <div className="rounded-xl border border-red-300/15 bg-red-950/35 p-3">
                    <p className="text-[9px] font-black uppercase tracking-wider text-red-200">
                      Como você disse
                    </p>
                    <p className="mt-1 text-sm text-slate-300 line-through decoration-red-300/60">
                      {correction.original}
                    </p>
                  </div>
                )}
                {correction.corrected && (
                  <div className="rounded-xl border border-emerald-300/20 bg-emerald-400/10 p-3">
                    <p className="text-[9px] font-black uppercase tracking-wider text-emerald-200">
                      Forma recomendada
                    </p>
                    <p className="mt-1 text-sm font-black leading-6 text-emerald-50" lang="en">
                      {correction.corrected}
                    </p>
                  </div>
                )}
                {correction.naturalVersion &&
                  correction.naturalVersion !== correction.corrected && (
                  <div className="rounded-xl border border-cyan-300/20 bg-cyan-400/10 p-3">
                    <p className="text-[9px] font-black uppercase tracking-wider text-cyan-200">
                      Versão mais natural
                    </p>
                    <p className="mt-1 text-sm font-semibold leading-6 text-cyan-50" lang="en">
                      {correction.naturalVersion}
                    </p>
                  </div>
                )}
                {correction.explanation_pt && (
                  <p className="text-xs leading-5 text-slate-300" lang="pt-BR">
                    {correction.explanation_pt}
                  </p>
                )}
                {correction.usefulChunk && (
                  <div className="rounded-xl bg-indigo-400/10 p-3 text-xs leading-5 text-indigo-100">
                    <strong className="mr-2 uppercase tracking-wider text-indigo-200">
                      Chunk útil
                    </strong>
                    <span lang="en">{correction.usefulChunk}</span>
                  </div>
                )}
              </div>
            )}

            {(turnGuidance.strengths.length > 0 ||
              turnGuidance.priorities.length > 0) && (
              <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
                {turnGuidance.strengths.length > 0 && (
                  <div className="rounded-xl bg-emerald-400/10 p-3">
                    <p className="text-[9px] font-black uppercase tracking-wider text-emerald-200">
                      O que funcionou
                    </p>
                    <ul className="mt-2 space-y-1 text-xs leading-5 text-slate-100">
                      {turnGuidance.strengths.map((item, index) => (
                        <li key={`${item}-${index}`}>• {item}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {turnGuidance.priorities.length > 0 && (
                  <div className="rounded-xl bg-amber-400/10 p-3">
                    <p className="text-[9px] font-black uppercase tracking-wider text-amber-200">
                      Prioridades
                    </p>
                    <ul className="mt-2 space-y-1 text-xs leading-5 text-slate-100">
                      {turnGuidance.priorities.map((item, index) => (
                        <li key={`${item}-${index}`}>• {item}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {(turnGuidance.nextAction || turnGuidance.retryRequired) && (
              <div className="mt-3 rounded-xl border border-amber-300/20 bg-amber-400/10 p-3 text-xs leading-5 text-amber-50">
                <strong className="block uppercase tracking-wider text-amber-200">
                  {turnGuidance.retryRequired ? "Nova tentativa" : "Próxima ação"}
                </strong>
                {turnGuidance.nextAction ||
                  "Repita sua resposta usando a correção antes de avançar."}
                {turnGuidance.retryRequired && (
                  <button
                    type="button"
                    onClick={() => void disputePendingCorrection()}
                    disabled={isDisputingCorrection}
                    className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-xl border border-amber-200/25 bg-white/5 px-3 font-black transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200 disabled:opacity-50"
                  >
                    {isDisputingCorrection
                      ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />
                      : <X size={14} />}
                    Wolfie entendeu errado
                  </button>
                )}
              </div>
            )}

            {turnGuidance.needsExternalVerification && (
              <div className="mt-3 rounded-xl border border-amber-300/20 bg-amber-950/45 p-3 text-xs leading-5 text-amber-50">
                <strong className="block text-amber-200">
                  Confirme esta informação em uma fonte oficial
                </strong>
                {turnGuidance.verificationReason ||
                  "Este ponto pode ter mudado e precisa de verificação antes de ser usado como fato."}
              </div>
            )}
          </section>
        )}

        {vocabulary?.keyTerms?.length ? (
          <section className="rounded-2xl border border-indigo-300/20 bg-indigo-950/65 p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[10px] font-black uppercase tracking-wider text-indigo-200">
                Vocabulário útil
              </p>
              <button
                type="button"
                onClick={() => setVocabulary(null)}
                aria-label="Fechar vocabulário"
                className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-indigo-100 transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <div className="mt-2 space-y-2">
              {vocabulary.keyTerms.map((term, index) => (
                <div key={`${term.term}-${index}`} className="rounded-xl bg-white/5 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-black text-indigo-100" lang="en">{term.term}</p>
                    {term.level && (
                      <span className="shrink-0 rounded-full bg-indigo-400/15 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-indigo-200">
                        {term.level}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-slate-300">{term.definition}</p>
                  <p className="mt-1 text-xs italic leading-5 text-indigo-100/80" lang="en">
                    {term.example}
                  </p>
                </div>
              ))}
            </div>
            {vocabulary.grammarNote && (
              <p className="mt-3 border-t border-white/10 pt-3 text-xs font-medium leading-5 text-indigo-200">
                {vocabulary.grammarNote}
              </p>
            )}
          </section>
        ) : null}

        {quiz && <InlineQuiz quiz={quiz} />}

        <section className="rounded-2xl border border-white/10 bg-slate-950/72 p-3 backdrop-blur-xl">
          <button
            type="button"
            onClick={() => setShowTranscript((current) => !current)}
            aria-expanded={showTranscript}
            className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl px-2 text-left text-xs font-black uppercase tracking-wider text-slate-200 transition hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            Histórico ({messages.length})
            {showTranscript
              ? <ChevronUp size={16} aria-hidden="true" />
              : <ChevronDown size={16} aria-hidden="true" />}
          </button>
          {showTranscript && (
            <div className="mt-2 max-h-64 space-y-2 overflow-y-auto border-t border-white/10 pt-3">
              {messages.length === 0
                ? <p className="text-xs text-slate-400">Nenhuma mensagem ainda.</p>
                : messages.map((message) => (
                  <div
                    key={message.id}
                    className={`rounded-xl p-3 text-xs leading-5 ${
                      message.role === "user"
                        ? "ml-5 bg-indigo-400/15 text-indigo-50"
                        : "mr-5 bg-white/5 text-slate-100"
                    }`}
                  >
                    <p>{message.content}</p>
                    {message.correction && (
                      <div className="mt-2 border-t border-white/10 pt-2">
                        {message.correction.original && (
                          <span className="text-red-300 line-through">
                            {message.correction.original}
                          </span>
                        )}
                        {message.correction.corrected && (
                          <span className="ml-2 font-semibold text-emerald-300">
                            {message.correction.corrected}
                          </span>
                        )}
                      </div>
                    )}
                    {message.translation && (
                      <p className="mt-1 italic text-sky-200/80">
                        {message.translation}
                      </p>
                    )}
                  </div>
                ))}
              <div ref={messagesEndRef} />
            </div>
          )}
        </section>
      </div>
    );

    const shouldShowVisualContext = Boolean(
      error || meetingVisualState || translation || correction ||
        turnGuidance.strengths.length > 0 ||
        turnGuidance.priorities.length > 0 || turnGuidance.nextAction ||
        turnGuidance.needsExternalVerification || showSessionScore ||
        vocabulary?.keyTerms?.length || quiz || showTranscript,
    );

    const primaryCallControl = hubModeRequested
      ? null
      : isRealtimeMode
      ? (
        <button
          type="button"
          onClick={() => {
            if (realtime.connected) {
              realtime.toggleMuted();
              return;
            }
            void startRealtimeConversation();
          }}
          disabled={isRealtimePostTurnPending}
          className={`inline-flex min-h-12 shrink-0 items-center justify-center gap-2 rounded-2xl px-5 text-sm font-black text-white shadow-lg transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-50 ${
            realtime.connected && !realtime.muted
              ? "bg-rose-500 hover:bg-rose-400"
              : "bg-emerald-500 hover:bg-emerald-400"
          }`}
        >
          {realtime.connected && !realtime.muted
            ? <MicOff size={18} aria-hidden="true" />
            : <Mic size={18} aria-hidden="true" />}
          {realtime.connected
            ? realtime.muted ? "Retomar conversa" : "Pausar conversa"
            : "Começar chamada"}
        </button>
      )
      : (
        <button
          type="button"
          disabled={state === "THINKING" || state === "SYNTHESIZING"}
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            startRecording();
          }}
          onPointerUp={(event) => {
            event.preventDefault();
            stopRecordingAndSend();
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          }}
          onPointerCancel={(event) => {
            event.preventDefault();
            stopRecordingAndSend();
          }}
          onKeyDown={(event) => {
            if ((event.key === "Enter" || event.key === " ") && !event.repeat) {
              event.preventDefault();
              startRecording();
            }
          }}
          onKeyUp={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              stopRecordingAndSend();
            }
          }}
          className={`inline-flex min-h-12 shrink-0 touch-none items-center justify-center gap-2 rounded-2xl px-5 text-sm font-black text-white shadow-lg transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-50 ${
            state === "LISTENING"
              ? "scale-[1.02] bg-rose-500 shadow-rose-950/40"
              : "bg-indigo-500 hover:bg-indigo-400"
          }`}
        >
          <Mic size={18} aria-hidden="true" />
          {state === "LISTENING" ? "Solte para enviar" : "Segure para falar"}
        </button>
      );

    const visualActions = (
      <div className="mx-auto w-full max-w-5xl space-y-2 px-3 pb-3 sm:px-5 lg:px-7">
        {showTextInput && (
          <div className="flex min-h-14 items-center gap-2 rounded-2xl border border-white/12 bg-slate-950/82 p-2 pl-4 shadow-2xl backdrop-blur-2xl focus-within:ring-2 focus-within:ring-cyan-300/60">
            <input
              type="text"
              value={inputText}
              onChange={(event) => setInputText(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && sendMessage(inputText)}
              placeholder={isRealtimeMode && !realtime.connected
                ? "Inicie a conversa ao vivo no Wolfie…"
                : "Digite em inglês ou português…"}
              disabled={state === "THINKING" ||
                (isRealtimeMode && isRealtimePostTurnPending) ||
                (isRealtimeMode && !realtime.connected)}
              className="min-w-0 flex-1 bg-transparent text-sm font-medium text-white outline-none placeholder:text-slate-400 disabled:opacity-50"
              aria-label="Mensagem para o Wolfie"
            />
            <button
              type="button"
              onClick={() => sendMessage(inputText)}
              disabled={!inputText.trim() || state === "THINKING" ||
                (isRealtimeMode && isRealtimePostTurnPending) ||
                (isRealtimeMode && !realtime.connected)}
              aria-label="Enviar mensagem"
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-indigo-500 text-white transition hover:bg-indigo-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-35"
            >
              {state === "THINKING"
                ? <Loader2 size={17} className="animate-spin motion-reduce:animate-none" />
                : <Send size={17} aria-hidden="true" />}
            </button>
          </div>
        )}
        <div className="flex min-h-16 items-center gap-2 rounded-[1.35rem] border border-white/12 bg-slate-950/82 p-2 shadow-2xl backdrop-blur-2xl">
          {primaryCallControl}
          <div
            role="group"
            aria-label="Controles da chamada"
            className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {visualControls}
          </div>
        </div>
      </div>
    );

    const latestAssistantText = [...messages]
      .reverse()
      .find((message) => message.role === "assistant")
      ?.content.trim() || "";
    const visualCoachResponse = latestAssistantText ||
      displaySubtitle.trim() || turnGuidance.nextAction.trim();
    const shouldShowVisualModal = Boolean(
      pendingTranscriptReview || meetingVisualState?.showCoachSheet,
    );
    const visualModal = shouldShowVisualModal
      ? (
        <>
          {pendingTranscriptReview && (
            <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-950/55 px-4 backdrop-blur-sm">
              <WolfieTranscriptReview
                transcript={pendingTranscriptReview.transcript}
                alternatives={pendingTranscriptReview.alternatives}
                confidence={pendingTranscriptReview.confidence}
                busy={pendingTranscriptReview.source === "realtime" &&
                  isConfirmingRealtimeTranscript}
                onConfirm={(transcript) => {
                  if (pendingTranscriptReview.source === "realtime") {
                    void confirmRealtimeTranscript(
                      pendingTranscriptReview,
                      transcript,
                    );
                    return;
                  }
                  unlockAudio();
                  startIOSKeepAlive();
                  submitVoiceTranscript(
                    { ...pendingTranscriptReview, transcript },
                    true,
                  );
                }}
                onRetry={() => {
                  if (pendingTranscriptReview.source === "realtime") {
                    markRealtimeConfirmationPending(true);
                    setError(
                      "Este turno já foi respondido. Edite a frase ou confirme-a para manter o histórico consistente.",
                    );
                    return;
                  }
                  setPendingTranscriptReview(null);
                  setSubtitle("");
                  setState("IDLE");
                }}
              />
            </div>
          )}
          {meetingVisualState && !pendingTranscriptReview && (
            <WolfieCoachSheet
              state={meetingVisualState}
              open={meetingVisualState.showCoachSheet}
              onResume={resumeMeetingFromCoach}
            >
              <div className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.045] p-4">
                <p className="text-[10px] font-black uppercase tracking-[0.16em] text-cyan-200">
                  Resposta do Wolfie
                </p>
                <p
                  className="whitespace-pre-wrap text-sm font-medium leading-6 text-slate-100"
                  lang={assistantLanguage}
                  dir="auto"
                >
                  {visualCoachResponse ||
                    "O apoio específico aparecerá aqui assim que o Wolfie concluir a resposta."}
                </p>
                {correction?.corrected && (
                  <div className="rounded-xl border border-emerald-300/20 bg-emerald-400/10 p-3">
                    <p className="text-[9px] font-black uppercase tracking-wider text-emerald-200">
                      Forma recomendada
                    </p>
                    <p className="mt-1 text-sm font-black leading-6 text-emerald-50" lang="en">
                      {correction.corrected}
                    </p>
                  </div>
                )}
                {translation && (
                  <p className="rounded-xl bg-sky-400/10 p-3 text-xs leading-5 text-sky-100">
                    {translation}
                  </p>
                )}
              </div>
            </WolfieCoachSheet>
          )}
        </>
      )
      : null;

    return (
      <div className="fixed inset-0 z-[200] overflow-hidden bg-slate-950 font-sans">
        <WolfieScenarioStage
          profile={visualSceneProfile}
          presentation="ugc"
          priority
          hud={
            <WolfieSessionHUD
              profile={visualSceneProfile}
              state={visualCharacterState}
              statusLabel={getStatusLabel()}
              elapsedSeconds={elapsed}
              level={studentLevel}
              topic={topic}
              stageLabel={meetingVisualState?.stageMeta.label ||
                turnGuidance.currentStage || undefined}
              modeLabel={isRealtimeMode ? "Ao vivo" : showTextInput ? "Texto" : "Voz clássica"}
              connectionLabel={isRealtimeMode
                ? realtime.connected
                  ? realtime.muted ? "Pausado" : "Conectado"
                  : "Pronto para conectar"
                : undefined}
              onClose={onClose ? handleClose : undefined}
            />
          }
          character={
            <WolfieCharacter
              profile={visualSceneProfile}
              state={visualCharacterState}
              inputLevel={avatarInputLevel}
              outputLevel={avatarOutputLevel}
              fallbackImageSrc={null}
              framing="ugc"
              className="pt-1 sm:pt-2"
            />
          }
          sceneContent={visualInteraction}
          context={shouldShowVisualContext ? visualContext : undefined}
          caption={
            <WolfieCaptionBar
              text={displaySubtitle}
              speaker={state === "LISTENING" ? "Você" : "Wolfie Tutor"}
              language={assistantLanguage}
              state={visualCharacterState}
              isFinal={state !== "LISTENING"}
              announceFinal
              variant="ugc"
            />
          }
          actions={visualActions}
          modal={visualModal}
          stageLabel="Área interativa do Wolfie"
          contextLabel={isGlobalMeetingScene
            ? "Checkpoint e apoio da reunião"
            : "Contexto e apoio da prática"}
        />
      </div>
    );
  }

  // ============================================================
  // RENDER — UNIFIED VOICE + TEXT EXPERIENCE
  // ============================================================
  return (
    <div className="fixed inset-0 z-[200] bg-slate-950 flex flex-col items-center justify-center overflow-hidden font-sans">
      {/* BACKGROUND EFFECTS */}
      <div
        className={`absolute inset-0 transition-colors duration-1000 ${
          state === "LISTENING"
            ? "bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-red-900/30 via-slate-950 to-slate-950"
            : state === "THINKING"
            ? "bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-purple-900/30 via-slate-950 to-slate-950"
            : state === "SPEAKING" || state === "SYNTHESIZING"
            ? "bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-cyan-900/30 via-slate-950 to-slate-950"
            : "bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-indigo-900/20 via-slate-950 to-slate-950"
        }`}
      >
      </div>
      {/* Noise texture inline — sem dependência externa */}
      <div
        className="absolute inset-0 opacity-[0.15] pointer-events-none mix-blend-overlay"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
          backgroundSize: "200px 200px",
        }}
      >
      </div>

      {/* CLOSE BUTTON */}
      {onClose && (
        <button
          onClick={handleClose}
          aria-label="Fechar Wolfie Tutor"
          className="absolute top-4 right-4 sm:top-6 sm:right-6 p-3 rounded-full bg-white/5 text-white/70 hover:bg-white/10 hover:text-white transition-all z-50 backdrop-blur-xl border border-white/10 hover:scale-110 active:scale-95 group"
        >
          <X
            size={20}
            className="group-hover:rotate-90 transition-transform duration-300"
          />
        </button>
      )}

      {/* HEADER HUD */}
      <div className="absolute top-4 sm:top-6 left-1/2 -translate-x-1/2 z-40 w-full px-16 sm:px-20 flex flex-col items-center gap-2">
        {/* Status Badge */}
        <div className="flex items-center gap-3 px-5 py-2 rounded-full bg-white/5 border border-white/10 backdrop-blur-md shadow-2xl">
          <div
            className={`w-2 h-2 rounded-full ${
              state === "LISTENING"
                ? "bg-red-500 animate-pulse shadow-[0_0_10px_rgba(239,68,68,0.8)]"
                : state === "THINKING"
                ? "bg-purple-500 animate-pulse"
                : state === "SPEAKING" || state === "SYNTHESIZING"
                ? "bg-cyan-500 shadow-[0_0_10px_rgba(6,182,212,0.8)]"
                : "bg-indigo-500"
            }`}
          />
          <span className="text-[10px] font-bold text-white/90 tracking-[0.2em] uppercase">
            {getStatusLabel()}
          </span>
          <span
            className="hidden sm:block max-w-[220px] truncate border-l border-white/10 pl-3 text-[10px] font-semibold text-cyan-200/80"
            title={`Tema mantido: ${topic}`}
          >
            Tema: {topic}
          </span>
        </div>

        {/* Timer + Level + Controls */}
        <div className="flex flex-wrap items-center justify-center gap-2">
          <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/5 border border-white/10 backdrop-blur-md">
            <Clock size={10} className="text-slate-400" />
            <span className="text-[10px] font-mono text-slate-400">
              {formatTime(elapsed)}
            </span>
          </div>
          <div className="px-3 py-1 rounded-full bg-indigo-500/15 border border-indigo-500/20 text-[10px] font-bold text-indigo-300 uppercase tracking-wider">
            {studentLevel}
          </div>
          {!hubModeRequested && WOLFIE_REALTIME_ENABLED && (
            <button
              type="button"
              onClick={isRealtimeMode ? useClassicVoice : useRealtimeVoice}
              disabled={isRealtimeMode && isRealtimePostTurnPending}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-wider transition disabled:cursor-not-allowed disabled:opacity-50 ${
                isRealtimeMode
                  ? "border-emerald-400/40 bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30"
                  : "border-white/10 bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white"
              }`}
              title={isRealtimeMode
                ? "Usar a voz clássica"
                : "Usar conversa contínua em tempo real"}
            >
              <Radio
                size={11}
                className={isRealtimeMode && realtime.connected
                  ? "animate-pulse"
                  : ""}
                aria-hidden="true"
              />
              {isRealtimeMode ? "Ao vivo" : "Clássico"}
            </button>
          )}
          {isRealtimeMode && realtime.connected && (
            <button
              type="button"
              onClick={realtime.toggleMuted}
              disabled={isRealtimePostTurnPending}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-wider transition ${
                realtime.muted
                  ? "border-amber-400/40 bg-amber-500/20 text-amber-100"
                  : "border-cyan-400/30 bg-cyan-500/15 text-cyan-100"
              }`}
              aria-pressed={realtime.muted}
              title={realtime.muted ? "Reativar microfone" : "Pausar microfone"}
            >
              {realtime.muted
                ? <MicOff size={11} aria-hidden="true" />
                : <Mic size={11} aria-hidden="true" />}
              {realtime.muted ? "Retomar" : "Pausar"}
            </button>
          )}
          {/* O idioma é reconhecido por fala, sem seletor PT/EN. */}
          {!hubModeRequested && !isRealtimeMode && (
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-violet-500/30 bg-violet-500/15 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-violet-200"
              title="O Wolfie reconhece português e inglês automaticamente a cada fala."
              aria-label="Idioma do microfone: automático, português e inglês"
            >
              <Mic size={11} aria-hidden="true" />
              MIC AUTO
            </span>
          )}
          {/* Translation Toggle */}
          <button
            onClick={() => setTranslationEnabled((p) => !p)}
            className={`p-1.5 rounded-full border transition-all ${
              translationEnabled
                ? "bg-sky-500/15 border-sky-500/30 text-sky-300"
                : "bg-white/5 border-white/10 text-slate-400"
            }`}
            title={translationEnabled ? "Tradução ON" : "Tradução OFF"}
          >
            <Languages size={12} />
          </button>
          {/* Auto-Speak Toggle */}
          {!hubModeRequested && !isRealtimeMode && (
            <button
              onClick={() => {
                setAutoSpeakEnabled((p) => !p);
                if (state === "SPEAKING") {
                  stopSpeaking();
                }
              }}
              className={`p-1.5 rounded-full border transition-all ${
                autoSpeakEnabled
                  ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-300"
                  : "bg-white/5 border-white/10 text-slate-400"
              }`}
              title={autoSpeakEnabled ? "Auto-speak ON" : "Auto-speak OFF"}
            >
              {autoSpeakEnabled ? <Volume2 size={12} /> : <VolumeX size={12} />}
            </button>
          )}
          {/* Text Toggle */}
          {!hubModeRequested && <button
            onClick={() => setShowTextInput((p) => !p)}
            className={`p-1.5 rounded-full border transition-all ${
              showTextInput
                ? "bg-amber-500/15 border-amber-500/30 text-amber-300"
                : "bg-white/5 border-white/10 text-slate-400"
            }`}
            title={showTextInput ? "Teclado ON" : "Teclado OFF"}
          >
            <MessageSquare size={12} />
          </button>}
          {/* Slow Replay — só existe quando o Wolfie fala (premium) */}
          {!isRealtimeMode && voiceReplies === true && (
            <button
              onClick={slowReplay}
              disabled={!lastSpokenTextRef.current}
              className="p-1.5 rounded-full bg-white/5 border border-white/10 text-slate-400 hover:text-white hover:bg-white/10 transition-all disabled:opacity-30"
              title="Repetir devagar (0.88x)"
            >
              <RotateCcw size={12} />
            </button>
          )}
          {/* Nova Conversa — reseta sessão (cria nova session_id no banco no próximo turno) */}
          <button
            onClick={restartConversation}
            disabled={isRestarting ||
              state === "THINKING" ||
              state === "LISTENING"}
            className="px-2.5 py-1.5 rounded-full bg-fuchsia-500/15 border border-fuchsia-500/30 text-fuchsia-300 text-[10px] font-bold uppercase tracking-wider hover:bg-fuchsia-500/25 transition-all disabled:cursor-not-allowed disabled:opacity-40"
            title={state === "THINKING" || state === "LISTENING"
              ? "Aguarde este turno terminar para iniciar uma nova conversa"
              : "Reiniciar mantendo o mesmo tema"}
          >
            {isRestarting ? "Encerrando…" : "Nova"}
          </button>
        </div>

        {turnGuidance.currentStage && (
          <div
            className="max-w-[min(34rem,calc(100vw-2rem))] truncate rounded-full border border-cyan-500/20 bg-cyan-500/10 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-cyan-200"
            title={turnGuidance.currentStage}
          >
            Etapa atual: {turnGuidance.currentStage}
          </div>
        )}

        {turnGuidance.retryRequired && (
          <div
            className="flex max-w-[min(38rem,calc(100vw-2rem))] items-center gap-2 rounded-2xl border border-amber-400/40 bg-amber-950/90 px-4 py-2 text-left text-[11px] font-semibold leading-4 text-amber-100 shadow-xl backdrop-blur-xl"
            role="status"
            aria-live="assertive"
          >
            <RotateCcw
              size={14}
              className="shrink-0 text-amber-300"
              aria-hidden="true"
            />
            <span>
              <strong className="block uppercase tracking-wider text-amber-300">
                Nova tentativa necessária
              </strong>
              {turnGuidance.nextAction ||
                "Repita sua resposta usando a correção antes de avançar."}
              <button
                type="button"
                onClick={() => void disputePendingCorrection()}
                disabled={isDisputingCorrection}
                className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-amber-300/30 bg-amber-300/10 px-3 py-1 text-[10px] font-black uppercase tracking-wider text-amber-100 transition hover:bg-amber-300/20 disabled:cursor-wait disabled:opacity-50"
              >
                {isDisputingCorrection
                  ? <Loader2 size={11} className="animate-spin" />
                  : <X size={11} />}
                Wolfie entendeu errado
              </button>
            </span>
          </div>
        )}

        {/* Idle Hint */}
        {state === "IDLE" && !pendingTranscriptReview && (
          <div className="text-white/30 text-[9px] font-bold tracking-[0.3em] uppercase animate-pulse">
            {hubModeRequested
              ? "Digite sua resposta para continuar"
              : isRealtimeMode
              ? realtime.connected
                ? realtime.muted
                  ? "Toque em retomar para continuar"
                  : "Conversa ao vivo · fale naturalmente"
                : "Toque no Wolfie para iniciar ao vivo"
              : "Pressione o mascote para falar"}
          </div>
        )}
      </div>

      {/* ERROR FEEDBACK */}
      {error && (
        <div className="absolute top-32 z-50 animate-in slide-in-from-top-4 fade-in duration-300">
          <div className="bg-red-950/80 backdrop-blur-2xl border border-red-500/50 text-red-200 px-6 py-3 rounded-2xl flex items-center gap-3 shadow-[0_0_30px_rgba(239,68,68,0.3)]">
            <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            <span className="text-xs font-bold tracking-[0.1em] uppercase">
              {error}
            </span>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* MAIN INTERACTION AREA — WOLFIE AVATAR */}
      {/* ============================================================ */}
      <div className="relative z-20 flex flex-col items-center justify-center w-full h-full max-w-5xl mx-auto">
        {pendingTranscriptReview && (
          <div className="absolute inset-0 z-50 flex items-center justify-center px-4">
            <WolfieTranscriptReview
              transcript={pendingTranscriptReview.transcript}
              alternatives={pendingTranscriptReview.alternatives}
              confidence={pendingTranscriptReview.confidence}
              busy={pendingTranscriptReview.source === "realtime" &&
                isConfirmingRealtimeTranscript}
              onConfirm={(transcript) => {
                if (pendingTranscriptReview.source === "realtime") {
                  void confirmRealtimeTranscript(
                    pendingTranscriptReview,
                    transcript,
                  );
                  return;
                }
                unlockAudio();
                startIOSKeepAlive();
                submitVoiceTranscript({
                  ...pendingTranscriptReview,
                  transcript,
                }, true);
              }}
              onRetry={() => {
                if (pendingTranscriptReview.source === "realtime") {
                  markRealtimeConfirmationPending(true);
                  setError(
                    "Este turno já foi respondido. Edite a frase ou confirme-a para manter o histórico consistente.",
                  );
                  return;
                }
                setPendingTranscriptReview(null);
                setSubtitle("");
                setState("IDLE");
              }}
            />
          </div>
        )}
        <div
          className={`relative w-[260px] h-[260px] sm:w-[320px] sm:h-[320px] md:w-[500px] md:h-[500px] touch-none select-none flex items-center justify-center group transition ${
            hubModeRequested ? "cursor-default" : "cursor-pointer"
          } ${
            pendingTranscriptReview || isRealtimePostTurnPending
              ? "pointer-events-none opacity-25 blur-sm"
              : ""
          }`}
          style={{
            WebkitUserSelect: "none",
            WebkitTouchCallout: "none",
          } as React.CSSProperties}
          role={hubModeRequested ? undefined : "button"}
          tabIndex={hubModeRequested || pendingTranscriptReview ||
              isRealtimePostTurnPending
            ? -1
            : 0}
          aria-label={hubModeRequested
            ? "Wolfie Tutor. Use o campo de texto para praticar."
            : isRealtimeMode
            ? realtime.connected
              ? "Wolfie ao vivo. Toque para pausar ou interromper."
              : "Toque no Wolfie para iniciar a conversa ao vivo"
            : "Pressione e segure o mascote para falar com o Wolfie"}
          onClick={!hubModeRequested && isRealtimeMode
            ? () => void startRealtimeConversation()
            : undefined}
          onPointerDown={hubModeRequested || isRealtimeMode ? undefined : (event) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            startRecording();
          }}
          onPointerUp={hubModeRequested || isRealtimeMode ? undefined : (event) => {
            event.preventDefault();
            stopRecordingAndSend();
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          }}
          onPointerCancel={hubModeRequested || isRealtimeMode ? undefined : (event) => {
            event.preventDefault();
            stopRecordingAndSend();
          }}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={hubModeRequested ? undefined : (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            if (isRealtimeMode) {
              event.preventDefault();
              if (!event.repeat) void startRealtimeConversation();
            } else if (state === "IDLE") {
              event.preventDefault();
              startRecording();
            }
          }}
          onKeyUp={hubModeRequested ? undefined : (event) => {
            if (
              !isRealtimeMode &&
              (event.key === "Enter" || event.key === " ")
            ) {
              event.preventDefault();
              stopRecordingAndSend();
            }
          }}
        >
          <WolfieAvatar
            state={state}
            inputLevel={avatarInputLevel}
            outputLevel={avatarOutputLevel}
            className="h-full w-full"
            accessibleLabel="Wolfie, tutor virtual da Wise Wolf"
          />

          {/* Hover Hint */}
          {state === "IDLE" && !pendingTranscriptReview && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-500">
              <div className="px-5 py-2.5 rounded-full bg-white/10 backdrop-blur-xl border border-white/20 tracking-[0.2em] text-white/90 text-[10px] font-bold uppercase shadow-2xl">
                {hubModeRequested
                  ? "Use o campo de texto"
                  : isRealtimeMode
                  ? realtime.connected
                    ? realtime.muted
                      ? "Toque para retomar"
                      : "Fale naturalmente"
                    : "Iniciar ao vivo"
                  : "Segure para falar"}
              </div>
            </div>
          )}
        </div>

        {/* Subtitles */}
        <div className="absolute bottom-24 sm:bottom-20 md:bottom-28 left-0 right-0 px-4 sm:px-8 text-center pointer-events-none z-30 min-h-[80px] flex flex-col items-center justify-end">
          {displaySubtitle
            ? (
              <p className="text-base sm:text-xl md:text-2xl lg:text-3xl font-light text-white drop-shadow-[0_4px_20px_rgba(0,0,0,0.8)] animate-in fade-in slide-in-from-bottom-6 duration-700 max-w-4xl mx-auto leading-relaxed">
                "{displaySubtitle}"
              </p>
            )
            : state !== "IDLE"
            ? (
              <p
                className={`text-xs tracking-[0.4em] font-bold uppercase ${
                  state === "THINKING" || state === "SYNTHESIZING"
                    ? "text-purple-400 animate-pulse"
                    : state === "LISTENING"
                    ? "text-red-400 animate-pulse"
                    : "text-slate-400"
                }`}
              >
                {state === "THINKING"
                  ? "Processando..."
                  : state === "SYNTHESIZING"
                  ? "Preparando a voz..."
                  : state === "LISTENING"
                  ? "Ouvindo..."
                  : ""}
              </p>
            )
            : null}
        </div>
      </div>

      {/* ============================================================ */}
      {/* TEXT INPUT (Collapsible) */}
      {/* ============================================================ */}
      {showTextInput && (
        <div className="absolute bottom-6 left-4 right-4 z-50 max-w-2xl mx-auto animate-in slide-in-from-bottom-6 fade-in duration-300">
          <div className="flex items-center gap-2 bg-slate-900/95 backdrop-blur-xl border border-white/10 rounded-full p-2 pl-5 shadow-2xl ring-1 ring-white/5 focus-within:ring-cyan-500/50 transition-all">
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendMessage(inputText)}
              placeholder={isRealtimeMode && !realtime.connected
                ? "Inicie o modo ao vivo no Wolfie..."
                : "Type in English..."}
              disabled={state === "THINKING" ||
                (isRealtimeMode && isRealtimePostTurnPending) ||
                (isRealtimeMode && !realtime.connected)}
              className="flex-1 min-w-0 bg-transparent border-none text-slate-200 placeholder:text-slate-500 focus:ring-0 focus:outline-none text-sm font-medium"
            />
            <button
              onClick={() => sendMessage(inputText)}
              disabled={!inputText.trim() ||
                state === "THINKING" ||
                (isRealtimeMode && isRealtimePostTurnPending) ||
                (isRealtimeMode && !realtime.connected)}
              className="p-2.5 rounded-full bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-30 transition-all"
            >
              {state === "THINKING"
                ? <Loader2 size={16} className="animate-spin" />
                : <Send size={16} />}
            </button>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* STRUCTURED FEEDBACK CARD (Bottom Left) */}
      {/* ============================================================ */}
      {(correction ||
        turnGuidance.strengths.length > 0 ||
        turnGuidance.priorities.length > 0 ||
        turnGuidance.nextAction ||
        turnGuidance.needsExternalVerification ||
        turnGuidance.retryRequired ||
        showSessionScore) && (
        <div
          className={`absolute ${
            showTextInput ? "bottom-24" : "bottom-6"
          } left-4 right-4 md:right-auto md:left-8 md:w-[440px] z-40 max-h-[58vh] overflow-y-auto animate-in slide-in-from-bottom-10 fade-in duration-500`}
        >
          <div className="bg-slate-900/90 backdrop-blur-3xl border border-slate-700/80 p-5 rounded-[1.5rem] shadow-[0_20px_50px_rgba(0,0,0,0.5)] relative overflow-hidden group hover:bg-slate-800/95 transition-colors">
            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-emerald-400 via-teal-400 to-emerald-400 opacity-80" />
            <div className="flex flex-col gap-3 relative z-10">
              <div className="flex items-center justify-between border-b border-white/5 pb-2">
                <div className="flex items-center gap-2">
                  <div className="p-1.5 bg-emerald-500/20 text-emerald-400 rounded-lg">
                    <Zap size={14} fill="currentColor" />
                  </div>
                  <h4 className="text-white font-black text-[10px] uppercase tracking-widest">
                    Feedback da rodada
                  </h4>
                  {correction?.priority && (
                    <span
                      className={`rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-wider ${
                        correction.priority === "high"
                          ? "bg-red-500/20 text-red-300"
                          : correction.priority === "medium"
                          ? "bg-amber-500/20 text-amber-300"
                          : "bg-sky-500/20 text-sky-300"
                      }`}
                    >
                      Prioridade {correction.priority === "high"
                        ? "alta"
                        : correction.priority === "medium"
                        ? "média"
                        : "baixa"}
                    </span>
                  )}
                </div>
                {!turnGuidance.retryRequired && (
                  <button
                    onClick={() => {
                      setCorrection(null);
                      setTurnGuidance((current) => ({
                        ...EMPTY_TURN_GUIDANCE,
                        currentStage: current.currentStage,
                        scenarioStatus: current.scenarioStatus,
                        learnerIntent: current.learnerIntent,
                        counterpart: current.counterpart,
                        pendingQuestion: current.pendingQuestion,
                        pendingDecision: current.pendingDecision,
                      }));
                    }}
                    aria-label="Fechar feedback"
                    className="text-slate-400 hover:text-white transition-colors bg-white/5 p-1.5 rounded-full"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>

              {showSessionScore && (
                <div className="rounded-2xl border border-cyan-500/25 bg-cyan-500/10 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[9px] font-black uppercase tracking-widest text-cyan-300">
                        Resultado desta sessão
                      </p>
                      <p className="mt-1 text-xs leading-5 text-slate-200">
                        Pontuação de prática, não uma nota oficial de nível ou
                        exame.
                      </p>
                    </div>
                    <span className="shrink-0 text-3xl font-black text-cyan-200">
                      {normalizedSessionScore}
                      <span className="text-xs text-cyan-300/70">/100</span>
                    </span>
                  </div>
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-950/50">
                    <div
                      className="h-full rounded-full bg-cyan-400 transition-[width]"
                      style={{ width: `${normalizedSessionScore}%` }}
                      aria-hidden="true"
                    />
                  </div>
                </div>
              )}

              {correction && (
                <div className="space-y-2">
                  {correction.original && (
                    <div className="bg-red-950/30 rounded-xl p-3 border border-red-500/10">
                      <span className="text-[9px] text-red-400 font-bold uppercase tracking-widest flex items-center gap-1 mb-1">
                        <X size={10} strokeWidth={3} /> Como você disse
                      </span>
                      <p className="text-sm font-medium text-white/50 line-through decoration-red-500/50">
                        {correction.original}
                      </p>
                    </div>
                  )}
                  {correction.corrected && (
                    <div className="bg-emerald-500/10 rounded-xl p-3 border border-emerald-500/20">
                      <span className="text-[9px] text-emerald-400 font-bold uppercase tracking-widest flex items-center gap-1 mb-1">
                        <CheckCircle2 size={10} strokeWidth={3} /> Forma correta
                      </span>
                      <p className="text-base font-black text-emerald-300">
                        "{correction.corrected}"
                      </p>
                    </div>
                  )}
                  {correction.naturalVersion &&
                    correction.naturalVersion !== correction.corrected && (
                    <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/10 p-3">
                      <span className="text-[9px] font-bold uppercase tracking-widest text-cyan-300">
                        Versão mais natural
                      </span>
                      <p className="mt-1 text-sm font-bold leading-relaxed text-cyan-100">
                        "{correction.naturalVersion}"
                      </p>
                    </div>
                  )}
                  {correction.explanation_pt && (
                    <p className="text-xs text-slate-300 leading-relaxed font-medium">
                      {correction.explanation_pt}
                    </p>
                  )}
                  {correction.usefulChunk && (
                    <div className="rounded-xl bg-white/5 p-3 text-xs text-slate-200">
                      <span className="font-black uppercase tracking-wider text-indigo-300">
                        Chunk útil
                      </span>
                      <span className="ml-2">{correction.usefulChunk}</span>
                    </div>
                  )}
                </div>
              )}

              {(turnGuidance.strengths.length > 0 ||
                turnGuidance.priorities.length > 0) && (
                <div className="grid gap-2 sm:grid-cols-2">
                  {turnGuidance.strengths.length > 0 && (
                    <div className="rounded-xl border border-emerald-500/15 bg-emerald-500/5 p-3">
                      <p className="text-[9px] font-black uppercase tracking-widest text-emerald-300">
                        O que funcionou
                      </p>
                      <ul className="mt-2 space-y-1 text-xs leading-5 text-slate-200">
                        {turnGuidance.strengths.map((strength, index) => (
                          <li key={`${strength}-${index}`}>• {strength}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {turnGuidance.priorities.length > 0 && (
                    <div className="rounded-xl border border-amber-500/15 bg-amber-500/5 p-3">
                      <p className="text-[9px] font-black uppercase tracking-widest text-amber-300">
                        Prioridades
                      </p>
                      <ul className="mt-2 space-y-1 text-xs leading-5 text-slate-200">
                        {turnGuidance.priorities.map((priority, index) => (
                          <li key={`${priority}-${index}`}>• {priority}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {turnGuidance.nextAction && (
                <div
                  className={`rounded-xl border p-3 ${
                    turnGuidance.retryRequired
                      ? "border-amber-400/30 bg-amber-500/10"
                      : "border-fuchsia-500/20 bg-fuchsia-500/10"
                  }`}
                >
                  <p
                    className={`text-[9px] font-black uppercase tracking-widest ${
                      turnGuidance.retryRequired
                        ? "text-amber-300"
                        : "text-fuchsia-300"
                    }`}
                  >
                    {turnGuidance.retryRequired
                      ? "Nova tentativa"
                      : "Próxima ação"}
                  </p>
                  <p className="mt-1 text-xs font-semibold leading-5 text-slate-100">
                    {turnGuidance.nextAction}
                  </p>
                </div>
              )}

              {turnGuidance.needsExternalVerification && (
                <div
                  className="rounded-xl border border-amber-400/30 bg-amber-950/40 p-3 text-xs leading-5 text-amber-100"
                  role="note"
                >
                  <strong className="block text-amber-300">
                    Esta informação precisa ser confirmada
                  </strong>
                  {turnGuidance.verificationReason ||
                    "Consulte uma fonte oficial ou atual antes de usar este ponto como fato."}
                </div>
              )}

              {turnGuidance.retryRequired && !turnGuidance.nextAction && (
                <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 p-3 text-xs font-semibold leading-5 text-amber-100">
                  Repita sua resposta usando a correção antes de avançar.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TRANSLATION CARD (Top Left) */}
      {translation && (
        <div className="absolute top-[130px] left-4 md:left-8 z-40 max-w-[280px] md:max-w-sm animate-in fade-in slide-in-from-left-8 duration-500">
          <div className="bg-sky-950/40 backdrop-blur-xl border border-sky-500/20 p-3 rounded-2xl shadow-lg relative group hover:bg-sky-950/60 transition-colors">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 text-sky-400">
                <Languages size={12} />
                <span className="text-[9px] uppercase font-bold tracking-wider">
                  {translationLanguage === "pt"
                    ? "Tradução 🇧🇷"
                    : "Versão em inglês 🇺🇸"}
                </span>
              </div>
              <div className="flex items-center gap-1">
                {/* Botão: ouvir tradução em voz PT-BR */}
                {!hubModeRequested && <button
                  onClick={() => {
                    void speak(translation, 1.0, translationLanguage);
                  }}
                  title={translationLanguage === "pt"
                    ? "Ouvir em português BR"
                    : "Ouvir em inglês americano"}
                  className="p-1 rounded-lg text-sky-400/60 hover:text-sky-300 hover:bg-sky-400/10 transition-colors"
                >
                  <Volume2 size={12} />
                </button>}
                <button
                  onClick={() => setTranslation(null)}
                  className="text-sky-400/50 hover:text-sky-300 p-1"
                >
                  <X size={12} />
                </button>
              </div>
            </div>
            <p className="text-sm text-sky-100 font-medium leading-relaxed">
              {translation}
            </p>
          </div>
        </div>
      )}

      {/* VOCABULARY CARD (Top Right) */}
      {vocabulary && vocabulary.keyTerms && vocabulary.keyTerms.length > 0 && (
        <div className="absolute top-[130px] right-4 md:right-8 z-40 max-w-[260px] md:max-w-sm animate-in fade-in slide-in-from-right-8 duration-500">
          <div className="bg-indigo-950/40 backdrop-blur-xl border border-indigo-500/20 p-3 rounded-2xl shadow-lg relative group hover:bg-indigo-950/60 transition-colors">
            <button
              onClick={() => setVocabulary(null)}
              className="absolute top-2 right-2 text-indigo-400/50 hover:text-indigo-300"
            >
              <X size={12} />
            </button>
            <div className="flex items-center gap-2 mb-2 text-indigo-400">
              <BookOpen size={12} />
              <span className="text-[9px] uppercase font-bold tracking-wider">
                Vocabulário
              </span>
            </div>
            <div className="space-y-2 max-h-[250px] overflow-y-auto pr-1">
              {vocabulary.keyTerms.map((term, idx) => (
                <div
                  key={idx}
                  className="bg-white/5 p-2.5 rounded-xl border border-white/10"
                >
                  <div className="flex justify-between items-center mb-1">
                    <span className="font-bold text-indigo-300 text-sm">
                      {term.term}
                    </span>
                    <span className="text-[9px] font-bold bg-indigo-500/20 px-1.5 py-0.5 rounded text-indigo-200">
                      {term.level}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-300 leading-relaxed">
                    {term.definition}
                  </p>
                  <p className="text-[10px] text-slate-400 italic mt-1">
                    "{term.example}"
                  </p>
                </div>
              ))}
            </div>
            {vocabulary.grammarNote && (
              <div className="mt-2 pt-2 border-t border-white/10 text-[11px] text-indigo-300 font-medium leading-relaxed">
                💡 {vocabulary.grammarNote}
              </div>
            )}
          </div>
        </div>
      )}

      {/* QUIZ CARD (Bottom Right) */}
      {quiz && (
        <div className="absolute bottom-6 right-4 md:right-8 z-40 max-w-[280px] md:max-w-sm animate-in fade-in slide-in-from-bottom-8 duration-500">
          <InlineQuiz quiz={quiz} />
        </div>
      )}

      {/* TRANSCRIPT TOGGLE (Bottom center, above text input) */}
      <div className="absolute bottom-20 left-1/2 -translate-x-1/2 z-40">
        <button
          onClick={() => setShowTranscript((p) => !p)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-slate-400 hover:text-white hover:bg-white/10 transition-all text-[10px] font-bold uppercase tracking-wider"
        >
          {showTranscript ? <ChevronDown size={10} /> : <ChevronUp size={10} />}
          Histórico ({messages.length})
        </button>
      </div>

      {/* TRANSCRIPT PANEL (Slide up) */}
      {showTranscript && (
        <div className="absolute bottom-28 left-4 right-4 max-h-[40vh] z-40 animate-in slide-in-from-bottom-6 fade-in duration-300">
          <div className="bg-slate-950/90 backdrop-blur-2xl border border-white/10 rounded-2xl p-4 overflow-y-auto max-h-[40vh] space-y-3">
            {messages.length === 0
              ? (
                <p className="text-xs text-slate-400 text-center py-4">
                  Nenhuma mensagem ainda
                </p>
              )
              : (
                messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex ${
                      msg.role === "user" ? "justify-end" : "justify-start"
                    }`}
                  >
                    <div
                      className={`max-w-[80%] p-3 rounded-xl text-sm ${
                        msg.role === "user"
                          ? "bg-indigo-600/30 text-indigo-100 rounded-tr-sm"
                          : "bg-slate-800/70 text-slate-200 rounded-tl-sm border-l-2 border-cyan-500"
                      }`}
                    >
                      <p className="leading-relaxed">{msg.content}</p>
                      {msg.correction && (
                        <div className="mt-2 pt-2 border-t border-white/10 text-xs">
                          <span className="text-red-400 line-through">
                            {msg.correction.original}
                          </span>
                          <span className="text-emerald-400 ml-2">
                            {msg.correction.corrected}
                          </span>
                        </div>
                      )}
                      {msg.translation && (
                        <p className="mt-1 text-xs text-sky-300/60 italic">
                          {msg.translation}
                        </p>
                      )}
                    </div>
                  </div>
                ))
              )}
            <div ref={messagesEndRef} />
          </div>
        </div>
      )}
    </div>
  );
};

export default WolfieTutor;
