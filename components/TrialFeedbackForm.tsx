import React, { useState, useEffect } from 'react';
import { X, Star, BookOpen, ThermometerSun, FileText, Check, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';

interface TrialFeedbackFormProps {
    opportunityId: string;
    bookingId?: string;
    teacherId: string;
    tenantId: string;
    studentName: string;
    onClose: () => void;
    onSaved?: () => void;
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
    bookingId,
    teacherId,
    tenantId,
    studentName,
    onClose,
    onSaved
}) => {
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [existingId, setExistingId] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);

    // Form fields
    const [level, setLevel] = useState('A1');
    const [plan, setPlan] = useState('2x_semana');
    const [interest, setInterest] = useState(3);
    const [notes, setNotes] = useState('');

    // Load existing feedback
    useEffect(() => {
        const loadExisting = async () => {
            const { data } = await supabase
                .from('trial_feedback')
                .select('*')
                .eq('opportunity_id', opportunityId)
                .maybeSingle();

            if (data) {
                setExistingId(data.id);
                setLevel(data.recommended_level || 'A1');
                setPlan(data.recommended_plan || '2x_semana');
                setInterest(data.interest_score || 3);
                setNotes(data.notes || '');
            }
            setLoading(false);
        };
        loadExisting();
    }, [opportunityId]);

    const handleSave = async () => {
        setSaving(true);
        try {
            const payload = {
                tenant_id: tenantId,
                opportunity_id: opportunityId,
                booking_id: bookingId || null,
                teacher_id: teacherId,
                recommended_level: level,
                recommended_plan: plan,
                interest_score: interest,
                notes: notes.trim() || null,
            };

            if (existingId) {
                // Update
                const { error } = await supabase
                    .from('trial_feedback')
                    .update(payload)
                    .eq('id', existingId);
                if (error) throw error;
            } else {
                // Insert
                const { error } = await supabase
                    .from('trial_feedback')
                    .insert(payload);
                if (error) throw error;
            }

            // Update opportunity trial_status to DONE (teacher is giving feedback, class happened)
            await supabase
                .from('opportunities')
                .update({ trial_status: 'DONE' })
                .eq('id', opportunityId);

            setSaved(true);
            setTimeout(() => {
                onSaved?.();
                onClose();
            }, 1500);

        } catch (err: any) {
            console.error('Error saving feedback:', err);
            alert('Erro ao salvar: ' + err.message);
        } finally {
            setSaving(false);
        }
    };

    // Saved success
    if (saved) {
        return (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
                <div className="bg-brand-surface rounded-3xl p-8 max-w-md w-full text-center animate-in zoom-in-95">
                    <div className="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4">
                        <Check size={40} className="text-emerald-600" />
                    </div>
                    <h2 className="text-2xl font-black text-brand-text mb-1">Feedback Salvo!</h2>
                    <p className="text-brand-muted text-sm">A direção pode agora gerar o contrato.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            <div className="bg-brand-surface rounded-3xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
                {/* Header */}
                <div className="bg-gradient-to-br from-indigo-600 to-purple-700 rounded-t-3xl p-6 text-white relative">
                    <button onClick={onClose} className="absolute top-4 right-4 p-2 rounded-xl bg-brand-surface/10 hover:bg-brand-surface/20 transition-colors">
                        <X size={18} />
                    </button>
                    <div className="flex items-center gap-3 mb-3">
                        <div className="w-12 h-12 rounded-2xl bg-brand-surface/20 flex items-center justify-center backdrop-blur-sm">
                            <BookOpen size={24} />
                        </div>
                        <div>
                            <p className="text-[10px] tracking-wider font-bold opacity-70 uppercase">Feedback da Experimental</p>
                            <h2 className="text-xl font-black">{studentName}</h2>
                        </div>
                    </div>
                </div>

                {loading ? (
                    <div className="p-12 flex items-center justify-center">
                        <Loader2 className="animate-spin text-indigo-500" size={32} />
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
                            <div className="grid grid-cols-6 gap-2">
                                {LEVELS.map(l => (
                                    <button
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
                                placeholder="Comportamento do aluno, pontos fortes/fracos, impressão geral..."
                                className="w-full rounded-2xl border border-brand-border px-4 py-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none transition-all"
                            />
                        </div>

                        {/* Submit */}
                        <button
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
