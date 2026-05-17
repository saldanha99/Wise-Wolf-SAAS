import React, { useState, useEffect } from 'react';
import { Globe, FileText, Save, Loader2, Check, AlertCircle, Plus, Trash2, Copy, ExternalLink, Download } from 'lucide-react';
import { supabase } from '../lib/supabase';

interface Props {
    user: { id: string; tenantId?: string; role: string };
    tenantId?: string;
}

const TenantAdvancedSettings: React.FC<Props> = ({ user, tenantId }) => {
    const [tab, setTab] = useState<'domain' | 'contracts' | 'lgpd'>('domain');

    return (
        <div className="space-y-4">
            <div className="flex gap-2">
                <TabButton active={tab === 'domain'} onClick={() => setTab('domain')} icon={Globe} label="Domínio próprio" />
                <TabButton active={tab === 'contracts'} onClick={() => setTab('contracts')} icon={FileText} label="Contratos" />
                <TabButton active={tab === 'lgpd'} onClick={() => setTab('lgpd')} icon={Download} label="LGPD" />
            </div>

            {tab === 'domain' && <CustomDomainPanel tenantId={tenantId} />}
            {tab === 'contracts' && <ContractTemplatesPanel user={user} tenantId={tenantId} />}
            {tab === 'lgpd' && <LgpdPanel tenantId={tenantId} role={user.role} />}
        </div>
    );
};

// ─────────────────────────────────────────────────────────────
// CUSTOM DOMAIN
// ─────────────────────────────────────────────────────────────
const CustomDomainPanel: React.FC<{ tenantId?: string }> = ({ tenantId }) => {
    const [tenant, setTenant] = useState<any>(null);
    const [domain, setDomain] = useState('');
    const [dnsInfo, setDnsInfo] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [working, setWorking] = useState(false);

    useEffect(() => { load(); }, [tenantId]);

    const load = async () => {
        setLoading(true);
        if (!tenantId) { setLoading(false); return; }
        const { data } = await supabase.from('tenants').select('custom_domain, custom_domain_verified, custom_domain_dns_token, custom_domain_verified_at').eq('id', tenantId).single();
        setTenant(data);
        if (data?.custom_domain) setDomain(data.custom_domain);
        setLoading(false);
    };

    const request = async () => {
        if (!domain.trim()) return;
        setWorking(true);
        try {
            const { data, error } = await supabase.rpc('request_custom_domain', { p_domain: domain.trim().toLowerCase() });
            if (error) throw error;
            setDnsInfo(data);
            load();
        } catch (err: any) {
            alert('Erro: ' + err.message);
        } finally { setWorking(false); }
    };

    const verify = async () => {
        setWorking(true);
        try {
            const { error } = await supabase.rpc('verify_custom_domain');
            if (error) throw error;
            alert('Marcado como verificado (em prod, validamos via DNS real).');
            load();
        } catch (err: any) {
            alert('Erro: ' + err.message);
        } finally { setWorking(false); }
    };

    if (loading) return <Loader />;

    return (
        <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 p-6 space-y-4">
            <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-blue-100 dark:bg-blue-900/30 rounded-xl flex items-center justify-center">
                    <Globe size={20} className="text-blue-600" />
                </div>
                <div>
                    <h3 className="font-black text-slate-800 dark:text-white text-sm">Domínio próprio</h3>
                    <p className="text-[10px] text-slate-400 uppercase tracking-widest">White-label completo</p>
                </div>
                {tenant?.custom_domain_verified && (
                    <span className="ml-auto text-[9px] font-bold uppercase tracking-widest px-2 py-1 rounded-full bg-emerald-100 text-emerald-600">
                        ✓ Verificado
                    </span>
                )}
            </div>

            <div className="space-y-3">
                <Input label="Seu domínio" value={domain} onChange={setDomain} placeholder="portal.suaescola.com.br" />
                <div className="flex gap-2">
                    <button onClick={request} disabled={working || !domain.trim()} className="flex-1 py-2 bg-blue-600 text-white text-xs font-black uppercase tracking-widest rounded-xl hover:brightness-110 disabled:opacity-50">
                        Gerar instruções DNS
                    </button>
                    {tenant?.custom_domain_dns_token && !tenant?.custom_domain_verified && (
                        <button onClick={verify} disabled={working} className="py-2 px-4 bg-emerald-600 text-white text-xs font-black uppercase tracking-widest rounded-xl hover:brightness-110 disabled:opacity-50">
                            Verificar
                        </button>
                    )}
                </div>

                {dnsInfo && (
                    <div className="bg-slate-50 dark:bg-slate-800/50 rounded-xl p-4 space-y-2 text-xs">
                        <p className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">Crie os 2 registros DNS abaixo no painel do seu provedor:</p>
                        <DnsRecord type="TXT" name={dnsInfo.dns_record_name} value={dnsInfo.dns_record_value} />
                        <DnsRecord type="CNAME" name={dnsInfo.domain} value={dnsInfo.cname_target} />
                        <p className="text-[10px] text-slate-500 mt-2">{dnsInfo.instructions}</p>
                    </div>
                )}
            </div>
        </div>
    );
};

const DnsRecord: React.FC<{ type: string; name: string; value: string }> = ({ type, name, value }) => (
    <div className="grid grid-cols-12 gap-2 items-center bg-white dark:bg-slate-900 rounded-lg p-2 border border-slate-200 dark:border-slate-700 font-mono text-[11px]">
        <span className="col-span-2 font-bold text-blue-600">{type}</span>
        <span className="col-span-5 truncate" title={name}>{name}</span>
        <span className="col-span-4 truncate text-slate-500" title={value}>{value}</span>
        <button onClick={() => navigator.clipboard.writeText(value)} className="col-span-1 p-1 hover:bg-slate-100 dark:hover:bg-slate-800 rounded">
            <Copy size={12} />
        </button>
    </div>
);

// ─────────────────────────────────────────────────────────────
// CONTRACT TEMPLATES
// ─────────────────────────────────────────────────────────────
const ContractTemplatesPanel: React.FC<{ user: any; tenantId?: string }> = ({ user, tenantId }) => {
    const [templates, setTemplates] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [editing, setEditing] = useState<any>(null);
    const [creating, setCreating] = useState(false);

    useEffect(() => { load(); }, [tenantId]);

    const load = async () => {
        setLoading(true);
        if (!tenantId) { setLoading(false); return; }
        const { data } = await supabase.from('tenant_contract_templates').select('*').eq('tenant_id', tenantId).order('kind').order('created_at');
        setTemplates(data || []);
        setLoading(false);
    };

    const save = async (t: any) => {
        try {
            if (t.id) {
                await supabase.from('tenant_contract_templates').update({
                    name: t.name, body_markdown: t.body_markdown,
                    cancellation_fee_pct: parseFloat(t.cancellation_fee_pct) || 0,
                    notice_period_days: parseInt(t.notice_period_days) || 0,
                    active: t.active, updated_at: new Date().toISOString(),
                }).eq('id', t.id);
            } else {
                await supabase.from('tenant_contract_templates').insert({
                    tenant_id: tenantId, kind: t.kind, name: t.name,
                    body_markdown: t.body_markdown,
                    cancellation_fee_pct: parseFloat(t.cancellation_fee_pct) || 30,
                    notice_period_days: parseInt(t.notice_period_days) || 30,
                });
            }
            setEditing(null); setCreating(false); load();
        } catch (err: any) {
            alert('Erro: ' + err.message);
        }
    };

    const remove = async (id: string) => {
        if (!confirm('Excluir este template?')) return;
        await supabase.from('tenant_contract_templates').delete().eq('id', id);
        load();
    };

    if (loading) return <Loader />;

    return (
        <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 p-6 space-y-4">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-violet-100 dark:bg-violet-900/30 rounded-xl flex items-center justify-center">
                        <FileText size={20} className="text-violet-600" />
                    </div>
                    <div>
                        <h3 className="font-black text-slate-800 dark:text-white text-sm">Templates de Contrato</h3>
                        <p className="text-[10px] text-slate-400 uppercase tracking-widest">Personalize prazos, multa e cláusulas</p>
                    </div>
                </div>
                <button onClick={() => setCreating(true)} className="flex items-center gap-2 px-3 py-1.5 bg-violet-600 text-white text-xs font-black uppercase tracking-widest rounded-lg hover:brightness-110">
                    <Plus size={12} /> Novo
                </button>
            </div>

            {(creating || editing) && (
                <ContractForm
                    initial={editing}
                    onSave={save}
                    onCancel={() => { setEditing(null); setCreating(false); }}
                />
            )}

            <div className="space-y-2">
                {templates.length === 0 && !creating && (
                    <p className="text-center text-sm text-slate-400 py-8">Nenhum template ainda. Crie o primeiro!</p>
                )}
                {templates.map(t => (
                    <div key={t.id} className="flex items-center gap-3 p-3 rounded-xl border border-slate-200 dark:border-slate-800">
                        <span className={`text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full ${t.kind === 'STUDENT' ? 'bg-blue-100 text-blue-600' : 'bg-emerald-100 text-emerald-600'}`}>{t.kind}</span>
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-black text-slate-800 dark:text-white">{t.name}</p>
                            <p className="text-[10px] text-slate-400">Multa {t.cancellation_fee_pct}% · {t.notice_period_days}d aviso prévio</p>
                        </div>
                        <button onClick={() => setEditing(t)} className="text-xs text-violet-600 font-bold">Editar</button>
                        <button onClick={() => remove(t.id)} className="text-rose-500 hover:text-rose-700 p-1"><Trash2 size={14} /></button>
                    </div>
                ))}
            </div>
        </div>
    );
};

const ContractForm: React.FC<{ initial?: any; onSave: (t: any) => void; onCancel: () => void }> = ({ initial, onSave, onCancel }) => {
    const [form, setForm] = useState(initial || { kind: 'STUDENT', name: '', body_markdown: '', cancellation_fee_pct: 30, notice_period_days: 30, active: true });
    return (
        <div className="bg-violet-50 dark:bg-violet-900/10 border border-violet-100 dark:border-violet-800/30 rounded-2xl p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
                <div>
                    <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold block mb-1">Tipo</label>
                    <select value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value })} disabled={!!initial} className="w-full p-2 bg-white dark:bg-slate-800 rounded-lg text-sm border border-slate-200 dark:border-slate-700">
                        <option value="STUDENT">Aluno</option>
                        <option value="TEACHER">Professor</option>
                    </select>
                </div>
                <Input label="Nome do template" value={form.name} onChange={v => setForm({ ...form, name: v })} placeholder="Ex: Padrão 2026" />
            </div>
            <div className="grid grid-cols-2 gap-3">
                <Input label="Multa rescisória (%)" type="number" value={String(form.cancellation_fee_pct)} onChange={v => setForm({ ...form, cancellation_fee_pct: v })} />
                <Input label="Aviso prévio (dias)" type="number" value={String(form.notice_period_days)} onChange={v => setForm({ ...form, notice_period_days: v })} />
            </div>
            <div>
                <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold block mb-1">Corpo do contrato (Markdown). Variáveis: {`{student_name}, {teacher_name}, {monthly_fee}, {duration_months}, {start_date}, {end_date}, {tenant_name}`}</label>
                <textarea value={form.body_markdown} onChange={e => setForm({ ...form, body_markdown: e.target.value })} rows={10}
                    className="w-full p-2 bg-white dark:bg-slate-800 rounded-lg text-sm font-mono border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-violet-500" />
            </div>
            <div className="flex gap-2 justify-end">
                <button onClick={onCancel} className="text-xs font-bold text-slate-500 px-3 py-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg">Cancelar</button>
                <button onClick={() => onSave(form)} disabled={!form.name || !form.body_markdown} className="text-xs font-black uppercase tracking-widest text-white bg-violet-600 px-4 py-2 rounded-lg hover:brightness-110 disabled:opacity-50 flex items-center gap-2"><Save size={12} /> Salvar</button>
            </div>
        </div>
    );
};

// ─────────────────────────────────────────────────────────────
// LGPD
// ─────────────────────────────────────────────────────────────
const LgpdPanel: React.FC<{ tenantId?: string; role: string }> = ({ tenantId, role }) => {
    const [working, setWorking] = useState(false);

    const exportData = async () => {
        if (!tenantId) return;
        setWorking(true);
        try {
            const { data, error } = await supabase.rpc('export_tenant_data', { p_tenant_id: tenantId });
            if (error) throw error;
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = `wisewolf-export-${tenantId}-${Date.now()}.json`; a.click();
            URL.revokeObjectURL(url);
        } catch (err: any) {
            alert('Erro: ' + err.message);
        } finally { setWorking(false); }
    };

    const deleteData = async () => {
        if (!tenantId) return;
        const confirm = prompt(`ATENÇÃO: isto vai anonimizar todos os dados do tenant.\nDigite EXATAMENTE: DELETE ${tenantId}`);
        if (confirm !== `DELETE ${tenantId}`) { alert('Confirmação inválida. Operação cancelada.'); return; }
        setWorking(true);
        try {
            const { data, error } = await supabase.rpc('delete_tenant_data', { p_tenant_id: tenantId, p_confirm_text: confirm });
            if (error) throw error;
            alert(`Dados anonimizados: ${JSON.stringify(data)}`);
        } catch (err: any) {
            alert('Erro: ' + err.message);
        } finally { setWorking(false); }
    };

    const isSuperAdmin = role === 'SUPER_ADMIN' || role === 'super_admin';

    return (
        <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 p-6 space-y-4">
            <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-amber-100 dark:bg-amber-900/30 rounded-xl flex items-center justify-center">
                    <Download size={20} className="text-amber-600" />
                </div>
                <div>
                    <h3 className="font-black text-slate-800 dark:text-white text-sm">LGPD — Portabilidade & Exclusão</h3>
                    <p className="text-[10px] text-slate-400 uppercase tracking-widest">Direito do titular dos dados (Lei 13.709)</p>
                </div>
            </div>

            <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800/30 rounded-xl p-4">
                <p className="text-sm font-black text-slate-800 dark:text-white mb-1">Exportar todos os dados</p>
                <p className="text-xs text-slate-500 mb-3">Baixa um JSON com profiles, bookings, payments, contracts, audit logs e tudo o mais associado a este tenant.</p>
                <button onClick={exportData} disabled={working} className="px-4 py-2 bg-blue-600 text-white text-xs font-black uppercase tracking-widest rounded-xl hover:brightness-110 disabled:opacity-50 flex items-center gap-2">
                    {working ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />} Baixar JSON
                </button>
            </div>

            {isSuperAdmin && (
                <div className="bg-rose-50 dark:bg-rose-900/20 border border-rose-100 dark:border-rose-800/30 rounded-xl p-4">
                    <p className="text-sm font-black text-rose-700 dark:text-rose-300 mb-1">⚠️ Excluir/anonimizar tenant</p>
                    <p className="text-xs text-slate-500 mb-3">Anonimiza PII (nome, email, CPF, telefone, etc) e deleta dados não-fiscais. Tenant marcado como CANCELLED. Irreversível.</p>
                    <button onClick={deleteData} disabled={working} className="px-4 py-2 bg-rose-600 text-white text-xs font-black uppercase tracking-widest rounded-xl hover:brightness-110 disabled:opacity-50">
                        Anonimizar tenant
                    </button>
                </div>
            )}
        </div>
    );
};

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
const TabButton: React.FC<{ active: boolean; onClick: () => void; icon: any; label: string }> = ({ active, onClick, icon: Icon, label }) => (
    <button onClick={onClick} className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${active ? 'bg-violet-600 text-white' : 'bg-white dark:bg-slate-900 text-slate-500 border border-slate-200 dark:border-slate-700'}`}>
        <Icon size={12} /> {label}
    </button>
);

const Loader = () => <div className="flex items-center justify-center py-12"><Loader2 className="animate-spin text-violet-500" size={24} /></div>;

const Input: React.FC<{ label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string }> = ({ label, value, onChange, placeholder, type = 'text' }) => (
    <div>
        <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold block mb-1">{label}</label>
        <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
            className="w-full p-2 bg-white dark:bg-slate-800 rounded-lg text-sm border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-violet-500" />
    </div>
);

export default TenantAdvancedSettings;
