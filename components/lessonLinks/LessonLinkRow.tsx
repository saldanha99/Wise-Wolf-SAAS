import React, { useState } from 'react';
import { Copy, CheckCircle, ExternalLink, Video } from 'lucide-react';
import { LINK_KIND_LABEL, formatLessonTime, lessonMoment, type LessonLink } from '../../lib/lessonLinks';

const KIND_TONE: Record<LessonLink['linkKind'], string> = {
  escola: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  preparando: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
  pessoal: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  sem_link: 'bg-rose-500/10 text-rose-700 dark:text-rose-300',
};

const MOMENT_LABEL = { agora: 'Agora', em_breve: 'Em breve', encerrada: 'Encerrada', depois: '' } as const;

/**
 * Uma aula com o link dela. `title` muda conforme quem olha (o aluno vê o
 * professor; o professor vê o aluno; a direção vê os dois). `joinUrl` permite
 * à direção entrar pela conta central.
 */
interface LessonLinkRowProps {
  lesson: LessonLink;
  title: string;
  subtitle?: string;
  now: Date;
  joinUrl?: string | null;
  joinLabel?: string;
}

const LessonLinkRow: React.FC<LessonLinkRowProps> = ({ lesson, title, subtitle, now, joinUrl, joinLabel = 'Entrar' }) => {
  const [copied, setCopied] = useState(false);
  const moment = lessonMoment(lesson, now);
  const href = joinUrl === undefined ? lesson.link : joinUrl;
  const copy = async () => {
    if (!lesson.link) return;
    try {
      await navigator.clipboard.writeText(lesson.link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch { /* sem permissão de área de transferência */ }
  };

  return (
    <li className={`ww-slab tone-${moment === 'agora' ? 'emerald' : 'slate'} flex flex-col gap-3 p-4 sm:flex-row sm:items-center ${moment === 'encerrada' ? 'opacity-60' : ''}`}>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="w-14 shrink-0 text-center">
          <p className="text-lg font-black leading-none text-brand-text">{formatLessonTime(lesson.startsAt)}</p>
          {MOMENT_LABEL[moment] ? (
            <p className={`mt-1 text-[9px] font-black uppercase tracking-wider ${moment === 'agora' ? 'text-emerald-600 dark:text-emerald-400' : 'text-brand-muted'}`}>
              {moment === 'agora' ? <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500 align-middle" /> : null}
              {MOMENT_LABEL[moment]}
            </p>
          ) : null}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-black text-brand-text">{title}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {lesson.kind === 'experimental' ? (
              <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-violet-700 dark:text-violet-300">Experimental</span>
            ) : null}
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wider ${KIND_TONE[lesson.linkKind]}`}>
              {LINK_KIND_LABEL[lesson.linkKind]}
            </span>
            {subtitle ? <span className="truncate text-[11px] font-semibold text-brand-muted">{subtitle}</span> : null}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        {lesson.link ? (
          <button type="button" onClick={copy} aria-label={`Copiar link da aula das ${formatLessonTime(lesson.startsAt)}`}
            className="flex items-center gap-1.5 rounded-xl border border-brand-border px-3 py-2 text-xs font-bold text-brand-text hover:bg-brand-bg">
            {copied ? <CheckCircle size={14} className="text-emerald-500" /> : <Copy size={14} />} {copied ? 'Copiado' : 'Copiar'}
          </button>
        ) : null}
        {href && moment !== 'encerrada' ? (
          <a href={href} target="_blank" rel="noopener noreferrer"
            className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-black text-white hover:bg-emerald-700 sm:flex-none">
            {moment === 'agora' ? <Video size={14} /> : <ExternalLink size={14} />} {joinLabel}
          </a>
        ) : null}
      </div>
    </li>
  );
};

export default LessonLinkRow;
