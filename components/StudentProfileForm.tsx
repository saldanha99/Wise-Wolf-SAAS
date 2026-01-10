import React, { useState, useEffect } from 'react';
import { X, Save, BookOpen, MessageCircle, Briefcase, Phone, User, Check, Plus, Trash2 } from 'lucide-react';

interface StudentProfileFormProps {
    initialData?: any;
    onSubmit: (data: any) => void;
    onCancel: () => void;
    onDelete?: () => void;
    title?: string;
}

const StudentProfileForm: React.FC<StudentProfileFormProps> = ({ initialData, onSubmit, onCancel, onDelete, title = 'Aluno' }) => {
    const [formData, setFormData] = useState({
        name: '',
        levelBadge: 'B1',
        currentModuleStatus: '',
        interests: [] as string[],
        correctionPreference: 'TODOS',
        occupation: '',
        phone: '',
        meeting_link: '',
        img: 'https://i.pravatar.cc/150?u=new'
    });

    const [newInterest, setNewInterest] = useState('');

    useEffect(() => {
        if (initialData) {
            setFormData({
                name: initialData.name || '',
                levelBadge: initialData.levelBadge || 'B1',
                currentModuleStatus: initialData.currentModuleStatus || '',
                interests: initialData.interests || [],
                correctionPreference: initialData.correctionPreference || 'TODOS',
                occupation: initialData.occupation || '',
                phone: initialData.phone || '',
                meeting_link: initialData.meeting_link || '',
                img: initialData.img || 'https://i.pravatar.cc/150?u=new'
            });
        }
    }, [initialData]);

    const handleAddInterest = () => {
        if (newInterest.trim()) {
            setFormData(prev => ({
                ...prev,
                interests: [...prev.interests, newInterest.trim().toUpperCase()]
            }));
            setNewInterest('');
        }
    };

    const removeInterest = (index: number) => {
        setFormData(prev => ({
            ...prev,
            interests: prev.interests.filter((_, i) => i !== index)
        }));
    };

    return (
        <div className="bg-white dark:bg-slate-900 rounded-[2rem] shadow-2xl w-full max-w-2xl border border-slate-100 dark:border-slate-800 overflow-hidden animate-in zoom-in-95 duration-200">

            {/* Header */}
            <div className="px-8 py-6 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center bg-slate-50/50 dark:bg-slate-800/20">
                <div>
                    <h3 className="text-xl font-black text-slate-800 dark:text-white uppercase tracking-tight">{initialData ? 'Editar Perfil' : 'Novo Aluno'}</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 font-bold uppercase tracking-widest mt-1">Preencha os detalhes do aluno</p>
                </div>
                <div className="flex items-center gap-2">
                    {onDelete && (
                        <button
                            onClick={onDelete}
                            className="p-2 bg-red-50 hover:bg-red-100 dark:bg-red-900/20 dark:hover:bg-red-900/40 text-red-500 rounded-xl transition-colors mr-2"
                            title="Remover da Agenda"
                        >
                            <Trash2 size={20} />
                        </button>
                    )}
                    <button onClick={onCancel} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full transition-colors text-slate-400">
                        <X size={20} />
                    </button>
                </div>
            </div>

            <div className="p-8 space-y-6 max-h-[70vh] overflow-y-auto custom-scrollbar">

                {/* Basic Info */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-2">
                        <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                            <User size={12} /> Nome Completo
                        </label>
                        <input
                            value={formData.name}
                            onChange={e => setFormData({ ...formData, name: e.target.value })}
                            className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-200 focus:ring-2 focus:ring-tenant-primary outline-none"
                            placeholder="Ex: Ana Silva"
                        />
                    </div>

                    <div className="space-y-2">
                        <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                            Nível (Badge)
                        </label>
                        <select
                            value={formData.levelBadge}
                            onChange={e => setFormData({ ...formData, levelBadge: e.target.value })}
                            className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-200 focus:ring-2 focus:ring-tenant-primary outline-none appearance-none"
                        >
                            <option>A1</option>
                            <option>A2</option>
                            <option>B1</option>
                            <option>B2</option>
                            <option>C1</option>
                            <option>C2</option>
                        </select>
                    </div>
                </div>

                {/* Current Module */}
                <div className="space-y-2">
                    <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                        <BookOpen size={12} /> Módulo Atual
                    </label>
                    <input
                        value={formData.currentModuleStatus}
                        onChange={e => setFormData({ ...formData, currentModuleStatus: e.target.value.toUpperCase() })}
                        className="w-full px-4 py-3 bg-blue-50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-900/30 rounded-xl text-xs font-black text-blue-700 dark:text-blue-300 focus:ring-2 focus:ring-blue-500 outline-none uppercase tracking-wide"
                        placeholder="Ex: B1 - PARTE 2 - AULA 26 ATÉ 50"
                    />
                </div>

                {/* Interests */}
                <div className="space-y-3">
                    <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                        Interesses
                    </label>
                    <div className="flex flex-wrap gap-2 mb-2">
                        {formData.interests.map((interest, idx) => (
                            <span key={idx} className="px-3 py-1 bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 rounded-lg text-[10px] font-black uppercase tracking-wide flex items-center gap-2">
                                {interest}
                                <button onClick={() => removeInterest(idx)} className="hover:text-orange-800 dark:hover:text-orange-200"><X size={10} /></button>
                            </span>
                        ))}
                    </div>
                    <div className="flex gap-2">
                        <input
                            value={newInterest}
                            onChange={e => setNewInterest(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handleAddInterest()}
                            className="flex-1 px-4 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs font-bold focus:ring-2 focus:ring-orange-500 outline-none uppercase"
                            placeholder="Adicionar interesse..."
                        />
                        <button
                            onClick={handleAddInterest}
                            className="px-4 py-2 bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-xl hover:bg-orange-100 hover:text-orange-600 transition-colors"
                        >
                            <Plus size={16} />
                        </button>
                    </div>
                </div>

                {/* Correction & Occupation */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-2">
                        <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                            <MessageCircle size={12} /> Preferência de Correção
                        </label>
                        <select
                            value={formData.correctionPreference}
                            onChange={e => setFormData({ ...formData, correctionPreference: e.target.value })}
                            className="w-full px-4 py-3 bg-emerald-50 dark:bg-emerald-900/10 border border-emerald-100 dark:border-emerald-900/30 rounded-xl text-xs font-black text-emerald-700 dark:text-emerald-400 focus:ring-2 focus:ring-emerald-500 outline-none uppercase"
                        >
                            <option>TODOS</option>
                            <option>AO FINAL</option>
                            <option>SEMPRE</option>
                            <option>NUNCA</option>
                        </select>
                    </div>

                    <div className="space-y-2">
                        <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                            <Briefcase size={12} /> Ocupação
                        </label>
                        <input
                            value={formData.occupation}
                            onChange={e => setFormData({ ...formData, occupation: e.target.value.toUpperCase() })}
                            className="w-full px-4 py-3 bg-white dark:bg-slate-900 border border-pink-200 dark:border-pink-900 rounded-xl text-xs font-black text-pink-500 dark:text-pink-400 focus:ring-2 focus:ring-pink-500 outline-none uppercase"
                            placeholder="Ex: ARQUITETA"
                        />
                    </div>
                </div>

                {/* Phone & Meet Link */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-2">
                        <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                            <Phone size={12} /> Telefone (WhatsApp)
                        </label>
                        <input
                            value={formData.phone}
                            onChange={e => setFormData({ ...formData, phone: e.target.value })}
                            className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-200 focus:ring-2 focus:ring-tenant-primary outline-none font-mono"
                            placeholder="5511999999999"
                        />
                    </div>

                    <div className="space-y-2">
                        <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                            <Plus size={12} /> Link da Aula (Meet)
                        </label>
                        <input
                            value={formData.meeting_link}
                            onChange={e => setFormData({ ...formData, meeting_link: e.target.value })}
                            className="w-full px-4 py-3 bg-blue-50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-900/30 rounded-xl text-xs font-bold text-blue-700 dark:text-blue-300 focus:ring-2 focus:ring-blue-500 outline-none"
                            placeholder="https://meet.google.com/abc-defg-hij"
                        />
                    </div>
                </div>

            </div>

            {/* Footer */}
            <div className="p-6 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900 flex justify-between gap-3 custom-shadow-top items-center">
                {/* Empty div to spacing if update layout, or just justify-end in original */}
                <div className="flex-1"></div>
                <div className="flex gap-3">
                    <button
                        onClick={onCancel}
                        className="px-6 py-3 rounded-xl font-bold text-xs uppercase tracking-widest text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                    >
                        Cancelar
                    </button>
                    <button
                        onClick={() => onSubmit(formData)}
                        className="px-8 py-3 bg-tenant-primary text-white rounded-xl font-black text-xs uppercase tracking-widest hover:scale-105 active:scale-95 transition-all shadow-lg shadow-tenant-primary/20 flex items-center gap-2"
                    >
                        <Save size={16} /> Salvar Perfil
                    </button>
                </div>
            </div>

        </div>
    );
};

export default StudentProfileForm;
