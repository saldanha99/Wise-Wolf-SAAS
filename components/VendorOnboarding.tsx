import React, { useState, useEffect } from 'react';
import { Briefcase, User, Mail, Lock, Phone, AlertCircle, CheckCircle, Loader2, DollarSign, BadgePercent } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { tenantLegalAssetsService } from '../services/tenantLegalAssetsService';
import { formatCents } from '../lib/affiliateProgram';
import AffiliateProgramGuide from './affiliate/AffiliateProgramGuide';

/**
 * Cadastro do afiliado pelo link de convite (/vendor-onboarding?offer=<uuid>).
 * A página já explica o programa inteiro — cupom, liquidação e saque — antes
 * de pedir os dados: quem aceita o convite sabe como vai receber.
 */
const VendorOnboarding: React.FC = () => {
    const [step, setStep] = useState<'OFFER' | 'FORM' | 'SUCCESS'>('OFFER');
    const [offerData, setOfferData] = useState<any>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [phone, setPhone] = useState('');
    const [acceptedTerms, setAcceptedTerms] = useState(false);

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const encodedOffer = params.get('offer');

        if (!encodedOffer) {
            setError('Link inválido.');
            return;
        }

        const apply = (data: any) => {
            if (data.kind !== 'VENDOR_INVITE') { setError('Link de convite inválido.'); return; }
            setOfferData(data);
            if (data.suggestedName) setName(data.suggestedName);
        };

        // Caminho seguro: offer_id (UUID) → comissão AUTORITATIVA vem do servidor.
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (UUID_RE.test(encodedOffer.trim())) {
            (async () => {
                try {
                    const payload = await tenantLegalAssetsService.vendorOffer(encodedOffer.trim());
                    if (!payload || payload.error) throw new Error('offer_unavailable');
                    apply(payload);
                } catch {
                    setError('Link de convite inválido, expirado ou já utilizado. Solicite um novo.');
                }
            })();
            return;
        }

        setError('Este convite antigo não possui validação server-side. Solicite um novo link seguro.');
    }, []);

    const handleRegister = async () => {
        if (!name || !email || !password) {
            setError('Preencha todos os campos obrigatórios.');
            return;
        }
        if (password.length < 8) {
            setError('A senha precisa ter pelo menos 8 caracteres.');
            return;
        }
        if (!acceptedTerms) {
            setError('Para continuar, confirme que leu e concorda com as regras do programa.');
            return;
        }
        setLoading(true);
        setError(null);

        try {
            const params = new URLSearchParams(window.location.search);
            const { data, error: fnError } = await supabase.functions.invoke('register-vendor', {
                body: {
                    email,
                    password,
                    name,
                    phone: phone.replace(/\D/g, ''),
                    offerPayload: params.get('offer'),
                    acceptedTerms: true,
                }
            });

            if (fnError) throw new Error(fnError.message || 'Erro ao registrar.');
            if (data?.error) throw new Error(data.error);

            setStep('SUCCESS');
        } catch (err: any) {
            let msg = err.message;
            if (msg.includes('already registered')) msg = 'Este e-mail já está cadastrado.';
            setError(msg);
        } finally {
            setLoading(false);
        }
    };

    if (error && !offerData) {
        return (
            <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center p-4">
                <div className="bg-white dark:bg-slate-900 p-8 rounded-3xl shadow-xl max-w-md w-full text-center">
                    <AlertCircle size={48} className="text-red-500 mx-auto mb-4" />
                    <h2 className="text-xl font-bold text-slate-800 dark:text-white mb-2">Ops!</h2>
                    <p className="text-slate-500 mb-6">{error}</p>
                </div>
            </div>
        );
    }

    if (!offerData) {
        return <div className="min-h-screen flex items-center justify-center"><Loader2 className="animate-spin text-violet-500" size={32} /></div>;
    }

    const commission = formatCents(offerData.commissionRate);
    const couponCode: string | null = typeof offerData.affiliateCode === 'string' && offerData.affiliateCode
        ? offerData.affiliateCode
        : null;
    const schoolName: string | null = typeof offerData.schoolName === 'string' && offerData.schoolName
        ? offerData.schoolName
        : null;

    if (step === 'SUCCESS') {
        return (
            <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center p-4">
                <div className="bg-white dark:bg-slate-900 p-8 rounded-3xl shadow-xl max-w-md w-full text-center">
                    <CheckCircle size={48} className="text-emerald-500 mx-auto mb-4" />
                    <h2 className="text-xl font-bold text-slate-800 dark:text-white mb-2">Cadastro concluído!</h2>
                    <p className="text-slate-500 mb-6">
                        Entre com seu e-mail e senha para acessar o seu painel de afiliado:
                        {couponCode ? <> o cupom <strong className="text-slate-700 dark:text-slate-200">{couponCode}</strong>,</> : ' o seu cupom,'} as suas indicações e os seus saques.
                    </p>
                    <a href="/" className="inline-block px-6 py-3 bg-violet-600 text-white rounded-xl text-xs font-black uppercase tracking-widest hover:brightness-110">
                        Ir para o login
                    </a>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-slate-50 dark:bg-slate-950 px-4 py-8">
            <div className="mx-auto grid w-full max-w-5xl gap-6 lg:grid-cols-[1.15fr_1fr] lg:items-start">
                <div className="space-y-6">
                    <div className="rounded-3xl bg-gradient-to-br from-violet-600 to-indigo-700 p-6 text-white shadow-xl">
                        <div className="mb-3 flex items-center gap-3">
                            <Briefcase size={28} aria-hidden="true" />
                            <div>
                                <h1 className="text-xl font-black">Programa de afiliados</h1>
                                {schoolName ? <p className="text-sm opacity-90">{schoolName}</p> : null}
                            </div>
                        </div>
                        <p className="text-sm opacity-90">
                            Você indica com o seu cupom, quem você indica fica isento da taxa de matrícula
                            e você recebe uma comissão por cada matrícula.
                        </p>
                        <div className="mt-4 grid gap-3 sm:grid-cols-2">
                            <div className="rounded-xl bg-white/10 p-3">
                                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest opacity-80">
                                    <DollarSign size={14} aria-hidden="true" /> Sua comissão
                                </div>
                                <p className="mt-1 text-2xl font-black">{commission}</p>
                                <p className="text-[11px] opacity-80">por matrícula, liberada na 1ª mensalidade liquidada</p>
                            </div>
                            <div className="rounded-xl bg-white/10 p-3">
                                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest opacity-80">
                                    <BadgePercent size={14} aria-hidden="true" /> Seu cupom
                                </div>
                                <p className="mt-1 truncate text-2xl font-black tracking-wider">{couponCode || 'Gerado no cadastro'}</p>
                                <p className="text-[11px] opacity-80">aparece no seu painel depois do cadastro</p>
                            </div>
                        </div>
                    </div>

                    <section className="rounded-3xl bg-white p-6 shadow-xl dark:bg-slate-900">
                        <h2 className="mb-4 text-lg font-black text-slate-800 dark:text-white">Como funciona</h2>
                        <AffiliateProgramGuide
                            commissionCents={offerData.commissionRate}
                            couponCode={couponCode}
                            schoolName={schoolName}
                            compact
                        />
                    </section>
                </div>

                <div className="rounded-3xl bg-white p-6 shadow-xl dark:bg-slate-900 lg:sticky lg:top-6">
                    <h2 className="text-lg font-black text-slate-800 dark:text-white">Crie seu acesso</h2>
                    <p className="mb-4 text-xs text-slate-500">Com ele você acompanha as suas indicações e pede o saque das comissões.</p>

                    <div className="space-y-3">
                        {error && (
                            <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 flex items-start gap-2" role="alert">
                                <AlertCircle size={16} className="text-rose-500 shrink-0 mt-0.5" />
                                <p className="text-xs text-rose-700">{error}</p>
                            </div>
                        )}

                        <Field icon={User} label="Nome completo" value={name} onChange={setName} placeholder="Seu nome" autoComplete="name" />
                        <Field icon={Mail} label="E-mail" value={email} onChange={setEmail} type="email" placeholder="voce@email.com" autoComplete="email" />
                        <Field icon={Lock} label="Senha" value={password} onChange={setPassword} type="password" placeholder="Mínimo de 8 caracteres" autoComplete="new-password" />
                        <Field icon={Phone} label="WhatsApp" value={phone} onChange={setPhone} placeholder="(11) 99999-9999" autoComplete="tel" />

                        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-3 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300">
                            <input
                                type="checkbox"
                                checked={acceptedTerms}
                                onChange={event => setAcceptedTerms(event.target.checked)}
                                className="mt-0.5 h-4 w-4 rounded text-violet-600 focus:ring-violet-500"
                            />
                            <span>
                                Li e concordo com as regras do programa: comissão fixa de {commission} por matrícula,
                                liberada quando a 1ª mensalidade é liquidada, e saque aprovado pela escola.
                            </span>
                        </label>

                        <button
                            onClick={handleRegister}
                            disabled={loading}
                            className="w-full py-3 bg-violet-600 text-white rounded-xl text-xs font-black uppercase tracking-widest hover:brightness-110 disabled:opacity-50 flex items-center justify-center gap-2"
                        >
                            {loading ? <Loader2 size={14} className="animate-spin" /> : null}
                            Criar minha conta de afiliado
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

const Field: React.FC<{ icon: any; label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string; autoComplete?: string }> = ({ icon: Icon, label, value, onChange, placeholder, type = 'text', autoComplete }) => (
    <div>
        <label className="text-[10px] uppercase tracking-widest text-slate-400 font-bold block mb-1">{label}</label>
        <div className="relative">
            <Icon className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={14} />
            <input
                type={type}
                value={value}
                onChange={e => onChange(e.target.value)}
                placeholder={placeholder}
                autoComplete={autoComplete}
                aria-label={label}
                className="w-full pl-9 pr-3 py-2 bg-slate-50 dark:bg-slate-800 rounded-xl text-sm border border-slate-200 dark:border-slate-700 focus:outline-none focus:ring-2 focus:ring-violet-500 text-slate-800 dark:text-white"
            />
        </div>
    </div>
);

export default VendorOnboarding;
