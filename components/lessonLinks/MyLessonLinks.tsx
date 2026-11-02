import React from 'react';
import { CalendarDays, RefreshCw } from 'lucide-react';
import LessonLinkRow from './LessonLinkRow';
import { todayInSaoPaulo, useLessonLinks, useNow } from './useLessonLinks';
import type { LessonLink } from '../../lib/lessonLinks';

/**
 * Aulas de hoje e amanhã com o link oficial — a mesma resposta do aviso de 10
 * minutos e do "Ao vivo" da direção, então aluno e professor veem o mesmo link.
 */
export default function MyLessonLinks({ role }: { role: 'STUDENT' | 'TEACHER' }) {
  const today = todayInSaoPaulo();
  const tomorrow = todayInSaoPaulo(1);
  const { result, error, loading, reload } = useLessonLinks(today, tomorrow);
  const now = useNow();

  const title = (lesson: LessonLink) => role === 'STUDENT'
    ? `Aula com ${lesson.teacherName}`
    : lesson.kind === 'experimental' ? lesson.studentName : `Aula com ${lesson.studentName}`;
  const groups = [
    { label: 'Hoje', rows: (result?.lessons || []).filter(l => l.classDate === today) },
    { label: 'Amanhã', rows: (result?.lessons || []).filter(l => l.classDate === tomorrow) },
  ];

  return (
    <section data-tour="lesson-links-today" className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="ww-orb tone-emerald h-10 w-10 shrink-0"><CalendarDays size={18} /></div>
          <div>
            <h3 className="text-base font-black text-brand-text">Links das suas aulas</h3>
            <p className="text-xs text-brand-muted">
              {role === 'STUDENT' ? 'O mesmo link que o seu professor usa.' : 'O mesmo link que o aluno recebe.'} 10 minutos antes, a plataforma avisa.
            </p>
          </div>
        </div>
        <button type="button" onClick={() => { void reload(); }} aria-label="Atualizar links"
          className="rounded-xl border border-brand-border p-2 text-brand-muted hover:bg-brand-bg">
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {error && !result ? (
        <p className="rounded-2xl bg-rose-500/10 p-4 text-sm font-semibold text-rose-700 dark:text-rose-300">
          Não foi possível carregar os links agora. Tente atualizar em instantes.
        </p>
      ) : null}

      {result ? groups.map(group => (
        <div key={group.label}>
          <p className="mb-2 text-[10px] font-black uppercase tracking-[0.18em] text-brand-muted">{group.label}</p>
          {group.rows.length ? (
            <ul className="space-y-2">
              {group.rows.map(lesson => (
                <LessonLinkRow key={`${lesson.kind}:${lesson.id}`} lesson={lesson} title={title(lesson)} now={now} />
              ))}
            </ul>
          ) : (
            <p className="rounded-2xl border border-dashed border-brand-border p-4 text-sm text-brand-muted">Nenhuma aula.</p>
          )}
        </div>
      )) : null}
    </section>
  );
}
