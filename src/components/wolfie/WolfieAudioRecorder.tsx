import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Loader2,
  Mic,
  Send,
  Square,
  Trash2,
} from 'lucide-react';
import { createWolfieRequestKey } from '../../services/wolfieActivityService';
import {
  InlineError,
  primaryButton,
  secondaryButton,
} from './WolfieActivityUI';

// Keeps the Base64 payload below the Edge Function's 6.75 MB ceiling.
const MAX_AUDIO_BYTES = 4_900_000;
const MAX_DURATION_SECONDS = 120;

export interface RecordedAudioPayload {
  audioBase64: string;
  mimeType: string;
  durationSeconds: number;
  requestKey: string;
}

interface WolfieAudioRecorderProps {
  onAnalyze: (payload: RecordedAudioPayload) => Promise<void>;
  busy: boolean;
  /** Changes when the parent requires a genuinely new recording. */
  resetKey?: string | number;
}

const formatDuration = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
};

const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('AUDIO_READ_FAILED'));
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : '';
      const separator = value.indexOf(',');
      resolve(separator >= 0 ? value.slice(separator + 1) : value);
    };
    reader.readAsDataURL(blob);
  });

const chooseMimeType = (): string | undefined => {
  if (
    typeof MediaRecorder === 'undefined' ||
    typeof MediaRecorder.isTypeSupported !== 'function'
  ) {
    return undefined;
  }
  const preferred = [
    'audio/webm;codecs=opus',
    'audio/mp4',
    'audio/ogg;codecs=opus',
    'audio/webm',
  ];
  return preferred.find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
};

export function WolfieAudioRecorder({
  onAnalyze,
  busy,
  resetKey,
}: WolfieAudioRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState('');
  const [error, setError] = useState('');
  const audioUrlRef = useRef('');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const durationRef = useRef(0);
  const recordingRequestKeyRef = useRef('');

  const supported = useMemo(
    () =>
      typeof window !== 'undefined' &&
      window.isSecureContext &&
      typeof navigator.mediaDevices?.getUserMedia === 'function' &&
      typeof MediaRecorder !== 'undefined',
    [],
  );

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  const releaseAudioUrl = () => {
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = '';
    }
  };

  useEffect(() => {
    return () => {
      clearTimer();
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        recorder.stop();
      }
      stopTracks();
      releaseAudioUrl();
    };
  }, []);

  const discardRecording = () => {
    releaseAudioUrl();
    setAudioUrl('');
    setAudioBlob(null);
    setDuration(0);
    durationRef.current = 0;
    recordingRequestKeyRef.current = '';
    setError('');
  };

  useEffect(() => {
    if (resetKey === undefined) return;
    discardRecording();
    // resetKey is the event; recorder internals are intentionally not deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  const stopRecording = () => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  };

  const startRecording = async () => {
    if (!supported || busy) return;
    discardRecording();
    setError('');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;
      recordingRequestKeyRef.current = createWolfieRequestKey();
      const mimeType = chooseMimeType();
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      startedAtRef.current = Date.now();
      durationRef.current = 0;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
        const bytes = chunksRef.current.reduce(
          (total, chunk) => total + chunk.size,
          0,
        );
        if (bytes > MAX_AUDIO_BYTES && recorder.state !== 'inactive') {
          setError(
            'A gravação atingiu o limite de tamanho. Faça uma resposta mais curta.',
          );
          recorder.stop();
        }
      };

      recorder.onerror = () => {
        setError(
          'O navegador interrompeu a gravação. Tente novamente ou use texto.',
        );
      };

      recorder.onstop = () => {
        clearTimer();
        stopTracks();
        setRecording(false);
        recorderRef.current = null;
        const recordedDuration = Math.max(
          1,
          Math.round((Date.now() - startedAtRef.current) / 1000),
        );
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || mimeType || 'audio/webm',
        });
        chunksRef.current = [];
        durationRef.current = recordedDuration;
        setDuration(recordedDuration);

        if (blob.size > MAX_AUDIO_BYTES) {
          setAudioBlob(null);
          setAudioUrl('');
          return;
        }

        setAudioBlob(blob);
        releaseAudioUrl();
        const nextUrl = URL.createObjectURL(blob);
        audioUrlRef.current = nextUrl;
        setAudioUrl(nextUrl);
      };

      recorder.start(1_000);
      setRecording(true);
      timerRef.current = window.setInterval(() => {
        const elapsed = Math.floor(
          (Date.now() - startedAtRef.current) / 1_000,
        );
        durationRef.current = elapsed;
        setDuration(elapsed);
        if (elapsed >= MAX_DURATION_SECONDS) stopRecording();
      }, 500);
    } catch (cause) {
      stopTracks();
      const name = cause instanceof DOMException ? cause.name : '';
      setError(
        name === 'NotAllowedError'
          ? 'Permita o uso do microfone no navegador ou responda por texto.'
          : 'Não foi possível iniciar o microfone. Você ainda pode responder por texto.',
      );
    }
  };

  const handleAnalyze = async () => {
    if (!audioBlob || busy) return;
    if (audioBlob.size > MAX_AUDIO_BYTES) {
      setError('O áudio ficou grande demais. Grave uma versão mais curta.');
      return;
    }

    setError('');
    try {
      const audioBase64 = await blobToBase64(audioBlob);
      const mimeType =
        audioBlob.type.split(';', 1)[0] || 'audio/webm';
      await onAnalyze({
        audioBase64,
        mimeType,
        durationSeconds: durationRef.current || duration,
        requestKey:
          recordingRequestKeyRef.current || createWolfieRequestKey(),
      });
    } catch {
      setError(
        'Não foi possível preparar sua gravação. Tente gravar novamente.',
      );
    }
  };

  if (!supported) {
    return (
      <div className="rounded-2xl border border-dashed border-brand-border bg-brand-surface-2 p-5">
        <div className="flex items-start gap-3">
          <Mic
            size={22}
            className="mt-0.5 shrink-0 text-brand-muted"
            aria-hidden="true"
          />
          <div>
            <h3 className="font-bold text-brand-text">
              Áudio indisponível neste navegador
            </h3>
            <p className="mt-1 text-sm leading-6 text-brand-muted">
              O microfone precisa de uma conexão segura e de um navegador
              compatível. Use a opção de resposta por texto acima.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <section
      className="rounded-2xl border border-brand-border bg-brand-surface-2 p-4 sm:p-5"
      aria-labelledby="wolfie-audio-title"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 id="wolfie-audio-title" className="font-bold text-brand-text">
            Responda com sua voz
          </h3>
          <p className="mt-1 text-xs leading-5 text-brand-muted">
            Até 2 minutos. O áudio é enviado para análise e não fica salvo no
            seu repertório.
          </p>
        </div>
        <div
          className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-bold ${
            recording
              ? 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300'
              : 'bg-brand-bg text-brand-muted'
          }`}
          role="status"
          aria-live="polite"
        >
          <span
            className={`h-2 w-2 rounded-full ${
              recording ? 'animate-pulse bg-red-500' : 'bg-brand-border'
            }`}
            aria-hidden="true"
          />
          {recording ? 'Gravando' : audioBlob ? 'Pronto para enviar' : 'Em espera'}
          {' · '}
          {formatDuration(duration)}
        </div>
      </div>

      {error ? <div className="mt-4"><InlineError message={error} /></div> : null}

      <div className="mt-5">
        {recording ? (
          <button
            type="button"
            onClick={stopRecording}
            disabled={busy}
            className={`${secondaryButton} w-full border-red-300 text-red-700 dark:border-red-900 dark:text-red-300`}
          >
            <Square size={17} fill="currentColor" aria-hidden="true" />
            Parar gravação
          </button>
        ) : audioBlob && audioUrl ? (
          <div className="space-y-4">
            <audio
              className="w-full"
              src={audioUrl}
              controls
              preload="metadata"
              aria-label="Prévia da sua resposta gravada"
            >
              Seu navegador não consegue reproduzir esta gravação.
            </audio>
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={discardRecording}
                disabled={busy}
                className={secondaryButton}
              >
                <Trash2 size={17} aria-hidden="true" />
                Gravar de novo
              </button>
              <button
                type="button"
                onClick={handleAnalyze}
                disabled={busy}
                className={primaryButton}
              >
                {busy ? (
                  <>
                    <Loader2
                      size={17}
                      className="animate-spin"
                      aria-hidden="true"
                    />
                    Analisando sua fala…
                  </>
                ) : (
                  <>
                    <Send size={17} aria-hidden="true" />
                    Enviar para o Wolfie
                  </>
                )}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={startRecording}
            disabled={busy}
            className={`${primaryButton} w-full`}
          >
            <Mic size={18} aria-hidden="true" />
            Começar a gravar
          </button>
        )}
      </div>

      <div className="sr-only" aria-live="polite">
        {recording
          ? `Gravação em andamento, ${duration} segundos`
          : audioBlob
            ? `Gravação concluída com ${duration} segundos`
            : ''}
      </div>
    </section>
  );
}
