import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { AlertTriangle, Building2, Check, FileText, Loader2, Save } from 'lucide-react';

// Dados do TOMADOR do serviço — o que o professor precisa para emitir a NF.
//
// Vive no banco, por escola, e nunca no repositório: o CLAUDE.md proíbe dado
// fiscal em código versionado, e num SaaS multi-tenant um CNPJ chumbado faria a
// escola B emitir nota contra o CNPJ da escola A.

interface NfSettingsAdminProps {
    /** Só para exibição; o tenant efetivo é resolvido no servidor. */
    tenantId?: string;
}

const CAMPOS: { key: string; label: string; hint?: string; textarea?: boolean }[] = [
    { key: 'cnpj', label: 'CNPJ do tomador', hint: 'Sem ele o tour não é exibido ao professor.' },
    { key: 'razao_social', label: 'Razão Social' },
    { key: 'nome_fantasia', label: 'Nome Fantasia' },
    { key: 'codigo_tributacao', label: 'Código de Tributação Nacional', hint: 'Ex.: 08.02.01' },
    { key: 'descricao_tributacao', label: 'Descrição do código', textarea: true },
    { key: 'descricao_servico', label: 'Descrição do serviço', hint: 'O texto que o professor copia para a nota.' },
    { key: 'portal_url', label: 'URL do portal NFS-e', hint: 'Vazio usa o Emissor Nacional do gov.br.' },
    { key: 'observacoes', label: 'Observações para o professor', textarea: true },
];

const NfSettingsAdmin: React.FC<NfSettingsAdminProps> = ({ tenantId }) => {
    const [form, setForm] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        let alive = true;
        (async () => {
            const { data, error: rpcError } = await supabase.rpc('get_nf_issuance_context');
            if (!alive) return;
            if (rpcError) setError(rpcError.message);
            const s = data?.settings || {};
            setForm(Object.fromEntries(CAMPOS.map(c => [c.key, String(s[c.key] ?? '')])));
            setLoading(false);
        })();
        return () => { alive = false; };
    }, [tenantId]);

    const save = async () => {
        setSaving(true);
        setError('');
        const { data, error: rpcError } = await supabase.rpc('save_nf_settings', { p_payload: form });
        if (rpcError || !data?.ok) {
            setError(rpcError?.message || data?.error || 'Não foi possível salvar.');
            setSaving(false);
            return;
        }
        setSaving(false);
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
    };

    if (loading) {
        return (
            <div className="flex items-center gap-2 p-8 text-brand-muted">
                <Loader2 size={16} className="animate-spin" /> Carregando dados fiscais…
            </div>
        );
    }

    const semCnpj = !String(form.cnpj || '').trim();

    return (
        <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
            <header>
                <div className="mb-2 flex items-center gap-3">
                    <div className="shrink-0 rounded-xl bg-tenant-primary/10 p-3">
                        <FileText className="text-tenant-primary" size={22} />
                    </div>
                    <h1 className="text-2xl font-black tracking-tight text-brand-text">Dados para Nota Fiscal</h1>
                </div>
                <p className="text-sm font-medium text-brand-muted">
                    O que o professor vê ao ser pago. Preencher aqui elimina a pergunta mensal à coordenação.
                </p>
            </header>

            {semCnpj && (
                <div className="flex gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4">
                    <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-500" />
                    <p className="text-xs text-brand-muted">
                        Sem CNPJ preenchido, o tour de emissão <strong className="text-brand-text">não é exibido</strong> ao
                        professor — ele vê apenas um aviso para procurar a coordenação. É proposital: instrução
                        incompleta faz emitir nota contra o CNPJ errado, o que obriga a cancelar e refazer.
                    </p>
                </div>
            )}

            <div className="space-y-4 rounded-3xl border border-brand-border bg-brand-surface p-5 sm:p-6">
                <h2 className="flex items-center gap-2 text-[11px] font-black uppercase tracking-widest text-brand-text">
                    <Building2 size={14} className="text-tenant-primary" /> Tomador do serviço
                </h2>

                {CAMPOS.map(campo => (
                    <div key={campo.key}>
                        <label className="text-[10px] font-black uppercase tracking-widest text-brand-muted">
                            {campo.label}
                        </label>
                        {campo.textarea ? (
                            <textarea
                                rows={2}
                                value={form[campo.key] || ''}
                                onChange={e => setForm({ ...form, [campo.key]: e.target.value })}
                                className="mt-1.5 w-full rounded-xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm font-medium text-brand-text outline-none focus:ring-2 focus:ring-tenant-primary"
                            />
                        ) : (
                            <input
                                value={form[campo.key] || ''}
                                onChange={e => setForm({ ...form, [campo.key]: e.target.value })}
                                className="mt-1.5 w-full rounded-xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm font-bold text-brand-text outline-none focus:ring-2 focus:ring-tenant-primary"
                            />
                        )}
                        {campo.hint && <p className="mt-1 text-[10px] text-brand-muted">{campo.hint}</p>}
                    </div>
                ))}
            </div>

            {error && <p className="text-xs font-bold text-red-500">{error}</p>}

            <button
                type="button"
                onClick={save}
                disabled={saving}
                className="flex w-full items-center justify-center gap-2 rounded-2xl bg-tenant-primary py-4 text-[11px] font-black uppercase tracking-widest text-white disabled:opacity-50"
            >
                {saving ? <Loader2 size={15} className="animate-spin" /> : saved ? <Check size={15} /> : <Save size={15} />}
                {saved ? 'Salvo' : 'Salvar dados fiscais'}
            </button>
        </div>
    );
};

export default NfSettingsAdmin;
