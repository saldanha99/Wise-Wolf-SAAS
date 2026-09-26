import React, { useCallback, useEffect, useState } from 'react';
import {
    TrendingUp, Users, Clock, CheckCircle, Award, Copy, Wallet, Check, BadgePercent,
    MessageCircle, BookOpen, RefreshCw, AlertTriangle, KeyRound, Loader2,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { User } from '../types';
import {
    PIX_KEY_TYPES,
    STAGE_LABEL,
    affiliateErrorMessage,
    affiliateShareMessage,
    formatCents,
    formatDayMonth,
    referralStageDetail,
    withdrawalStatusLabel,
    type AffiliatePanelData,
} from '../lib/affiliateProgram';

interface VendorDashboardProps {
    user: User;
    tenantId?: string;
    teachers?: any[];
    onNavigate?: (tab: string) => void;
}

const TONE_CLASS: Record<string, string> = {
    amber: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-300 dark:border-amber-800',
    sky: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-900/20 dark:text-sky-300 dark:border-sky-800',
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-300 dark:border-emerald-800',
    violet: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-900/20 dark:text-violet-300 dark:border-violet-800',
    slate: 'bg-slate-50 text-slate-500 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700',
};

/**
 * Painel do afiliado: o cupom (a indicação dele), as indicações por etapa, o
 * saldo e o saque. Tudo vem de `get_my_affiliate_panel` — a etapa de cada
 * indicação é decidida no servidor, a partir do pagamento real.
 */
const VendorDashboard: React.FC<VendorDashboardProps> = ({ user, onNavigate }) => {
    const [panel, setPanel] = useState<AffiliatePanelData | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [copied, setCopied] = useState<'code' | 'message' | null>(null);

    const [pixType, setPixType] = useState('CPF');
    const [pixKey, setPixKey] = useState('');
    const [editingPix, setEditingPix] = useState(false);
    const [savingPix, setSavingPix] = useState(false);
    const [pixMessage, setPixMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

    const [withdrawing, setWithdrawing] = useState(false);
    const [withdrawMessage, setWithdrawMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setLoadError(null);
        const { data, error } = await supabase.rpc('get_my_affiliate_panel');
        const record = data as (AffiliatePanelData & { ok?: boolean; error?: string }) | null;
        if (error || !record?.ok) {
            setLoadError(affiliateErrorMessage(record?.error));
            setLoading(false);
            return;
        }
        setPanel(record);
        setPixType(record.affiliate.pix_key_type || 'CPF');
        setPixKey(record.affiliate.pix_key || '');
        setEditingPix(!record.affiliate.pix_key);
        setLoading(false);
    }, []);

    useEffect(() => { void load(); }, [load, user.id]);

    const copy = async (kind: 'code' | 'message', text: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(kind);
            setTimeout(() => setCopied(null), 1800);
        } catch {
            setCopied(null);
        }
    };

    const savePix = async () => {
        setSavingPix(true);
        setPixMessage(null);
        const { data, error } = await supabase.rpc('set_my_affiliate_pix', {
            p_pix_key: pixKey,
            p_pix_key_type: pixType,
        });
        setSavingPix(false);
        const record = data as { ok?: boolean; error?: string } | null;
        if (error || !record?.ok) {
            setPixMessage({ tone: 'error', text: affiliateErrorMessage(record?.error || 'INVALID_PIX') });
            return;
        }
        setPixMessage({ tone: 'ok', text: 'Chave PIX salva.' });
        await load();
    };

    const requestWithdrawal = async () => {
        setWithdrawing(true);
        setWithdrawMessage(null);
        const { data, error } = await supabase.rpc('request_vendor_withdrawal');
        setWithdrawing(false);
        const record = data as { ok?: boolean; error?: string; amount_cents?: number } | null;
        if (error || !record?.ok) {
            setWithdrawMessage({ tone: 'error', text: affiliateErrorMessage(record?.error) });
            return;
        }
        setWithdrawMessage({
            tone: 'ok',
            text: `Saque de ${formatCents(record.amount_cents)} solicitado. A escola aprova e paga no seu PIX.`,
        });
        await load();
    };

    if (loading && !panel) {
        return <div className="flex justify-center py-20"><Loader2 className="animate-spin text-tenant-primary" size={28} /></div>;
    }

    if (loadError || !panel) {
        return (
            <div className="mx-auto max-w-lg rounded-2xl border border-brand-border bg-brand-surface p-8 text-center">
                <AlertTriangle className="mx-auto mb-3 text-amber-500" size={32} />
                <p className="text-sm font-bold text-brand-text">{loadError || 'Não foi possível carregar o painel.'}</p>
                <button onClick={() => void load()} className="mt-4 rounded-xl border border-brand-border px-4 py-2 text-xs font-bold text-brand-text">
                    Tentar de novo
                </button>
            </div>
        );
    }

    const { affiliate, totals, referrals, withdrawals } = panel;
    const code = affiliate.affiliate_code || '';
    const shareText = code ? affiliateShareMessage(code, affiliate.school_name) : '';
    const inProgress = totals.waiting_payment + totals.settling;
    const pixReady = Boolean(affiliate.pix_key);
    const pixPlaceholder = PIX_KEY_TYPES.find(type => type.value === pixType)?.placeholder || '';

    return (
        <div className="space-y-6 animate-in fade-in duration-500">
            <header className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h2 className="flex items-center gap-3 text-2xl font-black text-brand-text">
                        <TrendingUp className="text-tenant-primary" size={28} /> Painel do afiliado
                    </h2>
                    <p className="mt-1 text-sm text-brand-muted">
                        {affiliate.school_name ? `${affiliate.school_name} · ` : ''}
                        Comissão de <strong className="text-emerald-600">{formatCents(affiliate.commission_cents)}</strong> por matrícula,
                        liberada quando a 1ª mensalidade é liquidada.
                    </p>
                </div>
                <div className="flex gap-2">
                    <button
                        onClick={() => onNavigate?.('vendor_guide')}
                        className="flex items-center gap-2 rounded-xl border border-brand-border px-3 py-2 text-xs font-bold text-brand-text hover:bg-brand-surface-2"
                    >
                        <BookOpen size={14} /> Como funciona
                    </button>
                    <button onClick={() => void load()} aria-label="Atualizar painel" className="rounded-xl border border-brand-border p-2 text-brand-muted hover:text-brand-text">
                        <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
                    </button>
                </div>
            </header>

            {!affiliate.active ? (
                <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300" role="status">
                    <AlertTriangle size={18} className="mt-0.5 shrink-0" />
                    <p className="text-xs font-semibold">Seu cadastro de afiliado está inativo: o cupom não vale para novas matrículas. Fale com a escola.</p>
                </div>
            ) : null}

            {/* Cupom */}
            <section className="rounded-2xl bg-gradient-to-br from-slate-950 to-slate-800 p-6 text-white shadow-sm" data-tour="affiliate-coupon-card">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Seu cupom de afiliado</p>
                <div className="mt-3 flex items-center gap-3">
                    <BadgePercent size={22} className="shrink-0 text-emerald-400" aria-hidden="true" />
                    <code className="min-w-0 flex-1 truncate text-2xl font-black tracking-wider">{code || 'Gerando…'}</code>
                    <button onClick={() => void copy('code', code)} disabled={!code} className="rounded-xl bg-white/10 p-3 hover:bg-white/20 disabled:opacity-40" aria-label="Copiar cupom">
                        {copied === 'code' ? <Check size={18} /> : <Copy size={18} />}
                    </button>
                </div>
                <p className="mt-3 text-xs text-slate-300">
                    Quem se matricula com este cupom fica isento da taxa de matrícula. A pessoa informa o cupom
                    na conversa com a escola — ou diz que foi você quem indicou — ou digita na página de matrícula.
                </p>
                {code ? (
                    <div className="mt-4 flex flex-wrap gap-2">
                        <a
                            href={`https://wa.me/?text=${encodeURIComponent(shareText)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2 text-xs font-black uppercase tracking-wider text-white hover:bg-emerald-400"
                        >
                            <MessageCircle size={14} /> Divulgar no WhatsApp
                        </a>
                        <button onClick={() => void copy('message', shareText)} className="inline-flex items-center gap-2 rounded-xl bg-white/10 px-4 py-2 text-xs font-bold hover:bg-white/20">
                            {copied === 'message' ? <Check size={14} /> : <Copy size={14} />} Copiar mensagem pronta
                        </button>
                    </div>
                ) : null}
            </section>

            {/* Números */}
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                <Stat icon={<Users size={16} className="text-tenant-primary" />} label="Indicações" value={String(totals.referrals)} hint={`${totals.released} já liberada(s)`} />
                <Stat icon={<Clock size={16} className="text-amber-500" />} label="Em andamento" value={formatCents(totals.pending_cents)} hint={`${totals.waiting_payment} aguardando pagamento · ${totals.settling} em liquidação`} />
                <Stat icon={<CheckCircle size={16} className="text-emerald-500" />} label="Disponível para saque" value={formatCents(totals.available_cents)} hint={totals.requested_cents > 0 ? `${formatCents(totals.requested_cents)} em saque` : 'pronto para pedir'} />
                <Stat icon={<Award size={16} className="text-emerald-600" />} label="Já recebido" value={formatCents(totals.paid_cents)} hint="pago no seu PIX" />
            </div>

            {/* Saque */}
            <section className="grid gap-4 lg:grid-cols-2">
                <div className="rounded-2xl border border-brand-border bg-brand-surface p-6">
                    <h3 className="flex items-center gap-2 text-sm font-black text-brand-text"><KeyRound size={16} className="text-tenant-primary" /> Sua chave PIX</h3>
                    <p className="mt-1 text-xs text-brand-muted">É para ela que a escola paga as suas comissões.</p>
                    {!editingPix && pixReady ? (
                        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-brand-border px-3 py-2">
                            <p className="min-w-0 truncate text-sm font-bold text-brand-text">
                                {PIX_KEY_TYPES.find(type => type.value === affiliate.pix_key_type)?.label || 'PIX'}: {affiliate.pix_key}
                            </p>
                            <button onClick={() => { setEditingPix(true); setPixMessage(null); }} className="text-xs font-bold text-tenant-primary underline">Trocar</button>
                        </div>
                    ) : (
                        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                            <select
                                value={pixType}
                                onChange={event => setPixType(event.target.value)}
                                aria-label="Tipo da chave PIX"
                                className="rounded-xl border border-brand-border bg-brand-surface-2 px-3 py-2 text-sm text-brand-text"
                            >
                                {PIX_KEY_TYPES.map(type => <option key={type.value} value={type.value}>{type.label}</option>)}
                            </select>
                            <input
                                value={pixKey}
                                onChange={event => setPixKey(event.target.value)}
                                placeholder={pixPlaceholder}
                                aria-label="Chave PIX"
                                className="min-w-0 flex-1 rounded-xl border border-brand-border bg-brand-surface-2 px-3 py-2 text-sm text-brand-text"
                            />
                            <button
                                onClick={() => void savePix()}
                                disabled={savingPix || !pixKey.trim()}
                                className="rounded-xl bg-tenant-primary px-4 py-2 text-xs font-black uppercase tracking-wider text-white disabled:opacity-50"
                            >
                                {savingPix ? 'Salvando…' : 'Salvar'}
                            </button>
                        </div>
                    )}
                    {pixMessage ? (
                        <p className={`mt-2 text-xs font-bold ${pixMessage.tone === 'ok' ? 'text-emerald-600' : 'text-red-600'}`} role="status">{pixMessage.text}</p>
                    ) : null}
                </div>

                <div className="rounded-2xl border border-brand-border bg-brand-surface p-6" data-tour="affiliate-withdrawal">
                    <h3 className="flex items-center gap-2 text-sm font-black text-brand-text"><Wallet size={16} className="text-tenant-primary" /> Solicitar saque</h3>
                    <p className="mt-1 text-xs text-brand-muted">
                        Entram no saque as comissões já liberadas (1ª mensalidade liquidada). A escola aprova e paga no seu PIX.
                    </p>
                    {!pixReady ? <p className="mt-2 text-xs font-bold text-amber-600">Cadastre sua chave PIX para poder sacar.</p> : null}
                    <button
                        onClick={() => void requestWithdrawal()}
                        disabled={withdrawing || !pixReady || totals.available_cents <= 0}
                        className="mt-4 w-full rounded-xl bg-emerald-600 px-4 py-3 text-xs font-black uppercase tracking-wider text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        {withdrawing ? 'Solicitando…' : `Solicitar ${formatCents(totals.available_cents)}`}
                    </button>
                    {withdrawMessage ? (
                        <p className={`mt-2 text-xs font-bold ${withdrawMessage.tone === 'ok' ? 'text-emerald-600' : 'text-red-600'}`} role="status">{withdrawMessage.text}</p>
                    ) : null}
                </div>
            </section>

            {/* Indicações */}
            <section className="overflow-hidden rounded-2xl border border-brand-border bg-brand-surface">
                <div className="border-b border-brand-border p-5">
                    <h3 className="text-xs font-black uppercase tracking-widest text-brand-muted">Suas indicações</h3>
                </div>
                {referrals.length === 0 ? (
                    <div className="p-10 text-center">
                        <TrendingUp size={40} className="mx-auto mb-3 opacity-20" />
                        <p className="text-sm font-bold text-brand-muted">Nenhuma indicação ainda</p>
                        <p className="mt-1 text-xs text-brand-muted">Divulgue o seu cupom: cada matrícula com ele aparece aqui.</p>
                    </div>
                ) : (
                    <ul className="divide-y divide-brand-border">
                        {referrals.map(referral => {
                            const label = STAGE_LABEL[referral.stage] || { label: referral.stage, tone: 'slate' };
                            return (
                                <li key={referral.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                                    <div className="min-w-0">
                                        <p className="text-sm font-bold text-brand-text">
                                            {referral.student_display}
                                            <span className="ml-2 text-xs font-normal text-brand-muted">indicado em {formatDayMonth(referral.referred_at)}</span>
                                        </p>
                                        <p className="mt-0.5 text-xs text-brand-muted">{referralStageDetail(referral)}</p>
                                    </div>
                                    <div className="flex items-center gap-3">
                                        <span className="text-sm font-black text-emerald-600">{formatCents(referral.amount_cents)}</span>
                                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-black uppercase ${TONE_CLASS[label.tone]}`}>{label.label}</span>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </section>

            {withdrawals.length > 0 ? (
                <section className="overflow-hidden rounded-2xl border border-brand-border bg-brand-surface">
                    <div className="border-b border-brand-border p-5">
                        <h3 className="text-xs font-black uppercase tracking-widest text-brand-muted">Seus saques</h3>
                    </div>
                    <ul className="divide-y divide-brand-border">
                        {withdrawals.map(request => (
                            <li key={request.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-4 text-sm">
                                <div>
                                    <p className="font-black text-brand-text">{formatCents(request.amount_cents)}</p>
                                    <p className="text-xs text-brand-muted">
                                        {request.commission_count} comissão(ões) · pedido em {formatDayMonth(request.requested_at)}
                                        {request.review_note ? ` · ${request.review_note}` : ''}
                                    </p>
                                </div>
                                <span className="rounded-full border border-brand-border px-2 py-1 text-[10px] font-black uppercase text-brand-text">{withdrawalStatusLabel(request.status)}</span>
                            </li>
                        ))}
                    </ul>
                </section>
            ) : null}

            {inProgress > 0 ? (
                <p className="text-center text-[11px] text-brand-muted">
                    Liberação: Pix na hora · boleto na compensação (até 2 dias úteis) · cartão quando o valor cai (até ~30 dias).
                </p>
            ) : null}
        </div>
    );
};

const Stat: React.FC<{ icon: React.ReactNode; label: string; value: string; hint?: string }> = ({ icon, label, value, hint }) => (
    <div className="rounded-2xl border border-brand-border bg-brand-surface p-4">
        <div className="mb-1 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-brand-muted">{icon}{label}</div>
        <p className="text-xl font-black text-brand-text">{value}</p>
        {hint ? <p className="mt-0.5 text-[11px] text-brand-muted">{hint}</p> : null}
    </div>
);

export default VendorDashboard;
