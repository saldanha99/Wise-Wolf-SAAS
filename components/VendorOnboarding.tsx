import React, { useEffect, useRef, useState } from 'react';
import {
    AlertCircle, ArrowRight, BadgePercent, Check, CheckCircle2, ChevronDown, Copy, Eye, EyeOff,
    Landmark, Loader2, Lock, Mail, Phone, ShieldCheck, User, Wallet, type LucideIcon,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { tenantLegalAssetsService } from '../services/tenantLegalAssetsService';
import {
    SETTLEMENT_CARD_NOTE,
    SETTLEMENT_RULES,
    affiliateJourney,
    affiliateProgramRules,
    formatCents,
} from '../lib/affiliateProgram';
import {
    copyTextToClipboard,
    firstName,
    functionErrorText,
    resolveAffiliateBrand,
    schoolMonogram,
    validateAffiliateSignup,
    vendorRegistrationErrorMessage,
    type AffiliateBrand,
    type AffiliateSignupField,
} from '../lib/affiliateOnboarding';

/**
 * Cadastro do afiliado pelo link de convite (/vendor-onboarding?offer=<uuid>).
 *
 * A página abre pelo celular, vinda do WhatsApp: no topo o que a pessoa ganha
 * (comissão e cupom), logo depois o formulário, e embaixo "Como funciona" em
 * quatro etapas (indicar → matrícula → liquidação → saque) com o texto
 * completo das regras recolhido em cada uma. No computador: explicação à
 * esquerda, formulário fixo à direita.
 *
 * Cor e logo são os da escola quando o convite os traz (`tenant-legal-assets`);
 * sem eles — ou com cor clara demais para texto branco — vale o padrão do app.
 */

const DISPLAY = "'Manrope', 'DM Sans', system-ui, sans-serif";
const BODY = "'DM Sans', 'Inter', system-ui, sans-serif";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const card = 'rounded-[28px] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.06),0_28px_56px_-32px_rgba(15,23,42,0.45)] ring-1 ring-slate-900/[0.06] dark:bg-[#0F1626] dark:shadow-none dark:ring-white/10';
const eyebrow = 'text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400';
const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-[#60A5FA] dark:focus-visible:ring-offset-[#0F1626]';

interface VendorOffer {
    commissionCents: number;
    suggestedName: string | null;
    couponCode: string | null;
    schoolName: string | null;
    brand: AffiliateBrand;
}

const cleanText = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** Oferta do servidor → o que a tela usa. Comissão fora do contrato = convite inválido. */
function parseVendorOffer(payload: Record<string, unknown>): VendorOffer | null {
    if (payload.kind !== 'VENDOR_INVITE') return null;
    const commissionCents = Number(payload.commissionRate);
    if (!Number.isFinite(commissionCents) || commissionCents <= 0) return null;
    return {
        commissionCents,
        suggestedName: cleanText(payload.suggestedName),
        couponCode: cleanText(payload.affiliateCode),
        schoolName: cleanText(payload.schoolName),
        brand: resolveAffiliateBrand(payload),
    };
}

const DEFAULT_BRAND = resolveAffiliateBrand(null);

const VendorOnboarding: React.FC = () => {
    const [step, setStep] = useState<'FORM' | 'SUCCESS'>('FORM');
    const [offer, setOffer] = useState<VendorOffer | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [formError, setFormError] = useState<{ message: string; field?: AffiliateSignupField } | null>(null);
    const [loading, setLoading] = useState(false);

    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [phone, setPhone] = useState('');
    const [acceptedTerms, setAcceptedTerms] = useState(false);
    const [showPassword, setShowPassword] = useState(false);

    const fieldRefs = {
        name: useRef<HTMLInputElement>(null),
        email: useRef<HTMLInputElement>(null),
        password: useRef<HTMLInputElement>(null),
        phone: useRef<HTMLInputElement>(null),
        terms: useRef<HTMLInputElement>(null),
    } satisfies Record<AffiliateSignupField, React.RefObject<HTMLInputElement | null>>;

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const encodedOffer = params.get('offer');

        if (!encodedOffer) {
            setLoadError('Link inválido.');
            return;
        }

        // Caminho seguro: offer_id (UUID) → comissão AUTORITATIVA vem do servidor.
        if (UUID_RE.test(encodedOffer.trim())) {
            (async () => {
                try {
                    const payload = await tenantLegalAssetsService.vendorOffer(encodedOffer.trim());
                    if (!payload || payload.error) throw new Error('offer_unavailable');
                    if (payload.kind !== 'VENDOR_INVITE') {
                        setLoadError('Link de convite inválido.');
                        return;
                    }
                    const parsed = parseVendorOffer(payload);
                    if (!parsed) throw new Error('offer_malformed');
                    setOffer(parsed);
                    if (parsed.suggestedName) setName(parsed.suggestedName);
                } catch {
                    setLoadError('Link de convite inválido, expirado ou já utilizado. Solicite um novo.');
                }
            })();
            return;
        }

        setLoadError('Este convite antigo não possui validação server-side. Solicite um novo link seguro.');
    }, []);

    useEffect(() => {
        if (!offer) return;
        document.title = offer.schoolName ? `Programa de afiliados · ${offer.schoolName}` : 'Programa de afiliados';
    }, [offer]);

    /** Mexeu no campo que estava com erro: o aviso já não vale. */
    const edit = (field: AffiliateSignupField, apply: () => void) => {
        apply();
        if (formError?.field === field) setFormError(null);
    };

    const handleRegister = async () => {
        const problem = validateAffiliateSignup({ name, email, password, phone, acceptedTerms });
        if (problem) {
            setFormError(problem);
            // O aviso aparece logo abaixo do campo; centralizar mostra os dois juntos.
            const target = fieldRefs[problem.field].current;
            target?.focus({ preventScroll: true });
            target?.scrollIntoView?.({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
            return;
        }
        setLoading(true);
        setFormError(null);

        try {
            const params = new URLSearchParams(window.location.search);
            const { data, error: fnError } = await supabase.functions.invoke('register-vendor', {
                body: {
                    email: email.trim(),
                    password,
                    name: name.trim(),
                    phone: phone.replace(/\D/g, ''),
                    offerPayload: params.get('offer'),
                    acceptedTerms: true,
                }
            });

            if (fnError) throw fnError;
            if (data?.error) throw new Error(String(data.error));

            setStep('SUCCESS');
        } catch (err) {
            setFormError({ message: vendorRegistrationErrorMessage(await functionErrorText(err)) });
        } finally {
            setLoading(false);
        }
    };

    const showRules = () => {
        const rules = document.getElementById('regras-do-programa');
        if (!rules) return;
        rules.scrollIntoView?.({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
        rules.focus({ preventScroll: true });
    };

    if (loadError && !offer) {
        return (
            <PageShell brand={DEFAULT_BRAND}>
                <section className={`${card} mx-auto max-w-lg p-7 text-center sm:p-10`}>
                    <AlertCircle size={44} className="mx-auto text-rose-600 dark:text-rose-400" aria-hidden="true" />
                    <h2 className="mt-4 text-xl font-extrabold text-slate-900 dark:text-white" style={{ fontFamily: DISPLAY }}>
                        Não foi possível abrir o convite
                    </h2>
                    <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">{loadError}</p>
                </section>
            </PageShell>
        );
    }

    if (!offer) {
        return (
            <PageShell brand={DEFAULT_BRAND}>
                <section className={`${card} mx-auto grid max-w-lg place-items-center gap-3 p-12`} role="status">
                    <Loader2 className="animate-spin text-slate-500 dark:text-slate-400" size={32} aria-hidden="true" />
                    <p className="text-sm text-slate-600 dark:text-slate-300">Carregando o convite…</p>
                </section>
            </PageShell>
        );
    }

    const commission = formatCents(offer.commissionCents);
    const { couponCode, schoolName, brand } = offer;
    const greetingName = firstName(offer.suggestedName);

    if (step === 'SUCCESS') {
        return (
            <PageShell brand={brand} schoolName={schoolName} greetingName={greetingName}>
                <section className={`${card} mx-auto max-w-lg p-7 sm:p-10`} aria-labelledby="aff-success-title">
                    <div className="grid h-14 w-14 place-items-center rounded-full bg-emerald-50 dark:bg-emerald-400/10">
                        <CheckCircle2 size={30} className="text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                    </div>
                    <h2 id="aff-success-title" className="mt-5 text-2xl font-extrabold text-slate-900 dark:text-white" style={{ fontFamily: DISPLAY }}>
                        Cadastro concluído!
                    </h2>
                    <p className="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                        Entre com seu e-mail e senha para acessar o seu painel de afiliado:
                        {couponCode ? <> o cupom <strong className="font-semibold text-slate-900 dark:text-white">{couponCode}</strong>,</> : ' o seu cupom,'} as suas indicações e os seus saques.
                    </p>
                    <ol className="mt-6 space-y-3 border-t border-slate-200 pt-6 text-sm text-slate-700 dark:border-white/10 dark:text-slate-300">
                        {[
                            'Entre com o e-mail e a senha que você acabou de criar.',
                            'No painel, cadastre a sua chave PIX: é por ela que a escola paga as comissões.',
                            'Compartilhe o seu cupom com quem quiser indicar.',
                        ].map((item, index) => (
                            <li key={item} className="flex gap-3">
                                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-slate-100 text-xs font-bold text-slate-700 dark:bg-white/10 dark:text-white" aria-hidden="true">
                                    {index + 1}
                                </span>
                                <span className="pt-0.5">{item}</span>
                            </li>
                        ))}
                    </ol>
                    <a
                        href="/"
                        className={`mt-7 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[rgb(var(--aff-rgb))] px-5 text-[15px] font-bold text-white hover:bg-[rgb(var(--aff-rgb)_/_0.9)] dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200 ${focusRing}`}
                        style={{ fontFamily: DISPLAY }}
                    >
                        Ir para o login <ArrowRight size={18} aria-hidden="true" />
                    </a>
                </section>
            </PageShell>
        );
    }

    const journey = affiliateJourney(offer.commissionCents, couponCode);
    const rules = affiliateProgramRules(offer.commissionCents);
    const fieldInvalid = (field: AffiliateSignupField) => formError?.field === field;
    const fieldError = (field: AffiliateSignupField) => (formError?.field === field ? formError.message : undefined);

    return (
        <PageShell brand={brand} schoolName={schoolName} greetingName={greetingName} showLead>
            <div className="grid gap-6 lg:grid-cols-12 lg:gap-8">
                {/* O que você ganha: comissão e cupom, no topo em qualquer tela. */}
                <section aria-labelledby="aff-offer-title" className={`${card} p-5 sm:p-8 lg:col-span-7 lg:row-start-1`}>
                    <h2 id="aff-offer-title" className="sr-only">O que você ganha</h2>
                    <p className={eyebrow}>Sua comissão</p>
                    <p className="mt-2 text-[44px] font-extrabold leading-none tracking-tight text-slate-900 dark:text-white sm:text-[56px]" style={{ fontFamily: DISPLAY }}>
                        {commission}
                    </p>
                    <p className="mt-2 text-[15px] font-semibold text-slate-800 dark:text-slate-100">por matrícula · paga uma única vez</p>

                    <ul className="mt-5 grid gap-3 border-t border-slate-200 pt-5 text-sm text-slate-700 dark:border-white/10 dark:text-slate-300 sm:grid-cols-2">
                        <Fact icon={Landmark}>Liberada quando a 1ª mensalidade é liquidada</Fact>
                        <Fact icon={Wallet}>Saque no seu PIX, com aprovação da escola</Fact>
                    </ul>

                    <CouponTicket code={couponCode} />
                </section>

                {/* Formulário: logo depois do resumo no celular. No computador sobe para a
                    faixa (o botão fica acima da dobra) e acompanha a rolagem à direita. */}
                <section
                    aria-labelledby="aff-form-title"
                    className={`${card} p-5 sm:p-8 lg:sticky lg:top-6 lg:col-span-5 lg:col-start-8 lg:row-span-2 lg:row-start-1 lg:-mt-[224px] lg:self-start`}
                >
                    <h2 id="aff-form-title" className="text-xl font-extrabold text-slate-900 dark:text-white sm:text-2xl" style={{ fontFamily: DISPLAY }}>
                        Crie seu acesso
                    </h2>
                    <p className="mt-1 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                        Com ele você acompanha as suas indicações e pede o saque das comissões.
                    </p>

                    <form
                        noValidate
                        className="mt-6 space-y-4"
                        aria-busy={loading || undefined}
                        onSubmit={event => { event.preventDefault(); void handleRegister(); }}
                    >
                        <Field
                            id="aff-name" label="Nome completo" icon={User} value={name} inputRef={fieldRefs.name}
                            onChange={value => edit('name', () => setName(value))}
                            placeholder="Seu nome" autoComplete="name" error={fieldError('name')}
                        />
                        <Field
                            id="aff-email" label="E-mail" icon={Mail} value={email} inputRef={fieldRefs.email}
                            onChange={value => edit('email', () => setEmail(value))}
                            type="email" inputMode="email" placeholder="voce@email.com" autoComplete="email" error={fieldError('email')}
                        />
                        <Field
                            id="aff-password" label="Senha" icon={Lock} value={password} inputRef={fieldRefs.password}
                            onChange={value => edit('password', () => setPassword(value))}
                            type={showPassword ? 'text' : 'password'} placeholder="Crie uma senha" autoComplete="new-password"
                            hint="Mínimo de 8 caracteres." error={fieldError('password')}
                            trailing={(
                                <button
                                    type="button"
                                    onClick={() => setShowPassword(value => !value)}
                                    aria-label="Mostrar senha"
                                    aria-pressed={showPassword}
                                    className={`absolute right-1.5 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-white ${focusRing}`}
                                >
                                    {showPassword ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
                                </button>
                            )}
                        />
                        <Field
                            id="aff-phone" label="WhatsApp" icon={Phone} value={phone} inputRef={fieldRefs.phone}
                            onChange={value => edit('phone', () => setPhone(value))}
                            type="tel" inputMode="tel" placeholder="(11) 99999-9999" autoComplete="tel"
                            hint="Com DDD." error={fieldError('phone')}
                        />

                        <div>
                            <label
                                htmlFor="aff-terms"
                                className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-4 text-sm leading-relaxed text-slate-700 has-[:checked]:border-[rgb(var(--aff-rgb))] has-[:checked]:bg-[rgb(var(--aff-rgb)_/_0.04)] dark:text-slate-300 dark:has-[:checked]:border-[#60A5FA] dark:has-[:checked]:bg-white/5 ${fieldInvalid('terms') ? 'border-rose-600 bg-rose-50/60 dark:border-rose-400 dark:bg-rose-500/10' : 'border-slate-300 dark:border-white/20'}`}
                            >
                                <input
                                    id="aff-terms"
                                    ref={fieldRefs.terms}
                                    type="checkbox"
                                    checked={acceptedTerms}
                                    onChange={event => edit('terms', () => setAcceptedTerms(event.target.checked))}
                                    aria-invalid={fieldInvalid('terms') || undefined}
                                    aria-describedby={fieldInvalid('terms') ? 'aff-terms-error' : undefined}
                                    className={`mt-0.5 h-5 w-5 shrink-0 cursor-pointer accent-[rgb(var(--aff-rgb))] dark:accent-[#60A5FA] ${focusRing}`}
                                />
                                <span>
                                    Li e concordo com as regras do programa: comissão fixa de{' '}
                                    <strong className="font-semibold text-slate-900 dark:text-white">{commission}</strong> por matrícula,
                                    liberada quando a 1ª mensalidade é liquidada, e saque aprovado pela escola.
                                </span>
                            </label>
                            {fieldInvalid('terms') && <FieldError id="aff-terms-error">{formError?.message}</FieldError>}
                            <button
                                type="button"
                                onClick={showRules}
                                className={`mt-2 rounded text-sm font-semibold text-[rgb(var(--aff-rgb))] underline decoration-2 underline-offset-4 hover:decoration-[3px] dark:text-[#93C5FD] ${focusRing}`}
                            >
                                Ler as regras completas
                            </button>
                        </div>

                        {formError && !formError.field && (
                            <div
                                role="alert"
                                className="flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50 p-3.5 text-sm text-rose-800 dark:border-rose-400/30 dark:bg-rose-500/10 dark:text-rose-200"
                            >
                                <AlertCircle size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
                                <p>{formError.message}</p>
                            </div>
                        )}

                        <button
                            type="submit"
                            disabled={loading}
                            className={`flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[rgb(var(--aff-rgb))] px-5 text-[15px] font-bold text-white shadow-sm hover:bg-[rgb(var(--aff-rgb)_/_0.9)] disabled:cursor-wait disabled:opacity-75 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200 ${focusRing}`}
                            style={{ fontFamily: DISPLAY }}
                        >
                            {loading ? (
                                <>
                                    <Loader2 size={18} className="animate-spin" aria-hidden="true" />
                                    Criando sua conta…
                                </>
                            ) : (
                                <>
                                    Criar minha conta de afiliado
                                    <ArrowRight size={18} aria-hidden="true" />
                                </>
                            )}
                        </button>
                        <p className="text-center text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                            Depois, é só entrar com este e-mail e senha para ver o seu painel.
                        </p>
                    </form>
                </section>

                {/* Como funciona + regras: explicação à esquerda no computador, depois do formulário no celular. */}
                <div className="space-y-10 pt-2 lg:col-span-7 lg:row-start-2">
                    <section aria-labelledby="aff-how-title">
                        <h2 id="aff-how-title" className="text-xl font-extrabold text-slate-900 dark:text-white sm:text-2xl" style={{ fontFamily: DISPLAY }}>
                            Como funciona
                        </h2>
                        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                            Do cupom ao PIX, em quatro etapas. Toque numa etapa para ver os detalhes.
                        </p>
                        <ol className="mt-5">
                            {journey.map((stage, index) => (
                                <li key={stage.id} className="relative">
                                    {index < journey.length - 1 && (
                                        <span aria-hidden="true" className="absolute bottom-0 left-[19px] top-12 w-0.5 rounded-full bg-slate-300 dark:bg-white/15" />
                                    )}
                                    <details className="group pb-3">
                                        <summary
                                            className={`-mx-2 flex cursor-pointer list-none items-start gap-4 rounded-2xl p-2 hover:bg-white dark:hover:bg-white/5 [&::-webkit-details-marker]:hidden ${focusRing}`}
                                        >
                                            <span
                                                className="relative grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[rgb(var(--aff-rgb))] text-sm font-bold text-white ring-4 ring-[#F3F5F9] dark:bg-[#1C2740] dark:ring-[#070B14]"
                                                style={{ fontFamily: DISPLAY }}
                                                aria-hidden="true"
                                            >
                                                {index + 1}
                                            </span>
                                            <span className="min-w-0 flex-1 pt-0.5">
                                                <span className="block text-[15px] font-bold text-slate-900 dark:text-white">{stage.title}</span>
                                                <span className="mt-0.5 block text-sm leading-relaxed text-slate-600 dark:text-slate-400">{stage.summary}</span>
                                            </span>
                                            <ChevronDown size={18} className="mt-2.5 shrink-0 text-slate-500 transition-transform group-open:rotate-180 dark:text-slate-400" aria-hidden="true" />
                                        </summary>
                                        <div className="ml-14 space-y-2.5 pb-2 pt-1 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                                            {stage.details.map(detail => (
                                                <p key={detail.id}>
                                                    <strong className="font-semibold text-slate-900 dark:text-white">{detail.title}.</strong> {detail.text}
                                                </p>
                                            ))}
                                            {stage.showsSettlement && (
                                                <>
                                                    <dl className="divide-y divide-slate-200 overflow-hidden rounded-2xl bg-white ring-1 ring-slate-900/[0.06] dark:divide-white/10 dark:bg-white/5 dark:ring-white/10">
                                                        {SETTLEMENT_RULES.map(rule => (
                                                            <div key={rule.method} className="flex gap-3 px-4 py-3">
                                                                <dt className="w-28 shrink-0 font-semibold text-slate-900 dark:text-white">{rule.method}</dt>
                                                                <dd>{rule.when}.</dd>
                                                            </div>
                                                        ))}
                                                    </dl>
                                                    <p className="text-xs text-slate-500 dark:text-slate-400">{SETTLEMENT_CARD_NOTE}</p>
                                                </>
                                            )}
                                        </div>
                                    </details>
                                </li>
                            ))}
                        </ol>
                    </section>

                    <section
                        id="regras-do-programa"
                        tabIndex={-1}
                        aria-labelledby="aff-rules-title"
                        className="scroll-mt-6 rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] dark:focus-visible:ring-[#60A5FA]"
                    >
                        <h2 id="aff-rules-title" className="flex items-center gap-2 text-xl font-extrabold text-slate-900 dark:text-white sm:text-2xl" style={{ fontFamily: DISPLAY }}>
                            <ShieldCheck size={22} className="text-[rgb(var(--aff-rgb))] dark:text-[#93C5FD]" aria-hidden="true" />
                            Regras do programa
                        </h2>
                        <ul className="mt-4 space-y-3">
                            {rules.map(rule => (
                                <li key={rule} className="flex gap-3 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                                    <Check size={18} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                                    {rule}
                                </li>
                            ))}
                        </ul>
                    </section>
                </div>
            </div>
        </PageShell>
    );
};

/** Faixa na cor da escola (logo, nome, título) e o conteúdo por cima dela. */
const PageShell: React.FC<{
    brand: AffiliateBrand;
    schoolName?: string | null;
    greetingName?: string;
    showLead?: boolean;
    children: React.ReactNode;
}> = ({ brand, schoolName = null, greetingName = '', showLead = false, children }) => {
    const [logoFailed, setLogoFailed] = useState(false);
    const monogram = schoolMonogram(schoolName);
    const glow = brand.secondary
        ? `radial-gradient(120% 90% at 100% 0%, ${brand.secondary} 0%, transparent 60%)`
        : 'radial-gradient(120% 90% at 100% 0%, rgba(255,255,255,0.14) 0%, transparent 55%)';
    return (
        <main
            className={`min-h-screen bg-[#F3F5F9] text-slate-700 dark:bg-[#070B14] dark:text-slate-300`}
            style={{ fontFamily: BODY, '--aff-rgb': brand.primaryRgb } as React.CSSProperties}
        >
            <header
                className="relative overflow-hidden text-white"
                style={{ background: `${glow}, radial-gradient(80% 70% at 0% 100%, rgba(255,255,255,0.06) 0%, transparent 70%), ${brand.primary}` }}
            >
                <BadgePercent
                    aria-hidden="true"
                    strokeWidth={1.25}
                    className="pointer-events-none absolute -right-10 -top-8 h-56 w-56 text-white/[0.07] sm:h-72 sm:w-72 lg:hidden"
                />
                <div className="relative mx-auto max-w-6xl px-4 pb-24 pt-7 sm:px-6 sm:pt-10 lg:pb-32 lg:pt-14">
                    <div className="flex items-center gap-3">
                        {brand.logoUrl && !logoFailed ? (
                            <img
                                src={brand.logoUrl}
                                alt=""
                                onError={() => setLogoFailed(true)}
                                className="h-12 w-12 rounded-2xl bg-white object-contain p-1.5 shadow-[0_12px_28px_-14px_rgba(0,0,0,0.6)]"
                            />
                        ) : (
                            <span
                                aria-hidden="true"
                                className="grid h-12 w-12 place-items-center rounded-2xl bg-white/10 text-base font-extrabold ring-1 ring-white/25"
                                style={{ fontFamily: DISPLAY }}
                            >
                                {monogram || <BadgePercent size={22} />}
                            </span>
                        )}
                        <div className="min-w-0">
                            <p className="truncate text-sm font-semibold">{schoolName || 'Convite de afiliado'}</p>
                            {/* Só com a oferta carregada: link inválido não é convite de ninguém. */}
                            {schoolName && (
                                <p className="text-xs text-white/75">{greetingName ? `Convite pessoal para ${greetingName}` : 'Convite pessoal'}</p>
                            )}
                        </div>
                    </div>
                    <h1 className="mt-7 text-[34px] font-extrabold leading-[1.08] tracking-tight sm:text-5xl lg:max-w-[58%]" style={{ fontFamily: DISPLAY }}>
                        Programa de afiliados
                    </h1>
                    {showLead && (
                        <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-white/85 sm:text-base lg:max-w-[52%]">
                            Você indica com o seu cupom, quem você indica fica isento da taxa de matrícula e você recebe uma comissão por cada matrícula.
                        </p>
                    )}
                </div>
            </header>
            <div className="relative mx-auto -mt-16 max-w-6xl px-4 pb-16 sm:-mt-20 sm:px-6 lg:-mt-24">{children}</div>
        </main>
    );
};

/** O cupom como um cupom: código grande, picote e o botão de copiar no canhoto. */
const CouponTicket: React.FC<{ code: string | null }> = ({ code }) => {
    const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
    const codeRef = useRef<HTMLSpanElement>(null);
    const timer = useRef<number | null>(null);

    useEffect(() => () => {
        if (timer.current !== null) window.clearTimeout(timer.current);
    }, []);

    const handleCopy = async () => {
        if (!code) return;
        if (timer.current !== null) window.clearTimeout(timer.current);
        const copied = await copyTextToClipboard(code);
        if (copied) {
            setState('copied');
            timer.current = window.setTimeout(() => setState('idle'), 2500);
            return;
        }
        // Não copiou: deixa o código selecionado para a pessoa copiar à mão.
        setState('failed');
        if (codeRef.current) window.getSelection()?.selectAllChildren(codeRef.current);
    };

    const notch = `before:absolute before:-left-[11px] before:-top-[11px] before:h-5 before:w-5 before:rounded-full before:bg-white before:content-[''] after:absolute after:-bottom-[11px] after:-left-[11px] after:h-5 after:w-5 after:rounded-full after:bg-white after:content-[''] dark:before:bg-[#0F1626] dark:after:bg-[#0F1626]`;

    return (
        <div className="mt-6">
            <p className={eyebrow} id="aff-coupon-label">Seu cupom</p>
            <div className="mt-2 flex items-stretch rounded-2xl bg-[rgb(var(--aff-rgb))] text-white dark:ring-1 dark:ring-inset dark:ring-white/15">
                <div className="min-w-0 flex-1 px-4 py-4 sm:px-5">
                    {code ? (
                        <span
                            id="aff-coupon-code"
                            ref={codeRef}
                            className={`block select-all break-all font-mono font-bold leading-tight tracking-[0.1em] ${code.length > 12 ? 'text-base sm:text-xl' : 'text-[22px] sm:text-[28px]'}`}
                        >
                            {code}
                        </span>
                    ) : (
                        <span className="block text-lg font-bold" style={{ fontFamily: DISPLAY }}>Gerado no cadastro</span>
                    )}
                    <span className="mt-1 block text-xs text-white/80">
                        {code ? 'Quem se matricula com ele não paga a taxa de matrícula.' : 'Aparece no seu painel depois do cadastro.'}
                    </span>
                </div>
                {code && (
                    <div className={`relative flex shrink-0 items-center border-l-2 border-dashed border-white/35 px-2.5 sm:px-4 ${notch}`}>
                        <button
                            type="button"
                            onClick={() => { void handleCopy(); }}
                            aria-describedby="aff-coupon-code"
                            className="inline-flex h-11 min-w-[7rem] items-center justify-center gap-1.5 rounded-xl bg-white/15 px-3 text-sm font-bold text-white hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[rgb(var(--aff-rgb))] sm:px-4"
                        >
                            {state === 'copied' ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                            {state === 'copied' ? 'Copiado' : 'Copiar'}
                        </button>
                    </div>
                )}
            </div>
            <p role="status" aria-live="polite" className="mt-2 text-xs text-slate-600 empty:mt-0 dark:text-slate-400">
                {state === 'copied' && 'Cupom copiado. É só colar na conversa.'}
                {state === 'failed' && 'Não deu para copiar automaticamente: o código ficou selecionado, é só copiar.'}
            </p>
        </div>
    );
};

const Fact: React.FC<{ icon: LucideIcon; children: React.ReactNode }> = ({ icon: Icon, children }) => (
    <li className="flex items-start gap-2.5">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[rgb(var(--aff-rgb)_/_0.08)] text-[rgb(var(--aff-rgb))] dark:bg-white/10 dark:text-[#93C5FD]">
            <Icon size={16} aria-hidden="true" />
        </span>
        <span className="pt-1 leading-snug">{children}</span>
    </li>
);

const Field: React.FC<{
    id: string;
    label: string;
    icon: LucideIcon;
    value: string;
    onChange: (value: string) => void;
    inputRef: React.RefObject<HTMLInputElement | null>;
    placeholder?: string;
    type?: string;
    inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
    autoComplete?: string;
    hint?: string;
    /** Aviso da validação deste campo; sai logo abaixo dele. */
    error?: string;
    trailing?: React.ReactNode;
}> = ({ id, label, icon: Icon, value, onChange, inputRef, placeholder, type = 'text', inputMode, autoComplete, hint, error, trailing }) => {
    const invalid = Boolean(error);
    const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
    return (
        <div>
            <label htmlFor={id} className="block text-sm font-semibold text-slate-800 dark:text-slate-200">{label}</label>
            <div className="relative mt-1.5">
                <Icon className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400" size={18} aria-hidden="true" />
                <input
                    id={id}
                    ref={inputRef}
                    type={type}
                    inputMode={inputMode}
                    value={value}
                    onChange={event => onChange(event.target.value)}
                    placeholder={placeholder}
                    autoComplete={autoComplete}
                    aria-invalid={invalid || undefined}
                    aria-describedby={describedBy}
                    className={`h-12 w-full rounded-xl border bg-white pl-11 text-[15px] text-slate-900 placeholder:text-slate-400 focus:border-[rgb(var(--aff-rgb))] focus:outline-none focus:ring-2 focus:ring-[rgb(var(--aff-rgb)_/_0.25)] dark:bg-[#0A1020] dark:text-white dark:placeholder:text-slate-500 dark:focus:border-[#60A5FA] dark:focus:ring-[#60A5FA]/30 border-[#8792A5] dark:border-white/35 aria-[invalid=true]:border-rose-600 aria-[invalid=true]:focus:border-rose-600 aria-[invalid=true]:focus:ring-rose-600/25 dark:aria-[invalid=true]:border-rose-400 dark:aria-[invalid=true]:focus:border-rose-400 dark:aria-[invalid=true]:focus:ring-rose-400/30 ${trailing ? 'pr-12' : 'pr-3'}`}
                />
                {trailing}
            </div>
            {hint && <p id={`${id}-hint`} className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">{hint}</p>}
            {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
        </div>
    );
};

const FieldError: React.FC<{ id: string; children: React.ReactNode }> = ({ id, children }) => (
    <p id={id} role="alert" className="mt-1.5 flex items-start gap-1.5 text-[13px] font-medium leading-snug text-rose-700 dark:text-rose-300">
        <AlertCircle size={15} className="mt-px shrink-0" aria-hidden="true" />
        {children}
    </p>
);

function prefersReducedMotion(): boolean {
    return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
}

export default VendorOnboarding;
