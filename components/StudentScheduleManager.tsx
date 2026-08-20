import React, { useState, useEffect } from 'react';
import { Trash2, Plus, Calendar, Clock, User as UserIcon, Save, X, RefreshCw, AlertCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Teacher } from '../types';

interface StudentScheduleManagerProps {
    studentId: string;
    tenantId: string;
    teachers: Teacher[]; // For selecting teacher
    onUpdate?: () => void;
}

interface Booking {
    id: string;
    day_of_week: string;
    time_slot: string;
    teacher_id: string;
    teacher?: { full_name: string };
}

const DAYS_OF_WEEK = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

const StudentScheduleManager: React.FC<StudentScheduleManagerProps> = ({ studentId, tenantId, teachers, onUpdate }) => {
    const [bookings, setBookings] = useState<Booking[]>([]);
    const [loading, setLoading] = useState(true);
    const [isAdding, setIsAdding] = useState(false);

    // New Slot State
    const [newSlot, setNewSlot] = useState({
        day: 'Segunda',
        time: '08:00',
        teacherId: ''
    });

    const [processingId, setProcessingId] = useState<string | null>(null);
    const [scheduleDrafts, setScheduleDrafts] = useState<Record<string, { day: string; time: string }>>({});

    useEffect(() => {
        fetchBookings();
    }, [studentId, tenantId]);

    const fetchBookings = async () => {
        setLoading(true);
        try {
            const { data, error } = await supabase
                .from('bookings')
                .select('id, day_of_week, time_slot, teacher_id, teacher:teacher_id(full_name)')
                .eq('student_id', studentId)
                .eq('tenant_id', tenantId)
                .eq('status', 'SCHEDULED');

            if (error) throw error;
            const nextBookings = (data || []).map((booking: any) => ({
                ...booking,
                teacher: Array.isArray(booking.teacher) ? booking.teacher[0] : booking.teacher,
            })) as Booking[];
            setBookings(nextBookings);
            setScheduleDrafts(Object.fromEntries(nextBookings.map(booking => [
                booking.id,
                { day: booking.day_of_week, time: booking.time_slot.slice(0, 5) },
            ])));
        } catch (error) {
            console.error('Error fetching bookings:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleAddSlot = async () => {
        if (!newSlot.teacherId) return alert('Selecione um professor.');
        setLoading(true);
        try {
            // Basic validation: Check if slot is taken for this teacher could be complex, 
            // but for now we enforce the ADMIN override power.

            const { error } = await supabase.from('bookings').insert({
                student_id: studentId,
                teacher_id: newSlot.teacherId,
                tenant_id: tenantId,
                day_of_week: newSlot.day,
                time_slot: newSlot.time,
                status: 'SCHEDULED',
                start_date: new Date().toISOString().split('T')[0] // Effective today
            });

            if (error) throw error;

            setIsAdding(false);
            fetchBookings();
            if (onUpdate) onUpdate();
            alert('Aula adicionada com sucesso!');
        } catch (error: any) {
            alert('Erro ao adicionar aula: ' + error.message);
        } finally {
            setLoading(false);
        }
    };

    const handleDelete = async (id: string) => {
        if (!confirm('Tem certeza que deseja remover este horário?')) return;
        setProcessingId(id);
        try {
            const { error } = await supabase.from('bookings').delete().eq('id', id);
            if (error) throw error;

            setBookings(prev => prev.filter(b => b.id !== id));
            if (onUpdate) onUpdate();
        } catch (error: any) {
            alert('Erro ao remover: ' + error.message);
        } finally {
            setProcessingId(null);
        }
    };

    const handleTransfer = async (bookingId: string, newTeacherId: string) => {
        if (!newTeacherId) return;
        setProcessingId(bookingId);
        try {
            const { error } = await supabase
                .from('bookings')
                .update({ teacher_id: newTeacherId })
                .eq('id', bookingId);

            if (error) throw error;
            fetchBookings(); // Refresh to show new teacher name
            if (onUpdate) onUpdate();
        } catch (error: any) {
            alert('Erro na transferência: ' + error.message);
        } finally {
            setProcessingId(null);
        }
    };

    const handleScheduleSave = async (bookingId: string) => {
        const currentBooking = bookings.find(booking => booking.id === bookingId);
        if (!currentBooking) return;

        const draft = scheduleDrafts[bookingId];
        const nextDay = draft?.day || currentBooking.day_of_week;
        const nextTime = (draft?.time || currentBooking.time_slot).slice(0, 5);
        if (nextDay === currentBooking.day_of_week && nextTime === currentBooking.time_slot.slice(0, 5)) return;

        setProcessingId(bookingId);
        try {
            // A RPC centraliza autorização, disponibilidade, conflitos,
            // auditoria e a notificação operacional da mudança de agenda.
            const { data, error } = await supabase.rpc('change_booking_schedule', {
                p_booking_id: bookingId,
                p_day_of_week: nextDay,
                p_time_slot: nextTime.slice(0, 5),
            });

            if (error) throw error;
            if (data && (data as any).ok === false) {
                throw new Error((data as any).error || 'Não foi possível alterar o horário.');
            }
            await fetchBookings();
            if (onUpdate) onUpdate();
        } catch (error: any) {
            alert('Erro ao atualizar horário: ' + error.message);
        } finally {
            setProcessingId(null);
        }
    };

    if (loading && bookings.length === 0 && !isAdding) {
        return <div className="p-4 text-center text-brand-muted text-xs uppercase animate-pulse">Carregando agenda...</div>;
    }

    return (
        <div className="space-y-4">
            <div className="flex justify-between items-center mb-2">
                <h4 className="text-xs font-black uppercase tracking-widest text-brand-muted flex items-center gap-2">
                    <Calendar size={14} /> Agenda de Aulas
                </h4>
                <button
                    onClick={() => setIsAdding(!isAdding)}
                    className="text-[10px] font-bold uppercase tracking-wide text-brand-accent hover:bg-brand-accent/10 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1 border border-transparent hover:border-brand-accent/20"
                >
                    <Plus size={12} /> Adicionar Dia
                </button>
            </div>

            {isAdding && (
                <div className="p-4 bg-brand-surface-2 rounded-xl border border-dashed border-brand-accent/50 mb-4 animate-in slide-in-from-top-2">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
                        <div>
                            <label className="text-[10px] text-brand-muted font-bold uppercase">Dia</label>
                            <select
                                value={newSlot.day}
                                onChange={e => setNewSlot({ ...newSlot, day: e.target.value })}
                                className="w-full p-2 rounded-lg bg-brand-surface border border-brand-border text-brand-text text-xs font-bold focus:ring-1 focus:ring-brand-accent focus:border-brand-accent outline-none"
                            >
                                {DAYS_OF_WEEK.map(d => <option key={d} value={d}>{d}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className="text-[10px] text-brand-muted font-bold uppercase">Horário</label>
                            <input
                                type="time"
                                step={1800}
                                value={newSlot.time}
                                onChange={e => setNewSlot({ ...newSlot, time: e.target.value })}
                                className="w-full p-2 rounded-lg bg-brand-surface border border-brand-border text-brand-text text-xs font-bold focus:ring-1 focus:ring-brand-accent focus:border-brand-accent outline-none [color-scheme:dark]"
                            />
                        </div>
                        <div>
                            <label className="text-[10px] text-brand-muted font-bold uppercase">Professor</label>
                            <select
                                value={newSlot.teacherId}
                                onChange={e => setNewSlot({ ...newSlot, teacherId: e.target.value })}
                                className="w-full p-2 rounded-lg bg-brand-surface border border-brand-border text-brand-text text-xs font-bold focus:ring-1 focus:ring-brand-accent focus:border-brand-accent outline-none"
                            >
                                <option value="">Selecione...</option>
                                {teachers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                            </select>
                        </div>
                    </div>
                    <div className="flex justify-end gap-2">
                        <button onClick={() => setIsAdding(false)} className="px-3 py-1.5 text-xs font-bold text-brand-muted hover:text-brand-text transition-colors">Cancelar</button>
                        <button onClick={handleAddSlot} className="px-3 py-1.5 bg-brand-accent text-white rounded-lg text-xs font-bold uppercase shadow-sm hover:bg-brand-accent-hover transition-colors">Confirmar</button>
                    </div>
                </div>
            )}

            <div className="space-y-3">
                {bookings.map(booking => {
                    const draft = scheduleDrafts[booking.id] || {
                        day: booking.day_of_week,
                        time: booking.time_slot.slice(0, 5),
                    };
                    const scheduleChanged = draft.day !== booking.day_of_week
                        || draft.time !== booking.time_slot.slice(0, 5);

                    return (
                    <div key={booking.id} className="p-3 bg-brand-surface border border-brand-border rounded-xl hover:shadow-[0_8px_30px_rgba(0,0,0,0.12)] transition-all flex flex-col md:flex-row items-center gap-4 group">

                        {/* Day & Time Editor */}
                        <div className="flex gap-2 items-center flex-1">
                            <select
                                value={draft.day}
                                onChange={(e) => setScheduleDrafts(prev => ({
                                    ...prev,
                                    [booking.id]: { ...draft, day: e.target.value },
                                }))}
                                disabled={processingId === booking.id}
                                className="bg-brand-surface-2 border border-transparent rounded-lg px-2 py-1 text-xs font-black text-brand-text uppercase w-24 focus:border-brand-accent focus:ring-1 focus:ring-brand-accent outline-none transition-colors"
                            >
                                {DAYS_OF_WEEK.map(d => <option key={d} value={d}>{d}</option>)}
                            </select>

                            <input
                                type="time"
                                step={1800}
                                value={draft.time}
                                onChange={(e) => setScheduleDrafts(prev => ({
                                    ...prev,
                                    [booking.id]: { ...draft, time: e.target.value },
                                }))}
                                disabled={processingId === booking.id}
                                className="bg-brand-surface-2 border border-transparent rounded-lg px-2 py-1 text-xs font-black text-brand-text w-20 focus:border-brand-accent focus:ring-1 focus:ring-brand-accent outline-none transition-colors [color-scheme:dark]"
                            />
                            <button
                                type="button"
                                onClick={() => handleScheduleSave(booking.id)}
                                disabled={processingId === booking.id || !scheduleChanged}
                                className="p-2 rounded-lg bg-brand-accent text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                                title="Salvar novo dia e horário"
                                aria-label="Salvar novo dia e horário"
                            >
                                {processingId === booking.id
                                    ? <RefreshCw size={14} className="animate-spin" />
                                    : <Save size={14} />}
                            </button>
                        </div>

                        {/* Teacher Transfer */}
                        <div className="flex items-center gap-2 flex-1 w-full md:w-auto">
                            <UserIcon size={12} className="text-brand-muted" />
                            <select
                                value={booking.teacher_id}
                                onChange={(e) => handleTransfer(booking.id, e.target.value)}
                                disabled={processingId === booking.id}
                                className="flex-1 bg-transparent text-xs font-bold text-brand-text border-b border-dashed border-brand-border focus:border-brand-accent outline-none py-1 truncate"
                            >
                                {teachers.map(t => (
                                    <option key={t.id} value={t.id}>Prof. {t.name}</option>
                                ))}
                            </select>
                        </div>

                        {/* Delete */}
                        <button
                            onClick={() => handleDelete(booking.id)}
                            disabled={processingId === booking.id}
                            className="p-2 text-brand-muted hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-colors"
                            title="Remover Aula"
                        >
                            {processingId === booking.id ? <RefreshCw size={14} className="animate-spin text-brand-accent" /> : <Trash2 size={14} />}
                        </button>
                    </div>
                    );
                })}

                {bookings.length === 0 && !isAdding && (
                    <div className="p-4 border border-dashed border-brand-border rounded-xl text-center">
                        <p className="text-[10px] font-bold text-brand-muted uppercase">Nenhuma aula agendada</p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default StudentScheduleManager;
