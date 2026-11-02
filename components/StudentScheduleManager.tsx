import React, { useState, useEffect } from 'react';
import { Trash2, Plus, Calendar, User as UserIcon, CalendarClock, RefreshCw, ArrowRightLeft } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Teacher } from '../types';
import TeacherTransferGenerator from './TeacherTransferGenerator';
import DirectTeacherTransferModal from './DirectTeacherTransferModal';
import TeacherStudentScheduleEditor from './TeacherStudentScheduleEditor';

interface StudentScheduleManagerProps {
    studentId: string;
    tenantId: string;
    teachers: Teacher[]; // For selecting teacher
    student?: {
        id: string;
        full_name: string;
        professor_id?: string | null;
        class_frequency?: string | null;
    };
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

const StudentScheduleManager: React.FC<StudentScheduleManagerProps> = ({ studentId, tenantId, teachers, student, onUpdate }) => {
    const [bookings, setBookings] = useState<Booking[]>([]);
    const [loading, setLoading] = useState(true);
    const [isAdding, setIsAdding] = useState(false);
    const [showTransfer, setShowTransfer] = useState(false);
    const [showDirectTransfer, setShowDirectTransfer] = useState(false);
    const [currentTeacherId, setCurrentTeacherId] = useState(student?.professor_id || '');

    // New Slot State
    const [newSlot, setNewSlot] = useState({
        day: 'Segunda',
        time: '08:00',
        teacherId: ''
    });

    const [processingId, setProcessingId] = useState<string | null>(null);
    const [editingSchedule, setEditingSchedule] = useState<Booking | null>(null);

    useEffect(() => {
        fetchBookings();
    }, [studentId, tenantId]);

    useEffect(() => {
        setCurrentTeacherId(student?.professor_id || '');
    }, [student?.professor_id, studentId]);

    const fetchBookings = async () => {
        setLoading(true);
        try {
            const { data, error } = await supabase
                .from('bookings')
                .select('id, day_of_week, time_slot, teacher_id, teacher:teacher_id(full_name)')
                .eq('student_id', studentId)
                .eq('tenant_id', tenantId)
                .in('status', ['SCHEDULED', 'scheduled']);

            if (error) throw error;
            const nextBookings = (data || []).map((booking: any) => ({
                ...booking,
                teacher: Array.isArray(booking.teacher) ? booking.teacher[0] : booking.teacher,
            })) as Booking[];
            setBookings(nextBookings);

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

    if (loading && bookings.length === 0 && !isAdding) {
        return <div className="p-4 text-center text-brand-muted text-xs uppercase animate-pulse">Carregando agenda...</div>;
    }

    return (
        <div className="space-y-4">
            <div className="flex justify-between items-center mb-2">
                <h4 className="text-xs font-black uppercase tracking-widest text-brand-muted flex items-center gap-2">
                    <Calendar size={14} /> Agenda de Aulas
                </h4>
                <div className="flex flex-wrap justify-end gap-2">
                    {student && (
                        <button
                            type="button"
                            onClick={() => setShowDirectTransfer(true)}
                            className="text-[10px] font-bold uppercase tracking-wide text-white bg-indigo-600 hover:bg-indigo-700 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1"
                        >
                            <ArrowRightLeft size={12} /> Transferir definitivamente
                        </button>
                    )}
                    {student && (
                        <button
                            type="button"
                            onClick={() => setShowTransfer(true)}
                            className="text-[10px] font-bold uppercase tracking-wide text-indigo-500 hover:bg-indigo-500/10 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1 border border-indigo-500/20"
                        >
                            <ArrowRightLeft size={12} /> Transferir com aceite futuro
                        </button>
                    )}
                    <button
                        onClick={() => setIsAdding(!isAdding)}
                        className="text-[10px] font-bold uppercase tracking-wide text-brand-accent hover:bg-brand-accent/10 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1 border border-transparent hover:border-brand-accent/20"
                    >
                        <Plus size={12} /> Adicionar Dia
                    </button>
                </div>
            </div>

            {isAdding && (
                <div className="p-4 bg-brand-surface-2 rounded-xl border border-dashed border-brand-accent/50 mb-4 animate-in slide-in-from-top-2">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
                        <div>
                            <label className="text-[10px] text-brand-muted font-bold uppercase">Dia</label>
                            <select
                                value={newSlot.day}
                                onChange={e => setNewSlot({ ...newSlot, day: e.target.value })}
                                className="w-full p-2 rounded-lg bg-brand-surface border border-brand-border text-brand-text text-xs font-bold focus:ring-1 focus:ring-brand-accent focus:border-brand-accent outline-hidden"
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
                                className="w-full p-2 rounded-lg bg-brand-surface border border-brand-border text-brand-text text-xs font-bold focus:ring-1 focus:ring-brand-accent focus:border-brand-accent outline-hidden scheme-dark"
                            />
                        </div>
                        <div>
                            <label className="text-[10px] text-brand-muted font-bold uppercase">Professor</label>
                            <select
                                value={newSlot.teacherId}
                                onChange={e => setNewSlot({ ...newSlot, teacherId: e.target.value })}
                                className="w-full p-2 rounded-lg bg-brand-surface border border-brand-border text-brand-text text-xs font-bold focus:ring-1 focus:ring-brand-accent focus:border-brand-accent outline-hidden"
                            >
                                <option value="">Selecione...</option>
                                {teachers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                            </select>
                        </div>
                    </div>
                    <div className="flex justify-end gap-2">
                        <button onClick={() => setIsAdding(false)} className="px-3 py-1.5 text-xs font-bold text-brand-muted hover:text-brand-text transition-colors">Cancelar</button>
                        <button onClick={handleAddSlot} className="px-3 py-1.5 bg-brand-accent text-white rounded-lg text-xs font-bold uppercase shadow-xs hover:bg-brand-accent-hover transition-colors">Confirmar</button>
                    </div>
                </div>
            )}

            <div className="space-y-3">
                {bookings.map(booking => (
                    <div key={booking.id} className="p-3 bg-brand-surface border border-brand-border rounded-xl hover:shadow-[0_8px_30px_rgba(0,0,0,0.12)] transition-all flex flex-col md:flex-row items-center gap-4 group">
                        <div className="flex gap-2 items-center flex-1">
                            <span className="text-xs font-black text-brand-text">
                                {booking.day_of_week} · {booking.time_slot.slice(0, 5)}
                            </span>
                            <button
                                type="button"
                                onClick={() => setEditingSchedule(booking)}
                                className="px-3 py-2 rounded-lg bg-brand-accent text-white text-xs font-bold flex items-center gap-1"
                                aria-label={`Alterar horário de ${booking.day_of_week} ${booking.time_slot.slice(0, 5)}`}
                            >
                                <CalendarClock size={14} /> Alterar horário
                            </button>
                        </div>

                        {/* Professor é somente leitura aqui. Transferência altera a
                            grade inteira e exige o fluxo com data de corte e aceite. */}
                        <div className="flex items-center gap-2 flex-1 w-full md:w-auto">
                            <UserIcon size={12} className="text-brand-muted" />
                            <span className="flex-1 text-xs font-bold text-brand-text py-1 truncate">
                                Prof. {booking.teacher?.full_name || teachers.find(t => t.id === booking.teacher_id)?.name || 'Professor'}
                            </span>
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
                ))}

                {bookings.length === 0 && !isAdding && (
                    <div className="p-4 border border-dashed border-brand-border rounded-xl text-center">
                        <p className="text-[10px] font-bold text-brand-muted uppercase">Nenhuma aula agendada</p>
                    </div>
                )}
            </div>

            <p className="text-xs text-brand-muted">Para trocar um horário, use Alterar horário e Aplicar troca. Salvar Perfil salva somente os dados cadastrais.</p>
            {editingSchedule && (
                <TeacherStudentScheduleEditor
                    studentId={studentId}
                    studentName={student?.full_name || 'Aluno'}
                    tenantId={tenantId}
                    teacherId={editingSchedule.teacher_id}
                    bookingId={editingSchedule.id}
                    managerMode
                    onClose={() => setEditingSchedule(null)}
                    onChanged={() => {
                        void fetchBookings();
                        onUpdate?.();
                    }}
                />
            )}
            {showTransfer && student && (
                <TeacherTransferGenerator
                    tenantId={tenantId}
                    student={{ ...student, professor_id: currentTeacherId || student.professor_id }}
                    onClose={() => setShowTransfer(false)}
                />
            )}
            {showDirectTransfer && student && (
                <DirectTeacherTransferModal
                    student={{ ...student, professor_id: currentTeacherId || student.professor_id }}
                    teachers={teachers}
                    currentSchedules={bookings.map(booking => ({ day_of_week: booking.day_of_week, time_slot: booking.time_slot }))}
                    onClose={() => setShowDirectTransfer(false)}
                    onTransferred={async teacherId => {
                        setCurrentTeacherId(teacherId);
                        await fetchBookings();
                        onUpdate?.();
                    }}
                />
            )}
        </div>
    );
};

export default StudentScheduleManager;
