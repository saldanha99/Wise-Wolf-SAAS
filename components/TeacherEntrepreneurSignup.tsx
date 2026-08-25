import React, { useState } from 'react';
import {
    AlertCircle,
    ArrowLeft,
    ArrowRight,
    CalendarCheck2,
    CheckCircle2,
    CircleCheck,
    ClipboardCheck,
    FileSignature,
    Gauge,
    LayoutDashboard,
    Loader2,
    Mail,
    Phone,
    Settings2,
    ShieldCheck,
    User,
    UsersRound,
    Workflow,
    type LucideIcon,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import HubMarketingShell, {
    HubReveal,
    HubSectionIntro,
    type HubMarketingNavItem,
} from './hub/HubMarketingShell';
import HubProductMockup from './hub/HubProductMockups';
import { hubMarketingPath, resolveSystemAppUrl } from './hub/hubRoutes';
import { useSystemMarketingMetadata } from './marketing/useSystemMarketingMetadata';
import './hub/hub-audience.css';

interface TeacherEntrepreneurSignupProps {
    parentTenantId?: string;
    referrerTeacherId?: string;
}

type LeadForm = {
    teacher_name: string;
    email: string;
    phone: string;
    school_name: string;
    estimated_students: string;
    main_bottleneck: string;
};

type LeadFieldErrors = Partial<Record<keyof LeadForm, string>>;

const INITIAL_FORM: LeadForm = {
    teacher_name: '',
    email: '',
    phone: '',
    school_name: '',
    estimated_students: '',
    main_bottleneck: '',
};

const JOURNEY: Array<{
    label: string;
    title: string;
    description: string;
    marker: string;
    icon: LucideIcon;
}> = [
    {
        label: 'Rotina',
        title: 'Agenda que organiza o dia',
        description: 'Centralize aulas, horários e próximos passos para reduzir ruído na operação cotidiana.',
        marker: 'Agenda e reposições',
        icon: CalendarCheck2,
    },
    {
        label: 'Comercial',
        title: 'CRM para não perder oportunidades',
        description: 'Acompanhe contatos, conversas e matrículas com contexto e responsável definidos.',
        marker: 'Do lead à matrícula',
        icon: UsersRound,
    },
    {
        label: 'Formalização',
        title: 'Contratos e pagamentos no fluxo',
        description: 'Organize a passagem do acordo para a cobrança sem depender de controles espalhados.',
        marker: 'Menos trabalho manual',
        icon: FileSignature,
    },
    {
        label: 'Gestão',
        title: 'Visão financeira para decidir',
        description: 'Enxergue cobranças e a situação da operação para tomar decisões com mais segurança.',
        marker: 'Controle do negócio',
        icon: Gauge,
    },
];

const NAV_ITEMS: HubMarketingNavItem[] = [
    { label: 'Visão geral', href: '#inicio' },
    { label: 'Jornada', href: '#jornada' },
    { label: 'Implantação', href: '#implantacao' },
    { label: 'Diagnóstico', href: '#diagnostico' },
];

const onlyDigits = (value: string) => value.replace(/\D/g, '');
const isValidEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const TEACHER_FIELD_IDS: Record<keyof LeadForm, string> = {
    teacher_name: 'teacher-name',
    email: 'teacher-email',
    phone: 'teacher-phone',
    school_name: 'teacher-brand',
    estimated_students: 'teacher-students',
    main_bottleneck: 'teacher-bottleneck',
};

const focusInvalidField = (fieldId: string) => {
    const field = document.getElementById(fieldId);
    if (!(field instanceof HTMLElement)) return;

    const reducedMotion = typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    field.focus({ preventScroll: true });
    field.scrollIntoView({
        behavior: reducedMotion ? 'auto' : 'smooth',
        block: 'center',
    });
};

const TeacherEntrepreneurSignup: React.FC<TeacherEntrepreneurSignupProps> = ({
    parentTenantId,
    referrerTeacherId,
}) => {
    useSystemMarketingMetadata('teacher-business');
    const [form, setForm] = useState<LeadForm>(INITIAL_FORM);
    const [loading, setLoading] = useState(false);
    const [submitted, setSubmitted] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [fieldErrors, setFieldErrors] = useState<LeadFieldErrors>({});

    const updateField = (field: keyof LeadForm, value: string) => {
        setForm((current) => ({ ...current, [field]: value }));
        setFieldErrors((current) => {
            if (!current[field]) return current;
            const next = { ...current };
            delete next[field];
            return next;
        });
        setError(null);
    };

    const scrollToDiagnosis = () => {
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        document.getElementById('diagnostico')?.scrollIntoView({
            behavior: reducedMotion ? 'auto' : 'smooth',
            block: 'start',
        });
    };

    const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        const teacherName = form.teacher_name.trim();
        const email = form.email.trim().toLowerCase();
        const phone = onlyDigits(form.phone);
        const schoolName = form.school_name.trim();
        const estimatedStudents = Number.parseInt(form.estimated_students, 10);
        const mainBottleneck = form.main_bottleneck.trim();

        const validationErrors: LeadFieldErrors = {};
        if (!teacherName) validationErrors.teacher_name = 'Informe seu nome completo.';
        if (!email) validationErrors.email = 'Informe seu e-mail.';
        else if (!isValidEmail(email)) validationErrors.email = 'Informe um e-mail válido.';
        if (!phone) validationErrors.phone = 'Informe seu WhatsApp com DDD.';
        else if (phone.length < 10) validationErrors.phone = 'Informe um WhatsApp com DDD.';
        if (!schoolName) validationErrors.school_name = 'Informe o nome da marca ou operação.';
        if (!form.estimated_students) validationErrors.estimated_students = 'Informe a estimativa de alunos.';
        else if (!Number.isFinite(estimatedStudents) || estimatedStudents < 0) {
            validationErrors.estimated_students = 'Informe uma estimativa válida de alunos.';
        }
        if (!mainBottleneck) validationErrors.main_bottleneck = 'Descreva o principal gargalo da operação.';

        const firstInvalidField = (Object.keys(TEACHER_FIELD_IDS) as Array<keyof LeadForm>)
            .find((field) => validationErrors[field]);

        if (firstInvalidField) {
            setFieldErrors(validationErrors);
            setError('Revise os campos destacados para solicitar o diagnóstico.');
            focusInvalidField(TEACHER_FIELD_IDS[firstInvalidField]);
            return;
        }

        setLoading(true);
        setError(null);
        setFieldErrors({});

        try {
            const source = referrerTeacherId
                ? 'teacher_to_teacher_referral'
                : parentTenantId
                    ? 'teacher_referral'
                    : 'teacher_signup';

            const { error: insertError } = await supabase.from('saas_leads').insert({
                name: teacherName,
                email,
                phone,
                school_name: schoolName,
                status: 'new',
                owner_name: teacherName,
                owner_email: email,
                owner_phone: phone,
                estimated_students: estimatedStudents,
                estimated_teachers: 1,
                source,
                referrer_teacher_id: referrerTeacherId || null,
                plan_interest: 'Professor Negócio',
                lead_type: 'teacher',
                parent_tenant_id: parentTenantId || null,
                notes: `Principal gargalo informado: ${mainBottleneck}`,
            });

            if (insertError) throw insertError;
            setSubmitted(true);
        } catch {
            setError('Não foi possível enviar agora. Revise os dados ou tente novamente em alguns instantes.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <HubMarketingShell
            navItems={NAV_ITEMS}
            onLogin={() => { window.location.href = resolveSystemAppUrl('/'); }}
            onPrimary={scrollToDiagnosis}
            primaryLabel="Solicitar diagnóstico"
            accent="#258e79"
            pageLabel="Professor Negócio"
        >
            <div className="hub-audience-page" data-audience="schools">
                <section id="inicio" className="hub-audience-hero">
                    <div className="hub-container hub-audience-hero__grid">
                        <HubReveal className="hub-audience-hero__content">
                            <a href={hubMarketingPath('teachers')} className="hub-audience-back">
                                <ArrowLeft size={14} />Voltar ao Hub para professores
                            </a>
                            <p className="hub-eyebrow"><span />Uma oferta para professores com operação ativa</p>
                            <h1>Seu trabalho já virou uma operação. <em>Agora, ela precisa funcionar como negócio.</em></h1>
                            <p className="hub-audience-hero__description">
                                Professor Negócio conecta agenda, CRM, contratos, pagamentos e visão financeira em um ambiente preparado com implantação assistida.
                            </p>
                            <div className="hub-audience-hero__actions">
                                <button type="button" className="hub-button hub-button--primary" onClick={scrollToDiagnosis}>
                                    Solicitar diagnóstico<ArrowRight size={17} />
                                </button>
                                <a className="hub-button hub-button--secondary" href="#jornada">Ver como funciona</a>
                            </div>
                            <div className="hub-audience-hero__proof">
                                <span><CircleCheck size={13} />Oferta única</span>
                                <span><Settings2 size={13} />Implantação assistida</span>
                                <span><ShieldCheck size={13} />Sem ativação automática</span>
                            </div>
                        </HubReveal>

                        <HubReveal className="hub-audience-hero__visual" delay={0.12} direction="scale">
                            <div className="hub-audience-hero__visual-head">
                                <span>Professor Negócio</span>
                                <em>Operação conectada</em>
                            </div>
                            <HubProductMockup kind="school" />
                            <div className="hub-audience-hero__floating-card is-school">
                                <span><ClipboardCheck size={17} /></span>
                                <div><b>Entrada orientada</b><small>Diagnóstico antes de definir o escopo</small></div>
                            </div>
                        </HubReveal>
                    </div>
                </section>

                <section className="hub-audience-proof-strip" aria-label="Pilares do Professor Negócio">
                    <div className="hub-container">
                        <span><CalendarCheck2 size={16} /><b>Agenda organizada</b></span>
                        <span><Workflow size={16} /><b>CRM com continuidade</b></span>
                        <span><FileSignature size={16} /><b>Contratos e pagamentos</b></span>
                        <span><Gauge size={16} /><b>Visão financeira</b></span>
                    </div>
                </section>

                <section id="jornada" className="hub-section hub-audience-journey-section">
                    <div className="hub-container">
                        <HubReveal>
                            <HubSectionIntro
                                eyebrow="Uma operação, quatro momentos"
                                title={<>Do horário confirmado à decisão financeira. <em>Sem perder o contexto no caminho.</em></>}
                                description="A jornada mostra os blocos da oferta. O diagnóstico identifica prioridades e define como a implantação deve começar."
                            />
                        </HubReveal>

                        <ol className="hub-audience-journey" aria-label="Jornada do Professor Negócio">
                            {JOURNEY.map(({ label, title, description, marker, icon: Icon }, index) => (
                                <HubReveal as="li" key={label} delay={index * 0.06} className="hub-audience-journey__step">
                                        <div className="hub-audience-journey__rail" aria-hidden="true">
                                            <span>{String(index + 1).padStart(2, '0')}</span>
                                        </div>
                                        <div className="hub-audience-journey__icon"><Icon size={21} /></div>
                                        <p className="hub-audience-journey__label">{label}</p>
                                        <h3>{title}</h3>
                                        <p className="hub-audience-journey__description">{description}</p>
                                        <span className="hub-audience-journey__marker">{marker}</span>
                                </HubReveal>
                            ))}
                        </ol>
                    </div>
                </section>

                <section id="implantacao" className="hub-section hub-audience-rollout-section">
                    <div className="hub-container hub-audience-rollout">
                        <HubReveal className="hub-audience-rollout__intro">
                            <HubSectionIntro
                                eyebrow="Implantação assistida"
                                title={<>Primeiro entendemos a rotina. <em>Depois desenhamos a entrada.</em></>}
                                description="Professor Negócio não começa por uma seleção pública de planos. O diagnóstico orienta demonstração, prioridades e escopo."
                            />
                            <button type="button" className="hub-button hub-button--primary" onClick={scrollToDiagnosis}>
                                Compartilhar meu cenário<ArrowRight size={16} />
                            </button>
                        </HubReveal>

                        <div className="hub-audience-rollout__steps">
                            {[
                                { number: '01', icon: ClipboardCheck, title: 'Diagnóstico', description: 'Mapeamos carteira de alunos, rotina atual e o principal gargalo da operação.' },
                                { number: '02', icon: LayoutDashboard, title: 'Tour orientado', description: 'Apresentamos os fluxos ligados ao seu cenário, sem uma demonstração genérica.' },
                                { number: '03', icon: Settings2, title: 'Escopo de implantação', description: 'Organizamos prioridades, configurações e a sequência de adoção antes de qualquer ativação.' },
                            ].map(({ number, icon: Icon, title, description }, index) => (
                                <HubReveal key={number} delay={index * 0.06}>
                                    <article>
                                        <span className="hub-audience-rollout__number">{number}</span>
                                        <span className="hub-audience-rollout__icon"><Icon size={21} /></span>
                                        <div><h3>{title}</h3><p>{description}</p></div>
                                    </article>
                                </HubReveal>
                            ))}
                        </div>
                    </div>
                </section>

                <section id="diagnostico" className="hub-audience-assisted scroll-mt-24">
                    <div className="hub-container hub-audience-assisted__panel">
                        <HubReveal className="hub-audience-assisted__copy">
                            <p className="hub-eyebrow"><span />Diagnóstico Professor Negócio</p>
                            <h2>Conte onde sua operação trava. <em>Nós começamos por aí.</em></h2>
                            <p>
                                O formulário qualifica seu cenário para que a primeira conversa seja objetiva e conectada à sua realidade.
                            </p>
                            <div className="hub-audience-assisted__capabilities">
                                <span><ClipboardCheck size={15} />Análise do contexto</span>
                                <span><LayoutDashboard size={15} />Tour orientado</span>
                                <span><ShieldCheck size={15} />Nenhuma ativação automática</span>
                            </div>
                        </HubReveal>

                        <HubReveal className="hub-audience-assisted__commercial" delay={0.08} direction="scale">
                            {submitted ? (
                                <section className="py-3 text-center" aria-live="polite">
                                    <span className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-emerald-400/15 text-emerald-300">
                                        <CheckCircle2 size={32} />
                                    </span>
                                    <p className="mt-6 text-[10px] font-black uppercase tracking-[0.14em] text-emerald-300">Solicitação recebida</p>
                                    <h2 className="mt-2 text-3xl font-black tracking-tight text-white">Diagnóstico solicitado.</h2>
                                    <p className="mx-auto mt-4 max-w-md text-sm leading-7 text-slate-300">
                                        Recebemos seu contexto, {form.teacher_name.trim()}. A equipe vai analisar a operação e entrar em contato pelos dados informados para uma conversa de diagnóstico.
                                    </p>
                                    <div className="mt-6 flex items-start gap-3 rounded-2xl border border-white/10 bg-white/5 p-4 text-left text-xs leading-6 text-slate-300">
                                        <ShieldCheck className="mt-0.5 shrink-0 text-emerald-300" size={18} />
                                        <span>Nenhuma conta, assinatura ou cobrança foi ativada com este envio.</span>
                                    </div>
                                    <a className="hub-button hub-button--inverse mt-7" href={hubMarketingPath('teachers')}>
                                        Voltar ao Hub para professores<ArrowRight size={16} />
                                    </a>
                                </section>
                            ) : (
                                <form onSubmit={handleSubmit} noValidate className="space-y-5">
                                    <div>
                                        <p className="text-[10px] font-black uppercase tracking-[0.14em] text-emerald-300">Seu cenário atual</p>
                                        <h2 className="mt-2 text-2xl font-black tracking-tight text-white">Solicite uma conversa de diagnóstico</h2>
                                        <p className="mt-2 text-xs leading-6 text-slate-400">Campos com * são necessários. Não informe dados de alunos, documentos ou credenciais.</p>
                                    </div>

                                    {error && (
                                        <div id="teacher-form-error-summary" className="flex items-start gap-3 rounded-2xl border border-rose-400/25 bg-rose-400/10 p-4" role="alert" aria-live="assertive">
                                            <AlertCircle className="mt-0.5 shrink-0 text-rose-300" size={17} />
                                            <p className="text-xs leading-5 text-rose-100">{error}</p>
                                        </div>
                                    )}

                                    <div className="grid gap-4 md:grid-cols-2">
                                        <Field
                                            id="teacher-name"
                                            icon={User}
                                            label="Nome completo *"
                                            value={form.teacher_name}
                                            onChange={(value) => updateField('teacher_name', value)}
                                            autoComplete="name"
                                            required
                                            error={fieldErrors.teacher_name}
                                        />
                                        <Field
                                            id="teacher-email"
                                            icon={Mail}
                                            label="E-mail *"
                                            type="email"
                                            value={form.email}
                                            onChange={(value) => updateField('email', value)}
                                            autoComplete="email"
                                            required
                                            error={fieldErrors.email}
                                        />
                                        <Field
                                            id="teacher-phone"
                                            icon={Phone}
                                            label="WhatsApp com DDD *"
                                            type="tel"
                                            value={form.phone}
                                            onChange={(value) => updateField('phone', value)}
                                            autoComplete="tel"
                                            placeholder="(11) 99999-9999"
                                            required
                                            error={fieldErrors.phone}
                                        />
                                        <Field
                                            id="teacher-brand"
                                            icon={LayoutDashboard}
                                            label="Nome da marca / operação *"
                                            value={form.school_name}
                                            onChange={(value) => updateField('school_name', value)}
                                            autoComplete="organization"
                                            placeholder="Ex.: Macena English"
                                            required
                                            error={fieldErrors.school_name}
                                        />
                                        <Field
                                            id="teacher-students"
                                            icon={UsersRound}
                                            label="Estimativa de alunos *"
                                            type="number"
                                            value={form.estimated_students}
                                            onChange={(value) => updateField('estimated_students', value)}
                                            min={0}
                                            placeholder="Ex.: 24"
                                            required
                                            error={fieldErrors.estimated_students}
                                        />
                                    </div>

                                    <div>
                                        <label htmlFor="teacher-bottleneck" className="mb-2 block text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
                                            Principal gargalo da operação *
                                        </label>
                                        <textarea
                                            id="teacher-bottleneck"
                                            value={form.main_bottleneck}
                                            onChange={(event) => updateField('main_bottleneck', event.target.value)}
                                            rows={4}
                                            maxLength={600}
                                            required
                                            placeholder="Ex.: perco oportunidades no WhatsApp e não consigo acompanhar cobranças sem planilhas."
                                            aria-invalid={fieldErrors.main_bottleneck ? true : undefined}
                                            aria-describedby={fieldErrors.main_bottleneck ? 'teacher-bottleneck-error' : undefined}
                                            className={`w-full resize-none rounded-2xl border bg-white/5 px-4 py-3 text-sm leading-6 text-white outline-none transition placeholder:text-slate-500 focus:ring-2 ${fieldErrors.main_bottleneck
                                                ? 'border-rose-300/70 focus:border-rose-300 focus:ring-rose-300/15'
                                                : 'border-white/10 focus:border-emerald-300 focus:ring-emerald-300/15'}`}
                                        />
                                        {fieldErrors.main_bottleneck && (
                                            <p id="teacher-bottleneck-error" className="mt-2 text-xs leading-5 text-rose-200">
                                                {fieldErrors.main_bottleneck}
                                            </p>
                                        )}
                                    </div>

                                    <button
                                        type="submit"
                                        disabled={loading}
                                        className="hub-button hub-button--inverse w-full justify-center disabled:cursor-not-allowed disabled:opacity-60"
                                    >
                                        {loading ? <><Loader2 className="animate-spin" size={17} />Enviando contexto...</> : <>Solicitar diagnóstico<ArrowRight size={17} /></>}
                                    </button>
                                    <p className="text-center text-[10px] leading-5 text-slate-500">
                                        Ao enviar, você autoriza o contato para análise desta solicitação. O envio não cria conta, assinatura ou cobrança.
                                    </p>
                                </form>
                            )}
                        </HubReveal>
                    </div>
                </section>
            </div>
        </HubMarketingShell>
    );
};

const Field: React.FC<{
    id: string;
    icon: LucideIcon;
    label: string;
    value: string;
    onChange: (value: string) => void;
    type?: React.InputHTMLAttributes<HTMLInputElement>['type'];
    required?: boolean;
    placeholder?: string;
    autoComplete?: string;
    inputMode?: React.InputHTMLAttributes<HTMLInputElement>['inputMode'];
    min?: number;
    error?: string;
}> = ({
    id,
    icon: Icon,
    label,
    value,
    onChange,
    type = 'text',
    required = false,
    placeholder,
    autoComplete,
    inputMode,
    min,
    error,
}) => (
    <div>
        <label htmlFor={id} className="mb-2 block text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">{label}</label>
        <div className="relative">
            <Icon className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" size={16} aria-hidden="true" />
            <input
                id={id}
                type={type}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                required={required}
                placeholder={placeholder}
                autoComplete={autoComplete}
                inputMode={inputMode}
                min={min}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? `${id}-error` : undefined}
                className={`w-full rounded-2xl border bg-white/5 py-3 pl-11 pr-4 text-sm text-white outline-none transition placeholder:text-slate-500 focus:ring-2 ${error
                    ? 'border-rose-300/70 focus:border-rose-300 focus:ring-rose-300/15'
                    : 'border-white/10 focus:border-emerald-300 focus:ring-emerald-300/15'}`}
            />
        </div>
        {error && <p id={`${id}-error`} className="mt-2 text-xs leading-5 text-rose-200">{error}</p>}
    </div>
);

export default TeacherEntrepreneurSignup;
