import React, { useState, useEffect } from 'react';
import { Globe, FileText, Save, Loader2, Check, AlertCircle, Plus, Trash2, Copy, ExternalLink, Download, Building2, Link2, CheckCircle2, XCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { BASE_DOMAIN, slugify, clearTenantCache } from '../lib/tenant-resolver';

interface Props {
    user: { id: string; tenantId?: string; role: string };
    tenantId?: string;
}

const TenantAdvancedSettings: React.FC<Props> = ({ user, tenantId }) => {
    const [tab, setTab] = useState<'escola' | 'domain' | 'contracts' | 'lgpd'>('escola');

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
                <TabButton active={tab === 'escola'} onClick={() => setTab('escola')} icon={Building2} label="Dados da escola" />
                <TabButton active={tab === 'domain'} onClick={() => setTab('domain')} icon={Globe} label="Domínio próprio" />
                <TabButton active={tab === 'contracts'} onClick={() => setTab('contracts')} icon={FileText} label="Contratos" />
                <TabButton active={tab === 'lgpd'} onClick={() => setTab('lgpd')} icon={Download} label="LGPD" />
            </div>

            {tab === 'escola' && <SchoolInfoPanel tenantId={tenantId} />}
            {tab === 'domain' && <CustomDomainPanel tenantId={tenantId} />}
            {tab === 'contracts' && <ContractTemplatesPanel user={user} tenantId={tenantId} />}
            {tab === 'lgpd' && <LgpdPanel tenantId={tenantId} role={user.role} />}
        </div>
    );
};

// ─────────────────────────────────────────────────────────────
// SCHOOL INFO — Dados da escola para contratos
// ─────────────────────────────────────────────────────────────

interface SchoolInfoForm {
    name: string;
    cnpj: string;
    address: string;
    email: string;
    phone: string;
    city: string;
    state: string;
    directorName: string;
}

const EMPTY_SCHOOL: SchoolInfoForm = {
    name: '', cnpj: '', address: '', email: '',
    phone: '', city: '', state: '', directorName: '',
};

const WISE_WOLF_PREVIEW: SchoolInfoForm = {
    name: 'WISE WOLF LANGUAGE',
    cnpj: '[CNPJ não configurado]',
    address: '[Endereço não configurado]',
    email: '[E-mail não configurado]',
    phone: '[Telefone não configurado]',
    city: '[Cidade]',
    state: 'SP',
    directorName: '[Responsável não configurado]',
};

/** Formata CNPJ enquanto o usuário digita: ##.###.###/####-## */
function maskCNPJ(v: string) {
    const d = v.replace(/\D/g, '').slice(0, 14);
    if (d.length <= 2) return d;
    if (d.length <= 5) return `${d.slice(0, 2)}.${d.slice(2)}`;
    if (d.length <= 8) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5)}`;
    if (d.length <= 12) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8)}`;
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

/** Formata telefone: (##) #####-#### */
function maskPhone(v: string) {
    const d = v.replace(/\D/g, '').slice(0, 11);
    if (d.length <= 2) return d.length ? `(${d}` : '';
    if (d.length <= 7) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
    if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

const SchoolInfoPanel: React.FC<{ tenantId?: string }> = ({ tenantId }) => {
    const [form, setForm] = useState<SchoolInfoForm>(EMPTY_SCHOOL);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [isCustom, setIsCustom] = useState(false); // true = tem dados próprios

    useEffect(() => { loadSchoolInfo(); }, [tenantId]);

    const loadSchoolInfo = async () => {
        setLoading(true);
        if (!tenantId) { setLoading(false); return; }
        try {
            const { data } = await supabase
                .from('tenants')
                .select('school_info')
                .eq('id', tenantId)
                .single();
            if (data?.school_info && Object.keys(data.school_info).length > 0) {
                setForm({ ...EMPTY_SCHOOL, ...data.school_info });
                setIsCustom(true);
            }
        } catch (_) {
            // silencioso — usa defaults
        }
        setLoading(false);
    };

    const handleSave = async () => {
        if (!tenantId) return;
        setSaving(true);
        try {
            // Se todos os campos estiverem vazios, salva null (volta ao padrão Wise Wolf)
            const hasData = Object.values(form).some(v => v.trim() !== '');
            const payload = hasData ? form : null;
            const { error } = await supabase
                .from('tenants')
                .update({ school_info: payload })
                .eq('id', tenantId);
            if (error) throw error;
            setIsCustom(hasData);
            setSaved(true);
            setTimeout(() => setSaved(false), 3000);
        } catch (err: any) {
            alert('Erro ao salvar: ' + err.message);
        }
        setSaving(false);
    };

    const handleClear = () => {
        setForm(EMPTY_SCHOOL);
        setIsCustom(false);
    };

    const set = (field: keyof SchoolInfoForm, value: string) =>
        setForm(prev => ({ ...prev, [field]: value }));

    if (loading) return <Loader />;

    // Mostra os dados que serão usados no contrato (custom ou Wise Wolf defaults)
    const preview: SchoolInfoForm = isCustom ? form : WISE_WOLF_PREVIEW;

    return (
        <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 p-6 space-y-6">
            {/* Header */}
            <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-blue-100 dark:bg-blue-900/30 rounded-xl flex items-center justify-center">
                        <Building2 size={20} className="text-blue-600" />
                    </div>
                    <div>
                        <h3 className="font-black text-slate-800 dark:text-white text-sm">Dados da Escola</h3>
                        <p className="text-[10px] text-slate-400 uppercase tracking-widest">
                            Aparecem no cabeçalho e rodapé dos contratos
                        </p>
                    </div>
                </div>
                {!isCustom && (
                    <span className="text-[9px] font-bold uppercase tracking-widest px-2.5 py-1 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400">
                        ✦ Usando padrão Wise Wolf
                    </span>
                )}
                {isCustom && (
                    <span className="text-[9px] font-bold uppercase tracking-widest px-2.5 py-1 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400">
                        ✓ Dados personalizados
                    </span>
                )}
            </div>

            {/* Aviso quando nenhum dado configurado */}
            {!isCustom && (
                <div className="bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800/30 rounded-2xl p-4 flex gap-3 items-start">
                    <AlertCircle size={16} className="text-amber-500 shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                        <strong>Nenhum dado da escola configurado.</strong> Os contratos gerados mostrarão campos em branco até você preencher as informações abaixo. Preencha uma vez e todos os contratos futuros serão gerados automaticamente com os seus dados.
                    </p>
                </div>
            )}

            {/* Formulário */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <SchoolField
                    label="Nome da escola / razão social"
                    hint="Como aparece no cabeçalho do contrato"
                    value={form.name}
                    onChange={v => set('name', v)}
                    placeholder="Ex: Escola Futuro Idiomas"
                />
                <SchoolField
                    label="CNPJ"
                    hint="Número de registro da sua empresa (só números, a máscara é automática)"
                    value={form.cnpj}
                    onChange={v => set('cnpj', maskCNPJ(v))}
                    placeholder="Ex: 00.000.000/0001-00"
                />
                <div className="md:col-span-2">
                    <SchoolField
                        label="Endereço completo"
                        hint="Rua, número, complemento, bairro, cidade e estado — aparece no cabeçalho do contrato"
                        value={form.address}
                        onChange={v => set('address', v)}
                        placeholder="Ex: Rua das Flores, 100 - Centro - São Paulo/SP - CEP 01234-567"
                    />
                </div>
                <SchoolField
                    label="E-mail institucional"
                    hint="E-mail de contato da escola (aparece no contrato)"
                    value={form.email}
                    onChange={v => set('email', v)}
                    placeholder="Ex: contato@minhaescola.com.br"
                    type="email"
                />
                <SchoolField
                    label="Telefone / WhatsApp"
                    hint="Número com DDD (a máscara é automática)"
                    value={form.phone}
                    onChange={v => set('phone', maskPhone(v))}
                    placeholder="Ex: (11) 99999-9999"
                />
                <SchoolField
                    label="Cidade"
                    hint="Usada no rodapé do contrato como foro de eleição"
                    value={form.city}
                    onChange={v => set('city', v)}
                    placeholder="Ex: São Paulo"
                />
                <SchoolField
                    label="Estado (UF)"
                    hint="Sigla com 2 letras"
                    value={form.state}
                    onChange={v => set('state', v.toUpperCase().slice(0, 2))}
                    placeholder="Ex: SP"
                />
                <div className="md:col-span-2">
                    <SchoolField
                        label="Nome do diretor / responsável legal"
                        hint="Pessoa que assina o contrato pela escola — nome completo"
                        value={form.directorName}
                        onChange={v => set('directorName', v)}
                        placeholder="Ex: João Silva"
                    />
                </div>
            </div>

            {/* Preview de como vai aparecer no contrato */}
            <div className="bg-slate-50 dark:bg-slate-800/50 rounded-2xl p-4 border border-slate-100 dark:border-slate-700">
                <p className="text-[10px] uppercase tracking-widest text-slate-400 font-bold mb-3">
                    Pré-visualização — como vai aparecer no contrato
                </p>
                <div className="space-y-0.5 text-xs text-slate-600 dark:text-slate-300 font-medium">
                    <PreviewField value={preview.name} fallback="Nome da escola não preenchido" bold />
                    <PreviewField label="CNPJ:" value={preview.cnpj} fallback="CNPJ não preenchido" />
                    <PreviewField value={preview.address} fallback="Endereço não preenchido" />
                    <div className="flex flex-wrap gap-x-3">
                        <PreviewField label="✉" value={preview.email} fallback="E-mail não preenchido" inline />
                        <PreviewField label="☎" value={preview.phone} fallback="Telefone não preenchido" inline />
                    </div>
                    <div className="flex flex-wrap gap-x-3 text-[11px] pt-1 text-slate-400">
                        <PreviewField label="Responsável:" value={preview.directorName} fallback="Nome não preenchido" inline muted />
                        <PreviewField label="Foro:" value={preview.city && preview.state ? `${preview.city}/${preview.state}` : ''} fallback="Cidade/UF não preenchida" inline muted />
                    </div>
                </div>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-between pt-2">
                {isCustom ? (
                    <button
                        onClick={handleClear}
                        className="text-xs text-slate-400 hover:text-rose-500 transition-colors font-bold"
                    >
                        Remover personalização (voltar ao padrão)
                    </button>
                ) : <span />}
                <button
                    onClick={handleSave}
                    disabled={saving}
                    className={`flex items-center gap-2 px-6 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${
                        saved
                            ? 'bg-emerald-500 text-white'
                            : 'bg-blue-600 hover:brightness-110 text-white'
                    } disabled:opacity-50`}
                >
                    {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <Check size={14} /> : <Save size={14} />}
                    {saving ? 'Salvando...' : saved ? 'Salvo!' : 'Salvar dados da escola'}
                </button>
            </div>
        </div>
    );
};

/** Linha do preview do contrato — mostra valor preenchido ou aviso vermelho */
const PreviewField: React.FC<{
    label?: string;
    value: string;
    fallback: string;
    bold?: boolean;
    inline?: boolean;
    muted?: boolean;
}> = ({ label, value, fallback, bold, inline, muted }) => {
    const hasValue = value.trim() !== '';
    const base = inline ? 'inline' : 'block';
    if (bold) return (
        <p className={`${base} font-black text-slate-800 dark:text-white text-sm ${!hasValue ? 'text-rose-400 dark:text-rose-400 font-normal italic' : ''}`}>
            {hasValue ? value : `⚠ ${fallback}`}
        </p>
    );
    return (
        <span className={`${base} ${muted ? 'text-[11px] text-slate-400' : ''} ${!hasValue ? 'text-rose-400 italic' : ''}`}>
            {label && hasValue ? `${label} ` : label && !hasValue ? '' : ''}{hasValue ? value : `⚠ ${fallback}`}
        </span>
    );
};

/** Campo de formulário com label descritivo e hint */
const SchoolField: React.FC<{
    label: string;
    hint: string;
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
    type?: string;
}> = ({ label, hint, value, onChange, placeholder, type = 'text' }) => (
    <div className="space-y-1.5">
        <div>
            <label className="text-xs font-black text-slate-700 dark:text-slate-200 block">{label}</label>
            <p className="text-[10px] text-slate-400 leading-tight">{hint}</p>
        </div>
        <input
            type={type}
            value={value}
            onChange={e => onChange(e.target.value)}
            placeholder={placeholder}
            className="w-full px-3 py-2.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-sm text-slate-800 dark:text-slate-200 placeholder:text-slate-300 dark:placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"
        />
    </div>
);

// ─────────────────────────────────────────────────────────────
// DOMAIN PANEL — subdomínio Wise Wolf + domínio próprio
// ─────────────────────────────────────────────────────────────
const CustomDomainPanel: React.FC<{ tenantId?: string }> = ({ tenantId }) => {
    const [tenantData, setTenantData] = useState<any>(null);
    const [loading, setLoading] = useState(true);

    // Subdomínio
    const [slugEdit, setSlugEdit] = useState('');
    const [slugSaving, setSlugSaving] = useState(false);
    const [slugSaved, setSlugSaved] = useState(false);
    const [slugError, setSlugError] = useState('');
    const [copied, setCopied] = useState(false);

    // Domínio próprio
    const [customDomain, setCustomDomain] = useState('');
    const [dnsInfo, setDnsInfo] = useState<any>(null);
    const [domainWorking, setDomainWorking] = useState(false);

    useEffect(() => { load(); }, [tenantId]);

    const load = async () => {
        setLoading(true);
        if (!tenantId) { setLoading(false); return; }
        const { data } = await supabase
            .from('tenants')
            .select('slug, custom_domain, custom_domain_verified, custom_domain_dns_token, custom_domain_verified_at, name')
            .eq('id', tenantId)
            .single();
        setTenantData(data);
        if (data?.slug) setSlugEdit(data.slug);
        if (data?.custom_domain) setCustomDomain(data.custom_domain);
        setLoading(false);
    };

    const subdomainUrl = tenantData?.slug ? `https://${tenantData.slug}.${BASE_DOMAIN}` : null;

    const copyUrl = () => {
        if (subdomainUrl) {
            navigator.clipboard.writeText(subdomainUrl);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };

    const saveSlug = async () => {
        const clean = slugify(slugEdit);
        if (!clean) { setSlugError('Slug inválido.'); return; }
        setSlugSaving(true);
        setSlugError('');
        try {
            // Verifica disponibilidade
            const { data: existing } = await supabase
                .from('tenants')
                .select('id')
                .eq('slug', clean)
                .neq('id', tenantId!)
                .maybeSingle();
            if (existing) { setSlugError('Este endereço já está em uso. Escolha outro.'); setSlugSaving(false); return; }

            const { error } = await supabase.from('tenants').update({ slug: clean, domain: `${clean}.${BASE_DOMAIN}` }).eq('id', tenantId!);
            if (error) throw error;
            clearTenantCache();
            setSlugEdit(clean);
            setTenantData((prev: any) => ({ ...prev, slug: clean }));
            setSlugSaved(true);
            setTimeout(() => setSlugSaved(false), 3000);
        } catch (err: any) {
            setSlugError(err.message);
        }
        setSlugSaving(false);
    };

    const requestCustomDomain = async () => {
        if (!customDomain.trim()) return;
        setDomainWorking(true);
        try {
            const { data, error } = await supabase.rpc('request_custom_domain', { p_domain: customDomain.trim().toLowerCase() });
            if (error) throw error;
            setDnsInfo(data);
            load();
        } catch (err: any) {
            alert('Erro: ' + err.message);
        } finally { setDomainWorking(false); }
    };

    const verifyCustomDomain = async () => {
        setDomainWorking(true);
        try {
            const { error } = await supabase.rpc('verify_custom_domain');
            if (error) throw error;
            load();
        } catch (err: any) {
            alert('Erro: ' + err.message);
        } finally { setDomainWorking(false); }
    };

    if (loading) return <Loader />;

    return (
        <div className="space-y-4">
            {/* ── Opção A: Subdomínio Wise Wolf (gratuito, imediato) ── */}
            <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 p-6 space-y-5">
                <div className="flex items-start gap-3">
                    <div className="w-10 h-10 bg-blue-100 dark:bg-blue-900/30 rounded-xl flex items-center justify-center shrink-0">
                        <Link2 size={20} className="text-blue-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="font-black text-slate-800 dark:text-white text-sm">Endereço Wise Wolf</h3>
                            <span className="text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400">Gratuito</span>
                        </div>
                        <p className="text-[10px] text-slate-400 mt-0.5">
                            Seu portal fica disponível em <strong>{`<seuslug>.${BASE_DOMAIN}`}</strong> — sem nenhuma configuração extra.
                        </p>
                    </div>
                </div>

                {/* URL atual */}
                {subdomainUrl && (
                    <div className="flex items-center gap-2 bg-slate-50 dark:bg-slate-800/50 rounded-xl px-4 py-3 border border-slate-200 dark:border-slate-700">
                        <span className="flex-1 font-mono text-sm text-slate-700 dark:text-slate-200 truncate">{subdomainUrl}</span>
                        <button onClick={copyUrl} className="shrink-0 flex items-center gap-1 text-[10px] font-bold text-slate-400 hover:text-blue-600 transition-colors">
                            {copied ? <><CheckCircle2 size={14} className="text-emerald-500" /> Copiado</> : <><Copy size={14} /> Copiar</>}
                        </button>
                        <a href={subdomainUrl} target="_blank" rel="noopener noreferrer" className="shrink-0 text-slate-400 hover:text-blue-600 transition-colors">
                            <ExternalLink size={14} />
                        </a>
                    </div>
                )}

                {/* Editar slug */}
                <div className="space-y-2">
                    <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold block">
                        Personalizar o endereço
                    </label>
                    <p className="text-[11px] text-slate-400 leading-relaxed">
                        Use letras minúsculas, números e hífens. Sem espaços ou caracteres especiais.
                        <br/>
                        <span className="text-slate-500">Ex: <em>joao-idiomas</em> → <strong>joao-idiomas.{BASE_DOMAIN}</strong></span>
                    </p>
                    <div className="flex gap-2">
                        <div className="flex-1 flex items-center bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden focus-within:ring-2 focus-within:ring-blue-500">
                            <span className="px-3 py-2.5 text-xs text-slate-400 bg-slate-50 dark:bg-slate-700 border-r border-slate-200 dark:border-slate-600 shrink-0 whitespace-nowrap select-none">
                                https://
                            </span>
                            <input
                                type="text"
                                value={slugEdit}
                                onChange={e => { setSlugEdit(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '')); setSlugError(''); }}
                                placeholder="minha-escola"
                                className="flex-1 px-3 py-2.5 text-sm bg-transparent text-slate-800 dark:text-slate-200 focus:outline-none min-w-0"
                            />
                            <span className="px-3 py-2.5 text-xs text-slate-400 bg-slate-50 dark:bg-slate-700 border-l border-slate-200 dark:border-slate-600 shrink-0 whitespace-nowrap select-none">
                                .{BASE_DOMAIN}
                            </span>
                        </div>
                        <button
                            onClick={saveSlug}
                            disabled={slugSaving || !slugEdit.trim() || slugEdit === tenantData?.slug}
                            className={`shrink-0 px-4 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all disabled:opacity-50 flex items-center gap-1.5 ${slugSaved ? 'bg-emerald-500 text-white' : 'bg-blue-600 hover:brightness-110 text-white'}`}
                        >
                            {slugSaving ? <Loader2 size={12} className="animate-spin" /> : slugSaved ? <Check size={12} /> : <Save size={12} />}
                            {slugSaved ? 'Salvo!' : 'Salvar'}
                        </button>
                    </div>
                    {slugError && <p className="text-xs text-rose-500 font-medium">{slugError}</p>}
                </div>
            </div>

            {/* ── Opção B: Domínio próprio (avançado) ── */}
            <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 p-6 space-y-5">
                <div className="flex items-start gap-3">
                    <div className="w-10 h-10 bg-violet-100 dark:bg-violet-900/30 rounded-xl flex items-center justify-center shrink-0">
                        <Globe size={20} className="text-violet-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="font-black text-slate-800 dark:text-white text-sm">Domínio próprio</h3>
                            <span className="text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-400">Avançado</span>
                            {tenantData?.custom_domain_verified && (
                                <span className="text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 flex items-center gap-1">
                                    <CheckCircle2 size={10} /> Verificado
                                </span>
                            )}
                        </div>
                        <p className="text-[10px] text-slate-400 mt-0.5">
                            Use um domínio que você comprou (ex: <em>portal.suaescola.com.br</em>). Requer configuração de DNS.
                        </p>
                    </div>
                </div>

                <div className="space-y-3">
                    <div>
                        <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold block mb-1.5">Seu domínio</label>
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={customDomain}
                                onChange={e => setCustomDomain(e.target.value.toLowerCase().trim())}
                                placeholder="portal.suaescola.com.br"
                                className="flex-1 px-3 py-2.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
                            />
                            <button
                                onClick={requestCustomDomain}
                                disabled={domainWorking || !customDomain.trim()}
                                className="shrink-0 px-4 py-2.5 bg-violet-600 text-white text-xs font-black uppercase tracking-widest rounded-xl hover:brightness-110 disabled:opacity-50 flex items-center gap-1.5"
                            >
                                {domainWorking ? <Loader2 size={12} className="animate-spin" /> : null}
                                Ver instruções DNS
                            </button>
                        </div>
                    </div>

                    {/* Instruções DNS */}
                    {(dnsInfo || tenantData?.custom_domain_dns_token) && (
                        <div className="bg-slate-50 dark:bg-slate-800/50 rounded-2xl p-4 space-y-3 border border-slate-200 dark:border-slate-700">
                            <p className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">
                                Crie estes 2 registros no painel DNS do seu domínio:
                            </p>
                            <DnsRecord
                                type="CNAME"
                                name={customDomain || tenantData?.custom_domain || ''}
                                value="cname.vercel-dns.com"
                                hint="Aponta seu domínio para o servidor da Wise Wolf"
                            />
                            <DnsRecord
                                type="TXT"
                                name={`_wisewolf-verify.${customDomain || tenantData?.custom_domain || ''}`}
                                value={dnsInfo?.dns_record_value || tenantData?.custom_domain_dns_token || ''}
                                hint="Comprova que você é o dono do domínio"
                            />
                            <p className="text-[10px] text-slate-400">
                                ⏳ A propagação DNS pode levar até 48h. Após configurar, clique em "Verificar".
                            </p>
                            {!tenantData?.custom_domain_verified && (
                                <button
                                    onClick={verifyCustomDomain}
                                    disabled={domainWorking}
                                    className="w-full py-2 bg-emerald-600 text-white text-xs font-black uppercase tracking-widest rounded-xl hover:brightness-110 disabled:opacity-50 flex items-center justify-center gap-2"
                                >
                                    {domainWorking ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                                    Verificar domínio
                                </button>
                            )}
                        </div>
                    )}

                    {/* Status verificado */}
                    {tenantData?.custom_domain_verified && (
                        <div className="flex items-center gap-2 p-3 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/30 rounded-xl">
                            <CheckCircle2 size={16} className="text-emerald-500 shrink-0" />
                            <div>
                                <p className="text-xs font-black text-emerald-700 dark:text-emerald-300">Domínio ativo!</p>
                                <p className="text-[10px] text-emerald-600 dark:text-emerald-400">
                                    Seu portal está acessível em <strong>https://{tenantData.custom_domain}</strong>
                                </p>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

const DnsRecord: React.FC<{ type: string; name: string; value: string; hint?: string }> = ({ type, name, value, hint }) => (
    <div className="space-y-1">
        {hint && <p className="text-[10px] text-slate-400 italic">{hint}</p>}
        <div className="grid grid-cols-12 gap-2 items-center bg-white dark:bg-slate-900 rounded-lg p-2 border border-slate-200 dark:border-slate-700 font-mono text-[11px]">
            <span className={`col-span-2 font-bold ${type === 'CNAME' ? 'text-violet-600' : 'text-amber-600'}`}>{type}</span>
            <span className="col-span-5 truncate text-slate-600 dark:text-slate-300" title={name}>{name}</span>
            <span className="col-span-4 truncate text-slate-500" title={value}>{value}</span>
            <button
                onClick={() => navigator.clipboard.writeText(value)}
                title="Copiar valor"
                className="col-span-1 p-1 hover:bg-slate-100 dark:hover:bg-slate-800 rounded flex items-center justify-center"
            >
                <Copy size={11} />
            </button>
        </div>
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
