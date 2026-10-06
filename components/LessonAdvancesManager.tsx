import React, { useEffect, useMemo, useState } from 'react';
import { CalendarArrowDown, CheckCircle2, Loader2, Plane, RefreshCw, XCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { formatLocalDateBr, localMonth, localYMD, monthRange } from '../lib/dateUtils';

interface Props {
  tenantId?: string;
}

interface CandidateSource {
  booking_id: string;
  original_date: string;
  start_time: string;
  teacher_name: string | null;
}

interface Candidate {
  bookingId: string;
  originalDate: string;
  time: string;
  teacherName: string;
  selected: boolean;
  advanceDate: string;
}

const nextMonth = (): string => {
  const now = new Date();
  return localMonth(new Date(now.getFullYear(), now.getMonth() + 1, 1));
};

export const advanceDateLimit = (originalDate: string): string => {
  const first = new Date(`${originalDate.slice(0, 7)}-01T12:00:00`);
  first.setDate(first.getDate() - 1);
  return localYMD(first);
};

const LessonAdvancesManager: React.FC<Props> = ({ tenantId }) => {
  const [students, setStudents] = useState<any[]>([]);
  const [studentId, setStudentId] = useState('');
  const [sourceMonth, setSourceMonth] = useState(nextMonth);
  const [reason, setReason] = useState('Viagem da aluna');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [existing, setExisting] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [alreadyTaught, setAlreadyTaught] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadBase = async () => {
    setRefreshVersion(value => value + 1);
    if (!tenantId) return;
    setLoading(true);
    setError(null);
    const [studentsResult, advancesResult] = await Promise.all([
      supabase.from('profiles').select('id, full_name').eq('tenant_id', tenantId).eq('role', 'STUDENT').order('full_name'),
      supabase.from('lesson_advances')
        .select('id, original_date, advance_date, advance_time, reason, status, student:student_id(full_name), teacher:teacher_id(full_name)')
        .eq('tenant_id', tenantId).order('original_date', { ascending: false }).limit(100),
    ]);
    if (studentsResult.error || advancesResult.error) {
      setError(studentsResult.error?.message || advancesResult.error?.message || 'Falha ao carregar antecipações.');
    } else {
      setStudents(studentsResult.data || []);
      setExisting(advancesResult.data || []);
    }
    setLoading(false);
  };

  useEffect(() => { void loadBase(); }, [tenantId]);

  useEffect(() => {
    if (!tenantId || !studentId || !sourceMonth) {
      setCandidates([]);
      setCandidatesLoading(false);
      return;
    }
    let active = true;
    setCandidates([]);
    setCandidatesLoading(true);
    setError(null);
    void (async () => {
      const { data, error: bookingError } = await supabase.rpc('list_lesson_advance_candidates', {
        p_student_id: studentId,
        p_month: monthRange(sourceMonth).start,
      });
      if (!active) return;
      if (bookingError) {
        setError(bookingError.message);
        setCandidates([]);
      } else {
        setCandidates(((data || []) as CandidateSource[]).map(row => ({
          bookingId: row.booking_id, originalDate: row.original_date,
          time: row.start_time, teacherName: row.teacher_name || 'Professor',
          selected: false, advanceDate: '',
        })));
      }
      setCandidatesLoading(false);
    })();
    return () => { active = false; };
  }, [tenantId, studentId, sourceMonth, refreshVersion]);

  const selected = useMemo(() => candidates.filter(row => row.selected), [candidates]);
  const setRow = (index: number, patch: Partial<Candidate>) => {
    setCandidates(current => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  };

  const create = async () => {
    if (saving || candidatesLoading || !studentId || selected.length === 0) return;
    if (selected.some(row => !row.advanceDate || row.advanceDate >= row.originalDate)) {
      setError('Informe uma data anterior válida para cada aula selecionada.');
      return;
    }
    if (selected.some(row => row.advanceDate > advanceDateLimit(row.originalDate))) {
      setError('A data realizada precisa ser de um mês anterior ao da aula original.');
      return;
    }
    if (alreadyTaught && selected.some(row => row.advanceDate >= localYMD(new Date()))) {
      setError('Para contabilizar aulas já realizadas, informe somente datas anteriores a hoje.');
      return;
    }
    if (alreadyTaught && !window.confirm(`Confirmo que as ${selected.length} aulas selecionadas foram realizadas nas datas informadas. Elas serão contabilizadas nesse mês e as ocorrências originais ficarão bloqueadas, sem horário inventado.`)) return;
    setSaving(true);
    setError(null);
    const { error: createError } = await supabase.rpc(alreadyTaught ? 'settle_historical_lesson_advances' : 'create_lesson_advances', {
      p_student_id: studentId,
      p_reason: reason,
      p_entries: selected.map(row => ({
        booking_id: row.bookingId,
        original_date: row.originalDate,
        advance_date: row.advanceDate,
        ...(alreadyTaught ? {} : { advance_time: row.time }),
      })),
    });
    if (createError) {
      const messages: Record<string, string> = {
        lesson_advance_origin_must_be_future: 'Escolha uma aula original posterior a hoje. Atualize a lista de aulas.',
        lesson_advance_requires_previous_month: 'A data realizada precisa ser de um mês anterior ao da aula original.',
        lesson_advance_origin_not_a_booking_occurrence: 'A aula original não está mais disponível nessa data. Atualize a lista e confira a agenda do aluno.',
        historical_advance_actual_date_already_used: 'Já existe aula deste aluno na data realizada. Confira o histórico antes de contabilizar outra.',
        historical_advance_month_locked: 'O fechamento desse mês está protegido. Confira com o financeiro antes de alterar.',
        invalid_historical_advance_dates: 'Use datas realizadas nos últimos 120 dias e ocorrências futuras de outro mês.',
        lesson_advance_origin_already_used: 'Uma das aulas escolhidas já foi antecipada.',
        lesson_advance_actual_date_has_regular_occurrence: 'Esse agendamento já possui uma aula regular na data escolhida. Escolha outra data para antecipar esta ocorrência.',
        lesson_advance_actual_slot_conflict: 'Há outra antecipação nesse horário ou para o mesmo agendamento nessa data. Escolha outro horário/data.',
        lesson_advance_occurrence_already_logged: 'Uma dessas ocorrências já possui aula lançada. Peça à coordenação para conferir o histórico.',
      };
      setError(messages[createError.message] || createError.message);
    } else {
      setCandidates(current => current.map(row => ({ ...row, selected: false, advanceDate: '' })));
      await loadBase();
    }
    setSaving(false);
  };

  const cancel = async (id: string) => {
    if (!window.confirm('Cancelar esta antecipação? A ocorrência original voltará a ficar disponível.')) return;
    const { error: cancelError } = await supabase.rpc('cancel_lesson_advance', { p_advance_id: id });
    if (cancelError) setError(cancelError.message);
    else await loadBase();
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-col gap-3 border-b border-brand-border pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-widest text-tenant-primary"><Plane size={16} /> Aulas</div>
          <h2 className="text-3xl font-black tracking-tight text-brand-text">Antecipação de aulas</h2>
          <p className="mt-2 max-w-3xl text-sm text-brand-muted">Traga uma ocorrência futura para uma data anterior. O professor recebe no mês realizado e a aula original fica bloqueada.</p>
        </div>
        <button onClick={loadBase} className="flex items-center justify-center gap-2 rounded-xl border border-brand-border px-4 py-2 text-xs font-black text-brand-text"><RefreshCw size={14} /> Atualizar</button>
      </header>

      {error && <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-700">{error}</div>}

      <section data-tour="historical-lesson-advances" className="rounded-3xl border border-brand-border bg-brand-surface p-5 shadow-xs">
        <label className="mb-5 flex items-start gap-3 rounded-xl border border-brand-border p-3 text-sm text-brand-text">
          <input type="checkbox" checked={alreadyTaught} onChange={event => setAlreadyTaught(event.target.checked)} className="mt-1 h-4 w-4" />
          <span><strong>As aulas já foram realizadas e estão confirmadas pela direção</strong><br />Contabiliza pelas datas reais, sem inventar horário ou conteúdo, e bloqueia as aulas originais. Não use para aula ainda não realizada.</span>
        </label>
        <div className="grid gap-4 md:grid-cols-3">
          <label className="text-xs font-black uppercase tracking-wider text-brand-muted">Aluno
            <select value={studentId} onChange={event => setStudentId(event.target.value)} className="mt-2 w-full rounded-xl border border-brand-border bg-brand-surface-2 p-3 text-sm font-bold text-brand-text">
              <option value="">Selecione</option>
              {students.map(student => <option key={student.id} value={student.id}>{student.full_name}</option>)}
            </select>
          </label>
          <label className="text-xs font-black uppercase tracking-wider text-brand-muted">Mês de origem
            <input type="month" value={sourceMonth} min={localMonth()} onChange={event => setSourceMonth(event.target.value)} className="mt-2 w-full rounded-xl border border-brand-border bg-brand-surface-2 p-3 text-sm font-bold text-brand-text" />
          </label>
          <label className="text-xs font-black uppercase tracking-wider text-brand-muted">Motivo
            <input value={reason} maxLength={500} onChange={event => setReason(event.target.value)} className="mt-2 w-full rounded-xl border border-brand-border bg-brand-surface-2 p-3 text-sm font-bold text-brand-text" />
          </label>
        </div>

        {studentId && candidates.length === 0 && !loading && !candidatesLoading && !error && <p className="mt-6 rounded-2xl bg-amber-50 p-4 text-sm font-semibold text-amber-800">Não há aulas futuras disponíveis para antecipar neste mês. Aulas já antecipadas, lançadas ou excluídas não aparecem na lista.</p>}

        <p className="mt-4 text-sm text-brand-muted">Escolha uma aula original posterior a hoje e uma data realizada em mês anterior ao da aula original.</p>
        {candidatesLoading && <p role="status" className="mt-4 text-sm text-brand-muted">Consultando aulas disponíveis…</p>}

        {candidates.length > 0 && (
          <div className="mt-6 space-y-3">
            <div className="grid grid-cols-[auto_1fr_1fr] gap-3 px-2 text-[10px] font-black uppercase tracking-widest text-brand-muted"><span /><span>Aula original</span><span>Realizar em</span></div>
            {candidates.map((row, index) => (
              <div key={`${row.bookingId}-${row.originalDate}`} className={`grid grid-cols-[auto_1fr_1fr] items-center gap-3 rounded-2xl border p-3 ${row.selected ? 'border-tenant-primary bg-tenant-primary/5' : 'border-brand-border'}`}>
                <input aria-label={`Selecionar aula de ${formatLocalDateBr(row.originalDate)}`} type="checkbox" checked={row.selected} onChange={event => setRow(index, { selected: event.target.checked })} className="h-5 w-5 accent-tenant-primary" />
                <div><p className="text-sm font-black text-brand-text">{formatLocalDateBr(row.originalDate)} · {row.time}</p><p className="text-xs text-brand-muted">{row.teacherName}</p></div>
                <input aria-label={`Nova data da aula de ${formatLocalDateBr(row.originalDate)}`} type="date" disabled={!row.selected} max={advanceDateLimit(row.originalDate)} value={row.advanceDate} onChange={event => setRow(index, { advanceDate: event.target.value })} className="min-w-0 rounded-xl border border-brand-border bg-brand-surface-2 p-2 text-sm font-bold text-brand-text disabled:opacity-40" />
              </div>
            ))}
            <button disabled={saving || candidatesLoading || selected.length === 0} onClick={create} className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl bg-tenant-primary px-5 py-4 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-40">
              {saving ? <Loader2 className="animate-spin" size={18} /> : <CalendarArrowDown size={18} />} {alreadyTaught ? 'Contabilizar' : 'Criar'} {selected.length || ''} antecipação{selected.length === 1 ? '' : 'ões'}
            </button>
          </div>
        )}
      </section>

      <section className="rounded-3xl border border-brand-border bg-brand-surface p-5 shadow-xs">
        <h3 className="mb-4 text-lg font-black text-brand-text">Histórico recente</h3>
        {loading ? <Loader2 className="animate-spin text-tenant-primary" /> : existing.length === 0 ? <p className="text-sm text-brand-muted">Nenhuma antecipação registrada.</p> : (
          <div className="space-y-2">
            {existing.map(item => (
              <div key={item.id} className="flex flex-col gap-3 rounded-2xl border border-brand-border p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-black text-brand-text">{item.student?.full_name || 'Aluno'} · {item.teacher?.full_name || 'Professor'}</p>
                  <p className="text-xs text-brand-muted">{formatLocalDateBr(item.original_date)} → {formatLocalDateBr(item.advance_date)} · {item.advance_time ? `às ${String(item.advance_time).substring(0, 5)}` : 'Horário não informado'} · {item.reason}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`flex items-center gap-1 rounded-full px-3 py-1 text-[10px] font-black uppercase ${item.status === 'COMPLETED' ? 'bg-emerald-100 text-emerald-700' : item.status === 'CANCELLED' ? 'bg-slate-100 text-slate-500' : 'bg-blue-100 text-blue-700'}`}>
                    {item.status === 'COMPLETED' && <CheckCircle2 size={12} />}{item.status === 'COMPLETED' ? 'Realizada' : item.status === 'CANCELLED' ? 'Cancelada' : 'Agendada'}
                  </span>
                  {item.status === 'SCHEDULED' && <button onClick={() => cancel(item.id)} title="Cancelar antecipação" className="rounded-lg p-2 text-red-500 hover:bg-red-50"><XCircle size={18} /></button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

export default LessonAdvancesManager;
