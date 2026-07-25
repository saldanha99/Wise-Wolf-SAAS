import { supabase } from '../../lib/supabase';
import type {
  ActivityModality,
  ActivityPhase,
  AnswerFeedback,
  CefrLevel,
  MemorizationState,
  QuizResult,
  SpeechEvaluationResult,
  TextEvaluationResult,
  WolfieActivitySession,
  WolfieOverview,
  WolfieSubject,
} from '../components/wolfie/types';

const FUNCTION_NAME = 'wolfie-activity';

const ERROR_MESSAGES: Record<string, string> = {
  AUTH_REQUIRED: 'Sua sessão expirou. Entre novamente para continuar.',
  STUDENT_PROFILE_REQUIRED:
    'Não encontramos um perfil de aluno válido para esta conta.',
  PAYMENT_REQUIRED:
    'O acesso às atividades está temporariamente indisponível. Fale com a equipe Wise Wolf.',
  TOO_MANY_ACTIVITIES:
    'Você criou muitas atividades em pouco tempo. Respire um pouco e tente novamente em alguns minutos.',
  TOO_MANY_EVALUATIONS:
    'Você praticou bastante em pouco tempo. Aguarde alguns minutos antes de pedir uma nova correção.',
  TOO_MANY_AI_REQUESTS:
    'O Wolfie já processou muitas correções em pouco tempo. Aguarde alguns minutos e continue depois.',
  AI_REQUEST_IN_PROGRESS:
    'Esta atividade ainda está sendo preparada. Aguarde um instante e tente novamente.',
  AI_REQUEST_PREVIOUSLY_FAILED:
    'Esta tentativa não ficou pronta. Gere uma nova atividade para continuar.',
  AI_REQUEST_RESULT_UNAVAILABLE:
    'Não conseguimos recuperar o resultado desta tentativa. Comece uma nova prática.',
  AI_PROVIDER_UNAVAILABLE:
    'O Wolfie está se reorganizando. Tente gerar a atividade novamente em instantes.',
  ACTIVITY_GENERATION_FAILED:
    'Não foi possível montar esta atividade agora. Tente novamente.',
  SESSION_CREATE_FAILED:
    'Não conseguimos iniciar sua atividade. Tente novamente.',
  SESSION_NOT_FOUND:
    'Esta atividade não está mais disponível. Comece uma nova prática.',
  SESSION_NOT_IN_PROGRESS:
    'Esta tentativa já foi encerrada. Comece uma nova prática para continuar.',
  ANSWER_KEY_UNAVAILABLE:
    'O feedback desta pergunta está indisponível no momento. Tente novamente.',
  QUESTION_NOT_FOUND:
    'Esta pergunta não foi encontrada. Gere uma nova atividade.',
  INVALID_ANSWER:
    'Escolha uma alternativa válida para continuar.',
  INVALID_ANSWERS:
    'Responda todas as perguntas antes de finalizar.',
  QUIZ_NOT_FULLY_ANSWERED:
    'Confira todas as respostas antes de finalizar.',
  MEETING_SECTIONS_INCOMPLETE:
    'Conclua os seis blocos da reunião antes de avançar.',
  MEMORIZATION_REQUIRED:
    'Conclua ao menos uma rodada de memorização antes de readaptar o cenário.',
  INVALID_MEETING_STEP:
    'Esta etapa da reunião não está disponível. Volte ao início da prática.',
  RESPONSE_TOO_SHORT:
    'Escreva um pouco mais para o Wolfie conseguir fazer uma correção útil.',
  AUDIO_TOO_LARGE:
    'O áudio ficou muito longo. Grave uma versão de até dois minutos.',
  INVALID_AUDIO_SIZE:
    'A gravação ficou vazia ou grande demais. Grave novamente em até dois minutos.',
  AUDIO_CONTAINER_MISMATCH:
    'O formato real da gravação não corresponde ao informado pelo navegador. Tente novamente ou responda por texto.',
  UNSUPPORTED_AUDIO_TYPE:
    'Seu navegador gravou em um formato não compatível. Use a resposta por texto.',
  SPEECH_ANALYSIS_FAILED:
    'Não conseguimos analisar a gravação. Você pode tentar de novo ou responder por texto.',
  SPEECH_ANALYSIS_UNAVAILABLE:
    'A análise de fala está temporariamente indisponível. Tente novamente ou use texto.',
  SPEECH_ANALYSIS_INVALID:
    'O Wolfie não conseguiu interpretar essa gravação com segurança. Grave novamente em um lugar mais silencioso.',
  AI_EVALUATION_INVALID:
    'A correção não ficou confiável. Envie novamente para o Wolfie reavaliar.',
  LISTENING_AUDIO_UNAVAILABLE:
    'O áudio desta atividade não ficou pronto. Tente novamente.',
  LISTENING_AUDIO_NOT_AVAILABLE:
    'Esta atividade não possui um áudio de listening.',
  LISTENING_AUDIO_INVALID:
    'O áudio não ficou válido. Tente carregá-lo novamente.',
  ATTEMPT_SAVE_FAILED:
    'Não conseguimos salvar este feedback. Tente novamente.',
  ATTEMPT_LOOKUP_FAILED:
    'Não conseguimos recuperar sua resposta. Tente novamente.',
  STATE_SAVE_FAILED:
    'Não foi possível salvar sua memorização. Tente novamente.',
  OVERVIEW_UNAVAILABLE:
    'Seu repertório está temporariamente indisponível. Tente novamente.',
  BILLING_CHECK_UNAVAILABLE:
    'Não foi possível validar o acesso agora. Tente novamente em instantes.',
  WOLFIE_ACTIVITY_FAILED:
    'O Wolfie encontrou um imprevisto. Tente novamente.',
};

interface FunctionErrorLike extends Error {
  context?: Response;
}

export class WolfieActivityError extends Error {
  constructor(
    message: string,
    readonly code = 'WOLFIE_ACTIVITY_FAILED',
  ) {
    super(message);
    this.name = 'WolfieActivityError';
  }
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};

const readFunctionErrorCode = async (
  error: FunctionErrorLike,
): Promise<string> => {
  const response = error.context;
  if (response instanceof Response) {
    try {
      const payload = asRecord(await response.clone().json());
      const code = payload.code ?? payload.error;
      if (typeof code === 'string' && code) return code;
    } catch {
      // The SDK message below remains a useful fallback for non-JSON failures.
    }
  }
  return error.message || 'WOLFIE_ACTIVITY_FAILED';
};

async function invokeWolfie<T>(
  body: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await supabase.functions.invoke(FUNCTION_NAME, {
    body,
  });

  if (error) {
    const code = await readFunctionErrorCode(error as FunctionErrorLike);
    throw new WolfieActivityError(
      ERROR_MESSAGES[code] ?? ERROR_MESSAGES.WOLFIE_ACTIVITY_FAILED,
      code,
    );
  }

  if (!data || typeof data !== 'object') {
    throw new WolfieActivityError(
      'O Wolfie recebeu uma resposta inesperada. Tente novamente.',
      'INVALID_RESPONSE',
    );
  }

  const payload = data as Record<string, unknown>;
  if (typeof payload.error === 'string') {
    const code =
      typeof payload.code === 'string' ? payload.code : payload.error;
    throw new WolfieActivityError(
      ERROR_MESSAGES[code] ?? ERROR_MESSAGES.WOLFIE_ACTIVITY_FAILED,
      code,
    );
  }

  return data as T;
}

export const createWolfieRequestKey = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10).join(''),
  ].join('-');
};

export interface GenerateActivityInput {
  subject: WolfieSubject;
  level: CefrLevel;
  phase?: ActivityPhase;
  modality?: ActivityModality;
  sector?: string;
  sourceSessionId?: string;
  requestKey?: string;
}

export async function getWolfieOverview(): Promise<WolfieOverview> {
  const response = await invokeWolfie<{ overview: WolfieOverview }>({
    action: 'overview',
  });
  return response.overview;
}

export async function generateWolfieActivity(
  input: GenerateActivityInput,
): Promise<WolfieActivitySession> {
  const response = await invokeWolfie<{
    session: WolfieActivitySession;
    idempotent: boolean;
    source?: 'ai' | 'fallback' | 'test_fixture';
  }>({
    action: 'generate',
    subject: input.subject,
    level: input.level,
    phase:
      input.phase ??
      (input.subject === 'global_meetings' ? 'construction' : 'standard'),
    modality:
      input.modality ??
      (input.subject === 'global_meetings' ? 'mixed' : 'text'),
    sector: input.sector,
    sourceSessionId: input.sourceSessionId,
    requestKey: input.requestKey ?? createWolfieRequestKey(),
  });
  return response.session;
}

export async function checkWolfieAnswer(
  sessionId: string,
  questionId: string,
  selectedIndex: number,
  requestKey = createWolfieRequestKey(),
): Promise<AnswerFeedback> {
  const response = await invokeWolfie<{ result: AnswerFeedback }>({
    action: 'check_answer',
    sessionId,
    questionId,
    selectedIndex,
    requestKey,
  });
  return response.result;
}

export async function submitWolfieQuiz(
  sessionId: string,
  durationSeconds: number,
  requestKey = createWolfieRequestKey(),
): Promise<QuizResult> {
  const response = await invokeWolfie<{ result: QuizResult }>({
    action: 'submit',
    sessionId,
    requestKey,
    durationSeconds,
  });
  return response.result;
}

export interface SubmitTextInput {
  sessionId: string;
  text: string;
  durationSeconds: number;
  stepKey?: string;
  complete?: boolean;
  modality?: ActivityModality;
  requestKey?: string;
}

export async function submitWolfieText(
  input: SubmitTextInput,
): Promise<TextEvaluationResult> {
  const response = await invokeWolfie<{ result: TextEvaluationResult }>({
    action: 'submit',
    sessionId: input.sessionId,
    requestKey: input.requestKey ?? createWolfieRequestKey(),
    responses: { text: input.text },
    durationSeconds: input.durationSeconds,
    stepKey: input.stepKey,
    complete: input.complete ?? true,
    modality: input.modality ?? 'text',
  });
  return response.result;
}

export async function saveWolfieMemorization(
  sessionId: string,
  memorization: MemorizationState,
): Promise<Record<string, unknown>> {
  const response = await invokeWolfie<{
    learnerState: Record<string, unknown>;
  }>({
    action: 'save_state',
    sessionId,
    patch: { memorization },
  });
  return response.learnerState;
}

export interface AnalyzeSpeechInput {
  sessionId: string;
  audioBase64: string;
  mimeType: string;
  durationSeconds: number;
  stepKey?: string;
  complete?: boolean;
  requestKey?: string;
}

export async function analyzeWolfieSpeech(
  input: AnalyzeSpeechInput,
): Promise<SpeechEvaluationResult> {
  const response = await invokeWolfie<{ result: SpeechEvaluationResult }>({
    action: 'analyze_speech',
    sessionId: input.sessionId,
    requestKey: input.requestKey ?? createWolfieRequestKey(),
    audioBase64: input.audioBase64,
    mimeType: input.mimeType,
    durationSeconds: input.durationSeconds,
    stepKey: input.stepKey ?? 'speech',
    complete: input.complete ?? true,
  });
  return response.result;
}

export interface ListeningAudio {
  audioBase64: string;
  mimeType: 'audio/mpeg' | string;
}

const listeningAudioCache = new Map<string, Promise<ListeningAudio>>();

export function getWolfieListeningAudio(
  sessionId: string,
): Promise<ListeningAudio> {
  const cached = listeningAudioCache.get(sessionId);
  if (cached) return cached;

  const request = invokeWolfie<ListeningAudio>({
    action: 'listening_audio',
    sessionId,
  });
  listeningAudioCache.set(sessionId, request);
  void request.then(
    () => {
      if (listeningAudioCache.get(sessionId) === request) {
        listeningAudioCache.delete(sessionId);
      }
    },
    () => {
      if (listeningAudioCache.get(sessionId) === request) {
        listeningAudioCache.delete(sessionId);
      }
    },
  );
  return request;
}

export async function abandonWolfieActivity(
  sessionId: string,
): Promise<void> {
  await invokeWolfie<{ ok: boolean }>({
    action: 'abandon',
    sessionId,
  });
}
