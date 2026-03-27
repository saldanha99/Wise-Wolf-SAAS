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
    id: number;
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

    const [processingId, setProcessingId] = useState<number | null>(null);

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
            setBookings(data || []);
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

    const handleDelete = async (id: number) => {
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

    const handleTransfer = async (bookingId: number, newTeacherId: string) => {
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

    const handleTimeChange = async (bookingId: number, field: 'day_of_week' | 'time_slot', value: string) => {
        setProcessingId(bookingId);
        try {
            const { error } = await supabase
                .from('bookings')
                .update({ [field]: value })
                .eq('id', bookingId);

            if (error) throw error;
            fetchBookings();
            if (onUpdate) onUpdate();
        } catch (error: any) {
            alert('Erro ao atualizar horário: ' + error.message);
        } finally {
            setProcessingId(null);
        }
    };

    if (loading && bookings.length === 0 && !isAdding) {
        return <div className="p-4 text-center text-slate-400 text-xs uppercase animate-pulse">Carregando agenda...</div>;
    }

    return (
        <div className="space-y-4">
            <div className="flex justify-between items-center mb-2">
                <h4 className="text-xs font-black uppercase tracking-widest text-slate-500 flex items-center gap-2">
                    <Calendar size={14} /> Agenda de Aulas
                </h4>
                <button
                    onClick={() => setIsAdding(!isAdding)}
                    className="text-[10px] font-bold uppercase tracking-wide text-tenant-primary hover:bg-tenant-primary/10 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1"
                >
                    <Plus size={12} /> Adicionar Dia
                </button>
            </div>

            {isAdding && (
                <div className="p-4 bg-slate-50 dark:bg-slate-800 rounded-xl border border-dashed border-tenant-primary/50 mb-4 animate-in slide-in-from-top-2">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
                        <div>
                            <label className="text-[10px] text-slate-400 font-bold uppercase">Dia</label>
                            <select
                                value={newSlot.day}
                                onChange={e => setNewSlot({ ...newSlot, day: e.target.value })}
                                className="w-full p-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs font-bold"
                            >
                                {DAYS_OF_WEEK.map(d => <option key={d} value={d}>{d}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className="text-[10px] text-slate-400 font-bold uppercase">Horário</label>
                            <input
                                type="time"
                                value={newSlot.time}
                                onChange={e => setNewSlot({ ...newSlot, time: e.target.value })}
                                className="w-full p-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs font-bold"
                            />
                        </div>
                        <div>
                            <label className="text-[10px] text-slate-400 font-bold uppercase">Professor</label>
                            <select
                                value={newSlot.teacherId}
                                onChange={e => setNewSlot({ ...newSlot, teacherId: e.target.value })}
                                className="w-full p-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs font-bold"
                            >
                                <option value="">Selecione...</option>
                                {teachers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                            </select>
                        </div>
                    </div>
                    <div className="flex justify-end gap-2">
                        <button onClick={() => setIsAdding(false)} className="px-3 py-1.5 text-xs font-bold text-slate-500">Cancelar</button>
                        <button onClick={handleAddSlot} className="px-3 py-1.5 bg-tenant-primary text-white rounded-lg text-xs font-bold uppercase shadow-sm">Confirmar</button>
                    </div>
                </div>
            )}

            <div className="space-y-3">
                {bookings.map(booking => (
                    <div key={booking.id} className="p-3 bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 rounded-xl hover:shadow-md transition-all flex flex-col md:flex-row items-center gap-4 group">

                        {/* Day & Time Editor */}
                        <div className="flex gap-2 items-center flex-1">
                            <select
                                value={booking.day_of_week}
                                onChange={(e) => handleTimeChange(booking.id, 'day_of_week', e.target.value)}
                                disabled={processingId === booking.id}
                                className="bg-slate-50 dark:bg-slate-800 border-none rounded-lg px-2 py-1 text-xs font-black text-slate-700 dark:text-slate-200 uppercase w-24 focus:ring-1 focus:ring-tenant-primary"
                            >
                                {DAYS_OF_WEEK.map(d => <option key={d} value={d}>{d}</option>)}
                            </select>

                            <input
                                type="time"
                                value={booking.time_slot}
                                onChange={(e) => handleTimeChange(booking.id, 'time_slot', e.target.value)}
                                disabled={processingId === booking.id}
                                className="bg-slate-50 dark:bg-slate-800 border-none rounded-lg px-2 py-1 text-xs font-black text-slate-700 dark:text-slate-200 w-20 focus:ring-1 focus:ring-tenant-primary"
                            />
                        </div>

                        {/* Teacher Transfer */}
                        <div className="flex items-center gap-2 flex-1 w-full md:w-auto">
                            <UserIcon size={12} className="text-slate-400" />
                            <select
                                value={booking.teacher_id}
                                onChange={(e) => handleTransfer(booking.id, e.target.value)}
                                disabled={processingId === booking.id}
                                className="flex-1 bg-transparent text-xs font-bold text-slate-600 dark:text-slate-300 border-b border-dashed border-slate-300 dark:border-slate-700 focus:border-tenant-primary outline-none py-1 truncate"
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
                            className="p-2 text-slate-300 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
                            title="Remover Aula"
                        >
                            {processingId === booking.id ? <RefreshCw size={14} className="animate-spin" /> : <Trash2 size={14} />}
                        </button>
                    </div>
                ))}

                {bookings.length === 0 && !isAdding && (
                    <div className="p-4 border border-dashed border-slate-200 dark:border-slate-800 rounded-xl text-center">
                        <p className="text-[10px] font-bold text-slate-400 uppercase">Nenhuma aula agendada</p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default StudentScheduleManager;
