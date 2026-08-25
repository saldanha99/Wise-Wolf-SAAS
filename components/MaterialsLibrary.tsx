import React, { useState, useMemo } from 'react';
import { Search, ChevronDown, ChevronRight, Trash2, FileText, Video, Link as LinkIcon, Music, Layers, Globe, Pencil, FolderTree, Book, Folder } from 'lucide-react';
import { openMaterialAccess } from '../services/materialAccessService';

// =============================================================
// Componente reutilizável de biblioteca de materiais pedagógicos.
// Usado no painel admin/professor (PedagogicalConfig) e na visão do aluno
// (StudentPedagogicalView).
//
// Dois modos de visualização:
//  - "Pastas" (árvore): Nicho > Nível > Livro > Partes — ativado quando a prop
//    `collections` é fornecida. É a forma de organizar livros fracionados.
//  - "Nível" / "Nicho" (lista plana): agrupamento simples, sempre disponível.
// =============================================================

export interface MaterialItem {
    id?: string;
    assignment_id?: string;
    title: string;
    type?: string;       // PDF | VIDEO | LINK | AUDIO ...
    level_tag?: string;  // A1..C2 | null
    niche?: string;      // chave do nicho (tenant_niches.key)
    file_url?: string;
    scope?: string;      // PRIVATE | PUBLIC
    assigned_at?: string;
    collection_id?: string | null; // livro a que pertence (null = avulso)
    part_number?: number | null;   // ordem da parte dentro do livro
}

export interface CollectionItem {
    id: string;
    title: string;
    niche?: string;
    level_tag?: string;
    cover_url?: string | null;
}

interface Props {
    materials: MaterialItem[];
    collections?: CollectionItem[];            // se fornecido, habilita o modo "Pastas"
    nicheLabels?: Record<string, string>;      // key -> rótulo (vem de list_niches)
    onDelete?: (id: string) => void;           // botão de excluir material (admin)
    onEdit?: (m: MaterialItem) => void;        // botão de editar material (admin)
    onEditCollection?: (c: CollectionItem) => void;   // editar livro (admin)
    onDeleteCollection?: (id: string) => void;        // excluir livro (admin)
    emptyText?: string;
    // Injeta outra forma de abrir o material. O sistema usa o acesso por storage
    // (padrão); o Hub passa a sua, que assina a URL após checar assinatura e
    // franquia. Sem isto, reaproveitar o módulo furaria o controle de acesso.
    onOpenMaterial?: (m: MaterialItem) => Promise<void> | void;
}

const LEVEL_ORDER = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const NO_LEVEL = 'Sem nível';

// Emoji/cor de fallback para os nichos base. Rótulos reais vêm de `nicheLabels`.
const NICHE_META: Record<string, { label: string; badge: string }> = {
    GENERAL: { label: '🌎 Geral', badge: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' },
    MEDICINE: { label: '🏥 Medicina', badge: 'bg-green-100 text-green-600 dark:bg-green-900/40 dark:text-green-300' },
    TECH: { label: '💻 Tech', badge: 'bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-300' },
    BUSINESS: { label: '💼 Business', badge: 'bg-purple-100 text-purple-600 dark:bg-purple-900/40 dark:text-purple-300' },
    TRAVEL: { label: '✈️ Viagem', badge: 'bg-orange-100 text-orange-600 dark:bg-orange-900/40 dark:text-orange-300' },
    KIDS: { label: '🧸 Crianças', badge: 'bg-pink-100 text-pink-600 dark:bg-pink-900/40 dark:text-pink-300' },
    TOEFL_IELTS: { label: '🎓 TOEFL/IELTS', badge: 'bg-indigo-100 text-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-300' },
    CONVERSATION: { label: '💬 Conversação', badge: 'bg-cyan-100 text-cyan-600 dark:bg-cyan-900/40 dark:text-cyan-300' },
};

const typeVisual = (type?: string) => {
    const t = (type || '').toUpperCase();
    if (t === 'PDF') return { Icon: FileText, color: 'bg-red-500' };
    if (t === 'VIDEO') return { Icon: Video, color: 'bg-blue-500' };
    if (t === 'AUDIO') return { Icon: Music, color: 'bg-emerald-500' };
    return { Icon: LinkIcon, color: 'bg-slate-500' };
};

const MaterialsLibrary: React.FC<Props> = ({
    materials, collections, nicheLabels, onDelete, onEdit, onEditCollection, onDeleteCollection,
    emptyText = 'Nenhum material disponível.',
    onOpenMaterial,
}) => {
    const hasFolders = Array.isArray(collections);
    const [search, setSearch] = useState('');
    const [groupBy, setGroupBy] = useState<'folder' | 'level' | 'niche'>(hasFolders ? 'folder' : 'level');
    const [typeFilter, setTypeFilter] = useState<string>('ALL');
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
    const [openingMaterialId, setOpeningMaterialId] = useState<string | null>(null);

    const openMaterial = async (material: MaterialItem) => {
        if (!onOpenMaterial && !material.file_url) return;
        const materialId = material.id || material.assignment_id || material.file_url;
        setOpeningMaterialId(materialId);
        try {
            if (onOpenMaterial) await onOpenMaterial(material);
            else await openMaterialAccess(material.file_url as string);
        } catch {
            alert('Não foi possível abrir este material. Confirme seu acesso e tente novamente.');
        } finally {
            setOpeningMaterialId(null);
        }
    };

    // Resolve o rótulo de um nicho: catálogo dinâmico > fallback base > a própria key.
    const nicheLabel = (key?: string) => {
        const k = key || 'GENERAL';
        return nicheLabels?.[k] || NICHE_META[k]?.label || k;
    };
    // Versão curta (sem emoji) para badges.
    const nicheBadgeLabel = (key?: string) => nicheLabel(key).replace(/^[^\s\w]+\s*/, '').trim() || (key || '');

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

    const toggle = (key: string) => setCollapsed(prev => ({ ...prev, [key]: !prev[key] }));
    const sortLevels = (a: string, b: string) => {
        const ia = LEVEL_ORDER.indexOf(a); const ib = LEVEL_ORDER.indexOf(b);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    };

    // ----- Card de material (parte ou avulso) -----
    const renderCard = (m: MaterialItem, opts?: { part?: boolean }) => {
        const { Icon, color } = typeVisual(m.type);
        const isNew = m.assigned_at && (Date.now() - new Date(m.assigned_at).getTime()) < 7 * 24 * 60 * 60 * 1000;
        return (
            <div key={m.id || m.assignment_id} className="p-3 rounded-xl border border-brand-border flex items-center justify-between hover:bg-brand-surface-2 dark:hover:bg-brand-surface-2/50 transition-all group">
                <button
                    type="button"
                    onClick={() => void openMaterial(m)}
                    disabled={(!onOpenMaterial && !m.file_url) || openingMaterialId === (m.id || m.assignment_id || m.file_url)}
                    className="flex items-center gap-3 min-w-0 flex-1 text-left disabled:opacity-60"
                >
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center text-white shadow-sm shrink-0 ${color}`}>
                        <Icon size={16} />
                    </div>
                    <div className="min-w-0">
                        <h4 className="font-bold text-sm text-brand-text truncate group-hover:text-tenant-primary transition-colors flex items-center gap-1.5">
                            {opts?.part && m.part_number != null && (
                                <span className="text-[9px] bg-tenant-primary/10 text-tenant-primary px-1.5 py-0.5 rounded font-black shrink-0">Parte {m.part_number}</span>
                            )}
                            {m.title}
                            {isNew && <span className="text-[8px] bg-emerald-500 text-white px-1.5 py-0.5 rounded-full uppercase font-black tracking-wider shrink-0 animate-pulse">Novo</span>}
                            {m.scope === 'PRIVATE' && <span className="text-[8px] bg-indigo-100 text-indigo-500 px-1 rounded uppercase shrink-0">Privado</span>}
                            {(m as any).approval_status === 'PENDING' && <span className="text-[8px] bg-amber-100 text-amber-600 px-1 rounded uppercase shrink-0">⏳ Em aprovação</span>}
                            {(m as any).approval_status === 'REJECTED' && <span className="text-[8px] bg-red-100 text-red-600 px-1 rounded uppercase shrink-0" title={(m as any).rejection_reason || ''}>Reprovado</span>}
                        </h4>
                        <div className="flex gap-1.5 mt-1 flex-wrap">
                            {m.level_tag && <span className="text-[9px] bg-brand-surface-2 dark:bg-slate-700 px-1.5 rounded uppercase font-black text-brand-muted">{m.level_tag}</span>}
                            {m.niche && m.niche !== 'GENERAL' && (
                                <span className={`text-[9px] px-1.5 rounded uppercase font-black ${NICHE_META[m.niche]?.badge || 'bg-brand-surface-2 text-brand-muted'}`}>
                                    {nicheBadgeLabel(m.niche)}
                                </span>
                            )}
                        </div>
                    </div>
                </button>
                {onEdit && m.id && (
                    <button onClick={(e) => { e.stopPropagation(); onEdit(m); }} className="p-2 text-brand-muted hover:text-tenant-primary transition-colors opacity-0 group-hover:opacity-100 shrink-0" title="Editar material">
                        <Pencil size={15} />
                    </button>
                )}
                {onDelete && m.id && (
                    <button onClick={() => onDelete(m.id!)} className="p-2 text-brand-muted hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100 shrink-0" title="Excluir material">
                        <Trash2 size={15} />
                    </button>
                )}
            </div>
        );
    };

    // ===================== MODO PASTAS (árvore) =====================
    const tree = useMemo(() => {
        if (!hasFolders) return [];
        const colById = new Map((collections || []).map(c => [c.id, c]));

        // niche -> level -> { collections: Map<colId,{col,parts}>, loose: [] }
        type LevelBucket = { collections: Map<string, { col: CollectionItem; parts: MaterialItem[] }>; loose: MaterialItem[] };
        const byNiche = new Map<string, Map<string, LevelBucket>>();

        const ensure = (niche: string, level: string): LevelBucket => {
            if (!byNiche.has(niche)) byNiche.set(niche, new Map());
            const lv = byNiche.get(niche)!;
            if (!lv.has(level)) lv.set(level, { collections: new Map(), loose: [] });
            return lv.get(level)!;
        };

        // 1. Cria os "slots" de cada livro na sua pasta (niche/level do livro).
        for (const c of collections || []) {
            const bucket = ensure(c.niche || 'GENERAL', c.level_tag || NO_LEVEL);
            bucket.collections.set(c.id, { col: c, parts: [] });
        }

        // 2. Distribui os materiais filtrados.
        for (const m of filtered) {
            if (m.collection_id && colById.has(m.collection_id)) {
                const c = colById.get(m.collection_id)!;
                const bucket = ensure(c.niche || 'GENERAL', c.level_tag || NO_LEVEL);
                bucket.collections.get(c.id)!.parts.push(m);
            } else {
                const bucket = ensure(m.niche || 'GENERAL', (m.level_tag && LEVEL_ORDER.includes(m.level_tag)) ? m.level_tag : NO_LEVEL);
                bucket.loose.push(m);
            }
        }

        // 3. Quando há busca/filtro de tipo, esconde pastas/livros que ficaram vazios.
        const hasQuery = search.trim() !== '' || typeFilter !== 'ALL';

        const nicheKeys = Array.from(byNiche.keys()).sort((a, b) =>
            a === 'GENERAL' ? -1 : b === 'GENERAL' ? 1 : nicheLabel(a).localeCompare(nicheLabel(b)));

        return nicheKeys.map(nk => {
            const levels = byNiche.get(nk)!;
            const levelKeys = Array.from(levels.keys()).sort((a, b) => {
                if (a === NO_LEVEL) return 1; if (b === NO_LEVEL) return -1;
                return sortLevels(a, b);
            });
            const levelNodes = levelKeys.map(lk => {
                const b = levels.get(lk)!;
                let cols = Array.from(b.collections.values())
                    .sort((x, y) => x.col.title.localeCompare(y.col.title));
                cols.forEach(c => c.parts.sort((p, q) => (p.part_number ?? 999) - (q.part_number ?? 999)));
                let loose = b.loose;
                if (hasQuery) cols = cols.filter(c => c.parts.length > 0);
                const count = cols.reduce((s, c) => s + c.parts.length, 0) + loose.length;
                return { key: `${nk}::${lk}`, level: lk, cols, loose, count };
            }).filter(ln => !hasQuery || ln.count > 0);
            const total = levelNodes.reduce((s, l) => s + l.count, 0);
            return { key: nk, label: nicheLabel(nk), levels: levelNodes, total };
        }).filter(n => !hasQuery || n.total > 0);
    }, [hasFolders, collections, filtered, search, typeFilter, nicheLabels]);

    // ===================== MODO LISTA PLANA (nível/nicho) =====================
    const flatGroups = useMemo(() => {
        const map = new Map<string, MaterialItem[]>();
        for (const m of filtered) {
            const key = groupBy === 'level'
                ? (m.level_tag && LEVEL_ORDER.includes(m.level_tag) ? m.level_tag : NO_LEVEL)
                : (m.niche || 'GENERAL');
            if (!map.has(key)) map.set(key, []);
            map.get(key)!.push(m);
        }
        const keys = Array.from(map.keys()).sort((a, b) =>
            groupBy === 'level' ? sortLevels(a, b) : nicheLabel(a).localeCompare(nicheLabel(b)));
        return keys.map(k => ({
            key: k,
            label: groupBy === 'niche' ? nicheLabel(k) : k,
            items: map.get(k)!,
        }));
    }, [filtered, groupBy, nicheLabels]);

    return (
        <div className="flex flex-col gap-4">
            {/* Barra de controles */}
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                <div className="relative flex-1">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted" />
                    <input
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Buscar material pelo título..."
                        className="w-full pl-9 pr-3 py-2.5 bg-brand-surface-2 dark:bg-slate-800 border border-brand-border rounded-xl text-sm font-medium text-brand-text outline-none focus:ring-2 focus:ring-tenant-primary"
                    />
                </div>
                <div className="flex bg-brand-surface-2 dark:bg-slate-800 p-1 rounded-xl shrink-0">
                    {hasFolders && (
                        <button onClick={() => setGroupBy('folder')}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all ${groupBy === 'folder' ? 'bg-brand-surface dark:bg-slate-700 shadow-sm text-tenant-primary' : 'text-brand-muted'}`}>
                            <FolderTree size={12} /> Pastas
                        </button>
                    )}
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

            {/* Chips de tipo */}
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

            {filtered.length === 0 ? (
                <div className="text-center py-12 border-2 border-dashed border-brand-border rounded-2xl">
                    <FileText className="mx-auto text-slate-300 mb-2" size={32} />
                    <p className="text-brand-muted text-xs font-bold">{search || typeFilter !== 'ALL' ? 'Nenhum material encontrado com esses filtros.' : emptyText}</p>
                </div>
            ) : groupBy === 'folder' && hasFolders ? (
                // -------- Árvore Nicho > Nível > Livro > Partes --------
                <div className="space-y-3">
                    {tree.map(niche => {
                        const nCollapsed = collapsed[niche.key];
                        return (
                            <div key={niche.key} className="border border-brand-border rounded-2xl overflow-hidden">
                                <button onClick={() => toggle(niche.key)}
                                    className="w-full flex items-center justify-between px-4 py-3 bg-brand-surface-2/50 dark:bg-slate-800/50 hover:bg-brand-surface-2 transition-colors">
                                    <div className="flex items-center gap-2">
                                        {nCollapsed ? <ChevronRight size={16} className="text-brand-muted" /> : <ChevronDown size={16} className="text-brand-muted" />}
                                        <Folder size={15} className="text-tenant-primary" />
                                        <span className="font-black text-sm text-brand-text uppercase tracking-wide">{niche.label}</span>
                                    </div>
                                    <span className="text-[10px] font-black text-brand-muted bg-brand-surface dark:bg-slate-700 px-2 py-0.5 rounded-full">{niche.total}</span>
                                </button>
                                {!nCollapsed && (
                                    <div className="p-3 space-y-2">
                                        {niche.levels.map(lv => {
                                            const lCollapsed = collapsed[lv.key];
                                            return (
                                                <div key={lv.key} className="border border-brand-border/60 rounded-xl overflow-hidden">
                                                    <button onClick={() => toggle(lv.key)}
                                                        className="w-full flex items-center justify-between px-3 py-2 bg-brand-surface-2/30 hover:bg-brand-surface-2 transition-colors">
                                                        <div className="flex items-center gap-2">
                                                            {lCollapsed ? <ChevronRight size={14} className="text-brand-muted" /> : <ChevronDown size={14} className="text-brand-muted" />}
                                                            <span className="text-[11px] font-black text-brand-text uppercase tracking-wide">📚 {lv.level}</span>
                                                        </div>
                                                        <span className="text-[9px] font-black text-brand-muted">{lv.count}</span>
                                                    </button>
                                                    {!lCollapsed && (
                                                        <div className="p-2 space-y-2">
                                                            {/* Livros */}
                                                            {lv.cols.map(({ col, parts }) => {
                                                                const cKey = `col::${col.id}`;
                                                                const cCollapsed = collapsed[cKey];
                                                                return (
                                                                    <div key={col.id} className="border border-brand-border rounded-lg overflow-hidden bg-brand-surface">
                                                                        <div className="w-full flex items-center justify-between px-3 py-2 bg-tenant-primary/5">
                                                                            <button onClick={() => toggle(cKey)} className="flex items-center gap-2 min-w-0 flex-1">
                                                                                {cCollapsed ? <ChevronRight size={13} className="text-brand-muted shrink-0" /> : <ChevronDown size={13} className="text-brand-muted shrink-0" />}
                                                                                <Book size={14} className="text-tenant-primary shrink-0" />
                                                                                <span className="text-xs font-black text-brand-text truncate">{col.title}</span>
                                                                                <span className="text-[9px] font-black text-brand-muted shrink-0">({parts.length})</span>
                                                                            </button>
                                                                            <div className="flex items-center gap-1 shrink-0">
                                                                                {onEditCollection && (
                                                                                    <button onClick={() => onEditCollection(col)} className="p-1.5 text-brand-muted hover:text-tenant-primary" title="Editar livro"><Pencil size={13} /></button>
                                                                                )}
                                                                                {onDeleteCollection && (
                                                                                    <button onClick={() => onDeleteCollection(col.id)} className="p-1.5 text-brand-muted hover:text-red-500" title="Excluir livro (as partes viram avulsas)"><Trash2 size={13} /></button>
                                                                                )}
                                                                            </div>
                                                                        </div>
                                                                        {!cCollapsed && (
                                                                            <div className="p-2 grid grid-cols-1 gap-2">
                                                                                {parts.length === 0
                                                                                    ? <p className="text-[10px] text-brand-muted px-2 py-1">Sem partes ainda. Adicione materiais a este livro.</p>
                                                                                    : parts.map(p => renderCard(p, { part: true }))}
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                );
                                                            })}
                                                            {/* Avulsos */}
                                                            {lv.loose.length > 0 && (
                                                                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                                                    {lv.loose.map(m => renderCard(m))}
                                                                </div>
                                                            )}
                                                        </div>
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
            ) : (
                // -------- Lista plana (nível/nicho) --------
                <div className="space-y-3">
                    {flatGroups.map(g => {
                        const isCollapsed = collapsed[g.key];
                        return (
                            <div key={g.key} className="border border-brand-border rounded-2xl overflow-hidden">
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
                                {!isCollapsed && (
                                    <div className="p-3 grid grid-cols-1 md:grid-cols-2 gap-2">
                                        {g.items.map(m => renderCard(m))}
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
