import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { currentMonthInput, monthParam, type TeacherPunctualityResponse } from '../lib/teacherPunctuality';
import TeacherPunctualityExtract from './TeacherPunctualityExtract';

// Aba "Pontualidade" da Central de Qualidade (direção e coordenação). Um
// professor por vez, escolhido numa lista em ordem alfabética — nada de tabela
// com todos lado a lado (o termo v3 promete "sem comparação com outros
// professores"). Desligado para a escola: só o aviso de que o extrato existe e
// depende da liberação do jurídico.
export default function TeacherPunctualityPanel() {
  const [month, setMonth] = useState(currentMonthInput());
  const [teacherId, setTeacherId] = useState('');
  const [data, setData] = useState<TeacherPunctualityResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const result = await supabase.rpc('get_teacher_punctuality_extract', {
        p_teacher_id: teacherId || null,
        p_month: monthParam(month),
      });
      if (result.error || result.data?.ok !== true) throw new Error('load');
      setData(result.data as TeacherPunctualityResponse);
    } catch {
      setError('Não foi possível carregar o extrato de pontualidade. Verifique sua permissão.');
    } finally {
      setBusy(false);
    }
  }, [teacherId, month]);

  useEffect(() => { void load(); }, [load]);

  if (!data) return error
    ? <p role="alert" className="text-red-600">{error}</p>
    : <p className="text-sm text-slate-500">Carregando…</p>;

  if (!data.enabled) {
    return <div data-testid="punctuality-disabled" className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
      <p className="font-semibold">Extrato de pontualidade dos professores: pronto, e desligado nesta escola.</p>
      <p>O extrato mostra, para cada professor e mês, o horário em que ele entrou na sala da escola em cada aula, pelo relatório de presença do Google Meet — sem nota, sem ranking e sem comparação entre professores, e sem mexer no pagamento. O próprio professor vê o dele.</p>
      <p>Ele depende da liberação do jurídico. Enquanto estiver desligado, nada é calculado nem mostrado a ninguém. Liberado, a equipe da plataforma liga o extrato para a escola, e ele começa pelas aulas seguintes.</p>
      <p>Os avisos de atraso detectados pelo Meet continuam na fila de casos, como hoje.</p>
    </div>;
  }

  return <div className="space-y-4">
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-sm">Professor
        <select aria-label="Professor" value={teacherId} onChange={event => setTeacherId(event.target.value)} className="ml-2 rounded-lg border bg-white p-2 text-slate-900">
          <option value="">Escolha um professor</option>
          {data.teachers.map(teacher => <option key={teacher.id} value={teacher.id}>{teacher.name || 'Sem nome'}</option>)}
        </select>
      </label>
      <label className="text-sm">Mês
        <input aria-label="Mês" type="month" value={month} onChange={event => setMonth(event.target.value)} className="ml-2 rounded-lg border bg-white p-2 text-slate-900" />
      </label>
      {busy && <span className="text-xs text-slate-500">Atualizando…</span>}
    </div>
    {error && <p role="alert" className="text-red-600">{error}</p>}
    <p className="text-xs text-slate-500">Um professor por vez, sem comparação entre professores. Só aulas desde {new Date(data.enabled_at).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}, quando o extrato foi ligado; guardado por 90 dias depois da aula, o prazo do relatório de presença.</p>
    {data.extract
      ? <TeacherPunctualityExtract extract={data.extract} viewer="school" />
      : <p className="rounded-xl border p-5 text-sm text-slate-500">Escolha um professor para ver o extrato do mês.</p>}
  </div>;
}
