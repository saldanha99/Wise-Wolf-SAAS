import React, { useEffect, useRef, useState } from 'react';
import { X, Loader2, ArrowRight, Check, Building2, User, Mail, Phone, FileText, MapPin, Smartphone, Barcode, Copy, Sparkles, Shield, Lock, AlertCircle, ChevronLeft } from 'lucide-react';
import { supabase } from '../../lib/supabase';

interface Props {
    plan: any;
    yearly: boolean;
    onClose: () => void;
}

type Step = 'INFO' | 'PAYMENT' | 'SUCCESS';

const SaasCheckout: React.FC<Props> = ({ plan, yearly, onClose }) => {
    const [step, setStep] = useState<Step>('INFO');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<any>(null);
    const [acceptedLegal, setAcceptedLegal] = useState(false);
    const [idempotencyKey] = useState(() => crypto.randomUUID());
    const dialogRef = useRef<HTMLDivElement>(null);
    const closeButtonRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        const previouslyFocused = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
                return;
            }
            if (event.key !== 'Tab' || !dialogRef.current) return;
            const focusable = (Array.from(
                dialogRef.current.querySelectorAll<HTMLElement>(
                    'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
                ),
            ) as HTMLElement[]).filter((element) => element.getClientRects().length > 0);
            if (focusable.length === 0) {
                event.preventDefault();
                closeButtonRef.current?.focus();
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            window.cancelAnimationFrame(focusFrame);
            document.removeEventListener('keydown', handleKeyDown);
            document.body.style.overflow = previousOverflow;
            window.requestAnimationFrame(() => previouslyFocused?.focus());
        };
    }, [onClose]);

    const [form, setForm] = useState({
        school_name: '',
        owner_name: '',
        owner_email: '',
        owner_cpf_cnpj: '',
        owner_phone: '',
        postalCode: '',
        address: '',
        addressNumber: '',
        province: '',
        billing_type: 'PIX' as 'PIX' | 'BOLETO',
    });

    const price = yearly ? plan.price_yearly : plan.price;
    const monthly = yearly ? (plan.price_yearly / 12) : plan.price;

    // ─── Validações ───
    const isInfoValid =
        form.school_name.trim().length >= 3 &&
        form.owner_name.trim().length >= 3 &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.owner_email) &&
        form.owner_cpf_cnpj.replace(/\D/g, '').length >= 11 &&
        form.owner_phone.replace(/\D/g, '').length >= 10;

    // ─── Formatters ───
    const formatCpfCnpj = (v: string) => {
        const d = v.replace(/\D/g, '');
        if (d.length <= 11) return d.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2');
        return d.slice(0, 14).replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1/$2').replace(/(\d{4})(\d)/, '$1-$2');
    };
    const formatPhone = (v: string) => {
        const d = v.replace(/\D/g, '').slice(0, 11);
        if (d.length <= 10) return d.replace(/(\d{2})(\d)/, '($1) $2').replace(/(\d{4})(\d)/, '$1-$2');
        return d.replace(/(\d{2})(\d)/, '($1) $2').replace(/(\d{5})(\d)/, '$1-$2');
    };
    const formatCep = (v: string) => v.replace(/\D/g, '').slice(0, 8).replace(/(\d{5})(\d)/, '$1-$2');
    const lookupCep = async (cep: string) => {
        const c = cep.replace(/\D/g, '');
        if (c.length !== 8) return;
        try {
            const res = await fetch(`https://viacep.com.br/ws/${c}/json/`);
            const data = await res.json();
            if (!data.erro) setForm(f => ({ ...f, address: data.logradouro || '', province: data.bairro || '' }));
        } catch {}
    };

    const submit = async () => {
        if (!acceptedLegal) {
            setError('Antes de gerar sua cobrança, confirme que leu e aceitou os termos e a política de privacidade.');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const payload: any = {
                school_name: form.school_name,
                owner_name: form.owner_name,
                owner_email: form.owner_email,
                owner_cpf_cnpj: form.owner_cpf_cnpj,
                owner_phone: form.owner_phone,
                plan_id: plan.id,
                billing_cycle: yearly ? 'YEARLY' : 'MONTHLY',
                billing_type: form.billing_type,
                idempotency_key: idempotencyKey,
                postalCode: form.postalCode,
                address: form.address,
                addressNumber: form.addressNumber,
                province: form.province,
            };
            const { data, error: fnErr } = await supabase.functions.invoke('create-saas-checkout', { body: payload });
            if (fnErr) throw new Error(fnErr.message || 'Erro de conexão');
            if (data?.error) throw new Error(data.error);

            setResult(data);
            setStep('SUCCESS');
        } catch (err: any) {
            setError(err.message);
        } finally { setLoading(false); }
    };

    return (
        <div
            className="fixed inset-0 bg-slate-950/90 backdrop-blur-md z-[200] flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-y-auto"
            role="dialog"
            aria-modal="true"
            aria-labelledby="saas-checkout-title"
        >
            <div ref={dialogRef} className="bg-slate-900 border border-white/10 rounded-t-3xl sm:rounded-3xl max-w-2xl w-full max-h-[95vh] sm:max-h-[90vh] overflow-hidden shadow-2xl flex flex-col">

                {/* HEADER */}
                <div className="px-6 py-4 border-b border-white/5 flex items-center justify-between shrink-0">
                    <div className="flex items-center gap-3">
                        {step !== 'INFO' && step !== 'SUCCESS' && (
                            <button onClick={() => setStep('INFO')} aria-label="Voltar para os dados da escola" className="p-1.5 hover:bg-white/10 rounded-lg text-slate-400">
                                <ChevronLeft size={16} />
                            </button>
                        )}
                        <div>
                            <p className="text-[10px] uppercase tracking-widest text-violet-400 font-bold">{step === 'SUCCESS' ? 'Sucesso!' : 'Contratando'}</p>
                            <p id="saas-checkout-title" className="text-base font-black text-white">Plano {plan.name} · {yearly ? 'Anual' : 'Mensal'}</p>
                        </div>
                    </div>
                    <button ref={closeButtonRef} onClick={onClose} aria-label="Fechar checkout" className="p-2 hover:bg-white/10 rounded-xl text-slate-400">
                        <X size={18} />
                    </button>
                </div>

                {/* PROGRESS BAR */}
                {step !== 'SUCCESS' && (
                    <div className="px-6 py-3 border-b border-white/5 flex items-center gap-2 text-[10px] uppercase tracking-widest font-bold">
                        <span className={step === 'INFO' ? 'text-white' : 'text-emerald-400'}>① Dados</span>
                        <div className="flex-1 h-0.5 bg-white/10 rounded-full">
                            <div className={`h-full bg-gradient-to-r from-violet-500 to-pink-500 rounded-full transition-all`} style={{ width: step === 'INFO' ? '50%' : '100%' }} />
                        </div>
                        <span className={step === 'PAYMENT' ? 'text-white' : 'text-slate-500'}>② Pagamento</span>
                    </div>
                )}

                {/* BODY */}
                <div className="flex-1 overflow-y-auto px-6 py-6">
                    {step === 'INFO' && <StepInfo form={form} setForm={setForm} formatters={{ formatCpfCnpj, formatPhone, formatCep, lookupCep }} />}
                    {step === 'PAYMENT' && (
                      <StepPayment
                        form={form}
                        setForm={setForm}
                        error={error}
                        loading={loading}
                        price={price}
                        monthly={monthly}
                        yearly={yearly}
                        plan={plan}
                        acceptedLegal={acceptedLegal}
                        onLegalChange={setAcceptedLegal}
                      />
                    )}
                    {step === 'SUCCESS' && <StepSuccess result={result} plan={plan} />}
                </div>

                {/* FOOTER */}
                {step !== 'SUCCESS' && (
                    <div className="px-6 py-4 border-t border-white/5 bg-slate-950/50 shrink-0 flex items-center justify-between gap-3">
                        <div className="text-xs text-slate-400">
                            <p className="font-bold text-white">R$ {Math.round(monthly).toLocaleString('pt-BR')}<span className="text-slate-500">/mês</span></p>
                            {yearly && <p className="text-[10px]">cobrado R$ {price.toLocaleString('pt-BR')}/ano</p>}
                        </div>
                        {step === 'INFO' ? (
                            <button onClick={() => setStep('PAYMENT')} disabled={!isInfoValid}
                                className="px-6 py-3 bg-gradient-to-r from-violet-500 to-pink-500 text-white rounded-xl text-xs font-black uppercase tracking-widest hover:brightness-110 disabled:opacity-50 flex items-center gap-2">
                                Continuar <ArrowRight size={14} />
                            </button>
                        ) : (
                            <button onClick={submit} disabled={loading || !acceptedLegal}
                                className="px-6 py-3 bg-gradient-to-r from-violet-500 to-pink-500 text-white rounded-xl text-xs font-black uppercase tracking-widest hover:brightness-110 disabled:opacity-50 flex items-center gap-2">
                                {loading ? <Loader2 size={14} className="animate-spin" /> : <Lock size={14} />}
                                Confirmar
                            </button>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

// ─────────────────────────────────────────────────────────────
// STEP 1 — INFO
// ─────────────────────────────────────────────────────────────
const StepInfo: React.FC<any> = ({ form, setForm, formatters }) => (
    <div className="space-y-4">
        <Input icon={Building2} label="Nome da escola *" value={form.school_name} onChange={(v: string) => setForm({ ...form, school_name: v })} placeholder="Wise Wolf Centro" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input icon={User} label="Seu nome *" value={form.owner_name} onChange={(v: string) => setForm({ ...form, owner_name: v })} placeholder="João Silva" />
            <Input icon={Mail} label="E-mail *" type="email" value={form.owner_email} onChange={(v: string) => setForm({ ...form, owner_email: v })} placeholder="voce@escola.com.br" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input icon={FileText} label="CPF ou CNPJ *" value={form.owner_cpf_cnpj} onChange={(v: string) => setForm({ ...form, owner_cpf_cnpj: formatters.formatCpfCnpj(v) })} placeholder="000.000.000-00" />
            <Input icon={Phone} label="WhatsApp *" value={form.owner_phone} onChange={(v: string) => setForm({ ...form, owner_phone: formatters.formatPhone(v) })} placeholder="(11) 99999-9999" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Input icon={MapPin} label="CEP" value={form.postalCode} onChange={(v: string) => {
                const f = formatters.formatCep(v); setForm({ ...form, postalCode: f });
                if (f.replace(/\D/g, '').length === 8) formatters.lookupCep(f);
            }} placeholder="00000-000" />
            <div className="col-span-2">
                <Input label="Endereço" value={form.address} onChange={(v: string) => setForm({ ...form, address: v })} placeholder="Rua das Flores" />
            </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input label="Número" value={form.addressNumber} onChange={(v: string) => setForm({ ...form, addressNumber: v })} placeholder="123" />
            <Input label="Bairro" value={form.province} onChange={(v: string) => setForm({ ...form, province: v })} placeholder="Centro" />
        </div>
        <div className="flex items-start gap-2 text-[11px] text-slate-400 bg-violet-500/10 border border-violet-500/20 rounded-xl p-3">
            <Shield size={14} className="text-violet-400 shrink-0 mt-0.5" />
            <p>PIX e boleto são gerados pelo Asaas. A Wise Wolf não solicita, recebe ou armazena dados de cartão.</p>
        </div>
    </div>
);

// ─────────────────────────────────────────────────────────────
// STEP 2 — PAYMENT
// ─────────────────────────────────────────────────────────────
const StepPayment: React.FC<any> = ({
  form,
  setForm,
  error,
  plan,
  monthly,
  yearly,
  price,
  acceptedLegal,
  onLegalChange,
}) => {
    const opts: { id: 'PIX' | 'BOLETO'; label: string; sub: string; icon: any }[] = [
        { id: 'PIX', label: 'PIX', sub: 'Aprovação imediata', icon: Smartphone },
        { id: 'BOLETO', label: 'Boleto', sub: '3 dias úteis', icon: Barcode },
    ];

    return (
        <div className="space-y-4">
            {error && (
                <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 flex items-start gap-2">
                    <AlertCircle size={16} className="text-rose-400 shrink-0 mt-0.5" />
                    <p className="text-xs text-rose-300">{error}</p>
                </div>
            )}

            <div>
                <p className="text-[10px] uppercase tracking-widest text-slate-400 font-bold mb-2">Forma de pagamento</p>
                <div className="grid grid-cols-2 gap-2">
                    {opts.map(o => {
                        const Icon = o.icon;
                        const active = form.billing_type === o.id;
                        return (
                            <button key={o.id} onClick={() => setForm({ ...form, billing_type: o.id })}
                                className={`p-3 rounded-xl border-2 text-center transition-all ${active ? 'border-violet-500 bg-violet-500/10' : 'border-white/10 hover:border-white/20'}`}>
                                <Icon size={18} className={`mx-auto mb-1.5 ${active ? 'text-violet-400' : 'text-slate-400'}`} />
                                <p className="text-xs font-bold text-white">{o.label}</p>
                                <p className="text-[9px] text-slate-400 mt-0.5">{o.sub}</p>
                            </button>
                        );
                    })}
                </div>
            </div>

            {form.billing_type === 'PIX' && (
                <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-4">
                    <Smartphone size={20} className="text-emerald-400 mb-2" />
                    <p className="text-sm font-bold text-white">PIX gerado na hora</p>
                    <p className="text-xs text-slate-400 mt-1">Após confirmar, você recebe o QR Code. Pagamento confirmado em segundos.</p>
                </div>
            )}

            {form.billing_type === 'BOLETO' && (
                <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4">
                    <Barcode size={20} className="text-amber-400 mb-2" />
                    <p className="text-sm font-bold text-white">Boleto bancário</p>
                    <p className="text-xs text-slate-400 mt-1">Vencimento em 3 dias úteis. Compensação leva 1-2 dias após pagar.</p>
                </div>
            )}

            <label className="flex items-start gap-3 rounded-xl border border-white/10 bg-slate-950/40 p-3 text-[11px] text-slate-300">
                <input
                    type="checkbox"
                    checked={acceptedLegal}
                    onChange={(event) => onLegalChange(event.target.checked)}
                    className="mt-1 h-4 w-4 accent-violet-400"
                />
                <span>
                    Declaro que li e aceito os <a href="/termos" target="_blank" rel="noreferrer" className="font-bold text-violet-300 underline underline-offset-2">termos de uso</a> e a <a href="/privacidade" target="_blank" rel="noreferrer" className="font-bold text-violet-300 underline underline-offset-2">política de privacidade</a>, e concordo com a criação da assinatura recorrente informada.
                </span>
            </label>

            {/* Resumo */}
            <div className="bg-white/5 border border-white/10 rounded-xl p-4 space-y-2">
                <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-400">Plano {plan.name}</span>
                    <span className="text-white font-bold">R$ {Math.round(monthly).toLocaleString('pt-BR')}/mês</span>
                </div>
                {yearly && (
                    <div className="flex items-center justify-between text-xs">
                        <span className="text-emerald-400">Desconto anual aplicado</span>
                        <span className="text-emerald-400 font-bold">-15%</span>
                    </div>
                )}
                <div className="border-t border-white/10 pt-2 flex items-center justify-between">
                    <span className="text-sm font-bold text-white">Total {yearly ? 'anual' : 'hoje'}</span>
                    <span className="text-xl font-black bg-gradient-to-r from-violet-400 to-pink-400 bg-clip-text text-transparent">R$ {price.toLocaleString('pt-BR')}</span>
                </div>
            </div>

            <p className="text-[10px] text-slate-500 text-center">
                A contratação inicia de forma segura pelo Asaas. Nenhum dado de cartão é solicitado nesta etapa e nenhum pagamento é confirmado até a compensação no provedor.
            </p>
        </div>
    );
};

// ─────────────────────────────────────────────────────────────
// STEP 3 — SUCCESS
// ─────────────────────────────────────────────────────────────
const StepSuccess: React.FC<{ result: any; plan: any }> = ({ result, plan }) => {
    const copy = (s: string) => { navigator.clipboard.writeText(s); };
    return (
        <div className="text-center">
            <div className="relative w-20 h-20 mx-auto mb-6">
                <div className="absolute inset-0 bg-emerald-500/30 rounded-full animate-ping" />
                <div className="relative w-20 h-20 rounded-full bg-gradient-to-br from-emerald-400 to-cyan-500 flex items-center justify-center shadow-2xl shadow-emerald-500/50">
                    <Check size={36} className="text-white" />
                </div>
            </div>
            <h2 className="text-2xl sm:text-3xl font-black text-white mb-2">Sua contratação foi registrada</h2>
            <p className="text-slate-400 mb-6">
                Assim que o pagamento for confirmado, sua escola será criada automaticamente.
            </p>

            {result?.pix?.qr_code && (
                <div className="bg-white rounded-2xl p-4 mb-4 inline-block">
                    <img src={`data:image/png;base64,${result.pix.qr_code}`} alt="PIX QR Code" className="w-48 h-48" />
                </div>
            )}

            {result?.pix?.copy_paste && (
                <div className="bg-white/5 border border-white/10 rounded-xl p-3 mb-4 text-left">
                    <p className="text-[10px] uppercase tracking-widest text-slate-400 font-bold mb-1">PIX Copia e Cola</p>
                    <div className="flex gap-2">
                        <code className="flex-1 text-xs text-slate-300 truncate font-mono">{result.pix.copy_paste}</code>
                        <button onClick={() => copy(result.pix.copy_paste)} className="p-1.5 bg-white/10 rounded-lg hover:bg-white/20">
                            <Copy size={12} className="text-slate-300" />
                        </button>
                    </div>
                </div>
            )}

            {result?.invoice_url && (
                <a href={result.invoice_url} target="_blank" rel="noreferrer"
                    className="block bg-white/5 border border-white/10 rounded-xl p-3 mb-4 hover:bg-white/10 text-left">
                    <p className="text-[10px] uppercase tracking-widest text-slate-400 font-bold">Fatura</p>
                    <p className="text-xs text-violet-400 mt-1 truncate">{result.invoice_url}</p>
                </a>
            )}

            <div className="bg-violet-500/10 border border-violet-500/20 rounded-xl p-4 text-left mb-6">
                <p className="text-xs text-slate-300 font-bold mb-2">📬 Próximos passos:</p>
                <ul className="text-xs text-slate-400 space-y-1">
                    <li>• Conclua o pagamento pela opção escolhida</li>
                    <li>• O Asaas confirma o pagamento com segurança</li>
                    <li>• Você recebe por e-mail o link para definir sua senha</li>
                    <li>• Nossa equipe acompanha o início da sua operação</li>
                </ul>
            </div>

            <a href="/" className="inline-flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-violet-500 to-pink-500 text-white rounded-xl text-xs font-black uppercase tracking-widest hover:brightness-110">
                <Sparkles size={14} /> Ir para o login
            </a>
        </div>
    );
};

// ─────────────────────────────────────────────────────────────
// INPUT
// ─────────────────────────────────────────────────────────────
const Input: React.FC<{ icon?: any; label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string }> = ({ icon: Icon, label, value, onChange, placeholder, type = 'text' }) => (
    <div>
        <label className="text-[10px] uppercase tracking-widest text-slate-400 font-bold block mb-1.5">{label}</label>
        <div className="relative">
            {Icon && <Icon size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />}
            <input
                type={type}
                value={value}
                onChange={e => onChange(e.target.value)}
                placeholder={placeholder}
                className={`w-full ${Icon ? 'pl-9' : 'pl-3'} pr-3 py-2.5 bg-white/5 rounded-xl text-sm text-white border border-white/10 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent placeholder:text-slate-600`}
            />
        </div>
    </div>
);

export default SaasCheckout;
