import React, { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { currentMonthInput, monthLabel, monthParam, type MyPunctualityResponse, type PunctualityExtract } from '../lib/teacherPunctuality';
import TeacherPunctualityExtract from './TeacherPunctualityExtract';

// Painel do professor: o PRÓPRIO extrato de pontualidade (migration
// 20260928120000). Desligado para a escola (o padrão, até o jurídico liberar),
// com erro ou sem resposta: o cartão não aparece — nada de "em breve" nem de
// número estimado.
export default function TeacherPunctualityCard() {
  const [month, setMonth] = useState(currentMonthInput());
  const [extract, setExtract] = useState<PunctualityExtract | null>(null);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data, error } = await supabase.rpc('get_my_punctuality_extract', { p_month: monthParam(month) });
        const response = data as MyPunctualityResponse | null;
        if (!alive) return;
        if (error || !response || response.ok !== true || !response.enabled) {
          setEnabled(false); setExtract(null);
          return;
        }
        setEnabled(true);
        setExtract({ month: response.month, summary: response.summary, lessons: response.lessons });
      } catch {
        if (alive) { setEnabled(false); setExtract(null); }
      }
    })();
    return () => { alive = false; };
  }, [month]);

  if (!enabled || !extract) return null;

  return <div data-tour="teacher-punctuality" className="space-y-4 rounded-2xl border border-brand-border bg-brand-surface p-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="flex items-center gap-2 text-sm font-bold text-brand-text"><Clock size={16} /> Meu extrato de pontualidade · {monthLabel(extract.month)}</h3>
      <label className="text-xs text-brand-muted">Mês
        <input aria-label="Mês do extrato" type="month" value={month} onChange={event => setMonth(event.target.value)} className="ml-2 rounded-lg border bg-white p-1 text-slate-900" />
      </label>
    </div>
    <TeacherPunctualityExtract extract={extract} viewer="teacher" />
  </div>;
}
