import React, { useState } from 'react';
import { supabase } from '../lib/supabase';
import { X, Check, Beaker, Copy, ExternalLink } from 'lucide-react';

interface ManualTrialSchedulerProps {
    tenantId: string;
    teachers: { id: string; name?: string; full_name?: string }[];
    onClose: () => void;
    onSuccess?: () => void;
}

const ManualTrialScheduler: React.FC<ManualTrialSchedulerProps> = ({ teachers, onClose, onSuccess }) => {
    const [leadName, setLeadName] = useState('');
    const [leadPhone, setLeadPhone] = useState('');
    const [selectedTeacher, setSelectedTeacher] = useState('');
    const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
    const [time, setTime] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [confirmationUrl, setConfirmationUrl] = useState('');
    const [copied, setCopied] = useState(false);
    const [requestId] = useState(() => crypto.randomUUID());

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
            const startsAt = new Date(`${date}T${time}:00-03:00`);
            if (Number.isNaN(startsAt.getTime())) {
                throw new Error('Data ou horário inválido.');
            }
            const { data, error: scheduleError } = await supabase.rpc(
                'schedule_manual_trial_secure',
                {
                    p_payload: {
                        requestId,
                        teacherId: selectedTeacher,
                        studentName: leadName.trim(),
                        studentPhone: leadPhone.replace(/\D/g, '') || null,
                        startsAt: startsAt.toISOString(),
                    },
                }
            );

            if (scheduleError || data?.ok !== true) {
                const code = data?.error;
                const message = code === 'teacher_schedule_conflict'
                    ? 'O professor já tem outro compromisso nesse horário.'
                    : code === 'teacher_not_active_for_tenant'
                        ? 'O professor não está ativo nesta escola.'
                        : code === 'tenant_not_operational'
                            ? 'A escola não está disponível para novas solicitações.'
                            : scheduleError?.message || 'Erro ao solicitar aula experimental';
                throw new Error(message);
            }
            if (typeof data.teacherConfirmationUrl !== 'string' || !data.teacherConfirmationUrl) {
                throw new Error('A solicitação foi criada, mas o link seguro do professor não foi retornado.');
            }

            setConfirmationUrl(data.teacherConfirmationUrl);
            onSuccess?.();
        } catch (err: any) {
            console.error('Error scheduling trial:', err);
            setError(err.message || 'Erro ao solicitar aula experimental');
        } finally {
            setLoading(false);
        }
    };

    const copyConfirmationUrl = async () => {
        try {
            await navigator.clipboard.writeText(confirmationUrl);
            setCopied(true);
        } catch {
            setError('Não foi possível copiar automaticamente. Selecione o link abaixo.');
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
                        <h3 className="text-xl font-black text-brand-text">Solicitar Experimental</h3>
                        <p className="text-xs text-brand-muted">A aula só será agendada após o aceite do professor</p>
                    </div>
                </div>

                {error && (
                    <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600 font-medium">
                        {error}
                    </div>
                )}

                {confirmationUrl ? (
                    <div className="space-y-4">
                        <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900">
                            <p className="font-black">Solicitação criada — nenhuma aula foi agendada ainda.</p>
                            <p className="mt-1">Envie este link somente ao professor selecionado. O horário será confirmado quando ele aceitar.</p>
                        </div>
                        <input
                            readOnly
                            value={confirmationUrl}
                            onFocus={(event) => event.currentTarget.select()}
                            className="w-full px-4 py-3 bg-brand-surface-2 rounded-xl text-xs text-brand-text outline-none"
                            aria-label="Link seguro para aceite do professor"
                        />
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <button
                                type="button"
                                onClick={copyConfirmationUrl}
                                className="py-3 bg-purple-600 text-white font-bold rounded-xl hover:bg-purple-700 flex items-center justify-center gap-2"
                            >
                                <Copy size={16} /> {copied ? 'Link copiado' : 'Copiar link'}
                            </button>
                            <a
                                href={confirmationUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="py-3 bg-brand-surface-2 text-brand-text font-bold rounded-xl flex items-center justify-center gap-2"
                            >
                                <ExternalLink size={16} /> Abrir link
                            </a>
                        </div>
                        <button
                            type="button"
                            onClick={onClose}
                            className="w-full py-3 text-brand-muted font-bold"
                        >
                            Fechar
                        </button>
                    </div>
                ) : (
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
                                    <Check size={16} /> Enviar solicitação
                                </>
                            )}
                        </button>
                    </div>
                </form>
                )}
            </div>
        </div>
    );
};

export default ManualTrialScheduler;
