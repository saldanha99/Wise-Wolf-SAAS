import React, { useState, useEffect } from 'react';
import { Trash2, Plus, Calendar, Clock, User as UserIcon, Save, RefreshCw } from 'lucide-react';
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

type BookingDraft = Pick<Booking, 'day_of_week' | 'time_slot' | 'teacher_id'>;

const DAYS_OF_WEEK = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

const StudentScheduleManager: React.FC<StudentScheduleManagerProps> = ({ studentId, tenantId, teachers, onUpdate }) => {
    const [bookings, setBookings] = useState<Booking[]>([]);
    const [loading, setLoading] = useState(true);
    const [isAdding, setIsAdding] = useState(false);
    const [drafts, setDrafts] = useState<Record<string, BookingDraft>>({});
    const [bulkTime, setBulkTime] = useState('17:30');

    // New Slot State
    const [newSlot, setNewSlot] = useState({
        day: 'Segunda',
        time: '08:00',
        teacherId: ''
    });

    const [processingId, setProcessingId] = useState<string | 'all' | null>(null);

    useEffect(() => {
        fetchBookings();
    }, [studentId]);

    const fetchBookings = async () => {
        setLoading(true);
        try {
            const { data, error } = await supabase
                .from('bookings')
                .select('id, day_of_week, time_slot, teacher_id, teacher:teacher_id(full_name)')
                .eq('student_id', studentId)
                .eq('tenant_id', tenantId);

            if (error) throw error;
            const normalized = (data || []).map((booking: any) => ({
                ...booking,
                time_slot: String(booking.time_slot || '').slice(0, 5),
            })) as Booking[];
            setBookings(normalized);
            setDrafts(Object.fromEntries(normalized.map(booking => [booking.id, {
                day_of_week: booking.day_of_week,
                time_slot: booking.time_slot,
                teacher_id: booking.teacher_id,
            }])));
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

    const updateDraft = (bookingId: string, patch: Partial<BookingDraft>) => {
        setDrafts(previous => ({
            ...previous,
            [bookingId]: { ...previous[bookingId], ...patch },
        }));
    };

    const handleSaveBooking = async (bookingId: string) => {
        const draft = drafts[bookingId];
        if (!draft?.teacher_id || !DAYS_OF_WEEK.includes(draft.day_of_week) || !/^\d{2}:\d{2}$/.test(draft.time_slot)) {
            alert('Preencha dia, horário e professor corretamente.');
            return;
        }
        setProcessingId(bookingId);
        try {
            const { error } = await supabase
                .from('bookings')
                .update(draft)
                .eq('id', bookingId);

            if (error) throw error;
            await fetchBookings();
            if (onUpdate) onUpdate();
            alert('Horário atualizado com sucesso!');
        } catch (error: any) {
            alert('Erro ao atualizar horário: ' + error.message);
        } finally {
            setProcessingId(null);
        }
    };

    const handleApplyTimeToAll = async () => {
        if (!/^\d{2}:\d{2}$/.test(bulkTime) || bookings.length === 0) return;
        setProcessingId('all');
        try {
            const { error } = await supabase
                .from('bookings')
                .update({ time_slot: bulkTime })
                .eq('student_id', studentId)
                .eq('tenant_id', tenantId);

            if (error) throw error;
            await fetchBookings();
            if (onUpdate) onUpdate();
            alert(`Horário ${bulkTime} aplicado a todas as aulas do aluno.`);
        } catch (error: any) {
            alert('Erro ao aplicar o horário: ' + error.message);
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

            {bookings.length > 0 && (
                <div className="flex flex-col gap-3 rounded-xl border border-brand-border bg-brand-surface-2 p-3 sm:flex-row sm:items-end">
                    <label className="flex-1 text-[10px] font-bold uppercase text-brand-muted">
                        Mesmo horário para todas as aulas
                        <input
                            type="time"
                            value={bulkTime}
                            onChange={event => setBulkTime(event.target.value)}
                            disabled={processingId !== null}
                            className="mt-1 w-full rounded-lg border border-brand-border bg-brand-surface px-3 py-2 text-sm font-black text-brand-text outline-none focus:border-brand-accent"
                        />
                    </label>
                    <button
                        type="button"
                        onClick={handleApplyTimeToAll}
                        disabled={processingId !== null}
                        className="rounded-lg bg-brand-accent px-4 py-2.5 text-[10px] font-black uppercase tracking-wide text-white disabled:opacity-50"
                    >
                        {processingId === 'all' ? 'Salvando…' : 'Aplicar a todas'}
                    </button>
                </div>
            )}

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
                    const draft = drafts[booking.id] || booking;
                    const changed = draft.day_of_week !== booking.day_of_week
                        || draft.time_slot !== booking.time_slot
                        || draft.teacher_id !== booking.teacher_id;
                    return (
                    <div key={booking.id} className="p-3 bg-brand-surface border border-brand-border rounded-xl hover:shadow-[0_8px_30px_rgba(0,0,0,0.12)] transition-all flex flex-col md:flex-row items-center gap-4 group">

                        {/* Day & Time Editor */}
                        <div className="flex gap-2 items-center flex-1">
                            <select
                                value={draft.day_of_week}
                                onChange={(e) => updateDraft(booking.id, { day_of_week: e.target.value })}
                                disabled={processingId !== null}
                                className="bg-brand-surface-2 border border-transparent rounded-lg px-2 py-1 text-xs font-black text-brand-text uppercase w-24 focus:border-brand-accent focus:ring-1 focus:ring-brand-accent outline-none transition-colors"
                            >
                                {DAYS_OF_WEEK.map(d => <option key={d} value={d}>{d}</option>)}
                            </select>

                            <input
                                type="time"
                                value={draft.time_slot}
                                onChange={(e) => updateDraft(booking.id, { time_slot: e.target.value })}
                                disabled={processingId !== null}
                                className="bg-brand-surface-2 border border-transparent rounded-lg px-2 py-1 text-xs font-black text-brand-text w-20 focus:border-brand-accent focus:ring-1 focus:ring-brand-accent outline-none transition-colors [color-scheme:dark]"
                            />
                        </div>

                        {/* Teacher Transfer */}
                        <div className="flex items-center gap-2 flex-1 w-full md:w-auto">
                            <UserIcon size={12} className="text-brand-muted" />
                            <select
                                value={draft.teacher_id}
                                onChange={(e) => updateDraft(booking.id, { teacher_id: e.target.value })}
                                disabled={processingId !== null}
                                className="flex-1 bg-transparent text-xs font-bold text-brand-text border-b border-dashed border-brand-border focus:border-brand-accent outline-none py-1 truncate"
                            >
                                {teachers.map(t => (
                                    <option key={t.id} value={t.id}>Prof. {t.name}</option>
                                ))}
                            </select>
                        </div>

                        <button
                            type="button"
                            onClick={() => handleSaveBooking(booking.id)}
                            disabled={!changed || processingId !== null}
                            className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-2 text-[10px] font-black uppercase text-white disabled:opacity-40"
                        >
                            {processingId === booking.id ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />}
                            Salvar
                        </button>

                        {/* Delete */}
                        <button
                            onClick={() => handleDelete(booking.id)}
                            disabled={processingId !== null}
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
