import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ClassLogMeetSuggestion } from '../lib/classLogMeetDrafts';
import type { LastMaterial, MaterialOption } from '../lib/classLogMaterials';
import { Save, X, Search, RefreshCw, MessageCircle, BookOpen, CheckCheck, Sparkles } from 'lucide-react';

export interface ClassLogItem {
    id: string | number; name: string; date: string; avatar?: string; level?: string;
    suggestedTopic?: string; suggestedMaterial?: string; suggestedMaterialUrl?: string;
    classDate?: string; sourceType?: string; sourceId?: string; studentId?: string;
    type?: string; isLate?: boolean; time?: string; phone?: string | null; meetLink?: string | null;
}
export interface ClassLogDraft {
    type: string; subtype: string; lastApplied: string; lessonObjective: string;
    studentDifficulties: string; homeworkAssigned: string; recommendedNextStep: string;
    lateLoggingReason: string; observation: string;
    // Material e parte do livro (opcionais; vão para class_log_materials depois do lançamento).
    materialId: string; materialTitle: string; materialRef: string; materialFromMeet: boolean;
}
const emptyDraft = (): ClassLogDraft => ({
    type: '', subtype: '', lastApplied: '', lessonObjective: '', studentDifficulties: '',
    homeworkAssigned: '', recommendedNextStep: '', lateLoggingReason: '', observation: '',
    materialId: '', materialTitle: '', materialRef: '', materialFromMeet: false,
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
type SummaryNowStatus = 'READY' | 'WAITING' | 'NOT_RECORDED' | 'FAILED';
interface ClassLogFormProps {
    items: ClassLogItem[]; onSave: (data: Record<string, ClassLogDraft>) => void;
    loadSuggestions?: (items: ClassLogItem[]) => Promise<Record<string, ClassLogMeetSuggestion>>;
    onCancel?: () => void; title?: string; loading?: boolean;
    materials?: MaterialOption[];
    lastMaterials?: Record<string, LastMaterial>;
    onSummaryNow?: (sessionId: string) => Promise<SummaryNowStatus>;
}
const pedagogicalFields = [
    ['lessonObjective', 'Objetivo individual trabalhado'],
    ['lastApplied', 'Conteúdo e material realmente trabalhados'],
    ['studentDifficulties', 'Dificuldades observadas (ou “nenhuma observada”)'],
    ['homeworkAssigned', 'Tarefa combinada (ou “sem tarefa”)'],
    ['recommendedNextStep', 'Próximo passo'],
] as const;
const RESULTS = [
    ['COMPLETED', 'Aula ocorreu'],
    ['STUDENT_ABSENCE', 'Aluno faltou'],
    ['TEACHER_ABSENCE', 'Professor faltou'],
] as const;
const SUMMARY_NOW_TEXT: Record<SummaryNowStatus, string> = {
    READY: 'Resumo pronto: os campos foram preenchidos. Confira antes de enviar.',
    WAITING: 'O Google ainda não entregou a transcrição desta aula. Costuma levar alguns minutos depois do fim; tente de novo daqui a pouco ou preencha à mão.',
    NOT_RECORDED: 'Esta aula não teve registro na sala oficial. Preencha à mão.',
    FAILED: 'Não foi possível buscar o resumo agora. Tente de novo ou preencha à mão.',
};
const shortDate = (iso: string | null) => iso ? iso.slice(0, 10).split('-').reverse().slice(0, 2).join('/') : '';

const ClassLogForm: React.FC<ClassLogFormProps> = ({ items, onSave, onCancel, title, loading = false, loadSuggestions, materials = [], lastMaterials = {}, onSummaryNow }) => {
    const [drafts, setDrafts] = useState<Record<string, ClassLogDraft>>({});
    const [searchTerm, setSearchTerm] = useState('');
    const [error, setError] = useState('');
    const [suggestions, setSuggestions] = useState<Record<string, ClassLogMeetSuggestion>>({});
    const [suggestionsBusy, setSuggestionsBusy] = useState(false);
    const [suggestionsError, setSuggestionsError] = useState('');
    const [refreshKey, setRefreshKey] = useState(0);
    const [editing, setEditing] = useState<Record<string, boolean>>({});
    const [summaryNow, setSummaryNow] = useState<Record<string, SummaryNowStatus | 'BUSY'>>({});
    const autoFilled = useRef<string[]>([]);
    const touched = useRef<Record<string, Set<keyof ClassLogDraft>>>({});
    const requestKey = JSON.stringify(items.map(({ id, classDate, sourceType, sourceId }) => ({ id, classDate, sourceType, sourceId })));
    const byLabel = useMemo(() => new Map(materials.map(m => [m.label.toLocaleLowerCase('pt-BR'), m])), [materials]);
    const ready = (id: string) => { const s = suggestions[id]; return s && s.status !== 'PENDING' ? s : undefined; };

    useEffect(() => {
        if (!loadSuggestions) return;
        let active = true;
        setSuggestionsBusy(true); setSuggestionsError('');
        loadSuggestions(JSON.parse(requestKey)).then(result => {
            if (!active) return;
            setSuggestions(result);
            setDrafts(current => {
                const next = { ...current };
                for (const id of autoFilled.current) {
                    if (!next[id]) continue;
                    next[id] = { ...next[id] };
                    for (const [field] of pedagogicalFields) {
                        if (!touched.current[id]?.has(field)) next[id][field] = '';
                    }
                }
                autoFilled.current = Object.keys(result).filter(id => result[id].status !== 'PENDING');
                for (const [id, suggestion] of Object.entries(result) as [string, ClassLogMeetSuggestion][]) {
                    if (suggestion.status === 'PENDING') continue;
                    const draft = { ...(next[id] || emptyDraft()) };
                    for (const [key, value] of Object.entries(suggestion.fields)) {
                        const field = key as keyof ClassLogDraft;
                        if (!touched.current[id]?.has(field)) (draft as unknown as Record<string, string>)[field] = typeof value === 'string' ? value : '';
                    }
                    if (suggestion.materialReference && !touched.current[id]?.has('materialRef')) {
                        draft.materialRef = suggestion.materialReference; draft.materialFromMeet = true;
                    }
                    next[id] = draft;
                }
                return next;
            });
        }).catch(err => { if (active) setSuggestionsError(err.message || 'Não foi possível buscar o resumo.'); })
          .finally(() => { if (active) setSuggestionsBusy(false); });
        return () => { active = false; };
    }, [requestKey, loadSuggestions, refreshKey]);

    const selected = selectedClassLogPayload(items, drafts);
    const selectedCount = Object.keys(selected).length;
    const withLastMaterial = (item: ClassLogItem, draft: ClassLogDraft): ClassLogDraft => {
        const id = String(item.id), last = item.studentId ? lastMaterials[item.studentId] : undefined;
        if (!last || touched.current[id]?.has('materialTitle') || draft.materialTitle || draft.materialId) return draft;
        const option = last.materialId ? materials.find(m => m.id === last.materialId) : undefined;
        return { ...draft, materialId: option?.id || '', materialTitle: option?.label || last.title || last.collection || '' };
    };
    const change = (item: ClassLogItem, field: keyof ClassLogDraft, value: string) => {
        const id = String(item.id);
        setError('');
        (touched.current[id] ||= new Set()).add(field);
        setDrafts(current => {
            let draft: ClassLogDraft = { ...(current[id] || emptyDraft()), [field]: value };
            if (field === 'materialTitle') draft.materialId = byLabel.get(value.trim().toLocaleLowerCase('pt-BR'))?.id || '';
            if (field === 'materialRef') draft.materialFromMeet = false;
            if (field === 'type' && value === 'COMPLETED') draft = withLastMaterial(item, draft);
            return { ...current, [id]: draft };
        });
    };
    const markAllCompleted = () => {
        setError('');
        setDrafts(current => {
            const next = { ...current };
            for (const item of visible) {
                const id = String(item.id);
                if (next[id]?.type) continue;
                (touched.current[id] ||= new Set()).add('type');
                next[id] = withLastMaterial(item, { ...(next[id] || emptyDraft()), type: 'COMPLETED' });
            }
            return next;
        });
    };
    const fetchSummaryNow = async (id: string, sessionId: string) => {
        if (!onSummaryNow) return;
        setSummaryNow(current => ({ ...current, [id]: 'BUSY' }));
        const status = await onSummaryNow(sessionId);
        setSummaryNow(current => ({ ...current, [id]: status }));
        if (status === 'READY' || status === 'WAITING') setRefreshKey(key => key + 1);
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
    const visible = items.filter(item => item.name.toLocaleLowerCase().includes(searchTerm.toLocaleLowerCase()));
    const pendingChoice = visible.filter(item => !drafts[String(item.id)]?.type).length;
    return (
        <section data-tour="class-log-meet-prefill" className="flex h-full max-h-[85vh] flex-col overflow-hidden rounded-2xl border border-brand-border bg-brand-surface">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-brand-border p-5">
                <div><h3 className="font-bold text-brand-text">{title || 'Registrar aulas'}</h3><p className="text-xs text-brand-muted">Escolha o resultado de cada aula. {selectedCount} selecionada(s).</p></div>
                <div className="flex flex-wrap items-center gap-2">
                    <Search size={16} aria-hidden="true" />
                    <input aria-label="Buscar aluno" placeholder="Buscar aluno" value={searchTerm} onChange={e => setSearchTerm(e.target.value)} className="w-36 rounded-lg border border-brand-border bg-brand-surface p-2 text-sm text-brand-text" />
                    {pendingChoice > 1 && <button type="button" onClick={markAllCompleted} className="flex min-h-[44px] items-center gap-2 rounded-xl border border-tenant-primary px-3 py-2 text-sm font-bold text-tenant-primary">
                        <CheckCheck size={16} /> Todas ocorreram
                    </button>}
                    <button type="button" onClick={save} disabled={loading || !selectedCount} className="flex items-center gap-2 rounded-xl bg-tenant-primary px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
                        {loading ? <RefreshCw size={16} className="animate-spin" /> : <Save size={16} />} {loading ? 'Salvando...' : `Registrar selecionadas (${selectedCount})`}
                    </button>
                    {onCancel && <button type="button" onClick={onCancel} aria-label="Fechar"><X size={20} /></button>}
                </div>
            </header>
            {loadSuggestions && <div className="flex flex-wrap items-center justify-between gap-2 border-b border-brand-border px-5 py-3 text-sm text-brand-muted">
                <p>{suggestionsBusy ? 'Buscando resumos das reuniões…' : suggestionsError || 'Os dados disponíveis do Meet são preenchidos automaticamente. Revise antes de registrar.'}</p>
                <button type="button" disabled={suggestionsBusy} onClick={() => setRefreshKey(key => key + 1)} className="font-bold text-tenant-primary disabled:opacity-50">Atualizar resumos</button>
            </div>}
            {error && <p role="alert" className="border-b border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</p>}
            <datalist id="class-log-material-options">{materials.map(m => <option key={m.id} value={m.label} />)}</datalist>
            <div className="space-y-4 overflow-y-auto p-4">
                {visible.map(item => {
                    const id = String(item.id);
                    const draft = drafts[id] || emptyDraft();
                    const waLink = buildAvisarAlunoLink(item);
                    const suggestion = ready(id);
                    const pending = suggestions[id]?.status === 'PENDING' ? suggestions[id] : undefined;
                    const last = item.studentId ? lastMaterials[item.studentId] : undefined;
                    const now = summaryNow[id];
                    return <article key={item.id} className={`rounded-xl border p-4 ${draft.type ? 'border-tenant-primary' : 'border-brand-border'}`}>
                        <div className="flex flex-wrap items-start justify-between gap-3">
                            <div><h4 className="font-bold text-brand-text">{item.name}</h4><p className="text-xs text-brand-muted">{item.date}{item.time ? ` às ${item.time}` : ''} · {item.type || 'REGULAR'}{item.isLate ? ' · lançamento retroativo' : ''}</p>
                                {(item.suggestedTopic || item.suggestedMaterial) && <p className="mt-1 text-xs text-brand-muted">Planejado: {item.suggestedTopic}{item.suggestedTopic && item.suggestedMaterial ? ' · ' : ''}{item.suggestedMaterialUrl ? <a href={item.suggestedMaterialUrl} target="_blank" rel="noopener noreferrer" className="underline">{item.suggestedMaterial || 'Abrir material'}</a> : item.suggestedMaterial}. Confirme abaixo o que foi realmente trabalhado.</p>}
                                {waLink && <a href={waLink} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-emerald-600"><MessageCircle size={13} /> Avisar aluno</a>}
                            </div>
                            <div role="group" aria-label={`Resultado da aula de ${item.name}`} className="flex flex-wrap gap-2">
                                {RESULTS.map(([value, label]) => <button key={value} type="button" aria-pressed={draft.type === value} aria-label={`${label} — ${item.name}`}
                                    onClick={() => change(item, 'type', draft.type === value ? '' : value)}
                                    className={`min-h-[44px] rounded-xl border px-3 text-sm font-bold ${draft.type === value ? (value === 'COMPLETED' ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-amber-600 bg-amber-600 text-white') : 'border-brand-border text-brand-text'}`}>{label}</button>)}
                            </div>
                        </div>
                        {draft.type && <div className="mt-4 grid gap-3 sm:grid-cols-2">
                            {draft.type === 'COMPLETED' ? <>
                                <div data-tour="class-log-material" className="sm:col-span-2 rounded-xl border border-brand-border p-3">
                                    <p className="flex items-center gap-2 text-sm font-bold text-brand-text"><BookOpen size={16} /> Material da aula</p>
                                    {last?.label && <p className="mt-1 text-xs text-brand-muted">Última aula{last.classDate ? ` (${shortDate(last.classDate)}${last.teacherName ? `, ${last.teacherName.split(' ')[0]}` : ''})` : ''}: <b>{last.label}</b></p>}
                                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                                        <label className="text-xs text-brand-muted">Livro ou material
                                            <input list="class-log-material-options" aria-label={`Livro ou material — ${item.name}`} maxLength={300} value={draft.materialTitle} onChange={e => change(item, 'materialTitle', e.target.value)} placeholder="Escolha da biblioteca ou escreva" className="mt-1 block w-full rounded-lg border border-brand-border bg-brand-surface p-2 text-sm text-brand-text" />
                                        </label>
                                        <label className="text-xs text-brand-muted">Onde parou (unidade, página, exercício)
                                            <input aria-label={`Onde parou — ${item.name}`} maxLength={300} value={draft.materialRef} onChange={e => change(item, 'materialRef', e.target.value)} placeholder="Ex.: Unit 3, página 34" className="mt-1 block w-full rounded-lg border border-brand-border bg-brand-surface p-2 text-sm text-brand-text" />
                                            {draft.materialFromMeet && <span className="mt-1 flex items-center gap-1 text-indigo-700 dark:text-indigo-300"><Sparkles size={12} /> Sugerido pelo resumo da aula</span>}
                                        </label>
                                    </div>
                                </div>
                                {suggestion && <div className="sm:col-span-2 rounded-xl bg-indigo-50 p-3 text-sm text-indigo-950 dark:bg-indigo-950 dark:text-indigo-100">
                                    <p className="font-bold">{suggestion.status === 'VERIFIED' ? 'Preenchido pelo resumo aprovado da reunião' : 'Preenchido pelo rascunho da reunião — confira: ao lançar, o resumo da aula é aprovado com o que você deixar aqui'}</p>
                                    <dl className="mt-2 grid gap-2 sm:grid-cols-2">{pedagogicalFields.filter(([field]) => draft[field].trim()).map(([field,label]) => <div key={field}><dt className="font-semibold">{label}</dt><dd className="whitespace-pre-line">{draft[field]}</dd></div>)}</dl>
                                    {suggestion.uncertainties.length > 0 && <p className="mt-2 font-semibold">Pontos a conferir: {suggestion.uncertainties.join('; ')}</p>}
                                    <button type="button" onClick={() => setEditing(current => ({ ...current, [id]: !current[id] }))} className="mt-3 font-bold underline">{editing[id] ? 'Concluir ajustes' : 'Editar dados preenchidos'}</button>
                                </div>}
                                {loadSuggestions && !suggestion && !suggestionsBusy && <div className="sm:col-span-2 rounded-xl bg-brand-surface-2 p-3 text-sm text-brand-muted dark:bg-brand-surface">
                                    {pending ? <>
                                        <p>A transcrição desta aula ainda está chegando do Google (costuma levar alguns minutos depois do fim da aula).</p>
                                        {onSummaryNow && <button type="button" disabled={now === 'BUSY'} onClick={() => fetchSummaryNow(id, pending.sessionId)} className="mt-2 flex min-h-[44px] items-center gap-2 rounded-xl bg-indigo-600 px-3 py-2 font-bold text-white disabled:opacity-60">
                                            {now === 'BUSY' ? <RefreshCw size={16} className="animate-spin" /> : <Sparkles size={16} />} {now === 'BUSY' ? 'Buscando o resumo…' : 'Buscar o resumo agora'}
                                        </button>}
                                        {now && now !== 'BUSY' && <p role="status" className="mt-2">{SUMMARY_NOW_TEXT[now]}</p>}
                                    </> : <p>Ainda não há resumo disponível desta aula. Se ela ocorreu na sala oficial, aguarde o processamento e toque em Atualizar resumos, ou preencha manualmente. Aulas anteriores à integração não têm transcrição retroativa.</p>}
                                </div>}
                                {pedagogicalFields.filter(([field]) => !suggestion || editing[id] || !suggestion.fields[field]?.trim() || (touched.current[id]?.has(field) && !draft[field].trim())).map(([field, label]) => <label key={field} className="text-xs text-brand-muted">{label} *
                                    <textarea aria-label={`${label} — ${item.name}`} maxLength={4000} value={draft[field]} onChange={e => change(item, field, e.target.value)} rows={2} className="mt-1 block w-full rounded-lg border border-brand-border bg-brand-surface p-2 text-sm text-brand-text" />
                                    {field === 'studentDifficulties' && <button type="button" onClick={() => change(item, field, 'Nenhuma dificuldade observada')} className="mt-1 font-semibold text-tenant-primary">Nenhuma dificuldade observada</button>}
                                    {field === 'homeworkAssigned' && <button type="button" onClick={() => change(item, field, 'Sem tarefa combinada')} className="mt-1 font-semibold text-tenant-primary">Sem tarefa combinada</button>}
                                </label>)}
                            </> : <label className="text-xs text-brand-muted">Motivo informado
                                <select value={draft.subtype} onChange={e => change(item, 'subtype', e.target.value)} className="mt-1 block w-full rounded-lg border border-brand-border bg-brand-surface p-2 text-sm text-brand-text"><option value="">Não informado</option><option>Doença</option><option>Trabalho</option><option>Viagem</option><option>Outros</option></select>
                            </label>}
                            {item.isLate && <label className="text-xs text-brand-muted">Motivo do lançamento retroativo *
                                <div className="mt-1 flex flex-wrap gap-2">{['Esqueci de lançar na data da aula', 'Problema de acesso à plataforma'].map(reason => <button key={reason} type="button" onClick={() => change(item, 'lateLoggingReason', reason)} className="rounded-lg border border-brand-border px-2 py-1 text-tenant-primary">{reason}</button>)}</div>
                                <textarea aria-label={`Motivo do lançamento retroativo — ${item.name}`} maxLength={2000} value={draft.lateLoggingReason} onChange={e => change(item, 'lateLoggingReason', e.target.value)} rows={2} className="mt-1 block w-full rounded-lg border border-brand-border bg-brand-surface p-2 text-sm text-brand-text" />
                            </label>}
                            <details className="sm:col-span-2 text-xs text-brand-muted"><summary className="cursor-pointer">Adicionar observações (opcional)</summary><label>Observações adicionais
                                <textarea maxLength={4000} aria-label={`Observações adicionais — ${item.name}`} value={draft.observation} onChange={e => change(item, 'observation', e.target.value)} rows={2} className="mt-1 block w-full rounded-lg border border-brand-border bg-brand-surface p-2 text-sm text-brand-text" />
                            </label></details>
                        </div>}
                    </article>;
                })}
            </div>
            {/* Quem preenche desce a lista e procura o envio no fim — o botão do topo some de vista.
                Fica à ESQUERDA: o botão flutuante "Ajuda" mora no canto inferior direito e cobria o envio. */}
            <footer className="flex justify-start border-t border-brand-border p-4 pr-32">
                <button type="button" onClick={save} disabled={loading || !selectedCount} className="flex items-center gap-2 rounded-xl bg-tenant-primary px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
                    {loading ? <RefreshCw size={16} className="animate-spin" /> : <Save size={16} />} {loading ? 'Salvando...' : `Enviar aulas selecionadas (${selectedCount})`}
                </button>
            </footer>
        </section>
    );
};
export default ClassLogForm;
