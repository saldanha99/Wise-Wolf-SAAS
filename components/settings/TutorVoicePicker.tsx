import React, { useEffect, useRef, useState } from 'react';
import { Check, Mic, Play, Square } from 'lucide-react';
import {
  DEFAULT_TUTOR_VOICE,
  TUTOR_VOICES,
  type TutorVoiceGender,
} from '../../supabase/functions/_shared/tutor-voice';

interface TutorVoicePickerProps {
  /** Id salvo em tenants.branding.tutorVoice; vazio = voz padrão. */
  value: string;
  onChange: (voice: string) => void;
}

const GROUPS: { gender: TutorVoiceGender; title: string }[] = [
  { gender: 'female', title: 'Vozes femininas' },
  { gender: 'male', title: 'Vozes masculinas' },
];

/**
 * White label: a escola escolhe a voz do tutor (ao vivo e clássico).
 * As prévias (~5 s) ficam num módulo à parte, carregado só ao tocar a primeira.
 */
export const TutorVoicePicker: React.FC<TutorVoicePickerProps> = ({ value, onChange }) => {
  const selected = value || DEFAULT_TUTOR_VOICE;
  const [playing, setPlaying] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Cada toque ganha um número; só o último toca (cliques rápidos durante o import).
  const requestRef = useRef(0);

  useEffect(() => () => {
    audioRef.current?.pause();
    audioRef.current = null;
  }, []);

  const stop = () => {
    requestRef.current += 1;
    audioRef.current?.pause();
    audioRef.current = null;
    setPlaying(null);
  };

  const preview = async (voice: string) => {
    if (playing === voice) {
      stop();
      return;
    }
    stop();
    const request = requestRef.current;
    setPreviewError(false);
    try {
      const { TUTOR_VOICE_PREVIEWS } = await import('../../lib/tutorVoicePreviews');
      if (request !== requestRef.current) return;
      const src = TUTOR_VOICE_PREVIEWS[voice];
      if (!src) throw new Error('preview_missing');
      const audio = new Audio(src);
      audioRef.current = audio;
      audio.onended = () => {
        if (audioRef.current === audio) setPlaying(null);
      };
      setPlaying(voice);
      await audio.play();
    } catch {
      setPlaying(null);
      setPreviewError(true);
    }
  };

  return (
    <div data-tour="tutor-voice" className="rounded-3xl border border-brand-border bg-brand-surface p-5 shadow-xs">
      <div className="mb-4 flex items-start gap-3">
        <div className="rounded-xl bg-brand-surface-2 p-2 text-tenant-primary"><Mic size={18} /></div>
        <div>
          <h3 className="text-sm font-black text-brand-text">Voz do tutor</h3>
          <p className="text-xs text-brand-muted">
            Usada na conversa ao vivo e nas respostas faladas. Toque em ouvir para comparar.
          </p>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {GROUPS.map((group) => (
          <div key={group.gender} className="space-y-2">
            <p className="text-[10px] font-black uppercase tracking-widest text-brand-muted">{group.title}</p>
            {TUTOR_VOICES.filter((option) => option.gender === group.gender).map((option) => {
              const isSelected = selected === option.id;
              return (
                <div
                  key={option.id}
                  className={`flex items-center gap-2 rounded-2xl border p-2 ${isSelected ? 'border-tenant-primary bg-brand-surface-2' : 'border-brand-border'}`}
                >
                  <button
                    type="button"
                    onClick={() => onChange(option.id)}
                    aria-pressed={isSelected}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2 py-1 text-left"
                  >
                    <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${isSelected ? 'border-tenant-primary bg-tenant-primary text-white' : 'border-brand-border'}`}>
                      {isSelected && <Check size={12} />}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-bold text-brand-text">
                        {option.label}{option.id === DEFAULT_TUTOR_VOICE ? ' · padrão' : ''}
                      </span>
                      <span className="block truncate text-xs text-brand-muted">{option.description}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void preview(option.id)}
                    aria-label={playing === option.id ? `Parar prévia da voz ${option.label}` : `Ouvir prévia da voz ${option.label}`}
                    className="flex items-center gap-1 rounded-xl border border-brand-border px-3 py-2 text-xs font-bold text-brand-text hover:bg-brand-surface-2"
                  >
                    {playing === option.id ? <Square size={12} /> : <Play size={12} />}
                    {playing === option.id ? 'Parar' : 'Ouvir'}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {previewError && (
        <p role="alert" className="mt-3 text-xs text-red-600">Não foi possível tocar a prévia agora. A escolha da voz continua valendo.</p>
      )}
      <p className="mt-3 text-xs text-brand-muted">A nova voz vale para as próximas conversas, depois de salvar.</p>
    </div>
  );
};
