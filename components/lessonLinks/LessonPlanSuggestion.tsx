import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { formatLessonTime, lessonKey, lessonToSuggestPlan } from '../../lib/lessonLinks';
import { PLANNER_REQUEST, setPlannerIntent } from '../../lib/plannerIntent';
import { todayInSaoPaulo, useLessonLinks, useNow } from './useLessonLinks';

const STORAGE = (userId: string) => `wisewolf.planSuggestion.${userId}`;

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
  } catch { /* sem armazenamento: o aviso desta aula só volta a aparecer */ }
}

/**
 * "Sugestão de plano para a próxima aula": entre 60 e 10 minutos antes de cada
 * aula regular, o professor é convidado a abrir o plano que a IA monta a partir
 * das aulas anteriores do aluno. "Agora não" vale para aquela aula; "Não mostrar
 * mais" desliga no banco (religa no Planner IA). Erro ao ler a preferência não
 * abre nada — incomodar por engano é pior do que não sugerir.
 */
export default function LessonPlanSuggestion({ userId, onOpenPlanner, onActiveChange }: {
  userId: string;
  onOpenPlanner: () => void;
  onActiveChange?: (active: boolean) => void;
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const today = todayInSaoPaulo();
  const { result } = useLessonLinks(today, today, enabled === true);
  const now = useNow(30_000);
  const [dismissed, setDismissed] = useState(() => readDismissed(userId));
  const [lastStep, setLastStep] = useState<{ date: string; text: string } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const { data, error } = await supabase
        .from('teacher_lesson_plan_prompt_prefs')
        .select('disabled')
        .eq('user_id', userId)
        .maybeSingle();
      if (!active) return;
      setEnabled(error ? false : !(data as { disabled?: boolean } | null)?.disabled);
    })();
    return () => { active = false; };
  }, [userId]);

  const lesson = useMemo(
    () => (enabled && result ? lessonToSuggestPlan(result.lessons, now, dismissed) : null),
    [enabled, result, now, dismissed],
  );

  // O que a última aula lançada deixou como próximo passo — o gancho do plano.
  useEffect(() => {
    setLastStep(null);
    if (!lesson?.studentId) return;
    let active = true;
    void (async () => {
      const { data } = await supabase
        .from('class_logs')
        .select('class_date, recommended_next_step')
        .eq('student_id', lesson.studentId as string)
        .not('recommended_next_step', 'is', null)
        .order('class_date', { ascending: false })
        .limit(1)
        .maybeSingle();
      const row = data as { class_date?: string; recommended_next_step?: string } | null;
      if (active && row?.recommended_next_step?.trim()) {
        setLastStep({ date: String(row.class_date || ''), text: row.recommended_next_step.trim() });
      }
    })();
    return () => { active = false; };
  }, [lesson?.studentId]);

  useEffect(() => { onActiveChange?.(lesson !== null); }, [lesson, onActiveChange]);
  useEffect(() => () => onActiveChange?.(false), [onActiveChange]);
  useEffect(() => {
    const node = dialog.current;
    if (lesson && node && !node.open) node.showModal();
    if (!lesson && node?.open) node.close();
  }, [lesson]);

  if (!lesson) return null;

  const dismiss = () => {
    const next = new Set<string>(dismissed);
    next.add(`plan:${lessonKey(lesson)}`);
    writeDismissed(userId, next);
    setDismissed(next);
  };
  const time = formatLessonTime(lesson.startsAt);
  const openPlan = () => {
    setPlannerIntent({
      studentId: lesson.studentId as string,
      studentName: lesson.studentName,
      request: PLANNER_REQUEST(time, lesson.studentName),
      autoGenerate: true,
    });
    dismiss();
    onOpenPlanner();
  };
  const neverAgain = async () => {
    const { error } = await supabase
      .from('teacher_lesson_plan_prompt_prefs')
      .upsert({ user_id: userId, disabled: true, updated_at: new Date().toISOString() });
    dismiss();
    if (!error) setEnabled(false);
  };
  const minutes = Math.max(1, Math.ceil((lesson.startsAt.getTime() - now.getTime()) / 60_000));
  const stepDate = lastStep?.date ? lastStep.date.split('-').reverse().slice(0, 2).join('/') : '';

  return (
    <dialog
      ref={dialog}
      aria-labelledby="plan-suggestion-title"
      onCancel={(event) => { event.preventDefault(); dismiss(); }}
      className="m-auto w-[min(92vw,28rem)] rounded-3xl border border-brand-border bg-brand-surface p-0 text-brand-text shadow-2xl backdrop:bg-slate-950/60"
    >
      <div className="p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="ww-orb tone-violet h-12 w-12 shrink-0"><Sparkles size={22} /></div>
          <button type="button" onClick={dismiss} aria-label="Fechar sugestão" className="rounded-full p-2 text-brand-muted hover:bg-brand-bg">
            <X size={18} />
          </button>
        </div>
        <p className="mt-4 text-[10px] font-black uppercase tracking-[0.18em] text-brand-muted">
          Sugestão de plano · aula em {minutes} min
        </p>
        <h2 id="plan-suggestion-title" className="mt-1 text-xl font-black leading-tight">
          Próxima aula: {lesson.studentName}, às {time}
        </h2>
        <p className="mt-2 text-sm text-brand-muted">
          A IA monta o plano desta aula a partir das aulas anteriores: revisão, pontos de atenção, objetivo de hoje, roteiro e próximos passos.
        </p>
        {lastStep && (
          <div className="mt-3 rounded-2xl bg-brand-bg p-3 text-sm">
            <p className="text-[10px] font-black uppercase tracking-[0.14em] text-brand-muted">
              Próximo passo da última aula{stepDate ? ` (${stepDate})` : ''}
            </p>
            <p className="mt-1 line-clamp-3">{lastStep.text}</p>
          </div>
        )}
        <button
          type="button"
          onClick={openPlan}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-brand-accent px-5 py-3.5 text-sm font-black text-white shadow-lg hover:opacity-90"
        >
          <Sparkles size={18} /> Ver o plano da aula
        </button>
        <div className="mt-3 flex items-center justify-between gap-2 text-xs font-bold">
          <button type="button" onClick={dismiss} className="rounded-xl px-3 py-2 text-brand-muted hover:bg-brand-bg">
            Agora não
          </button>
          <button type="button" onClick={() => { void neverAgain(); }} className="rounded-xl px-3 py-2 text-brand-muted hover:bg-brand-bg">
            Não mostrar mais
          </button>
        </div>
      </div>
    </dialog>
  );
}
