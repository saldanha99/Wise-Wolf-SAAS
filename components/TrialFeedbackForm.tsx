import React, { useState, useEffect, useRef } from 'react';
import { X, Star, BookOpen, ThermometerSun, FileText, Check, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';

interface TrialFeedbackFormProps {
    opportunityId: string;
    studentName: string;
    onClose: () => void;
    onSaved?: () => void | Promise<void>;
}

const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const PLANS = [
    { value: '1x_semana', label: '1x por semana' },
    { value: '2x_semana', label: '2x por semana' },
    { value: '3x_semana', label: '3x por semana' },
    { value: 'intensivo', label: 'Intensivo (5x)' },
];

const TrialFeedbackForm: React.FC<TrialFeedbackFormProps> = ({
    opportunityId,
    studentName,
    onClose,
    onSaved
}) => {
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [existingId, setExistingId] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [saveError, setSaveError] = useState<string | null>(null);
    const [loadVersion, setLoadVersion] = useState(0);
    const submissionRef = useRef<{ fingerprint: string; requestId: string } | null>(null);

    // Form fields
    const [level, setLevel] = useState('A1');
    const [plan, setPlan] = useState('2x_semana');
    const [interest, setInterest] = useState(3);
    const [notes, setNotes] = useState('');

    // Load existing feedback
    useEffect(() => {
        let active = true;
        const loadExisting = async () => {
            setLoading(true);
            setLoadError(null);
            const { data, error } = await supabase
                .from('trial_feedback')
                .select('id, recommended_level, recommended_plan, interest_score, notes')
                .eq('opportunity_id', opportunityId)
                .maybeSingle();

            if (!active) return;
            if (error) {
                setLoadError('Não foi possível carregar a avaliação atual. Tente novamente para evitar sobrescrever informações.');
                setLoading(false);
                return;
            }
            if (data) {
                setExistingId(data.id);
                setLevel(data.recommended_level || 'A1');
                setPlan(data.recommended_plan || '2x_semana');
                setInterest(data.interest_score || 3);
                setNotes(data.notes || '');
            }
            setLoading(false);
        };
        void loadExisting();
        return () => { active = false; };
    }, [opportunityId, loadVersion]);

    const handleSave = async () => {
        if (saving || loadError) return;
        setSaving(true);
        setSaveError(null);
        try {
            const feedbackPayload = {
                opportunityId,
                recommendedLevel: level,
                recommendedPlan: plan,
                interestScore: interest,
                notes: notes.trim() || null,
            };
            const fingerprint = JSON.stringify(feedbackPayload);
            if (submissionRef.current?.fingerprint !== fingerprint) {
                submissionRef.current = { fingerprint, requestId: crypto.randomUUID() };
            }
            const { data, error } = await supabase.rpc(
                'update_trial_outcome_secure',
                {
                    p_payload: {
                        requestId: submissionRef.current.requestId,
                        action: 'SAVE_FEEDBACK',
                        ...feedbackPayload,
                    },
                }
            );
            if (error || data?.ok !== true) {
                const code = data?.error;
                const message = code === 'appointment_required'
                    ? 'Esta experimental não possui um agendamento válido.'
                    : code === 'appointment_tenant_mismatch'
                        ? 'O agendamento não pertence a esta escola ou professor.'
                        : code === 'teacher_not_active_for_tenant'
                            ? 'Seu vínculo como professor não está ativo.'
                            : code === 'appointment_not_settleable'
                                ? 'A aula ainda não está concluída no sistema. Atualize a agenda e tente novamente.'
                                : code === 'appointment_not_ended'
                                    ? 'Aguarde o término da aula experimental antes de salvar a avaliação.'
                                    : code === 'completed_class_log_required'
                                        ? 'Primeiro lance a aula experimental como realizada na sua agenda; depois conclua o feedback.'
                                : code === 'class_log_tenant_mismatch'
                                    ? 'O registro da aula precisa ser revisado pela gestão antes do feedback.'
                                    : code === 'opportunity_already_won'
                                        ? 'Esta oportunidade já foi convertida e não aceita mais alterações.'
                                        : code === 'forbidden'
                                            ? 'Somente o professor responsável pode salvar este feedback.'
                                            : error?.message || 'Não foi possível salvar o feedback.';
                if (code === 'idempotency_key_reused') submissionRef.current = null;
                throw new Error(message);
            }

            setSaved(true);
            void Promise.resolve(onSaved?.()).catch(error => {
                console.error('Error refreshing trial feedback state:', error);
            });

        } catch (err: any) {
            console.error('Error saving feedback:', err);
            setSaveError(err?.message || 'Não foi possível salvar o feedback.');
        } finally {
            setSaving(false);
        }
    };

    // Saved success
    if (saved) {
        return (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" role="dialog" aria-modal="true" aria-labelledby="trial-feedback-saved-title">
                <div className="bg-brand-surface rounded-3xl p-8 max-w-md w-full text-center animate-in zoom-in-95">
                    <div className="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4">
                        <Check size={40} className="text-emerald-600" />
                    </div>
                    <h2 id="trial-feedback-saved-title" className="text-2xl font-black text-brand-text mb-1">Feedback salvo!</h2>
                    <p className="text-brand-muted text-sm">A direção pode agora gerar o contrato.</p>
                    <button
                        type="button"
                        onClick={onClose}
                        className="mt-6 w-full rounded-2xl bg-emerald-600 px-4 py-3 text-sm font-bold text-white hover:bg-emerald-700"
                    >
                        Concluir
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" role="dialog" aria-modal="true" aria-labelledby="trial-feedback-title">
            <div className="bg-brand-surface rounded-3xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
                {/* Header */}
                <div className="bg-gradient-to-br from-indigo-600 to-purple-700 rounded-t-3xl p-6 text-white relative">
                    <button type="button" onClick={onClose} aria-label="Fechar feedback" className="absolute top-4 right-4 p-2 rounded-xl bg-brand-surface/10 hover:bg-brand-surface/20 transition-colors">
                        <X size={18} />
                    </button>
                    <div className="flex min-w-0 items-center gap-3 pr-8 mb-3">
                        <div className="w-12 h-12 rounded-2xl bg-brand-surface/20 flex items-center justify-center backdrop-blur-sm">
                            <BookOpen size={24} />
                        </div>
                        <div className="min-w-0">
                            <p className="text-[10px] tracking-wider font-bold opacity-70 uppercase">Feedback da Experimental</p>
                            <h2 id="trial-feedback-title" className="break-words text-lg font-black sm:text-xl">{studentName}</h2>
                        </div>
                    </div>
                </div>

                {loading ? (
                    <div className="p-12 flex items-center justify-center">
                        <Loader2 className="animate-spin text-indigo-500" size={32} />
                    </div>
                ) : loadError ? (
                    <div className="p-6">
                        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700" role="status">
                            {loadError}
                        </div>
                        <div className="mt-4 flex gap-2">
                            <button
                                type="button"
                                onClick={onClose}
                                className="flex-1 rounded-xl border border-brand-border px-4 py-3 text-sm font-bold text-brand-muted"
                            >
                                Fechar
                            </button>
                            <button
                                type="button"
                                onClick={() => setLoadVersion(version => version + 1)}
                                className="flex-1 rounded-xl bg-indigo-600 px-4 py-3 text-sm font-bold text-white"
                            >
                                Tentar novamente
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="p-6 space-y-6">
                        {existingId && (
                            <div className="text-xs text-amber-600 bg-amber-50 rounded-xl px-4 py-2 font-medium border border-amber-100">
                                ✏️ Editando feedback existente
                            </div>
                        )}

                        {/* Level Selector */}
                        <div>
                            <label className="text-xs font-black uppercase tracking-wider text-brand-muted mb-2 block">
                                Nível Recomendado
                            </label>
                            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                                {LEVELS.map(l => (
                                    <button
                                        type="button"
                                        key={l}
                                        onClick={() => setLevel(l)}
                                        className={`py-3 rounded-xl text-sm font-bold transition-all ${level === l
                                                ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200 scale-105'
                                                : 'bg-brand-surface-2 text-brand-muted hover:bg-slate-200'
                                            }`}
                                    >
                                        {l}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Plan Selector */}
                        <div>
                            <label className="text-xs font-black uppercase tracking-wider text-brand-muted mb-2 block">
                                Plano Recomendado
                            </label>
                            <div className="grid grid-cols-2 gap-2">
                                {PLANS.map(p => (
                                    <button
                                        type="button"
                                        key={p.value}
                                        onClick={() => setPlan(p.value)}
                                        className={`py-3 px-4 rounded-xl text-sm font-semibold transition-all text-left ${plan === p.value
                                                ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200'
                                                : 'bg-brand-surface-2 text-brand-muted hover:bg-slate-200'
                                            }`}
                                    >
                                        {p.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Interest Score */}
                        <div>
                            <label className="text-xs font-black uppercase tracking-wider text-brand-muted mb-2 flex items-center gap-2">
                                <ThermometerSun size={14} />
                                Interesse do Lead (1–5)
                            </label>
                            <div className="flex gap-2">
                                {[1, 2, 3, 4, 5].map(score => (
                                    <button
                                        type="button"
                                        key={score}
                                        onClick={() => setInterest(score)}
                                        className={`flex-1 py-3 rounded-xl flex items-center justify-center transition-all ${interest >= score
                                                ? score <= 2 ? 'bg-red-100 text-red-500'
                                                    : score === 3 ? 'bg-amber-100 text-amber-500'
                                                        : 'bg-emerald-100 text-emerald-500'
                                                : 'bg-brand-surface-2 text-slate-300'
                                            }`}
                                    >
                                        <Star size={20} fill={interest >= score ? 'currentColor' : 'none'} />
                                    </button>
                                ))}
                            </div>
                            <p className="text-xs text-brand-muted mt-1 text-center">
                                {interest <= 2 ? '🥶 Frio' : interest === 3 ? '🤔 Morno' : '🔥 Quente!'}
                            </p>
                        </div>

                        {/* Notes */}
                        <div>
                            <label className="text-xs font-black uppercase tracking-wider text-brand-muted mb-2 flex items-center gap-2">
                                <FileText size={14} />
                                Observações
                            </label>
                            <textarea
                                value={notes}
                                onChange={(e) => setNotes(e.target.value)}
                                rows={3}
                                maxLength={4000}
                                placeholder="Comportamento do aluno, pontos fortes/fracos, impressão geral..."
                                className="w-full rounded-2xl border border-brand-border px-4 py-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none transition-all"
                            />
                        </div>

                        {saveError && (
                            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700" role="status">
                                {saveError}
                            </div>
                        )}

                        {/* Submit */}
                        <button
                            type="button"
                            onClick={handleSave}
                            disabled={saving}
                            className="w-full py-4 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-2xl font-bold text-lg shadow-xl shadow-indigo-200 hover:shadow-indigo-300 active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-70"
                        >
                            {saving ? (
                                <>
                                    <Loader2 className="animate-spin" size={20} />
                                    Salvando...
                                </>
                            ) : (
                                <>
                                    <Check size={20} />
                                    {existingId ? 'Atualizar Feedback' : 'Salvar Feedback'}
                                </>
                            )}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};

export default TrialFeedbackForm;
