import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarRange, CheckCircle2, Loader2, Plus, RefreshCw, Trash2, UserRoundCog, XCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { formatLocalDateBr } from '../lib/dateUtils';
import {
  HALF_HOUR_OPTIONS,
  STATE_LABELS,
  WEEKDAY_OPTIONS,
  assignmentErrorMessage,
  lessonsInSlot,
  planLabel,
  planSummary,
  slotsProblem,
  type AssignmentPreview,
  type AssignmentSlot,
  type TemporaryAssignment,
} from '../lib/temporaryAssignments';

interface Props {
  /** Dentro da ficha do aluno: o aluno já está escolhido e a lista é só dele. */
  lockedStudentId?: string;
}

interface StudentOption {
  id: string;
  name: string;
  titular_id: string | null;
  titular_name: string | null;
}

interface TeacherOption {
  id: string;
  name: string;
  lifecycle_status: string | null;
  can_assign: boolean;
}

const newRequestId = (): string => crypto.randomUUID();

const count = (value: number, singular: string, plural: string): string => `${value} ${value === 1 ? singular : plural}`;

const FIELD = 'mt-2 w-full rounded-xl border border-brand-border bg-brand-surface-2 p-3 text-sm font-bold text-brand-text';
const LABEL = 'text-xs font-black uppercase tracking-wider text-brand-muted';

const weekdayDate = (iso: string): string =>
  new Date(`${iso}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });

const Stat: React.FC<{ label: string; value: number; tone?: string }> = ({ label, value, tone = 'text-brand-text' }) => (
  <div className="rounded-xl border border-brand-border bg-brand-surface-2 px-3 py-2">
    <p className={`text-lg font-black ${tone}`}>{value}</p>
    <p className="text-[10px] font-black uppercase tracking-wide text-brand-muted">{label}</p>
  </div>
);

/**
 * Um professor assume reposições de um aluno por um período. A grade fixa e o
 * titular não mudam: o servidor gera reposições com data, e são elas que aparecem
 * na agenda do professor, no lançamento e na folha.
 */
const TemporaryAssignmentsPanel: React.FC<Props> = ({ lockedStudentId }) => {
  const [students, setStudents] = useState<StudentOption[]>([]);
  const [teachers, setTeachers] = useState<TeacherOption[]>([]);
  const [assignments, setAssignments] = useState<TemporaryAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [studentId, setStudentId] = useState(lockedStudentId ?? '');
  const [originalId, setOriginalId] = useState('');
  const [temporaryId, setTemporaryId] = useState('');
  const [slots, setSlots] = useState<AssignmentSlot[]>([{ day_of_week: 6, start: '10:30', end: '11:30' }]);
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [owed, setOwed] = useState('');
  const [reason, setReason] = useState('');
  const [notify, setNotify] = useState(true);

  const [previewState, setPreviewState] = useState<{ key: string; data: AssignmentPreview } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [endingId, setEndingId] = useState<string | null>(null);
  const [endReason, setEndReason] = useState('');
  const [endingBusy, setEndingBusy] = useState(false);
  const requestId = useRef(newRequestId());

  const load = async () => {
    setLoading(true);
    setError(null);
    const [optionsResult, listResult] = await Promise.all([
      supabase.rpc('temporary_assignment_options'),
      supabase.rpc('list_temporary_assignments', { p_student_id: lockedStudentId ?? null }),
    ]);
    if (optionsResult.error || listResult.error) {
      setError(assignmentErrorMessage(optionsResult.error?.message || listResult.error?.message));
    } else {
      setStudents((optionsResult.data?.students ?? []) as StudentOption[]);
      setTeachers((optionsResult.data?.teachers ?? []) as TeacherOption[]);
      setAssignments((listResult.data ?? []) as TemporaryAssignment[]);
    }
    setLoading(false);
  };

  useEffect(() => { void load(); }, [lockedStudentId]);

  // O que a direção confirma é sempre o plano dos dados que estão na tela: mudou
  // qualquer campo, a prévia deixa de valer.
  const inputsKey = (owedValue: string) => JSON.stringify({ studentId, originalId, temporaryId, slots, startsOn, endsOn, owed: owedValue });
  const preview = previewState?.key === inputsKey(owed) ? previewState.data : null;

  const lessonsPerWeek = useMemo(() => slots.reduce((sum, slot) => sum + lessonsInSlot(slot), 0), [slots]);
  const assignable = useMemo(() => teachers.filter(teacher => teacher.can_assign), [teachers]);
  const summary = useMemo(() => (preview ? planSummary(preview.occurrences) : null), [preview]);
  const selectedStudent = students.find(student => student.id === studentId);
  const slotProblem = slotsProblem(slots);
  const ready = !!(studentId && originalId && temporaryId && startsOn && endsOn) && !slotProblem;

  const setSlot = (index: number, patch: Partial<AssignmentSlot>) =>
    setSlots(current => current.map((slot, slotIndex) => (slotIndex === index ? { ...slot, ...patch } : slot)));

  const runPreview = async () => {
    if (!ready || previewing) return;
    setPreviewing(true);
    setError(null);
    setNotice(null);
    const { data, error: previewError } = await supabase.rpc('preview_temporary_assignment', {
      p_student_id: studentId,
      p_original_teacher_id: originalId,
      p_temporary_teacher_id: temporaryId,
      p_starts_on: startsOn,
      p_ends_on: endsOn,
      p_slots: slots,
      p_lessons_owed: owed ? Number(owed) : null,
    });
    if (previewError) {
      setError(assignmentErrorMessage(previewError.message));
    } else {
      const result = data as AssignmentPreview;
      const filledOwed = owed || String(result.owed);
      setOwed(filledOwed);
      setPreviewState({ key: inputsKey(filledOwed), data: result });
    }
    setPreviewing(false);
  };

  const create = async () => {
    if (!preview || saving) return;
    if (reason.trim().length < 3) {
      setError(assignmentErrorMessage('motivo_obrigatorio'));
      return;
    }
    setSaving(true);
    setError(null);
    const { data, error: createError } = await supabase.rpc('create_temporary_assignment', {
      p_student_id: studentId,
      p_original_teacher_id: originalId,
      p_temporary_teacher_id: temporaryId,
      p_starts_on: startsOn,
      p_ends_on: endsOn,
      p_slots: slots,
      p_lessons_owed: owed ? Number(owed) : null,
      p_reason: reason.trim(),
      p_request_id: requestId.current,
      p_notify: notify,
    });
    if (createError) {
      setError(assignmentErrorMessage(createError.message));
    } else {
      const absorbed = Number(data?.absorbed_credits ?? 0);
      setNotice(`${count(Number(data?.generated ?? 0), 'aula', 'aulas')} na agenda.${absorbed ? ` ${count(absorbed, 'reposição antiga sem data substituída', 'reposições antigas sem data substituídas')}.` : ''}`);
      requestId.current = newRequestId();
      setPreviewState(null);
      setReason('');
      setOwed('');
      if (!lockedStudentId) setStudentId('');
      await load();
    }
    setSaving(false);
  };

  const endAssignment = async () => {
    if (!endingId || endingBusy) return;
    if (endReason.trim().length < 3) {
      setError(assignmentErrorMessage('motivo_obrigatorio'));
      return;
    }
    setEndingBusy(true);
    setError(null);
    const { data, error: endError } = await supabase.rpc('end_temporary_assignment', {
      p_id: endingId,
      p_reason: endReason.trim(),
      p_notify: true,
    });
    if (endError) {
      setError(assignmentErrorMessage(endError.message));
    } else {
      setNotice(`Atribuição encerrada. ${count(Number(data?.closed ?? 0), 'aula futura saiu', 'aulas futuras saíram')} da agenda.`);
      setEndingId(null);
      setEndReason('');
      await load();
    }
    setEndingBusy(false);
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6" data-tour="temporary-assignments">
      {!lockedStudentId && (
        <header className="flex flex-col gap-3 border-b border-brand-border pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-black uppercase tracking-widest text-tenant-primary"><UserRoundCog size={16} /> Aulas</div>
            <h2 className="text-3xl font-black tracking-tight text-brand-text">Atribuição temporária</h2>
            <p className="mt-2 max-w-3xl text-sm text-brand-muted">Outro professor assume as reposições de um aluno por um período. A grade fixa e o professor titular não mudam.</p>
          </div>
          <button onClick={load} className="flex items-center justify-center gap-2 rounded-xl border border-brand-border px-4 py-2 text-xs font-black text-brand-text"><RefreshCw size={14} /> Atualizar</button>
        </header>
      )}

      {error && <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-700">{error}</div>}
      {notice && <div role="status" className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-bold text-emerald-700">{notice}</div>}

      <section className="rounded-3xl border border-brand-border bg-brand-surface p-5 shadow-xs">
        <h3 className="mb-4 text-lg font-black text-brand-text">Nova atribuição</h3>
        <div className="grid gap-4 md:grid-cols-3">
          {!lockedStudentId && (
            <label className={LABEL}>Aluno
              <select aria-label="Aluno" value={studentId} onChange={event => setStudentId(event.target.value)} className={FIELD}>
                <option value="">Selecione</option>
                {students.map(student => <option key={student.id} value={student.id}>{student.name}</option>)}
              </select>
            </label>
          )}
          <label className={LABEL}>Professor original
            <select aria-label="Professor original" value={originalId} onChange={event => setOriginalId(event.target.value)} className={FIELD}>
              <option value="">Selecione</option>
              {teachers.map(teacher => <option key={teacher.id} value={teacher.id}>{teacher.name}{teacher.can_assign ? '' : ' (inativo)'}</option>)}
            </select>
          </label>
          <label className={LABEL}>Professor temporário
            <select aria-label="Professor temporário" value={temporaryId} onChange={event => setTemporaryId(event.target.value)} className={FIELD}>
              <option value="">Selecione</option>
              {assignable.filter(teacher => teacher.id !== originalId).map(teacher => <option key={teacher.id} value={teacher.id}>{teacher.name}</option>)}
            </select>
          </label>
        </div>
        {selectedStudent?.titular_name && <p className="mt-2 text-xs text-brand-muted">Titular do aluno: {selectedStudent.titular_name}. Continua sendo.</p>}

        <div className="mt-5 space-y-3">
          <p className={LABEL}>Dias e horários</p>
          {slots.map((slot, index) => (
            <div key={index} className="grid grid-cols-2 items-end gap-3 rounded-2xl border border-brand-border p-3 sm:grid-cols-[1fr_1fr_1fr_auto]">
              <label className="text-[10px] font-black uppercase tracking-wider text-brand-muted">Dia
                <select aria-label={`Dia do horário ${index + 1}`} value={slot.day_of_week} onChange={event => setSlot(index, { day_of_week: Number(event.target.value) })} className={FIELD}>
                  {WEEKDAY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label className="text-[10px] font-black uppercase tracking-wider text-brand-muted">Início
                <select aria-label={`Início do horário ${index + 1}`} value={slot.start} onChange={event => setSlot(index, { start: event.target.value })} className={FIELD}>
                  {HALF_HOUR_OPTIONS.map(time => <option key={time} value={time}>{time}</option>)}
                </select>
              </label>
              <label className="text-[10px] font-black uppercase tracking-wider text-brand-muted">Fim
                <select aria-label={`Fim do horário ${index + 1}`} value={slot.end} onChange={event => setSlot(index, { end: event.target.value })} className={FIELD}>
                  {HALF_HOUR_OPTIONS.map(time => <option key={time} value={time}>{time}</option>)}
                </select>
              </label>
              <button type="button" aria-label={`Remover horário ${index + 1}`} disabled={slots.length === 1} onClick={() => setSlots(current => current.filter((_, slotIndex) => slotIndex !== index))} className="flex h-11 items-center justify-center rounded-xl border border-brand-border px-3 text-brand-muted hover:text-red-500 disabled:opacity-30"><Trash2 size={16} /></button>
            </div>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button type="button" onClick={() => setSlots(current => [...current, { day_of_week: 6, start: '10:30', end: '11:30' }])} className="flex items-center gap-2 rounded-xl border border-brand-border px-3 py-2 text-xs font-black text-brand-text"><Plus size={14} /> Outro horário</button>
            <p className="text-xs font-bold text-brand-muted">{count(lessonsPerWeek, 'aula', 'aulas')} de 30 min por semana</p>
          </div>
          {slotProblem && <p className="text-xs font-bold text-red-600">{slotProblem}</p>}
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-3">
          <label className={LABEL}>Início
            <input aria-label="Início do período" type="date" value={startsOn} onChange={event => setStartsOn(event.target.value)} className={FIELD} />
          </label>
          <label className={LABEL}>Fim
            <input aria-label="Fim do período" type="date" value={endsOn} min={startsOn || undefined} onChange={event => setEndsOn(event.target.value)} className={FIELD} />
          </label>
          <label className={LABEL}>Total de aulas pendentes
            <input aria-label="Total de aulas pendentes" type="number" min={1} max={500} value={owed} placeholder="Opcional" onChange={event => setOwed(event.target.value)} className={FIELD} />
            <span className="mt-1 block text-[11px] font-medium normal-case tracking-normal text-brand-muted">Em aulas de 30 min. O sistema não gera mais do que esse total.</span>
          </label>
        </div>

        <button type="button" disabled={!ready || previewing} onClick={runPreview} className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl border border-tenant-primary px-5 py-3 text-sm font-black text-tenant-primary disabled:cursor-not-allowed disabled:opacity-40">
          {previewing ? <Loader2 className="animate-spin" size={18} /> : <CalendarRange size={18} />} Ver as aulas
        </button>

        {preview && summary && (
          <div className="mt-5 space-y-4 rounded-2xl border border-brand-border bg-brand-surface-2/50 p-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Vão para a agenda" value={summary.entram} tone="text-emerald-600" />
              <Stat label="Fora do plano" value={summary.foraDoPlano} tone={summary.foraDoPlano ? 'text-amber-600' : 'text-brand-text'} />
              <Stat label="Saldo total" value={preview.owed} />
              <Stat label="Ficam sem professor" value={Math.max(preview.owed - preview.pool.distribuidas - summary.entram, 0)} />
            </div>

            {preview.term_pending && <p className="rounded-xl bg-amber-50 p-3 text-sm font-semibold text-amber-800">Falta o termo individual deste professor com este aluno. Assine em Contratos, Termos por aluno, antes de gerar as aulas.</p>}
            {preview.open_credits > 0 && <p className="rounded-xl bg-blue-50 p-3 text-sm font-semibold text-blue-800">{count(preview.open_credits, 'reposição sem data', 'reposições sem data')} no nome do professor original. As aulas geradas substituem essas reposições, para não contar em dobro. Se a atribuição for encerrada antes, elas voltam a ficar abertas.</p>}
            {preview.pool.distribuidas > 0 && <p className="rounded-xl bg-blue-50 p-3 text-sm font-semibold text-blue-800">{count(preview.pool.distribuidas, 'aula deste saldo já distribuída', 'aulas deste saldo já distribuídas')} em atribuições anteriores.</p>}
            {summary.foraDaGrade > 0 && <p className="rounded-xl bg-amber-50 p-3 text-sm font-semibold text-amber-800">{count(summary.foraDaGrade, 'aula fora', 'aulas fora')} da grade declarada do professor. Confirme com o professor antes.</p>}

            <div className="grid max-h-80 gap-2 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
              {preview.occurrences.map(occurrence => (
                <div key={`${occurrence.date}-${occurrence.time}`} className={`rounded-xl border p-3 ${occurrence.status === 'OK' ? 'border-emerald-200' : 'border-amber-200 bg-amber-50/60'}`}>
                  <p className="text-sm font-black text-brand-text">{weekdayDate(occurrence.date)} · {occurrence.time}</p>
                  <p className="text-xs text-brand-muted">{planLabel(occurrence)}</p>
                </div>
              ))}
            </div>

            <p className="text-sm text-brand-text">Cada aula dada entra na folha de quem assumiu, como reposição, pelo valor normal. Falta de quem assumiu não paga e a aula continua no saldo.</p>

            <label className={LABEL}>Motivo (só a direção e a coordenação veem)
              <input aria-label="Motivo" value={reason} maxLength={500} onChange={event => setReason(event.target.value)} className={FIELD} />
            </label>
            <label className="flex items-start gap-3 rounded-xl border border-brand-border p-3 text-sm text-brand-text">
              <input type="checkbox" checked={notify} onChange={event => setNotify(event.target.checked)} className="mt-1 h-4 w-4" />
              <span>Avisar pelo WhatsApp o professor temporário, a família e a coordenação. Uma mensagem para cada, com os dias e o horário.</span>
            </label>
            <button type="button" disabled={saving || summary.entram === 0} onClick={create} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-tenant-primary px-5 py-4 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-40">
              {saving ? <Loader2 className="animate-spin" size={18} /> : <CheckCircle2 size={18} />} Gerar {count(summary.entram, 'aula', 'aulas')} na agenda
            </button>
          </div>
        )}
      </section>

      <section className="rounded-3xl border border-brand-border bg-brand-surface p-5 shadow-xs">
        <h3 className="mb-4 text-lg font-black text-brand-text">Atribuições</h3>
        {loading ? <Loader2 className="animate-spin text-tenant-primary" /> : assignments.length === 0 ? <p className="text-sm text-brand-muted">Nenhuma atribuição temporária registrada.</p> : (
          <div className="space-y-4">
            {assignments.map(item => (
              <article key={item.id} className="rounded-2xl border border-brand-border p-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-black text-brand-text">{item.student_name}</p>
                    <p className="text-xs text-brand-muted">De {item.original_teacher_name} para {item.temporary_teacher_name} · {item.slots_text}</p>
                    <p className="text-xs text-brand-muted">{formatLocalDateBr(item.starts_on)} a {formatLocalDateBr(item.ends_on)} · {item.status === 'ACTIVE' ? 'encerra sozinha depois da última aula' : item.ended_automatically ? 'encerrada no fim do período' : `encerrada por ${item.ended_by_name || 'direção'}`}</p>
                    <p className="mt-1 text-xs text-brand-muted">Motivo: {item.reason}{item.end_reason && item.status === 'ENDED' && !item.ended_automatically ? ` · Encerramento: ${item.end_reason}` : ''}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className={`rounded-full px-3 py-1 text-[10px] font-black uppercase ${item.status === 'ACTIVE' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>{item.status === 'ACTIVE' ? 'Ativa' : 'Encerrada'}</span>
                    {item.status === 'ACTIVE' && (
                      <button type="button" onClick={() => { setEndingId(item.id); setEndReason(''); }} className="flex items-center gap-1 rounded-lg border border-red-200 px-2 py-1 text-[11px] font-black text-red-600"><XCircle size={14} /> Encerrar</button>
                    )}
                  </div>
                </div>

                {item.status === 'ACTIVE' && !item.participants_active && <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm font-semibold text-amber-800">O aluno ou o professor temporário não está mais ativo. As aulas não podem ser lançadas enquanto isso não mudar. Encerre a atribuição se ela não vale mais.</p>}

                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                  <Stat label="Realizadas" value={item.counts.realizadas} tone="text-emerald-600" />
                  <Stat label="Agendadas" value={item.counts.agendadas} />
                  <Stat label="A lançar" value={item.counts.a_lancar + item.counts.sem_data} tone={item.counts.a_lancar + item.counts.sem_data ? 'text-amber-600' : 'text-brand-text'} />
                  <Stat label="Aluno faltou" value={item.counts.aluno_faltou} />
                  <Stat label="Professor faltou" value={item.counts.professor_faltou} />
                  <Stat label="Canceladas" value={item.counts.canceladas} />
                </div>
                <p className="mt-3 text-sm font-bold text-brand-text">
                  Saldo do aluno com {item.original_teacher_name}: {item.pool.pendentes} de {item.pool.owed} ainda pendentes
                  {item.pool.sem_professor > 0 ? `, ${item.pool.sem_professor} sem professor definido.` : '.'}
                </p>

                {item.occurrences.length > 0 && (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs font-black text-tenant-primary">Ver {count(item.occurrences.length, 'aula', 'aulas')}</summary>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {item.occurrences.map(occurrence => (
                        <div key={occurrence.id} className="flex items-center justify-between gap-2 rounded-xl border border-brand-border px-3 py-2 text-xs">
                          <span className="font-bold text-brand-text">{occurrence.state === 'sem_data' ? 'Sem data' : `${weekdayDate(occurrence.date)} · ${occurrence.time}`}</span>
                          <span className="font-black text-brand-muted">{STATE_LABELS[occurrence.state]}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                {endingId === item.id && (
                  <div className="mt-3 space-y-2 rounded-xl border border-red-200 bg-red-50/60 p-3">
                    <p className="text-sm text-brand-text">As aulas que ainda não aconteceram saem da agenda. Aula que já passou continua disponível para o professor lançar. O professor, a família e a coordenação são avisados.</p>
                    <input aria-label="Motivo do encerramento" value={endReason} maxLength={500} placeholder="Motivo do encerramento" onChange={event => setEndReason(event.target.value)} className={FIELD} />
                    <div className="flex justify-end gap-2">
                      <button type="button" onClick={() => setEndingId(null)} className="rounded-xl px-3 py-2 text-xs font-black text-brand-muted">Voltar</button>
                      <button type="button" disabled={endingBusy} onClick={endAssignment} className="flex items-center gap-2 rounded-xl bg-red-600 px-3 py-2 text-xs font-black text-white disabled:opacity-40">
                        {endingBusy && <Loader2 className="animate-spin" size={14} />} Encerrar atribuição
                      </button>
                    </div>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

export default TemporaryAssignmentsPanel;
