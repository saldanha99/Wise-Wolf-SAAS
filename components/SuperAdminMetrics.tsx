import React, { useState, useEffect } from 'react';
import { Building2, Users, GraduationCap, DollarSign, AlertTriangle, TrendingUp, Loader2, Activity, Search, Clock } from 'lucide-react';
import { supabase } from '../lib/supabase';

const SuperAdminMetrics: React.FC = () => {
    const [loading, setLoading] = useState(true);
    const [tenants, setTenants] = useState<any[]>([]);
    const [usage, setUsage] = useState<Record<string, any>>({});
    const [leads, setLeads] = useState<any[]>([]);
    const [invoices, setInvoices] = useState<any[]>([]);
    const [search, setSearch] = useState('');

    useEffect(() => {
        load();
    }, []);

    const load = async () => {
        setLoading(true);
        try {
            const [tenantsRes, usageRes, leadsRes, invRes] = await Promise.all([
                supabase.from('tenants').select('id, name, saas_status, plan_id, trial_ends_at, asaas_subaccount_status, created_at').order('created_at', { ascending: false }),
                supabase.rpc('get_tenant_usage'),
                supabase.from('saas_leads').select('*').order('created_at', { ascending: false }).limit(50),
                supabase.from('saas_invoices').select('*').in('status', ['PENDING','OVERDUE']).order('due_date', { ascending: true }).limit(50),
            ]);
            setTenants(tenantsRes.data || []);
            const usageMap: Record<string, any> = {};
            (usageRes.data || []).forEach((u: any) => { usageMap[u.tenant_id] = u; });
            setUsage(usageMap);
            setLeads(leadsRes.data || []);
            setInvoices(invRes.data || []);
        } catch (err) {
            console.error('SuperAdmin metrics:', err);
        } finally {
            setLoading(false);
        }
    };

    const provisionFromLead = async (lead: any) => {
        const slug = prompt('Slug do novo tenant (curto, sem espaço, ex: escola-abc):', (lead.school_name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-'));
        if (!slug) return;
        const trialDays = parseInt(prompt('Dias de trial (default 14):', '14') || '14');
        const planId = prompt('Plan ID (default starter):', 'starter') || 'starter';
        try {
            const { data, error } = await supabase.rpc('provision_tenant_from_lead', {
                p_lead_id: lead.id,
                p_tenant_slug: slug,
                p_trial_days: trialDays,
                p_plan_id: planId,
            });
            if (error) throw error;
            alert(`Tenant provisionado: ${(data as any)?.[0]?.tenant_id}`);
            load();
        } catch (err: any) {
            alert('Erro: ' + err.message);
        }
    };

    if (loading) return <div className="p-12 flex items-center justify-center"><Loader2 className="animate-spin text-violet-500" size={28} /></div>;

    // Stats agregadas
    const totalStudents = Object.values(usage).reduce((a: number, u: any) => a + (u.student_count || 0), 0);
    const totalTeachers = Object.values(usage).reduce((a: number, u: any) => a + (u.teacher_count || 0), 0);
    const totalMRR = invoices.filter(i => i.status === 'PENDING').reduce((a, i) => a + Number(i.amount || 0), 0);
    const overdueAmt = invoices.filter(i => new Date(i.due_date) < new Date()).reduce((a, i) => a + Number(i.amount || 0), 0);

    const filteredTenants = tenants.filter(t =>
        !search || (t.name || '').toLowerCase().includes(search.toLowerCase()) || (t.id || '').toLowerCase().includes(search.toLowerCase())
    );

    return (
        <div className="space-y-4">
            {/* Stats cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatCard icon={Building2} label="Escolas ativas" value={tenants.filter(t => t.saas_status === 'ACTIVE').length} sub={`${tenants.filter(t => t.saas_status === 'TRIAL').length} em trial`} color="violet" />
                <StatCard icon={Users} label="Alunos totais" value={totalStudents} sub={`${totalTeachers} professores`} color="blue" />
                <StatCard icon={DollarSign} label="MRR previsto" value={`R$ ${totalMRR.toFixed(0)}`} sub={`${invoices.length} faturas em aberto`} color="emerald" />
                <StatCard icon={AlertTriangle} label="Em atraso" value={`R$ ${overdueAmt.toFixed(0)}`} sub={`${invoices.filter(i => new Date(i.due_date) < new Date()).length} faturas`} color="rose" />
            </div>

            {/* Lista de tenants com usage */}
            <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 overflow-hidden">
                <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-violet-100 dark:bg-violet-900/30 rounded-xl flex items-center justify-center">
                            <Building2 size={20} className="text-violet-600 dark:text-violet-400" />
                        </div>
                        <div>
                            <h3 className="font-black text-slate-800 dark:text-white text-sm">Tenants & Uso</h3>
                            <p className="text-[10px] text-slate-400 uppercase tracking-widest">{tenants.length} escolas no sistema</p>
                        </div>
                    </div>
                    <div className="relative">
                        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                        <input
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Buscar tenant..."
                            className="pl-9 pr-3 py-2 bg-slate-50 dark:bg-slate-800 rounded-xl text-sm border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-violet-500"
                        />
                    </div>
                </div>

                <div className="divide-y divide-slate-100 dark:divide-slate-800">
                    {filteredTenants.map(t => {
                        const u = usage[t.id] || {};
                        return (
                            <div key={t.id} className="px-6 py-3 flex items-center gap-3 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <p className="text-sm font-black text-slate-800 dark:text-white truncate">{t.name}</p>
                                        <StatusBadge status={t.saas_status} />
                                        {t.asaas_subaccount_status === 'APPROVED' && <span className="text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-300">Asaas ✓</span>}
                                    </div>
                                    <p className="text-[10px] text-slate-400 truncate">{t.id} · plano {t.plan_id || '—'}</p>
                                </div>
                                <div className="hidden md:flex items-center gap-6 text-xs">
                                    <UsageBar label="Alunos" current={u.student_count || 0} limit={u.student_limit || 0} />
                                    <UsageBar label="Profs" current={u.teacher_count || 0} limit={u.teacher_limit || 0} />
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* Leads novos */}
            {leads.filter(l => l.status === 'NEW').length > 0 && (
                <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 overflow-hidden">
                    <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex items-center gap-3">
                        <div className="w-10 h-10 bg-amber-100 dark:bg-amber-900/30 rounded-xl flex items-center justify-center">
                            <TrendingUp size={20} className="text-amber-600 dark:text-amber-400" />
                        </div>
                        <div>
                            <h3 className="font-black text-slate-800 dark:text-white text-sm">Leads pendentes</h3>
                            <p className="text-[10px] text-slate-400 uppercase tracking-widest">{leads.filter(l => l.status === 'NEW').length} aguardando provisionamento</p>
                        </div>
                    </div>
                    <div className="divide-y divide-slate-100 dark:divide-slate-800">
                        {leads.filter(l => l.status === 'NEW').map(l => (
                            <div key={l.id} className="px-6 py-3 flex items-center gap-3">
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-black text-slate-800 dark:text-white">{l.school_name}</p>
                                    <p className="text-[10px] text-slate-400">{l.owner_name} · {l.owner_email} · {l.owner_phone || '—'}</p>
                                    {l.notes && <p className="text-[11px] text-slate-500 mt-1 italic">"{l.notes}"</p>}
                                </div>
                                <button
                                    onClick={() => provisionFromLead(l)}
                                    className="px-3 py-1.5 bg-violet-600 text-white text-[10px] font-black uppercase tracking-widest rounded-lg hover:brightness-110"
                                >
                                    Provisionar trial
                                </button>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Invoices em aberto */}
            {invoices.length > 0 && (
                <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 overflow-hidden">
                    <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex items-center gap-3">
                        <div className="w-10 h-10 bg-rose-100 dark:bg-rose-900/30 rounded-xl flex items-center justify-center">
                            <Clock size={20} className="text-rose-600 dark:text-rose-400" />
                        </div>
                        <div>
                            <h3 className="font-black text-slate-800 dark:text-white text-sm">Faturas em aberto</h3>
                            <p className="text-[10px] text-slate-400 uppercase tracking-widest">SaaS Receivables</p>
                        </div>
                    </div>
                    <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-96 overflow-y-auto">
                        {invoices.map(i => {
                            const overdue = new Date(i.due_date) < new Date();
                            const tenant = tenants.find(t => t.id === i.tenant_id);
                            return (
                                <div key={i.id} className="px-6 py-2 flex items-center gap-3">
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-black text-slate-800 dark:text-white truncate">{tenant?.name || i.tenant_id}</p>
                                        <p className="text-[10px] text-slate-400">{i.invoice_number} · vence {new Date(i.due_date).toLocaleDateString('pt-BR')}</p>
                                    </div>
                                    <div className="text-right">
                                        <p className={`text-sm font-black ${overdue ? 'text-rose-500' : 'text-slate-800 dark:text-white'}`}>R$ {Number(i.amount || 0).toFixed(2)}</p>
                                        {overdue && <p className="text-[9px] font-bold text-rose-500">VENCIDA</p>}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
};

const StatCard: React.FC<{ icon: any; label: string; value: any; sub: string; color: string }> = ({ icon: Icon, label, value, sub, color }) => (
    <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 p-4">
        <div className={`w-9 h-9 rounded-xl flex items-center justify-center bg-${color}-100 dark:bg-${color}-900/30 text-${color}-600 mb-3`}>
            <Icon size={16} />
        </div>
        <p className="text-[10px] uppercase tracking-widest text-slate-400 font-bold">{label}</p>
        <p className="text-2xl font-black text-slate-800 dark:text-white mt-1">{value}</p>
        <p className="text-[10px] text-slate-400 mt-0.5">{sub}</p>
    </div>
);

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
    const colors: Record<string, string> = {
        ACTIVE: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-300',
        TRIAL: 'bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-300',
        PAST_DUE: 'bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-300',
        SUSPENDED: 'bg-rose-100 text-rose-600 dark:bg-rose-900/30 dark:text-rose-300',
        CANCELLED: 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
    };
    return <span className={`text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded ${colors[status] || colors.ACTIVE}`}>{status || 'ACTIVE'}</span>;
};

const UsageBar: React.FC<{ label: string; current: number; limit: number }> = ({ label, current, limit }) => {
    const pct = limit > 0 ? Math.min(100, (current / limit) * 100) : 0;
    const overLimit = limit > 0 && current >= limit;
    return (
        <div className="flex items-center gap-2">
            <p className="text-[10px] uppercase tracking-widest text-slate-400 font-bold">{label}</p>
            <div className="w-20 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                <div className={`h-full transition-all ${overLimit ? 'bg-rose-500' : pct > 80 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${pct}%` }} />
            </div>
            <p className="text-[10px] font-bold text-slate-600 dark:text-slate-300">{current}/{limit || '∞'}</p>
        </div>
    );
};

export default SuperAdminMetrics;
