import React, { useState } from 'react';
import { supabase } from '../../lib/supabase';
import { Building2, User, Mail, Globe, CheckCircle, AlertTriangle, X } from 'lucide-react';

interface ProvisionTenantModalProps {
    isOpen: boolean;
    onClose: () => void;
    leadData: { name: string; email: string; school_name: string; id: string } | null;
    onSuccess: () => void;
}

const ProvisionTenantModal: React.FC<ProvisionTenantModalProps> = ({ isOpen, onClose, leadData, onSuccess }) => {
    const [step, setStep] = useState(1);
    const [loading, setLoading] = useState(false);
    const [formData, setFormData] = useState({
        schoolName: leadData?.school_name || '',
        slug: '',
        adminName: leadData?.name || '',
        adminEmail: leadData?.email || '',
        planId: 'pro' // Default plan, could be dynamic
    });

    const [generatedLink, setGeneratedLink] = useState('');

    if (!isOpen) return null;

    // Helper to slugify name
    const generateSlug = (name: string) => {
        return name.toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // Remove accents
            .replace(/[^a-z0-9]/g, '-') // Replace non-alphanum with -
            .replace(/-+/g, '-') // Replace multiple - with single -
            .replace(/^-|-$/g, ''); // Remove leading/trailing -
    };

    const handleCreateTenant = async () => {
        setLoading(true);
        try {
            // 1. Create Tenant (INSERT directly if RLS allows Super Admin, otherwise RPC might be safer but lets try direct)
            const slug = formData.slug || generateSlug(formData.schoolName);

            // Note: In real app, we need to handle UUID creation or let DB do it. 
            // We'll let DB generate ID.
            const { data: tenant, error: tenantError } = await supabase
                .from('tenants')
                .insert({
                    name: formData.schoolName,
                    slug: slug,
                    domain: `${slug}.wisewolf.com.br`, // Mock domain logic
                    plan_id: null, // We need to fetch plan UUID first, or just null for now
                    owner_email: formData.adminEmail, // Used for recovery/contact
                    saas_status: 'active'
                })
                .select()
                .single();

            if (tenantError) throw tenantError;

            // 2. Create Admin User (Ideally, we just create a Profile waiting for Auth signup? 
            // OR we use Supabase Admin API which is not available in client.
            // WORKAROUND: We create a 'pending_invite' or we just give the link to the user to signup.
            // For this flow, we will assume we generate a special signup link for this tenant.

            const inviteLink = `${window.location.origin}/signup?tenant=${tenant.slug}&email=${encodeURIComponent(formData.adminEmail)}&role=SCHOOL_ADMIN`;
            setGeneratedLink(inviteLink);

            // 3. Update SaaS Lead status to CLOSED (Active)
            if (leadData?.id) {
                await supabase.from('saas_leads').update({ status: 'CLOSED' }).eq('id', leadData.id);
            }

            setStep(2);
        } catch (error: any) {
            console.error('Provisioning Error:', error);
            alert('Erro ao provisionar escola: ' + error.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in">
            <div className="bg-white dark:bg-slate-900 w-full max-w-lg rounded-3xl p-8 border border-slate-200 dark:border-slate-800 shadow-2xl">
                <div className="flex justify-between items-center mb-6">
                    <h3 className="text-2xl font-black text-slate-800 dark:text-white flex items-center gap-2">
                        {step === 1 ? <Building2 className="text-indigo-600" /> : <CheckCircle className="text-emerald-500" />}
                        {step === 1 ? 'Provisionar Nova Escola' : 'Escola Criada!'}
                    </h3>
                    <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-full text-slate-500">
                        <X size={20} />
                    </button>
                </div>

                {step === 1 ? (
                    <div className="space-y-4">
                        <div className="space-y-2">
                            <label className="text-xs font-bold text-slate-500 uppercase">Nome da Escola</label>
                            <input
                                value={formData.schoolName}
                                onChange={e => setFormData({ ...formData, schoolName: e.target.value, slug: generateSlug(e.target.value) })}
                                className="w-full bg-slate-50 dark:bg-slate-800 border-none rounded-xl px-4 py-3 font-bold outline-none"
                            />
                        </div>
                        <div className="space-y-2">
                            <label className="text-xs font-bold text-slate-500 uppercase">Subdomínio (Slug)</label>
                            <div className="flex items-center bg-slate-50 dark:bg-slate-800 rounded-xl px-4 py-3 border border-slate-200 dark:border-slate-700">
                                <Globe size={16} className="text-slate-400 mr-2" />
                                <span className="text-slate-400 font-medium">wisewolf.com/</span>
                                <input
                                    value={formData.slug}
                                    onChange={e => setFormData({ ...formData, slug: e.target.value })}
                                    className="bg-transparent border-none font-bold outline-none text-indigo-600 w-full ml-1"
                                />
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <label className="text-xs font-bold text-slate-500 uppercase">Nome Admin</label>
                                <input
                                    value={formData.adminName}
                                    onChange={e => setFormData({ ...formData, adminName: e.target.value })}
                                    className="w-full bg-slate-50 dark:bg-slate-800 border-none rounded-xl px-4 py-3 font-bold outline-none"
                                />
                            </div>
                            <div className="space-y-2">
                                <label className="text-xs font-bold text-slate-500 uppercase">Email Admin</label>
                                <input
                                    value={formData.adminEmail}
                                    onChange={e => setFormData({ ...formData, adminEmail: e.target.value })}
                                    className="w-full bg-slate-50 dark:bg-slate-800 border-none rounded-xl px-4 py-3 font-bold outline-none"
                                />
                            </div>
                        </div>

                        <div className="bg-amber-50 text-amber-700 p-4 rounded-xl text-xs font-medium flex gap-2">
                            <AlertTriangle size={16} className="shrink-0" />
                            <p>Ao confirmar, um novo ambiente isolado sera criado e o link de acesso será gerado.</p>
                        </div>

                        <button
                            onClick={handleCreateTenant}
                            disabled={loading}
                            className="w-full py-4 bg-indigo-600 text-white rounded-xl font-black text-sm uppercase tracking-widest shadow-lg shadow-indigo-600/20 hover:scale-[1.02] active:scale-[0.98] transition-all disabled:opacity-50"
                        >
                            {loading ? 'Criando Ambiente...' : 'Confirmar e Criar'}
                        </button>
                    </div>
                ) : (
                    <div className="text-center py-6">
                        <p className="text-slate-500 mb-6">Ambiente criado com sucesso! Envie este link para o dono da escola completar o cadastro.</p>

                        <div className="bg-slate-100 dark:bg-slate-800 p-4 rounded-xl flex items-center justify-between gap-2 mb-6 break-all">
                            <code className="text-xs font-mono text-indigo-600">{generatedLink}</code>
                            <button
                                onClick={() => navigator.clipboard.writeText(generatedLink)}
                                className="text-xs font-bold bg-white shadow-sm px-3 py-1 rounded-lg text-slate-600 hover:text-indigo-600"
                            >
                                Copiar
                            </button>
                        </div>

                        <button
                            onClick={() => { onSuccess(); onClose(); }}
                            className="w-full py-3 bg-slate-100 hover:bg-slate-200 text-slate-600 font-bold rounded-xl transition-colors"
                        >
                            Fechar
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};

export default ProvisionTenantModal;
