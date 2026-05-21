import React, { useState, useEffect } from 'react';
import {
    User, Mail, Phone, FileText, CheckCircle, Loader2,
    ArrowRight, AlertCircle, ChevronDown, ChevronUp, Zap, TrendingUp, Star
} from 'lucide-react';
import { supabase } from '../lib/supabase';

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface Plan {
    id: string;
    name: string;
    price: number;
    max_students: number;
    max_teachers: number;
    description: string;
    features: string[];
}

interface TeacherEntrepreneurSignupProps {
    /** ID do tenant da escola mãe que está indicando o professor */
    parentTenantId?: string;
}

// ─── Planos (fallback local caso Supabase não retorne) ────────────────────────

const FALLBACK_PLANS: Plan[] = [
    {
        id: 'starter',
        name: 'Teacher Starter',
        price: 97,
        max_students: 15,
        max_teachers: 1,
        description: 'Para começar',
        features: ['Contratos digitais', 'Pagamentos Asaas', 'Até 15 alunos', 'Agenda + lançamentos', 'Suporte via chat'],
    },
    {
        id: 'growth',
        name: 'Teacher Growth',
        price: 197,
        max_students: 50,
        max_teachers: 3,
        description: 'Para crescer',
        features: ['Tudo do Starter', 'CRM completo', 'Material didático', 'Wolfie AI Tutor', 'Relatórios financeiros'],
    },
    {
        id: 'scale',
        name: 'Teacher Scale',
        price: 397,
        max_students: 99999,
        max_teachers: 99,
        description: 'Para dominar',
        features: ['Tudo do Growth', 'Professores ilimitados', 'Multi-tenant', 'Domínio próprio', 'Suporte prioritário'],
    },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PlanIcon = ({ name }: { name: string }) => {
    if (name.includes('Scale')) return <Star size={18} />;
    if (name.includes('Growth')) return <TrendingUp size={18} />;
    return <Zap size={18} />;
};

const planColors: Record<string, { border: string; bg: string; badge: string; text: string }> = {
    starter: { border: 'border-blue-500/40', bg: 'bg-blue-500/10', badge: 'bg-blue-500/20 text-blue-300', text: 'text-blue-400' },
    growth:  { border: 'border-emerald-500/40', bg: 'bg-emerald-500/10', badge: 'bg-emerald-500/20 text-emerald-300', text: 'text-emerald-400' },
    scale:   { border: 'border-amber-500/40', bg: 'bg-amber-500/10', badge: 'bg-amber-500/20 text-amber-300', text: 'text-amber-400' },
};

const getPlanKey = (name: string) => {
    if (name.toLowerCase().includes('scale')) return 'scale';
    if (name.toLowerCase().includes('growth')) return 'growth';
    return 'starter';
};

// ─── Componente Principal ─────────────────────────────────────────────────────

const TeacherEntrepreneurSignup: React.FC<TeacherEntrepreneurSignupProps> = ({ parentTenantId }) => {
    const [plans, setPlans] = useState<Plan[]>(FALLBACK_PLANS);
    const [selectedPlan, setSelectedPlan] = useState<Plan>(FALLBACK_PLANS[1]); // Growth por padrão
    const [step, setStep] = useState<'plans' | 'form' | 'success'>('plans');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [faqOpen, setFaqOpen] = useState<number | null>(null);

    const [form, setForm] = useState({
        teacher_name: '',
        email: '',
        phone: '',
        cpf: '',
        school_name: '',  // nome da mini-escola do teacher
        notes: '',
    });

    // Carregar planos reais do Supabase
    useEffect(() => {
        const fetchPlans = async () => {
            const { data } = await supabase
                .from('saas_plans')
                .select('id, name, price, max_students, max_teachers, description, features')
                .eq('plan_type', 'teacher')
                .eq('active', true)
                .order('price', { ascending: true });

            if (data && data.length > 0) {
                const parsed: Plan[] = data.map((p: any) => ({
                    ...p,
                    features: Array.isArray(p.features) ? p.features : JSON.parse(p.features || '[]'),
                }));
                setPlans(parsed);
                setSelectedPlan(parsed[1] ?? parsed[0]);
            }
        };
        fetchPlans();
    }, []);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!form.teacher_name || !form.email || !form.phone) {
            setError('Preencha nome, e-mail e WhatsApp.');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const { error: insertErr } = await supabase.from('saas_leads').insert({
                // Campos legados
                name: form.teacher_name,
                email: form.email,
                phone: form.phone.replace(/\D/g, ''),
                school_name: form.school_name || `Escola de ${form.teacher_name}`,
                status: 'new',
                // Campos novos
                owner_name: form.teacher_name,
                owner_email: form.email,
                owner_phone: form.phone.replace(/\D/g, ''),
                owner_cpf_cnpj: form.cpf.replace(/\D/g, '') || null,
                estimated_students: selectedPlan.max_students < 9999 ? selectedPlan.max_students : null,
                estimated_teachers: 1,
                source: parentTenantId ? 'teacher_referral' : 'teacher_signup',
                plan_interest: selectedPlan.name,
                lead_type: 'teacher',
                parent_tenant_id: parentTenantId || null,
                notes: form.notes || null,
            });
            if (insertErr) throw insertErr;
            setStep('success');
        } catch (err: any) {
            setError(err.message || 'Erro ao enviar. Tente novamente.');
        } finally {
            setLoading(false);
        }
    };

    // ── Sucesso ──────────────────────────────────────────────────────────────

    if (step === 'success') {
        return (
            <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
                <div className="bg-slate-900 border border-slate-800 rounded-3xl max-w-md w-full p-10 text-center">
                    <div className="w-16 h-16 bg-emerald-500/20 rounded-full flex items-center justify-center mx-auto mb-6">
                        <CheckCircle size={32} className="text-emerald-400" />
                    </div>
                    <h2 className="text-2xl font-black text-white mb-3">Inscrição recebida!</h2>
                    <p className="text-sm text-slate-400 leading-relaxed mb-6">
                        Ótimo, <b className="text-white">{form.teacher_name}</b>! Recebemos sua solicitação para o plano{' '}
                        <b className="text-white">{selectedPlan.name}</b>.
                        Vamos entrar em contato em até 24h no e-mail{' '}
                        <b className="text-white">{form.email}</b> para ativar sua mini-escola.
                    </p>
                    <div className="bg-slate-800 rounded-2xl p-4 text-left text-sm text-slate-300 space-y-1">
                        <p>✅ Tenant próprio com sua marca</p>
                        <p>✅ Contratos digitais configurados</p>
                        <p>✅ Pagamentos Asaas ativados</p>
                        <p>✅ 14 dias grátis para testar</p>
                    </div>
                </div>
            </div>
        );
    }

    // ── Seleção de plano ──────────────────────────────────────────────────────

    if (step === 'plans') {
        return (
            <div className="min-h-screen bg-slate-950 text-white">
                {/* Hero */}
                <div className="max-w-4xl mx-auto px-4 pt-16 pb-8 text-center">
                    <div className="inline-flex items-center gap-2 bg-indigo-500/10 border border-indigo-500/20 rounded-full px-4 py-1.5 text-indigo-300 text-xs font-semibold uppercase tracking-wider mb-6">
                        <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-pulse" />
                        Wise Wolf For Teachers
                    </div>
                    <h1 className="text-4xl md:text-5xl font-black mb-4 leading-tight">
                        Transforme seu talento<br />
                        <span className="bg-gradient-to-r from-amber-400 to-orange-500 bg-clip-text text-transparent">
                            em negócio
                        </span>
                    </h1>
                    <p className="text-slate-400 text-lg max-w-2xl mx-auto leading-relaxed">
                        Toda a infraestrutura da Wise Wolf — contratos, pagamentos, CRM, alunos, AI — com a sua marca.
                        Seja seu próprio chefe sem perder o suporte.
                    </p>
                </div>

                {/* Cards de planos */}
                <div className="max-w-4xl mx-auto px-4 pb-10">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        {plans.map((plan) => {
                            const key = getPlanKey(plan.name);
                            const colors = planColors[key];
                            const isSelected = selectedPlan.id === plan.id;
                            const isPopular = key === 'growth';
                            return (
                                <button
                                    key={plan.id}
                                    onClick={() => setSelectedPlan(plan)}
                                    className={`relative text-left rounded-2xl border p-5 transition-all ${colors.border} ${isSelected ? colors.bg + ' ring-2 ring-offset-2 ring-offset-slate-950 ' + colors.text.replace('text-', 'ring-') : 'bg-slate-900/60 hover:bg-slate-900'}`}
                                >
                                    {isPopular && (
                                        <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                                            <span className="bg-emerald-500 text-white text-[10px] font-bold px-3 py-1 rounded-full uppercase tracking-wider">
                                                Mais Popular
                                            </span>
                                        </div>
                                    )}
                                    <div className={`inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-lg mb-3 ${colors.badge}`}>
                                        <PlanIcon name={plan.name} />
                                        {plan.name.replace('Teacher ', '')}
                                    </div>
                                    <div className="mb-1">
                                        <span className="text-3xl font-black text-white">R${plan.price}</span>
                                        <span className="text-slate-500 text-sm">/mês</span>
                                    </div>
                                    <p className="text-xs text-slate-500 mb-4">{plan.description}</p>
                                    <ul className="space-y-1.5">
                                        {plan.features.map((f, i) => (
                                            <li key={i} className="flex items-start gap-2 text-xs text-slate-300">
                                                <span className={`mt-0.5 shrink-0 ${colors.text}`}>✓</span>
                                                {f}
                                            </li>
                                        ))}
                                    </ul>
                                    {isSelected && (
                                        <div className={`mt-4 text-xs font-bold ${colors.text} flex items-center gap-1`}>
                                            <span>Selecionado</span>
                                        </div>
                                    )}
                                </button>
                            );
                        })}
                    </div>

                    <div className="text-center mt-8">
                        <button
                            onClick={() => setStep('form')}
                            className="inline-flex items-center gap-2 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-bold px-8 py-4 rounded-2xl transition-all shadow-xl shadow-indigo-900/40"
                        >
                            Começar com {selectedPlan.name}
                            <ArrowRight size={18} />
                        </button>
                        <p className="text-xs text-slate-500 mt-3">14 dias grátis · Sem cartão de crédito · Cancele quando quiser</p>
                    </div>
                </div>

                {/* FAQ */}
                <div className="max-w-2xl mx-auto px-4 pb-16">
                    <h3 className="text-center text-lg font-black text-white mb-4">Dúvidas frequentes</h3>
                    {[
                        { q: 'Preciso sair da escola para usar?', a: 'Não necessariamente. Você pode usar a plataforma como professor autônomo ou em paralelo com seu vínculo atual.' },
                        { q: 'Meus alunos terão acesso com minha marca?', a: 'Sim. Seu tenant terá nome, cores e domínio (ou subdomínio) com a sua identidade visual.' },
                        { q: 'Como funciona o pagamento dos alunos?', a: 'Os alunos pagam diretamente para você via Asaas (PIX, boleto ou cartão). O dinheiro cai na sua conta.' },
                        { q: 'Posso convidar outros professores para trabalhar comigo?', a: 'Nos planos Growth e Scale, sim. Você vira o "dono da escola" e pode adicionar professores à sua equipe.' },
                    ].map((item, i) => (
                        <div key={i} className="border-b border-slate-800">
                            <button
                                className="w-full flex items-center justify-between py-4 text-left text-sm font-semibold text-slate-200 hover:text-white transition-colors"
                                onClick={() => setFaqOpen(faqOpen === i ? null : i)}
                            >
                                {item.q}
                                {faqOpen === i ? <ChevronUp size={16} className="text-slate-400 shrink-0" /> : <ChevronDown size={16} className="text-slate-400 shrink-0" />}
                            </button>
                            {faqOpen === i && (
                                <p className="text-sm text-slate-400 pb-4 leading-relaxed">{item.a}</p>
                            )}
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    // ── Formulário ────────────────────────────────────────────────────────────

    const planKey = getPlanKey(selectedPlan.name);
    const colors = planColors[planKey];

    return (
        <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
            <form onSubmit={handleSubmit} className="bg-slate-900 border border-slate-800 rounded-3xl max-w-lg w-full overflow-hidden">
                {/* Header */}
                <div className="bg-gradient-to-br from-indigo-600 to-purple-700 p-7 text-white">
                    <button
                        type="button"
                        onClick={() => setStep('plans')}
                        className="text-xs text-white/60 hover:text-white mb-4 flex items-center gap-1 transition-colors"
                    >
                        ← Voltar aos planos
                    </button>
                    <h1 className="text-2xl font-black mb-1">Criar minha mini-escola</h1>
                    <div className={`inline-flex items-center gap-1.5 text-xs font-bold px-3 py-1 rounded-full ${colors.badge} mt-2`}>
                        <PlanIcon name={selectedPlan.name} />
                        {selectedPlan.name} — R${selectedPlan.price}/mês
                    </div>
                </div>

                <div className="p-7 space-y-4">
                    {error && (
                        <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 flex items-start gap-2">
                            <AlertCircle size={15} className="text-rose-400 shrink-0 mt-0.5" />
                            <p className="text-xs text-rose-300">{error}</p>
                        </div>
                    )}

                    <Field icon={User} label="Seu nome completo *" value={form.teacher_name} onChange={v => setForm({ ...form, teacher_name: v })} required />
                    <Field icon={Mail} label="E-mail *" type="email" value={form.email} onChange={v => setForm({ ...form, email: v })} required />
                    <Field icon={Phone} label="WhatsApp *" value={form.phone} onChange={v => setForm({ ...form, phone: v })} required placeholder="(11) 99999-9999" />
                    <Field icon={FileText} label="CPF (opcional)" value={form.cpf} onChange={v => setForm({ ...form, cpf: v })} placeholder="000.000.000-00" />
                    <Field icon={User} label="Nome da sua escola/marca" value={form.school_name} onChange={v => setForm({ ...form, school_name: v })} placeholder={`Ex: ${form.teacher_name || 'João'} English`} />

                    <div>
                        <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold block mb-1">
                            Observações (opcional)
                        </label>
                        <textarea
                            value={form.notes}
                            onChange={e => setForm({ ...form, notes: e.target.value })}
                            rows={2}
                            placeholder="Especialidade, idioma que leciona, público-alvo..."
                            className="w-full p-3 bg-slate-800 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
                        />
                    </div>

                    <button
                        type="submit"
                        disabled={loading}
                        className="w-full py-4 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-bold rounded-2xl transition-all flex items-center justify-center gap-2 disabled:opacity-60"
                    >
                        {loading ? (
                            <><Loader2 className="animate-spin" size={18} /> Enviando...</>
                        ) : (
                            <>Quero minha mini-escola <ArrowRight size={18} /></>
                        )}
                    </button>
                    <p className="text-[11px] text-slate-600 text-center">
                        Ao enviar, você concorda com os Termos de Uso e Política de Privacidade da Wise Wolf Language School.
                    </p>
                </div>
            </form>
        </div>
    );
};

// ─── Field helper ─────────────────────────────────────────────────────────────

const Field = ({
    icon: Icon,
    label,
    value,
    onChange,
    type = 'text',
    required = false,
    placeholder,
}: {
    icon?: React.ComponentType<any>;
    label: string;
    value: string;
    onChange: (v: string) => void;
    type?: string;
    required?: boolean;
    placeholder?: string;
}) => (
    <div>
        <label className="text-[10px] uppercase tracking-widest text-slate-500 font-bold block mb-1">{label}</label>
        <div className="relative">
            {Icon && <Icon size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />}
            <input
                type={type}
                value={value}
                onChange={e => onChange(e.target.value)}
                required={required}
                placeholder={placeholder}
                className={`w-full p-3 ${Icon ? 'pl-9' : ''} bg-slate-800 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all`}
            />
        </div>
    </div>
);

export default TeacherEntrepreneurSignup;
