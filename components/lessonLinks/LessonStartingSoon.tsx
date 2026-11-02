import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Video, Clock, X } from 'lucide-react';
import { formatLessonTime, lessonKey, lessonMoment, lessonToAnnounce } from '../../lib/lessonLinks';
import { todayInSaoPaulo, useLessonLinks, useNow } from './useLessonLinks';

const STORAGE = (userId: string) => `wisewolf.lessonSoon.${userId}`;

function readDismissed(userId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(STORAGE(userId));
    const list = raw ? JSON.parse(raw) : [];
    return new Set<string>(Array.isArray(list) ? list.slice(-50).map(String) : []);
  } catch {
    return new Set();
  }
}

function writeDismissed(userId: string, keys: Set<string>) {
  try {
    window.localStorage.setItem(STORAGE(userId), JSON.stringify([...keys].slice(-50)));
  } catch { /* sem armazenamento: o aviso só volta a aparecer */ }
}

/**
 * Aviso que abre 10 minutos antes da aula para o aluno e o professor logados,
 * com o MESMO link para os dois (o servidor decide qual: `my_lesson_links`).
 * Fechar vale para aquela aula, neste aparelho.
 */
export default function LessonStartingSoon({ userId, role, onActiveChange }: {
  userId: string;
  role: 'STUDENT' | 'TEACHER';
  onActiveChange?: (active: boolean) => void;
}) {
  const today = todayInSaoPaulo();
  const { result } = useLessonLinks(today, today);
  const now = useNow(15_000);
  const [dismissed, setDismissed] = useState(() => readDismissed(userId));
  const dialog = useRef<HTMLDialogElement>(null);

  const lesson = useMemo(
    () => (result ? lessonToAnnounce(result.lessons, now, dismissed) : null),
    [result, now, dismissed],
  );

  useEffect(() => { onActiveChange?.(lesson !== null); }, [lesson, onActiveChange]);
  useEffect(() => () => onActiveChange?.(false), [onActiveChange]);
  useEffect(() => {
    const node = dialog.current;
    if (lesson && node && !node.open) node.showModal();
    if (!lesson && node?.open) node.close();
  }, [lesson]);

  if (!lesson) return null;

  const close = () => {
    const next = new Set<string>(dismissed);
    next.add(lessonKey(lesson));
    writeDismissed(userId, next);
    setDismissed(next);
  };
  const started = lessonMoment(lesson, now) === 'agora';
  const minutes = Math.max(1, Math.ceil((lesson.startsAt.getTime() - now.getTime()) / 60_000));
  const other = role === 'STUDENT'
    ? `com ${lesson.teacherName}`
    : lesson.kind === 'experimental' ? `experimental com ${lesson.studentName}` : `com ${lesson.studentName}`;

  return (
    <dialog
      ref={dialog}
      aria-labelledby="lesson-soon-title"
      onCancel={(event) => { event.preventDefault(); close(); }}
      className="m-auto w-[min(92vw,26rem)] rounded-3xl border border-brand-border bg-brand-surface p-0 text-brand-text shadow-2xl backdrop:bg-slate-950/60"
    >
      <div className="p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="ww-orb tone-emerald h-12 w-12 shrink-0"><Video size={22} /></div>
          <button type="button" onClick={close} aria-label="Fechar aviso" className="rounded-full p-2 text-brand-muted hover:bg-brand-bg">
            <X size={18} />
          </button>
        </div>
        <p className="mt-4 text-[10px] font-black uppercase tracking-[0.18em] text-brand-muted flex items-center gap-1.5">
          <Clock size={12} /> {started ? 'Sua aula já começou' : `Sua aula começa em ${minutes} min`}
        </p>
        <h2 id="lesson-soon-title" className="mt-1 text-xl font-black leading-tight">
          Aula {other} às {formatLessonTime(lesson.startsAt)}
        </h2>

        {lesson.link ? (
          <>
            <p className="mt-2 text-sm text-brand-muted">
              {lesson.linkKind === 'escola'
                ? 'É a sala da escola no Google Meet — o mesmo link para aluno e professor.'
                : 'Use o link combinado para esta aula.'}
            </p>
            <a
              href={lesson.link}
              target="_blank"
              rel="noopener noreferrer"
              onClick={close}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-emerald-600 px-5 py-3.5 text-sm font-black text-white shadow-lg hover:bg-emerald-700"
            >
              <Video size={18} /> Entrar na aula
            </a>
            <p className="mt-2 break-all text-center text-[11px] text-brand-muted">{lesson.link}</p>
          </>
        ) : (
          <p className="mt-3 rounded-2xl bg-amber-500/10 p-3 text-sm font-semibold text-amber-700 dark:text-amber-300">
            {lesson.linkKind === 'preparando'
              ? 'A sala da escola está sendo preparada e o link aparece aqui em instantes. Não use outro link.'
              : 'Esta aula ainda não tem link cadastrado. Fale com a escola pelo WhatsApp.'}
          </p>
        )}
      </div>
    </dialog>
  );
}
