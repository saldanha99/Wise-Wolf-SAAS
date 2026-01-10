import React, { useState } from 'react';
import { Save, X, Search, RefreshCw } from 'lucide-react';

export interface ClassLogItem {
    id: string | number;
    name: string;
    date: string;
    avatar?: string;
    level?: string;
    suggestedTopic?: string;
    suggestedMaterial?: string;
    suggestedMaterialUrl?: string; // Add URL for direct access
}

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
                ...prev[id] || { type: 'Falta', subtype: '', personalized: '', lastApplied: '', observation: '' },
                [field]: value
            }
        }));
    };

    const getFieldValue = (id: string | number, field: string) => {
        return formData[id]?.[field] || '';
    };

    const getDefaultType = (id: string | number) => {
        return formData[id]?.type || 'Falta'; // Default based on image
    };

    const filteredItems = items.filter(item =>
        item.name.toLowerCase().includes(searchTerm.toLowerCase())
    );

    return (
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden animate-in fade-in duration-500 flex flex-col h-full">

            {/* Header & Actions */}
            <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-slate-50/50 dark:bg-slate-900">
                <div>
                    {title && <h3 className="text-lg font-black text-slate-800 dark:text-white uppercase tracking-tight">{title}</h3>}
                    <p className="text-xs text-slate-500 dark:text-slate-400 font-medium mt-1">
                        {items.length} aluno(s) listado(s)
                    </p>
                </div>

                <div className="flex items-center gap-3 w-full md:w-auto">
                    {onCancel && (
                        <button
                            onClick={onCancel}
                            className="p-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-800 rounded-lg transition-colors"
                            title="Fechar"
                        >
                            <X size={18} />
                        </button>
                    )}
                    <div className="relative flex-1 md:w-64">
                        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                        <input
                            type="text"
                            placeholder="Buscar aluno..."
                            value={searchTerm}
                            onChange={e => setSearchTerm(e.target.value)}
                            className="w-full pl-9 pr-4 py-2.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-xs font-medium focus:ring-2 focus:ring-tenant-primary outline-none transition-all"
                        />
                    </div>
                    <button
                        onClick={() => onSave(formData)}
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
                    <div className="grid grid-cols-[minmax(140px,2fr)_repeat(5,minmax(85px,1fr))] gap-2 px-6 py-3 bg-slate-100/50 dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-800 items-center">
                        <div className="">
                            <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Alunos</label>
                        </div>
                        <div className="">
                            <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Tipo</label>
                        </div>
                        <div className="">
                            <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest leading-tight block">Subtipo</label>
                        </div>
                        <div className="">
                            <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest leading-tight block">Personalizada</label>
                        </div>
                        <div className="">
                            <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest leading-tight block">Última Aula</label>
                        </div>
                        <div className="">
                            <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Obs</label>
                        </div>
                    </div>

                    {/* Rows */}
                    <div className="p-4 space-y-1">
                        {filteredItems.map((item, index) => (
                            <div key={item.id} className="border-b border-slate-100 dark:border-slate-800 last:border-0 hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors bg-white dark:bg-slate-900 group">
                                {/* Main Row */}
                                <div className="grid grid-cols-[minmax(140px,2fr)_repeat(4,minmax(85px,1fr))] gap-2 py-4 items-center">
                                    {/* Student Info */}
                                    <div className="flex items-center gap-3 pr-4 pl-2">
                                        {item.avatar ? (
                                            <img src={item.avatar} className="w-9 h-9 rounded-xl object-cover shadow-sm bg-slate-100 shrink-0" alt="" />
                                        ) : (
                                            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center text-white text-xs font-bold shadow-sm shrink-0">
                                                {item.name.substring(0, 2).toUpperCase()}
                                            </div>
                                        )}
                                        <div className="overflow-hidden min-w-0">
                                            <h4 className="text-xs font-bold text-slate-800 dark:text-slate-200 truncate" title={item.name}>{item.name}</h4>
                                            <p className="text-[10px] text-slate-400 dark:text-slate-500 font-medium mt-0.5 flex items-center gap-1.5 truncate">
                                                {item.level && <span className="bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded text-[8px] uppercase tracking-wider shrink-0">{item.level}</span>}
                                                {item.date}
                                            </p>
                                        </div>
                                    </div>

                                    {/* Type */}
                                    <div className="">
                                        <select
                                            className="w-full p-2.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-medium text-slate-700 dark:text-slate-300 focus:ring-2 focus:ring-tenant-primary outline-none transition-shadow"
                                            value={getDefaultType(item.id)}
                                            onChange={e => handleChange(item.id, 'type', e.target.value)}
                                        >
                                            <option>Presença</option>
                                            <option>Falta</option>
                                            <option>Falta Justificada</option>
                                            <option>Falta do Professor</option>
                                        </select>
                                    </div>

                                    {/* Subtype */}
                                    <div className="pr-2">
                                        <select
                                            className="w-full p-2.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-medium text-slate-700 dark:text-slate-300 focus:ring-2 focus:ring-tenant-primary outline-none disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                                            value={getFieldValue(item.id, 'subtype')}
                                            onChange={e => handleChange(item.id, 'subtype', e.target.value)}
                                            disabled={getDefaultType(item.id) === 'Presença'}
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
                                            className="w-full p-2.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-medium text-slate-700 dark:text-slate-300 focus:ring-2 focus:ring-tenant-primary outline-none disabled:opacity-30 disabled:cursor-not-allowed"
                                            value={getFieldValue(item.id, 'personalized')}
                                            onChange={e => handleChange(item.id, 'personalized', e.target.value)}
                                            disabled={getDefaultType(item.id) !== 'Presença'}
                                        >
                                            <option value="">Selecione...</option>
                                            <option>Sim</option>
                                            <option>Não</option>
                                        </select>
                                    </div>

                                    {/* Last Applied (Legacy/Topic) */}
                                    <div className="pr-2">
                                        <input
                                            className="w-full p-2.5 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-lg text-[10px] font-bold text-slate-500 uppercase disabled:cursor-not-allowed"
                                            value={item.suggestedTopic || 'Geral'}
                                            disabled
                                        />
                                    </div>
                                </div>

                                {/* Detailed Pedagogical Fields */}
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 px-2 pb-4">
                                    <div className="flex-1 space-y-1">
                                        <div className="flex justify-between items-center">
                                            <label className="text-[9px] font-black uppercase text-slate-400">O que foi visto?</label>
                                            {item.suggestedTopic && !getFieldValue(item.id, 'content') && (
                                                <button onClick={() => handleChange(item.id, 'content', `Aula: ${item.suggestedTopic}`)} className="text-[9px] text-indigo-500 font-bold hover:underline">Usar Sugestão</button>
                                            )}
                                        </div>
                                        <textarea
                                            placeholder={`Conteúdo técnico... ${item.suggestedTopic ? `(Sugestão: ${item.suggestedTopic})` : ''}`}
                                            className="w-full p-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-medium focus:ring-2 focus:ring-tenant-primary outline-none resize-none h-16"
                                            value={getFieldValue(item.id, 'content')}
                                            onChange={e => handleChange(item.id, 'content', e.target.value)}
                                        />
                                    </div>
                                    <div className="flex-1 space-y-1">
                                        <label className="text-[9px] font-black uppercase text-slate-400 block">Dificuldades</label>
                                        <textarea
                                            placeholder="Monitoramento..."
                                            className="w-full p-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-medium focus:ring-2 focus:ring-tenant-primary outline-none resize-none h-16"
                                            value={getFieldValue(item.id, 'difficulties')}
                                            onChange={e => handleChange(item.id, 'difficulties', e.target.value)}
                                        />
                                    </div>
                                    <div className="flex-1 space-y-1">
                                        <div className="flex justify-between items-center">
                                            <label className="text-[9px] font-black uppercase text-slate-400">Tarefa de Casa</label>
                                            {item.suggestedMaterial && (
                                                <div className="flex items-center gap-1">
                                                    <span className="text-[9px] text-slate-400">Base: {item.suggestedMaterial}</span>
                                                </div>
                                            )}
                                        </div>
                                        <textarea
                                            placeholder="Para o aluno..."
                                            className="w-full p-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-xs font-medium focus:ring-2 focus:ring-tenant-primary outline-none resize-none h-16"
                                            value={getFieldValue(item.id, 'homework')}
                                            onChange={e => handleChange(item.id, 'homework', e.target.value)}
                                        />
                                    </div>
                                </div>
                            </div>
                        ))}

                        {filteredItems.length === 0 && (
                            <div className="text-center py-12 text-slate-400">
                                <p className="text-sm">Nenhum aluno encontrado.</p>
                            </div>
                        )}
                    </div>
                </div>
            </div >

            {onCancel && (
                <div className="flex justify-start p-4 border-t border-slate-100 dark:border-slate-800 md:hidden">
                    <button
                        onClick={onCancel}
                        className="text-xs font-bold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors uppercase tracking-wider"
                    >
                        Cancelar
                    </button>
                </div>
            )}
        </div >
    );
};

export default ClassLogForm;
