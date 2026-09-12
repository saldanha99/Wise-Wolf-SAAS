import React, { useEffect, useMemo, useState } from 'react';
import { CalendarArrowDown, CheckCircle2, Loader2, Plane, RefreshCw, XCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { formatLocalDateBr, localMonth, localYMD, monthRange, parseLocalDate } from '../lib/dateUtils';
import { normalizeWeekdayToIndex } from '../lib/weekday';

interface Props {
  tenantId?: string;
}

interface Booking {
  id: string;
  teacher_id: string;
  day_of_week: string;
  time_slot: string;
  start_date: string | null;
  teacher: { full_name?: string } | null;
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

export const occurrencesForMonth = (bookings: Booking[], month: string): Candidate[] => {
  const range = monthRange(month);
  const start = parseLocalDate(range.start);
  const end = parseLocalDate(range.endExclusive);
  if (!start || !end) return [];
  const rows: Candidate[] = [];
  for (const booking of bookings) {
    const weekday = normalizeWeekdayToIndex(booking.day_of_week) + 1;
    if (weekday < 1 || weekday > 6) continue;
    for (const cursor = new Date(start); cursor < end; cursor.setDate(cursor.getDate() + 1)) {
      const date = localYMD(cursor);
      if (cursor.getDay() !== weekday || (booking.start_date && date < booking.start_date)) continue;
      rows.push({
        bookingId: booking.id,
        originalDate: date,
        time: String(booking.time_slot || '').substring(0, 5),
        teacherName: booking.teacher?.full_name || 'Professor',
        selected: false,
        advanceDate: '',
      });
    }
  }
  return rows.sort((a, b) => a.originalDate.localeCompare(b.originalDate) || a.time.localeCompare(b.time));
};

const LessonAdvancesManager: React.FC<Props> = ({ tenantId }) => {
  const [students, setStudents] = useState<any[]>([]);
  const [studentId, setStudentId] = useState('');
  const [sourceMonth, setSourceMonth] = useState(nextMonth);
  const [reason, setReason] = useState('Viagem');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [existing, setExisting] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadBase = async () => {
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
      return;
    }
    let active = true;
    void (async () => {
      const { data, error: bookingError } = await supabase.from('bookings')
        .select('id, teacher_id, day_of_week, time_slot, start_date, teacher:teacher_id(full_name)')
        .eq('tenant_id', tenantId).eq('student_id', studentId).in('status', ['SCHEDULED', 'scheduled']);
      if (!active) return;
      if (bookingError) {
        setError(bookingError.message);
        setCandidates([]);
      } else {
        setCandidates(occurrencesForMonth((data || []) as unknown as Booking[], sourceMonth));
      }
    })();
    return () => { active = false; };
  }, [tenantId, studentId, sourceMonth]);

  const selected = useMemo(() => candidates.filter(row => row.selected), [candidates]);
  const setRow = (index: number, patch: Partial<Candidate>) => {
    setCandidates(current => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  };

  const create = async () => {
    if (!studentId || selected.length === 0) return;
    if (selected.some(row => !row.advanceDate || row.advanceDate >= row.originalDate)) {
      setError('Informe uma data anterior válida para cada aula selecionada.');
      return;
    }
    setSaving(true);
    setError(null);
    const { error: createError } = await supabase.rpc('create_lesson_advances', {
      p_student_id: studentId,
      p_reason: reason,
      p_entries: selected.map(row => ({
        booking_id: row.bookingId,
        original_date: row.originalDate,
        advance_date: row.advanceDate,
        advance_time: row.time,
      })),
    });
    if (createError) {
      setError(createError.message === 'lesson_advance_origin_already_used'
        ? 'Uma das aulas escolhidas já foi antecipada.' : createError.message);
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

      <section className="rounded-3xl border border-brand-border bg-brand-surface p-5 shadow-sm">
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

        {studentId && candidates.length === 0 && !loading && <p className="mt-6 rounded-2xl bg-amber-50 p-4 text-sm font-semibold text-amber-800">Não há ocorrências recorrentes para este aluno no mês escolhido.</p>}

        {candidates.length > 0 && (
          <div className="mt-6 space-y-3">
            <div className="grid grid-cols-[auto_1fr_1fr] gap-3 px-2 text-[10px] font-black uppercase tracking-widest text-brand-muted"><span /><span>Aula original</span><span>Realizar em</span></div>
            {candidates.map((row, index) => (
              <div key={`${row.bookingId}-${row.originalDate}`} className={`grid grid-cols-[auto_1fr_1fr] items-center gap-3 rounded-2xl border p-3 ${row.selected ? 'border-tenant-primary bg-tenant-primary/5' : 'border-brand-border'}`}>
                <input aria-label={`Selecionar aula de ${formatLocalDateBr(row.originalDate)}`} type="checkbox" checked={row.selected} onChange={event => setRow(index, { selected: event.target.checked })} className="h-5 w-5 accent-tenant-primary" />
                <div><p className="text-sm font-black text-brand-text">{formatLocalDateBr(row.originalDate)} · {row.time}</p><p className="text-xs text-brand-muted">{row.teacherName}</p></div>
                <input aria-label={`Nova data da aula de ${formatLocalDateBr(row.originalDate)}`} type="date" disabled={!row.selected} max={row.originalDate} value={row.advanceDate} onChange={event => setRow(index, { advanceDate: event.target.value })} className="min-w-0 rounded-xl border border-brand-border bg-brand-surface-2 p-2 text-sm font-bold text-brand-text disabled:opacity-40" />
              </div>
            ))}
            <button disabled={saving || selected.length === 0} onClick={create} className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl bg-tenant-primary px-5 py-4 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-40">
              {saving ? <Loader2 className="animate-spin" size={18} /> : <CalendarArrowDown size={18} />} Criar {selected.length || ''} antecipação{selected.length === 1 ? '' : 'ões'}
            </button>
          </div>
        )}
      </section>

      <section className="rounded-3xl border border-brand-border bg-brand-surface p-5 shadow-sm">
        <h3 className="mb-4 text-lg font-black text-brand-text">Histórico recente</h3>
        {loading ? <Loader2 className="animate-spin text-tenant-primary" /> : existing.length === 0 ? <p className="text-sm text-brand-muted">Nenhuma antecipação registrada.</p> : (
          <div className="space-y-2">
            {existing.map(item => (
              <div key={item.id} className="flex flex-col gap-3 rounded-2xl border border-brand-border p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-black text-brand-text">{item.student?.full_name || 'Aluno'} · {item.teacher?.full_name || 'Professor'}</p>
                  <p className="text-xs text-brand-muted">{formatLocalDateBr(item.original_date)} → {formatLocalDateBr(item.advance_date)} às {String(item.advance_time).substring(0, 5)} · {item.reason}</p>
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
