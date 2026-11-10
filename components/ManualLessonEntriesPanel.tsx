import React, { useEffect, useState } from 'react';
import { ClipboardCheck, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { formatLocalDateBr } from '../lib/dateUtils';
import {
  MANUAL_LESSON_KINDS,
  draftProblem,
  kindLabel,
  manualLessonErrorMessage,
  money,
  parseRate,
  type ManualLessonDraft,
  type ManualLessonEntry,
} from '../lib/manualLessons';

interface Option { id: string; name: string }

const FIELD = 'mt-2 w-full rounded-xl border border-brand-border bg-brand-surface-2 p-3 text-sm font-bold text-brand-text';
const LABEL = 'text-xs font-black uppercase tracking-wider text-brand-muted';

const currentMonth = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

const EMPTY: ManualLessonDraft = {
  teacherId: '', kind: '', date: '', time: '', units: 1,
  personMode: 'guest', studentId: '', guestName: '', reason: '', rate: '',
};

/**
 * Baixa manual de aulas: a direção lança na folha uma aula que não passou pelos
 * fluxos normais (prova oral de quem não é aluno, experimental fora do sistema,
 * reposição deixada por outro professor). Vira um lançamento de aula pago pela
 * régua de quem deu a aula, com o motivo guardado para a direção.
 */
const ManualLessonEntriesPanel: React.FC = () => {
  const [teachers, setTeachers] = useState<Option[]>([]);
  const [students, setStudents] = useState<Option[]>([]);
  const [entries, setEntries] = useState<ManualLessonEntry[]>([]);
  const [month, setMonth] = useState(currentMonth());
  const [draft, setDraft] = useState<ManualLessonDraft>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelBusy, setCancelBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    const [options, list] = await Promise.all([
      supabase.rpc('manual_lesson_options'),
      supabase.rpc('list_manual_lesson_entries', { p_month: month }),
    ]);
    if (options.error || list.error) {
      setError(manualLessonErrorMessage(options.error?.message || list.error?.message));
    } else {
      setTeachers((options.data?.teachers ?? []) as Option[]);
      setStudents((options.data?.students ?? []) as Option[]);
      setEntries((list.data ?? []) as ManualLessonEntry[]);
    }
    setLoading(false);
  };

  useEffect(() => { void load(); }, [month]);

  const set = (patch: Partial<ManualLessonDraft>) => setDraft(current => ({ ...current, ...patch }));
  const problem = draftProblem(draft);

  const submit = async () => {
    if (problem || saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    const { data, error: rpcError } = await supabase.rpc('create_manual_lesson_entry', {
      p_teacher_id: draft.teacherId,
      p_kind: draft.kind,
      p_class_date: draft.date,
      p_start_time: draft.time,
      p_units: draft.units,
      p_student_id: draft.personMode === 'student' ? draft.studentId : null,
      p_guest_name: draft.personMode === 'guest' ? draft.guestName.trim() : null,
      p_reason: draft.reason.trim(),
      p_rate_override: parseRate(draft.rate),
    });
    setSaving(false);
    if (rpcError) {
      setError(manualLessonErrorMessage(rpcError.message));
      return;
    }
    const valor = Number((data as { valor?: number } | null)?.valor ?? 0);
    setNotice(`Baixa lançada. Entra na folha do professor: ${money(valor)}.`);
    setDraft(EMPTY);
    if (draft.date.slice(0, 7) !== month) setMonth(draft.date.slice(0, 7));
    else void load();
  };

  const confirmCancel = async () => {
    if (!cancelId || cancelReason.trim().length < 10 || cancelBusy) return;
    setCancelBusy(true);
    setError(null);
    const { error: rpcError } = await supabase.rpc('cancel_manual_lesson_entry', {
      p_entry_id: cancelId, p_reason: cancelReason.trim(),
    });
    setCancelBusy(false);
    if (rpcError) {
      setError(manualLessonErrorMessage(rpcError.message));
      return;
    }
    setCancelId(null);
    setCancelReason('');
    setNotice('Baixa cancelada. O lançamento saiu da folha.');
    void load();
  };

  const total = entries.filter(entry => !entry.cancelled_at).reduce((sum, entry) => sum + Number(entry.valor || 0), 0);

  return (
    <div className="mx-auto max-w-6xl space-y-6" data-tour="manual-lessons">
      <header className="flex flex-col gap-3 border-b border-brand-border pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-widest text-tenant-primary"><ClipboardCheck size={16} /> Dinheiro</div>
          <h2 className="text-3xl font-black tracking-tight text-brand-text">Baixa manual de aulas</h2>
          <p className="mt-2 max-w-3xl text-sm text-brand-muted">
            Para a aula que não passou pelos fluxos normais: teste oral de quem não é aluno, experimental fora do sistema,
            reposição deixada por outro professor. Vira um lançamento de aula na folha do professor, pela tarifa dele.
            Reposição de aluno que ainda vai acontecer se agenda em Atribuição temporária.
          </p>
        </div>
        <button onClick={load} className="flex items-center justify-center gap-2 rounded-xl border border-brand-border px-4 py-2 text-xs font-black text-brand-text"><RefreshCw size={14} /> Atualizar</button>
      </header>

      {error && <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-700">{error}</div>}
      {notice && <div role="status" className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-bold text-emerald-700">{notice}</div>}

      <section className="rounded-3xl border border-brand-border bg-brand-surface p-5 shadow-xs" data-tour="manual-lessons-form">
        <h3 className="mb-4 text-lg font-black text-brand-text">Nova baixa</h3>
        <div className="grid gap-4 md:grid-cols-3">
          <label className={LABEL}>Professor
            <select aria-label="Professor" value={draft.teacherId} onChange={event => set({ teacherId: event.target.value })} className={FIELD}>
              <option value="">Selecione</option>
              {teachers.map(teacher => <option key={teacher.id} value={teacher.id}>{teacher.name}</option>)}
            </select>
          </label>
          <label className={LABEL}>Tipo
            <select aria-label="Tipo" value={draft.kind} onChange={event => set({ kind: event.target.value as ManualLessonDraft['kind'] })} className={FIELD}>
              <option value="">Selecione</option>
              {MANUAL_LESSON_KINDS.map(kind => <option key={kind.value} value={kind.value}>{kind.label}</option>)}
            </select>
          </label>
          <label className={LABEL}>Duração
            <select aria-label="Duração" value={draft.units} onChange={event => set({ units: Number(event.target.value) })} className={FIELD}>
              <option value={1}>30 min</option>
              <option value={2}>1 hora</option>
              <option value={3}>1h30</option>
              <option value={4}>2 horas</option>
            </select>
          </label>
          <label className={LABEL}>Data
            <input aria-label="Data" type="date" value={draft.date} onChange={event => set({ date: event.target.value })} className={FIELD} />
          </label>
          <label className={LABEL}>Horário
            <input aria-label="Horário" type="time" step={1800} value={draft.time} onChange={event => set({ time: event.target.value })} className={FIELD} />
          </label>
          <label className={LABEL}>Valor por 30 min
            <input aria-label="Valor por 30 min" inputMode="decimal" placeholder="Tarifa normal" value={draft.rate} onChange={event => set({ rate: event.target.value })} className={FIELD} />
            <span className="mt-1 block text-[11px] font-medium normal-case tracking-normal text-brand-muted">Em branco, a folha usa a tarifa do professor.</span>
          </label>
        </div>

        <fieldset className="mt-5">
          <legend className={LABEL}>Quem fez a aula</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" aria-pressed={draft.personMode === 'guest'} onClick={() => set({ personMode: 'guest', studentId: '' })} className={`rounded-xl border px-3 py-2 text-xs font-black ${draft.personMode === 'guest' ? 'border-tenant-primary text-tenant-primary' : 'border-brand-border text-brand-muted'}`}>Não é aluno</button>
            <button type="button" aria-pressed={draft.personMode === 'student'} onClick={() => set({ personMode: 'student', guestName: '' })} className={`rounded-xl border px-3 py-2 text-xs font-black ${draft.personMode === 'student' ? 'border-tenant-primary text-tenant-primary' : 'border-brand-border text-brand-muted'}`}>Aluno da escola</button>
          </div>
          {draft.personMode === 'student' ? (
            <select aria-label="Aluno" value={draft.studentId} onChange={event => set({ studentId: event.target.value })} className={FIELD}>
              <option value="">Selecione</option>
              {students.map(student => <option key={student.id} value={student.id}>{student.name}</option>)}
            </select>
          ) : (
            <input aria-label="Nome de quem fez a aula" maxLength={120} placeholder="Nome completo" value={draft.guestName} onChange={event => set({ guestName: event.target.value })} className={FIELD} />
          )}
        </fieldset>

        <label className={`${LABEL} mt-5 block`}>Motivo (obrigatório)
          <textarea aria-label="Motivo" rows={3} maxLength={500} value={draft.reason} onChange={event => set({ reason: event.target.value })} placeholder="Por que esta aula entra por baixa manual" className={FIELD} />
          <span className="mt-1 block text-[11px] font-medium normal-case tracking-normal text-brand-muted">Fica com a direção e a coordenação. O professor vê só "Baixa manual pela direção" e o tipo.</span>
        </label>

        {problem && (draft.teacherId || draft.kind || draft.reason) && <p className="mt-3 text-xs font-bold text-amber-700">{problem}</p>}

        <button type="button" disabled={!!problem || saving} onClick={submit} className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-tenant-primary px-5 py-3 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-40">
          {saving ? <Loader2 className="animate-spin" size={18} /> : <ClipboardCheck size={18} />} Lançar na folha
        </button>
      </section>

      <section className="rounded-3xl border border-brand-border bg-brand-surface p-5 shadow-xs" data-tour="manual-lessons-list">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <h3 className="text-lg font-black text-brand-text">Baixas do mês</h3>
          <div className="flex items-end gap-4">
            <p className="text-sm font-bold text-brand-muted">Total na folha: <span className="text-brand-text">{money(total)}</span></p>
            <input aria-label="Mês" type="month" value={month} onChange={event => event.target.value && setMonth(event.target.value)} className="rounded-xl border border-brand-border bg-brand-surface-2 p-2 text-sm font-bold text-brand-text" />
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center p-8"><Loader2 className="animate-spin text-brand-muted" /></div>
        ) : entries.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-brand-border p-6 text-center text-sm text-brand-muted">Nenhuma baixa manual neste mês.</p>
        ) : (
          <ul className="space-y-3">
            {entries.map(entry => (
              <li key={entry.id} className={`rounded-2xl border border-brand-border p-4 ${entry.cancelled_at ? 'opacity-60' : ''}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-black text-brand-text">
                      {kindLabel(entry.kind)} · {entry.student_name ?? entry.guest_name}
                      {!entry.student_id && <span className="ml-2 rounded-full bg-brand-surface-2 px-2 py-0.5 text-[10px] font-black uppercase text-brand-muted">não é aluno</span>}
                    </p>
                    <p className="text-xs text-brand-muted">
                      {entry.teacher_name} · {formatLocalDateBr(entry.class_date)} às {entry.start_time} · {entry.units * 30} min
                      {entry.rate_override != null && ` · ${money(Number(entry.rate_override))} por 30 min`}
                    </p>
                    <p className="mt-2 text-xs text-brand-text"><span className="font-black">Motivo:</span> {entry.reason}</p>
                    <p className="mt-1 text-[11px] text-brand-muted">Lançada por {entry.created_by_name ?? '—'} em {new Date(entry.created_at).toLocaleString('pt-BR')}</p>
                    {entry.cancelled_at && (
                      <p className="mt-1 text-[11px] font-bold text-red-600">Cancelada por {entry.cancelled_by_name ?? '—'}: {entry.cancel_reason}</p>
                    )}
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-black text-brand-text">{entry.cancelled_at ? '—' : money(Number(entry.valor))}</p>
                    {!entry.cancelled_at && !entry.month_closed && cancelId !== entry.id && (
                      <button type="button" onClick={() => { setCancelId(entry.id); setCancelReason(''); }} className="mt-2 flex items-center gap-1 text-xs font-black text-red-600"><XCircle size={14} /> Cancelar</button>
                    )}
                    {entry.month_closed && !entry.cancelled_at && <p className="mt-2 text-[11px] font-bold text-brand-muted">Mês fechado</p>}
                  </div>
                </div>
                {cancelId === entry.id && (
                  <div className="mt-3 space-y-2 rounded-xl border border-red-200 bg-red-50 p-3">
                    <textarea aria-label="Motivo do cancelamento" rows={2} value={cancelReason} onChange={event => setCancelReason(event.target.value)} placeholder="Por que cancelar (pelo menos 10 letras)" className="w-full rounded-lg border border-red-200 p-2 text-sm" />
                    <div className="flex gap-2">
                      <button type="button" disabled={cancelReason.trim().length < 10 || cancelBusy} onClick={confirmCancel} className="rounded-lg bg-red-600 px-3 py-2 text-xs font-black text-white disabled:opacity-40">{cancelBusy ? 'Cancelando…' : 'Confirmar cancelamento'}</button>
                      <button type="button" onClick={() => setCancelId(null)} className="rounded-lg border border-brand-border px-3 py-2 text-xs font-black text-brand-text">Voltar</button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};

export default ManualLessonEntriesPanel;
