import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { Search, MoreHorizontal, User, Lock, Unlock, Shield, Trash2 } from 'lucide-react';

interface Tenant {
    id: string;
    name: string;
    slug: string;
    plan_id?: string;
    saas_status?: 'active' | 'blocked' | 'trial' | 'past_due';
    created_at: string;
    // Joined fields
    owner_email?: string;
}

const SaasTenantManager: React.FC = () => {
    const [tenants, setTenants] = useState<Tenant[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');

    useEffect(() => {
        fetchTenants();
    }, []);

    const fetchTenants = async () => {
        try {
            // Fetch tenants
            const { data, error } = await supabase
                .from('tenants')
                .select('*')
                .order('created_at', { ascending: false });

            if (error) throw error;
            setTenants(data || []);
        } catch (error) {
            console.error('Error fetching tenants:', error);
        } finally {
            setLoading(false);
        }
    };

    const toggleStatus = async (id: string, currentStatus: string) => {
        const newStatus = currentStatus === 'blocked' ? 'active' : 'blocked';
        try {
            const { error } = await supabase
                .from('tenants')
                .update({ saas_status: newStatus })
                .eq('id', id);

            if (error) throw error;
            setTenants(prev => prev.map(t => t.id === id ? { ...t, saas_status: newStatus as any } : t));
        } catch (error) {
            console.error('Error updating status', error);
            alert('Erro ao atualizar status');
        }
    };

    const filteredTenants = tenants.filter(t =>
        t.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        t.slug.toLowerCase().includes(searchTerm.toLowerCase())
    );

    return (
        <div className="space-y-6">
            <div className="flex justify-between items-center">
                <div>
                    <h2 className="text-2xl font-bold text-slate-800 dark:text-white">Gestão de Escolas (Tenants)</h2>
                    <p className="text-sm text-slate-500">Controle de acesso e planos das unidades</p>
                </div>
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                    <input
                        className="pl-10 pr-4 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl outline-none focus:ring-2 focus:ring-blue-100"
                        placeholder="Buscar escola..."
                        value={searchTerm}
                        onChange={e => setSearchTerm(e.target.value)}
                    />
                </div>
            </div>

            <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-sm border border-slate-100 dark:border-slate-800 overflow-hidden">
                <table className="w-full text-left text-sm">
                    <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-800 text-slate-500 font-medium">
                        <tr>
                            <th className="p-4 pl-6">Escola</th>
                            <th className="p-4">Slug (URL)</th>
                            <th className="p-4">Plano</th>
                            <th className="p-4">Status</th>
                            <th className="p-4 text-right pr-6">Ações</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800 text-slate-700 dark:text-slate-300">
                        {filteredTenants.map(tenant => (
                            <tr key={tenant.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
                                <td className="p-4 pl-6 font-bold">{tenant.name}</td>
                                <td className="p-4"><code className="bg-slate-100 dark:bg-slate-800 px-2 py-1 rounded text-xs">/{tenant.slug}</code></td>
                                <td className="p-4">
                                    <span className="px-2 py-1 rounded-full bg-blue-50 text-blue-600 text-xs font-bold border border-blue-100">
                                        {tenant.plan_id ? 'PRO' : 'Starter'} {/* Mock Plan Name */}
                                    </span>
                                </td>
                                <td className="p-4">
                                    {tenant.saas_status === 'blocked' ? (
                                        <span className="flex items-center gap-1 text-red-500 font-bold text-xs"><Lock size={12} /> Bloqueado</span>
                                    ) : (
                                        <span className="flex items-center gap-1 text-emerald-500 font-bold text-xs"><Shield size={12} /> Ativo</span>
                                    )}
                                </td>
                                <td className="p-4 text-right pr-6">
                                    <div className="flex justify-end gap-2">
                                        <button
                                            onClick={() => toggleStatus(tenant.id, tenant.saas_status || 'active')}
                                            className={`p-2 rounded-lg transition-colors ${tenant.saas_status === 'blocked' ? 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100' : 'bg-red-50 text-red-600 hover:bg-red-100'}`}
                                            title={tenant.saas_status === 'blocked' ? 'Desbloquear' : 'Bloquear Acesso'}
                                        >
                                            {tenant.saas_status === 'blocked' ? <Unlock size={14} /> : <Lock size={14} />}
                                        </button>
                                        <button className="p-2 bg-slate-100 hover:bg-slate-200 text-slate-500 rounded-lg">
                                            <MoreHorizontal size={14} />
                                        </button>
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {filteredTenants.length === 0 && (
                    <div className="p-12 text-center text-slate-400">
                        Nenhuma escola encontrada.
                    </div>
                )}
            </div>
        </div>
    );
};

export default SaasTenantManager;
