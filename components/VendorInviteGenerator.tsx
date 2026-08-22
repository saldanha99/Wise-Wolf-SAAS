import React, { useState } from 'react';
import { Copy, Check, Link as LinkIcon, DollarSign, User as UserIcon, Briefcase } from 'lucide-react';
import { APP_BASE_URL } from '../constants';
import { supabase } from '../lib/supabase';

interface Props {
    tenantId: string;
}

/**
 * Geração de link para convidar VENDEDOR (SALESPERSON).
 * Espelha o TeacherInviteGenerator para manter UX consistente.
 *
 * Payload: { kind: 'VENDOR_INVITE', commissionRate (centavos), tenantId, exp }
 * URL: /vendor-onboarding?offer=<base64>
 * O componente VendorOnboarding (a criar) consome o payload e dispara
 * a edge function register-vendor (a criar) com a service role.
 */
const VendorInviteGenerator: React.FC<Props> = ({ tenantId }) => {
    const [commissionReais, setCommissionReais] = useState('30');
    const [name, setName] = useState('');
    const [generatedLink, setGeneratedLink] = useState('');
    const [copied, setCopied] = useState(false);

    const handleGenerate = async () => {
        const commissionCents = Math.round(parseFloat(commissionReais || '0') * 100);
        if (!commissionCents || commissionCents <= 0) {
            alert('Informe um valor de comissão válido.');
            return;
        }

        const payload = {
            kind: 'VENDOR_INVITE',
            commissionRate: commissionCents,
            suggestedName: name || null,
            tenantId,
        };

        // A comissão autoritativa fica na oferta server-side. Nunca criamos um
        // fallback editável no navegador quando essa gravação falha.
        try {
            const { data: offerId, error } = await supabase.rpc('create_invite_offer', { p_kind: 'VENDOR_INVITE', p_payload: payload });
            if (error || !offerId) throw error || new Error('offer vazio');
            setGeneratedLink(`${APP_BASE_URL}/vendor-onboarding?offer=${offerId}`);
        } catch (e) {
            console.error('Não foi possível criar o convite seguro:', e);
            setGeneratedLink('');
            alert('Não foi possível gerar um convite seguro. Tente novamente.');
        }
        setCopied(false);
    };

    const handleCopy = () => {
        navigator.clipboard.writeText(generatedLink);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="bg-brand-surface p-6 rounded-2xl border border-gray-100 dark:border-brand-border shadow-sm">
            <h3 className="text-lg font-black text-gray-800 dark:text-white flex items-center gap-2 mb-4">
                <Briefcase size={18} className="text-tenant-primary" />
                Convidar Novo Vendedor
            </h3>

            <p className="text-sm text-gray-500 mb-6">
                Gere um link com a comissão pré-definida. O vendedor faz seu próprio cadastro
                e ganha acesso ao painel de comissões.
            </p>

            <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-1">
                        <label className="text-[10px] font-black uppercase tracking-widest text-gray-400 ml-1">
                            Comissão por matrícula
                        </label>
                        <div className="relative">
                            <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
                            <input
                                type="number"
                                value={commissionReais}
                                onChange={e => setCommissionReais(e.target.value)}
                                className="w-full pl-9 pr-4 py-2 bg-gray-50 dark:bg-brand-surface-2 border-transparent rounded-xl text-sm font-bold outline-none focus:ring-2 focus:ring-tenant-primary"
                            />
                        </div>
                        <p className="text-[10px] text-tenant-primary font-bold mt-1 ml-1">
                            R$ {parseFloat(commissionReais || '0').toFixed(2)} por matrícula confirmada.
                        </p>
                    </div>

                    <div className="space-y-1">
                        <label className="text-[10px] font-black uppercase tracking-widest text-gray-400 ml-1">
                            Nome sugerido (opcional)
                        </label>
                        <div className="relative">
                            <UserIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
                            <input
                                type="text"
                                placeholder="Ex: João Vendas"
                                value={name}
                                onChange={e => setName(e.target.value)}
                                className="w-full pl-9 pr-4 py-2 bg-gray-50 dark:bg-brand-surface-2 border-transparent rounded-xl text-sm font-bold outline-none focus:ring-2 focus:ring-tenant-primary"
                            />
                        </div>
                    </div>
                </div>

                <button
                    onClick={handleGenerate}
                    className="w-full py-3 bg-tenant-primary text-white rounded-xl font-bold uppercase tracking-widest text-xs hover:brightness-110 transition-all shadow-lg shadow-tenant-primary/20"
                >
                    Gerar Link de Convite
                </button>

                {generatedLink && (
                    <div className="mt-4 animate-in fade-in slide-in-from-top-2">
                        <div className="p-3 bg-gray-50 dark:bg-brand-surface-2 border border-gray-200 dark:border-brand-border rounded-xl flex items-center gap-3">
                            <input
                                readOnly
                                value={generatedLink}
                                className="flex-1 bg-transparent text-xs font-mono text-gray-600 dark:text-slate-300 outline-none"
                            />
                            <button
                                onClick={handleCopy}
                                className={`p-2 rounded-lg transition-all ${copied ? 'bg-green-100 text-green-600' : 'bg-brand-surface shadow-sm text-gray-500 hover:text-tenant-primary'}`}
                            >
                                {copied ? <Check size={16} /> : <Copy size={16} />}
                            </button>
                        </div>
                        <p className="text-[10px] text-gray-400 mt-2 text-center">
                            Link válido por 7 dias.
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default VendorInviteGenerator;
