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

const friendlyScheduleError = (message: string) => {
  const knownMessages = [
    'Você só pode alterar alunos da sua própria agenda.',
    'O novo horário não está na disponibilidade cadastrada do professor.',
    'O professor já possui uma aula nesse dia e horário.',
    'O aluno já possui uma aula nesse dia e horário.',
    'Escolha um horário em intervalos de 30 minutos.',
    'Somente aulas ativas podem ter o horário alterado.',
  ];
  if (/schedule_change_one_pending|duplicate key/.test(message)) return 'Já existe uma proposta pendente para esta aula. Aguarde a revisão da escola.';
  if (/original_occurrence|one_off|occurrence_already/.test(message)) return 'Confira a data original e a proposta. A data original precisa corresponder a uma aula futura da agenda.';
  return knownMessages.find(known => message.includes(known)) || 'Não foi possível registrar. Confira datas futuras, horário e motivo (mínimo de 8 caracteres).';
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

  const hasPendingChange = useMemo(
    () => bookings.some(item => item.day_of_week !== item.originalDay || item.time_slot !== item.originalTime),
    [bookings],
  );

  const updateDraft = (id: string, patch: Partial<Pick<BookingDraft, 'day_of_week' | 'time_slot'>>) => {
    setError('');
    setSuccessId(null);
    setBookings(current => current.map(item => item.id === id ? { ...item, ...patch } : item));
  };

  const saveBooking = async (booking: BookingDraft) => {
    if (scope === 'PERMANENT' && booking.day_of_week === booking.originalDay && booking.time_slot === booking.originalTime) return;

    const confirmed = window.confirm(
      `Registrar proposta para ${studentName}?\n\n` +
      `${booking.originalDay} às ${booking.originalTime}  →  ${booking.day_of_week} às ${booking.time_slot}\n\n` +
      'A família precisa aceitar e a escola aprovar antes da mudança. A agenda atual será mantida até a aprovação e a vigência.',
    );
    if (!confirmed) return;

    setSavingId(booking.id);
    setError('');
    setSuccessId(null);
    const newDay = scope === 'ONE_OFF' && proposedDate
      ? ['Domingo', ...DAYS][new Date(`${proposedDate}T12:00:00`).getDay()]
      : booking.day_of_week;
    const { error: rpcError, data: result } = await supabase.rpc('request_booking_schedule_change', {
      p_booking_id: booking.id,
      p_new_day: newDay,
      p_new_time: booking.time_slot,
      p_effective_from: scope === 'ONE_OFF' ? originalDate : effectiveFrom,
      p_reason: reason,
      p_scope: scope,
      p_original_date: scope === 'ONE_OFF' ? originalDate : null,
      p_proposed_date: scope === 'ONE_OFF' ? proposedDate : null,
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

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-xl overflow-hidden rounded-[2rem] border border-brand-border bg-brand-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-brand-border bg-brand-surface-2/60 p-6">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-500/10 text-blue-500">
              <CalendarClock size={22} />
            </div>
            <div>
              <h3 className="text-sm font-black text-brand-text">Solicitar mudança de horário</h3>
              <p className="text-xs text-brand-muted">{studentName} · aceite da família e revisão da escola</p>
            </div>
          </div>
          <button onClick={onClose} className="rounded-xl p-2 text-brand-muted transition-colors hover:bg-brand-surface hover:text-brand-text" aria-label="Fechar">
            <X size={19} />
          </button>
        </div>

        <div className="max-h-[65vh] space-y-4 overflow-y-auto p-6">
          <div className="rounded-2xl border border-blue-500/20 bg-blue-500/10 p-4 text-xs leading-relaxed text-blue-700 dark:text-blue-300">
            Informe o motivo e a vigência. A escola coleta o aceite da família e confere a disponibilidade antes de aplicar a mudança. Cada etapa fica registrada.
          </div>
          <div className="grid gap-3 sm:grid-cols-2 text-xs">
            <label>Tipo de mudança<select value={scope} onChange={e => setScope(e.target.value as 'PERMANENT' | 'ONE_OFF')} className="mt-1 w-full rounded-xl border border-brand-border bg-brand-surface p-3"><option value="PERMANENT">Permanente</option><option value="ONE_OFF">Somente uma aula</option></select></label>
            <label>Quem pediu a mudança?<select value={initiatedBy} onChange={e => setInitiatedBy(e.target.value)} className="mt-1 w-full rounded-xl border border-brand-border bg-brand-surface p-3"><option value="TEACHER">Eu, professor</option><option value="STUDENT">Aluno</option><option value="GUARDIAN">Responsável</option></select></label>
            {scope === 'PERMANENT' ? <label>A partir de<input type="date" min={tomorrow()} value={effectiveFrom} onChange={e => setEffectiveFrom(e.target.value)} className="mt-1 w-full rounded-xl border border-brand-border bg-brand-surface p-3" /></label> : <><label>Data original da aula<input type="date" min={tomorrow()} value={originalDate} onChange={e => setOriginalDate(e.target.value)} className="mt-1 w-full rounded-xl border border-brand-border bg-brand-surface p-3" /></label><label>Data proposta<input type="date" min={tomorrow()} value={proposedDate} onChange={e => setProposedDate(e.target.value)} className="mt-1 w-full rounded-xl border border-brand-border bg-brand-surface p-3" /></label></>}
            <label className="sm:col-span-2">Motivo<textarea value={reason} maxLength={1000} onChange={e => setReason(e.target.value)} placeholder="Explique o motivo para a família e a coordenação." className="mt-1 w-full rounded-xl border border-brand-border bg-brand-surface p-3" /></label>
          </div>
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
          ) : bookings.map(booking => {
            const changed = scope === 'ONE_OFF' || booking.day_of_week !== booking.originalDay || booking.time_slot !== booking.originalTime;
            return (
              <div key={booking.id} className="rounded-2xl border border-brand-border bg-brand-surface-2/40 p-4">
                <div className="mb-3 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-brand-muted">
                  <Clock size={13} /> Horário atual: {booking.originalDay}, {booking.originalTime}
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_130px_auto]">
                  <select
                    aria-label={`Dia proposto para ${booking.originalDay} ${booking.originalTime}`}
                    value={booking.day_of_week}
                    onChange={event => updateDraft(booking.id, { day_of_week: event.target.value })}
                    disabled={savingId === booking.id || scope === 'ONE_OFF'}
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
                    disabled={savingId === booking.id}
                    className="rounded-xl border border-brand-border bg-brand-surface px-4 py-3 text-sm font-bold text-brand-text outline-none [color-scheme:dark] focus:border-brand-accent focus:ring-2 focus:ring-brand-accent/20 disabled:opacity-60"
                  />
                  <button
                    onClick={() => void saveBooking(booking)}
                    disabled={!changed || savingId === booking.id || successId === booking.id || reason.trim().length < 8 || (scope === 'ONE_OFF' && (!originalDate || !proposedDate))}
                    className="flex items-center justify-center gap-2 rounded-xl bg-brand-accent px-4 py-3 text-xs font-black uppercase text-white transition-all hover:bg-brand-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {savingId === booking.id
                      ? <RefreshCw size={15} className="animate-spin" />
                      : successId === booking.id
                        ? <Check size={15} />
                        : <Save size={15} />}
                    {successId === booking.id ? 'Solicitado' : 'Solicitar'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-brand-border bg-brand-surface-2/40 p-5">
          <p className="text-[10px] font-bold text-brand-muted">
            {hasPendingChange ? 'Há uma proposta ainda não enviada.' : 'A agenda vigente permanece preservada.'}
          </p>
          <button onClick={onClose} className="rounded-xl px-5 py-2.5 text-xs font-black uppercase text-brand-muted transition-colors hover:bg-brand-surface hover:text-brand-text">
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
};

export default TeacherStudentScheduleEditor;
