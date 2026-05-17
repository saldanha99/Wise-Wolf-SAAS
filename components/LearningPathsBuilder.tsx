import React, { useState, useEffect } from 'react';
import {
    Plus, Edit2, Trash2, Save, X, ChevronRight, ChevronLeft, Loader2, Sparkles,
    BookOpen, Briefcase, GraduationCap, Plane, Cpu, Heart, Globe, Target,
    Layers, FileText, Mic, HelpCircle, Pen, Check, GripVertical, UserPlus
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { generateUnitActivityContent } from '../services/geminiService';
import PathAssignmentModal from './PathAssignmentModal';

interface Props {
    user: { id: string; tenantId?: string; role: string };
    tenantId?: string;
}

const CATEGORIES = [
    { id: 'BUSINESS', label: 'Business', icon: Briefcase },
    { id: 'TOEFL_IELTS', label: 'TOEFL/IELTS', icon: GraduationCap },
    { id: 'TRAVEL', label: 'Viagem', icon: Plane },
    { id: 'KIDS', label: 'Crianças', icon: Heart },
    { id: 'TECH', label: 'Tecnologia', icon: Cpu },
    { id: 'GENERAL', label: 'Geral', icon: Globe },
    { id: 'CONVERSATION', label: 'Conversação', icon: Sparkles },
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
        <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 overflow-hidden">
            <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-violet-100 dark:bg-violet-900/30 rounded-xl flex items-center justify-center">
                        <Target size={20} className="text-violet-600 dark:text-violet-400" />
                    </div>
                    <div>
                        <h3 className="font-black text-slate-800 dark:text-white text-sm">Trilhas Didáticas</h3>
                        <p className="text-[10px] text-slate-400 uppercase tracking-widest">Builder pedagógico</p>
                    </div>
                </div>
                {view.type !== 'list' && (
                    <button
                        onClick={() => setView({ type: 'list' })}
                        className="text-xs font-bold text-slate-500 hover:text-slate-800 dark:hover:text-white flex items-center gap-1"
                    >
                        <ChevronLeft size={14} /> Voltar para lista
                    </button>
                )}
            </div>

            <div className="p-6">
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

    const deletePath = async (id: string) => {
        if (!confirm('Excluir esta trilha? Todas as units, atividades e progresso serão removidos.')) return;
        await supabase.from('learning_paths').delete().eq('id', id);
        onRefresh();
    };

    if (loading) return <Loader />;

    return (
        <div>
            <div className="flex items-center justify-between mb-4">
                <p className="text-xs font-bold text-slate-500 dark:text-slate-400">{paths.length} trilhas</p>
                <button
                    onClick={() => setCreating(true)}
                    className="flex items-center gap-2 px-4 py-2 bg-violet-600 text-white text-xs font-black uppercase tracking-widest rounded-xl hover:brightness-110"
                >
                    <Plus size={14} /> Nova Trilha
                </button>
            </div>

            {creating && <PathForm onSubmit={createPath} onCancel={() => setCreating(false)} />}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
                {paths.map(p => {
                    const meta = CATEGORIES.find(c => c.id === p.category) || CATEGORIES[5];
                    const Icon = meta.icon;
                    return (
                        <div key={p.id} className="rounded-2xl border border-slate-200 dark:border-slate-800 p-4 hover:border-violet-300 dark:hover:border-violet-700 transition-colors">
                            <div className="flex items-start justify-between gap-2 mb-2">
                                <div className="w-9 h-9 rounded-xl bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center">
                                    <Icon size={16} className="text-violet-600" />
                                </div>
                                <div className="flex items-center gap-1">
                                    {!p.tenant_id && <span className="text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-300">Global</span>}
                                    <span className="text-[9px] font-bold uppercase tracking-widest text-violet-500">{p.target_level}</span>
                                </div>
                            </div>
                            <p className="text-sm font-black text-slate-800 dark:text-white">{p.name}</p>
                            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 line-clamp-2 min-h-[2rem]">{p.description}</p>
                            <div className="flex items-center justify-between mt-3">
                                <button
                                    onClick={() => onOpen(p.id)}
                                    className="text-xs font-bold text-violet-600 hover:text-violet-800 flex items-center gap-1"
                                >
                                    Editar <ChevronRight size={12} />
                                </button>
                                {p.tenant_id && (
                                    <button
                                        onClick={() => deletePath(p.id)}
                                        className="text-xs text-rose-500 hover:text-rose-700"
                                        title="Excluir"
                                    >
                                        <Trash2 size={14} />
                                    </button>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
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
                <button onClick={() => onSubmit(form)} disabled={!form.name} className="text-xs font-black uppercase tracking-widest text-white bg-violet-600 px-4 py-2 rounded-lg hover:brightness-110 disabled:opacity-50 flex items-center gap-2">
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

    useEffect(() => { load(); }, [pathId]);

    const load = async () => {
        const { data: pathData } = await supabase.from('learning_paths').select('*').eq('id', pathId).single();
        setPath(pathData);
        const { data: unitsData } = await supabase.from('learning_units').select('*').eq('path_id', pathId).order('order_index');
        setUnits(unitsData || []);
    };

    const savePath = async (form: any) => {
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
        if (!confirm('Excluir esta unidade e suas atividades?')) return;
        await supabase.from('learning_units').delete().eq('id', id);
        load();
    };

    // Drag-and-drop reordering das units
    const handleDragStart = (idx: number) => setDragIndex(idx);
    const handleDragOver = (e: React.DragEvent) => e.preventDefault();
    const handleDrop = async (targetIdx: number) => {
        if (dragIndex === null || dragIndex === targetIdx) return;
        const reordered = [...units];
        const [moved] = reordered.splice(dragIndex, 1);
        reordered.splice(targetIdx, 0, moved);
        setUnits(reordered);
        setDragIndex(null);

        // Persistir novos order_index (1, 2, 3...)
        try {
            const updates = reordered.map((u, i) => supabase
                .from('learning_units')
                .update({ order_index: i + 1 })
                .eq('id', u.id));
            await Promise.all(updates);
        } catch (err) {
            console.error('Reorder error:', err);
            load(); // recarrega se falhar
        }
    };

    if (!path) return <Loader />;

    return (
        <div className="space-y-4">
            {editing ? (
                <PathForm initial={path} onSubmit={savePath} onCancel={() => setEditing(false)} />
            ) : (
                <div className="bg-slate-50 dark:bg-slate-800/50 rounded-2xl p-4">
                    <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                                <span className="text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-violet-100 text-violet-600 dark:bg-violet-900/30 dark:text-violet-300">{path.target_level}</span>
                                <span className="text-[9px] font-bold uppercase tracking-widest text-slate-500">{CATEGORIES.find(c => c.id === path.category)?.label}</span>
                                <span className="text-[9px] text-slate-400">~{path.estimated_hours}h</span>
                            </div>
                            <h4 className="text-lg font-black text-slate-800 dark:text-white">{path.name}</h4>
                            <p className="text-xs text-slate-500 mt-1">{path.description}</p>
                        </div>
                        <div className="flex flex-col items-end gap-2 shrink-0">
                            <button
                                onClick={() => setAssigning(true)}
                                className="text-xs font-black uppercase tracking-widest text-white bg-violet-600 px-3 py-1.5 rounded-lg hover:brightness-110 flex items-center gap-1"
                            >
                                <UserPlus size={12} /> Atribuir
                            </button>
                            {path.tenant_id && (
                                <button onClick={() => setEditing(true)} className="text-xs text-violet-600 hover:text-violet-800 flex items-center gap-1"><Edit2 size={12} /> Editar</button>
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

            <div className="flex items-center justify-between">
                <p className="text-xs font-bold text-slate-500 dark:text-slate-400">Unidades ({units.length})</p>
                <button onClick={() => setCreatingUnit(true)} className="flex items-center gap-2 px-3 py-1.5 bg-violet-600 text-white text-xs font-black uppercase tracking-widest rounded-lg hover:brightness-110">
                    <Plus size={12} /> Nova Unit
                </button>
            </div>

            {creatingUnit && <UnitForm onSubmit={createUnit} onCancel={() => setCreatingUnit(false)} />}

            <div className="space-y-2">
                {units.map((u, i) => (
                    <div
                        key={u.id}
                        draggable
                        onDragStart={() => handleDragStart(i)}
                        onDragOver={handleDragOver}
                        onDrop={() => handleDrop(i)}
                        className={`flex items-center gap-3 p-3 rounded-xl border bg-white dark:bg-slate-900 transition-all ${
                            dragIndex === i ? 'opacity-40' : 'border-slate-200 dark:border-slate-800 hover:border-violet-300 dark:hover:border-violet-700'
                        }`}
                    >
                        <GripVertical size={14} className="text-slate-300 cursor-grab active:cursor-grabbing shrink-0" />
                        <div className="w-8 h-8 rounded-lg bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center text-violet-600 font-black text-sm shrink-0">{i + 1}</div>
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-black text-slate-800 dark:text-white">{u.title}</p>
                            <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{u.description}</p>
                        </div>
                        <button onClick={() => onOpenUnit(u.id)} className="text-xs font-bold text-violet-600 hover:text-violet-800 flex items-center gap-1">
                            Atividades <ChevronRight size={12} />
                        </button>
                        <button onClick={() => deleteUnit(u.id)} className="text-rose-500 hover:text-rose-700 p-1"><Trash2 size={14} /></button>
                    </div>
                ))}
            </div>
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
                <button onClick={() => onSubmit(form)} disabled={!form.title} className="text-xs font-black uppercase tracking-widest text-white bg-violet-600 px-4 py-2 rounded-lg hover:brightness-110 disabled:opacity-50 flex items-center gap-2"><Save size={12} /> Salvar</button>
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

    const handleDragStart = (idx: number) => setDragIndex(idx);
    const handleDragOver = (e: React.DragEvent) => e.preventDefault();
    const handleDrop = async (targetIdx: number) => {
        if (dragIndex === null || dragIndex === targetIdx) return;
        const reordered = [...activities];
        const [moved] = reordered.splice(dragIndex, 1);
        reordered.splice(targetIdx, 0, moved);
        setActivities(reordered);
        setDragIndex(null);
        try {
            await Promise.all(reordered.map((a, i) => supabase
                .from('unit_activities')
                .update({ order_index: i + 1 })
                .eq('id', a.id)));
        } catch (err) {
            console.error('Reorder activities error:', err);
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
    };

    const createActivity = async (form: { title: string; description: string; type: string; xp_reward: number; estimated_minutes: number; content: any }) => {
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
        if (!confirm('Excluir esta atividade?')) return;
        await supabase.from('unit_activities').delete().eq('id', id);
        load();
    };

    if (!unit) return <Loader />;

    return (
        <div className="space-y-4">
            <div className="bg-slate-50 dark:bg-slate-800/50 rounded-2xl p-4">
                <button onClick={onBack} className="text-xs font-bold text-slate-500 hover:text-slate-800 dark:hover:text-white flex items-center gap-1 mb-2">
                    <ChevronLeft size={12} /> Voltar para a trilha
                </button>
                <h4 className="text-lg font-black text-slate-800 dark:text-white">{unit.title}</h4>
                <p className="text-xs text-slate-500 mt-1">{unit.description}</p>
                {path && <p className="text-[10px] uppercase tracking-widest text-slate-400 mt-2">{path.name} · {path.target_level}</p>}
            </div>

            <div className="flex items-center justify-between">
                <p className="text-xs font-bold text-slate-500 dark:text-slate-400">Atividades ({activities.length})</p>
                <button onClick={() => setCreating(true)} className="flex items-center gap-2 px-3 py-1.5 bg-violet-600 text-white text-xs font-black uppercase tracking-widest rounded-lg hover:brightness-110">
                    <Plus size={12} /> Nova Atividade
                </button>
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
                            draggable
                            onDragStart={() => handleDragStart(i)}
                            onDragOver={handleDragOver}
                            onDrop={() => handleDrop(i)}
                            className={`flex items-center gap-3 p-3 rounded-xl border bg-white dark:bg-slate-900 transition-all ${
                                dragIndex === i ? 'opacity-40' : 'border-slate-200 dark:border-slate-800 hover:border-violet-300 dark:hover:border-violet-700'
                            }`}
                        >
                            <GripVertical size={14} className="text-slate-300 cursor-grab active:cursor-grabbing shrink-0" />
                            <div className="w-8 h-8 rounded-lg bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center text-violet-600 shrink-0">
                                <Icon size={14} />
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                    <p className="text-sm font-black text-slate-800 dark:text-white">{a.title}</p>
                                    <span className="text-[9px] font-bold uppercase tracking-widest text-slate-400">{meta?.label}</span>
                                </div>
                                <p className="text-[10px] text-slate-400 mt-0.5">{a.estimated_minutes}min · {a.xp_reward} XP</p>
                            </div>
                            <button onClick={() => onOpenActivity(a.id)} className="text-xs font-bold text-violet-600 hover:text-violet-800 flex items-center gap-1">
                                Editar <ChevronRight size={12} />
                            </button>
                            <button onClick={() => deleteActivity(a.id)} className="text-rose-500 hover:text-rose-700 p-1"><Trash2 size={14} /></button>
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
                        className="text-xs font-black uppercase tracking-widest text-white bg-gradient-to-r from-violet-600 to-pink-600 px-3 py-1.5 rounded-lg hover:brightness-110 disabled:opacity-50 flex items-center gap-1"
                    >
                        {generating ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                        {generating ? 'Gerando...' : 'Gerar com IA'}
                    </button>
                </div>
                <textarea
                    value={contentJson}
                    onChange={e => setContentJson(e.target.value)}
                    rows={10}
                    className="w-full p-2 bg-slate-50 dark:bg-slate-800 rounded-lg text-xs font-mono text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-violet-500"
                    placeholder="Use 'Gerar com IA' ou cole JSON manualmente."
                />
                <p className="text-[10px] text-slate-400 mt-1">Schema varia por tipo. Use "Gerar com IA" para preencher automaticamente.</p>
            </div>

            <div className="flex gap-2 justify-end">
                <button onClick={onCancel} className="text-xs font-bold text-slate-500 px-3 py-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg">Cancelar</button>
                <button onClick={submit} disabled={!title} className="text-xs font-black uppercase tracking-widest text-white bg-violet-600 px-4 py-2 rounded-lg hover:brightness-110 disabled:opacity-50 flex items-center gap-2"><Save size={12} /> Criar Atividade</button>
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
        }
    };

    const save = async () => {
        let parsedContent: any = {};
        try {
            parsedContent = JSON.parse(contentJson);
        } catch {
            alert('JSON inválido.');
            return;
        }
        setSaving(true);
        await supabase.from('unit_activities').update({
            title,
            description,
            xp_reward: xpReward,
            estimated_minutes: estimatedMin,
            content: parsedContent,
        }).eq('id', activityId);
        setSaving(false);
        alert('Salvo com sucesso!');
    };

    const regenerate = async () => {
        if (!path || !unit || !activity) return;
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
                <span className="text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-violet-100 text-violet-600 dark:bg-violet-900/30 dark:text-violet-300">{meta?.label}</span>
                {unit && <span className="text-[10px] text-slate-400">em {unit.title}</span>}
            </div>

            <Input label="Título" value={title} onChange={setTitle} />
            <Input label="Descrição" value={description} onChange={setDescription} multiline />
            <div className="grid grid-cols-2 gap-3">
                <Input label="XP" type="number" value={String(xpReward)} onChange={v => setXpReward(parseInt(v) || 0)} />
                <Input label="Minutos" type="number" value={String(estimatedMin)} onChange={v => setEstimatedMin(parseInt(v) || 0)} />
            </div>

            <div className="bg-white dark:bg-slate-900 rounded-xl p-3 border border-slate-200 dark:border-slate-700">
                <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Conteúdo (JSON)</p>
                    <button
                        onClick={regenerate}
                        disabled={generating}
                        className="text-xs font-black uppercase tracking-widest text-white bg-gradient-to-r from-violet-600 to-pink-600 px-3 py-1.5 rounded-lg hover:brightness-110 disabled:opacity-50 flex items-center gap-1"
                    >
                        {generating ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                        {generating ? 'Gerando...' : 'Regerar com IA'}
                    </button>
                </div>
                <textarea
                    value={contentJson}
                    onChange={e => setContentJson(e.target.value)}
                    rows={16}
                    className="w-full p-2 bg-slate-50 dark:bg-slate-800 rounded-lg text-xs font-mono text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-violet-500"
                />
            </div>

            <div className="flex gap-2 justify-end">
                <button onClick={save} disabled={saving} className="text-xs font-black uppercase tracking-widest text-white bg-violet-600 px-4 py-2 rounded-lg hover:brightness-110 disabled:opacity-50 flex items-center gap-2">
                    {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Salvar Alterações
                </button>
            </div>
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

const Input: React.FC<{ label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string; multiline?: boolean }> = ({ label, value, onChange, placeholder, type = 'text', multiline }) => (
    <div>
        <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold block mb-1">{label}</label>
        {multiline ? (
            <textarea
                value={value}
                onChange={e => onChange(e.target.value)}
                placeholder={placeholder}
                rows={2}
                className="w-full p-2 bg-white dark:bg-slate-800 rounded-lg text-sm text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-violet-500"
            />
        ) : (
            <input
                type={type}
                value={value}
                onChange={e => onChange(e.target.value)}
                placeholder={placeholder}
                className="w-full p-2 bg-white dark:bg-slate-800 rounded-lg text-sm text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-violet-500"
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
            className="w-full p-2 bg-white dark:bg-slate-800 rounded-lg text-sm text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-violet-500"
        >
            {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
    </div>
);

export default LearningPathsBuilder;
