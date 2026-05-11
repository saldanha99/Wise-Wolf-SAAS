import React, { useState, useEffect } from 'react';
import { 
    Users, 
    Search, 
    Plus, 
    X, 
    Mail, 
    Phone, 
    Target, 
    TrendingUp, 
    CheckCircle, 
    Save, 
    RefreshCw,
    Link as LinkIcon,
    Briefcase
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { UserRole } from '../types';
import CommercialInviteGenerator from './CommercialInviteGenerator';

interface CommercialManagementProps {
    tenantId?: string;
}

const CommercialManagement: React.FC<CommercialManagementProps> = ({ tenantId }) => {
    const [salespeople, setSalespeople] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    const initialFormState = {
        name: '',
        email: '',
        phone: '',
        status: 'Ativo'
    };
    const [formData, setFormData] = useState(initialFormState);
    const [editingId, setEditingId] = useState<string | null>(null);

    useEffect(() => {
        if (tenantId) fetchSalespeople();
    }, [tenantId]);

    const fetchSalespeople = async () => {
        setLoading(true);
        try {
            const { data, error } = await supabase
                .from('profiles')
                .select('*')
                .eq('tenant_id', tenantId)
                .eq('role', 'COMMERCIAL');

            if (error) throw error;
            setSalespeople(data || []);
        } catch (e) {
            console.error("Error fetching salespeople", e);
        } finally {
            setLoading(false);
        }
    };

    const handleEdit = (person: any) => {
        setEditingId(person.id);
        setFormData({
            name: person.full_name,
            email: person.email,
            phone: person.phone || '',
            status: person.status || 'Ativo'
        });
        setIsModalOpen(true);
    };

    const handleSave = async () => {
        if (!formData.name || !formData.email || !tenantId) {
            alert("Preencha os campos obrigatórios.");
            return;
        }
        setIsSaving(true);
        try {
            if (editingId) {
                const { error } = await supabase
                    .from('profiles')
                    .update({
                        full_name: formData.name,
                        phone: formData.phone,
                        status: formData.status
                    })
                    .eq('id', editingId);

                if (error) throw error;
                alert("Dados atualizados!");
            } else {
                // For creation, we'll use the Invite Link pattern or a generic account creator
                // Since create-teacher-account is specific, I'll suggest using the Invite Link
                // OR I can use create-teacher-account if I modify it (not possible here directly)
                // Let's assume for now the user creates them via Invite Link to ensure Auth is handled correctly.
                alert("Para novos vendedores, utilize o 'Link de Convite' para garantir a criação da conta de acesso.");
                setIsModalOpen(false);
                setIsInviteModalOpen(true);
                return;
            }
            fetchSalespeople();
            setIsModalOpen(false);
            setEditingId(null);
            setFormData(initialFormState);
        } catch (e: any) {
            alert("Erro ao salvar: " + e.message);
        } finally {
            setIsSaving(false);
        }
    };

    const filtered = salespeople.filter(p => 
        p.full_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        p.email?.toLowerCase().includes(searchTerm.toLowerCase())
    );

    return (
        <div className="space-y-6 md:space-y-8 animate-in fade-in duration-500">
            <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                    <h2 className="text-2xl md:text-3xl font-black text-gray-800 dark:text-slate-100 tracking-tight flex items-center gap-3">
                        <Target className="text-tenant-primary" size={28} /> Equipe Comercial
                    </h2>
                    <p className="text-gray-500 dark:text-slate-400 text-sm">Gerencie seus vendedores e gere links de admissão.</p>
                </div>
                <div className="flex gap-3">
                    <button
                        onClick={() => setIsInviteModalOpen(true)}
                        className="bg-white dark:bg-slate-900 text-tenant-primary border border-tenant-primary/20 px-6 py-3 rounded-xl font-bold text-xs uppercase tracking-widest hover:bg-tenant-primary/5 transition-all flex items-center gap-2"
                    >
                        <LinkIcon size={18} /> Novo Vendedor (Link)
                    </button>
                </div>
            </header>

            {/* Stats Overview */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-white dark:bg-slate-900 p-6 rounded-[2rem] border border-gray-100 dark:border-slate-800 shadow-sm flex items-center gap-4">
                    <div className="p-3 bg-blue-50 dark:bg-blue-900/20 text-blue-600 rounded-xl"><Users size={24} /></div>
                    <div>
                        <p className="text-xs text-gray-400 uppercase font-black tracking-widest">Vendedores</p>
                        <p className="text-2xl font-black text-gray-800 dark:text-white">{salespeople.length}</p>
                    </div>
                </div>
                <div className="bg-white dark:bg-slate-900 p-6 rounded-[2rem] border border-gray-100 dark:border-slate-800 shadow-sm flex items-center gap-4">
                    <div className="p-3 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 rounded-xl"><CheckCircle size={24} /></div>
                    <div>
                        <p className="text-xs text-gray-400 uppercase font-black tracking-widest">Ativos</p>
                        <p className="text-2xl font-black text-gray-800 dark:text-white">{salespeople.filter(p => p.status === 'Ativo').length}</p>
                    </div>
                </div>
                <div className="bg-white dark:bg-slate-900 p-6 rounded-[2rem] border border-gray-100 dark:border-slate-800 shadow-sm flex items-center gap-4">
                    <div className="p-3 bg-purple-50 dark:bg-purple-900/20 text-purple-600 rounded-xl"><TrendingUp size={24} /></div>
                    <div>
                        <p className="text-xs text-gray-400 uppercase font-black tracking-widest">Meta Global</p>
                        <p className="text-2xl font-black text-gray-800 dark:text-white">85%</p>
                    </div>
                </div>
            </div>

            {/* Main List */}
            <div className="bg-white dark:bg-slate-900 border border-gray-100 dark:border-slate-800 rounded-[2.5rem] shadow-sm overflow-hidden">
                <div className="p-6 border-b dark:border-slate-800 flex flex-col sm:flex-row justify-between items-center gap-4">
                    <div className="relative w-full sm:w-72">
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                        <input
                            type="text"
                            placeholder="Buscar vendedor..."
                            value={searchTerm}
                            onChange={e => setSearchTerm(e.target.value)}
                            className="w-full pl-12 pr-4 py-3 bg-gray-50 dark:bg-slate-800 border border-transparent focus:border-tenant-primary rounded-xl text-sm outline-none transition-all"
                        />
                    </div>
                    <button onClick={fetchSalespeople} className="p-2 text-gray-400 hover:text-tenant-primary transition-colors">
                        <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
                    </button>
                </div>

                <div className="overflow-x-auto">
                    <table className="w-full text-left">
                        <thead className="bg-gray-50/50 dark:bg-slate-800/50 text-[10px] uppercase font-black text-gray-500 dark:text-slate-400">
                            <tr>
                                <th className="px-6 py-4">Vendedor</th>
                                <th className="px-6 py-4">Status</th>
                                <th className="px-6 py-4">Telefone</th>
                                <th className="px-6 py-4 text-right">Ações</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
                            {filtered.map(person => (
                                <tr key={person.id} className="hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors group">
                                    <td className="px-6 py-4">
                                        <div className="flex items-center gap-3">
                                            <div className="w-10 h-10 rounded-xl bg-indigo-100 text-indigo-600 flex items-center justify-center font-bold">
                                                {person.full_name?.charAt(0)}
                                            </div>
                                            <div>
                                                <p className="font-bold text-sm text-gray-800 dark:text-slate-200">{person.full_name}</p>
                                                <p className="text-xs text-gray-400 dark:text-slate-500">{person.email}</p>
                                            </div>
                                        </div>
                                    </td>
                                    <td className="px-6 py-4">
                                        <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wide border ${person.status === 'Ativo' ? 'bg-emerald-50 text-emerald-600 border-emerald-100 dark:bg-emerald-900/20 dark:border-emerald-900/30' : 'bg-red-50 text-red-600 border-red-100'}`}>
                                            {person.status || 'Ativo'}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4">
                                        <span className="text-xs font-bold text-gray-600 dark:text-slate-300">{person.phone || '-'}</span>
                                    </td>
                                    <td className="px-6 py-4 text-right">
                                        <button
                                            onClick={() => handleEdit(person)}
                                            className="p-2 text-gray-400 hover:text-tenant-primary hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg transition-all"
                                        >
                                            <Briefcase size={18} />
                                        </button>
                                    </td>
                                </tr>
                            ))}
                            {filtered.length === 0 && !loading && (
                                <tr>
                                    <td colSpan={4} className="px-6 py-12 text-center text-gray-400">
                                        Nenhum vendedor encontrado.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Edit Modal */}
            {isModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
                    <div className="bg-white dark:bg-slate-900 w-full max-w-md rounded-[2rem] shadow-2xl border border-gray-100 dark:border-slate-800 overflow-hidden">
                        <div className="p-6 border-b dark:border-slate-800 flex justify-between items-center">
                            <h3 className="text-lg font-black text-gray-800 dark:text-white">Editar Vendedor</h3>
                            <button onClick={() => setIsModalOpen(false)} className="p-2 hover:bg-black/5 rounded-xl transition-colors">
                                <X size={20} className="text-gray-500" />
                            </button>
                        </div>
                        <div className="p-8 space-y-4">
                            <Input label="Nome" value={formData.name} onChange={(e: any) => setFormData({...formData, name: e.target.value})} icon={<Users size={16} />} />
                            <Input label="Telefone" value={formData.phone} onChange={(e: any) => setFormData({...formData, phone: e.target.value})} icon={<Phone size={16} />} />
                            
                            <div className="space-y-1.5">
                                <label className="text-[10px] font-black uppercase tracking-widest text-gray-400 ml-1">Status</label>
                                <select 
                                    value={formData.status}
                                    onChange={e => setFormData({...formData, status: e.target.value})}
                                    className="w-full px-4 py-3 bg-gray-50 dark:bg-slate-800 border-none rounded-xl text-sm font-bold outline-none focus:ring-2 focus:ring-tenant-primary"
                                >
                                    <option value="Ativo">Ativo</option>
                                    <option value="Inativo">Inativo</option>
                                </select>
                            </div>
                        </div>
                        <div className="p-6 border-t dark:border-slate-800 flex justify-end gap-3">
                            <button onClick={() => setIsModalOpen(false)} className="px-6 py-3 text-xs font-bold text-gray-400 uppercase tracking-widest">Cancelar</button>
                            <button onClick={handleSave} className="bg-tenant-primary text-white px-8 py-3 rounded-xl font-bold text-xs uppercase tracking-widest shadow-lg shadow-tenant-primary/20">
                                {isSaving ? <RefreshCw className="animate-spin" /> : <Save size={16} />} Salvar
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Invite Modal */}
            {isInviteModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
                    <div className="bg-white dark:bg-slate-900 w-full max-w-md rounded-[2rem] shadow-2xl border border-gray-100 dark:border-slate-800 overflow-hidden relative">
                        <button
                            onClick={() => setIsInviteModalOpen(false)}
                            className="absolute top-4 right-4 p-2 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-full transition-colors z-10"
                        >
                            <X size={20} className="text-gray-400" />
                        </button>
                        <CommercialInviteGenerator tenantId={tenantId || ''} />
                    </div>
                </div>
            )}
        </div>
    );
};

const Input = ({ label, value, onChange, icon }: any) => (
    <div className="space-y-1.5">
        <label className="text-[10px] font-black uppercase tracking-widest text-gray-400 ml-1">{label}</label>
        <div className="relative">
            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">{icon}</div>
            <input 
                type="text" 
                value={value} 
                onChange={onChange}
                className="w-full pl-10 pr-4 py-3 bg-gray-50 dark:bg-slate-800 border-none rounded-xl text-sm font-bold outline-none focus:ring-2 focus:ring-tenant-primary"
            />
        </div>
    </div>
);

export default CommercialManagement;
