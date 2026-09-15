import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CalendarClock, Check, Clock, RefreshCw, Save, X } from 'lucide-react';
import { supabase } from '../lib/supabase';

interface TeacherStudentScheduleEditorProps {
  studentId: string;
  studentName: string;
  tenantId: string;
  teacherId: string;
  onClose: () => void;
  onChanged?: () => void;
}

interface BookingRow {
  id: string;
  day_of_week: string;
  time_slot: string;
}

interface BookingDraft extends BookingRow {
  originalDay: string;
  originalTime: string;
}

const DAYS = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const tomorrow = () => { const date = new Date(); date.setDate(date.getDate() + 1); return date.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); };
const formatDate = (value: string) => new Date(`${value}T12:00:00`).toLocaleDateString('pt-BR');

const friendlyScheduleError = (message: string) => {
  const knownMessages = [
    'Você só pode alterar alunos da sua própria agenda.',
    'O professor já possui uma aula nesse dia e horário.',
    'O aluno já possui uma aula nesse dia e horário.',
    'Escolha um horário em intervalos de 30 minutos.',
    'Somente aulas fixas ativas podem ter o horário alterado.',
    'Já existe uma troca programada para esta aula a partir dessa data.',
    'A troca vale a partir de amanhã, no máximo em um ano.',
    'Informe o motivo da troca (mínimo de 8 caracteres).',
  ];
  const conflict = message.match(/Choque de agenda[^.]*\./);
  if (conflict) return conflict[0];
  if (/inactive_student_scheduled_booking_forbidden/.test(message)) return 'O aluno está inativo. Fale com a coordenação antes de trocar o horário.';
  if (/schedule_change_one_pending|duplicate key/.test(message)) return 'Já existe uma proposta pendente para esta aula. Aguarde a revisão da escola.';
  if (/original_occurrence|one_off|occurrence_already/.test(message)) return 'Confira a data original e a proposta. A data original precisa corresponder a uma aula futura da agenda.';
  return knownMessages.find(known => message.includes(known)) || 'Não foi possível salvar. Confira a data, o horário e o motivo (mínimo de 8 caracteres).';
};

const TeacherStudentScheduleEditor: React.FC<TeacherStudentScheduleEditorProps> = ({
  studentId,
  studentName,
  tenantId,
  teacherId,
  onClose,
  onChanged,
}) => {
  const [bookings, setBookings] = useState<BookingDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [successId, setSuccessId] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState('');
  const [error, setError] = useState('');
  const [scope, setScope] = useState<'PERMANENT' | 'ONE_OFF'>('PERMANENT');
  const [effectiveFrom, setEffectiveFrom] = useState(tomorrow);
  const [originalDate, setOriginalDate] = useState('');
  const [proposedDate, setProposedDate] = useState('');
  const [reason, setReason] = useState('');
  const [initiatedBy, setInitiatedBy] = useState('TEACHER');

  const loadBookings = async () => {
    setLoading(true);
    setError('');
    const { data, error: queryError } = await supabase
      .from('bookings')
      .select('id, day_of_week, time_slot')
      .eq('student_id', studentId)
      .eq('teacher_id', teacherId)
      .eq('tenant_id', tenantId)
      .in('status', ['SCHEDULED', 'scheduled'])
      .order('day_of_week')
      .order('time_slot');

    if (queryError) {
      setError('Não foi possível carregar a agenda deste aluno.');
      setBookings([]);
    } else {
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
      const snapshots = await Promise.all(((data || []) as BookingRow[]).map(item => supabase.rpc('booking_schedule_on_date', { p_booking_id: item.id, p_date: today })));
      setBookings(((data || []) as BookingRow[]).map((item, index) => {
        const schedule = snapshots[index].data;
        const day = schedule?.day_of_week || item.day_of_week;
        const canonicalDay = day === 'Terca' ? 'Terça' : day;
        const time = String(schedule?.time_slot || item.time_slot).slice(0, 5);
        return {
          ...item,
          day_of_week: canonicalDay,
          time_slot: time,
          originalDay: canonicalDay,
          originalTime: time,
        };
      }));
    }
    setLoading(false);
  };

  useEffect(() => {
    void loadBookings();
  }, [studentId, teacherId, tenantId]);

  const changedBookings = useMemo(
    () => bookings.filter(item => item.day_of_week !== item.originalDay || item.time_slot !== item.originalTime),
    [bookings],
  );

  const updateDraft = (id: string, patch: Partial<Pick<BookingDraft, 'day_of_week' | 'time_slot'>>) => {
    setError('');
    setSuccessId(null);
    setApplied('');
    setBookings(current => current.map(item => item.id === id ? { ...item, ...patch } : item));
  };

  // Troca permanente: o professor aplica direto, todas as aulas numa transação só.
  // As aulas antes da vigência continuam no horário antigo; a Gestão é avisada no grupo.
  const applyPermanentChange = async () => {
    if (!changedBookings.length) return;
    const summary = changedBookings
      .map(item => `${item.originalDay} ${item.originalTime}  →  ${item.day_of_week} ${item.time_slot}`)
      .join('\n');
    const confirmed = window.confirm(
      `Alterar o horário de ${studentName} a partir de ${formatDate(effectiveFrom)}?\n\n${summary}\n\n` +
      'As aulas anteriores continuam no horário antigo. A Gestão será avisada no grupo.',
    );
    if (!confirmed) return;

    setApplying(true);
    setError('');
    setApplied('');
    const { data: result, error: rpcError } = await supabase.rpc('teacher_apply_student_schedule_change', {
      p_student_id: studentId,
      p_changes: changedBookings.map(item => ({ booking_id: item.id, new_day: item.day_of_week, new_time: item.time_slot })),
      p_effective_from: effectiveFrom,
      p_reason: reason,
    });
    setApplying(false);

    if (rpcError || result?.ok === false) {
      setError(friendlyScheduleError(rpcError?.message || result?.error || ''));
      return;
    }
    setApplied(`Horário alterado a partir de ${formatDate(effectiveFrom)}.${result?.notification_queued ? ' A Gestão foi avisada no grupo.' : ''}`);
    setBookings(current => current.map(item => ({ ...item, originalDay: item.day_of_week, originalTime: item.time_slot })));
    onChanged?.();
  };

  // Troca de UMA aula continua sendo solicitação: aceite da família e revisão da escola.
  const requestOneOff = async (booking: BookingDraft) => {
    const confirmed = window.confirm(
      `Registrar proposta para ${studentName}?\n\n` +
      `Aula de ${originalDate ? formatDate(originalDate) : '—'}  →  ${proposedDate ? formatDate(proposedDate) : '—'} às ${booking.time_slot}\n\n` +
      'A família precisa aceitar e a escola aprovar antes da mudança.',
    );
    if (!confirmed) return;

    setSavingId(booking.id);
    setError('');
    setSuccessId(null);
    const newDay = proposedDate
      ? ['Domingo', ...DAYS][new Date(`${proposedDate}T12:00:00`).getDay()]
      : booking.day_of_week;
    const { error: rpcError, data: result } = await supabase.rpc('request_booking_schedule_change', {
      p_booking_id: booking.id,
      p_new_day: newDay,
      p_new_time: booking.time_slot,
      p_effective_from: originalDate,
      p_reason: reason,
      p_scope: 'ONE_OFF',
      p_original_date: originalDate,
      p_proposed_date: proposedDate,
      p_initiated_by: initiatedBy,
    });

    if (rpcError || result?.ok === false) {
      setError(friendlyScheduleError(rpcError?.message || result?.error || ''));
      setSavingId(null);
      return;
    }

    setBookings(current => current.map(item => item.id === booking.id
      ? { ...item, day_of_week: item.originalDay, time_slot: item.originalTime }
      : item));
    setSuccessId(booking.id);
    setSavingId(null);
    onChanged?.();
  };

  const permanent = scope === 'PERMANENT';

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-xl overflow-hidden rounded-[2rem] border border-brand-border bg-brand-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-brand-border bg-brand-surface-2/60 p-6">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-500/10 text-blue-500">
              <CalendarClock size={22} />
            </div>
            <div>
              <h3 className="text-sm font-black text-brand-text">{permanent ? 'Alterar horário do aluno' : 'Solicitar troca de uma aula'}</h3>
              <p className="text-xs text-brand-muted">{studentName} · {permanent ? 'a Gestão é avisada no grupo' : 'aceite da família e revisão da escola'}</p>
            </div>
          </div>
          <button onClick={onClose} className="rounded-xl p-2 text-brand-muted transition-colors hover:bg-brand-surface hover:text-brand-text" aria-label="Fechar">
            <X size={19} />
          </button>
        </div>

        <div className="max-h-[65vh] space-y-4 overflow-y-auto p-6">
          <div className="rounded-2xl border border-blue-500/20 bg-blue-500/10 p-4 text-xs leading-relaxed text-blue-700 dark:text-blue-300">
            {permanent
              ? 'Escolha o novo dia e horário das aulas que mudam e a data a partir da qual vale. As aulas anteriores continuam no horário antigo, inclusive as já lançadas. Toda troca fica registrada e é avisada no grupo da Gestão.'
              : 'Para trocar uma única aula, informe a data original e a proposta. A escola coleta o aceite da família antes de aplicar. Cada etapa fica registrada.'}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 text-xs">
            <label>Tipo de mudança<select value={scope} onChange={e => { setScope(e.target.value as 'PERMANENT' | 'ONE_OFF'); setApplied(''); setError(''); }} className="mt-1 w-full rounded-xl border border-brand-border bg-brand-surface p-3"><option value="PERMANENT">Permanente</option><option value="ONE_OFF">Somente uma aula</option></select></label>
            {!permanent && <label>Quem pediu a mudança?<select value={initiatedBy} onChange={e => setInitiatedBy(e.target.value)} className="mt-1 w-full rounded-xl border border-brand-border bg-brand-surface p-3"><option value="TEACHER">Eu, professor</option><option value="STUDENT">Aluno</option><option value="GUARDIAN">Responsável</option></select></label>}
            {permanent ? <label>A partir de<input type="date" min={tomorrow()} value={effectiveFrom} onChange={e => setEffectiveFrom(e.target.value)} className="mt-1 w-full rounded-xl border border-brand-border bg-brand-surface p-3" /></label> : <><label>Data original da aula<input type="date" min={tomorrow()} value={originalDate} onChange={e => setOriginalDate(e.target.value)} className="mt-1 w-full rounded-xl border border-brand-border bg-brand-surface p-3" /></label><label>Data proposta<input type="date" min={tomorrow()} value={proposedDate} onChange={e => setProposedDate(e.target.value)} className="mt-1 w-full rounded-xl border border-brand-border bg-brand-surface p-3" /></label></>}
            <label className="sm:col-span-2">Motivo<textarea value={reason} maxLength={1000} onChange={e => setReason(e.target.value)} placeholder="Explique o motivo (fica registrado e vai para a Gestão)." className="mt-1 w-full rounded-xl border border-brand-border bg-brand-surface p-3" /></label>
          </div>
          {applied && <p role="status" className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-700">{applied}</p>}
          {successId && <p role="status" className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-700">Proposta registrada. Aguarde o aceite da família e a aprovação da escola.</p>}

          {error && (
            <div className="flex items-start gap-2 rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-xs font-bold text-red-600 dark:text-red-300">
              <AlertCircle size={16} className="mt-0.5 shrink-0" /> {error}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-xs font-bold text-brand-muted">
              <RefreshCw size={16} className="animate-spin" /> Carregando agenda...
            </div>
          ) : bookings.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-brand-border py-10 text-center text-xs font-bold text-brand-muted">
              Este aluno não possui aula ativa na sua agenda.
            </div>
          ) : bookings.map(booking => (
            <div key={booking.id} className="rounded-2xl border border-brand-border bg-brand-surface-2/40 p-4">
              <div className="mb-3 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-brand-muted">
                <Clock size={13} /> Horário atual: {booking.originalDay}, {booking.originalTime}
              </div>
              <div className={`grid grid-cols-1 gap-3 ${permanent ? 'sm:grid-cols-[1fr_130px]' : 'sm:grid-cols-[1fr_130px_auto]'}`}>
                <select
                  aria-label={`Dia proposto para ${booking.originalDay} ${booking.originalTime}`}
                  value={booking.day_of_week}
                  onChange={event => updateDraft(booking.id, { day_of_week: event.target.value })}
                  disabled={applying || savingId === booking.id || !permanent}
                  className="rounded-xl border border-brand-border bg-brand-surface px-4 py-3 text-sm font-bold text-brand-text outline-none focus:border-brand-accent focus:ring-2 focus:ring-brand-accent/20 disabled:opacity-60"
                >
                  {DAYS.map(day => <option key={day} value={day}>{day}</option>)}
                </select>
                <input
                  type="time"
                  aria-label={`Horário proposto para ${booking.originalDay} ${booking.originalTime}`}
                  step={1800}
                  value={booking.time_slot}
                  onChange={event => updateDraft(booking.id, { time_slot: event.target.value })}
                  disabled={applying || savingId === booking.id}
                  className="rounded-xl border border-brand-border bg-brand-surface px-4 py-3 text-sm font-bold text-brand-text outline-none [color-scheme:dark] focus:border-brand-accent focus:ring-2 focus:ring-brand-accent/20 disabled:opacity-60"
                />
                {!permanent && (
                  <button
                    onClick={() => void requestOneOff(booking)}
                    disabled={savingId === booking.id || successId === booking.id || reason.trim().length < 8 || !originalDate || !proposedDate}
                    className="flex items-center justify-center gap-2 rounded-xl bg-brand-accent px-4 py-3 text-xs font-black uppercase text-white transition-all hover:bg-brand-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {savingId === booking.id
                      ? <RefreshCw size={15} className="animate-spin" />
                      : successId === booking.id
                        ? <Check size={15} />
                        : <Save size={15} />}
                    {successId === booking.id ? 'Solicitado' : 'Solicitar'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-brand-border bg-brand-surface-2/40 p-5">
          <p className="text-[10px] font-bold text-brand-muted">
            {permanent
              ? (changedBookings.length ? `${changedBookings.length} aula(s) com horário novo.` : 'Nenhuma alteração ainda.')
              : 'A agenda vigente permanece até a aprovação.'}
          </p>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="rounded-xl px-5 py-2.5 text-xs font-black uppercase text-brand-muted transition-colors hover:bg-brand-surface hover:text-brand-text">
              Fechar
            </button>
            {permanent && (
              <button
                onClick={() => void applyPermanentChange()}
                disabled={!changedBookings.length || applying || reason.trim().length < 8 || !effectiveFrom}
                className="flex items-center justify-center gap-2 rounded-xl bg-brand-accent px-4 py-2.5 text-xs font-black uppercase text-white transition-all hover:bg-brand-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                {applying ? <RefreshCw size={15} className="animate-spin" /> : <Save size={15} />}
                {`Aplicar troca (${changedBookings.length})`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default TeacherStudentScheduleEditor;
