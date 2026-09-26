import React, { useState } from 'react';
import { Copy, Check, DollarSign, User as UserIcon, Briefcase, BadgePercent, MessageCircle } from 'lucide-react';
import { APP_BASE_URL } from '../constants';
import { supabase } from '../lib/supabase';
import {
    DEFAULT_AFFILIATE_COMMISSION_CENTS,
    affiliateInviteErrorMessage,
    formatCents,
    isValidAffiliateCode,
    normalizeAffiliateCode,
} from '../lib/affiliateProgram';

interface Props {
    tenantId: string;
}

/**
 * Convite de afiliado com o cupom já escolhido ("AFILIADA10") e a comissão.
 *
 * `create_affiliate_invite` grava o convite pela porta de sempre
 * (`create_invite_offer`, que confere papel e escola) e reserva o cupom até o
 * convite ser usado ou vencer. O link abre /vendor-onboarding, que explica o
 * programa inteiro antes do cadastro.
 */
const VendorInviteGenerator: React.FC<Props> = ({ tenantId }) => {
    const [commissionReais, setCommissionReais] = useState(String(DEFAULT_AFFILIATE_COMMISSION_CENTS / 100));
    const [name, setName] = useState('');
    const [couponCode, setCouponCode] = useState('');
    const [generatedLink, setGeneratedLink] = useState('');
    const [generatedFor, setGeneratedFor] = useState<{ name: string; code: string; commission: string } | null>(null);
    const [copied, setCopied] = useState(false);
    const [generating, setGenerating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const normalizedCode = normalizeAffiliateCode(couponCode);
    const codeInvalid = couponCode.trim() !== '' && !isValidAffiliateCode(couponCode);

    const handleGenerate = async () => {
        const commissionCents = Math.round(parseFloat((commissionReais || '0').replace(',', '.')) * 100);
        if (!commissionCents || commissionCents <= 0) {
            setError('Informe um valor de comissão válido.');
            return;
        }
        if (codeInvalid) {
            setError('Cupom inválido: use de 4 a 32 letras, números, "-" ou "_", começando por letra ou número.');
            return;
        }
        setGenerating(true);
        setError(null);
        setGeneratedLink('');
        try {
            const { data: offerId, error: rpcError } = await supabase.rpc('create_affiliate_invite', {
                p_commission_cents: commissionCents,
                p_suggested_name: name.trim() || null,
                p_affiliate_code: normalizedCode || null,
            });
            if (rpcError || !offerId) throw rpcError || new Error('offer vazio');
            setGeneratedLink(`${APP_BASE_URL}/vendor-onboarding?offer=${offerId}`);
            setGeneratedFor({ name: name.trim(), code: normalizedCode, commission: formatCents(commissionCents) });
        } catch (e) {
            console.error('Não foi possível criar o convite de afiliado:', e);
            setError(affiliateInviteErrorMessage(e));
        } finally {
            setGenerating(false);
            setCopied(false);
        }
    };

    const handleCopy = () => {
        navigator.clipboard.writeText(generatedLink);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const inviteMessage = generatedFor
        ? `Oi${generatedFor.name ? ` ${generatedFor.name.split(' ')[0]}` : ''}! Você foi convidado(a) para o nosso programa de afiliados. `
            + `${generatedFor.code ? `Seu cupom será *${generatedFor.code}* e ` : ''}a comissão é de ${generatedFor.commission} por matrícula. `
            + `Crie seu acesso por este link — lá explica tudo, do cupom ao saque: ${generatedLink}`
        : '';

    return (
        <div className="bg-brand-surface p-6 rounded-2xl border border-gray-100 dark:border-brand-border shadow-sm">
            <h3 className="text-lg font-black text-gray-800 dark:text-white flex items-center gap-2 mb-4">
                <Briefcase size={18} className="text-tenant-primary" />
                Convidar novo afiliado
            </h3>

            <p className="text-sm text-gray-500 mb-6">
                Defina o cupom e a comissão. O afiliado cria o próprio acesso pelo link, já lendo como o programa
                funciona, e acompanha as indicações e os saques no painel dele.
            </p>

            <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="space-y-1">
                        <label htmlFor="affiliate-invite-name" className="text-[10px] font-black uppercase tracking-widest text-gray-400 ml-1">
                            Nome do afiliado
                        </label>
                        <div className="relative">
                            <UserIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
                            <input
                                id="affiliate-invite-name"
                                type="text"
                                placeholder="Ex.: Gabriela Souza"
                                value={name}
                                onChange={e => setName(e.target.value)}
                                className="w-full pl-9 pr-4 py-2 bg-gray-50 dark:bg-brand-surface-2 border-transparent rounded-xl text-sm font-bold outline-none focus:ring-2 focus:ring-tenant-primary text-brand-text"
                            />
                        </div>
                    </div>

                    <div className="space-y-1">
                        <label htmlFor="affiliate-invite-code" className="text-[10px] font-black uppercase tracking-widest text-gray-400 ml-1">
                            Cupom
                        </label>
                        <div className="relative">
                            <BadgePercent className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
                            <input
                                id="affiliate-invite-code"
                                type="text"
                                placeholder="Ex.: AFILIADA10"
                                value={couponCode}
                                onChange={e => setCouponCode(e.target.value.toUpperCase())}
                                aria-invalid={codeInvalid}
                                className="w-full pl-9 pr-4 py-2 bg-gray-50 dark:bg-brand-surface-2 border-transparent rounded-xl text-sm font-black uppercase tracking-wider outline-none focus:ring-2 focus:ring-tenant-primary text-brand-text"
                            />
                        </div>
                        <p className={`text-[10px] font-bold mt-1 ml-1 ${codeInvalid ? 'text-red-600' : 'text-gray-400'}`}>
                            {codeInvalid
                                ? '4 a 32 letras, números, "-" ou "_".'
                                : couponCode.trim() ? `Fica como ${normalizedCode}.` : 'Em branco: o sistema gera um cupom.'}
                        </p>
                    </div>

                    <div className="space-y-1">
                        <label htmlFor="affiliate-invite-commission" className="text-[10px] font-black uppercase tracking-widest text-gray-400 ml-1">
                            Comissão por matrícula
                        </label>
                        <div className="relative">
                            <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
                            <input
                                id="affiliate-invite-commission"
                                type="number"
                                min="1"
                                step="0.01"
                                value={commissionReais}
                                onChange={e => setCommissionReais(e.target.value)}
                                className="w-full pl-9 pr-4 py-2 bg-gray-50 dark:bg-brand-surface-2 border-transparent rounded-xl text-sm font-bold outline-none focus:ring-2 focus:ring-tenant-primary text-brand-text"
                            />
                        </div>
                        <p className="text-[10px] text-tenant-primary font-bold mt-1 ml-1">
                            Liberada quando a 1ª mensalidade é liquidada.
                        </p>
                    </div>
                </div>

                {error ? (
                    <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs font-bold text-red-700" role="alert">{error}</p>
                ) : null}

                <button
                    onClick={() => void handleGenerate()}
                    disabled={generating}
                    className="w-full py-3 bg-tenant-primary text-white rounded-xl font-bold uppercase tracking-widest text-xs hover:brightness-110 transition-all shadow-lg shadow-tenant-primary/20 disabled:opacity-50"
                >
                    {generating ? 'Gerando…' : 'Gerar link de convite'}
                </button>

                {generatedLink && (
                    <div className="mt-4 animate-in fade-in slide-in-from-top-2 space-y-2">
                        <div className="p-3 bg-gray-50 dark:bg-brand-surface-2 border border-gray-200 dark:border-brand-border rounded-xl flex items-center gap-3">
                            <input
                                readOnly
                                value={generatedLink}
                                aria-label="Link de convite do afiliado"
                                className="flex-1 bg-transparent text-xs font-mono text-gray-600 dark:text-slate-300 outline-none"
                            />
                            <button
                                onClick={handleCopy}
                                aria-label="Copiar link"
                                className={`p-2 rounded-lg transition-all ${copied ? 'bg-green-100 text-green-600' : 'bg-brand-surface shadow-sm text-gray-500 hover:text-tenant-primary'}`}
                            >
                                {copied ? <Check size={16} /> : <Copy size={16} />}
                            </button>
                        </div>
                        <a
                            href={`https://wa.me/?text=${encodeURIComponent(inviteMessage)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 py-2.5 text-xs font-black uppercase tracking-wider text-white hover:bg-emerald-500"
                        >
                            <MessageCircle size={14} /> Enviar convite pelo WhatsApp
                        </a>
                        <p className="text-[10px] text-gray-400 text-center">
                            Link válido por 7 dias e para um único cadastro.{generatedFor?.code ? ` O cupom ${generatedFor.code} fica reservado até lá.` : ''}
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default VendorInviteGenerator;
