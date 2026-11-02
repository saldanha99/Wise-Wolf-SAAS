import React, { useMemo, useState } from 'react';
import { Radio, RefreshCw, EyeOff, Search } from 'lucide-react';
import LessonLinkRow from './LessonLinkRow';
import { todayInSaoPaulo, useLessonLinks, useNow } from './useLessonLinks';
import { directorJoinUrl, lessonMoment, type LessonLink } from '../../lib/lessonLinks';
import { Kpi3D, PageHero3D } from '../depth/Depth3D';

/**
 * Ao vivo da direção: as aulas de hoje com o link de cada uma. A sala da
 * escola abre já na conta central (dona da sala), que entra sem pedir para
 * participar — de câmera e microfone desligados, é o "entrar sem atrapalhar".
 */
export default function LiveLessonsBoard() {
  const today = todayInSaoPaulo();
  const { result, error, loading, reload } = useLessonLinks(today, today);
  const now = useNow(15_000);
  const [query, setQuery] = useState('');
  const [showEnded, setShowEnded] = useState(false);

  const lessons = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('pt-BR');
    return (result?.lessons || []).filter(l => !q
      || l.teacherName.toLocaleLowerCase('pt-BR').includes(q)
      || l.studentName.toLocaleLowerCase('pt-BR').includes(q));
  }, [result, query]);

  const byMoment = (moment: ReturnType<typeof lessonMoment>) => lessons.filter(l => lessonMoment(l, now, 30) === moment);
  const live = byMoment('agora');
  const soon = byMoment('em_breve');
  const later = byMoment('depois');
  const ended = byMoment('encerrada');
  const all = result?.lessons || [];
  const withoutSchoolRoom = all.filter(l => l.linkKind !== 'escola' && lessonMoment(l, now) !== 'encerrada').length;

  const row = (lesson: LessonLink) => (
    <LessonLinkRow
      key={`${lesson.kind}:${lesson.id}`}
      lesson={lesson}
      title={`${lesson.teacherName} · ${lesson.studentName}`}
      subtitle={lesson.kind === 'experimental' ? 'lead sem conta' : undefined}
      now={now}
      joinUrl={directorJoinUrl(lesson, result?.organizerEmail || null)}
      joinLabel={lessonMoment(lesson, now) === 'agora' ? 'Entrar agora' : 'Abrir sala'}
    />
  );

  const section = (label: string, rows: LessonLink[], empty: string) => (
    <div>
      <p className="mb-2 text-[10px] font-black uppercase tracking-[0.18em] text-brand-muted">{label} · {rows.length}</p>
      {rows.length ? <ul className="space-y-2">{rows.map(row)}</ul>
        : <p className="rounded-2xl border border-dashed border-brand-border p-4 text-sm text-brand-muted">{empty}</p>}
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHero3D
        icon={<Radio size={24} />}
        eyebrow="Aulas"
        title="Ao vivo"
        tone="emerald"
        subtitle="As aulas de hoje, com o mesmo link que professor e aluno recebem."
        actions={(
          <>
            <label className="relative w-full sm:w-64">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted" />
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Professor ou aluno"
                aria-label="Buscar professor ou aluno"
                className="w-full rounded-xl border border-brand-border bg-brand-surface py-2 pl-9 pr-3 text-sm text-brand-text" />
            </label>
            <button type="button" onClick={() => { void reload(); }} aria-label="Atualizar aulas ao vivo"
              className="flex items-center justify-center gap-2 rounded-xl border border-brand-border px-3 py-2 text-sm font-bold text-brand-text hover:bg-brand-bg">
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Atualizar
            </button>
          </>
        )}
      />

      <div data-tour="live-lessons-kpis" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi3D icon={<Radio size={18} />} tone="emerald" label="Acontecendo agora" value={live.length} />
        <Kpi3D icon={<Radio size={18} />} tone="sky" label="Nos próximos 30 min" value={soon.length} />
        <Kpi3D icon={<Radio size={18} />} tone="violet" label="Aulas hoje" value={all.length} />
        <Kpi3D icon={<Radio size={18} />} tone={withoutSchoolRoom ? 'amber' : 'emerald'} label="Fora da sala da escola"
          value={withoutSchoolRoom} hint="link pessoal, sala preparando ou sem link" />
      </div>

      <div className="flex gap-3 rounded-2xl bg-sky-500/10 p-4 text-sm text-sky-900 dark:text-sky-200">
        <EyeOff size={18} className="mt-0.5 shrink-0" />
        <p>
          Na <strong>sala da escola</strong>, "Entrar agora" abre o Meet na conta central{result?.organizerEmail ? <> ({result.organizerEmail})</> : null},
          dona da sala: você entra direto, sem pedir para participar. Desligue câmera e microfone logo ao abrir
          (o Meet pode abrir com a câmera ligada). O Google Meet não tem participante invisível: seu nome aparece na
          lista de pessoas. Em <strong>link pessoal</strong> é preciso ser admitido por quem está na sala.
        </p>
      </div>

      {error && !result ? (
        <p className="rounded-2xl bg-rose-500/10 p-4 text-sm font-semibold text-rose-700 dark:text-rose-300">
          Não foi possível carregar as aulas agora. Tente atualizar.
        </p>
      ) : null}

      {result ? (
        <div data-tour="live-lessons-list" className="space-y-6">
          {section('Acontecendo agora', live, 'Nenhuma aula neste momento.')}
          {section('Nos próximos 30 minutos', soon, 'Nenhuma aula começando agora.')}
          {section('Mais tarde hoje', later, 'Nenhuma outra aula hoje.')}
          {ended.length ? (
            <div>
              <button type="button" onClick={() => setShowEnded(v => !v)}
                className="text-xs font-bold text-brand-muted underline-offset-2 hover:underline">
                {showEnded ? 'Esconder' : 'Mostrar'} encerradas ({ended.length})
              </button>
              {showEnded ? <ul className="mt-2 space-y-2">{ended.map(row)}</ul> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
