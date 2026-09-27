import React from 'react';
import { lessonLine, monthLabel, notMeasuredItems, summaryItems, type PunctualityExtract } from '../lib/teacherPunctuality';

// Extrato de UM professor num mês (migration 20260928120000). Sem nota, sem
// ranking, sem comparação — e o texto diz que não mexe no pagamento.
export default function TeacherPunctualityExtract({ extract, viewer }: { extract: PunctualityExtract; viewer: 'teacher' | 'school' }) {
  const pending = notMeasuredItems(extract.summary);
  return <section className="space-y-4" aria-label={`Extrato de pontualidade de ${monthLabel(extract.month)}`}>
    <p className="text-xs text-slate-500 dark:text-slate-400">
      Horário de entrada na sala da escola pelo relatório de presença do Google Meet, aula a aula.
      Sem nota, sem ranking e sem comparação entre professores. Não altera o pagamento.
    </p>
    <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {summaryItems(extract.summary).map(item => <div key={item.key} className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
        <dt className="text-xs text-slate-500">{item.label}</dt>
        <dd className="mt-1 text-xl font-bold">{item.value}</dd>
      </div>)}
    </dl>
    {pending.length > 0 && <div className="rounded-xl border border-slate-200 p-3 text-sm dark:border-slate-700">
      <p className="font-semibold">Aulas sem horário medido</p>
      <ul className="mt-1 space-y-0.5">{pending.map(item => <li key={item.status}>{item.label}: {item.count}</li>)}</ul>
    </div>}
    {extract.lessons.length === 0
      ? <p className="rounded-xl border p-4 text-sm text-slate-500">Nenhuma aula neste mês no extrato.</p>
      : <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 text-sm dark:divide-slate-700 dark:border-slate-700">
        {extract.lessons.map((lesson, index) => {
          const line = lessonLine(lesson, viewer);
          return <li key={`${lesson.scheduled_start_at}-${index}`} className="flex flex-wrap justify-between gap-2 p-3">
            <span className="font-medium">{line.when}</span>
            <span className="text-slate-600 dark:text-slate-300">{line.detail}</span>
          </li>;
        })}
      </ul>}
  </section>;
}
