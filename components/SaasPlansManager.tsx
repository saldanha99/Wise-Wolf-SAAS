import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Package, Plus, Edit3, Trash2, HardDrive, Users, Shield } from 'lucide-react';

const SaasPlansManager: React.FC = () => {
    const [plans, setPlans] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingPlan, setEditingPlan] = useState<any>(null);

    // Form State
    const [formData, setFormData] = useState({
        name: '',
        description: '',
        storage_limit_gb: 5,
        max_students: 50,
        max_users: 1,
        price: 0,
        price_yearly: 0,
        active: true
    });

    useEffect(() => {
        fetchPlans();
    }, []);

    const fetchPlans = async () => {
        setLoading(true);
        const { data, error } = await supabase
            .from('saas_plans')
            .select('*')
            .order('price', { ascending: true });

        if (!error) {
            setPlans(data || []);
        }
        setLoading(false);
    };

    const handleEdit = (plan: any) => {
        setEditingPlan(plan);
        setFormData({
            name: plan.name,
            description: plan.description || '',
            storage_limit_gb: plan.max_storage_gb, // Note mapping: max_storage_gb in DB
            max_students: plan.max_students,
            max_users: plan.max_users,
            price: plan.price,
            price_yearly: plan.price_yearly || 0,
            active: plan.active
        });
        setIsModalOpen(true);
    };

    const handleAddNew = () => {
        setEditingPlan(null);
        setFormData({
            name: '',
            description: '',
            storage_limit_gb: 5,
            max_students: 50,
            max_users: 1,
            price: 197,
            price_yearly: 1997,
            active: true
        });
        setIsModalOpen(true);
    };

    const handleSave = async () => {
        try {
            const payload = {
                name: formData.name,
                description: formData.description,
                max_storage_gb: formData.storage_limit_gb,
                max_students: formData.max_students,
                max_users: formData.max_users,
                price: formData.price,
                price_yearly: formData.price_yearly,
                active: formData.active
            };

            if (editingPlan) {
                const { error } = await supabase
                    .from('saas_plans')
                    .update(payload)
                    .eq('id', editingPlan.id);
                if (error) throw error;
            } else {
                const { error } = await supabase
                    .from('saas_plans')
                    .insert([payload]);
                if (error) throw error;
            }
            setIsModalOpen(false);
            fetchPlans();
        } catch (err: any) {
            alert('Erro ao salvar plano: ' + err.message);
        }
    };

    const handleDelete = async (id: string) => {
        if (!confirm('Tem certeza que deseja excluir este plano?')) return;
        try {
            const { error } = await supabase.from('saas_plans').delete().eq('id', id);
            if (error) throw error;
            fetchPlans();
        } catch (err: any) {
            alert('Erro ao excluir: ' + err.message);
        }
    };

    return (
        <div className="space-y-6">
            <div className="flex justify-between items-center">
                <div>
                    <h3 className="text-xl font-black text-slate-800 dark:text-white tracking-tight flex items-center gap-2">
                        <Package className="text-blue-600" size={24} />
                        Planos SaaS (Infraestrutura)
                    </h3>
                    <p className="text-slate-500 text-xs mt-1">Defina os tiers, limites e preços da plataforma.</p>
                </div>
                <button
                    onClick={handleAddNew}
                    className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-xl text-xs font-black uppercase tracking-widest flex items-center gap-2 shadow-lg transition-all"
                >
                    <Plus size={16} /> Novo Plano
                </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {loading ? (
                    <p className="text-slate-400 text-xs">Carregando planos...</p>
                ) : plans.map((plan) => (
                    <div key={plan.id} className="group bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 rounded-[2.5rem] p-6 relative overflow-hidden transition-all hover:shadow-xl hover:border-blue-200">
                        <div className={`absolute top-0 right-0 w-24 h-24 bg-gradient-to-br ${plan.active ? 'from-emerald-500/10 to-teal-500/10' : 'from-slate-500/10 to-gray-500/10'} rounded-bl-[2.5rem] transition-colors`} />

                        <div className="flex justify-between items-start mb-4 relative z-10">
                            <div>
                                <h4 className="font-black text-slate-800 dark:text-white text-lg">{plan.name}</h4>
                                <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider mt-1 ${plan.active ? 'bg-emerald-100 text-emerald-600' : 'bg-slate-100 text-slate-500'}`}>
                                    {plan.active ? 'Ativo' : 'Inativo'}
                                </div>
                            </div>
                            <div className="flex gap-2">
                                <button onClick={() => handleEdit(plan)} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg text-slate-400 hover:text-blue-500 transition-colors">
                                    <Edit3 size={16} />
                                </button>
                                <button onClick={() => handleDelete(plan.id)} className="p-2 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg text-slate-400 hover:text-red-500 transition-colors">
                                    <Trash2 size={16} />
                                </button>
                            </div>
                        </div>

                        <div className="space-y-3 mb-6 relative z-10">
                            <div className="flex items-center gap-3 text-slate-600 dark:text-slate-400 text-xs font-medium">
                                <HardDrive size={14} className="text-blue-600" />
                                <span>{plan.max_storage_gb} GB Armazenamento</span>
                            </div>
                            <div className="flex items-center gap-3 text-slate-600 dark:text-slate-400 text-xs font-medium">
                                <Users size={14} className="text-blue-500" />
                                <span>Até {plan.max_students} Alunos</span>
                            </div>
                            <div className="flex items-center gap-3 text-slate-600 dark:text-slate-400 text-xs font-medium">
                                <Shield size={14} className="text-purple-500" />
                                <span>{plan.max_users} Usuários Admin</span>
                            </div>
                        </div>

                        <div className="pt-4 border-t border-slate-50 dark:border-slate-800 relative z-10">
                            <div className="flex items-baseline gap-1">
                                <span className="text-2xl font-black text-slate-800 dark:text-white">R$ {plan.price}</span>
                                <span className="text-xs font-bold text-slate-400">/mês</span>
                            </div>
                            {plan.price_yearly && <p className="text-[10px] text-slate-400 mt-1">Ou R$ {plan.price_yearly} /ano</p>}
                        </div>
                    </div>
                ))}
            </div>

            {/* Modal */}
            {isModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in">
                    <div className="bg-white dark:bg-slate-900 w-full max-w-2xl rounded-[2.5rem] p-8 border border-slate-200 dark:border-slate-800 shadow-2xl overflow-y-auto max-h-[90vh]">
                        <h3 className="text-2xl font-black text-slate-800 dark:text-white mb-6">
                            {editingPlan ? 'Editar Plano' : 'Novo Plano SaaS'}
                        </h3>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                            <div className="space-y-2">
                                <label className="text-xs font-black text-slate-500 uppercase tracking-widest">Nome do Plano</label>
                                <input
                                    type="text"
                                    value={formData.name}
                                    onChange={e => setFormData({ ...formData, name: e.target.value })}
                                    className="w-full bg-slate-50 dark:bg-slate-800 border-none rounded-xl px-4 py-3 font-bold outline-none focus:ring-2 focus:ring-blue-600"
                                    placeholder="Ex: Start, Pro"
                                />
                            </div>
                            <div className="space-y-2">
                                <label className="text-xs font-black text-slate-500 uppercase tracking-widest">Armazenamento (GB)</label>
                                <input
                                    type="number"
                                    value={formData.storage_limit_gb}
                                    onChange={e => setFormData({ ...formData, storage_limit_gb: Number(e.target.value) })}
                                    className="w-full bg-slate-50 dark:bg-slate-800 border-none rounded-xl px-4 py-3 font-bold outline-none focus:ring-2 focus:ring-blue-600"
                                />
                            </div>
                            <div className="space-y-2">
                                <label className="text-xs font-black text-slate-500 uppercase tracking-widest">Max Alunos</label>
                                <input
                                    type="number"
                                    value={formData.max_students}
                                    onChange={e => setFormData({ ...formData, max_students: Number(e.target.value) })}
                                    className="w-full bg-slate-50 dark:bg-slate-800 border-none rounded-xl px-4 py-3 font-bold outline-none focus:ring-2 focus:ring-blue-600"
                                />
                            </div>
                            <div className="space-y-2">
                                <label className="text-xs font-black text-slate-500 uppercase tracking-widest">Max Admin Users</label>
                                <input
                                    type="number"
                                    value={formData.max_users}
                                    onChange={e => setFormData({ ...formData, max_users: Number(e.target.value) })}
                                    className="w-full bg-slate-50 dark:bg-slate-800 border-none rounded-xl px-4 py-3 font-bold outline-none focus:ring-2 focus:ring-blue-600"
                                />
                            </div>
                            <div className="space-y-2">
                                <label className="text-xs font-black text-slate-500 uppercase tracking-widest">Preço Mensal (R$)</label>
                                <input
                                    type="number"
                                    value={formData.price}
                                    onChange={e => setFormData({ ...formData, price: Number(e.target.value) })}
                                    className="w-full bg-slate-50 dark:bg-slate-800 border-none rounded-xl px-4 py-3 font-bold outline-none focus:ring-2 focus:ring-blue-600"
                                />
                            </div>
                            <div className="space-y-2">
                                <label className="text-xs font-black text-slate-500 uppercase tracking-widest">Preço Anual (R$)</label>
                                <input
                                    type="number"
                                    value={formData.price_yearly}
                                    onChange={e => setFormData({ ...formData, price_yearly: Number(e.target.value) })}
                                    className="w-full bg-slate-50 dark:bg-slate-800 border-none rounded-xl px-4 py-3 font-bold outline-none focus:ring-2 focus:ring-blue-600"
                                />
                            </div>
                            <div className="col-span-1 md:col-span-2 space-y-2">
                                <label className="text-xs font-black text-slate-500 uppercase tracking-widest">Descrição</label>
                                <textarea
                                    value={formData.description}
                                    onChange={e => setFormData({ ...formData, description: e.target.value })}
                                    className="w-full h-24 bg-slate-50 dark:bg-slate-800 border-none rounded-xl px-4 py-3 font-bold outline-none focus:ring-2 focus:ring-blue-600 resize-none"
                                />
                            </div>
                            <div className="col-span-1 md:col-span-2 flex items-center gap-3">
                                <button
                                    onClick={() => setFormData({ ...formData, active: !formData.active })}
                                    className={`w-12 h-6 rounded-full transition-colors relative ${formData.active ? 'bg-emerald-500' : 'bg-slate-300'}`}
                                >
                                    <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${formData.active ? 'left-7' : 'left-1'}`} />
                                </button>
                                <span className="text-sm font-bold text-slate-600 dark:text-slate-400">Plano Ativo para Venda?</span>
                            </div>
                        </div>

                        <div className="flex gap-4">
                            <button
                                onClick={() => setIsModalOpen(false)}
                                className="flex-1 py-4 text-slate-500 font-black text-xs uppercase tracking-widest hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl transition-colors"
                            >
                                Cancelar
                            </button>
                            <button
                                onClick={handleSave}
                                className="flex-1 py-4 bg-blue-600 text-white rounded-xl font-black text-xs uppercase tracking-widest shadow-lg shadow-blue-600/20 hover:scale-[1.02] active:scale-[0.98] transition-all"
                            >
                                Salvar Plano
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default SaasPlansManager;
