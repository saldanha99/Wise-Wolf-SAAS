import React, { useState, useMemo } from 'react';
import { Search, ChevronDown, ChevronRight, Trash2, FileText, Video, Link as LinkIcon, Music, Layers, Globe } from 'lucide-react';

// =============================================================
// Componente reutilizável de biblioteca de materiais pedagógicos.
// Usado no painel admin/professor (PedagogicalConfig) e na visão do aluno
// (StudentPedagogicalView). Oferece busca, agrupamento por Nível ou Nicho,
// filtro por tipo e seções colapsáveis — com cards padronizados.
// =============================================================

export interface MaterialItem {
    id?: string;
    assignment_id?: string;
    title: string;
    type?: string;       // PDF | VIDEO | LINK | AUDIO ...
    level_tag?: string;  // A1..C2 | null
    niche?: string;      // GENERAL | MEDICINE | TECH | BUSINESS | TRAVEL
    file_url?: string;
    scope?: string;      // PRIVATE | PUBLIC
    assigned_at?: string;
}

interface Props {
    materials: MaterialItem[];
    onDelete?: (id: string) => void; // se fornecido, mostra botão de excluir (admin)
    emptyText?: string;
}

const LEVEL_ORDER = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

const NICHE_META: Record<string, { label: string; badge: string }> = {
    GENERAL: { label: '🌎 Geral', badge: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' },
    MEDICINE: { label: '🏥 Medicina', badge: 'bg-green-100 text-green-600 dark:bg-green-900/40 dark:text-green-300' },
    TECH: { label: '💻 Tech', badge: 'bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-300' },
    BUSINESS: { label: '💼 Business', badge: 'bg-purple-100 text-purple-600 dark:bg-purple-900/40 dark:text-purple-300' },
    TRAVEL: { label: '✈️ Viagem', badge: 'bg-orange-100 text-orange-600 dark:bg-orange-900/40 dark:text-orange-300' },
    KIDS: { label: '🧸 Crianças', badge: 'bg-pink-100 text-pink-600 dark:bg-pink-900/40 dark:text-pink-300' },
};

const typeVisual = (type?: string) => {
    const t = (type || '').toUpperCase();
    if (t === 'PDF') return { Icon: FileText, color: 'bg-red-500' };
    if (t === 'VIDEO') return { Icon: Video, color: 'bg-blue-500' };
    if (t === 'AUDIO') return { Icon: Music, color: 'bg-emerald-500' };
    return { Icon: LinkIcon, color: 'bg-slate-500' };
};

const MaterialsLibrary: React.FC<Props> = ({ materials, onDelete, emptyText = 'Nenhum material disponível.' }) => {
    const [search, setSearch] = useState('');
    const [groupBy, setGroupBy] = useState<'level' | 'niche'>('level');
    const [typeFilter, setTypeFilter] = useState<string>('ALL');
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

    // Tipos presentes (para os chips de filtro)
    const availableTypes = useMemo(() => {
        const set = new Set<string>();
        materials.forEach(m => m.type && set.add(m.type.toUpperCase()));
        return Array.from(set);
    }, [materials]);

    // Aplica busca + filtro de tipo
    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        return materials.filter(m => {
            const matchesSearch = !q || (m.title || '').toLowerCase().includes(q);
            const matchesType = typeFilter === 'ALL' || (m.type || '').toUpperCase() === typeFilter;
            return matchesSearch && matchesType;
        });
    }, [materials, search, typeFilter]);

    // Agrupa por nível ou nicho
    const groups = useMemo(() => {
        const map = new Map<string, MaterialItem[]>();
        for (const m of filtered) {
            const key = groupBy === 'level'
                ? (m.level_tag && LEVEL_ORDER.includes(m.level_tag) ? m.level_tag : 'Geral')
                : (m.niche || 'GENERAL');
            if (!map.has(key)) map.set(key, []);
            map.get(key)!.push(m);
        }
        // Ordena as chaves
        const keys = Array.from(map.keys()).sort((a, b) => {
            if (groupBy === 'level') {
                const ia = LEVEL_ORDER.indexOf(a); const ib = LEVEL_ORDER.indexOf(b);
                return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
            }
            return a.localeCompare(b);
        });
        return keys.map(k => ({
            key: k,
            label: groupBy === 'niche' ? (NICHE_META[k]?.label || k) : k,
            items: map.get(k)!,
        }));
    }, [filtered, groupBy]);

    const toggle = (key: string) => setCollapsed(prev => ({ ...prev, [key]: !prev[key] }));

    return (
        <div className="flex flex-col gap-4">
            {/* Barra de controles: busca + agrupamento + filtro de tipo */}
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                {/* Busca */}
                <div className="relative flex-1">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted" />
                    <input
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Buscar material pelo título..."
                        className="w-full pl-9 pr-3 py-2.5 bg-brand-surface-2 dark:bg-slate-800 border border-brand-border rounded-xl text-sm font-medium text-brand-text outline-none focus:ring-2 focus:ring-tenant-primary"
                    />
                </div>
                {/* Toggle de agrupamento */}
                <div className="flex bg-brand-surface-2 dark:bg-slate-800 p-1 rounded-xl shrink-0">
                    <button onClick={() => setGroupBy('level')}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all ${groupBy === 'level' ? 'bg-brand-surface dark:bg-slate-700 shadow-sm text-tenant-primary' : 'text-brand-muted'}`}>
                        <Layers size={12} /> Nível
                    </button>
                    <button onClick={() => setGroupBy('niche')}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all ${groupBy === 'niche' ? 'bg-brand-surface dark:bg-slate-700 shadow-sm text-tenant-primary' : 'text-brand-muted'}`}>
                        <Globe size={12} /> Nicho
                    </button>
                </div>
            </div>

            {/* Chips de tipo (só se houver mais de um tipo) */}
            {availableTypes.length > 1 && (
                <div className="flex flex-wrap gap-1.5">
                    {['ALL', ...availableTypes].map(t => (
                        <button key={t} onClick={() => setTypeFilter(t)}
                            className={`px-2.5 py-1 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all border ${typeFilter === t ? 'bg-tenant-primary text-white border-tenant-primary' : 'bg-brand-surface-2 dark:bg-slate-800 text-brand-muted border-brand-border'}`}>
                            {t === 'ALL' ? 'Todos os tipos' : t}
                        </button>
                    ))}
                </div>
            )}

            {/* Grupos */}
            {filtered.length === 0 ? (
                <div className="text-center py-12 border-2 border-dashed border-brand-border rounded-2xl">
                    <FileText className="mx-auto text-slate-300 mb-2" size={32} />
                    <p className="text-brand-muted text-xs font-bold">{search || typeFilter !== 'ALL' ? 'Nenhum material encontrado com esses filtros.' : emptyText}</p>
                </div>
            ) : (
                <div className="space-y-3">
                    {groups.map(g => {
                        const isCollapsed = collapsed[g.key];
                        return (
                            <div key={g.key} className="border border-brand-border rounded-2xl overflow-hidden">
                                {/* Cabeçalho da seção */}
                                <button onClick={() => toggle(g.key)}
                                    className="w-full flex items-center justify-between px-4 py-3 bg-brand-surface-2/50 dark:bg-slate-800/50 hover:bg-brand-surface-2 transition-colors">
                                    <div className="flex items-center gap-2">
                                        {isCollapsed ? <ChevronRight size={16} className="text-brand-muted" /> : <ChevronDown size={16} className="text-brand-muted" />}
                                        <span className="font-black text-sm text-brand-text uppercase tracking-wide">{g.label}</span>
                                    </div>
                                    <span className="text-[10px] font-black text-brand-muted bg-brand-surface dark:bg-slate-700 px-2 py-0.5 rounded-full">
                                        {g.items.length} {g.items.length === 1 ? 'material' : 'materiais'}
                                    </span>
                                </button>

                                {/* Cards */}
                                {!isCollapsed && (
                                    <div className="p-3 grid grid-cols-1 md:grid-cols-2 gap-2">
                                        {g.items.map(m => {
                                            const { Icon, color } = typeVisual(m.type);
                                            // "Novo": atribuído nos últimos 7 dias (só aplica a materiais com assigned_at)
                                            const isNew = m.assigned_at
                                                && (Date.now() - new Date(m.assigned_at).getTime()) < 7 * 24 * 60 * 60 * 1000;
                                            return (
                                                <div key={m.id || m.assignment_id} className="p-3 rounded-xl border border-brand-border flex items-center justify-between hover:bg-brand-surface-2 dark:hover:bg-brand-surface-2/50 transition-all group">
                                                    <a href={m.file_url} target="_blank" rel="noreferrer" className="flex items-center gap-3 min-w-0 flex-1">
                                                        <div className={`w-10 h-10 rounded-lg flex items-center justify-center text-white shadow-sm shrink-0 ${color}`}>
                                                            <Icon size={16} />
                                                        </div>
                                                        <div className="min-w-0">
                                                            <h4 className="font-bold text-sm text-brand-text truncate group-hover:text-tenant-primary transition-colors flex items-center gap-1.5">
                                                                {m.title}
                                                                {isNew && <span className="text-[8px] bg-emerald-500 text-white px-1.5 py-0.5 rounded-full uppercase font-black tracking-wider shrink-0 animate-pulse">Novo</span>}
                                                                {m.scope === 'PRIVATE' && <span className="text-[8px] bg-indigo-100 text-indigo-500 px-1 rounded uppercase shrink-0">Privado</span>}
                                                            </h4>
                                                            <div className="flex gap-1.5 mt-1 flex-wrap">
                                                                {m.level_tag && <span className="text-[9px] bg-brand-surface-2 dark:bg-slate-700 px-1.5 rounded uppercase font-black text-brand-muted">{m.level_tag}</span>}
                                                                {m.niche && m.niche !== 'GENERAL' && (
                                                                    <span className={`text-[9px] px-1.5 rounded uppercase font-black ${NICHE_META[m.niche]?.badge || 'bg-brand-surface-2 text-brand-muted'}`}>
                                                                        {(NICHE_META[m.niche]?.label || m.niche).replace(/^[^\s]+\s/, '')}
                                                                    </span>
                                                                )}
                                                            </div>
                                                        </div>
                                                    </a>
                                                    {onDelete && m.id && (
                                                        <button onClick={() => onDelete(m.id!)} className="p-2 text-brand-muted hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100 shrink-0">
                                                            <Trash2 size={15} />
                                                        </button>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};

export default MaterialsLibrary;
