import React, { useState } from 'react';
import {
    Repeat,
    Settings,
    Plus,
    Trash2,
    Filter,
    Search,
    Calendar,
    X,
    User,
    Clock,
    Save
} from 'lucide-react';
import { Reschedule } from '../types';

interface TeacherReschedulesProps {
    reschedules?: Reschedule[];
    students?: { id: string; name: string; module: string; }[];
    onAdd?: (data: any) => void;
    onDelete?: (id: string | number) => void;
}

const TeacherReschedules: React.FC<TeacherReschedulesProps> = ({ reschedules = [], students = [], onAdd, onDelete }) => {
    const [activeTab, setActiveTab] = useState('schedule');
    const [searchTerm, setSearchTerm] = useState('');
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingId, setEditingId] = useState<string | number | null>(null);
    const [formData, setFormData] = useState({
        studentId: '',
        date: '',
        time: ''
    });

    const tabs = [
        { id: 'schedule', label: 'Agendar Reposição' },
        { id: 'form', label: 'Formulário Reposição' },
    ];

    const filteredReschedules = reschedules.filter(r =>
        r.studentName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        r.date.includes(searchTerm)
    );

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (onAdd) {
            onAdd({
                id: editingId,
                studentId: formData.studentId,
                date: formData.date,
                time: formData.time
            });
            setIsModalOpen(false);
            setFormData({ studentId: '', date: '', time: '' });
            setEditingId(null);
        }
    };

    const handleEdit = (item: any) => {
        setFormData({
            studentId: item.studentId || '',
            date: item.date === 'Pendente' ? '' : item.date,
            time: item.time === 'Pendente' ? '' : item.time
        });
        setEditingId(item.id);
        setIsModalOpen(true);
    };

    return (
        <div className="space-y-6 animate-in fade-in duration-500">
            <div className="flex items-center justify-between">
                <h2 className="text-2xl font-black text-gray-800 dark:text-slate-100 tracking-tight flex items-center gap-3">
                    Reposições
                </h2>
            </div>

            <div className="bg-white dark:bg-slate-900 rounded-[2rem] border border-gray-100 dark:border-slate-800 shadow-sm overflow-hidden">
                {/* Tabs */}
                <div className="border-b border-gray-100 dark:border-slate-800 px-6 pt-2 flex gap-6 overflow-x-auto">
                    {tabs.map((tab) => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            className={`pb-4 text-xs font-bold uppercase tracking-wide transition-colors relative whitespace-nowrap ${activeTab === tab.id
                                ? 'text-tenant-primary dark:text-sky-400'
                                : 'text-gray-400 hover:text-gray-600 dark:hover:text-slate-300'
                                }`}
                        >
                            {tab.label}
                            {activeTab === tab.id && (
                                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-tenant-primary dark:bg-sky-400 rounded-t-full" />
                            )}
                        </button>
                    ))}
                </div>

                <div className="p-6 space-y-6">
                    {activeTab === 'schedule' ? (
                        <>
                            {/* Actions Bar */}
                            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                                <div className="flex gap-2">
                                    <button className="bg-tenant-primary hover:bg-tenant-primary/90 text-white px-4 py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide transition-all shadow-lg shadow-tenant-primary/20 flex items-center gap-2">
                                        <Settings size={14} /> Ajustar Colunas
                                    </button>
                                </div>

                                <div className="relative w-full md:w-64">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
                                    <input
                                        type="text"
                                        placeholder="Buscar..."
                                        value={searchTerm}
                                        onChange={(e) => setSearchTerm(e.target.value)}
                                        className="w-full pl-9 pr-4 py-2 bg-gray-50 dark:bg-slate-800 border border-gray-100 dark:border-slate-700 rounded-xl text-xs outline-none focus:ring-2 focus:ring-tenant-primary/20"
                                    />
                                </div>
                            </div>

                            {/* Table */}
                            <div className="overflow-x-auto rounded-xl border border-gray-100 dark:border-slate-800">
                                <table className="w-full text-left border-collapse">
                                    <thead>
                                        <tr className="bg-gray-50/50 dark:bg-slate-800/50 border-b border-gray-100 dark:border-slate-800">
                                            <th className="p-4 text-[10px] uppercase font-black text-gray-500 dark:text-slate-400 tracking-wider w-24 text-center">
                                                Ações
                                            </th>
                                            <th className="p-4 text-[10px] uppercase font-black text-gray-500 dark:text-slate-400 tracking-wider">
                                                <div className="flex items-center gap-1 cursor-pointer hover:text-gray-700 dark:hover:text-slate-200">
                                                    Agendamento <Filter size={10} className="ml-1" />
                                                </div>
                                            </th>
                                            <th className="p-4 text-[10px] uppercase font-black text-gray-500 dark:text-slate-400 tracking-wider">
                                                <div className="flex items-center gap-1 cursor-pointer hover:text-gray-700 dark:hover:text-slate-200">
                                                    Teacher <Filter size={10} className="ml-1" />
                                                </div>
                                            </th>
                                            <th className="p-4 text-[10px] uppercase font-black text-gray-500 dark:text-slate-400 tracking-wider">
                                                <div className="flex items-center gap-1 cursor-pointer hover:text-gray-700 dark:hover:text-slate-200">
                                                    Student <Filter size={10} className="ml-1" />
                                                </div>
                                            </th>
                                            <th className="p-4 text-[10px] uppercase font-black text-gray-500 dark:text-slate-400 tracking-wider">
                                                <div className="flex items-center gap-1 cursor-pointer hover:text-gray-700 dark:hover:text-slate-200">
                                                    Origem <Filter size={10} className="ml-1" />
                                                </div>
                                            </th>
                                            <th className="p-4 text-[10px] uppercase font-black text-gray-500 dark:text-slate-400 tracking-wider">
                                                Status
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-50 dark:divide-slate-800/50">
                                        {filteredReschedules.map((item) => (
                                            <tr key={item.id} className="hover:bg-gray-50 dark:hover:bg-slate-800/30 transition-colors">
                                                <td className="p-4 flex items-center gap-2 justify-center">
                                                    <button
                                                        onClick={() => handleEdit(item)}
                                                        className="p-1.5 text-blue-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors border border-transparent hover:border-blue-100"
                                                        title="Editar"
                                                    >
                                                        <Settings size={14} />
                                                    </button>
                                                    <button
                                                        onClick={() => handleEdit(item)}
                                                        className="p-1.5 text-blue-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors border border-transparent hover:border-blue-100"
                                                        title="Editar"
                                                    >
                                                        <Settings size={14} />
                                                    </button>
                                                </td>
                                                <td className="p-4 text-xs font-bold">
                                                    {item.date === 'Pendente' ? (
                                                        <span className="flex items-center gap-2 text-orange-500 bg-orange-50 dark:bg-orange-900/20 px-2 py-1 rounded w-fit uppercase">
                                                            <Clock size={12} /> Aguardando Data
                                                        </span>
                                                    ) : (
                                                        <span className="text-gray-700 dark:text-slate-300 font-black whitespace-nowrap">{item.date} às {item.time}</span>
                                                    )}
                                                </td>
                                                <td className="p-4 text-xs font-medium text-gray-600 dark:text-slate-400 max-w-[150px] truncate">
                                                    {item.teacherName}
                                                </td>
                                                <td className="p-4 text-xs font-medium text-gray-600 dark:text-slate-400">
                                                    <span className="font-black text-slate-800 dark:text-slate-100 uppercase">{item.studentName}</span>
                                                </td>
                                                <td className="p-4 text-xs font-medium text-gray-500 dark:text-slate-400 text-[10px] tracking-widest font-black uppercase">
                                                    {item.repoId > 0 ? 'CRÉDITO' : 'AGENDADA'}
                                                </td>
                                                <td className="p-4">
                                                    {item.date === 'Pendente' ? (
                                                        <button
                                                            onClick={() => handleEdit(item)}
                                                            className="text-[10px] font-black uppercase text-tenant-primary hover:underline"
                                                        >
                                                            Agendar Agora
                                                        </button>
                                                    ) : (
                                                        <span className="text-[10px] font-black text-emerald-500 uppercase flex items-center gap-1">
                                                            Confirmada
                                                        </span>
                                                    )}
                                                </td>
                                            </tr>
                                        ))}
                                        {filteredReschedules.length === 0 && (
                                            <tr>
                                                <td colSpan={6} className="p-12 text-center text-gray-400 text-xs font-black uppercase tracking-[0.2em] opacity-40">
                                                    Nenhuma reposição encontrada
                                                </td>
                                            </tr>
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </>
                    ) : (
                        <div className="flex flex-col items-center justify-center py-20 text-gray-300 dark:text-slate-700">
                            <Calendar size={64} strokeWidth={1} className="mb-4" />
                            <p className="text-sm font-black uppercase tracking-widest">Formulário de Detalhes</p>
                            <p className="text-xs font-medium mt-1">Recurso em desenvolvimento para relatórios avançados.</p>
                        </div>
                    )}
                </div>
            </div>

            {/* Add/Edit Modal */}
            {isModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-md animate-in fade-in duration-300">
                    <div className="bg-white dark:bg-slate-900 w-full max-w-md rounded-[3rem] shadow-2xl border border-slate-100 dark:border-slate-800 overflow-hidden flex flex-col transform animate-in zoom-in-95 duration-300">
                        <div className="p-8 border-b dark:border-slate-800 flex justify-between items-center bg-slate-50/50 dark:bg-slate-800/50">
                            <div>
                                <h3 className="text-xl font-black text-slate-800 dark:text-white flex items-center gap-2 uppercase tracking-tight">
                                    <Repeat size={24} className="text-tenant-primary" /> {editingId ? 'Editar Reposição' : 'Agendar Reposição'}
                                </h3>
                                <p className="text-xs text-slate-400 font-medium mt-0.5">Defina a nova data e horário para a aula.</p>
                            </div>
                            <button
                                onClick={() => {
                                    setIsModalOpen(false);
                                    setEditingId(null);
                                }}
                                className="p-3 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-2xl transition-all"
                            >
                                <X size={20} className="text-slate-400" />
                            </button>
                        </div>

                        <form onSubmit={handleSubmit} className="p-8 space-y-6">
                            <div className="space-y-2">
                                <label className="text-[10px] font-black uppercase tracking-[0.1em] text-slate-400 flex items-center gap-2 ml-1">
                                    <User size={12} className="text-tenant-primary" /> Aluno Selecionado
                                </label>
                                <select
                                    required
                                    value={formData.studentId}
                                    onChange={e => setFormData({ ...formData, studentId: e.target.value })}
                                    className="w-full px-5 py-4 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-[1.25rem] text-sm font-bold text-slate-700 dark:text-slate-200 focus:ring-4 focus:ring-tenant-primary/10 outline-none transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                                    disabled={true}
                                >
                                    <option value="">Selecione um aluno...</option>
                                    {students.map(student => (
                                        <option key={student.id} value={student.id}>
                                            {student.name} ({student.module})
                                        </option>
                                    ))}
                                </select>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black uppercase tracking-[0.1em] text-slate-400 flex items-center gap-2 ml-1">
                                        <Calendar size={12} className="text-tenant-primary" /> Data
                                    </label>
                                    <input
                                        type="date"
                                        required
                                        value={formData.date}
                                        onChange={e => setFormData({ ...formData, date: e.target.value })}
                                        className="w-full px-5 py-4 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-[1.25rem] text-sm font-bold text-slate-700 dark:text-slate-200 focus:ring-4 focus:ring-tenant-primary/10 outline-none transition-all"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-[10px] font-black uppercase tracking-[0.1em] text-slate-400 flex items-center gap-2 ml-1">
                                        <Clock size={12} className="text-tenant-primary" /> Horário
                                    </label>
                                    <input
                                        type="time"
                                        required
                                        value={formData.time}
                                        onChange={e => setFormData({ ...formData, time: e.target.value })}
                                        className="w-full px-5 py-4 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-[1.25rem] text-sm font-bold text-slate-700 dark:text-slate-200 focus:ring-4 focus:ring-tenant-primary/10 outline-none transition-all"
                                    />
                                </div>
                            </div>

                            <button
                                type="submit"
                                className="w-full bg-tenant-primary text-white py-5 rounded-[1.5rem] font-black text-[11px] uppercase tracking-[0.2em] hover:scale-[1.02] active:scale-[0.98] transition-all shadow-xl shadow-tenant-primary/30 flex items-center justify-center gap-3 mt-4"
                            >
                                <Save size={18} /> {editingId ? 'Salvar Alterações' : 'Concluir Agendamento'}
                            </button>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
};

export default TeacherReschedules;
