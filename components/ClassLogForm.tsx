import React, { useState } from 'react';
import { Save, X, Search, RefreshCw, MessageCircle } from 'lucide-react';

export interface ClassLogItem {
    id: string | number; name: string; date: string; avatar?: string; level?: string;
    suggestedTopic?: string; suggestedMaterial?: string; suggestedMaterialUrl?: string;
    type?: string; isLate?: boolean; time?: string; phone?: string | null; meetLink?: string | null;
}
export interface ClassLogDraft {
    type: string; subtype: string; lastApplied: string; lessonObjective: string;
    studentDifficulties: string; homeworkAssigned: string; recommendedNextStep: string;
    lateLoggingReason: string; observation: string;
}
const emptyDraft = (): ClassLogDraft => ({
    type: '', subtype: '', lastApplied: '', lessonObjective: '', studentDifficulties: '',
    homeworkAssigned: '', recommendedNextStep: '', lateLoggingReason: '', observation: '',
});
// Search changes visibility, never selects rows or invents attendance.
export function selectedClassLogPayload(items: ClassLogItem[], drafts: Record<string, ClassLogDraft>) {
    return Object.fromEntries(items.flatMap(item => {
        const draft = drafts[String(item.id)];
        return draft?.type ? [[String(item.id), draft]] : [];
    }));
}
const buildAvisarAlunoLink = (item: ClassLogItem): string | null => {
    let phone = (item.phone || '').replace(/\D/g, '');
    if (phone.length === 10 || phone.length === 11) phone = '55' + phone;
    if (phone.length < 12) return null;
    const message = `Olá ${item.name.split(' ')[0]}! Aqui é a Wise Wolf. Sobre sua aula de ${item.date}.${item.meetLink ? `\nLink da aula: ${item.meetLink}` : ''}`;
    return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
};
interface ClassLogFormProps {
    items: ClassLogItem[]; onSave: (data: Record<string, ClassLogDraft>) => void;
    onCancel?: () => void; title?: string; loading?: boolean;
}
const pedagogicalFields = [
    ['lessonObjective', 'Objetivo individual trabalhado'],
    ['lastApplied', 'Conteúdo e material realmente trabalhados'],
    ['studentDifficulties', 'Dificuldades observadas (ou “nenhuma observada”)'],
    ['homeworkAssigned', 'Tarefa combinada (ou “sem tarefa”)'],
    ['recommendedNextStep', 'Próximo passo'],
] as const;

const ClassLogForm: React.FC<ClassLogFormProps> = ({ items, onSave, onCancel, title, loading = false }) => {
    const [drafts, setDrafts] = useState<Record<string, ClassLogDraft>>({});
    const [searchTerm, setSearchTerm] = useState('');
    const [error, setError] = useState('');
    const selected = selectedClassLogPayload(items, drafts);
    const selectedCount = Object.keys(selected).length;
    const change = (id: string | number, field: keyof ClassLogDraft, value: string) => {
        setError('');
        setDrafts(current => ({ ...current, [id]: { ...(current[id] || emptyDraft()), [field]: value } }));
    };
    const save = () => {
        const invalid = items.filter(item => {
            const draft = selected[String(item.id)];
            if (!draft) return false;
            return (draft.type === 'COMPLETED' && pedagogicalFields.some(([field]) => !draft[field].trim()))
                || (item.isLate && !draft.lateLoggingReason.trim());
        });
        if (invalid.length) {
            setError(`Complete os campos obrigatórios de: ${invalid.map(item => item.name).join(', ')}.`);
            return;
        }
        if (selectedCount) onSave(selected);
    };
    return (
        <section className="flex h-full max-h-[85vh] flex-col overflow-hidden rounded-2xl border border-brand-border bg-brand-surface">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-brand-border p-5">
                <div><h3 className="font-bold text-brand-text">{title || 'Registrar aulas'}</h3><p className="text-xs text-brand-muted">Selecione o resultado de cada aula. {selectedCount} selecionada(s).</p></div>
                <div className="flex flex-wrap items-center gap-2">
                    <Search size={16} aria-hidden="true" />
                    <input aria-label="Buscar aluno" placeholder="Buscar aluno" value={searchTerm} onChange={e => setSearchTerm(e.target.value)} className="w-36 rounded-lg border border-brand-border bg-brand-surface p-2 text-sm text-brand-text" />
                    <button type="button" onClick={save} disabled={loading || !selectedCount} className="flex items-center gap-2 rounded-xl bg-tenant-primary px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
                        {loading ? <RefreshCw size={16} className="animate-spin" /> : <Save size={16} />} {loading ? 'Salvando...' : `Registrar selecionadas (${selectedCount})`}
                    </button>
                    {onCancel && <button type="button" onClick={onCancel} aria-label="Fechar"><X size={20} /></button>}
                </div>
            </header>
            {error && <p role="alert" className="border-b border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</p>}
            <div className="space-y-4 overflow-y-auto p-4">
                {items.filter(item => item.name.toLocaleLowerCase().includes(searchTerm.toLocaleLowerCase())).map(item => {
                    const draft = drafts[String(item.id)] || emptyDraft();
                    const waLink = buildAvisarAlunoLink(item);
                    return <article key={item.id} className={`rounded-xl border p-4 ${draft.type ? 'border-tenant-primary' : 'border-brand-border'}`}>
                        <div className="flex flex-wrap items-start justify-between gap-3">
                            <div><h4 className="font-bold text-brand-text">{item.name}</h4><p className="text-xs text-brand-muted">{item.date}{item.time ? ` às ${item.time}` : ''} · {item.type || 'REGULAR'}{item.isLate ? ' · lançamento retroativo' : ''}</p>
                                {(item.suggestedTopic || item.suggestedMaterial) && <p className="mt-1 text-xs text-brand-muted">Planejado: {item.suggestedTopic}{item.suggestedTopic && item.suggestedMaterial ? ' · ' : ''}{item.suggestedMaterialUrl ? <a href={item.suggestedMaterialUrl} target="_blank" rel="noopener noreferrer" className="underline">{item.suggestedMaterial || 'Abrir material'}</a> : item.suggestedMaterial}. Confirme abaixo o que foi realmente trabalhado.</p>}
                                {waLink && <a href={waLink} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-emerald-600"><MessageCircle size={13} /> Avisar aluno</a>}
                            </div>
                            <label className="text-xs text-brand-muted">Resultado da aula
                                <select aria-label={`Resultado da aula de ${item.name}`} value={draft.type} onChange={e => change(item.id, 'type', e.target.value)} className="mt-1 block rounded-lg border border-brand-border bg-brand-surface p-2 text-sm text-brand-text">
                                    <option value="">Não selecionada</option><option value="COMPLETED">Aula ocorreu</option><option value="STUDENT_ABSENCE">Aluno faltou</option><option value="TEACHER_ABSENCE">Professor faltou</option>
                                </select>
                            </label>
                        </div>
                        {draft.type && <div className="mt-4 grid gap-3 sm:grid-cols-2">
                            {draft.type === 'COMPLETED' ? pedagogicalFields.map(([field, label]) => <label key={field} className="text-xs text-brand-muted">{label} *
                                <textarea aria-label={`${label} — ${item.name}`} maxLength={4000} value={draft[field]} onChange={e => change(item.id, field, e.target.value)} rows={2} className="mt-1 block w-full rounded-lg border border-brand-border bg-brand-surface p-2 text-sm text-brand-text" />
                            </label>) : <label className="text-xs text-brand-muted">Motivo informado
                                <select value={draft.subtype} onChange={e => change(item.id, 'subtype', e.target.value)} className="mt-1 block w-full rounded-lg border border-brand-border bg-brand-surface p-2 text-sm text-brand-text"><option value="">Não informado</option><option>Doença</option><option>Trabalho</option><option>Viagem</option><option>Outros</option></select>
                            </label>}
                            {item.isLate && <label className="text-xs text-brand-muted">Motivo do lançamento retroativo *
                                <textarea aria-label={`Motivo do lançamento retroativo — ${item.name}`} maxLength={2000} value={draft.lateLoggingReason} onChange={e => change(item.id, 'lateLoggingReason', e.target.value)} rows={2} className="mt-1 block w-full rounded-lg border border-brand-border bg-brand-surface p-2 text-sm text-brand-text" />
                            </label>}
                            <label className="text-xs text-brand-muted">Observações adicionais
                                <textarea maxLength={4000} value={draft.observation} onChange={e => change(item.id, 'observation', e.target.value)} rows={2} className="mt-1 block w-full rounded-lg border border-brand-border bg-brand-surface p-2 text-sm text-brand-text" />
                            </label>
                        </div>}
                    </article>;
                })}
            </div>
            {/* Quem preenche desce a lista e procura o envio no fim — o botão do topo some de vista. */}
            <footer className="flex justify-end border-t border-brand-border p-4">
                <button type="button" onClick={save} disabled={loading || !selectedCount} className="flex items-center gap-2 rounded-xl bg-tenant-primary px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
                    {loading ? <RefreshCw size={16} className="animate-spin" /> : <Save size={16} />} {loading ? 'Salvando...' : `Enviar aulas selecionadas (${selectedCount})`}
                </button>
            </footer>
        </section>
    );
};
export default ClassLogForm;
