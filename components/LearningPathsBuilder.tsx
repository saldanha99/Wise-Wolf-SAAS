import React, { useState, useEffect, useMemo } from 'react';
import {
    Plus, Edit2, Trash2, Save, X, ChevronRight, ChevronLeft, Loader2, Sparkles,
    BookOpen, Briefcase, GraduationCap, Plane, Cpu, Heart, Globe, Target,
    Layers, FileText, Mic, HelpCircle, Pen, Check, GripVertical, UserPlus, Archive, AlertCircle, Search, Home
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { generateUnitActivityContent } from '../services/geminiService';
import PathAssignmentModal from './PathAssignmentModal';

interface Props {
    user: { id: string; tenantId?: string; role: string };
    tenantId?: string;
}

// `tone`: cor da categoria nos cartões — transparência funciona nos dois temas.
const CATEGORIES = [
    { id: 'BUSINESS', label: 'Business', icon: Briefcase, tone: 'bg-blue-500/10 text-blue-700 dark:text-blue-300', bar: 'bg-blue-500' },
    { id: 'TOEFL_IELTS', label: 'TOEFL/IELTS', icon: GraduationCap, tone: 'bg-amber-500/10 text-amber-700 dark:text-amber-300', bar: 'bg-amber-500' },
    { id: 'TRAVEL', label: 'Viagem', icon: Plane, tone: 'bg-sky-500/10 text-sky-700 dark:text-sky-300', bar: 'bg-sky-500' },
    { id: 'KIDS', label: 'Crianças', icon: Heart, tone: 'bg-rose-500/10 text-rose-700 dark:text-rose-300', bar: 'bg-rose-500' },
    { id: 'TECH', label: 'Tecnologia', icon: Cpu, tone: 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-300', bar: 'bg-cyan-500' },
    { id: 'GENERAL', label: 'Geral', icon: Globe, tone: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300', bar: 'bg-emerald-500' },
    { id: 'CONVERSATION', label: 'Conversação', icon: Sparkles, tone: 'bg-orange-500/10 text-orange-700 dark:text-orange-300', bar: 'bg-orange-500' },
];

const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

const ACTIVITY_TYPES = [
    { id: 'vocab_cards', label: 'Flashcards de Vocabulário', icon: BookOpen },
    { id: 'quiz', label: 'Quiz', icon: HelpCircle },
    { id: 'grammar_drill', label: 'Drill de Gramática', icon: Pen },
    { id: 'reading', label: 'Leitura + Compreensão', icon: FileText },
    { id: 'speaking_wolfie', label: 'Fala com Wolfie', icon: Mic },
];

type View =
    | { type: 'list' }
    | { type: 'path'; pathId: string }
    | { type: 'unit'; pathId: string; unitId: string }
    | { type: 'activity'; pathId: string; unitId: string; activityId: string };

const LearningPathsBuilder: React.FC<Props> = ({ user, tenantId }) => {
    const [view, setView] = useState<View>({ type: 'list' });
    const [refreshKey, setRefreshKey] = useState(0);
    const triggerRefresh = () => setRefreshKey(k => k + 1);

    return (
        <div className="overflow-hidden rounded-3xl border border-brand-border bg-brand-surface">
            <div className="flex flex-col gap-3 border-b border-brand-border p-4 sm:flex-row sm:items-center sm:justify-between sm:p-6">
                <div className="flex items-center gap-3">
                    <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-brand-accent/10">
                        <Target size={20} className="text-brand-accent" />
                    </div>
                    <div>
                        <h3 className="text-lg font-black tracking-tight text-brand-text">Trilhas Didáticas</h3>
                        <p className="text-xs text-brand-muted">Trilha → unidades → atividades que o aluno faz no portal</p>
                    </div>
                </div>
                {/* Onde estou: cada nível volta para ele com um clique */}
                <nav data-tour="paths-breadcrumb" aria-label="Onde você está" className="flex flex-wrap items-center gap-1 text-xs font-bold">
                    {([
                        { key: 'list', label: 'Todas as trilhas', icon: Home, go: () => setView({ type: 'list' }), show: true },
                        { key: 'path', label: 'Trilha', icon: Target, go: () => view.type !== 'list' && setView({ type: 'path', pathId: view.pathId }), show: view.type !== 'list' },
                        { key: 'unit', label: 'Unidade', icon: Layers, go: () => (view.type === 'unit' || view.type === 'activity') && setView({ type: 'unit', pathId: view.pathId, unitId: view.unitId }), show: view.type === 'unit' || view.type === 'activity' },
                        { key: 'activity', label: 'Atividade', icon: FileText, go: () => undefined, show: view.type === 'activity' },
                    ] as const).filter(step => step.show).map((step, index, list) => {
                        const current = index === list.length - 1;
                        const StepIcon = step.icon;
                        return (
                            <React.Fragment key={step.key}>
                                {index > 0 && <ChevronRight size={13} className="text-brand-muted" aria-hidden />}
                                <button
                                    type="button"
                                    onClick={step.go}
                                    disabled={current}
                                    aria-current={current ? 'page' : undefined}
                                    className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 transition-colors ${current
                                        ? 'bg-brand-accent/10 text-brand-accent'
                                        : 'text-brand-muted hover:bg-brand-surface-2 hover:text-brand-text'
                                        }`}
                                >
                                    <StepIcon size={13} /> {step.label}
                                </button>
                            </React.Fragment>
                        );
                    })}
                </nav>
            </div>

            <div className="p-4 sm:p-6">
                {view.type === 'list' && <PathList user={user} tenantId={tenantId} onOpen={(id) => setView({ type: 'path', pathId: id })} refreshKey={refreshKey} onRefresh={triggerRefresh} />}
                {view.type === 'path' && <PathDetail pathId={view.pathId} user={user} tenantId={tenantId} onOpenUnit={(uid) => setView({ type: 'unit', pathId: view.pathId, unitId: uid })} onPathDeleted={() => setView({ type: 'list' })} />}
                {view.type === 'unit' && <UnitDetail unitId={view.unitId} user={user} tenantId={tenantId} onOpenActivity={(aid) => setView({ type: 'activity', pathId: view.pathId, unitId: view.unitId, activityId: aid })} onBack={() => setView({ type: 'path', pathId: view.pathId })} />}
                {view.type === 'activity' && <ActivityDetail activityId={view.activityId} unitId={view.unitId} onBack={() => setView({ type: 'unit', pathId: view.pathId, unitId: view.unitId })} />}
            </div>
        </div>
    );
};

// ─────────────────────────────────────────────────────────────
// LIST DE PATHS
// ─────────────────────────────────────────────────────────────
const PathList: React.FC<{ user: any; tenantId?: string; onOpen: (id: string) => void; refreshKey: number; onRefresh: () => void }> = ({ user, tenantId, onOpen, refreshKey, onRefresh }) => {
    const [paths, setPaths] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [creating, setCreating] = useState(false);
    const [archivingId, setArchivingId] = useState<string | null>(null);
    const [actionMessage, setActionMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
    // Filtros só na tela: a consulta ao banco é a mesma de sempre.
    const [search, setSearch] = useState('');
    const [levelFilter, setLevelFilter] = useState<string>('all');
    const [categoryFilter, setCategoryFilter] = useState<string>('all');
    const [showArchived, setShowArchived] = useState(false);

    useEffect(() => {
        load();
    }, [tenantId, refreshKey]);

    const load = async () => {
        setLoading(true);
        const { data } = await supabase
            .from('learning_paths')
            .select('id, name, description, target_level, category, active, tenant_id, created_at')
            .or(`tenant_id.is.null,tenant_id.eq.${tenantId || 'none'}`)
            .order('created_at', { ascending: false });
        setPaths(data || []);
        setLoading(false);
    };

    const createPath = async (form: any) => {
        const { data, error } = await supabase.from('learning_paths').insert({
            tenant_id: tenantId,
            name: form.name,
            description: form.description,
            target_level: form.target_level,
            category: form.category,
            estimated_hours: parseInt(form.estimated_hours) || 0,
            active: true,
            created_by: user.id,
        }).select('id').single();
        if (error) {
            alert('Erro ao criar trilha: ' + error.message);
            return;
        }
        setCreating(false);
        onRefresh();
        if (data?.id) onOpen(data.id);
    };

    const archivePath = async (id: string) => {
        const reason = window.prompt('Motivo do arquivamento (o histórico dos alunos será preservado):');
        if (reason === null) return;
        if (reason.trim().length < 5) {
            setActionMessage({ tone: 'error', text: 'Informe um motivo com pelo menos 5 caracteres.' });
            return;
        }
        setArchivingId(id);
        setActionMessage(null);
        try {
            const { error } = await supabase.rpc('archive_learning_path', {
                p_path_id: id,
                p_reason: reason.trim(),
            });
            if (error) throw error;
            setActionMessage({ tone: 'success', text: 'Trilha arquivada sem apagar matrículas, progresso ou XP.' });
            onRefresh();
        } catch (error) {
            console.error('Secure learning path archive failed:', error);
            setActionMessage({
                tone: 'error',
                text: String((error as any)?.message || '').includes('learning_path_has_active_students')
                    ? 'Esta trilha ainda tem alunos em curso. Conclua ou troque essas matrículas antes de arquivar.'
                    : 'Não foi possível arquivar a trilha. Nenhum histórico foi removido.',
            });
        } finally {
            setArchivingId(null);
        }
    };

    const visiblePaths = useMemo(() => {
        const term = search.trim().toLowerCase();
        return paths.filter(p =>
            (showArchived || p.active)
            && (levelFilter === 'all' || p.target_level === levelFilter)
            && (categoryFilter === 'all' || p.category === categoryFilter)
            && (!term || `${p.name} ${p.description || ''}`.toLowerCase().includes(term)),
        );
    }, [paths, search, levelFilter, categoryFilter, showArchived]);

    const activeCount = paths.filter(p => p.active).length;
    const archivedCount = paths.length - activeCount;
    const levelCounts = LEVELS.map(level => ({ level, count: paths.filter(p => p.active && p.target_level === level).length }));
    const maxLevel = Math.max(1, ...levelCounts.map(item => item.count));

    if (loading) return <Loader />;

    return (
        <div className="space-y-5">
            {/* Retrato do acervo: quantas trilhas e como se espalham pelos níveis */}
            <div className="grid gap-3 lg:grid-cols-[auto_1fr_auto] lg:items-center">
                <div className="flex gap-6">
                    <div>
                        <p className="text-3xl font-black leading-none text-brand-text">{activeCount}</p>
                        <p className="mt-1 text-xs font-semibold text-brand-muted">trilhas ativas</p>
                    </div>
                    {archivedCount > 0 && (
                        <div>
                            <p className="text-3xl font-black leading-none text-brand-muted">{archivedCount}</p>
                            <p className="mt-1 text-xs font-semibold text-brand-muted">arquivadas</p>
                        </div>
                    )}
                </div>
                <div data-tour="paths-levels" className="flex items-end gap-2 rounded-2xl bg-brand-surface-2 px-4 py-3" aria-label="Trilhas ativas por nível">
                    {levelCounts.map(({ level, count }) => (
                        <button
                            key={level}
                            type="button"
                            onClick={() => setLevelFilter(levelFilter === level ? 'all' : level)}
                            aria-pressed={levelFilter === level}
                            className="group flex flex-1 flex-col items-center gap-1"
                            title={`${count} trilha(s) ${level}`}
                        >
                            <span className="text-[11px] font-black text-brand-text">{count}</span>
                            <span className="flex h-10 w-full items-end overflow-hidden rounded-md bg-brand-surface">
                                <span
                                    className={`w-full rounded-md transition-all ${levelFilter === level ? 'bg-brand-accent' : 'bg-brand-accent/40 group-hover:bg-brand-accent/70'}`}
                                    style={{ height: `${Math.max(count > 0 ? 12 : 0, (count / maxLevel) * 100)}%` }}
                                />
                            </span>
                            <span className={`text-[11px] font-bold ${levelFilter === level ? 'text-brand-accent' : 'text-brand-muted'}`}>{level}</span>
                        </button>
                    ))}
                </div>
                <button
                    onClick={() => setCreating(true)}
                    className="flex items-center justify-center gap-2 rounded-xl bg-brand-accent px-5 py-3 text-sm font-bold text-white shadow-sm hover:bg-brand-accent-hover dark:text-brand-bg"
                >
                    <Plus size={16} /> Nova trilha
                </button>
            </div>

            {creating && <PathForm onSubmit={createPath} onCancel={() => setCreating(false)} />}

            {actionMessage && (
                <div className={`flex items-start gap-2 rounded-xl border p-3 text-xs font-bold ${actionMessage.tone === 'error' ? 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900/40 dark:bg-rose-950/25 dark:text-rose-100' : 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-950/25 dark:text-emerald-100'}`} role={actionMessage.tone === 'error' ? 'alert' : 'status'}>
                    {actionMessage.tone === 'error' ? <AlertCircle size={15} className="shrink-0" /> : <Check size={15} className="shrink-0" />}
                    <span>{actionMessage.text}</span>
                </div>
            )}

            {/* Busca e filtros */}
            <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <label className="relative flex-1">
                    <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted" />
                    <input
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Buscar trilha pelo nome ou descrição"
                        className="w-full rounded-xl border border-brand-border bg-brand-surface py-2.5 pl-9 pr-3 text-sm text-brand-text placeholder:text-brand-muted focus:outline-hidden focus:ring-2 focus:ring-brand-accent/30"
                    />
                </label>
                {archivedCount > 0 && (
                    <label className="flex shrink-0 items-center gap-2 text-xs font-bold text-brand-muted">
                        <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} className="accent-current" />
                        Mostrar arquivadas
                    </label>
                )}
                </div>
                <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0 [&::-webkit-scrollbar]:hidden">
                    {[{ id: 'all', label: 'Todas' }, ...CATEGORIES].map(c => (
                        <button
                            key={c.id}
                            type="button"
                            aria-pressed={categoryFilter === c.id}
                            onClick={() => setCategoryFilter(c.id)}
                            className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-bold transition-colors ${categoryFilter === c.id
                                ? 'bg-brand-accent text-white dark:text-brand-bg'
                                : 'bg-brand-surface-2 text-brand-muted hover:text-brand-text'
                                }`}
                        >
                            {c.label}
                        </button>
                    ))}
                </div>
            </div>

            {visiblePaths.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-brand-border py-14 text-center">
                    <Target className="mx-auto mb-2 text-brand-muted opacity-40" size={36} />
                    <p className="text-sm font-medium text-brand-muted">
                        {paths.length === 0 ? 'Nenhuma trilha ainda. Crie a primeira em “Nova trilha”.' : 'Nenhuma trilha com esses filtros.'}
                    </p>
                </div>
            ) : (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {visiblePaths.map(p => {
                        const meta = CATEGORIES.find(c => c.id === p.category) || CATEGORIES[5];
                        const Icon = meta.icon;
                        return (
                            <div
                                key={p.id}
                                className={`group relative flex flex-col overflow-hidden rounded-2xl border border-brand-border bg-brand-surface transition-all hover:-translate-y-0.5 hover:shadow-lg ${p.active ? '' : 'opacity-70'}`}
                            >
                                <span className={`h-1.5 w-full ${meta.bar}`} aria-hidden />
                                <div className="flex flex-1 flex-col p-4">
                                    <div className="flex items-start justify-between gap-2">
                                        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold ${meta.tone}`}>
                                            <Icon size={13} /> {meta.label}
                                        </span>
                                        <span className="rounded-xl bg-brand-surface-2 px-2.5 py-1 text-sm font-black text-brand-text">{p.target_level}</span>
                                    </div>
                                    <p className="mt-3 text-base font-black leading-snug text-brand-text">{p.name}</p>
                                    <p className="mt-1 line-clamp-2 min-h-10 text-sm text-brand-muted">{p.description || 'Sem descrição.'}</p>
                                    <div className="mt-2 flex flex-wrap gap-1.5">
                                        {!p.tenant_id && <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-300">Global</span>}
                                        {!p.active && <span className="rounded-full bg-brand-surface-2 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-brand-muted">Arquivada</span>}
                                    </div>
                                    <div className="mt-auto flex items-center justify-between gap-2 pt-4">
                                        <button
                                            onClick={() => onOpen(p.id)}
                                            className="flex items-center gap-1.5 rounded-xl bg-brand-surface-2 px-3.5 py-2 text-sm font-bold text-brand-text transition-colors hover:bg-brand-accent hover:text-white dark:hover:text-brand-bg"
                                        >
                                            Abrir trilha <ChevronRight size={14} />
                                        </button>
                                        {p.tenant_id && p.active && (
                                            <button
                                                type="button"
                                                onClick={() => void archivePath(p.id)}
                                                disabled={archivingId === p.id}
                                                className="rounded-lg p-2 text-xs text-brand-muted hover:bg-brand-surface-2 hover:text-brand-text disabled:cursor-wait disabled:opacity-50"
                                                title="Arquivar sem apagar histórico"
                                                aria-label={`Arquivar ${p.name}`}
                                            >
                                                {archivingId === p.id ? <Loader2 size={14} className="animate-spin" /> : <Archive size={14} />}
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

// ─────────────────────────────────────────────────────────────
// FORM DE PATH
// ─────────────────────────────────────────────────────────────
const PathForm: React.FC<{ initial?: any; onSubmit: (form: any) => void; onCancel: () => void }> = ({ initial, onSubmit, onCancel }) => {
    const [form, setForm] = useState({
        name: initial?.name || '',
        description: initial?.description || '',
        target_level: initial?.target_level || 'B1',
        category: initial?.category || 'GENERAL',
        estimated_hours: initial?.estimated_hours || 6,
    });

    return (
        <div className="bg-violet-50 dark:bg-violet-900/10 border border-violet-100 dark:border-violet-800/30 rounded-2xl p-4 space-y-3">
            <Input label="Nome" value={form.name} onChange={v => setForm({ ...form, name: v })} placeholder="Ex: Business English B1" />
            <Input label="Descrição" value={form.description} onChange={v => setForm({ ...form, description: v })} placeholder="Para quem é esta trilha?" multiline />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Select label="Nível" value={form.target_level} onChange={v => setForm({ ...form, target_level: v })} options={LEVELS.map(l => ({ id: l, label: l }))} />
                <Select label="Categoria" value={form.category} onChange={v => setForm({ ...form, category: v })} options={CATEGORIES.map(c => ({ id: c.id, label: c.label }))} />
                <Input label="Horas estimadas" type="number" value={String(form.estimated_hours)} onChange={v => setForm({ ...form, estimated_hours: v })} />
            </div>
            <div className="flex gap-2 justify-end">
                <button onClick={onCancel} className="text-xs font-bold text-slate-500 px-3 py-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg">Cancelar</button>
                <button onClick={() => onSubmit(form)} disabled={!form.name} className="text-xs font-black uppercase tracking-widest text-white bg-brand-accent dark:text-brand-bg px-4 py-2 rounded-lg hover:brightness-110 disabled:opacity-50 flex items-center gap-2">
                    <Save size={12} /> Salvar
                </button>
            </div>
        </div>
    );
};

// ─────────────────────────────────────────────────────────────
// DETALHE DE PATH (edita + lista units)
// ─────────────────────────────────────────────────────────────
const PathDetail: React.FC<{ pathId: string; user: any; tenantId?: string; onOpenUnit: (id: string) => void; onPathDeleted: () => void }> = ({ pathId, user, tenantId, onOpenUnit, onPathDeleted }) => {
    const [path, setPath] = useState<any>(null);
    const [units, setUnits] = useState<any[]>([]);
    const [editing, setEditing] = useState(false);
    const [creatingUnit, setCreatingUnit] = useState(false);
    const [assigning, setAssigning] = useState(false);
    const [dragIndex, setDragIndex] = useState<number | null>(null);
    const [frozen, setFrozen] = useState(true);

    useEffect(() => { load(); }, [pathId]);

    const load = async () => {
        const { data: pathData } = await supabase.from('learning_paths').select('*').eq('id', pathId).single();
        setPath(pathData);
        const { data: unitsData } = await supabase.from('learning_units').select('*').eq('path_id', pathId).order('order_index');
        setUnits(unitsData || []);
        const { data: enrollments, error: enrollmentError } = await supabase
            .from('student_path_enrollments')
            .select('id')
            .eq('path_id', pathId)
            .limit(1);
        if (enrollmentError) console.error('Learning path freeze state error:', enrollmentError);
        setFrozen(Boolean(enrollmentError || enrollments?.length));
    };

    const savePath = async (form: any) => {
        if (frozen) return;
        await supabase.from('learning_paths').update({
            name: form.name,
            description: form.description,
            target_level: form.target_level,
            category: form.category,
            estimated_hours: parseInt(form.estimated_hours) || 0,
        }).eq('id', pathId);
        setEditing(false);
        load();
    };

    const createUnit = async (form: any) => {
        if (frozen) return;
        const nextOrder = units.length > 0 ? Math.max(...units.map(u => u.order_index)) + 1 : 1;
        await supabase.from('learning_units').insert({
            path_id: pathId,
            order_index: nextOrder,
            title: form.title,
            description: form.description,
            estimated_minutes: parseInt(form.estimated_minutes) || 30,
            skill_focus: form.skill_focus ? form.skill_focus.split(',').map((s: string) => s.trim()) : [],
        });
        setCreatingUnit(false);
        load();
    };

    const deleteUnit = async (id: string) => {
        if (frozen) return;
        if (!confirm('Excluir esta unidade e suas atividades?')) return;
        const { error } = await supabase.rpc('delete_learning_unit', {
            p_unit_id: id,
        });
        if (error) {
            alert('Não foi possível excluir a unidade: ' + error.message);
            return;
        }
        load();
    };

    // Drag-and-drop reordering das units
    const handleDragStart = (idx: number) => setDragIndex(idx);
    const handleDragOver = (e: React.DragEvent) => e.preventDefault();
    const handleDrop = async (targetIdx: number) => {
        if (frozen || dragIndex === null || dragIndex === targetIdx) return;
        const reordered = [...units];
        const [moved] = reordered.splice(dragIndex, 1);
        reordered.splice(targetIdx, 0, moved);
        setUnits(reordered);
        setDragIndex(null);

        try {
            const { error } = await supabase.rpc('reorder_learning_units', {
                p_path_id: pathId,
                p_unit_ids: reordered.map((unit) => unit.id),
            });
            if (error) throw error;
        } catch (err) {
            console.error('Reorder error:', err);
            alert('Não foi possível reorganizar as unidades. A ordem anterior foi restaurada.');
            load();
        }
    };

    if (!path) return <Loader />;

    return (
        <div className="space-y-4">
            {editing ? (
                <PathForm initial={path} onSubmit={savePath} onCancel={() => setEditing(false)} />
            ) : (
                <div className="rounded-2xl bg-brand-surface-2 p-4 sm:p-5">
                    <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                                <span className="text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-violet-100 text-brand-accent dark:bg-violet-900/30 dark:text-violet-300">{path.target_level}</span>
                                <span className="text-[9px] font-bold uppercase tracking-widest text-slate-500">{CATEGORIES.find(c => c.id === path.category)?.label}</span>
                                <span className="text-[9px] text-slate-400">~{path.estimated_hours}h</span>
                            </div>
                            <h4 className="text-xl font-black text-brand-text">{path.name}</h4>
                            <p className="mt-1 text-sm text-brand-muted">{path.description}</p>
                        </div>
                        <div className="flex flex-col items-end gap-2 shrink-0">
                            <button
                                onClick={() => setAssigning(true)}
                                className="text-xs font-black uppercase tracking-widest text-white bg-brand-accent dark:text-brand-bg px-3 py-1.5 rounded-lg hover:brightness-110 flex items-center gap-1"
                            >
                                <UserPlus size={12} /> Atribuir
                            </button>
                            {path.tenant_id && !frozen && (
                                <button onClick={() => setEditing(true)} className="text-xs text-brand-accent hover:underline flex items-center gap-1"><Edit2 size={12} /> Editar</button>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {assigning && (
                <PathAssignmentModal
                    path={path}
                    user={user}
                    tenantId={tenantId}
                    onClose={() => setAssigning(false)}
                />
            )}

            {frozen && (
                <div className="flex items-start gap-3 rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sky-950 dark:border-sky-900/50 dark:bg-sky-950/25 dark:text-sky-100" role="status">
                    <Archive size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
                    <div>
                        <p className="text-xs font-black">Conteúdo preservado como histórico acadêmico</p>
                        <p className="mt-1 text-[11px] leading-relaxed opacity-80">Esta trilha já foi atribuída. Você pode consultá-la e atribuí-la a novos alunos, mas unidades e atividades não podem mais ser alteradas.</p>
                    </div>
                </div>
            )}

            <div className="flex items-center justify-between">
                <p className="text-sm font-black text-brand-text">Unidades <span className="font-bold text-brand-muted">{units.length}</span></p>
                {!frozen && (
                    <button onClick={() => setCreatingUnit(true)} className="flex items-center gap-2 px-3 py-1.5 bg-brand-accent dark:text-brand-bg text-white text-xs font-black uppercase tracking-widest rounded-lg hover:brightness-110">
                        <Plus size={12} /> Nova Unit
                    </button>
                )}
            </div>

            {creatingUnit && <UnitForm onSubmit={createUnit} onCancel={() => setCreatingUnit(false)} />}

            {/* Unidades como linha do tempo: a ordem é a ordem em que o aluno percorre a trilha */}
            {units.length === 0 && !creatingUnit && (
                <div className="rounded-2xl border border-dashed border-brand-border py-10 text-center text-sm text-brand-muted">
                    Nenhuma unidade ainda.
                </div>
            )}
            <ol data-tour="paths-units-timeline" className="relative space-y-3 before:absolute before:bottom-6 before:left-[27px] before:top-6 before:w-0.5 before:bg-brand-border">
                {units.map((u, i) => (
                    <li
                        key={u.id}
                        draggable={!frozen}
                        onDragStart={frozen ? undefined : () => handleDragStart(i)}
                        onDragOver={frozen ? undefined : handleDragOver}
                        onDrop={frozen ? undefined : () => handleDrop(i)}
                        className={`relative flex items-center gap-3 rounded-2xl border bg-brand-surface p-3 transition-all ${
                            dragIndex === i ? 'opacity-40' : 'border-brand-border hover:border-brand-accent/40 hover:shadow-sm'
                        }`}
                    >
                        <div className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-accent text-sm font-black text-white ring-4 ring-brand-surface dark:text-brand-bg">{i + 1}</div>
                        <div className="min-w-0 flex-1">
                            <p className="text-sm font-black text-brand-text">{u.title}</p>
                            <p className="truncate text-xs text-brand-muted">{u.description}</p>
                            {(u.estimated_minutes || (Array.isArray(u.skill_focus) && u.skill_focus.length > 0)) && (
                                <div className="mt-1.5 flex flex-wrap gap-1">
                                    {u.estimated_minutes ? <span className="rounded-full bg-brand-surface-2 px-2 py-0.5 text-[10px] font-bold text-brand-muted">{u.estimated_minutes} min</span> : null}
                                    {Array.isArray(u.skill_focus) && u.skill_focus.slice(0, 3).map((skill: string) => (
                                        <span key={skill} className="rounded-full bg-brand-accent/10 px-2 py-0.5 text-[10px] font-bold text-brand-accent">{skill}</span>
                                    ))}
                                </div>
                            )}
                        </div>
                        <button onClick={() => onOpenUnit(u.id)} className="flex shrink-0 items-center gap-1 rounded-xl bg-brand-surface-2 px-3 py-2 text-xs font-bold text-brand-text hover:bg-brand-accent hover:text-white dark:hover:text-brand-bg">
                            Atividades <ChevronRight size={12} />
                        </button>
                        {!frozen && (
                            <>
                                <GripVertical size={14} className="hidden shrink-0 cursor-grab text-brand-muted active:cursor-grabbing sm:block" aria-label="Arrastar para reordenar" />
                                <button onClick={() => deleteUnit(u.id)} className="shrink-0 rounded-lg p-1.5 text-rose-500 hover:bg-rose-500/10" aria-label={`Excluir ${u.title}`}><Trash2 size={14} /></button>
                            </>
                        )}
                    </li>
                ))}
            </ol>
        </div>
    );
};

const UnitForm: React.FC<{ initial?: any; onSubmit: (form: any) => void; onCancel: () => void }> = ({ initial, onSubmit, onCancel }) => {
    const [form, setForm] = useState({
        title: initial?.title || '',
        description: initial?.description || '',
        estimated_minutes: initial?.estimated_minutes || 30,
        skill_focus: (initial?.skill_focus || []).join(', '),
    });
    return (
        <div className="bg-violet-50 dark:bg-violet-900/10 border border-violet-100 dark:border-violet-800/30 rounded-2xl p-4 space-y-3">
            <Input label="Título" value={form.title} onChange={v => setForm({ ...form, title: v })} placeholder="Ex: Opening a Meeting" />
            <Input label="Descrição" value={form.description} onChange={v => setForm({ ...form, description: v })} multiline />
            <div className="grid grid-cols-2 gap-3">
                <Input label="Minutos estimados" type="number" value={String(form.estimated_minutes)} onChange={v => setForm({ ...form, estimated_minutes: v })} />
                <Input label="Skills (csv)" value={form.skill_focus} onChange={v => setForm({ ...form, skill_focus: v })} placeholder="grammar, speaking" />
            </div>
            <div className="flex gap-2 justify-end">
                <button onClick={onCancel} className="text-xs font-bold text-slate-500 px-3 py-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg">Cancelar</button>
                <button onClick={() => onSubmit(form)} disabled={!form.title} className="text-xs font-black uppercase tracking-widest text-white bg-brand-accent dark:text-brand-bg px-4 py-2 rounded-lg hover:brightness-110 disabled:opacity-50 flex items-center gap-2"><Save size={12} /> Salvar</button>
            </div>
        </div>
    );
};

// ─────────────────────────────────────────────────────────────
// DETALHE DE UNIT (lista atividades + criar)
// ─────────────────────────────────────────────────────────────
const UnitDetail: React.FC<{ unitId: string; user: any; tenantId?: string; onOpenActivity: (id: string) => void; onBack: () => void }> = ({ unitId, user, tenantId, onOpenActivity, onBack }) => {
    const [unit, setUnit] = useState<any>(null);
    const [path, setPath] = useState<any>(null);
    const [activities, setActivities] = useState<any[]>([]);
    const [creating, setCreating] = useState(false);
    const [creatingType, setCreatingType] = useState<string>('vocab_cards');
    const [dragIndex, setDragIndex] = useState<number | null>(null);
    const [frozen, setFrozen] = useState(true);

    const handleDragStart = (idx: number) => setDragIndex(idx);
    const handleDragOver = (e: React.DragEvent) => e.preventDefault();
    const handleDrop = async (targetIdx: number) => {
        if (frozen || dragIndex === null || dragIndex === targetIdx) return;
        const reordered = [...activities];
        const [moved] = reordered.splice(dragIndex, 1);
        reordered.splice(targetIdx, 0, moved);
        setActivities(reordered);
        setDragIndex(null);
        try {
            const { error } = await supabase.rpc('reorder_unit_activities', {
                p_unit_id: unitId,
                p_activity_ids: reordered.map((activity) => activity.id),
            });
            if (error) throw error;
        } catch (err) {
            console.error('Reorder activities error:', err);
            alert('Não foi possível reorganizar as atividades. A ordem anterior foi restaurada.');
            load();
        }
    };

    useEffect(() => { load(); }, [unitId]);

    const load = async () => {
        const { data: unitData } = await supabase.from('learning_units').select('*, learning_paths(*)').eq('id', unitId).single();
        setUnit(unitData);
        setPath((unitData as any)?.learning_paths);
        const { data: actsData } = await supabase.from('unit_activities').select('*').eq('unit_id', unitId).order('order_index');
        setActivities(actsData || []);
        const pathId = (unitData as any)?.learning_paths?.id;
        if (!pathId) {
            setFrozen(true);
            return;
        }
        const { data: enrollments, error: enrollmentError } = await supabase
            .from('student_path_enrollments')
            .select('id')
            .eq('path_id', pathId)
            .limit(1);
        if (enrollmentError) console.error('Learning unit freeze state error:', enrollmentError);
        setFrozen(Boolean(enrollmentError || enrollments?.length));
    };

    const createActivity = async (form: { title: string; description: string; type: string; xp_reward: number; estimated_minutes: number; content: any }) => {
        if (frozen) return;
        const nextOrder = activities.length > 0 ? Math.max(...activities.map(a => a.order_index)) + 1 : 1;
        const { data, error } = await supabase.from('unit_activities').insert({
            unit_id: unitId,
            order_index: nextOrder,
            type: form.type,
            title: form.title,
            description: form.description,
            content: form.content || {},
            xp_reward: form.xp_reward,
            estimated_minutes: form.estimated_minutes,
        }).select('id').single();
        if (error) {
            alert('Erro: ' + error.message);
            return;
        }
        setCreating(false);
        load();
        if (data?.id) onOpenActivity(data.id);
    };

    const deleteActivity = async (id: string) => {
        if (frozen) return;
        if (!confirm('Excluir esta atividade?')) return;
        const { error } = await supabase.rpc('delete_unit_activity', {
            p_activity_id: id,
        });
        if (error) {
            alert('Não foi possível excluir a atividade: ' + error.message);
            return;
        }
        load();
    };

    if (!unit) return <Loader />;

    return (
        <div className="space-y-4">
            <div className="rounded-2xl bg-brand-surface-2 p-4 sm:p-5">
                <button onClick={onBack} className="text-xs font-bold text-slate-500 hover:text-slate-800 dark:hover:text-white flex items-center gap-1 mb-2">
                    <ChevronLeft size={12} /> Voltar para a trilha
                </button>
                <h4 className="text-xl font-black text-brand-text">{unit.title}</h4>
                <p className="mt-1 text-sm text-brand-muted">{unit.description}</p>
                {path && <p className="text-[10px] uppercase tracking-widest text-slate-400 mt-2">{path.name} · {path.target_level}</p>}
            </div>

            {frozen && (
                <div className="flex items-start gap-3 rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sky-950 dark:border-sky-900/50 dark:bg-sky-950/25 dark:text-sky-100" role="status">
                    <Archive size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
                    <div>
                        <p className="text-xs font-black">Unidade em modo de consulta</p>
                        <p className="mt-1 text-[11px] opacity-80">O conteúdo permanece exatamente como foi atribuído aos alunos.</p>
                    </div>
                </div>
            )}

            <div className="flex items-center justify-between">
                <p className="text-sm font-black text-brand-text">Atividades <span className="font-bold text-brand-muted">{activities.length}</span></p>
                {!frozen && (
                    <button onClick={() => setCreating(true)} className="flex items-center gap-2 px-3 py-1.5 bg-brand-accent dark:text-brand-bg text-white text-xs font-black uppercase tracking-widest rounded-lg hover:brightness-110">
                        <Plus size={12} /> Nova Atividade
                    </button>
                )}
            </div>

            {creating && (
                <NewActivityWizard
                    unit={unit}
                    path={path}
                    onCancel={() => setCreating(false)}
                    onCreate={createActivity}
                />
            )}

            <div className="space-y-2">
                {activities.map((a, i) => {
                    const meta = ACTIVITY_TYPES.find(t => t.id === a.type);
                    const Icon = meta?.icon || BookOpen;
                    return (
                        <div
                            key={a.id}
                            draggable={!frozen}
                            onDragStart={frozen ? undefined : () => handleDragStart(i)}
                            onDragOver={frozen ? undefined : handleDragOver}
                            onDrop={frozen ? undefined : () => handleDrop(i)}
                            className={`flex items-center gap-3 rounded-2xl border bg-brand-surface p-3 transition-all ${
                                dragIndex === i ? 'opacity-40' : 'border-brand-border hover:border-brand-accent/40 hover:shadow-sm'
                            }`}
                        >
                            <GripVertical size={14} className={`shrink-0 text-slate-300 ${frozen ? 'opacity-40' : 'cursor-grab active:cursor-grabbing'}`} />
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-accent/10 text-brand-accent">
                                <Icon size={14} />
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                    <p className="text-sm font-black text-brand-text">{a.title}</p>
                                    <span className="text-[9px] font-bold uppercase tracking-widest text-slate-400">{meta?.label}</span>
                                </div>
                                <p className="text-[10px] text-slate-400 mt-0.5">{a.estimated_minutes}min · {a.xp_reward} XP</p>
                            </div>
                            <button onClick={() => onOpenActivity(a.id)} className="text-xs font-bold text-brand-accent hover:underline flex items-center gap-1">
                                {frozen ? 'Visualizar' : 'Editar'} <ChevronRight size={12} />
                            </button>
                            {!frozen && <button onClick={() => deleteActivity(a.id)} className="text-rose-500 hover:text-rose-700 p-1"><Trash2 size={14} /></button>}
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

// ─────────────────────────────────────────────────────────────
// WIZARD: NOVA ATIVIDADE
// ─────────────────────────────────────────────────────────────
const NewActivityWizard: React.FC<{ unit: any; path: any; onCancel: () => void; onCreate: (form: any) => void }> = ({ unit, path, onCancel, onCreate }) => {
    const [type, setType] = useState<string>('vocab_cards');
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [xpReward, setXpReward] = useState(40);
    const [estimatedMin, setEstimatedMin] = useState(5);
    const [content, setContent] = useState<any>({});
    const [contentJson, setContentJson] = useState('{}');
    const [generating, setGenerating] = useState(false);

    const handleAIGenerate = async () => {
        if (!path) return;
        setGenerating(true);
        try {
            const result = await generateUnitActivityContent({
                activityType: type as any,
                unitTitle: unit.title,
                unitDescription: unit.description,
                targetLevel: path.target_level,
                category: path.category,
                extraInstructions: description,
            });
            setContent(result);
            setContentJson(JSON.stringify(result, null, 2));
            if (!title) {
                const defaults: Record<string, string> = {
                    vocab_cards: `Vocabulary: ${unit.title}`,
                    quiz: `Quiz: ${unit.title}`,
                    grammar_drill: `Grammar: ${unit.title}`,
                    reading: `Reading: ${unit.title}`,
                    speaking_wolfie: `Practice: ${unit.title}`,
                };
                setTitle(defaults[type] || unit.title);
            }
        } catch (err: any) {
            alert('Erro ao gerar com IA: ' + (err.message || 'Tente novamente.'));
        } finally {
            setGenerating(false);
        }
    };

    const submit = () => {
        let parsedContent: any = {};
        try {
            parsedContent = JSON.parse(contentJson);
        } catch {
            alert('JSON inválido. Verifique antes de salvar ou use Gerar com IA.');
            return;
        }
        onCreate({
            title,
            description,
            type,
            xp_reward: xpReward,
            estimated_minutes: estimatedMin,
            content: parsedContent,
        });
    };

    return (
        <div className="bg-violet-50 dark:bg-violet-900/10 border border-violet-100 dark:border-violet-800/30 rounded-2xl p-4 space-y-3">
            <div>
                <p className="text-[10px] uppercase tracking-widest text-slate-500 font-bold mb-2">Tipo</p>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                    {ACTIVITY_TYPES.map(t => {
                        const Icon = t.icon;
                        const active = type === t.id;
                        return (
                            <button
                                key={t.id}
                                onClick={() => setType(t.id)}
                                className={`p-2 rounded-xl border-2 text-[10px] font-bold transition-all flex flex-col items-center gap-1 ${active ? 'border-violet-500 bg-violet-100 dark:bg-violet-900/30 text-violet-700' : 'border-slate-200 dark:border-slate-700 text-slate-500 hover:border-violet-300'}`}
                            >
                                <Icon size={14} />
                                <span>{t.label}</span>
                            </button>
                        );
                    })}
                </div>
            </div>

            <Input label="Título" value={title} onChange={setTitle} placeholder="Como o aluno verá esta atividade" />
            <Input label="Descrição (briefing)" value={description} onChange={setDescription} placeholder="O que o aluno vai praticar / instruções para a IA" multiline />

            <div className="grid grid-cols-2 gap-3">
                <Input label="XP de recompensa" type="number" value={String(xpReward)} onChange={v => setXpReward(parseInt(v) || 0)} />
                <Input label="Minutos estimados" type="number" value={String(estimatedMin)} onChange={v => setEstimatedMin(parseInt(v) || 0)} />
            </div>

            <div className="bg-white dark:bg-slate-900 rounded-xl p-3 border border-slate-200 dark:border-slate-700">
                <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Conteúdo (JSON)</p>
                    <button
                        onClick={handleAIGenerate}
                        disabled={generating}
                        className="text-xs font-black uppercase tracking-widest text-white bg-linear-to-r from-violet-600 to-pink-600 px-3 py-1.5 rounded-lg hover:brightness-110 disabled:opacity-50 flex items-center gap-1"
                    >
                        {generating ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                        {generating ? 'Gerando...' : 'Gerar com IA'}
                    </button>
                </div>
                <textarea
                    value={contentJson}
                    onChange={e => setContentJson(e.target.value)}
                    rows={10}
                    className="w-full p-2 bg-slate-50 dark:bg-slate-800 rounded-lg text-xs font-mono text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 focus:outline-hidden focus:ring-2 focus:ring-violet-500"
                    placeholder="Use 'Gerar com IA' ou cole JSON manualmente."
                />
                <p className="text-[10px] text-slate-400 mt-1">Schema varia por tipo. Use "Gerar com IA" para preencher automaticamente.</p>
            </div>

            <div className="flex gap-2 justify-end">
                <button onClick={onCancel} className="text-xs font-bold text-slate-500 px-3 py-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg">Cancelar</button>
                <button onClick={submit} disabled={!title} className="text-xs font-black uppercase tracking-widest text-white bg-brand-accent dark:text-brand-bg px-4 py-2 rounded-lg hover:brightness-110 disabled:opacity-50 flex items-center gap-2"><Save size={12} /> Criar Atividade</button>
            </div>
        </div>
    );
};

// ─────────────────────────────────────────────────────────────
// DETALHE DE ATIVIDADE (editar conteúdo)
// ─────────────────────────────────────────────────────────────
const ActivityDetail: React.FC<{ activityId: string; unitId: string; onBack: () => void }> = ({ activityId, unitId, onBack }) => {
    const [activity, setActivity] = useState<any>(null);
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [xpReward, setXpReward] = useState(40);
    const [estimatedMin, setEstimatedMin] = useState(5);
    const [contentJson, setContentJson] = useState('{}');
    const [saving, setSaving] = useState(false);
    const [generating, setGenerating] = useState(false);
    const [path, setPath] = useState<any>(null);
    const [unit, setUnit] = useState<any>(null);
    const [frozen, setFrozen] = useState(true);

    useEffect(() => { load(); }, [activityId]);

    const load = async () => {
        const { data } = await supabase.from('unit_activities').select('*, learning_units(*, learning_paths(*))').eq('id', activityId).single();
        if (data) {
            setActivity(data);
            setTitle(data.title);
            setDescription(data.description || '');
            setXpReward(data.xp_reward);
            setEstimatedMin(data.estimated_minutes);
            setContentJson(JSON.stringify(data.content || {}, null, 2));
            setUnit((data as any).learning_units);
            setPath((data as any).learning_units?.learning_paths);
            const pathId = (data as any).learning_units?.learning_paths?.id;
            if (!pathId) {
                setFrozen(true);
                return;
            }
            const { data: enrollments, error: enrollmentError } = await supabase
                .from('student_path_enrollments')
                .select('id')
                .eq('path_id', pathId)
                .limit(1);
            if (enrollmentError) console.error('Learning activity freeze state error:', enrollmentError);
            setFrozen(Boolean(enrollmentError || enrollments?.length));
        }
    };

    const save = async () => {
        if (frozen) return;
        let parsedContent: any = {};
        try {
            parsedContent = JSON.parse(contentJson);
        } catch {
            alert('JSON inválido.');
            return;
        }
        setSaving(true);
        const { error } = await supabase.rpc('update_unit_activity', {
            p_activity_id: activityId,
            p_payload: {
                title,
                description,
                xp_reward: xpReward,
                estimated_minutes: estimatedMin,
                content: parsedContent,
            },
        });
        setSaving(false);
        if (error) {
            alert('Não foi possível salvar a atividade: ' + error.message);
            return;
        }
        alert('Salvo com sucesso!');
    };

    const regenerate = async () => {
        if (frozen || !path || !unit || !activity) return;
        setGenerating(true);
        try {
            const result = await generateUnitActivityContent({
                activityType: activity.type,
                unitTitle: unit.title,
                unitDescription: unit.description,
                targetLevel: path.target_level,
                category: path.category,
                extraInstructions: description,
            });
            setContentJson(JSON.stringify(result, null, 2));
        } catch (err: any) {
            alert('Erro: ' + (err.message || 'Tente novamente'));
        } finally {
            setGenerating(false);
        }
    };

    if (!activity) return <Loader />;
    const meta = ACTIVITY_TYPES.find(t => t.id === activity.type);

    return (
        <div className="space-y-4">
            <button onClick={onBack} className="text-xs font-bold text-slate-500 hover:text-slate-800 dark:hover:text-white flex items-center gap-1">
                <ChevronLeft size={12} /> Voltar para a unit
            </button>

            <div className="flex items-center gap-2">
                <span className="text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-violet-100 text-brand-accent dark:bg-violet-900/30 dark:text-violet-300">{meta?.label}</span>
                {unit && <span className="text-[10px] text-slate-400">em {unit.title}</span>}
            </div>

            {frozen && (
                <div className="flex items-start gap-3 rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sky-950 dark:border-sky-900/50 dark:bg-sky-950/25 dark:text-sky-100" role="status">
                    <Archive size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
                    <div>
                        <p className="text-xs font-black">Atividade preservada</p>
                        <p className="mt-1 text-[11px] opacity-80">Como já há aluno vinculado à trilha, esta atividade está disponível somente para consulta.</p>
                    </div>
                </div>
            )}

            <Input label="Título" value={title} onChange={setTitle} disabled={frozen} />
            <Input label="Descrição" value={description} onChange={setDescription} multiline disabled={frozen} />
            <div className="grid grid-cols-2 gap-3">
                <Input label="XP" type="number" value={String(xpReward)} onChange={v => setXpReward(parseInt(v) || 0)} disabled={frozen} />
                <Input label="Minutos" type="number" value={String(estimatedMin)} onChange={v => setEstimatedMin(parseInt(v) || 0)} disabled={frozen} />
            </div>

            <div className="bg-white dark:bg-slate-900 rounded-xl p-3 border border-slate-200 dark:border-slate-700">
                <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Conteúdo (JSON)</p>
                    <button
                        onClick={regenerate}
                        disabled={generating || frozen}
                        className="text-xs font-black uppercase tracking-widest text-white bg-linear-to-r from-violet-600 to-pink-600 px-3 py-1.5 rounded-lg hover:brightness-110 disabled:opacity-50 flex items-center gap-1"
                    >
                        {generating ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                        {generating ? 'Gerando...' : 'Regerar com IA'}
                    </button>
                </div>
                <textarea
                    value={contentJson}
                    onChange={e => setContentJson(e.target.value)}
                    readOnly={frozen}
                    rows={16}
                    className="w-full p-2 bg-slate-50 dark:bg-slate-800 rounded-lg text-xs font-mono text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 focus:outline-hidden focus:ring-2 focus:ring-violet-500 read-only:cursor-default read-only:opacity-75"
                />
            </div>

            {!frozen && (
                <div className="flex gap-2 justify-end">
                    <button onClick={save} disabled={saving} className="text-xs font-black uppercase tracking-widest text-white bg-brand-accent dark:text-brand-bg px-4 py-2 rounded-lg hover:brightness-110 disabled:opacity-50 flex items-center gap-2">
                        {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Salvar Alterações
                    </button>
                </div>
            )}
        </div>
    );
};

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
const Loader = () => (
    <div className="flex items-center justify-center py-12">
        <Loader2 className="animate-spin text-violet-500" size={24} />
    </div>
);

const Input: React.FC<{ label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string; multiline?: boolean; disabled?: boolean }> = ({ label, value, onChange, placeholder, type = 'text', multiline, disabled = false }) => (
    <div>
        <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold block mb-1">{label}</label>
        {multiline ? (
            <textarea
                value={value}
                onChange={e => onChange(e.target.value)}
                placeholder={placeholder}
                disabled={disabled}
                rows={2}
                className="w-full p-2 bg-white dark:bg-slate-800 rounded-lg text-sm text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 focus:outline-hidden focus:ring-2 focus:ring-violet-500 disabled:cursor-default disabled:opacity-70"
            />
        ) : (
            <input
                type={type}
                value={value}
                onChange={e => onChange(e.target.value)}
                placeholder={placeholder}
                disabled={disabled}
                className="w-full p-2 bg-white dark:bg-slate-800 rounded-lg text-sm text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 focus:outline-hidden focus:ring-2 focus:ring-violet-500 disabled:cursor-default disabled:opacity-70"
            />
        )}
    </div>
);

const Select: React.FC<{ label: string; value: string; onChange: (v: string) => void; options: { id: string; label: string }[] }> = ({ label, value, onChange, options }) => (
    <div>
        <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold block mb-1">{label}</label>
        <select
            value={value}
            onChange={e => onChange(e.target.value)}
            className="w-full p-2 bg-white dark:bg-slate-800 rounded-lg text-sm text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 focus:outline-hidden focus:ring-2 focus:ring-violet-500"
        >
            {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
    </div>
);

export default LearningPathsBuilder;
