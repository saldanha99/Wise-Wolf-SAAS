import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Users, Plus, Edit3, Trash2, Calendar, DollarSign, BookOpen, Link, Copy } from 'lucide-react';

const StudentPlansManager: React.FC = () => {
    const [plans, setPlans] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingPlan, setEditingPlan] = useState<any>(null);
    const [tenantId, setTenantId] = useState<string | null>(null);
    const [userRole, setUserRole] = useState<string>('');

    // Form State
    const [formData, setFormData] = useState({
        name: '',
        description: '',
        classes_per_week: 2,
        fidelity_months: 12,
        monthly_price: 271,
        // original_price removed from new schema or optional? Schema has monthly_price. Let's keep original_price as potential metadata or remove if not in schema. 
        // My refined schema didn't explicitly remove standard columns, but created a new table. 
        // Let's assume student_plans has simpler structure or I should double check. 
        // The refined SQL has: id, tenant_id, name, description, lessons_per_week, contract_duration, monthly_price, active, landing_page_slug.
        // So I should map classes_per_week -> lessons_per_week, fidelity_months -> contract_duration.
        lessons_per_week: 2,
        contract_duration: 12,
        landing_page_slug: '',
        is_active: true
    });

    useEffect(() => {
        getCurrentUser();
    }, []);

    useEffect(() => {
        if (tenantId || userRole === 'super_admin') {
            fetchPlans();
        }
    }, [tenantId, userRole]);

    const getCurrentUser = async () => {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
            setTenantId(user.app_metadata?.tenant_id || null);
            setUserRole(user.app_metadata?.role || 'admin');
        }
    };

    const fetchPlans = async () => {
        setLoading(true);
        let query = supabase
            .from('student_plans')
            .select('*');

        if (userRole === 'super_admin') {
            // Super admin sees all plans (global and tenant-specific)
            // No additional filter needed here, as select('*') already does this.
        } else if (tenantId) {
            // Regular admin sees global templates and their own tenant's plans
            query = query.or(`tenant_id.is.null,tenant_id.eq.${tenantId}`);
        } else {
            // Should not happen if user is logged in, but as a fallback, show nothing or only global
            query = query.is('tenant_id', null);
        }

        const { data, error } = await query.order('monthly_price', { ascending: true });

        if (!error) {
            setPlans(data || []);
        }
        setLoading(false);
    };

    const handleEdit = (plan: any) => {
        // Prevent editing global templates if not super_admin
        if (!plan.tenant_id && userRole !== 'super_admin') return;

        setEditingPlan(plan);
        setFormData({
            name: plan.name,
            description: plan.description || '',
            lessons_per_week: plan.lessons_per_week,
            contract_duration: plan.contract_duration,
            monthly_price: plan.monthly_price,
            landing_page_slug: plan.landing_page_slug || '',
            is_active: plan.is_active
        });
        setIsModalOpen(true);
    };

    const handleClone = (plan: any) => {
        setEditingPlan(null); // Clone as new
        setFormData({
            name: `${plan.name} (Cópia)`,
            description: plan.description || '',
            lessons_per_week: plan.lessons_per_week,
            contract_duration: plan.contract_duration,
            monthly_price: plan.monthly_price,
            landing_page_slug: '', // Reset slug for new plan
            is_active: true
        });
        setIsModalOpen(true);
    };

    const handleAddNew = () => {
        setEditingPlan(null);
        setFormData({
            name: 'Novo Plano',
            description: '',
            lessons_per_week: 2,
            contract_duration: 12,
            monthly_price: 271,
            landing_page_slug: '',
            is_active: true
        });
        setIsModalOpen(true);
    };

    const handleSave = async () => {
        try {
            // Auto-generate slug if empty
            let slugToSave = formData.landing_page_slug;
            if (!slugToSave && formData.name) {
                slugToSave = formData.name.toLowerCase().replace(/ /g, '-').replace(/[^\w-]+/g, '');
            }

            // Prepare payload
            // If super_admin, can create Global (null) or specific. For now assume super_admin creates Global defaults if no tenant context? 
            // Or better: Current Logic -> If I have a tenant_id, I use it. 
            // But if I am a "School Admin" I MUST use my tenant_id.

            const payload: any = {
                ...formData,
                landing_page_slug: slugToSave
            };

            // If regular admin (not super), force tenant_id
            if (userRole !== 'super_admin' && tenantId) {
                payload.tenant_id = tenantId;
            }
            // If super_admin, keep it null for Global Templates (implicit behavior for now)

            if (editingPlan) {
                const { error } = await supabase
                    .from('student_plans')
                    .update(payload)
                    .eq('id', editingPlan.id);
                if (error) throw error;
            } else {
                const { error } = await supabase
                    .from('student_plans')
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
            const { error } = await supabase.from('student_plans').delete().eq('id', id);
            if (error) throw error;
            fetchPlans();
        } catch (err: any) {
            alert('Erro ao excluir: ' + err.message);
        }
    };

    const generateUrl = (slug: string) => {
        return `https://seudominio.com/checkout/${slug}`;
    };

    return (
        <div className="space-y-6">
            <div className="flex justify-between items-center">
                <div>
                    <h3 className="text-xl font-black text-slate-800 dark:text-white tracking-tight flex items-center gap-2">
                        <Users className="text-blue-500" size={24} />
                        Planos de Alunos
                    </h3>
                    <p className="text-slate-500 text-xs mt-1">
                        {userRole === 'super_admin' ? 'Gerencie os Templates Globais' : 'Gerencie os planos da sua escola'}
                    </p>
                </div>
                <button
                    onClick={handleAddNew}
                    className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-xl text-xs font-black uppercase tracking-widest flex items-center gap-2 shadow-lg shadow-blue-500/20 transition-all hover:scale-105 active:scale-95"
                >
                    <Plus size={16} /> Novo Plano
                </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {loading ? (
                    <p className="text-slate-400 text-xs">Carregando planos...</p>
                ) : plans.map((plan) => {
                    const isGlobal = !plan.tenant_id;
                    const canEdit = isGlobal ? userRole === 'super_admin' : true; // Tenant can edit their own

                    return (
                        <div key={plan.id} className={`group bg-white dark:bg-slate-900 border ${isGlobal ? 'border-purple-200 dark:border-purple-900/30' : 'border-slate-100 dark:border-slate-800'} rounded-[2.5rem] p-6 relative overflow-hidden transition-all hover:shadow-xl hover:border-blue-500/20`}>
                            <div className={`absolute top-0 right-0 w-24 h-24 bg-gradient-to-br ${plan.is_active ? 'from-blue-500/10 to-indigo-500/10' : 'from-slate-500/10 to-gray-500/10'} rounded-bl-[2.5rem] transition-colors`} />

                            <div className="flex justify-between items-start mb-4 relative z-10">
                                <div className="max-w-[70%]">
                                    {isGlobal && (
                                        <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-100 text-purple-600 text-[9px] font-black uppercase tracking-wider mb-2">
                                            Template Global
                                        </div>
                                    )}
                                    <h4 className="font-black text-slate-800 dark:text-white text-lg break-words">{plan.name}</h4>
                                    <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider mt-1 ${plan.is_active ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-500'}`}>
                                        {plan.is_active ? 'Ativo' : 'Inativo'}
                                    </div>
                                </div>
                                <div className="flex gap-2 min-w-[70px] justify-end">
                                    {/* Edit Button - Only if can Edit */}
                                    {canEdit && (
                                        <>
                                            <button onClick={() => handleEdit(plan)} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg text-slate-400 hover:text-blue-500 transition-colors">
                                                <Edit3 size={16} />
                                            </button>
                                            <button onClick={() => handleDelete(plan.id)} className="p-2 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg text-slate-400 hover:text-red-500 transition-colors">
                                                <Trash2 size={16} />
                                            </button>
                                        </>
                                    )}

                                    {/* Clone Button - If Global and User is NOT Super Admin (so they can use it) */}
                                    {isGlobal && userRole !== 'super_admin' && (
                                        <button onClick={() => handleClone(plan)} className="p-2 bg-blue-50 hover:bg-blue-100 text-blue-600 rounded-lg transition-colors" title="Usar Modelo">
                                            <Copy size={16} />
                                        </button>
                                    )}
                                </div>
                            </div>

                            <div className="space-y-3 mb-6 relative z-10">
                                <div className="flex items-center gap-3 text-slate-600 dark:text-slate-400 text-xs font-medium">
                                    <BookOpen size={14} className="text-blue-500" />
                                    <span>{plan.lessons_per_week} Aulas / Semana</span>
                                </div>
                                <div className="flex items-center gap-3 text-slate-600 dark:text-slate-400 text-xs font-medium">
                                    <Calendar size={14} className="text-purple-500" />
                                    <span>Fidelidade: {plan.contract_duration} Meses</span>
                                </div>
                                {plan.landing_page_slug && (
                                    <div className="flex items-center gap-3 text-slate-600 dark:text-slate-400 text-xs font-medium">
                                        <Link size={14} className="text-emerald-500" />
                                        <span className="truncate max-w-[150px]">{plan.landing_page_slug}</span>
                                    </div>
                                )}
                            </div>

                            <div className="pt-4 border-t border-slate-50 dark:border-slate-800 relative z-10">
                                <div className="flex items-baseline gap-1">
                                    <span className="text-2xl font-black text-slate-800 dark:text-white text-blue-600">R$ {plan.monthly_price}</span>
                                    <span className="text-xs font-bold text-slate-400">/mês</span>
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Modal */}
            {isModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in">
                    <div className="bg-white dark:bg-slate-900 w-full max-w-2xl rounded-[2.5rem] p-8 border border-slate-200 dark:border-slate-800 shadow-2xl overflow-y-auto max-h-[90vh]">
                        <h3 className="text-2xl font-black text-slate-800 dark:text-white mb-6">
                            {editingPlan ? 'Editar Modelo de Plano' : 'Novo Modelo de Plano'}
                        </h3>
                        {/* Form Inputs (Same as before but wrapped in logic to display correctly) */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                            <div className="col-span-1 md:col-span-2 space-y-2">
                                <label className="text-xs font-black text-slate-500 uppercase tracking-widest">Nome do Plano</label>
                                <input
                                    type="text"
                                    value={formData.name}
                                    onChange={e => setFormData({ ...formData, name: e.target.value })}
                                    className="w-full bg-slate-50 dark:bg-slate-800 border-none rounded-xl px-4 py-3 font-bold outline-none focus:ring-2 focus:ring-blue-600"
                                    placeholder="Ex: Start 2x Semanal"
                                />
                            </div>
                            <div className="space-y-2">
                                <label className="text-xs font-black text-slate-500 uppercase tracking-widest">Aulas por Semana</label>
                                <input
                                    type="number"
                                    value={formData.lessons_per_week}
                                    onChange={e => setFormData({ ...formData, lessons_per_week: Number(e.target.value) })}
                                    className="w-full bg-slate-50 dark:bg-slate-800 border-none rounded-xl px-4 py-3 font-bold outline-none focus:ring-2 focus:ring-blue-600"
                                />
                            </div>
                            <div className="space-y-2">
                                <label className="text-xs font-black text-slate-500 uppercase tracking-widest">Fidelidade (Meses)</label>
                                <input
                                    type="number"
                                    value={formData.contract_duration}
                                    onChange={e => setFormData({ ...formData, contract_duration: Number(e.target.value) })}
                                    className="w-full bg-slate-50 dark:bg-slate-800 border-none rounded-xl px-4 py-3 font-bold outline-none focus:ring-2 focus:ring-blue-600"
                                />
                            </div>
                            <div className="space-y-2">
                                <label className="text-xs font-black text-slate-500 uppercase tracking-widest">Preço Mensal (R$)</label>
                                <input
                                    type="number"
                                    value={formData.monthly_price}
                                    onChange={e => setFormData({ ...formData, monthly_price: Number(e.target.value) })}
                                    className="w-full bg-slate-50 dark:bg-slate-800 border-none rounded-xl px-4 py-3 font-bold outline-none focus:ring-2 focus:ring-blue-600"
                                />
                            </div>
                            <div className="col-span-1 md:col-span-2 space-y-2">
                                <label className="text-xs font-black text-slate-500 uppercase tracking-widest">Slug da Landing Page (URL)</label>
                                <div className="flex items-center gap-2">
                                    <span className="text-slate-400 text-xs font-bold">.../checkout/</span>
                                    <input
                                        type="text"
                                        value={formData.landing_page_slug}
                                        onChange={e => setFormData({ ...formData, landing_page_slug: e.target.value })}
                                        className="w-full bg-slate-50 dark:bg-slate-800 border-none rounded-xl px-4 py-3 font-bold outline-none focus:ring-2 focus:ring-blue-600"
                                        placeholder="(Auto-gerado se vazio)"
                                    />
                                </div>
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
                                    onClick={() => setFormData({ ...formData, is_active: !formData.is_active })}
                                    className={`w-12 h-6 rounded-full transition-colors relative ${formData.is_active ? 'bg-blue-600' : 'bg-slate-300'}`}
                                >
                                    <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${formData.is_active ? 'left-7' : 'left-1'}`} />
                                </button>
                                <span className="text-sm font-bold text-slate-600 dark:text-slate-400">Modelo Ativo?</span>
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
                                className="flex-1 py-4 bg-blue-600 text-white rounded-xl font-black text-xs uppercase tracking-widest shadow-lg shadow-blue-500/20 hover:scale-[1.02] active:scale-[0.98] transition-all"
                            >
                                Salvar Modelo
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default StudentPlansManager;
