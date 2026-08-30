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

const friendlyScheduleError = (message: string) => {
  const knownMessages = [
    'Você só pode alterar alunos da sua própria agenda.',
    'O novo horário não está na disponibilidade cadastrada do professor.',
    'O professor já possui uma aula nesse dia e horário.',
    'O aluno já possui uma aula nesse dia e horário.',
    'Escolha um horário em intervalos de 30 minutos.',
    'Somente aulas ativas podem ter o horário alterado.',
  ];
  return knownMessages.find(known => message.includes(known)) || 'Não foi possível alterar o horário. Confira sua disponibilidade e tente novamente.';
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
      setBookings(((data || []) as BookingRow[]).map(item => {
        const canonicalDay = item.day_of_week === 'Terca' ? 'Terça' : item.day_of_week;
        const time = item.time_slot.slice(0, 5);
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
    if (booking.day_of_week === booking.originalDay && booking.time_slot === booking.originalTime) return;

    const confirmed = window.confirm(
      `Confirmar a troca da aula de ${studentName}?\n\n` +
      `${booking.originalDay} às ${booking.originalTime}  →  ${booking.day_of_week} às ${booking.time_slot}\n\n` +
      'O grupo operacional da Wise Wolf será avisado automaticamente.',
    );
    if (!confirmed) return;

    setSavingId(booking.id);
    setError('');
    setSuccessId(null);
    const { error: rpcError } = await supabase.rpc('change_booking_schedule', {
      p_booking_id: booking.id,
      p_day_of_week: booking.day_of_week,
      p_time_slot: booking.time_slot,
    });

    if (rpcError) {
      setError(friendlyScheduleError(rpcError.message));
      setSavingId(null);
      return;
    }

    setBookings(current => current.map(item => item.id === booking.id
      ? { ...item, originalDay: item.day_of_week, originalTime: item.time_slot }
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
              <h3 className="text-sm font-black text-brand-text">Trocar dia ou horário</h3>
              <p className="text-xs text-brand-muted">{studentName} · alteração permanente</p>
            </div>
          </div>
          <button onClick={onClose} className="rounded-xl p-2 text-brand-muted transition-colors hover:bg-brand-surface hover:text-brand-text" aria-label="Fechar">
            <X size={19} />
          </button>
        </div>

        <div className="max-h-[65vh] space-y-4 overflow-y-auto p-6">
          <div className="rounded-2xl border border-blue-500/20 bg-blue-500/10 p-4 text-xs leading-relaxed text-blue-700 dark:text-blue-300">
            Use esta opção depois de combinar com o aluno. O sistema impede choque de agenda, registra a alteração e avisa o grupo operacional.
          </div>

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
            const changed = booking.day_of_week !== booking.originalDay || booking.time_slot !== booking.originalTime;
            return (
              <div key={booking.id} className="rounded-2xl border border-brand-border bg-brand-surface-2/40 p-4">
                <div className="mb-3 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-brand-muted">
                  <Clock size={13} /> Horário atual: {booking.originalDay}, {booking.originalTime}
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_130px_auto]">
                  <select
                    value={booking.day_of_week}
                    onChange={event => updateDraft(booking.id, { day_of_week: event.target.value })}
                    disabled={savingId === booking.id}
                    className="rounded-xl border border-brand-border bg-brand-surface px-4 py-3 text-sm font-bold text-brand-text outline-none focus:border-brand-accent focus:ring-2 focus:ring-brand-accent/20 disabled:opacity-60"
                  >
                    {DAYS.map(day => <option key={day} value={day}>{day}</option>)}
                  </select>
                  <input
                    type="time"
                    step={1800}
                    value={booking.time_slot}
                    onChange={event => updateDraft(booking.id, { time_slot: event.target.value })}
                    disabled={savingId === booking.id}
                    className="rounded-xl border border-brand-border bg-brand-surface px-4 py-3 text-sm font-bold text-brand-text outline-none [color-scheme:dark] focus:border-brand-accent focus:ring-2 focus:ring-brand-accent/20 disabled:opacity-60"
                  />
                  <button
                    onClick={() => void saveBooking(booking)}
                    disabled={!changed || savingId === booking.id}
                    className="flex items-center justify-center gap-2 rounded-xl bg-brand-accent px-4 py-3 text-xs font-black uppercase text-white transition-all hover:bg-brand-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {savingId === booking.id
                      ? <RefreshCw size={15} className="animate-spin" />
                      : successId === booking.id
                        ? <Check size={15} />
                        : <Save size={15} />}
                    {successId === booking.id && !changed ? 'Salvo' : 'Salvar'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-brand-border bg-brand-surface-2/40 p-5">
          <p className="text-[10px] font-bold text-brand-muted">
            {hasPendingChange ? 'Há uma alteração ainda não salva.' : 'Nenhuma alteração pendente.'}
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
