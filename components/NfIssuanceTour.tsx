import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import {
    AlertTriangle, ArrowUpRight, Building2, Check, ClipboardList, Copy,
    FileText, Hash, Loader2, Upload, Wallet,
} from 'lucide-react';

// Tour obrigatório de emissão de NF.
//
// Aparece quando o financeiro autoriza o pagamento e some assim que o professor
// confirma a leitura — uma vez por fechamento. Quem decide se aparece é o
// servidor (`get_nf_issuance_context`), não esta tela: o status do fechamento é
// dado do banco, e replicar a regra aqui criaria uma segunda versão dela.
//
// NÃO tem X nem fecha por clique fora, de propósito. "Obrigatório" é o pedido; o
// custo de fechar sem ler é a nota voltar errada e o pagamento travar.

interface NfSettings {
    cnpj?: string | null;
    razao_social?: string | null;
    nome_fantasia?: string | null;
    codigo_tributacao?: string | null;
    descricao_tributacao?: string | null;
    descricao_servico?: string | null;
    portal_url?: string | null;
    observacoes?: string | null;
}

interface PendingClosing {
    id: string;
    month_year: string;
    total_amount?: number | null;
    total_lessons?: number | null;
    status: string;
}

interface NfIssuanceTourProps {
    /** Reconsulta os fechamentos depois do aceite (a tela de NF recarrega). */
    onDone?: () => void;
    /**
     * Consulta avulsa: o professor clicou em "Como emitir minha nota". Mostra as
     * mesmas instruções mesmo sem fechamento pendente, e o botão só fecha — não
     * registra aceite de um fechamento que ele não foi obrigado a ler agora.
     */
    manual?: boolean;
    /** Fecha o modo consulta. */
    onClose?: () => void;
}

const PORTAL_PADRAO = 'https://www.nfse.gov.br/EmissorNacional';

const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const mesExtenso = (monthYear: string) => {
    // month_year é 'YYYY-MM'. Dia 02 evita o fuso comer um dia e mostrar o mês anterior.
    const d = new Date(`${monthYear}-02T00:00:00`);
    if (isNaN(d.getTime())) return monthYear;
    return d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
};

/** Botão de copiar com confirmação visual — o professor precisa saber que pegou. */
const CopyButton: React.FC<{ value?: string | null; label: string; className?: string }> = ({
    value, label, className = '',
}) => {
    const [copied, setCopied] = useState(false);

    const copy = async () => {
        const text = String(value || '').trim();
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            // Safari/iOS sem permissão de clipboard: fallback pelo textarea oculto,
            // senão o botão não faz nada e o professor acha que a tela travou.
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch { /* sem clipboard, desiste */ }
            document.body.removeChild(ta);
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
    };

    if (!String(value || '').trim()) return null;

    return (
        <button
            type="button"
            onClick={copy}
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border text-[10px] font-black uppercase tracking-widest transition-all ${
                copied
                    ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-600'
                    : 'bg-brand-surface-2 border-brand-border text-brand-muted hover:text-brand-text hover:border-brand-accent'
            } ${className}`}
        >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? 'Copiado' : label}
        </button>
    );
};

/** Linha de dado com destaque opcional (CNPJ e código de tributação são os que erram). */
const DataRow: React.FC<{
    label: string;
    value?: string | null;
    copyLabel?: string;
    highlight?: boolean;
    mono?: boolean;
}> = ({ label, value, copyLabel, highlight = false, mono = false }) => {
    if (!String(value || '').trim()) return null;
    return (
        <div
            className={`flex flex-wrap items-center justify-between gap-2 rounded-2xl p-3.5 border ${
                highlight
                    ? 'bg-amber-500/10 border-amber-500/40'
                    : 'bg-brand-surface-2 border-brand-border'
            }`}
        >
            <div className="min-w-0">
                <p className="text-[9px] font-black uppercase tracking-widest text-brand-muted">{label}</p>
                <p className={`mt-0.5 break-words text-brand-text ${
                    highlight ? 'text-lg font-black tracking-tight' : 'text-sm font-bold'
                } ${mono ? 'font-mono' : ''}`}>
                    {value}
                </p>
            </div>
            {copyLabel && <CopyButton value={value} label={copyLabel} />}
        </div>
    );
};

const Step: React.FC<{
    n: number;
    title: string;
    icon: React.ReactNode;
    children: React.ReactNode;
}> = ({ n, title, icon, children }) => (
    <section className="flex gap-3">
        <div className="flex flex-col items-center">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-accent text-white text-[11px] font-black">
                {n}
            </div>
            <div className="mt-1 w-px flex-1 bg-brand-border" />
        </div>
        <div className="min-w-0 flex-1 pb-5">
            <h3 className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-widest text-brand-text">
                {icon} {title}
            </h3>
            <div className="mt-2 space-y-2">{children}</div>
        </div>
    </section>
);

const NfIssuanceTour: React.FC<NfIssuanceTourProps> = ({ onDone, manual = false, onClose }) => {
    const [loading, setLoading] = useState(true);
    const [settings, setSettings] = useState<NfSettings | null>(null);
    const [configured, setConfigured] = useState(false);
    const [pending, setPending] = useState<PendingClosing | null>(null);
    const [acking, setAcking] = useState(false);
    const [error, setError] = useState('');
    const [copiedAll, setCopiedAll] = useState(false);

    useEffect(() => {
        let alive = true;
        (async () => {
            const { data, error: rpcError } = await supabase.rpc('get_nf_issuance_context');
            if (!alive) return;
            if (rpcError || !data?.ok) {
                // Falha aqui não pode travar a tela de notas fiscais: o tour é um
                // acessório do fluxo, não o fluxo. Some em silêncio e loga.
                console.error('get_nf_issuance_context', rpcError || data?.error);
                setLoading(false);
                return;
            }
            setSettings(data.settings || null);
            setConfigured(!!data.configured);
            setPending(data.pending || null);
            setLoading(false);
        })();
        return () => { alive = false; };
    }, []);

    const portal = String(settings?.portal_url || '').trim() || PORTAL_PADRAO;

    const valorNota = useMemo(() => {
        const v = Number(pending?.total_amount || 0);
        return v > 0 ? brl(v) : null;
    }, [pending]);

    /** "Copiar tudo": o bloco inteiro num clique, para colar no portal ou guardar. */
    const resumoCompleto = useMemo(() => {
        const linhas = [
            'DADOS PARA EMISSÃO DA NOTA FISCAL',
            '',
            'TOMADOR DO SERVIÇO',
            settings?.cnpj ? `CNPJ: ${settings.cnpj}` : null,
            settings?.razao_social ? `Razão Social: ${settings.razao_social}` : null,
            settings?.nome_fantasia ? `Nome Fantasia: ${settings.nome_fantasia}` : null,
            '',
            settings?.codigo_tributacao ? `CÓDIGO DE TRIBUTAÇÃO NACIONAL: ${settings.codigo_tributacao}` : null,
            settings?.descricao_tributacao || null,
            '',
            settings?.descricao_servico ? `DESCRIÇÃO DO SERVIÇO: ${settings.descricao_servico}` : null,
            valorNota ? `VALOR DA NOTA: ${valorNota}` : null,
            pending?.month_year ? `REFERÊNCIA: ${mesExtenso(pending.month_year)}` : null,
        ].filter(Boolean);
        return linhas.join('\n');
    }, [settings, valorNota, pending]);

    const copiarTudo = async () => {
        try {
            await navigator.clipboard.writeText(resumoCompleto);
        } catch {
            return;
        }
        setCopiedAll(true);
        setTimeout(() => setCopiedAll(false), 2200);
    };

    const handleAck = async () => {
        // Consulta avulsa não registra aceite: o aceite significa "fui avisado ao
        // ser pago". Marcá-lo aqui faria o tour obrigatório não aparecer depois.
        if (manual || !pending) { onClose?.(); return; }
        if (acking) return;
        setAcking(true);
        setError('');
        const { data, error: rpcError } = await supabase.rpc('ack_nf_tour', { p_closing_id: pending.id });
        if (rpcError || !data?.ok) {
            setError(rpcError?.message || data?.error || 'Não foi possível confirmar. Tente de novo.');
            setAcking(false);
            return;
        }
        setPending(null);
        onDone?.();
    };

    // Sem fechamento autorizado pendente = não há tour obrigatório a mostrar.
    if (loading) return null;
    if (!manual && !pending) return null;

    return (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
            {/* Sem onClick de fechar no overlay: o tour é obrigatório. */}
            <div className="bg-brand-surface rounded-3xl w-full max-w-xl border border-brand-border shadow-2xl max-h-[92dvh] flex flex-col">

                <header className="px-6 py-5 border-b border-brand-border bg-brand-surface-2/50 rounded-t-3xl">
                    <div className="flex items-center gap-2.5">
                        <FileText size={20} className="text-brand-accent" />
                        <h2 className="text-lg font-black tracking-tight text-brand-text">Emissão da Nota Fiscal</h2>
                    </div>
                    <p className="mt-1.5 text-xs text-brand-muted font-medium">
                        {pending ? (
                            <>
                                Seu pagamento de <strong className="text-brand-text">{mesExtenso(pending.month_year)}</strong> foi
                                autorizado. Para receber, emita sua Nota Fiscal de Serviços seguindo as instruções abaixo.
                            </>
                        ) : (
                            <>Para receber o pagamento, emita sua Nota Fiscal de Serviços seguindo as instruções abaixo.</>
                        )}
                    </p>
                </header>

                <div className="flex-1 overflow-y-auto px-6 py-5">
                    {!configured ? (
                        // A escola ainda não preencheu o tomador. Instrução pela metade
                        // faz o professor emitir contra CNPJ errado — pior que não ter tour.
                        <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 flex gap-3">
                            <AlertTriangle size={18} className="text-amber-500 shrink-0 mt-0.5" />
                            <div>
                                <p className="text-sm font-bold text-brand-text">Dados fiscais ainda não configurados</p>
                                <p className="mt-1 text-xs text-brand-muted">
                                    A coordenação ainda não cadastrou os dados do tomador do serviço.
                                    Entre em contato antes de emitir a nota — emitir com dados errados
                                    obriga a cancelar e refazer.
                                </p>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-1">
                            <Step n={1} title="Emissão" icon={<ArrowUpRight size={13} />}>
                                <p className="text-xs text-brand-muted">
                                    Acesse o portal <strong className="text-brand-text">gov.br/NFS-e</strong> ou o aplicativo MEI.
                                </p>
                                <a
                                    href={portal}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-brand-accent text-white text-[10px] font-black uppercase tracking-widest hover:bg-brand-accent-hover"
                                >
                                    <ArrowUpRight size={13} /> Abrir Portal NFS-e
                                </a>
                            </Step>

                            <Step n={2} title="Tomador do Serviço" icon={<Building2 size={13} />}>
                                <DataRow label="CNPJ" value={settings?.cnpj} copyLabel="Copiar CNPJ" highlight mono />
                                <DataRow label="Razão Social" value={settings?.razao_social} copyLabel="Copiar Razão Social" />
                                <DataRow label="Nome Fantasia" value={settings?.nome_fantasia} copyLabel="Copiar" />
                            </Step>

                            <Step n={3} title="Código de Tributação Nacional" icon={<Hash size={13} />}>
                                <DataRow
                                    label="Código"
                                    value={settings?.codigo_tributacao}
                                    copyLabel={`Copiar Código ${settings?.codigo_tributacao || ''}`.trim()}
                                    highlight
                                    mono
                                />
                                {settings?.descricao_tributacao && (
                                    <p className="text-xs text-brand-muted leading-relaxed">{settings.descricao_tributacao}</p>
                                )}
                            </Step>

                            <Step n={4} title="Descrição do Serviço" icon={<ClipboardList size={13} />}>
                                <DataRow label="Descrição" value={settings?.descricao_servico} copyLabel="Copiar Descrição" />
                            </Step>

                            <Step n={5} title="Valor da Nota" icon={<Wallet size={13} />}>
                                {valorNota ? (
                                    <>
                                        <DataRow label="Emita exatamente este valor" value={valorNota} copyLabel="Copiar Valor" highlight />
                                        {!!pending?.total_lessons && (
                                            <p className="text-[11px] text-brand-muted">
                                                Referente a {pending.total_lessons} aula(s) em {mesExtenso(pending.month_year)}.
                                            </p>
                                        )}
                                    </>
                                ) : (
                                    <p className="text-xs text-brand-muted">
                                        Emita exatamente o valor informado no seu fechamento.
                                    </p>
                                )}
                            </Step>

                            <Step n={6} title="Envio" icon={<Upload size={13} />}>
                                <p className="text-xs text-brand-muted">
                                    Após emitir a nota, anexe o PDF aqui mesmo, na aba{' '}
                                    <strong className="text-brand-text">Notas Fiscais</strong> da plataforma.
                                </p>
                            </Step>

                            <div className="pt-1 space-y-3">
                                <button
                                    type="button"
                                    onClick={copiarTudo}
                                    className={`w-full inline-flex items-center justify-center gap-2 py-3 rounded-2xl border text-[10px] font-black uppercase tracking-widest transition-all ${
                                        copiedAll
                                            ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-600'
                                            : 'bg-brand-surface-2 border-brand-border text-brand-muted hover:text-brand-text'
                                    }`}
                                >
                                    {copiedAll ? <Check size={14} /> : <Copy size={14} />}
                                    {copiedAll ? 'Todas as informações copiadas' : 'Copiar todas as informações'}
                                </button>

                                <p className="text-[11px] text-brand-muted text-center">
                                    Caso tenha qualquer dúvida, entre em contato com a coordenação.
                                </p>
                            </div>
                        </div>
                    )}
                </div>

                <footer className="px-6 py-4 border-t border-brand-border bg-brand-surface-2/50 rounded-b-3xl">
                    {error && (
                        <p className="mb-2 text-[11px] font-bold text-red-500 text-center">{error}</p>
                    )}
                    <button
                        type="button"
                        onClick={handleAck}
                        disabled={acking}
                        className="w-full py-4 bg-brand-accent text-white rounded-2xl font-black text-[11px] uppercase tracking-widest hover:bg-brand-accent-hover disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                        {acking ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
                        {manual || !pending ? 'Fechar' : 'Entendi'}
                    </button>
                    {!manual && pending && (
                        <p className="mt-2 text-[10px] text-brand-muted text-center">
                            Você verá estas instruções uma vez por fechamento. Elas continuam disponíveis na aba Notas Fiscais.
                        </p>
                    )}
                </footer>
            </div>
        </div>
    );
};

export default NfIssuanceTour;
