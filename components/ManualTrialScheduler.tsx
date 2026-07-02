import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Calendar, Clock, User, Phone, Search, X, Check, Beaker } from 'lucide-react';

interface ManualTrialSchedulerProps {
    tenantId: string;
    teachers: { id: string; name?: string; full_name?: string }[];
    onClose: () => void;
    onSuccess?: () => void;
}

const ManualTrialScheduler: React.FC<ManualTrialSchedulerProps> = ({ tenantId, teachers, onClose, onSuccess }) => {
    const [leadName, setLeadName] = useState('');
    const [leadPhone, setLeadPhone] = useState('');
    const [selectedTeacher, setSelectedTeacher] = useState('');
    const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
    const [time, setTime] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const timeSlots = [
        '07:00', '07:30', '08:00', '08:30', '09:00', '09:30',
        '10:00', '10:30', '11:00', '11:30', '12:00', '12:30',
        '13:00', '13:30', '14:00', '14:30', '15:00', '15:30',
        '16:00', '16:30', '17:00', '17:30', '18:00', '18:30',
        '19:00', '19:30', '20:00', '20:30', '21:00', '21:30'
    ];

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!selectedTeacher || !date || !time || !leadName) {
            setError('Preencha todos os campos obrigatórios.');
            return;
        }
        setLoading(true);
        setError('');

        try {
            // 1. Create an opportunity entry for tracking
            const { data: opportunity, error: oppError } = await supabase
                .from('opportunities')
                .insert({
                    tenant_id: tenantId,
                    student_name: leadName,
                    student_phone: leadPhone,
                    winner_teacher_id: selectedTeacher,
                    status: 'CLAIMED',
                    slots_proposed: [],
                })
                .select()
                .single();

            if (oppError) throw oppError;

            // 2. Create appointment entry (so it appears in teacher's schedule)
            const { error: apptError } = await supabase
                .from('appointments')
                .insert({
                    tenant_id: tenantId,
                    teacher_id: selectedTeacher,
                    opportunity_id: opportunity.id,
                    date,
                    time,
                    type: 'experimental',
                    student_name: leadName,
                    student_phone: leadPhone,
                    status: 'SCHEDULED'
                });

            if (apptError) throw apptError;

            alert('✅ Aula experimental agendada com sucesso!');
            onSuccess?.();
            onClose();
        } catch (err: any) {
            console.error('Error scheduling trial:', err);
            setError(err.message || 'Erro ao agendar aula experimental');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in">
            <div className="bg-brand-surface rounded-3xl p-6 sm:p-8 max-w-lg w-full shadow-2xl relative max-h-[90dvh] overflow-y-auto">
                <button
                    onClick={onClose}
                    className="absolute top-4 right-4 text-brand-muted hover:text-brand-muted transition-colors"
                >
                    <X size={20} />
                </button>

                <div className="flex items-center gap-3 mb-6">
                    <div className="p-2 bg-purple-100 dark:bg-purple-900/30 rounded-xl">
                        <Beaker size={20} className="text-purple-600" />
                    </div>
                    <div>
                        <h3 className="text-xl font-black text-brand-text">Agendar Experimental</h3>
                        <p className="text-xs text-brand-muted">Agendar aula experimental manual para qualquer professor</p>
                    </div>
                </div>

                {error && (
                    <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600 font-medium">
                        {error}
                    </div>
                )}

                <form onSubmit={handleSubmit} className="space-y-4">
                    {/* Lead Name */}
                    <div>
                        <label className="text-xs font-bold uppercase text-brand-muted mb-1 block">Nome do Lead / Aluno</label>
                        <input
                            required
                            value={leadName}
                            onChange={e => setLeadName(e.target.value)}
                            placeholder="Nome completo"
                            className="w-full px-4 py-3 bg-brand-surface-2 rounded-xl text-sm font-bold text-brand-text outline-none focus:ring-2 focus:ring-purple-500"
                        />
                    </div>

                    {/* Lead Phone */}
                    <div>
                        <label className="text-xs font-bold uppercase text-brand-muted mb-1 block">WhatsApp</label>
                        <input
                            value={leadPhone}
                            onChange={e => setLeadPhone(e.target.value)}
                            placeholder="(XX) XXXXX-XXXX"
                            className="w-full px-4 py-3 bg-brand-surface-2 rounded-xl text-sm font-bold text-brand-text outline-none focus:ring-2 focus:ring-purple-500"
                        />
                    </div>

                    {/* Teacher Select */}
                    <div>
                        <label className="text-xs font-bold uppercase text-brand-muted mb-1 block">Professor</label>
                        <select
                            required
                            value={selectedTeacher}
                            onChange={e => setSelectedTeacher(e.target.value)}
                            className="w-full px-4 py-3 bg-brand-surface-2 rounded-xl text-sm font-bold text-brand-text outline-none focus:ring-2 focus:ring-purple-500"
                        >
                            <option value="">Selecione o professor</option>
                            {teachers.map(t => (
                                <option key={t.id} value={t.id}>{t.name || t.full_name}</option>
                            ))}
                        </select>
                    </div>

                    {/* Date and Time */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <label className="text-xs font-bold uppercase text-brand-muted mb-1 block">Data</label>
                            <input
                                type="date"
                                required
                                value={date}
                                onChange={e => setDate(e.target.value)}
                                className="w-full px-4 py-3 bg-brand-surface-2 rounded-xl text-sm font-bold text-brand-text outline-none focus:ring-2 focus:ring-purple-500"
                            />
                        </div>
                        <div>
                            <label className="text-xs font-bold uppercase text-brand-muted mb-1 block">Horário</label>
                            <select
                                required
                                value={time}
                                onChange={e => setTime(e.target.value)}
                                className="w-full px-4 py-3 bg-brand-surface-2 rounded-xl text-sm font-bold text-brand-text outline-none focus:ring-2 focus:ring-purple-500"
                            >
                                <option value="">Selecione</option>
                                {timeSlots.map(slot => (
                                    <option key={slot} value={slot}>{slot}</option>
                                ))}
                            </select>
                        </div>
                    </div>

                    {/* Action Buttons */}
                    <div className="flex gap-3 pt-4">
                        <button
                            type="button"
                            onClick={onClose}
                            className="flex-1 py-3 bg-brand-surface-2 dark:bg-brand-surface-2 text-brand-muted font-bold rounded-xl hover:bg-slate-200 transition-colors"
                        >
                            Cancelar
                        </button>
                        <button
                            type="submit"
                            disabled={loading}
                            className="flex-[2] py-3 bg-purple-600 text-white font-bold rounded-xl hover:bg-purple-700 transition-colors shadow-lg shadow-purple-500/20 flex items-center justify-center gap-2 disabled:opacity-50"
                        >
                            {loading ? (
                                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                            ) : (
                                <>
                                    <Check size={16} /> Agendar
                                </>
                            )}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default ManualTrialScheduler;
