import React, { useState, useEffect } from 'react';
import { MessageSquare, Save, Loader2, Check, Bell, BellOff, Eye, RefreshCw } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { DEFAULT_REMINDER_TEMPLATE, REMINDER_TEMPLATE_VARIABLES } from '../services/whatsappService';

interface Props {
    user: { id: string };
}

const PREVIEW_VARS: Record<string, string> = {
    student_name: 'Maria',
    class_time: '19:00',
    teacher_name: 'João Silva',
    class_link: 'https://meet.google.com/abc-defg-hij',
    tenant_name: 'Wise Wolf São Paulo',
};

const renderPreview = (template: string): string =>
    template.replace(/\{(\w+)\}/g, (_, key) => PREVIEW_VARS[key] ?? `{${key}}`);

const TeacherMessageSettings: React.FC<Props> = ({ user }) => {
    const [loading, setLoading] = useState(true);
    const [template, setTemplate] = useState('');
    const [automationEnabled, setAutomationEnabled] = useState(false);
    const [saving, setSaving] = useState(false);
    const [savedFeedback, setSavedFeedback] = useState(false);
    const [textareaRef, setTextareaRef] = useState<HTMLTextAreaElement | null>(null);

    useEffect(() => {
        load();
    }, [user.id]);

    const load = async () => {
        setLoading(true);
        try {
            const { data } = await supabase
                .from('profiles')
                .select('lesson_reminder_template, date_automation_enabled')
                .eq('id', user.id)
                .single();
            setTemplate(data?.lesson_reminder_template || DEFAULT_REMINDER_TEMPLATE);
            setAutomationEnabled(data?.date_automation_enabled === true);
        } catch (err) {
            console.error('Load template error:', err);
            setTemplate(DEFAULT_REMINDER_TEMPLATE);
        } finally {
            setLoading(false);
        }
    };

    const save = async () => {
        setSaving(true);
        try {
            const { error } = await supabase
                .from('profiles')
                .update({
                    lesson_reminder_template: template.trim() || null,
                    date_automation_enabled: automationEnabled,
                })
                .eq('id', user.id);
            if (error) throw error;
            setSavedFeedback(true);
            setTimeout(() => setSavedFeedback(false), 3000);
        } catch (err: any) {
            alert('Erro ao salvar: ' + err.message);
        } finally {
            setSaving(false);
        }
    };

    const insertVariable = (variable: string) => {
        if (!textareaRef) return;
        const start = textareaRef.selectionStart;
        const end = textareaRef.selectionEnd;
        const before = template.slice(0, start);
        const after = template.slice(end);
        const newValue = before + variable + after;
        setTemplate(newValue);
        // Reposicionar cursor depois da variavel inserida
        setTimeout(() => {
            const pos = start + variable.length;
            textareaRef.focus();
            textareaRef.setSelectionRange(pos, pos);
        }, 10);
    };

    const resetToDefault = () => {
        if (!confirm('Restaurar o template padrão?')) return;
        setTemplate(DEFAULT_REMINDER_TEMPLATE);
    };

    if (loading) {
        return (
            <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 p-12 flex items-center justify-center">
                <Loader2 className="animate-spin text-violet-500" size={24} />
            </div>
        );
    }

    const preview = renderPreview(template || DEFAULT_REMINDER_TEMPLATE);

    return (
        <div className="space-y-4">
            {/* Header */}
            <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 overflow-hidden">
                <div className="flex items-center justify-between border-b border-slate-100 p-4 dark:border-slate-800 sm:p-6">
                    <div className="flex min-w-0 items-start gap-3 sm:items-center">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-100 dark:bg-emerald-900/30">
                            <MessageSquare size={20} className="text-emerald-600 dark:text-emerald-400" />
                        </div>
                        <div className="min-w-0">
                            <h3 className="font-black text-slate-800 dark:text-white text-sm">Lembrete de Aula via WhatsApp</h3>
                            <p className="text-[10px] text-slate-400 uppercase tracking-widest">Disparado automaticamente 60 minutos antes de cada aula</p>
                        </div>
                    </div>
                </div>

                {/* Automation toggle */}
                <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-800">
                    <div className="flex items-center justify-between gap-4">
                        <div className="flex min-w-0 items-start gap-3 sm:items-center">
                            {automationEnabled ? <Bell size={16} className="text-emerald-500" /> : <BellOff size={16} className="text-slate-400" />}
                            <div className="min-w-0">
                                <p className="text-sm font-black text-slate-800 dark:text-white">
                                    {automationEnabled ? 'Automação ligada' : 'Automação desligada'}
                                </p>
                                <p className="text-xs text-slate-500">
                                    {automationEnabled
                                        ? 'Seus alunos receberão um lembrete automático 1h antes de cada aula.'
                                        : 'Ative para começar a enviar lembretes automáticos.'}
                                </p>
                            </div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={automationEnabled}
                            aria-label={automationEnabled ? 'Desativar automação de lembretes' : 'Ativar automação de lembretes'}
                            onClick={() => setAutomationEnabled(!automationEnabled)}
                            className={`relative h-6 w-12 shrink-0 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 dark:focus:ring-offset-slate-900 ${automationEnabled ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-700'}`}
                        >
                            <div className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${automationEnabled ? 'translate-x-6' : ''}`} />
                        </button>
                    </div>
                </div>

                {/* Variables row */}
                <div className="px-6 py-3 border-b border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/30">
                    <p className="text-[10px] uppercase tracking-widest text-slate-500 font-bold mb-2">Variáveis (clique para inserir)</p>
                    <div className="flex flex-wrap gap-2">
                        {REMINDER_TEMPLATE_VARIABLES.map(v => (
                            <button
                                key={v.key}
                                onClick={() => insertVariable(v.key)}
                                className="text-xs font-mono bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-2.5 py-1 rounded-lg hover:border-emerald-300 hover:text-emerald-600 transition-colors"
                                title={v.label}
                            >
                                {v.key}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Editor + Preview lado a lado */}
                <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-slate-100 dark:divide-slate-800">
                    <div className="p-6">
                        <div className="mb-3 flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
                            <p className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Seu template</p>
                            <button
                                onClick={resetToDefault}
                                className="flex shrink-0 items-center gap-1 whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-slate-400 hover:text-slate-600"
                            >
                                <RefreshCw size={10} /> Restaurar padrão
                            </button>
                        </div>
                        <textarea
                            ref={setTextareaRef}
                            value={template}
                            onChange={e => setTemplate(e.target.value)}
                            rows={10}
                            placeholder={DEFAULT_REMINDER_TEMPLATE}
                            className="w-full p-3 bg-slate-50 dark:bg-slate-800 rounded-xl text-sm font-mono text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-y"
                        />
                        <p className="text-[10px] text-slate-400 mt-2">{template.length}/1000 caracteres</p>
                    </div>

                    <div className="p-6 bg-slate-50 dark:bg-slate-900/50">
                        <div className="flex items-center gap-2 mb-3">
                            <Eye size={12} className="text-slate-400" />
                            <p className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Pré-visualização</p>
                        </div>

                        {/* Mock WhatsApp chat bubble */}
                        <div className="bg-[#dcf8c6] dark:bg-emerald-900/30 rounded-xl rounded-tl-sm p-4 max-w-sm shadow-sm relative">
                            <p className="text-sm text-slate-800 dark:text-slate-100 whitespace-pre-wrap leading-relaxed">{preview}</p>
                            <div className="text-[10px] text-slate-500 text-right mt-2">
                                {new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} ✓✓
                            </div>
                        </div>

                        <p className="text-[10px] text-slate-400 mt-3">
                            Exemplo simulando uma aula da Maria às 19:00 com o prof. João da escola Wise Wolf São Paulo.
                        </p>
                    </div>
                </div>

                {/* Footer */}
                <div className="flex flex-col items-stretch gap-3 border-t border-slate-100 bg-slate-50 px-4 py-4 dark:border-slate-800 dark:bg-slate-900/50 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                    {savedFeedback ? (
                        <div className="flex min-w-0 items-center gap-2 text-xs font-bold text-emerald-600" role="status" aria-live="polite">
                            <Check size={14} /> Configurações salvas!
                        </div>
                    ) : (
                        <p className="min-w-0 text-xs text-slate-500">
                            Variáveis vazias (ex.: link da aula sem cadastro) virão como string vazia.
                        </p>
                    )}
                    <button
                        onClick={save}
                        disabled={saving || template.length > 1000}
                        className="flex w-full shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-emerald-700 px-4 py-2 text-xs font-black uppercase tracking-widest text-white hover:brightness-110 disabled:opacity-50 sm:w-auto"
                    >
                        {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                        Salvar
                    </button>
                </div>
            </div>
        </div>
    );
};

export default TeacherMessageSettings;
