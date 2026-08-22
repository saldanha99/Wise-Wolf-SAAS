import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import {
    User, Mail, Phone, FileText, CheckCircle, X, Loader2,
    Globe, Zap, TrendingUp, Star, Building2, ArrowRight,
    AlertTriangle, Copy, Check, RefreshCw, ExternalLink,
    ChevronDown, Filter
} from 'lucide-react';

// ─── Tipos ─────────────────────────────────────────────────────────────────

interface TeacherLead {
    id: string;
    owner_name: string | null;
    name: string | null;
    owner_email: string | null;
    email: string | null;
    owner_phone: string | null;
    phone: string | null;
    owner_cpf_cnpj: string | null;
    school_name: string | null;
    plan_interest: string | null;
    status: string;
    lead_type: string;
    parent_tenant_id: string | null;
    notes: string | null;
    created_at: string;
    source: string | null;
    converted_tenant_id: string | null;
}

interface SaasPlan {
    id: string;
    name: string;
    price: number;
    plan_type: string;
}

interface ParentTenant {
    id: string;
    name: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; color: string; dot: string }> = {
    new:          { label: 'Novo',        color: 'bg-blue-500/15 text-blue-300 border-blue-500/20',     dot: 'bg-blue-400' },
    contacted:    { label: 'Contatado',   color: 'bg-amber-500/15 text-amber-300 border-amber-500/20', dot: 'bg-amber-400' },
    trial:        { label: 'Trial',       color: 'bg-purple-500/15 text-purple-300 border-purple-500/20', dot: 'bg-purple-400' },
    active:       { label: 'Ativo',       color: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20', dot: 'bg-emerald-400' },
    CLOSED:       { label: 'Ativo',       color: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20', dot: 'bg-emerald-400' },
    lost:         { label: 'Perdido',     color: 'bg-slate-500/15 text-slate-400 border-slate-500/20',  dot: 'bg-slate-500' },
};

const PLAN_ICON: Record<string, React.ReactNode> = {
    starter: <Zap size={13} />,
    growth:  <TrendingUp size={13} />,
    scale:   <Star size={13} />,
};

const getPlanKey = (name?: string | null) => {
    if (!name) return 'starter';
    const n = name.toLowerCase();
    if (n.includes('scale')) return 'scale';
    if (n.includes('growth')) return 'growth';
    return 'starter';
};

const PLAN_COLORS: Record<string, string> = {
    starter: 'bg-blue-500/10 text-blue-300 border-blue-500/20',
    growth:  'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
    scale:   'bg-amber-500/10 text-amber-300 border-amber-500/20',
};

const generateSlug = (name: string) =>
    name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

// ─── Modal de Ativação ──────────────────────────────────────────────────────

interface ActivateModalProps {
    lead: TeacherLead;
    plans: SaasPlan[];
    onClose: () => void;
    onSuccess: () => void;
}

const ActivateModal: React.FC<ActivateModalProps> = ({ lead, plans, onClose, onSuccess }) => {
    const teacherPlans = plans.filter(p => p.plan_type === 'teacher');
    const displayName = lead.owner_name || lead.name || '';
    const displayEmail = lead.owner_email || lead.email || '';

    const [step, setStep] = useState<'form' | 'done'>('form');
    const [loading, setLoading] = useState(false);
    const [copied, setCopied] = useState(false);
    const [inviteLink, setInviteLink] = useState('');
    const [form, setForm] = useState({
        schoolName: lead.school_name || `Escola de ${displayName}`,
        slug: generateSlug(lead.school_name || displayName),
        adminEmail: displayEmail,
        planId: teacherPlans.find(p => p.name === lead.plan_interest)?.id || teacherPlans[1]?.id || teacherPlans[0]?.id || '',
        sendTrial: true,
    });

    const handleActivate = async () => {
        setLoading(true);
        try {
            // 1. Criar tenant
            const { data: tenant, error: tenantErr } = await supabase
                .from('tenants')
                .insert({
                    name: form.schoolName,
                    slug: form.slug,
                    domain: `${form.slug}.wisewolf.com.br`,
                    owner_email: form.adminEmail,
                    plan_id: form.planId || null,
                    saas_status: form.sendTrial ? 'trial' : 'active',
                    trial_ends_at: form.sendTrial ? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString() : null,
                    tenant_type: 'teacher',
                    parent_tenant_id: lead.parent_tenant_id || null,
                })
                .select('id,slug,trial_ends_at')
                .single();

            if (tenantErr) throw tenantErr;

            // 2. Criar saas_subscription
            if (form.planId) {
                await supabase.from('saas_subscriptions').insert({
                    tenant_id: tenant.id,
                    plan_id: form.planId,
                    status: form.sendTrial ? 'trial' : 'active',
                    trial_ends_at: form.sendTrial ? tenant.trial_ends_at : null,
                    parent_tenant_id: lead.parent_tenant_id || null,
                });
            }

            // 3. Atualizar lead
            await supabase.from('saas_leads').update({
                status: 'CLOSED',
                converted_tenant_id: tenant.id,
            }).eq('id', lead.id);

            // 4. Gerar link de acesso
            const link = `${window.location.origin}/teacher-onboarding?tenant=${tenant.slug}&email=${encodeURIComponent(form.adminEmail)}`;
            setInviteLink(link);
            setStep('done');
            onSuccess();
        } catch (err: any) {
            alert('Erro ao ativar: ' + err.message);
        } finally {
            setLoading(false);
        }
    };

    const copyLink = () => {
        navigator.clipboard.writeText(inviteLink);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
            <div className="bg-slate-900 border border-slate-700 rounded-3xl w-full max-w-lg shadow-2xl">
                {/* Header */}
                <div className="bg-gradient-to-br from-indigo-600 to-purple-700 rounded-t-3xl p-6 text-white flex items-start justify-between">
                    <div>
                        <p className="text-[10px] uppercase tracking-widest opacity-70 mb-1">
                            {step === 'form' ? 'Ativar Teacher Empreendedor' : 'Mini-Escola Criada!'}
                        </p>
                        <h3 className="text-xl font-black">{displayName}</h3>
                        <p className="text-sm opacity-70">{displayEmail}</p>
                    </div>
                    <button onClick={onClose} className="p-2 rounded-xl bg-white/10 hover:bg-white/20 transition-colors">
                        <X size={16} />
                    </button>
                </div>

                {step === 'form' ? (
                    <div className="p-6 space-y-4">
                        <FormField label="Nome da Escola / Marca">
                            <input
                                value={form.schoolName}
                                onChange={e => setForm({ ...form, schoolName: e.target.value, slug: generateSlug(e.target.value) })}
                                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                            />
                        </FormField>

                        <FormField label="Subdomínio (slug)">
                            <div className="flex items-center bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5">
                                <Globe size={14} className="text-slate-500 mr-2 shrink-0" />
                                <span className="text-slate-500 text-sm">wisewolf.com.br/</span>
                                <input
                                    value={form.slug}
                                    onChange={e => setForm({ ...form, slug: e.target.value })}
                                    className="bg-transparent text-sm text-indigo-400 font-bold focus:outline-none flex-1 ml-1"
                                />
                            </div>
                        </FormField>

                        <FormField label="E-mail de acesso do teacher">
                            <input
                                value={form.adminEmail}
                                onChange={e => setForm({ ...form, adminEmail: e.target.value })}
                                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                            />
                        </FormField>

                        <FormField label="Plano">
                            <select
                                value={form.planId}
                                onChange={e => setForm({ ...form, planId: e.target.value })}
                                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                            >
                                <option value="">Sem plano (manual)</option>
                                {teacherPlans.map(p => (
                                    <option key={p.id} value={p.id}>
                                        {p.name} — R${p.price}/mês
                                    </option>
                                ))}
                            </select>
                        </FormField>

                        <label className="flex items-center gap-3 cursor-pointer select-none">
                            <div
                                onClick={() => setForm({ ...form, sendTrial: !form.sendTrial })}
                                className={`w-10 h-5 rounded-full transition-colors ${form.sendTrial ? 'bg-indigo-600' : 'bg-slate-700'} relative`}
                            >
                                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${form.sendTrial ? 'translate-x-5' : 'translate-x-0.5'}`} />
                            </div>
                            <span className="text-sm text-slate-300">Iniciar com 14 dias de trial grátis</span>
                        </label>

                        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-3 flex gap-2">
                            <AlertTriangle size={15} className="text-amber-400 shrink-0 mt-0.5" />
                            <p className="text-xs text-amber-300">Um novo tenant isolado será criado com a marca do professor. O link de acesso será gerado ao confirmar.</p>
                        </div>

                        <button
                            onClick={handleActivate}
                            disabled={loading || !form.schoolName || !form.adminEmail}
                            className="w-full py-3.5 bg-gradient-to-r from-indigo-600 to-purple-600 text-white font-bold rounded-2xl flex items-center justify-center gap-2 disabled:opacity-50 transition-all hover:from-indigo-500 hover:to-purple-500"
                        >
                            {loading ? <><Loader2 className="animate-spin" size={16} /> Criando...</> : <><CheckCircle size={16} /> Ativar Mini-Escola</>}
                        </button>
                    </div>
                ) : (
                    <div className="p-6 text-center">
                        <div className="w-16 h-16 bg-emerald-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
                            <CheckCircle size={32} className="text-emerald-400" />
                        </div>
                        <h4 className="text-lg font-black text-white mb-2">Mini-escola ativada!</h4>
                        <p className="text-sm text-slate-400 mb-6">Envie este link para <b className="text-white">{form.adminEmail}</b> completar o cadastro.</p>

                        <div className="bg-slate-800 rounded-xl p-3 flex items-center gap-2 mb-4 text-left">
                            <code className="text-xs text-indigo-300 flex-1 break-all">{inviteLink}</code>
                            <button onClick={copyLink} className="shrink-0 p-2 rounded-lg bg-slate-700 hover:bg-slate-600 transition-colors text-slate-300">
                                {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                            </button>
                        </div>

                        <button onClick={onClose} className="w-full py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded-2xl transition-colors">
                            Fechar
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};

const FormField = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div>
        <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold block mb-1.5">{label}</label>
        {children}
    </div>
);

// ─── Componente principal ───────────────────────────────────────────────────

const TeacherLeadsPanel: React.FC = () => {
    const [leads, setLeads] = useState<TeacherLead[]>([]);
    const [plans, setPlans] = useState<SaasPlan[]>([]);
    const [parentTenants, setParentTenants] = useState<ParentTenant[]>([]);
    const [loading, setLoading] = useState(true);
    const [filterStatus, setFilterStatus] = useState<string>('all');
    const [activatingLead, setActivatingLead] = useState<TeacherLead | null>(null);
    const [expandedLead, setExpandedLead] = useState<string | null>(null);

    const fetchData = useCallback(async () => {
        setLoading(true);
        try {
            const [leadsRes, plansRes, tenantsRes] = await Promise.all([
                supabase.from('saas_leads').select('*').eq('lead_type', 'teacher').order('created_at', { ascending: false }),
                supabase.from('saas_plans').select('id, name, price, plan_type').eq('plan_type', 'teacher'),
                supabase.from('tenants').select('id, name').eq('tenant_type', 'school'),
            ]);
            setLeads(leadsRes.data || []);
            setPlans(plansRes.data || []);
            setParentTenants(tenantsRes.data || []);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchData(); }, [fetchData]);

    // ── Stats ─────────────────────────────────────────────────────────────

    const stats = {
        total: leads.length,
        new: leads.filter(l => l.status === 'new').length,
        trial: leads.filter(l => l.status === 'trial').length,
        active: leads.filter(l => l.status === 'active' || l.status === 'CLOSED').length,
        mrr: leads
            .filter(l => l.status === 'active' || l.status === 'CLOSED')
            .reduce((acc, l) => {
                const plan = plans.find(p => p.name === l.plan_interest);
                return acc + (plan?.price || 0);
            }, 0),
    };

    // ── Leads filtrados ───────────────────────────────────────────────────

    const filtered = filterStatus === 'all' ? leads : leads.filter(l =>
        filterStatus === 'active' ? (l.status === 'active' || l.status === 'CLOSED') : l.status === filterStatus
    );

    const handleStatusChange = async (leadId: string, newStatus: string) => {
        await supabase.from('saas_leads').update({ status: newStatus }).eq('id', leadId);
        setLeads(prev => prev.map(l => l.id === leadId ? { ...l, status: newStatus } : l));
    };

    if (loading) return (
        <div className="flex items-center justify-center h-64">
            <Loader2 className="animate-spin text-indigo-400" size={32} />
        </div>
    );

    return (
        <div className="space-y-6">
            {/* Stats */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                {[
                    { label: 'Total leads',  value: stats.total,  color: 'text-white' },
                    { label: 'Novos',        value: stats.new,    color: 'text-blue-400' },
                    { label: 'Em trial',     value: stats.trial,  color: 'text-purple-400' },
                    { label: 'Ativos',       value: stats.active, color: 'text-emerald-400' },
                    { label: 'MRR Teacher',  value: `R$${stats.mrr}`, color: 'text-amber-400' },
                ].map((s, i) => (
                    <div key={i} className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
                        <p className="text-xs text-slate-500 mb-1">{s.label}</p>
                        <p className={`text-2xl font-black ${s.color}`}>{s.value}</p>
                    </div>
                ))}
            </div>

            {/* Toolbar */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 flex-wrap">
                    {['all', 'new', 'contacted', 'trial', 'active', 'lost'].map(s => (
                        <button
                            key={s}
                            onClick={() => setFilterStatus(s)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all capitalize ${filterStatus === s ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}`}
                        >
                            {s === 'all' ? 'Todos' : STATUS_CONFIG[s]?.label || s}
                        </button>
                    ))}
                </div>
                <button onClick={fetchData} className="p-2 rounded-xl bg-slate-800 text-slate-400 hover:text-white transition-colors">
                    <RefreshCw size={16} />
                </button>
            </div>

            {/* Link de divulgação */}
            <div className="bg-indigo-500/10 border border-indigo-500/20 rounded-2xl p-4 flex items-center justify-between gap-4">
                <div>
                    <p className="text-xs font-bold text-indigo-300 mb-0.5">Link de captação — compartilhe com seus professores</p>
                    <code className="text-xs text-slate-400">{window.location.origin}/seja-professor</code>
                </div>
                <button
                    onClick={() => { navigator.clipboard.writeText(`${window.location.origin}/seja-professor`); }}
                    className="shrink-0 flex items-center gap-1.5 px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl transition-colors"
                >
                    <Copy size={13} /> Copiar
                </button>
            </div>

            {/* Lista de leads */}
            {filtered.length === 0 ? (
                <div className="text-center py-16 text-slate-500">
                    <User size={40} className="mx-auto mb-3 opacity-30" />
                    <p className="font-bold">Nenhum lead de teacher ainda</p>
                    <p className="text-sm mt-1">Compartilhe o link acima para começar a captar</p>
                </div>
            ) : (
                <div className="space-y-3">
                    {filtered.map(lead => {
                        const name = lead.owner_name || lead.name || '—';
                        const email = lead.owner_email || lead.email || '—';
                        const phone = lead.owner_phone || lead.phone || '—';
                        const planKey = getPlanKey(lead.plan_interest);
                        const statusCfg = STATUS_CONFIG[lead.status] || STATUS_CONFIG['new'];
                        const isExpanded = expandedLead === lead.id;
                        const isActive = lead.status === 'active' || lead.status === 'CLOSED';
                        const parentName = parentTenants.find(t => t.id === lead.parent_tenant_id)?.name;

                        return (
                            <div key={lead.id} className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden transition-all">
                                {/* Linha principal */}
                                <div className="flex items-center gap-4 p-4">
                                    <div className="w-10 h-10 rounded-full bg-indigo-500/20 flex items-center justify-center text-indigo-300 font-black text-sm shrink-0">
                                        {name.charAt(0).toUpperCase()}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <p className="font-bold text-white text-sm">{name}</p>
                                            {lead.plan_interest && (
                                                <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border ${PLAN_COLORS[planKey]}`}>
                                                    {PLAN_ICON[planKey]}
                                                    {lead.plan_interest.replace('Teacher ', '')}
                                                </span>
                                            )}
                                            {parentName && (
                                                <span className="text-[10px] text-slate-500 bg-slate-800 px-2 py-0.5 rounded-full">
                                                    via {parentName}
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-xs text-slate-400 truncate">{email}</p>
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                        <span className={`inline-flex items-center gap-1.5 text-[10px] font-bold px-2.5 py-1 rounded-full border ${statusCfg.color}`}>
                                            <span className={`w-1.5 h-1.5 rounded-full ${statusCfg.dot}`} />
                                            {statusCfg.label}
                                        </span>
                                        {!isActive && (
                                            <button
                                                onClick={() => setActivatingLead(lead)}
                                                className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl transition-colors"
                                            >
                                                <Zap size={12} /> Ativar
                                            </button>
                                        )}
                                        {isActive && lead.converted_tenant_id && (
                                            <span className="flex items-center gap-1 text-xs text-emerald-400 font-semibold">
                                                <CheckCircle size={13} /> Tenant ativo
                                            </span>
                                        )}
                                        <button
                                            onClick={() => setExpandedLead(isExpanded ? null : lead.id)}
                                            className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-slate-800 transition-colors"
                                        >
                                            <ChevronDown size={15} className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                                        </button>
                                    </div>
                                </div>

                                {/* Detalhes expandidos */}
                                {isExpanded && (
                                    <div className="border-t border-slate-800 p-4 grid grid-cols-2 md:grid-cols-4 gap-4 bg-slate-950/40">
                                        <Detail icon={Phone} label="WhatsApp" value={phone} />
                                        <Detail icon={FileText} label="CPF" value={lead.owner_cpf_cnpj || '—'} />
                                        <Detail icon={Building2} label="Escola" value={lead.school_name || '—'} />
                                        <Detail icon={Globe} label="Origem" value={lead.source || '—'} />
                                        {lead.notes && (
                                            <div className="col-span-2 md:col-span-4">
                                                <p className="text-[10px] uppercase tracking-widest text-slate-600 mb-1">Observações</p>
                                                <p className="text-xs text-slate-400">{lead.notes}</p>
                                            </div>
                                        )}
                                        {/* Alterar status */}
                                        <div className="col-span-2 md:col-span-4 flex items-center gap-2 flex-wrap pt-2 border-t border-slate-800">
                                            <p className="text-[10px] uppercase tracking-widest text-slate-600 mr-2">Mover para:</p>
                                            {['new', 'contacted', 'trial', 'lost'].map(s => (
                                                lead.status !== s && (
                                                    <button
                                                        key={s}
                                                        onClick={() => handleStatusChange(lead.id, s)}
                                                        className="px-3 py-1 text-xs font-bold rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors capitalize"
                                                    >
                                                        {STATUS_CONFIG[s]?.label || s}
                                                    </button>
                                                )
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Modal de ativação */}
            {activatingLead && (
                <ActivateModal
                    lead={activatingLead}
                    plans={plans}
                    onClose={() => setActivatingLead(null)}
                    onSuccess={() => { fetchData(); setActivatingLead(null); }}
                />
            )}
        </div>
    );
};

const Detail = ({ icon: Icon, label, value }: { icon: React.ComponentType<any>; label: string; value: string }) => (
    <div>
        <p className="text-[10px] uppercase tracking-widest text-slate-600 mb-0.5 flex items-center gap-1">
            <Icon size={10} /> {label}
        </p>
        <p className="text-xs text-slate-300 font-medium">{value}</p>
    </div>
);

export default TeacherLeadsPanel;
