import React, { useCallback, useEffect, useRef, useState } from "react";
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
  shouldConfirmVoiceTranscript,
  uniqueTranscriptAlternatives,
} from "../lib/wolfieVoiceSafety";
import {
  useWolfieRealtime,
  type WolfieRealtimeCompletedTurn,
} from "../src/services/useWolfieRealtime";
import { WolfieAvatar } from "./WolfieAvatar";
import { WolfieTranscriptReview } from "./WolfieTranscriptReview";

// ============================================================
// TYPES
// ============================================================
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

const EMPTY_TURN_GUIDANCE: TurnGuidance = {
  currentStage: "",
  strengths: [],
  priorities: [],
  nextAction: "",
  needsExternalVerification: false,
  verificationReason: "",
  retryRequired: false,
  sessionScore: null,
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

const IS_IOS = typeof navigator !== "undefined" && (
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
);

// WAV mínimo válido (44 bytes, 0 samples, 8000Hz mono 8-bit).
// Usado para "pré-ativar" HTMLAudioElement no iOS — play() com src válido
// registra a gesture no elemento; play() com src vazio não funciona.
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

declare global {
  interface Window {
    webkitSpeechRecognition: any;
  }
}

// ============================================================
// TTS SPEED CONFIG BY LEVEL (E-Bot style)
// ============================================================
function getTTSSpeed(level: string): number {
  switch (level) {
    case "A1":
      return 0.92;
    case "A2":
      return 0.95;
    case "B1":
      return 0.98;
    case "B2":
      return 1.0;
    default:
      return 1.0; // C1, C2
  }
}

type SpeechLanguage = "pt" | "en";
type RecognitionLanguage = "pt-BR" | "en-US";

const defaultRecognitionLanguage = (): RecognitionLanguage => "en-US";

const PORTUGUESE_MARKERS = new Set([
  "a",
  "agora",
  "ainda",
  "aqui",
  "as",
  "com",
  "como",
  "da",
  "das",
  "de",
  "do",
  "dos",
  "e",
  "ela",
  "ele",
  "em",
  "então",
  "essa",
  "esse",
  "está",
  "eu",
  "inglês",
  "isso",
  "mas",
  "me",
  "meu",
  "minha",
  "não",
  "o",
  "oi",
  "os",
  "ou",
  "para",
  "por",
  "porque",
  "que",
  "se",
  "seu",
  "sua",
  "também",
  "tem",
  "uma",
  "um",
  "você",
  "vocês",
]);

const ENGLISH_MARKERS = new Set([
  "a",
  "about",
  "am",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "because",
  "but",
  "can",
  "do",
  "for",
  "from",
  "have",
  "how",
  "i",
  "in",
  "is",
  "it",
  "like",
  "my",
  "of",
  "on",
  "or",
  "so",
  "that",
  "the",
  "this",
  "to",
  "want",
  "we",
  "what",
  "when",
  "with",
  "you",
  "your",
]);

function detectSpeechLanguage(
  text: string,
  fallback: SpeechLanguage = "en",
): SpeechLanguage {
  const normalized = text.toLocaleLowerCase("pt-BR");
  const words = normalized.match(/[\p{L}']+/gu) || [];
  let portugueseScore = /[áàâãéêíóôõúç]/i.test(text) ? 3 : 0;
  let englishScore = 0;

  for (const word of words) {
    if (PORTUGUESE_MARKERS.has(word)) portugueseScore += 1;
    if (ENGLISH_MARKERS.has(word)) englishScore += 1;
  }

  if (portugueseScore > englishScore) return "pt";
  if (englishScore > portugueseScore) return "en";
  return fallback;
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
  studentLanguage?: SpeechLanguage;
  transcriptionConfidence?: number | null;
  transcriptionAlternatives?: string[];
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
  onClose,
}) => {
  // --- Core State ---
  const [state, setState] = useState<CallState>("IDLE");
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [turnCount, setTurnCount] = useState(0);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [pendingTranscriptReview, setPendingTranscriptReview] = useState<
    PendingTranscriptReview | null
  >(null);
  const [isDisputingCorrection, setIsDisputingCorrection] = useState(false);

  // --- UI State ---
  const [topic, setTopic] = useState<string>(initialTopic || "");
  const [hasSelectedTopic, setHasSelectedTopic] = useState(!!initialTopic);
  const [context, setContext] = useState<string>("");
  const [translationEnabled, setTranslationEnabled] = useState(true);
  const [autoSpeakEnabled, setAutoSpeakEnabled] = useState(true);
  const [showTextInput, setShowTextInput] = useState(!voiceMode);
  const [showTranscript, setShowTranscript] = useState(false);
  const [restartNonce, setRestartNonce] = useState(0);
  const [isRestarting, setIsRestarting] = useState(false);
  const [audioGestureReady, setAudioGestureReady] = useState(
    () => !IS_IOS || !voiceMode,
  );
  const [voiceTransport, setVoiceTransport] = useState<VoiceTransport>(
    () => voiceMode && WOLFIE_REALTIME_ENABLED ? "realtime" : "text",
  );
  const [recognitionLanguage, setRecognitionLanguage] = useState<
    RecognitionLanguage
  >(() => defaultRecognitionLanguage());

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
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);

  // --- Refs ---
  const recognitionRef = useRef<any>(null); // Web Speech API recognition
  const recognitionLanguageRef = useRef<RecognitionLanguage>(
    defaultRecognitionLanguage(),
  );
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
  const lastSpokenLanguageRef = useRef<SpeechLanguage>("en");
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
  const [audioStream, setAudioStream] = useState<MediaStream | null>(null); // energia visual do mascote
  const [inputLevel, setInputLevel] = useState(0);
  const [outputLevel, setOutputLevel] = useState(0);

  const studentLevel = user.levelBadge || "A1";
  const isRealtimeMode = voiceTransport === "realtime";

  const handleRealtimeTurnComplete = useCallback(
    (turn: WolfieRealtimeCompletedTurn) => {
      if (realtimeTurnIdsRef.current.has(turn.id)) return;
      realtimeTurnIdsRef.current.add(turn.id);

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
      setTurnCount((current) => current + 1);
      setAssistantLanguage(
        detectSpeechLanguage(turn.assistantTranscript, "en"),
      );

      if (
        turn.inputMethod === "audio_transcription" &&
        shouldConfirmVoiceTranscript({
          transcript: turn.userTranscript,
          alternatives: [],
          confidence: turn.asrConfidence,
        })
      ) {
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

      // Serializa a persistência para que o primeiro turno crie uma única
      // sessão e os seguintes reutilizem o mesmo conversationId.
      realtimePersistenceRef.current = realtimePersistenceRef.current
        .catch(() => undefined)
        .then(async () => {
          const { data, error: persistenceError } = await supabase.functions
            .invoke("wolfie-brain", {
              body: {
                action: "record_realtime_turn",
                conversationId: realtimeConversationIdRef.current,
                clientTurnId: turn.id,
                userTranscript: turn.userTranscript,
                assistantTranscript: turn.assistantTranscript,
                inputMethod: turn.inputMethod,
                asrConfidence: turn.asrConfidence,
                transcriptIsRoughGuide: true,
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
              },
            });

          const payload = asRecord(data);
          const nextConversationId = firstString(
            payload,
            "conversationId",
            "conversation_id",
          );
          if (nextConversationId) {
            realtimeConversationIdRef.current = nextConversationId;
            if (isMountedRef.current) setConversationId(nextConversationId);
          }

          if (persistenceError || payload.error) {
            throw new Error(
              firstString(payload, "error") ||
                persistenceError?.message ||
                "REALTIME_TURN_PERSISTENCE_FAILED",
            );
          }
        })
        .catch((persistenceError) => {
          console.error(
            "[WolfieTutor] Falha ao salvar turno em tempo real:",
            persistenceError,
          );
          if (!isMountedRef.current) return;
          setError(
            "A conversa continua, mas este turno não pôde ser salvo no histórico.",
          );
          window.setTimeout(() => {
            if (isMountedRef.current) setError(null);
          }, 5000);
        });
    },
    [
      correctionMode,
      difficulty,
      experienceAudiences,
      experienceId,
      experienceMode,
      experienceUniverse,
      languageMode,
      scenario,
      studentGoal,
      studentLevel,
      targetSkill,
      topic,
    ],
  );

  const handleRealtimeFallback = useCallback(
    (_reason: string, message: string) => {
      setVoiceTransport("classic");
      setState("IDLE");
      setError(`${message} O Wolfie mudou para a voz clássica.`);
      window.setTimeout(() => {
        if (isMountedRef.current) setError(null);
      }, 6000);
    },
    [],
  );

  const realtime = useWolfieRealtime({
    enabled: WOLFIE_REALTIME_ENABLED && isRealtimeMode,
    topic,
    goal: studentGoal || targetSkill || "Praticar inglês com naturalidade",
    language: "auto",
    ragQuery: [topic, studentGoal, targetSkill].filter(Boolean).join("\n"),
    onFallback: handleRealtimeFallback,
    onTurnComplete: handleRealtimeTurnComplete,
  });

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
      if (!clientTurnId) return;

      setPendingTranscriptReview(null);
      realtime.setMuted(false);
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

        if (!isMountedRef.current) return;
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
        if (!isMountedRef.current) return;
        setSubtitle("");
        setError(
          "A conversa continua, mas a informação confirmada não pôde ser salva.",
        );
        window.setTimeout(() => {
          if (isMountedRef.current) setError(null);
        }, 5000);
      }
    },
    [
      correctionMode,
      difficulty,
      experienceAudiences,
      experienceId,
      experienceMode,
      experienceUniverse,
      languageMode,
      realtime.setMuted,
      scenario,
      studentGoal,
      studentLevel,
      targetSkill,
      topic,
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

  const ensureAudioStream = useCallback(() => {
    if (
      typeof navigator === "undefined" ||
      audioStreamRef.current ||
      audioStreamRequestRef.current
    ) {
      return;
    }

    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.getUserMedia) {
      console.warn("Mascot audio stream unavailable (avatar ficará estático)");
      return;
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
    void request
      .then((stream) => {
        if (
          !isMountedRef.current ||
          requestVersion !== audioStreamRequestVersionRef.current
        ) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        audioStreamRef.current = stream;
        setAudioStream(stream);
      })
      .catch((err) => {
        console.warn("Mascot audio stream denied (avatar ficará estático):", err);
      })
      .finally(() => {
        if (audioStreamRequestRef.current === request) {
          audioStreamRequestRef.current = null;
        }
      });
  }, []);

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
        realtime.disconnect();
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

      // ── Inglês — ordem de preferência por qualidade ──
      // Prioridade 1: vozes Online/Natural/Neural (Microsoft) — soam humanas no Chrome/Edge
      // Prioridade 2: vozes Enhanced/Premium (macOS Safari/Chrome)
      // Prioridade 3: Google US English (servidor Google, boa qualidade)
      // Prioridade 4: vozes offline decentes
      const pickBestEnglish = (
        list: SpeechSynthesisVoice[],
      ): SpeechSynthesisVoice | null => {
        const allEnglish = list.filter((v) => v.lang.startsWith("en"));
        const americanEnglish = allEnglish.filter((v) =>
          v.lang.toLowerCase().startsWith("en-us")
        );
        const en = americanEnglish.length > 0 ? americanEnglish : allEnglish;

        // Tier 1 — Microsoft Neural Online (Windows Chrome/Edge)
        const msNatural = en.find((v) =>
          v.name.includes("Online") || v.name.includes("Natural") ||
          v.name.includes("Neural") || v.name.includes("Aria") ||
          v.name.includes("Jenny") || v.name.includes("Ana") ||
          v.name.includes("Guy")
        );
        if (msNatural) return msNatural;

        // Tier 2 — macOS Enhanced/Premium
        const macEnhanced = en.find((v) =>
          v.name.includes("Enhanced") || v.name.includes("Premium") ||
          v.name.includes("Samantha") || v.name.includes("Serena") ||
          v.name.includes("Karen") || v.name.includes("Daniel") ||
          v.name.includes("Moira") || v.name.includes("Tessa")
        );
        if (macEnhanced) return macEnhanced;

        // Tier 3 — Google TTS online
        const google = en.find((v) =>
          v.name.startsWith("Google") && v.lang.startsWith("en")
        );
        if (google) return google;

        // Tier 4 — qualquer en-US
        return en.find((v) => v.lang === "en-US") || en[0] || null;
      };

      const enVoice = pickBestEnglish(voices);
      if (enVoice) {
        englishVoiceRef.current = enVoice;
      }

      // ── Português BR ──
      const ptBrVoices = voices.filter((v) =>
        v.lang.toLowerCase().startsWith("pt-br")
      );
      const portugueseVoices = ptBrVoices.length > 0
        ? ptBrVoices
        : voices.filter((v) => v.lang.toLowerCase().startsWith("pt"));
      const preferredPt = [
        "Luciana",
        "Felipe",
        "Google português do Brasil",
        "Google português",
        "pt-BR",
      ];
      let ptVoice: SpeechSynthesisVoice | null = null;
      for (const name of preferredPt) {
        ptVoice = portugueseVoices.find((v) =>
          v.name.includes(name) || v.lang === name
        ) || null;
        if (ptVoice) {
          break;
        }
      }
      if (!ptVoice) ptVoice = portugueseVoices[0] || null;
      if (ptVoice) {
        ptBrVoiceRef.current = ptVoice;
      }
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
      isProcessingRef.current = false;
      stopSpeaking();
      stopIOSKeepAlive();
      if (recordingDelayRef.current) {
        clearTimeout(recordingDelayRef.current);
        recordingDelayRef.current = null;
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

  useEffect(() => {
    const nextLanguage = defaultRecognitionLanguage();
    recognitionLanguageRef.current = nextLanguage;
    setRecognitionLanguage(nextLanguage);
  }, [languageMode]);

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
            "id, topic, started_at, last_activity_at, scenario_status, finished_at, student_level, experience_mode, correction_mode, language_mode, difficulty, scenario_context, student_goal, target_skill, current_stage",
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

        if (cancelled) return;
        const turns = [...(recentTurns ?? [])].reverse();
        setConversationId(lastSession.id);
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
          setTurnCount(Math.floor(turns.length / 2));
          if (lastSession.topic && !initialTopic) {
            setTopic(lastSession.topic);
            setHasSelectedTopic(true);
          }
        }

        if (lastSession.scenario_status === "awaiting_retry") {
          const latestWolfieTurn = [...turns]
            .reverse()
            .find((turn: any) => turn.speaker !== "student");
          const retryPayload = asRecord(
            latestWolfieTurn?.structured_payload,
          );
          const retryCorrections = normalizeCorrections(retryPayload);
          const retryCorrection = retryCorrections[0] ?? null;
          const retryText = latestWolfieTurn?.content || "";

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

  /** Prepara texto para soar natural no TTS — remove markdown e adiciona pausas */
  const prepareForTTS = (raw: string): string =>
    raw
      .replace(/\*\*(.*?)\*\*/g, "$1") // bold → texto puro
      .replace(/\*(.*?)\*/g, "$1") // itálico → texto puro
      .replace(/`(.*?)`/g, "$1") // code → texto puro
      .replace(/#{1,6}\s+/g, "") // headings
      .replace(/\[(.*?)\]\(.*?\)/g, "$1") // links → só o label
      .replace(/---+/g, ".") // separadores → ponto
      .replace(/\n{2,}/g, ", ") // parágrafos → pausa curta
      .replace(/\n/g, " ") // linha única → espaço
      .replace(/([a-z])([A-Z])/g, "$1 $2") // camelCase → palavras separadas
      .replace(/\s{2,}/g, " ") // espaços duplos
      .trim();

  /**
   * Fallback: Web Speech API (local, sem qualidade neural)
   * Usado quando o edge function wolfie-tts falha.
   */
  const speakWebSpeech = useCallback((
    text: string,
    speed?: number,
    forceLang?: "en" | "pt",
    requestVersion = ttsRequestVersionRef.current,
  ) => {
    const isCurrent = () => requestVersion === ttsRequestVersionRef.current;
    if (!isCurrent()) return;
    const lang = forceLang ?? "en"; // sempre inglês por padrão
    const clean = prepareForTTS(text);
    const sentences = clean.match(/[^.!?]+[.!?]+/g) || [clean];

    let idx = 0;
    const speakNext = () => {
      if (!isCurrent()) return;
      if (idx >= sentences.length) {
        setState("IDLE");
        setSubtitle("");
        return;
      }
      const sentence = sentences[idx++].trim();
      if (!sentence) {
        speakNext();
        return;
      }

      const utterance = new SpeechSynthesisUtterance(sentence);

      if (lang === "pt") {
        if (ptBrVoiceRef.current) {
          utterance.voice = ptBrVoiceRef.current;
        }
        utterance.lang = "pt-BR";
        utterance.rate = speed ?? 1.0;
        utterance.pitch = 1.05;
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
    async (text: string, speed?: number, forceLang?: "en" | "pt") => {
      const requestVersion = ++ttsRequestVersionRef.current;
      const isCurrent = () => requestVersion === ttsRequestVersionRef.current;
      setState("SYNTHESIZING");
      setSubtitle(text);
      lastSpokenTextRef.current = text;

      const lang = forceLang ?? "en";
      lastSpokenLanguageRef.current = lang;
      const voice = lang === "pt" ? "pt-BR-ThalitaNeural" : "en-US-JennyNeural";
      const rate = speed ?? (lang === "pt" ? 1.0 : getTTSSpeed(studentLevel));

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
        const { data, error: fnError } = await supabase.functions.invoke(
          "wolfie-tts",
          {
            body: { text, voice, speed: rate },
          },
        );

        if (!isCurrent()) return;
        if (fnError || !data?.audio) {
          throw new Error(fnError?.message || "wolfie-tts sem áudio");
        }

        // Decodifica base64 → ArrayBuffer
        const rawBase64 = data.audio; // guardamos para data URI fallback
        const binary = atob(rawBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

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
          speakWebSpeech(text, rate, lang, requestVersion);
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
            speakWebSpeech(text, rate, lang, requestVersion);
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
            speakWebSpeech(text, rate, lang, requestVersion);
            return;
          }
        }
      } catch (err: any) {
        if (!isCurrent()) return;
        const errMsg = err?.message ?? String(err);
        console.warn("[WolfieTutor] wolfie-tts erro:", errMsg);
        stopIOSKeepAlive();
        speakWebSpeech(text, speed, lang, requestVersion);
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
      );
    }
  };

  const startRealtimeConversation = async () => {
    if (!isRealtimeMode) return;
    unlockAudio();
    setAudioGestureReady(true);
    setError(null);

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
    realtime.disconnect();
    setVoiceTransport("classic");
    setState("IDLE");
    setSubtitle("");
    setError(null);
  };

  const useRealtimeVoice = () => {
    abortRecognition();
    stopSpeaking();
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
      studentLanguage: review.studentLanguage,
      transcriptionConfidence: review.confidence,
      transcriptionAlternatives: review.alternatives,
      transcriptConfirmed,
    });
  };

  // ============================================================
  // VOICE INPUT — Web Speech API (hold to speak, bilingual PT+EN)
  // ============================================================
  const startRecording = () => {
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

    // Solicita o microfone somente dentro do gesto explícito do aluno.
    ensureAudioStream();

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
    setCorrection(null);
    setTranslation(null);
    setVocabulary(null);
    setQuiz(null);
    setError(null);

    const SpeechRec = (window as any).webkitSpeechRecognition ||
      (window as any).SpeechRecognition;
    if (!SpeechRec) {
      releaseAudioStream();
      stopIOSKeepAlive();
      setError("Reconhecimento de voz não suportado. Use o campo de texto.");
      setTimeout(() => setError(null), 5000);
      setShowTextInput(true);
      return;
    }

    // Aguarda 400ms para o speaker parar fisicamente antes de ligar o mic
    recordingDelayRef.current = setTimeout(() => {
      recordingDelayRef.current = null;
      if (recognitionRef.current) {
        recognitionRef.current.onresult = null;
        recognitionRef.current.onerror = null;
        recognitionRef.current.onend = null;
        try {
          recognitionRef.current.abort();
        } catch (_) {}
        recognitionRef.current = null;
      }

      finalTranscriptRef.current = "";
      transcriptAlternativesRef.current = [];
      transcriptConfidenceRef.current = null;

      const recognition = new SpeechRec();
      const captureLanguage = recognitionLanguageRef.current;
      // Um único modelo acústico por tentativa evita mutilar o outro idioma.
      recognition.lang = captureLanguage;
      // continuous = true: NÃO corta enquanto o usuário segura o mascote
      recognition.continuous = true;
      // interimResults = true: mostra legenda em tempo real enquanto fala
      recognition.interimResults = true;
      recognition.maxAlternatives = 5;
      recognitionRef.current = recognition;

      recognition.onresult = (event: any) => {
        // Acumula todo texto final + exibe interim como legenda ao vivo
        let finalText = "";
        let interimText = "";
        const finalResults: any[] = [];
        for (let i = 0; i < event.results.length; i++) {
          if (event.results[i].isFinal) {
            finalText += event.results[i][0].transcript + " ";
            finalResults.push(event.results[i]);
          } else {
            interimText += event.results[i][0].transcript;
          }
        }
        finalTranscriptRef.current = finalText.trim();

        if (finalResults.length > 0) {
          const candidateCount = Math.min(
            5,
            Math.max(...finalResults.map((result) => result.length || 1)),
          );
          const alternatives: string[] = [];
          for (let rank = 0; rank < candidateCount; rank++) {
            const candidate = finalResults
              .map((result) =>
                (result[Math.min(rank, result.length - 1)]?.transcript || "")
                  .trim()
              )
              .filter(Boolean)
              .join(" ")
              .trim();
            if (candidate) alternatives.push(candidate);
          }
          transcriptAlternativesRef.current = uniqueTranscriptAlternatives(
            finalTranscriptRef.current,
            alternatives,
          );

          const confidenceValues = finalResults
            .map((result) => result[0]?.confidence)
            .filter((value): value is number =>
              typeof value === "number" && Number.isFinite(value) && value > 0
            );
          transcriptConfidenceRef.current = confidenceValues.length
            ? confidenceValues.reduce((sum, value) => sum + value, 0) /
              confidenceValues.length
            : null;
        }
        // Mostra o que já reconheceu como legenda (feedback visual ao vivo)
        setSubtitle(interimText || finalText.trim());
      };

      recognition.onerror = (event: any) => {
        releaseAudioStream();
        recognitionRef.current = null;
        stopIOSKeepAlive();
        // 'aborted' é silencioso (usuário soltou antes do delay)
        if (event.error !== "aborted") {
          const msgs: Record<string, string> = {
            "no-speech": "Não ouvi nada — segure e fale mais perto",
            "audio-capture": "Microfone não encontrado",
            "not-allowed": "Permissão do microfone negada",
            "network": "Erro de rede no reconhecimento de voz",
          };
          const msg = msgs[event.error] ?? `Erro: ${event.error}`;
          if (msg) {
            setError(msg);
            setTimeout(() => setError(null), 4000);
          }
        }
        setState("IDLE");
        setSubtitle("");
      };

      recognition.onend = () => {
        // Chamado quando stop() é acionado pelo mouseup/touchend
        const transcript = finalTranscriptRef.current.trim();
        releaseAudioStream();
        recognitionRef.current = null;
        setSubtitle("");

        if (!transcript) {
          stopIOSKeepAlive();
          setState("IDLE");
          if (!isProcessingRef.current) {
            setError("Não ouvi nada — segure o mascote e fale");
            setTimeout(() => setError(null), 3000);
          }
          return;
        }

        if (isProcessingRef.current) {
          console.warn("🎤 Resultado ignorado — já processando outro");
          setState("IDLE");
          return;
        }

        const review: PendingTranscriptReview = {
          transcript,
          alternatives: transcriptAlternativesRef.current,
          confidence: transcriptConfidenceRef.current,
          studentLanguage: captureLanguage === "pt-BR" ? "pt" : "en",
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
      } catch (_) {
        recognitionRef.current = null;
        releaseAudioStream();
        stopIOSKeepAlive();
        setState("IDLE");
        setError("Não foi possível iniciar o microfone. Tente novamente.");
        setTimeout(() => setError(null), 4000);
      }
    }, 400);
  };

  const stopRecordingAndSend = () => {
    if (recordingDelayRef.current) {
      clearTimeout(recordingDelayRef.current);
      recordingDelayRef.current = null;
      releaseAudioStream();
      stopIOSKeepAlive();
      setState("IDLE");
      return;
    }
    if (!recognitionRef.current) {
      releaseAudioStream();
      stopIOSKeepAlive();
      return;
    }
    // iOS: re-bloqueia AudioContext no touchEnd — momento mais próximo do speak()
    // Isso garante que o AudioContext permanece "running" durante o fetch assíncrono
    if (IS_IOS) unlockAudio();
    // stop() termina a sessão → dispara onend com o transcript acumulado
    recognitionRef.current?.stop();
  };

  const sendMessage = async (text: string) => {
    if (!text.trim()) return;
    unlockAudio(); // desbloqueia AudioContext no iOS para o texto também

    if (isRealtimeMode) {
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
    setCorrection(null);
    setTranslation(null);
    setVocabulary(null);
    setQuiz(null);

    // Add user message to chat
    const newUserMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, newUserMsg]);

    await sendToWolfieBrain({ message: text });
  };

  const sendToWolfieBrain = async (input: WolfieBrainInput) => {
    if (isProcessingRef.current) {
      console.warn("[Wolfie] sendToWolfieBrain ignorado — já está processando");
      return;
    }
    isProcessingRef.current = true;
    const requestVersion = ++requestVersionRef.current;

    // ── Detecta idioma do input para resposta bilíngue ──
    // Se o aluno falou PT → Wolfie responde em PT (FranciscaNeural)
    // Se falou EN → Wolfie responde em EN (JennyNeural)
    const studentLang: SpeechLanguage = input.studentLanguage ??
      detectSpeechLanguage(input.message || "", "en");

    try {
      const history = messages.slice(-6).map((m) =>
        `${m.role === "user" ? "Student" : "Wolfie"}: ${m.content}`
      ).join("\n");
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

      const { data, error: supabaseError } = await supabase.functions.invoke(
        "wolfie-brain",
        {
          body: {
            ...input,
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
            // Quando aluno fala PT, desativa tradução (já está em PT)
            translationEnabled: studentLang === "pt"
              ? false
              : translationEnabled,
            vocabularyEnabled: true,
            mode,
            correctionStrictness:
              mode === "exam_prep" || mode === "grammar_focus" ? 3 : 1,
            allowPortuguese: true,
            turnCount,
            conversationId,
            studentLanguage: studentLang, // PT ou EN — Wolfie responde no mesmo idioma
          },
        },
      );

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
      const nextCorrections = normalizeCorrections(responsePayload);
      const nextCorrection = nextCorrections[0] ?? null;
      const nextTranslation = firstString(responsePayload, "translation") ||
        null;
      const nextCurrentStage = firstString(
        responsePayload,
        "currentStage",
        "current_stage",
        "stage",
      );
      const nextStrengths = firstStringArray(
        responsePayload,
        "studentStrengths",
        "student_strengths",
        "strengths",
      );
      const nextPriorities = firstStringArray(
        responsePayload,
        "studentPriorities",
        "student_priorities",
        "priorities",
      );
      const nextAction = firstString(
        responsePayload,
        "nextAction",
        "next_action",
      );
      const needsExternalVerification = firstBoolean(
        responsePayload,
        "needsExternalVerification",
        "needs_external_verification",
      );
      const verificationReason = firstString(
        responsePayload,
        "verificationReason",
        "verification_reason",
      );
      const sessionScore = firstNumber(
        responsePayload,
        "sessionScore",
        "session_score",
      );
      const retryRequired = firstBoolean(
        responsePayload,
        "retryRequired",
        "retry_required",
        "requiresRetry",
        "requires_retry",
      ) ||
        nextCorrections.some((item) => item.retryRequired);

      const aiMessage: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: chatText,
        timestamp: new Date(),
        correction: nextCorrection,
        translation: nextTranslation,
        vocabulary: responsePayload.vocabulary as VocabData || null,
        quiz: responsePayload.quiz as QuizData || null,
      };

      setMessages((prev) => [...prev, aiMessage]);
      setTurnCount((prev) => prev + 1);
      const nextConversationId = firstString(
        responsePayload,
        "conversationId",
        "conversation_id",
      );
      if (nextConversationId) setConversationId(nextConversationId);

      setCorrection(nextCorrection);
      setTranslation(nextTranslation);
      setAssistantLanguage(responseLang);
      const nextVocabulary = responsePayload.vocabulary as
        | VocabData
        | undefined;
      setVocabulary(nextVocabulary?.keyTerms?.length ? nextVocabulary : null);
      setQuiz(responsePayload.quiz as QuizData || null);
      setTurnGuidance({
        currentStage: nextCurrentStage,
        strengths: nextStrengths,
        priorities: nextPriorities,
        nextAction,
        needsExternalVerification,
        verificationReason,
        retryRequired,
        sessionScore,
      });

      // O backend informa explicitamente o idioma desta fala. A heurística
      // acima existe apenas para compatibilidade durante a implantação.
      if (autoSpeakEnabled && chatText) {
        void speak(chatText, undefined, responseLang);
      } else {
        setState("IDLE");
      }
    } catch (err: any) {
      if (requestVersion !== requestVersionRef.current) return;
      console.error("Wolfie Brain Error:", err);
      setError(err.message || "Erro de conexão");
      setState("IDLE");
      setTimeout(() => setError(null), 5000);
    } finally {
      // Libera o lock sempre — seja sucesso ou erro
      if (requestVersion === requestVersionRef.current) {
        isProcessingRef.current = false;
      }
    }
  };

  // Auto-start first turn when mode is selected
  useEffect(() => {
    if (
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
    isRealtimeMode,
    messages.length,
    restartNonce,
  ]);

  const invalidatePendingRequest = () => {
    requestVersionRef.current += 1;
    isProcessingRef.current = false;
  };

  const abortRecognition = () => {
    if (recordingDelayRef.current) {
      clearTimeout(recordingDelayRef.current);
      recordingDelayRef.current = null;
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
    realtime.disconnect();
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
      if (conversationId) {
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
    const sessionToAbandon = conversationId;

    invalidatePendingRequest();
    realtime.disconnect();
    stopSpeaking();
    abortRecognition();
    setError(null);
    setIsRestarting(true);

    try {
      // A sessão precisa ser encerrada no servidor antes de o ID local ser
      // removido; caso contrário, um reload retomaria a conversa antiga.
      if (sessionToAbandon) {
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
      setMessages([]);
      setConversationId(null);
      realtimeConversationIdRef.current = null;
      realtimeTurnIdsRef.current.clear();
      setTurnCount(0);
      setCorrection(null);
      setTranslation(null);
      setVocabulary(null);
      setQuiz(null);
      setTurnGuidance(EMPTY_TURN_GUIDANCE);
      setPendingTranscriptReview(null);
      setSubtitle("");
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
    : realtime.userTranscript || realtime.lastUserTranscript;
  const displaySubtitle = isRealtimeMode ? realtimeSubtitle : subtitle;
  const avatarInputLevel = isRealtimeMode
    ? realtime.localAudioLevel
    : inputLevel;
  const avatarOutputLevel = isRealtimeMode
    ? realtime.remoteAudioLevel
    : outputLevel;

  const getStatusLabel = () => {
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
        return "Pronto para Ouvir";
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

  const handleModeSelection = (mode: "voice" | "text") => {
    // Desbloqueia AudioContext no iOS — esse clique é o primeiro gesto do usuário
    unlockAudio();
    setAudioGestureReady(true);

    setTopic("Conversa Livre");
    setContext("");
    setShowTextInput(mode === "text");
    setVoiceTransport(
      mode === "voice"
        ? WOLFIE_REALTIME_ENABLED
          ? "realtime"
          : "classic"
        : "text",
    );
    setHasSelectedTopic(true);

    // Se escolheu voz, podemos até já acionar o áudio, ou deixar ele apertar.
    // O aluno pode pressionar o mascote; o prompt visual explica a interação.
  };

  const normalizedStage = turnGuidance.currentStage.trim().toLowerCase();
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

          <div className="grid grid-cols-2 gap-4 sm:gap-6 w-full max-w-2xl mx-auto">
            {/* Voice Mode */}
            <button
              onClick={() => handleModeSelection("voice")}
              className="group relative p-5 sm:p-8 rounded-2xl sm:rounded-3xl bg-slate-900/80 backdrop-blur-xl border border-slate-700/80 hover:bg-slate-800/90 active:scale-95 transition-all duration-300 overflow-hidden flex flex-col items-center text-center"
            >
              <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/20 to-purple-500/0 opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
              <div className="w-14 h-14 sm:w-20 sm:h-20 rounded-full bg-indigo-500/20 flex items-center justify-center mb-3 sm:mb-6 group-hover:scale-110 group-hover:bg-indigo-500 transition-all duration-300">
                <Mic
                  size={24}
                  className="sm:w-8 sm:h-8 text-indigo-400 group-hover:text-white transition-colors"
                />
              </div>
              <h3 className="text-base sm:text-2xl font-bold text-white mb-1 sm:mb-3">
                Por Voz
              </h3>
              <p className="text-slate-400 text-xs sm:text-sm hidden sm:block">
                Pratique com conversas em tempo real usando o microfone.
              </p>
            </button>

            {/* Text Mode */}
            <button
              onClick={() => handleModeSelection("text")}
              className="group relative p-5 sm:p-8 rounded-2xl sm:rounded-3xl bg-slate-900/80 backdrop-blur-xl border border-slate-700/80 hover:bg-slate-800/90 active:scale-95 transition-all duration-300 overflow-hidden flex flex-col items-center text-center"
            >
              <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/20 to-teal-500/0 opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
              <div className="w-14 h-14 sm:w-20 sm:h-20 rounded-full bg-emerald-500/20 flex items-center justify-center mb-3 sm:mb-6 group-hover:scale-110 group-hover:bg-emerald-500 transition-all duration-300">
                <MessageSquare
                  size={24}
                  className="sm:w-8 sm:h-8 text-emerald-400 group-hover:text-white transition-colors"
                />
              </div>
              <h3 className="text-base sm:text-2xl font-bold text-white mb-1 sm:mb-3">
                Por Texto
              </h3>
              <p className="text-slate-400 text-xs sm:text-sm hidden sm:block">
                Pratique a escrita através do chat interativo do Wolfie.
              </p>
            </button>
          </div>
        </div>
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
          {WOLFIE_REALTIME_ENABLED && (
            <button
              type="button"
              onClick={isRealtimeMode ? useClassicVoice : useRealtimeVoice}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-wider transition ${
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
          {/* Idioma do reconhecimento — cada tentativa usa um único modelo acústico */}
          {!isRealtimeMode && (
            <button
              type="button"
              onClick={() =>
                setRecognitionLanguage((current) => {
                  const next = current === "en-US" ? "pt-BR" : "en-US";
                  recognitionLanguageRef.current = next;
                  return next;
                })}
              disabled={state === "LISTENING" || state === "THINKING"}
              className="inline-flex items-center gap-1.5 rounded-full border border-violet-500/30 bg-violet-500/15 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-violet-200 transition hover:bg-violet-500/25 disabled:cursor-not-allowed disabled:opacity-40"
              title={recognitionLanguage === "en-US"
                ? "Microfone ouvindo inglês americano. Clique para mudar para português do Brasil."
                : "Microfone ouvindo português do Brasil. Clique para mudar para inglês americano."}
              aria-label={recognitionLanguage === "en-US"
                ? "Idioma do microfone: inglês americano"
                : "Idioma do microfone: português do Brasil"}
            >
              <Mic size={11} aria-hidden="true" />
              MIC {recognitionLanguage === "en-US" ? "EN" : "PT"}
            </button>
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
          {!isRealtimeMode && (
            <button
              onClick={() => {
                setAutoSpeakEnabled((p) => !p);
                if (state === "SPEAKING") stopSpeaking();
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
          <button
            onClick={() => setShowTextInput((p) => !p)}
            className={`p-1.5 rounded-full border transition-all ${
              showTextInput
                ? "bg-amber-500/15 border-amber-500/30 text-amber-300"
                : "bg-white/5 border-white/10 text-slate-400"
            }`}
            title={showTextInput ? "Teclado ON" : "Teclado OFF"}
          >
            <MessageSquare size={12} />
          </button>
          {/* Slow Replay */}
          {!isRealtimeMode && (
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
            {isRealtimeMode
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
                  realtime.setMuted(false);
                }
                setPendingTranscriptReview(null);
                setSubtitle("");
                setState("IDLE");
              }}
            />
          </div>
        )}
        <div
          className={`relative w-[260px] h-[260px] sm:w-[320px] sm:h-[320px] md:w-[500px] md:h-[500px] cursor-pointer touch-none select-none flex items-center justify-center group transition ${
            pendingTranscriptReview ? "pointer-events-none opacity-25 blur-sm" : ""
          }`}
          style={{
            WebkitUserSelect: "none",
            WebkitTouchCallout: "none",
          } as React.CSSProperties}
          role="button"
          tabIndex={pendingTranscriptReview ? -1 : 0}
          aria-label={isRealtimeMode
            ? realtime.connected
              ? "Wolfie ao vivo. Toque para pausar ou interromper."
              : "Toque no Wolfie para iniciar a conversa ao vivo"
            : "Pressione e segure o mascote para falar com o Wolfie"}
          onClick={isRealtimeMode
            ? () => void startRealtimeConversation()
            : undefined}
          onMouseDown={isRealtimeMode ? undefined : startRecording}
          onMouseUp={isRealtimeMode ? undefined : stopRecordingAndSend}
          onMouseLeave={isRealtimeMode
            ? undefined
            : () => state === "LISTENING" && stopRecordingAndSend()}
          onTouchStart={isRealtimeMode
            ? undefined
            : (e) => {
              e.preventDefault();
              startRecording();
            }}
          onTouchEnd={isRealtimeMode
            ? undefined
            : (e) => {
              e.preventDefault();
              stopRecordingAndSend();
            }}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            if (isRealtimeMode) {
              event.preventDefault();
              if (!event.repeat) void startRealtimeConversation();
            } else if (state === "IDLE") {
              event.preventDefault();
              startRecording();
            }
          }}
          onKeyUp={(event) => {
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
                {isRealtimeMode
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
                (isRealtimeMode && !realtime.connected)}
              className="flex-1 min-w-0 bg-transparent border-none text-slate-200 placeholder:text-slate-500 focus:ring-0 focus:outline-none text-sm font-medium"
            />
            <button
              onClick={() => sendMessage(inputText)}
              disabled={!inputText.trim() ||
                state === "THINKING" ||
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
                <button
                  onClick={() => {
                    void speak(translation, 1.0, translationLanguage);
                  }}
                  title={translationLanguage === "pt"
                    ? "Ouvir em português BR"
                    : "Ouvir em inglês americano"}
                  className="p-1 rounded-lg text-sky-400/60 hover:text-sky-300 hover:bg-sky-400/10 transition-colors"
                >
                  <Volume2 size={12} />
                </button>
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
