import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { Plus, Trash2, Video, FileText, Users, GraduationCap, Briefcase, Loader2, Save, X, Edit2, Eye, Link as LinkIcon } from 'lucide-react';

const AUDIENCE_OPTIONS = [
    { id: 'TEACHER', label: 'Professores', icon: Briefcase, color: 'emerald' },
    { id: 'STUDENT', label: 'Alunos', icon: GraduationCap, color: 'blue' },
    { id: 'SCHOOL_ADMIN', label: 'Administradores', icon: Users, color: 'violet' },
    { id: 'SALESPERSON', label: 'Vendedores', icon: Users, color: 'amber' },
];

const CATEGORIES = ['Metodologia', 'Boas-vindas', 'Vendas', 'Pedagógico', 'Plataforma', 'Outro'];

interface Module {
    id: string;
    title: string;
    description: string;
    video_url: string;
    pdf_url: string;
    thumbnail_url: string;
    category: string;
    is_mandatory: boolean;
    target_roles: string[];
    order_index: number;
    active: boolean;
    created_at: string;
}

interface Props {
    tenantId: string;
    currentUser?: any;
}

const TrainingAdmin: React.FC<Props> = ({ tenantId, currentUser }) => {
    const [modules, setModules] = useState<Module[]>([]);
    const [loading, setLoading] = useState(true);
    const [editing, setEditing] = useState<Module | null>(null);
    const [creating, setCreating] = useState(false);
    const [audienceFilter, setAudienceFilter] = useState<string>('ALL');

    useEffect(() => { load(); }, [tenantId]);

    const load = async () => {
        setLoading(true);
        const { data } = await supabase.from('training_modules')
            .select('*').eq('tenant_id', tenantId)
            .order('order_index').order('created_at', { ascending: false });
        setModules((data || []) as Module[]);
        setLoading(false);
    };

    const remove = async (id: string) => {
        if (!confirm('Excluir este módulo? Histórico de progresso será mantido.')) return;
        await supabase.from('training_modules').delete().eq('id', id);
        load();
    };

    const toggleActive = async (m: Module) => {
        await supabase.from('training_modules').update({ active: !m.active }).eq('id', m.id);
        load();
    };

    const save = async (form: any) => {
        const payload = {
            tenant_id: tenantId,
            title: form.title, description: form.description,
            video_url: form.video_url || null, pdf_url: form.pdf_url || null,
            thumbnail_url: form.thumbnail_url || null,
            category: form.category, is_mandatory: form.is_mandatory,
            target_roles: form.target_roles, order_index: parseInt(form.order_index) || 0,
            active: form.active, created_by: currentUser?.id,
            updated_at: new Date().toISOString(),
        };
        if (form.id) {
            await supabase.from('training_modules').update(payload).eq('id', form.id);
        } else {
            await supabase.from('training_modules').insert(payload);
        }
        setEditing(null); setCreating(false); load();
    };

    const filtered = audienceFilter === 'ALL'
        ? modules
        : modules.filter(m => m.target_roles?.includes(audienceFilter));

    if (loading) return <div className="p-12 flex items-center justify-center"><Loader2 className="animate-spin text-violet-500" size={24} /></div>;

    return (
        <div className="space-y-4">
            {/* Header */}
            <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 overflow-hidden">
                <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-violet-100 dark:bg-violet-900/30 rounded-xl flex items-center justify-center">
                            <GraduationCap size={20} className="text-violet-600" />
                        </div>
                        <div>
                            <h3 className="font-black text-slate-800 dark:text-white text-sm">Treinamentos</h3>
                            <p className="text-[10px] text-slate-400 uppercase tracking-widest">{modules.length} módulo{modules.length !== 1 ? 's' : ''}</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <select value={audienceFilter} onChange={e => setAudienceFilter(e.target.value)}
                            className="px-3 py-2 bg-slate-50 dark:bg-slate-800 rounded-xl text-xs font-bold border border-slate-200 dark:border-slate-700">
                            <option value="ALL">Todos públicos</option>
                            {AUDIENCE_OPTIONS.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
                        </select>
                        <button onClick={() => setCreating(true)} className="flex items-center gap-2 px-3 py-2 bg-violet-600 text-white text-xs font-black uppercase tracking-widest rounded-xl hover:brightness-110">
                            <Plus size={12} /> Novo módulo
                        </button>
                    </div>
                </div>

                <div className="p-6">
                    {filtered.length === 0 ? (
                        <div className="text-center py-12 text-slate-400">
                            <GraduationCap size={32} className="mx-auto mb-3 opacity-40" />
                            <p className="text-sm font-bold">Nenhum módulo {audienceFilter !== 'ALL' && 'para esse público'}</p>
                            <p className="text-xs mt-1">Crie o primeiro!</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            {filtered.map(m => (
                                <div key={m.id} className={`rounded-2xl border p-4 ${m.active ? 'border-slate-200 dark:border-slate-700' : 'border-slate-100 dark:border-slate-800 opacity-60'}`}>
                                    <div className="flex items-start justify-between gap-2 mb-2">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            {m.video_url && <Video size={14} className="text-blue-500" />}
                                            {m.pdf_url && <FileText size={14} className="text-rose-500" />}
                                            <span className="text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600">{m.category}</span>
                                            {m.is_mandatory && <span className="text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-amber-100 text-amber-600">Obrigatório</span>}
                                            {!m.active && <span className="text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-rose-100 text-rose-600">Inativo</span>}
                                        </div>
                                    </div>
                                    <p className="text-sm font-black text-slate-800 dark:text-white">{m.title}</p>
                                    <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2 mt-1">{m.description}</p>

                                    <div className="flex items-center flex-wrap gap-1.5 mt-3">
                                        <span className="text-[9px] uppercase tracking-widest text-slate-400 font-bold">Visível para:</span>
                                        {(m.target_roles || []).map(r => {
                                            const opt = AUDIENCE_OPTIONS.find(o => o.id === r);
                                            return (
                                                <span key={r} className={`text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded-full bg-${opt?.color || 'slate'}-100 text-${opt?.color || 'slate'}-600 dark:bg-${opt?.color || 'slate'}-900/30 dark:text-${opt?.color || 'slate'}-300`}>
                                                    {opt?.label || r}
                                                </span>
                                            );
                                        })}
                                    </div>

                                    <div className="flex items-center justify-end gap-2 mt-3">
                                        <button onClick={() => toggleActive(m)} className="text-[10px] text-slate-500 hover:text-violet-600 font-bold flex items-center gap-1">
                                            <Eye size={12} /> {m.active ? 'Desativar' : 'Reativar'}
                                        </button>
                                        <button onClick={() => setEditing(m)} className="text-[10px] text-violet-600 hover:text-violet-800 font-bold flex items-center gap-1">
                                            <Edit2 size={12} /> Editar
                                        </button>
                                        <button onClick={() => remove(m.id)} className="text-rose-500 hover:text-rose-700 p-1">
                                            <Trash2 size={12} />
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {(creating || editing) && (
                <ModuleForm initial={editing} onSave={save} onCancel={() => { setEditing(null); setCreating(false); }} tenantId={tenantId} />
            )}
        </div>
    );
};

// ─────────────────────────────────────────────────────────────
// FORM DE MÓDULO
// ─────────────────────────────────────────────────────────────
const ModuleForm: React.FC<{ initial: Module | null; onSave: (f: any) => void; onCancel: () => void; tenantId: string }> = ({ initial, onSave, onCancel, tenantId }) => {
    const [form, setForm] = useState<any>(initial || {
        title: '', description: '', video_url: '', pdf_url: '', thumbnail_url: '',
        category: 'Metodologia', is_mandatory: true,
        target_roles: ['TEACHER'], order_index: 0, active: true,
    });
    const [uploadingPdf, setUploadingPdf] = useState(false);
    const [pdfFile, setPdfFile] = useState<File | null>(null);

    const toggleRole = (role: string) => {
        setForm({
            ...form,
            target_roles: form.target_roles?.includes(role)
                ? form.target_roles.filter((r: string) => r !== role)
                : [...(form.target_roles || []), role]
        });
    };

    const uploadPdf = async () => {
        if (!pdfFile) return null;
        setUploadingPdf(true);
        try {
            const filename = `${tenantId}/${Date.now()}-${pdfFile.name.replace(/[^a-z0-9.-]/gi, '_')}`;
            const { error } = await supabase.storage.from('training_materials').upload(filename, pdfFile);
            if (error) throw error;
            const { data } = supabase.storage.from('training_materials').getPublicUrl(filename);
            return data.publicUrl;
        } finally { setUploadingPdf(false); }
    };

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!form.title) { alert('Título é obrigatório'); return; }
        if (!form.target_roles || form.target_roles.length === 0) {
            alert('Selecione pelo menos um público.'); return;
        }

        let pdfUrl = form.pdf_url;
        if (pdfFile) {
            const url = await uploadPdf();
            if (url) pdfUrl = url;
        }

        onSave({ ...form, pdf_url: pdfUrl });
    };

    return (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-sm z-[200] flex items-end sm:items-center justify-center p-0 sm:p-4">
            <form onSubmit={submit} className="bg-white dark:bg-slate-900 rounded-t-3xl sm:rounded-3xl max-w-2xl w-full max-h-[95vh] overflow-y-auto shadow-2xl">
                <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between sticky top-0 bg-white dark:bg-slate-900 z-10">
                    <h3 className="font-black text-slate-800 dark:text-white">{initial ? 'Editar módulo' : 'Novo módulo de treinamento'}</h3>
                    <button type="button" onClick={onCancel} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl"><X size={18} /></button>
                </div>

                <div className="p-6 space-y-4">
                    <Input label="Título *" value={form.title} onChange={v => setForm({ ...form, title: v })} placeholder="Ex: Boas-vindas Wise Wolf" />
                    <Input label="Descrição" value={form.description} onChange={v => setForm({ ...form, description: v })} placeholder="O que o usuário vai aprender" multiline />

                    {/* AUDIÊNCIA — A FEATURE QUE FALTAVA */}
                    <div>
                        <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold block mb-2">Quem pode ver este módulo? *</label>
                        <div className="grid grid-cols-2 gap-2">
                            {AUDIENCE_OPTIONS.map(a => {
                                const Icon = a.icon;
                                const selected = form.target_roles?.includes(a.id);
                                return (
                                    <button key={a.id} type="button" onClick={() => toggleRole(a.id)}
                                        className={`flex items-center gap-2 p-3 rounded-xl border-2 transition-all text-xs font-bold ${selected ? `border-${a.color}-500 bg-${a.color}-50 dark:bg-${a.color}-900/20 text-${a.color}-700 dark:text-${a.color}-300` : 'border-slate-200 dark:border-slate-700 text-slate-500 hover:border-slate-300'}`}>
                                        <Icon size={14} /> {a.label}
                                        {selected && <span className="ml-auto">✓</span>}
                                    </button>
                                );
                            })}
                        </div>
                        <p className="text-[10px] text-slate-400 mt-1.5">Clique em uma ou mais opções. Vazio = ninguém vê.</p>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                            <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold block mb-1">Categoria</label>
                            <select value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}
                                className="w-full p-2 bg-slate-50 dark:bg-slate-800 rounded-xl text-sm border border-slate-200 dark:border-slate-700">
                                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                            </select>
                        </div>
                        <Input label="Ordem (0 = topo)" type="number" value={String(form.order_index)} onChange={v => setForm({ ...form, order_index: v })} />
                    </div>

                    <Input label="URL do vídeo (YouTube/Vimeo/Meet)" value={form.video_url} onChange={v => setForm({ ...form, video_url: v })} placeholder="https://..." />
                    <Input label="URL da thumbnail (opcional)" value={form.thumbnail_url} onChange={v => setForm({ ...form, thumbnail_url: v })} placeholder="https://..." />

                    <div>
                        <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold block mb-1">PDF complementar (opcional)</label>
                        {form.pdf_url && (
                            <p className="text-xs mb-2"><a href={form.pdf_url} target="_blank" rel="noreferrer" className="text-violet-600 hover:underline flex items-center gap-1"><LinkIcon size={10} /> PDF atual</a></p>
                        )}
                        <input type="file" accept=".pdf" onChange={e => setPdfFile(e.target.files?.[0] || null)} className="text-xs" />
                    </div>

                    <div className="flex items-center gap-4">
                        <label className="flex items-center gap-2 text-xs font-bold text-slate-700 dark:text-slate-300">
                            <input type="checkbox" checked={form.is_mandatory} onChange={e => setForm({ ...form, is_mandatory: e.target.checked })} className="w-4 h-4 accent-violet-600" />
                            Obrigatório
                        </label>
                        <label className="flex items-center gap-2 text-xs font-bold text-slate-700 dark:text-slate-300">
                            <input type="checkbox" checked={form.active} onChange={e => setForm({ ...form, active: e.target.checked })} className="w-4 h-4 accent-violet-600" />
                            Ativo
                        </label>
                    </div>
                </div>

                <div className="p-6 border-t border-slate-100 dark:border-slate-800 flex justify-end gap-2 sticky bottom-0 bg-white dark:bg-slate-900">
                    <button type="button" onClick={onCancel} className="px-4 py-2 text-xs font-bold text-slate-500">Cancelar</button>
                    <button type="submit" disabled={uploadingPdf} className="px-4 py-2 bg-violet-600 text-white rounded-xl text-xs font-black uppercase tracking-widest hover:brightness-110 flex items-center gap-2 disabled:opacity-50">
                        {uploadingPdf ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                        Salvar
                    </button>
                </div>
            </form>
        </div>
    );
};

const Input: React.FC<{ label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string; multiline?: boolean }> = ({ label, value, onChange, placeholder, type = 'text', multiline }) => (
    <div>
        <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold block mb-1">{label}</label>
        {multiline ? (
            <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} rows={3}
                className="w-full p-2 bg-slate-50 dark:bg-slate-800 rounded-xl text-sm border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-violet-500" />
        ) : (
            <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
                className="w-full p-2 bg-slate-50 dark:bg-slate-800 rounded-xl text-sm border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-violet-500" />
        )}
    </div>
);

export default TrainingAdmin;
