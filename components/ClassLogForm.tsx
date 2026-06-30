import React, { useState } from 'react';
import { Save, X, Search, RefreshCw, BookOpen, MessageCircle } from 'lucide-react';
import { PEDAGOGICAL_BOOKS } from '../constants';

export interface ClassLogItem {
    id: string | number;
    name: string;
    date: string;
    avatar?: string;
    level?: string;
    suggestedTopic?: string;
    suggestedMaterial?: string;
    suggestedMaterialUrl?: string; // Add URL for direct access
    type?: string;
    isLate?: boolean; // true = aula de dia anterior (atrasada)
    time?: string;     // horário HH:MM da aula
    phone?: string | null;    // telefone do aluno (para o botão "Avisar aluno")
    meetLink?: string | null; // link do Meet (do professor ou do aluno)
}

// Monta o link wa.me que abre o WhatsApp do professor já com a mensagem pronta
// de confirmação de aula + link do Meet. Disparo MANUAL (sem instância).
const buildAvisarAlunoLink = (item: ClassLogItem): string | null => {
    let phone = (item.phone || '').replace(/\D/g, '');
    if (phone.length === 10 || phone.length === 11) phone = '55' + phone;
    if (phone.length < 12) return null;
    const nome = (item.name || '').split(' ')[0];
    const quando = item.time ? `hoje às ${item.time}` : 'hoje';
    const linkMeet = item.meetLink ? `\n\nLink da aula: ${item.meetLink}` : '';
    const msg = `Oi ${nome}! 🐺 Aqui é a Wise Wolf.\n\nPassando pra confirmar que você tem aula ${quando}.${linkMeet}\n\nTe espero! 💜`;
    return `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
};

interface ClassLogFormProps {
    items: ClassLogItem[];
    onSave: (data: any) => void;
    onCancel?: () => void;
    title?: string;
    loading?: boolean;
}

const ClassLogForm: React.FC<ClassLogFormProps> = ({ items, onSave, onCancel, title, loading = false }) => {
    const [formData, setFormData] = useState<Record<string, any>>({});
    const [searchTerm, setSearchTerm] = useState('');

    const handleChange = (id: string | number, field: string, value: string) => {
        setFormData(prev => ({
            ...prev,
            [id]: {
                ...prev[id] || { type: 'COMPLETED', subtype: '', personalized: '', lastApplied: '', observation: '' },
                [field]: value
            }
        }));
    };

    const getBookOptions = (level: string) => {
        const books = (PEDAGOGICAL_BOOKS as any)[level.split(' ')[0]] || [];
        return books;
    };

    const getFieldValue = (id: string | number, field: string) => {
        return formData[id]?.[field] || '';
    };

    const getDefaultType = (id: string | number) => {
        return formData[id]?.type || 'COMPLETED'; // Default 'Aula Ocorreu'
    };

    const filteredItems = items.filter(item =>
        item.name.toLowerCase().includes(searchTerm.toLowerCase())
    );

    const handleValidateAndSave = () => {
        // Validate each item in the formData or check visible items?
        // Check all items that have data or are in the list.
        // We only care about items where 'personalized' is set to 'Sim' in the formData.

        const errors: string[] = [];

        Object.keys(formData).forEach(key => {
            const entry = formData[key];
            if (entry.personalized === 'Sim' && (!entry.observation || !entry.observation.trim())) {
                // Find student name for error message
                const studentName = items.find(i => String(i.id) === key)?.name || 'Desconhecido';
                errors.push(studentName);
            }
        });

        if (errors.length > 0) {
            alert(`⚠️ CAMPO OBRIGATÓRIO FALTANDO\n\nProfessor, você marcou a aula como "Personalizada", por isso é OBRIGATÓRIO descrever o conteúdo no campo "Obs".\n\nAlunos pendentes:\n- ${errors.join('\n- ')}`);
            return;
        }

        // FIX (contabilização): "Salvar Tudo" deve registrar TODAS as aulas listadas.
        // Antes, só iam as linhas que o professor tocou (formData). As linhas no padrão
        // visível "Aula Ocorreu" (COMPLETED) não entravam no payload e eram descartadas
        // em silêncio — a aula sumia da lista, mas NÃO era lançada nem contabilizada.
        // Agora materializamos o padrão visível para cada item listado.
        const DEFAULT_ENTRY = { type: 'COMPLETED', subtype: '', personalized: '', lastApplied: '', observation: '' };
        const completePayload: Record<string, any> = {};
        for (const item of items) {
            const id = String(item.id);
            completePayload[id] = formData[id] || { ...DEFAULT_ENTRY };
        }

        onSave(completePayload);
    };

    return (
        <div className="bg-brand-surface rounded-2xl border border-brand-border dark:border-brand-border shadow-sm overflow-hidden animate-in fade-in duration-500 flex flex-col h-full max-h-[85vh]">

            {/* Header & Actions */}
            <div className="p-6 border-b border-brand-border flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-brand-surface-2/50 dark:bg-brand-surface">
                <div>
                    {title && <h3 className="text-lg font-black text-brand-text uppercase tracking-tight">{title}</h3>}
                    <p className="text-xs text-brand-muted font-medium mt-1">
                        {(() => {
                            const hoje = items.filter(i => !i.isLate).length;
                            const atrasadas = items.filter(i => i.isLate).length;
                            if (hoje > 0 && atrasadas > 0)
                                return <><span className="text-brand-text font-bold">{hoje} de hoje</span> · <span className="text-amber-500 font-bold">{atrasadas} atrasada{atrasadas > 1 ? 's' : ''} (dia anterior)</span></>;
                            if (atrasadas > 0)
                                return <span className="text-amber-500 font-bold">{atrasadas} aula{atrasadas > 1 ? 's' : ''} atrasada{atrasadas > 1 ? 's' : ''} de dia anterior</span>;
                            return <span>{hoje} aluno(s) listado(s)</span>;
                        })()}
                    </p>
                </div>

                <div className="flex items-center gap-3 w-full md:w-auto">
                    {onCancel && (
                        <button
                            onClick={onCancel}
                            className="p-2 text-brand-muted hover:text-brand-muted dark:hover:text-slate-200 hover:bg-brand-surface-2 dark:hover:bg-800 rounded-lg transition-colors"
                            title="Fechar"
                        >
                            <X size={18} />
                        </button>
                    )}
                    <div className="relative flex-1 md:w-64">
                        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted" />
                        <input
                            type="text"
                            placeholder="Buscar aluno..."
                            value={searchTerm}
                            onChange={e => setSearchTerm(e.target.value)}
                            className="w-full pl-9 pr-4 py-2.5 bg-brand-surface dark:bg-brand-surface-2 border border-brand-border rounded-xl text-xs font-medium focus:ring-2 focus:ring-tenant-primary outline-none transition-all"
                        />
                    </div>
                    <button
                        onClick={handleValidateAndSave}
                        disabled={loading}
                        className="bg-tenant-primary text-white px-6 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest shadow-lg shadow-tenant-primary/20 hover:scale-105 transition-all flex items-center gap-2 disabled:opacity-50 disabled:scale-100 disabled:cursor-not-allowed"
                    >
                        {loading ? <RefreshCw className="animate-spin" size={14} /> : <Save size={14} />}
                        {loading ? 'Salvando...' : 'Salvar Tudo'}
                    </button>
                </div>
            </div>

            {/* Table Content Wrapper for Scroll */}
            <div className="flex-1 overflow-auto custom-scrollbar">
                <div className="min-w-[600px]">
                    {/* Table Header */}
                    {/* Table Header */}
                    <div className="grid grid-cols-[minmax(140px,2fr)_minmax(100px,1fr)_minmax(120px,1fr)_minmax(100px,1fr)_minmax(200px,2fr)] gap-4 px-6 py-3 bg-brand-surface-2/50 dark:bg-brand-surface-2/50 border-b border-brand-border items-center">
                        <div className="">
                            <label className="text-[9px] font-black text-brand-muted uppercase tracking-widest">Alunos</label>
                        </div>
                        <div className="">
                            <label className="text-[9px] font-black text-brand-muted uppercase tracking-widest">Tipo</label>
                        </div>
                        <div className="">
                            <label className="text-[9px] font-black text-brand-muted uppercase tracking-widest leading-tight block">Subtipo</label>
                        </div>
                        <div className="">
                            <label className="text-[9px] font-black text-brand-muted uppercase tracking-widest leading-tight block">Personalizada</label>
                        </div>

                        <div className="">
                            <label className="text-[9px] font-black text-brand-muted uppercase tracking-widest">Obs</label>
                        </div>
                    </div>

                    {/* Rows */}
                    <div className="p-4 space-y-1">
                        {filteredItems.map((item, index) => (
                            <div key={item.id} className={`border-b border-brand-border last:border-0 hover:bg-brand-surface-2 dark:hover:bg-brand-surface-2/30 transition-colors group ${
                                item.type === 'AULA EXPERIMENTAL'
                                    ? 'bg-purple-50 dark:bg-purple-900/15 border-l-4 border-l-purple-500'
                                    : item.type === 'TREINAMENTO'
                                        ? 'bg-amber-50 dark:bg-amber-900/15 border-l-4 border-l-amber-500'
                                        : item.isLate
                                            ? 'bg-orange-50 dark:bg-orange-900/10 border-l-4 border-l-orange-400'
                                            : 'bg-brand-surface'
                            }`}>
                            {/* Banner de aviso para aulas atrasadas */}
                            {item.isLate && (
                                <div className="flex items-center gap-2 px-4 pt-2.5">
                                    <span className="text-[9px] font-black uppercase tracking-widest bg-orange-100 dark:bg-orange-900/40 text-orange-600 dark:text-orange-400 px-2 py-0.5 rounded-full border border-orange-200 dark:border-orange-800">
                                        ⚠ Lançamento atrasado · {item.date}
                                    </span>
                                </div>
                            )}
                                {/* Main Row */}
                                <div className="grid grid-cols-[minmax(140px,2fr)_minmax(100px,1fr)_minmax(120px,1fr)_minmax(100px,1fr)_minmax(200px,2fr)] gap-4 py-4 items-center">
                                    {/* Student Info */}
                                    <div className="flex items-center gap-3 pr-4 pl-2">
                                        <div className="relative">
                                            {item.avatar ? (
                                                <img src={item.avatar} className={`w-9 h-9 rounded-xl object-cover shadow-sm bg-brand-surface-2 shrink-0 border-2 ${item.type === 'AULA EXPERIMENTAL' ? 'border-purple-500' : 'border-transparent'}`} alt="" />
                                            ) : (
                                                <div className={`w-9 h-9 rounded-xl flex items-center justify-center text-white text-xs font-bold shadow-sm shrink-0 ${item.type === 'AULA EXPERIMENTAL' ? 'bg-purple-600' : 'bg-gradient-to-br from-indigo-500 to-purple-500'}`}>
                                                    {item.name.substring(0, 2).toUpperCase()}
                                                </div>
                                            )}
                                            {item.type === 'AULA EXPERIMENTAL' && (
                                                <div className="absolute -top-1 -right-1 w-3 h-3 bg-purple-600 border border-white dark:border-brand-border rounded-full animate-pulse" />
                                            )}
                                        </div>
                                        <div className="overflow-hidden min-w-0">
                                            <div className="flex items-center gap-2">
                                                <h4 className="text-xs font-bold text-brand-text dark:text-slate-200 truncate" title={item.name}>{item.name}</h4>
                                                {item.type === 'AULA EXPERIMENTAL' && (
                                                    <span className="text-[7px] font-black bg-purple-600 text-white px-1.5 py-0.5 rounded uppercase tracking-[0.1em] animate-pulse">Trial</span>
                                                )}
                                            </div>
                                            <p className="text-[10px] text-brand-muted font-medium mt-0.5 flex items-center gap-1.5 truncate">
                                                {item.level && <span className={`px-1.5 py-0.5 rounded text-[8px] uppercase tracking-wider shrink-0 ${item.type === 'AULA EXPERIMENTAL' ? 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 font-black' : 'bg-brand-surface-2 dark:bg-brand-surface-2'}`}>{item.level}</span>}
                                                {item.date}
                                            </p>
                                            {/* Botão de aviso MANUAL ao aluno (abre o WhatsApp do professor já com a mensagem + link do Meet) */}
                                            {(() => {
                                                const waLink = buildAvisarAlunoLink(item);
                                                if (!waLink) return null;
                                                return (
                                                    <a
                                                        href={waLink}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        onClick={e => e.stopPropagation()}
                                                        title="Avisar o aluno pelo WhatsApp (confirmação de aula + link do Meet)"
                                                        className="inline-flex items-center gap-1 mt-1.5 px-2 py-1 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 text-[9px] font-black uppercase tracking-widest border border-emerald-500/20 transition-colors"
                                                    >
                                                        <MessageCircle size={11} />
                                                        Avisar aluno
                                                    </a>
                                                );
                                            })()}
                                        </div>
                                    </div>

                                    {/* Type */}
                                    <div className="">
                                        <select
                                            className="w-full p-2.5 bg-brand-surface dark:bg-brand-surface-2 border border-brand-border rounded-lg text-xs font-medium text-brand-text dark:text-slate-300 focus:ring-2 focus:ring-tenant-primary outline-none transition-shadow"
                                            value={getDefaultType(item.id)}
                                            onChange={e => handleChange(item.id, 'type', e.target.value)}
                                        >
                                            <option value="COMPLETED">Aula Ocorreu</option>
                                            <option value="STUDENT_ABSENCE">Aluno Faltou</option>
                                            <option value="TEACHER_ABSENCE">Professor Faltou</option>
                                            <option value="Falta Justificada">Falta Justificada (Legacy)</option>
                                        </select>
                                    </div>

                                    {/* Subtype */}
                                    <div className="pr-2">
                                        <select
                                            className="w-full p-2.5 bg-brand-surface dark:bg-brand-surface-2 border border-brand-border rounded-lg text-xs font-medium text-brand-text dark:text-slate-300 focus:ring-2 focus:ring-tenant-primary outline-none disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                                            value={getFieldValue(item.id, 'subtype')}
                                            onChange={e => handleChange(item.id, 'subtype', e.target.value)}
                                            disabled={getDefaultType(item.id) === 'COMPLETED'}
                                        >
                                            <option value="">Selecione...</option>
                                            <option>Doença</option>
                                            <option>Trabalho</option>
                                            <option>Viagem</option>
                                            <option>Outros</option>
                                        </select>
                                    </div>

                                    {/* Personalized */}
                                    <div className="pr-2">
                                        <select
                                            className="w-full p-2.5 bg-brand-surface dark:bg-brand-surface-2 border border-brand-border rounded-lg text-xs font-medium text-brand-text dark:text-slate-300 focus:ring-2 focus:ring-tenant-primary outline-none disabled:opacity-30 disabled:cursor-not-allowed"
                                            value={getFieldValue(item.id, 'personalized')}
                                            onChange={e => handleChange(item.id, 'personalized', e.target.value)}
                                            disabled={getDefaultType(item.id) !== 'COMPLETED'}
                                        >
                                            <option value="">Selecione...</option>
                                            <option>Sim</option>
                                            <option>Não</option>
                                        </select>
                                    </div>



                                    {/* Obs (Free Text) */}
                                    <div className="pr-2">
                                        <input
                                            className={`w-full p-2.5 bg-brand-surface dark:bg-brand-surface-2 border rounded-lg text-xs font-medium text-brand-text dark:text-slate-300 outline-none transition-all ${getFieldValue(item.id, 'personalized') === 'Sim' && !getFieldValue(item.id, 'observation') ? 'border-red-400 ring-2 ring-red-100' : 'border-brand-border focus:ring-2 focus:ring-tenant-primary'}`}
                                            placeholder={getFieldValue(item.id, 'personalized') === 'Sim' ? "OBRIGATÓRIO: Justifique o conteúdo..." : "Obs (Opcional)..."}
                                            value={getFieldValue(item.id, 'observation')}
                                            onChange={e => handleChange(item.id, 'observation', e.target.value)}
                                        />
                                    </div>
                                </div>
                            </div>
                        ))}

                        {filteredItems.length === 0 && (
                            <div className="text-center py-12 text-brand-muted">
                                <p className="text-sm">Nenhum aluno encontrado.</p>
                            </div>
                        )}
                    </div>
                </div>
            </div >

            {onCancel && (
                <div className="flex justify-start p-4 border-t border-brand-border md:hidden">
                    <button
                        onClick={onCancel}
                        className="text-xs font-bold text-brand-muted hover:text-brand-text dark:hover:text-slate-200 transition-colors uppercase tracking-wider"
                    >
                        Cancelar
                    </button>
                </div>
            )}
        </div >
    );
};

export default ClassLogForm;
