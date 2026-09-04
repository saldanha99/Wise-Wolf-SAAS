import React, { useState, useEffect, useMemo, useRef } from 'react';
import { supabase } from '../lib/supabase';
import {
    Kanban, User, Phone, Mail, MessageCircle, Search, Filter, Plus,
    X, Clock, DollarSign, MoreHorizontal, Edit2, Tag, ChevronDown,
    TrendingUp, Users, Target, AlertCircle, Check, Trash2, RefreshCw, Bot, BotOff
} from 'lucide-react';

interface CRMPageProps {
    tenantId: string;
}

interface Lead {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    status: 'NEW' | 'CONTACTED' | 'TRIAL' | 'SCHEDULED' | 'TRIAL_DONE' | 'WON' | 'LOST';
    source: string | null;
    notes: string | null;
    created_at: string;
    student_id?: string | null;
    value: number | null;
    tags: string[] | null;
    last_status_change: string | null;
    level?: string | null;
    goal?: string | null;
    assigned_teacher_id?: string | null;
    opportunity_id?: string | null;
}

type StatusType = Lead['status'];
type ManualStatusType = Extract<StatusType, 'NEW' | 'CONTACTED' | 'LOST'>;

const COLUMN_CONFIG: Record<string, { label: string; color: string; text: string; dot: string; border: string }> = {
    NEW:       { label: 'Novos Leads',    color: 'from-blue-500/10',    text: 'text-blue-500',    dot: 'bg-blue-500',    border: 'border-blue-500/30' },
    CONTACTED: { label: 'Em Contato',     color: 'from-amber-500/10',   text: 'text-amber-500',   dot: 'bg-amber-500',   border: 'border-amber-500/30' },
    TRIAL:     { label: 'Aula Agendada',  color: 'from-violet-500/10',  text: 'text-violet-500',  dot: 'bg-violet-500',  border: 'border-violet-500/30' },
    SCHEDULED: { label: 'Aula Agendada',  color: 'from-violet-500/10',  text: 'text-violet-500',  dot: 'bg-violet-500',  border: 'border-violet-500/30' },
    TRIAL_DONE:{ label: 'Pós-aula',       color: 'from-orange-500/10',  text: 'text-orange-500',  dot: 'bg-orange-500',   border: 'border-orange-500/30' },
    WON:       { label: 'Matriculados',   color: 'from-emerald-500/10', text: 'text-emerald-500', dot: 'bg-emerald-500', border: 'border-emerald-500/30' },
};

const VISIBLE_COLUMNS: StatusType[] = ['NEW', 'CONTACTED', 'SCHEDULED', 'TRIAL_DONE', 'WON'];
const MANUAL_ACTIVE_STATUSES: ManualStatusType[] = ['NEW', 'CONTACTED'];
const WON_MANUAL_BLOCK_MESSAGE = 'A etapa Matriculados é automática e só é liberada após a matrícula autoritativa.';
const TRIAL_MANUAL_BLOCK_MESSAGE = 'As etapas da aula experimental são atualizadas automaticamente pela agenda e pelo lançamento da aula.';

const isAuthoritativeLeadStage = (lead: Partial<Lead>): boolean => Boolean(
    lead.opportunity_id
    || lead.status === 'TRIAL'
    || lead.status === 'SCHEDULED'
    || lead.status === 'TRIAL_DONE'
    || lead.status === 'WON'
);

const normalizeLeadForBoard = (lead: Lead): Lead => ({
    ...lead,
    status: lead.status === 'TRIAL' ? 'SCHEDULED' : lead.status,
});

const SOURCE_OPTIONS = ['Instagram', 'Facebook', 'Indicação', 'Google', 'WhatsApp', 'Site', 'Evento', 'Outro'];
const LEVEL_OPTIONS  = ['Iniciante', 'Básico', 'Intermediário', 'Avançado', 'Nativo'];
const TAG_SUGGESTIONS = ['hot-lead', 'adulto', 'infantil', 'business', 'conversação', 'intensivo', 'online'];

const editableLeadPayload = (data: Partial<Lead>) => ({
    name: data.name?.trim() || '',
    email: data.email?.trim() || null,
    phone: data.phone?.trim() || null,
    source: data.source || null,
    notes: data.notes?.trim() || null,
    value: Number(data.value) || 0,
    tags: data.tags || [],
    level: data.level || null,
    goal: data.goal?.trim() || null,
});

// Componente Modal reutilizável
const Modal: React.FC<{ title: string; onClose: () => void; children: React.ReactNode }> = ({ title, onClose, children }) => (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
        <div className="relative bg-brand-surface border border-brand-border rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between p-5 border-b border-brand-border shrink-0">
                <h3 className="font-extrabold text-brand-text text-lg">{title}</h3>
                <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-brand-surface-2 text-brand-muted hover:text-brand-text transition-colors">
                    <X size={18} />
                </button>
            </div>
            <div className="overflow-y-auto flex-1 p-5">
                {children}
            </div>
        </div>
    </div>
);

// Formulário de lead (Nova Oportunidade + Editar)
interface LeadFormProps {
    initial?: Partial<Lead>;
    onSave: (data: Partial<Lead>) => Promise<void>;
    onCancel: () => void;
    saving: boolean;
    formError?: string | null;
}

const LeadForm: React.FC<LeadFormProps> = ({ initial, onSave, onCancel, saving, formError }) => {
    const [form, setForm] = useState<Partial<Lead>>({
        name: '', email: '', phone: '', source: '', notes: '',
        value: 0, tags: [], status: 'NEW', level: '', goal: '',
        ...initial,
    });
    const [tagInput, setTagInput] = useState('');
    const [errors, setErrors] = useState<Record<string, string>>({});
    const isAuthoritativeWon = initial?.status === 'WON';
    const isAuthoritativeStage = isAuthoritativeLeadStage(initial || {});

    const set = (key: keyof Lead, val: unknown) => {
        setForm(f => ({ ...f, [key]: val }));
        if (errors[key]) setErrors(e => { const n = { ...e }; delete n[key]; return n; });
    };

    const addTag = (tag: string) => {
        const t = tag.trim().toLowerCase();
        if (t && !(form.tags || []).includes(t)) {
            set('tags', [...(form.tags || []), t]);
        }
        setTagInput('');
    };

    const removeTag = (tag: string) => set('tags', (form.tags || []).filter(t => t !== tag));

    const validate = () => {
        const e: Record<string, string> = {};
        if (!form.name?.trim()) e.name = 'Nome é obrigatório';
        return e;
    };

    const handleSubmit = async () => {
        const e = validate();
        if (!isAuthoritativeStage && form.status === 'WON') e.status = WON_MANUAL_BLOCK_MESSAGE;
        if (Object.keys(e).length > 0) { setErrors(e); return; }
        await onSave(form);
    };

    return (
        <div className="space-y-4">
            {/* Nome */}
            <div>
                <label className="text-xs font-bold uppercase tracking-wider text-brand-muted mb-1 block">Nome *</label>
                <input
                    value={form.name || ''}
                    onChange={e => set('name', e.target.value)}
                    placeholder="Nome completo"
                    className={`w-full px-4 py-2.5 bg-brand-surface-2 border rounded-xl text-sm text-brand-text placeholder-brand-muted outline-none focus:border-brand-accent transition-colors ${errors.name ? 'border-red-500' : 'border-brand-border'}`}
                />
                {errors.name && <p className="text-xs text-red-500 mt-1">{errors.name}</p>}
            </div>

            {/* Email + Telefone */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                    <label className="text-xs font-bold uppercase tracking-wider text-brand-muted mb-1 block">E-mail</label>
                    <input
                        value={form.email || ''}
                        onChange={e => set('email', e.target.value)}
                        placeholder="email@exemplo.com"
                        type="email"
                        className="w-full px-4 py-2.5 bg-brand-surface-2 border border-brand-border rounded-xl text-sm text-brand-text placeholder-brand-muted outline-none focus:border-brand-accent transition-colors"
                    />
                </div>
                <div>
                    <label className="text-xs font-bold uppercase tracking-wider text-brand-muted mb-1 block">Telefone</label>
                    <input
                        value={form.phone || ''}
                        onChange={e => set('phone', e.target.value)}
                        placeholder="(11) 99999-9999"
                        className="w-full px-4 py-2.5 bg-brand-surface-2 border border-brand-border rounded-xl text-sm text-brand-text placeholder-brand-muted outline-none focus:border-brand-accent transition-colors"
                    />
                </div>
            </div>

            {/* Origem + Nível */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                    <label className="text-xs font-bold uppercase tracking-wider text-brand-muted mb-1 block">Origem</label>
                    <select
                        value={form.source || ''}
                        onChange={e => set('source', e.target.value)}
                        className="w-full px-4 py-2.5 bg-brand-surface-2 border border-brand-border rounded-xl text-sm text-brand-text outline-none focus:border-brand-accent transition-colors"
                    >
                        <option value="">Selecionar</option>
                        {SOURCE_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                </div>
                <div>
                    <label className="text-xs font-bold uppercase tracking-wider text-brand-muted mb-1 block">Nível de Inglês</label>
                    <select
                        value={form.level || ''}
                        onChange={e => set('level', e.target.value)}
                        className="w-full px-4 py-2.5 bg-brand-surface-2 border border-brand-border rounded-xl text-sm text-brand-text outline-none focus:border-brand-accent transition-colors"
                    >
                        <option value="">Selecionar</option>
                        {LEVEL_OPTIONS.map(l => <option key={l} value={l}>{l}</option>)}
                    </select>
                </div>
            </div>

            {/* Valor + Status */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                    <label className="text-xs font-bold uppercase tracking-wider text-brand-muted mb-1 block">Valor (R$)</label>
                    <input
                        value={form.value || ''}
                        onChange={e => set('value', Number(e.target.value) || 0)}
                        placeholder="0"
                        type="number"
                        min="0"
                        className="w-full px-4 py-2.5 bg-brand-surface-2 border border-brand-border rounded-xl text-sm text-brand-text placeholder-brand-muted outline-none focus:border-brand-accent transition-colors"
                    />
                </div>
                <div>
                    <label className="text-xs font-bold uppercase tracking-wider text-brand-muted mb-1 block">Etapa</label>
                    {isAuthoritativeStage ? (
                        <div className={`rounded-xl border px-4 py-2.5 ${isAuthoritativeWon ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-violet-500/30 bg-violet-500/10'}`}>
                            <p className={`text-sm font-bold ${isAuthoritativeWon ? 'text-emerald-600' : 'text-violet-600'}`}>
                                {isAuthoritativeWon
                                    ? 'Matriculado pelo fluxo de matrícula'
                                    : COLUMN_CONFIG[normalizeLeadForBoard(initial as Lead).status]?.label || 'Aula experimental'}
                            </p>
                            <p className="mt-0.5 text-[10px] text-brand-muted">Esta etapa é reconciliada automaticamente e não pode ser alterada aqui.</p>
                        </div>
                    ) : (
                        <select
                            aria-label="Etapa"
                            value={form.status === 'WON' ? 'NEW' : (form.status || 'NEW')}
                            onChange={e => set('status', e.target.value as ManualStatusType)}
                            className={`w-full px-4 py-2.5 bg-brand-surface-2 border rounded-xl text-sm text-brand-text outline-none focus:border-brand-accent transition-colors ${errors.status ? 'border-red-500' : 'border-brand-border'}`}
                        >
                            {MANUAL_ACTIVE_STATUSES.map(s => <option key={s} value={s}>{COLUMN_CONFIG[s].label}</option>)}
                            <option value="LOST">Perdidos</option>
                        </select>
                    )}
                    {errors.status && <p className="text-xs text-red-500 mt-1">{errors.status}</p>}
                </div>
            </div>

            {formError && (
                <div role="alert" className="flex items-start gap-2 rounded-xl border border-red-400/40 bg-red-500/10 px-3 py-2.5 text-xs font-bold text-red-600">
                    <AlertCircle size={15} className="mt-0.5 shrink-0" />
                    <span>{formError}</span>
                </div>
            )}

            {/* Tags */}
            <div>
                <label className="text-xs font-bold uppercase tracking-wider text-brand-muted mb-1 block">Tags</label>
                <div className="flex flex-wrap gap-1.5 mb-2 min-h-[28px]">
                    {(form.tags || []).map(tag => (
                        <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-brand-accent/10 text-brand-accent border border-brand-accent/30 text-[11px] font-bold">
                            {tag}
                            <button onClick={() => removeTag(tag)} className="hover:text-red-400 transition-colors"><X size={11} /></button>
                        </span>
                    ))}
                </div>
                <div className="flex gap-2">
                    <input
                        value={tagInput}
                        onChange={e => setTagInput(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag(tagInput); }}}
                        placeholder="Adicionar tag..."
                        className="flex-1 px-3 py-2 bg-brand-surface-2 border border-brand-border rounded-xl text-xs text-brand-text placeholder-brand-muted outline-none focus:border-brand-accent transition-colors"
                    />
                    <button onClick={() => addTag(tagInput)} className="px-3 py-2 bg-brand-surface-2 border border-brand-border rounded-xl text-xs text-brand-muted hover:text-brand-text transition-colors">
                        +
                    </button>
                </div>
                <div className="flex flex-wrap gap-1 mt-1.5">
                    {TAG_SUGGESTIONS.filter(t => !(form.tags || []).includes(t)).map(t => (
                        <button key={t} onClick={() => addTag(t)} className="px-2 py-0.5 rounded bg-brand-surface border border-brand-border text-brand-muted text-[10px] hover:border-brand-accent hover:text-brand-accent transition-colors">
                            + {t}
                        </button>
                    ))}
                </div>
            </div>

            {/* Objetivo */}
            <div>
                <label className="text-xs font-bold uppercase tracking-wider text-brand-muted mb-1 block">Objetivo do Aluno</label>
                <input
                    value={form.goal || ''}
                    onChange={e => set('goal', e.target.value)}
                    placeholder="Ex: Viagem, trabalho, provas..."
                    className="w-full px-4 py-2.5 bg-brand-surface-2 border border-brand-border rounded-xl text-sm text-brand-text placeholder-brand-muted outline-none focus:border-brand-accent transition-colors"
                />
            </div>

            {/* Notas */}
            <div>
                <label className="text-xs font-bold uppercase tracking-wider text-brand-muted mb-1 block">Notas</label>
                <textarea
                    value={form.notes || ''}
                    onChange={e => set('notes', e.target.value)}
                    placeholder="Anotações sobre o lead..."
                    rows={3}
                    className="w-full px-4 py-2.5 bg-brand-surface-2 border border-brand-border rounded-xl text-sm text-brand-text placeholder-brand-muted outline-none focus:border-brand-accent transition-colors resize-none"
                />
            </div>

            {/* Ações */}
            <div className="flex gap-3 pt-2">
                <button
                    onClick={onCancel}
                    className="flex-1 px-4 py-2.5 border border-brand-border text-brand-muted hover:text-brand-text hover:bg-brand-surface-2 rounded-xl font-bold text-sm transition-colors"
                >
                    Cancelar
                </button>
                <button
                    onClick={handleSubmit}
                    disabled={saving}
                    className="flex-1 px-4 py-2.5 bg-brand-accent hover:bg-brand-accent-hover disabled:opacity-60 text-white rounded-xl font-bold text-sm transition-colors flex items-center justify-center gap-2"
                >
                    {saving ? <><RefreshCw size={14} className="animate-spin" /> Salvando...</> : <><Check size={14} /> Salvar</>}
                </button>
            </div>
        </div>
    );
};

// Painel de filtros
interface FilterPanelProps {
    filters: { source: string; tags: string; minDays: number };
    onChange: (f: FilterPanelProps['filters']) => void;
    onClose: () => void;
}

const FilterPanel: React.FC<FilterPanelProps> = ({ filters, onChange, onClose }) => {
    const [local, setLocal] = useState(filters);
    const set = (k: keyof typeof local, v: unknown) => setLocal(f => ({ ...f, [k]: v }));

    return (
        <div className="absolute right-0 top-full mt-2 w-72 bg-brand-surface border border-brand-border rounded-2xl shadow-2xl z-30 p-4 space-y-4">
            <div className="flex items-center justify-between">
                <span className="font-bold text-sm text-brand-text">Filtros</span>
                <button onClick={onClose} className="text-brand-muted hover:text-brand-text"><X size={16} /></button>
            </div>
            <div>
                <label className="text-[11px] font-bold uppercase tracking-wider text-brand-muted mb-1 block">Origem</label>
                <select
                    value={local.source}
                    onChange={e => set('source', e.target.value)}
                    className="w-full px-3 py-2 bg-brand-surface-2 border border-brand-border rounded-xl text-sm text-brand-text outline-none"
                >
                    <option value="">Todas</option>
                    {SOURCE_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
            </div>
            <div>
                <label className="text-[11px] font-bold uppercase tracking-wider text-brand-muted mb-1 block">Tag</label>
                <input
                    value={local.tags}
                    onChange={e => set('tags', e.target.value)}
                    placeholder="Filtrar por tag..."
                    className="w-full px-3 py-2 bg-brand-surface-2 border border-brand-border rounded-xl text-sm text-brand-text placeholder-brand-muted outline-none"
                />
            </div>
            <div>
                <label className="text-[11px] font-bold uppercase tracking-wider text-brand-muted mb-1 block">Leads estagnados há mais de</label>
                <div className="flex items-center gap-2">
                    <input
                        value={local.minDays}
                        onChange={e => set('minDays', Number(e.target.value))}
                        type="number"
                        min="0"
                        className="w-20 px-3 py-2 bg-brand-surface-2 border border-brand-border rounded-xl text-sm text-brand-text outline-none"
                    />
                    <span className="text-sm text-brand-muted">dias</span>
                </div>
            </div>
            <div className="flex gap-2">
                <button
                    onClick={() => { setLocal({ source: '', tags: '', minDays: 0 }); onChange({ source: '', tags: '', minDays: 0 }); }}
                    className="flex-1 py-2 text-xs font-bold border border-brand-border text-brand-muted hover:text-brand-text rounded-xl transition-colors"
                >
                    Limpar
                </button>
                <button
                    onClick={() => { onChange(local); onClose(); }}
                    className="flex-1 py-2 text-xs font-bold bg-brand-accent text-white rounded-xl transition-colors hover:bg-brand-accent-hover"
                >
                    Aplicar
                </button>
            </div>
        </div>
    );
};

// ===========================================================
// COMPONENTE PRINCIPAL
// ===========================================================
const CRMPage: React.FC<CRMPageProps> = ({ tenantId }) => {
    const [leads, setLeads] = useState<Lead[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [actionError, setActionError] = useState('');
    const [draggedLead, setDraggedLead] = useState<Lead | null>(null);
    const [dragOverCol, setDragOverCol] = useState<string | null>(null);
    const fetchRequestIdRef = useRef(0);

    // Modais
    const [showNewModal, setShowNewModal] = useState(false);
    const [editLead, setEditLead] = useState<Lead | null>(null);
    const [saving, setSaving] = useState(false);

    // Busca + Filtros
    const [searchTerm, setSearchTerm] = useState('');
    const [showFilters, setShowFilters] = useState(false);
    const [filters, setFilters] = useState({ source: '', tags: '', minDays: 0 });
    const filterBtnRef = useRef<HTMLDivElement>(null);

    // ---------------------------------------------------------
    // HANDOFF DA IA
    //
    // `ai_handoff` era permanente: uma resposta manual pelo WhatsApp central
    // calava a Bia naquele lead para sempre — 34 dos 103 leads estavam assim em
    // 09/08/2026, sem nada na tela indicando isso. Agora vale 72h e o card mostra
    // o estado, com um clique para devolver o lead à IA.
    // ---------------------------------------------------------
    const HANDOFF_TTL_MS = 72 * 3600 * 1000;
    const leadHandoffAtivo = (lead: any): boolean => {
        if (lead?.ai_handoff !== true || !lead?.ai_handoff_at) return false;
        const at = new Date(lead.ai_handoff_at).getTime();
        return !Number.isNaN(at) && Date.now() - at < HANDOFF_TTL_MS;
    };

    const toggleLeadHandoff = async (lead: any) => {
        setActionError('');
        const querSilenciar = !leadHandoffAtivo(lead);
        const { data, error } = await supabase.rpc('set_ai_handoff', {
            p_kind: 'lead', p_id: lead.id, p_handoff: querSilenciar,
        });
        if (error || !(data as any)?.ok) {
            setActionError('Não foi possível alterar o atendimento deste lead. Tente novamente.');
            return;
        }
        setLeads(prev => prev.map(l => l.id === lead.id
            ? { ...l, ai_handoff: querSilenciar, ai_handoff_at: querSilenciar ? new Date().toISOString() : null }
            : l));
    };

    // ---------------------------------------------------------
    // FETCH
    // ---------------------------------------------------------
    const fetchLeads = async () => {
        const requestId = ++fetchRequestIdRef.current;
        setLoading(true);
        setLoadError('');
        setLeads([]);
        try {
            const { data, error } = await supabase
                .from('crm_leads')
                .select('*')
                .eq('tenant_id', tenantId)
                .order('created_at', { ascending: false });

            if (error) throw error;
            if (requestId !== fetchRequestIdRef.current) return;
            setLeads(((data || []) as Lead[]).map(normalizeLeadForBoard));
        } catch (err) {
            console.error('Erro ao buscar leads:', err);
            if (requestId === fetchRequestIdRef.current) {
                setLoadError('Não foi possível carregar o pipeline. Nenhum lead será tratado como ausente até uma leitura válida.');
            }
        } finally {
            if (requestId === fetchRequestIdRef.current) setLoading(false);
        }
    };

    useEffect(() => {
        void fetchLeads();
        return () => { fetchRequestIdRef.current += 1; };
    }, [tenantId]);

    // ---------------------------------------------------------
    // MÉTRICAS
    // ---------------------------------------------------------
    const metrics = useMemo(() => {
        const totalValue = leads.reduce((acc, l) => acc + (l.value || 0), 0);
        const wonCount   = leads.filter(l => l.status === 'WON').length;
        const total      = leads.length;

        return {
            opportunities:  leads.filter(l => l.status !== 'WON' && l.status !== 'LOST').length,
            pipelineValue:  totalValue,
            conversion:     total > 0 ? ((wonCount / total) * 100).toFixed(1) : '0',
            totalLeads:     total,
        };
    }, [leads]);

    // ---------------------------------------------------------
    // FILTROS
    // ---------------------------------------------------------
    const getDaysInStage = (dateStr: string | null) => {
        if (!dateStr) return 0;
        return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000);
    };

    const filteredLeads = useMemo(() => {
        return leads.filter(l => {
            if (l.status === 'LOST') return false; // LOST fica fora do board principal

            const matchSearch = !searchTerm ||
                l.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                l.email?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                l.phone?.includes(searchTerm);

            const matchSource = !filters.source || l.source === filters.source;

            const matchTags = !filters.tags ||
                (l.tags || []).some(t => t.includes(filters.tags.toLowerCase()));

            const days = getDaysInStage(l.last_status_change || l.created_at);
            const matchDays = filters.minDays === 0 || days >= filters.minDays;

            return matchSearch && matchSource && matchTags && matchDays;
        });
    }, [leads, searchTerm, filters]);

    const activeFiltersCount = [filters.source, filters.tags, filters.minDays > 0 ? '1' : ''].filter(Boolean).length;

    // ---------------------------------------------------------
    // DRAG & DROP
    // ---------------------------------------------------------
    const handleDragStart = (e: React.DragEvent, lead: Lead) => {
        if (isAuthoritativeLeadStage(lead)) {
            e.preventDefault();
            setActionError(lead.status === 'WON' ? WON_MANUAL_BLOCK_MESSAGE : TRIAL_MANUAL_BLOCK_MESSAGE);
            return;
        }
        setActionError('');
        setDraggedLead(lead);
        e.dataTransfer.effectAllowed = 'move';
    };

    const handleDragOver = (e: React.DragEvent, col: string) => {
        e.preventDefault();
        if (col === 'WON' || col === 'SCHEDULED' || col === 'TRIAL_DONE' || (draggedLead && isAuthoritativeLeadStage(draggedLead))) {
            e.dataTransfer.dropEffect = 'none';
            setDragOverCol(null);
            return;
        }
        e.dataTransfer.dropEffect = 'move';
        setDragOverCol(col);
    };

    const handleDragLeave = () => setDragOverCol(null);

    const handleDrop = async (e: React.DragEvent, targetStatus: StatusType) => {
        e.preventDefault();
        setDragOverCol(null);
        const lead = draggedLead;
        setDraggedLead(null);
        if (!lead || lead.status === targetStatus) return;
        if (targetStatus === 'WON' || targetStatus === 'SCHEDULED' || targetStatus === 'TRIAL_DONE' || isAuthoritativeLeadStage(lead)) {
            setActionError(targetStatus === 'WON' || lead.status === 'WON'
                ? WON_MANUAL_BLOCK_MESSAGE
                : TRIAL_MANUAL_BLOCK_MESSAGE);
            return;
        }

        setActionError('');
        const now = new Date().toISOString();
        try {
            const { data: updated, error } = await supabase.from('crm_leads').update({
                status: targetStatus,
                last_status_change: now,
            })
                .eq('id', lead.id)
                .eq('tenant_id', tenantId)
                .select('*')
                .maybeSingle();
            if (error) throw error;
            if (!updated) throw new Error('lead_update_not_applied');
            setLeads(prev => prev.map(item => item.id === lead.id ? normalizeLeadForBoard(updated as Lead) : item));
        } catch (err) {
            console.error('Erro ao mover lead:', err);
            setActionError('Não foi possível mover o lead. A etapa anterior foi mantida; tente novamente.');
        }
    };

    // ---------------------------------------------------------
    // CRUD
    // ---------------------------------------------------------
    const handleSaveNew = async (data: Partial<Lead>) => {
        if (data.status === 'WON') {
            setActionError(WON_MANUAL_BLOCK_MESSAGE);
            return;
        }
        setSaving(true);
        setActionError('');
        try {
            const { data: inserted, error } = await supabase.from('crm_leads').insert({
                ...editableLeadPayload(data),
                status: data.status || 'NEW',
                tenant_id: tenantId,
                last_status_change: new Date().toISOString(),
            }).select().single();

            if (error) throw error;
            setLeads(prev => [normalizeLeadForBoard(inserted as Lead), ...prev]);
            setShowNewModal(false);
        } catch (err) {
            console.error('Erro ao criar lead:', err);
            setActionError('Não foi possível criar a oportunidade. Revise os dados e tente novamente.');
        } finally {
            setSaving(false);
        }
    };

    const handleSaveEdit = async (data: Partial<Lead>) => {
        if (!editLead) return;
        const authoritativeStage = isAuthoritativeLeadStage(editLead);
        if (!authoritativeStage && data.status === 'WON') {
            setActionError(WON_MANUAL_BLOCK_MESSAGE);
            return;
        }
        setSaving(true);
        setActionError('');
        try {
            const statusChanged = !authoritativeStage
                && data.status !== undefined
                && data.status !== editLead.status;
            const payload: Record<string, unknown> = editableLeadPayload(data);
            if (!authoritativeStage) payload.status = data.status || editLead.status;
            if (statusChanged) payload.last_status_change = new Date().toISOString();

            const { data: updated, error } = await supabase.from('crm_leads')
                .update(payload)
                .eq('id', editLead.id)
                .eq('tenant_id', tenantId)
                .select()
                .single();

            if (error) throw error;
            setLeads(prev => prev.map(l => l.id === editLead.id ? normalizeLeadForBoard(updated as Lead) : l));
            setEditLead(null);
        } catch (err) {
            console.error('Erro ao editar lead:', err);
            setActionError('Não foi possível salvar as alterações. O lead anterior foi mantido; tente novamente.');
        } finally {
            setSaving(false);
        }
    };

    // ---------------------------------------------------------
    // RENDER
    // ---------------------------------------------------------
    return (
        <div className="flex flex-col h-full min-h-0 bg-brand-bg font-sans">
            {/* ── TOP BAR ── */}
            <header className="shrink-0 bg-brand-surface border-b border-brand-border px-6 py-4 flex items-center justify-between z-10 shadow-sm">
                {/* Título + KPIs */}
                <div className="flex items-center gap-6 flex-wrap">
                    <h1 className="text-lg font-extrabold text-brand-text flex items-center gap-2 whitespace-nowrap">
                        <Kanban size={20} className="text-brand-accent" />
                        Pipeline de Vendas
                    </h1>

                    <div className="hidden sm:block h-8 w-px bg-brand-border" />

                    <div className="flex gap-6 flex-wrap">
                        <div>
                            <p className="text-[10px] font-bold uppercase tracking-wider text-brand-muted">Oportunidades</p>
                            <p className="text-lg font-extrabold text-brand-text">{metrics.opportunities}</p>
                        </div>
                        <div>
                            <p className="text-[10px] font-bold uppercase tracking-wider text-brand-muted">Pipeline Total</p>
                            <p className="text-lg font-extrabold text-emerald-500">
                                {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', notation: 'compact' }).format(metrics.pipelineValue)}
                            </p>
                        </div>
                        <div>
                            <p className="text-[10px] font-bold uppercase tracking-wider text-brand-muted">Conversão</p>
                            <p className="text-lg font-extrabold text-brand-accent">{metrics.conversion}%</p>
                        </div>
                        <div>
                            <p className="text-[10px] font-bold uppercase tracking-wider text-brand-muted">Total Leads</p>
                            <p className="text-lg font-extrabold text-brand-text">{metrics.totalLeads}</p>
                        </div>
                    </div>
                </div>

                {/* Ações */}
                <div className="flex items-center gap-2 shrink-0">
                    <div className="relative hidden md:block">
                        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted pointer-events-none" />
                        <input
                            type="text"
                            placeholder="Buscar leads..."
                            value={searchTerm}
                            onChange={e => setSearchTerm(e.target.value)}
                            className="pl-9 pr-4 py-2 bg-brand-surface-2 border border-brand-border rounded-xl text-sm outline-none focus:border-brand-accent w-52 transition-colors text-brand-text placeholder-brand-muted"
                        />
                    </div>

                    <button
                        onClick={() => { setActionError(''); setShowNewModal(true); }}
                        className="bg-brand-accent hover:bg-brand-accent-hover text-white px-4 py-2 rounded-xl font-bold text-sm flex items-center gap-1.5 shadow-sm transition-colors whitespace-nowrap"
                    >
                        <Plus size={15} /> Nova Oportunidade
                    </button>

                    {/* Botão Filtro com badge */}
                    <div ref={filterBtnRef} className="relative">
                        <button
                            onClick={() => setShowFilters(f => !f)}
                            className={`relative p-2 border rounded-xl transition-colors ${activeFiltersCount > 0 ? 'border-brand-accent text-brand-accent bg-brand-accent/10' : 'border-brand-border text-brand-muted hover:text-brand-text hover:bg-brand-surface-2'}`}
                        >
                            <Filter size={18} />
                            {activeFiltersCount > 0 && (
                                <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-brand-accent text-white text-[10px] font-bold flex items-center justify-center">
                                    {activeFiltersCount}
                                </span>
                            )}
                        </button>

                        {showFilters && (
                            <FilterPanel
                                filters={filters}
                                onChange={f => { setFilters(f); }}
                                onClose={() => setShowFilters(false)}
                            />
                        )}
                    </div>

                    <button
                        onClick={fetchLeads}
                        className="p-2 border border-brand-border text-brand-muted hover:text-brand-text hover:bg-brand-surface-2 rounded-xl transition-colors"
                        title="Atualizar"
                    >
                        <RefreshCw size={18} />
                    </button>
                </div>
            </header>

            {actionError && !showNewModal && !editLead && (
                <div role="alert" className="mx-4 mt-4 flex items-start gap-2 rounded-xl border border-red-400/40 bg-red-500/10 px-4 py-3 text-xs font-bold text-red-600">
                    <AlertCircle size={16} className="mt-0.5 shrink-0" />
                    <span className="flex-1">{actionError}</span>
                    <button type="button" onClick={() => setActionError('')} aria-label="Fechar aviso"><X size={14} /></button>
                </div>
            )}

            {/* ── BOARD ── */}
            <main className="flex-1 min-h-0 p-4 overflow-x-auto overflow-y-hidden">
                {loading ? (
                    <div className="flex items-center justify-center h-full text-brand-muted">
                        <RefreshCw size={24} className="animate-spin mr-2" /> Carregando leads...
                    </div>
                ) : loadError ? (
                    <div role="alert" className="flex h-full items-center justify-center">
                        <div className="max-w-md rounded-2xl border border-red-400/40 bg-brand-surface p-6 text-center shadow-sm">
                            <AlertCircle size={28} className="mx-auto text-red-500" />
                            <h2 className="mt-3 text-sm font-black text-brand-text">Pipeline indisponível</h2>
                            <p className="mt-1 text-xs leading-relaxed text-brand-muted">{loadError}</p>
                            <button
                                type="button"
                                onClick={() => void fetchLeads()}
                                className="mt-4 inline-flex items-center gap-2 rounded-xl border border-red-400/40 px-4 py-2 text-xs font-black text-red-600 hover:bg-red-500/10"
                            >
                                <RefreshCw size={14} /> Tentar novamente
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="flex gap-4 h-full min-w-[900px]">
                        {VISIBLE_COLUMNS.map(status => {
                            const col = filteredLeads.filter(l => l.status === status);
                            const colValue = col.reduce((a, l) => a + (l.value || 0), 0);
                            const cfg = COLUMN_CONFIG[status];
                            const isDragTarget = dragOverCol === status && draggedLead?.status !== status;

                            return (
                                <div
                                    key={status}
                                    data-testid={`crm-column-${status}`}
                                    onDragOver={e => handleDragOver(e, status)}
                                    onDragLeave={handleDragLeave}
                                    onDrop={e => handleDrop(e, status)}
                                    className={`flex flex-col flex-1 min-w-[220px] rounded-2xl border transition-all duration-150 ${isDragTarget ? 'border-brand-accent bg-brand-accent/5 scale-[1.01]' : 'border-brand-border bg-brand-surface'}`}
                                >
                                    {/* Cabeçalho da coluna */}
                                    <div className={`shrink-0 p-4 rounded-t-2xl border-b border-brand-border bg-gradient-to-b ${cfg.color} to-transparent`}>
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-2">
                                                <span className={`w-2 h-2 rounded-full shadow-sm ${cfg.dot}`} />
                                                <span className={`text-xs font-extrabold uppercase tracking-widest ${cfg.text}`}>
                                                    {cfg.label}
                                                </span>
                                                {status === 'WON' && (
                                                    <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[8px] font-black uppercase tracking-wider text-emerald-600">
                                                        Automático
                                                    </span>
                                                )}
                                            </div>
                                            <span className="text-xs font-bold text-brand-muted bg-brand-surface-2 px-2 py-0.5 rounded-full border border-brand-border">
                                                {col.length}
                                            </span>
                                        </div>
                                        <p className="text-[11px] text-brand-muted mt-1.5 font-medium">
                                            {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', notation: 'compact' }).format(colValue)}
                                        </p>
                                    </div>

                                    {/* Cards — scroll vertical dentro da coluna */}
                                    <div
                                        className="flex-1 overflow-y-auto p-3 space-y-2.5"
                                        style={{ scrollbarWidth: 'thin', scrollbarColor: 'var(--brand-border, #334155) transparent' }}
                                    >
                                        {col.length === 0 && (
                                            <div className="flex flex-col items-center justify-center h-24 text-brand-muted/50 select-none">
                                                <Users size={20} className="mb-1 opacity-30" />
                                                <span className="px-3 text-center text-[11px]">
                                                    {status === 'WON'
                                                        ? 'A matrícula aparece aqui após o fluxo autoritativo.'
                                                        : 'Arraste leads aqui'}
                                                </span>
                                            </div>
                                        )}

                                        {col.map(lead => {
                                            const days = getDaysInStage(lead.last_status_change || lead.created_at);
                                            const stagnant = days > 3;
                                            const initials = (lead.name || '?').charAt(0).toUpperCase();

                                            return (
                                                <div
                                                    key={lead.id}
                                                    data-testid={`crm-card-${lead.id}`}
                                                    draggable={!isAuthoritativeLeadStage(lead)}
                                                    onDragStart={e => handleDragStart(e, lead)}
                                                    onDragEnd={() => { setDraggedLead(null); setDragOverCol(null); }}
                                                    className={`group bg-brand-surface-2 p-3.5 rounded-xl border transition-all select-none hover:shadow-md ${isAuthoritativeLeadStage(lead) ? 'cursor-default' : 'cursor-grab active:cursor-grabbing'} ${stagnant ? 'border-amber-500/30 hover:border-amber-500/60' : 'border-brand-border hover:border-brand-accent/50'}`}
                                                >
                                                    {/* Header */}
                                                    <div className="flex items-start gap-2.5 mb-2.5">
                                                        <div className="w-8 h-8 rounded-lg bg-brand-surface border border-brand-border flex items-center justify-center text-brand-text text-xs font-black shrink-0">
                                                            {initials}
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                            <h4 className="font-bold text-brand-text truncate text-sm leading-tight" title={lead.name}>
                                                                {lead.name}
                                                            </h4>
                                                            <p className="text-[11px] text-brand-muted truncate leading-tight">
                                                                {lead.source || 'Sem origem'}
                                                                {lead.level ? ` • ${lead.level}` : ''}
                                                            </p>
                                                        </div>
                                                        <button
                                                            onClick={() => toggleLeadHandoff(lead)}
                                                            className={`p-1 rounded-lg transition-all ${leadHandoffAtivo(lead)
                                                                ? 'text-amber-500 hover:bg-amber-500/10'
                                                                : 'opacity-0 group-hover:opacity-100 text-brand-muted hover:text-brand-accent hover:bg-brand-accent/10'}`}
                                                            title={leadHandoffAtivo(lead)
                                                                ? 'Atendimento humano: a Bia não responde este lead. Clique para devolver à IA.'
                                                                : 'Silenciar a Bia neste lead (assumir o atendimento)'}
                                                        >
                                                            {leadHandoffAtivo(lead) ? <BotOff size={13} /> : <Bot size={13} />}
                                                        </button>
                                                        <button
                                                            onClick={() => { setActionError(''); setEditLead(lead); }}
                                                            className="opacity-0 group-hover:opacity-100 p-1 rounded-lg text-brand-muted hover:text-brand-accent hover:bg-brand-accent/10 transition-all"
                                                            title="Editar lead"
                                                        >
                                                            <Edit2 size={13} />
                                                        </button>
                                                    </div>

                                                    {/* Valor */}
                                                    {(lead.value || 0) > 0 && (
                                                        <div className="mb-2">
                                                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-emerald-400/10 text-emerald-500 border border-emerald-400/20 text-[10px] font-bold">
                                                                R$ {(lead.value || 0).toLocaleString('pt-BR')}
                                                            </span>
                                                        </div>
                                                    )}

                                                    {/* Tags */}
                                                    {(lead.tags || []).length > 0 && (
                                                        <div className="flex flex-wrap gap-1 mb-2">
                                                            {(lead.tags || []).slice(0, 3).map((tag, i) => (
                                                                <span key={i} className="px-1.5 py-0.5 rounded bg-brand-surface border border-brand-border text-brand-muted text-[10px] font-medium">
                                                                    {tag}
                                                                </span>
                                                            ))}
                                                            {(lead.tags || []).length > 3 && (
                                                                <span className="px-1.5 py-0.5 rounded bg-brand-surface border border-brand-border text-brand-muted text-[10px]">
                                                                    +{(lead.tags || []).length - 3}
                                                                </span>
                                                            )}
                                                        </div>
                                                    )}

                                                    {/* Alerta de estagnação */}
                                                    {stagnant && (
                                                        <div className="flex items-center gap-1 text-amber-500 text-[10px] font-bold bg-amber-400/10 border border-amber-400/20 px-2 py-0.5 rounded-lg w-fit mb-2">
                                                            <Clock size={11} /> {days}d nessa etapa
                                                        </div>
                                                    )}

                                                    {/* Footer */}
                                                    <div className="flex items-center justify-between pt-2 border-t border-brand-border/50">
                                                        <div className="flex gap-1">
                                                            {lead.phone && (
                                                                <a
                                                                    href={`https://wa.me/55${lead.phone.replace(/\D/g, '')}`}
                                                                    target="_blank"
                                                                    rel="noopener noreferrer"
                                                                    onClick={e => e.stopPropagation()}
                                                                    className="p-1.5 rounded-lg text-brand-muted hover:text-emerald-500 hover:bg-emerald-400/10 transition-colors"
                                                                    title="WhatsApp"
                                                                >
                                                                    <MessageCircle size={14} />
                                                                </a>
                                                            )}
                                                            {lead.email && (
                                                                <a
                                                                    href={`mailto:${lead.email}`}
                                                                    onClick={e => e.stopPropagation()}
                                                                    className="p-1.5 rounded-lg text-brand-muted hover:text-blue-500 hover:bg-blue-400/10 transition-colors"
                                                                    title="E-mail"
                                                                >
                                                                    <Mail size={14} />
                                                                </a>
                                                            )}
                                                        </div>
                                                        <span className="text-[10px] text-brand-muted/70 font-medium">
                                                            {new Date(lead.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}
                                                        </span>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </main>

            {/* ── MODAL: NOVA OPORTUNIDADE ── */}
            {showNewModal && (
                <Modal title="Nova Oportunidade" onClose={() => { setShowNewModal(false); setActionError(''); }}>
                    <LeadForm
                        onSave={handleSaveNew}
                        onCancel={() => { setShowNewModal(false); setActionError(''); }}
                        saving={saving}
                        formError={actionError}
                    />
                </Modal>
            )}

            {/* ── MODAL: EDITAR LEAD ── */}
            {editLead && (
                <Modal title={`Editar: ${editLead.name}`} onClose={() => { setEditLead(null); setActionError(''); }}>
                    <LeadForm
                        initial={editLead}
                        onSave={handleSaveEdit}
                        onCancel={() => { setEditLead(null); setActionError(''); }}
                        saving={saving}
                        formError={actionError}
                    />
                </Modal>
            )}
        </div>
    );
};

export default CRMPage;
