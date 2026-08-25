import React, { useState } from 'react';
import {
    AlertCircle,
    ArrowLeft,
    ArrowRight,
    Building2,
    CheckCircle2,
    CircleCheck,
    ClipboardCheck,
    GraduationCap,
    LayoutDashboard,
    Loader2,
    Mail,
    MessagesSquare,
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

type SchoolDiagnosisForm = {
    school_name: string;
    owner_name: string;
    owner_email: string;
    owner_phone: string;
    estimated_students: string;
    estimated_teachers: string;
    school_stage: string;
    priority_area: string;
    main_bottleneck: string;
    current_tools: string;
};

type SchoolFieldErrors = Partial<Record<keyof SchoolDiagnosisForm, string>>;

const INITIAL_FORM: SchoolDiagnosisForm = {
    school_name: '',
    owner_name: '',
    owner_email: '',
    owner_phone: '',
    estimated_students: '',
    estimated_teachers: '',
    school_stage: '',
    priority_area: '',
    main_bottleneck: '',
    current_tools: '',
};

const NAV_ITEMS: HubMarketingNavItem[] = [
    { label: 'Visão geral', href: '#inicio' },
    { label: 'O que mapeamos', href: '#mapeamento' },
    { label: 'Como funciona', href: '#processo' },
    { label: 'Diagnóstico', href: '#diagnostico' },
];

const DIAGNOSIS_AREAS: Array<{
    eyebrow: string;
    title: string;
    description: string;
    bullets: string[];
    icon: LucideIcon;
    tone: string;
}> = [
    {
        eyebrow: 'Aquisição e matrícula',
        title: 'Como oportunidades avançam',
        description: 'Entendemos onde contatos, aulas experimentais e matrículas perdem continuidade.',
        bullets: ['Entrada e qualificação de leads', 'Responsáveis e próximos passos', 'Passagem para matrícula'],
        icon: MessagesSquare,
        tone: '#258e79',
    },
    {
        eyebrow: 'Entrega pedagógica',
        title: 'Como a escola sustenta a experiência',
        description: 'Mapeamos os pontos que conectam direção, professores, alunos e rotina acadêmica.',
        bullets: ['Agenda e acompanhamento', 'Materiais e trilhas', 'Papéis da equipe'],
        icon: GraduationCap,
        tone: '#7652ed',
    },
    {
        eyebrow: 'Gestão e backoffice',
        title: 'Como a operação ganha controle',
        description: 'Levantamos prioridades administrativas e requisitos de acesso antes de propor módulos.',
        bullets: ['Financeiro e contratos', 'Configurações da escola', 'Acessos e responsabilidades'],
        icon: LayoutDashboard,
        tone: '#e49a38',
    },
];

const PROCESS_STEPS = [
    {
        number: '01',
        icon: ClipboardCheck,
        title: 'Leitura do cenário',
        description: 'A equipe analisa o contexto enviado e organiza os pontos que precisam ser aprofundados.',
    },
    {
        number: '02',
        icon: Workflow,
        title: 'Conversa e tour orientado',
        description: 'Percorremos os fluxos prioritários e mostramos os módulos ligados à realidade da escola.',
    },
    {
        number: '03',
        icon: Settings2,
        title: 'Escopo de implantação',
        description: 'Se houver aderência, definimos etapas, configurações, acessos e responsabilidades antes da contratação.',
    },
];

const onlyDigits = (value: string) => value.replace(/\D/g, '');
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SCHOOL_FIELD_IDS: Record<keyof SchoolDiagnosisForm, string> = {
    school_name: 'school-name',
    owner_name: 'school-owner-name',
    owner_email: 'school-owner-email',
    owner_phone: 'school-owner-phone',
    estimated_students: 'school-students',
    estimated_teachers: 'school-teachers',
    school_stage: 'school-stage',
    priority_area: 'school-priority',
    main_bottleneck: 'school-bottleneck',
    current_tools: 'school-tools',
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

const SchoolSignupPage: React.FC = () => {
    useSystemMarketingMetadata('school-diagnosis');
    const [form, setForm] = useState<SchoolDiagnosisForm>(INITIAL_FORM);
    const [loading, setLoading] = useState(false);
    const [submitted, setSubmitted] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [fieldErrors, setFieldErrors] = useState<SchoolFieldErrors>({});

    const updateField = (field: keyof SchoolDiagnosisForm, value: string) => {
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

        const schoolName = form.school_name.trim();
        const ownerName = form.owner_name.trim();
        const ownerEmail = form.owner_email.trim().toLowerCase();
        const ownerPhone = onlyDigits(form.owner_phone);
        const estimatedStudents = Number.parseInt(form.estimated_students, 10);
        const estimatedTeachers = Number.parseInt(form.estimated_teachers, 10);
        const mainBottleneck = form.main_bottleneck.trim();

        const validationErrors: SchoolFieldErrors = {};
        if (!schoolName) validationErrors.school_name = 'Informe o nome da escola.';
        if (!ownerName) validationErrors.owner_name = 'Informe o nome do responsável.';
        if (!ownerEmail) validationErrors.owner_email = 'Informe o e-mail profissional.';
        else if (!EMAIL_PATTERN.test(ownerEmail)) validationErrors.owner_email = 'Informe um e-mail válido.';
        if (!ownerPhone) validationErrors.owner_phone = 'Informe o WhatsApp com DDD.';
        else if (ownerPhone.length < 10 || ownerPhone.length > 13) {
            validationErrors.owner_phone = 'Informe um WhatsApp válido com DDD.';
        }
        if (!form.estimated_students) validationErrors.estimated_students = 'Informe a estimativa de alunos.';
        else if (!Number.isFinite(estimatedStudents) || estimatedStudents < 1) {
            validationErrors.estimated_students = 'Informe uma estimativa válida de alunos.';
        }
        if (!form.estimated_teachers) validationErrors.estimated_teachers = 'Informe a estimativa de professores.';
        else if (!Number.isFinite(estimatedTeachers) || estimatedTeachers < 1) {
            validationErrors.estimated_teachers = 'Informe uma estimativa válida de professores.';
        }
        if (!form.school_stage) validationErrors.school_stage = 'Selecione o momento da escola.';
        if (!form.priority_area) validationErrors.priority_area = 'Selecione a prioridade inicial.';
        if (!mainBottleneck) validationErrors.main_bottleneck = 'Descreva o principal gargalo da operação.';

        const firstInvalidField = (Object.keys(SCHOOL_FIELD_IDS) as Array<keyof SchoolDiagnosisForm>)
            .find((field) => validationErrors[field]);

        if (firstInvalidField) {
            setFieldErrors(validationErrors);
            setError('Revise os campos destacados para solicitar o diagnóstico.');
            focusInvalidField(SCHOOL_FIELD_IDS[firstInvalidField]);
            return;
        }

        setLoading(true);
        setError(null);
        setFieldErrors({});

        try {
            const notes = [
                `Estágio da escola: ${form.school_stage}`,
                `Prioridade inicial: ${form.priority_area}`,
                `Principal gargalo: ${mainBottleneck}`,
                form.current_tools.trim() ? `Ferramentas atuais: ${form.current_tools.trim()}` : null,
            ].filter(Boolean).join('\n');

            const { error: insertError } = await supabase.from('saas_leads').insert({
                name: ownerName,
                email: ownerEmail,
                phone: ownerPhone,
                school_name: schoolName,
                status: 'LEAD',
                notes,
                owner_name: ownerName,
                owner_email: ownerEmail,
                owner_phone: ownerPhone,
                estimated_students: estimatedStudents,
                estimated_teachers: estimatedTeachers,
                source: 'public_school_diagnosis',
                plan_interest: 'Wise Wolf para Escolas — diagnóstico assistido',
                lead_type: 'school',
            });

            if (insertError) throw insertError;
            setSubmitted(true);
        } catch {
            setError('Não foi possível enviar agora. Tente novamente em alguns instantes.');
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
            pageLabel="Para escolas"
        >
            <div className="hub-audience-page" data-audience="schools">
                <section id="inicio" className="hub-audience-hero">
                    <div className="hub-container hub-audience-hero__grid">
                        <HubReveal className="hub-audience-hero__content">
                            <a href={hubMarketingPath('schools')} className="hub-audience-back">
                                <ArrowLeft size={14} />Voltar ao Hub para escolas
                            </a>
                            <p className="hub-eyebrow"><span />Diagnóstico assistido para escolas de inglês</p>
                            <h1>Antes de mostrar módulos, <em>entendemos sua operação.</em></h1>
                            <p className="hub-audience-hero__description">
                                Compartilhe o cenário da escola para receber uma conversa orientada aos seus fluxos comerciais, pedagógicos e administrativos.
                            </p>
                            <div className="hub-audience-hero__actions">
                                <button type="button" className="hub-button hub-button--primary" onClick={scrollToDiagnosis}>
                                    Solicitar diagnóstico<ArrowRight size={17} />
                                </button>
                                <a className="hub-button hub-button--secondary" href="#mapeamento">Ver o que mapeamos</a>
                            </div>
                            <div className="hub-audience-hero__proof">
                                <span><CircleCheck size={13} />Conversa baseada no seu cenário</span>
                                <span><Settings2 size={13} />Escopo definido antes da implantação</span>
                                <span><ShieldCheck size={13} />Sem ativação ou cobrança automática</span>
                            </div>
                        </HubReveal>

                        <HubReveal className="hub-audience-hero__visual" delay={0.12} direction="scale">
                            <div className="hub-audience-hero__visual-head">
                                <span>Visão da direção</span>
                                <em>Comercial + pedagógico + gestão</em>
                            </div>
                            <HubProductMockup kind="school" />
                            <div className="hub-audience-hero__floating-card is-school">
                                <span><ClipboardCheck size={17} /></span>
                                <div><b>Diagnóstico primeiro</b><small>Prioridades antes da proposta</small></div>
                            </div>
                        </HubReveal>
                    </div>
                </section>

                <section className="hub-audience-proof-strip" aria-label="Princípios do diagnóstico para escolas">
                    <div className="hub-container">
                        <span><MessagesSquare size={16} /><b>Contexto comercial</b></span>
                        <span><GraduationCap size={16} /><b>Rotina pedagógica</b></span>
                        <span><LayoutDashboard size={16} /><b>Backoffice da escola</b></span>
                        <span><ShieldCheck size={16} /><b>Acessos no escopo</b></span>
                    </div>
                </section>

                <section id="mapeamento" className="hub-section hub-section--quiet hub-audience-offers-section">
                    <div className="hub-container">
                        <HubReveal>
                            <HubSectionIntro
                                eyebrow="A escola como jornada"
                                title={<>Três áreas conectadas. <em>Uma leitura com contexto.</em></>}
                                description="O diagnóstico identifica onde a informação se perde e quais blocos merecem atenção primeiro."
                                align="center"
                            />
                        </HubReveal>

                        <div className="hub-audience-offer-grid" aria-label="Áreas avaliadas no diagnóstico">
                            {DIAGNOSIS_AREAS.map(({ eyebrow, title, description, bullets, icon: Icon, tone }, index) => (
                                <HubReveal key={eyebrow} delay={index * 0.06}>
                                    <article className="hub-audience-offer-card" style={{ '--audience-card-tone': tone } as React.CSSProperties}>
                                        <div className="hub-audience-offer-card__top">
                                            <span className="hub-audience-offer-card__icon"><Icon size={23} /></span>
                                            <span className="hub-audience-offer-card__number">{String(index + 1).padStart(2, '0')}</span>
                                        </div>
                                        <p className="hub-audience-offer-card__eyebrow">{eyebrow}</p>
                                        <h3>{title}</h3>
                                        <p className="hub-audience-offer-card__description">{description}</p>
                                        <ul>
                                            {bullets.map((bullet) => <li key={bullet}><CheckCircle2 size={14} />{bullet}</li>)}
                                        </ul>
                                    </article>
                                </HubReveal>
                            ))}
                        </div>
                    </div>
                </section>

                <section id="processo" className="hub-section hub-audience-rollout-section">
                    <div className="hub-container hub-audience-rollout">
                        <HubReveal className="hub-audience-rollout__intro">
                            <HubSectionIntro
                                eyebrow="Processo assistido"
                                title={<>Clareza antes de <em>qualquer decisão.</em></>}
                                description="A primeira conversa não exige dados reais de alunos nem acesso aos sistemas atuais da escola."
                            />
                            <button type="button" className="hub-button hub-button--primary" onClick={scrollToDiagnosis}>
                                Compartilhar meu cenário<ArrowRight size={16} />
                            </button>
                        </HubReveal>

                        <div className="hub-audience-rollout__steps">
                            {PROCESS_STEPS.map(({ number, icon: Icon, title, description }, index) => (
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
                            <p className="hub-eyebrow"><span />Diagnóstico da escola</p>
                            <h2>Mostre onde a operação perde contexto. <em>Nós começamos por aí.</em></h2>
                            <p>As respostas qualificam a conversa e evitam uma demonstração genérica. Não pedimos dados de alunos, credenciais ou documentos nesta etapa.</p>
                            <div className="hub-audience-assisted__capabilities">
                                <span><ClipboardCheck size={15} />Leitura da operação</span>
                                <span><Workflow size={15} />Tour por prioridade</span>
                                <span><ShieldCheck size={15} />Coleta mínima de dados</span>
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
                                        Recebemos o contexto da {form.school_name.trim()}. A equipe vai analisar as informações e usar os contatos enviados para organizar a conversa.
                                    </p>
                                    <div className="mt-6 flex items-start gap-3 rounded-2xl border border-white/10 bg-white/5 p-4 text-left text-xs leading-6 text-slate-300">
                                        <ShieldCheck className="mt-0.5 shrink-0 text-emerald-300" size={18} />
                                        <span>Nenhum tenant, conta, assinatura ou cobrança foi criado com este envio.</span>
                                    </div>
                                    <a className="hub-button hub-button--inverse mt-7" href={hubMarketingPath('schools')}>
                                        Voltar ao Hub para escolas<ArrowRight size={16} />
                                    </a>
                                </section>
                            ) : (
                                <form onSubmit={handleSubmit} noValidate className="space-y-5">
                                    <div>
                                        <p className="text-[10px] font-black uppercase tracking-[0.14em] text-emerald-300">Seu cenário atual</p>
                                        <h2 className="mt-2 text-2xl font-black tracking-tight text-white">Solicite uma conversa de diagnóstico</h2>
                                        <p className="mt-2 text-xs leading-6 text-slate-400">Campos com * são necessários para entendermos a operação.</p>
                                    </div>

                                    {error && (
                                        <div id="school-form-error-summary" className="flex items-start gap-3 rounded-2xl border border-rose-400/25 bg-rose-400/10 p-4" role="alert" aria-live="assertive">
                                            <AlertCircle className="mt-0.5 shrink-0 text-rose-300" size={17} />
                                            <p className="text-xs leading-5 text-rose-100">{error}</p>
                                        </div>
                                    )}

                                    <div className="grid gap-4 md:grid-cols-2">
                                        <Field id="school-name" icon={Building2} label="Nome da escola *" value={form.school_name} onChange={(value) => updateField('school_name', value)} autoComplete="organization" required error={fieldErrors.school_name} />
                                        <Field id="school-owner-name" icon={User} label="Nome do responsável *" value={form.owner_name} onChange={(value) => updateField('owner_name', value)} autoComplete="name" required error={fieldErrors.owner_name} />
                                        <Field id="school-owner-email" icon={Mail} label="E-mail profissional *" type="email" value={form.owner_email} onChange={(value) => updateField('owner_email', value)} autoComplete="email" required error={fieldErrors.owner_email} />
                                        <Field id="school-owner-phone" icon={Phone} label="WhatsApp com DDD *" type="tel" value={form.owner_phone} onChange={(value) => updateField('owner_phone', value)} autoComplete="tel" placeholder="(11) 99999-9999" required error={fieldErrors.owner_phone} />
                                        <Field id="school-students" icon={UsersRound} label="Estimativa de alunos *" type="number" value={form.estimated_students} onChange={(value) => updateField('estimated_students', value)} min={1} placeholder="Ex.: 180" required error={fieldErrors.estimated_students} />
                                        <Field id="school-teachers" icon={GraduationCap} label="Estimativa de professores *" type="number" value={form.estimated_teachers} onChange={(value) => updateField('estimated_teachers', value)} min={1} placeholder="Ex.: 12" required error={fieldErrors.estimated_teachers} />
                                        <SelectField
                                            id="school-stage"
                                            label="Momento da escola *"
                                            value={form.school_stage}
                                            onChange={(value) => updateField('school_stage', value)}
                                            options={[
                                                ['Em estruturação', 'Em estruturação'],
                                                ['Operação ativa', 'Operação ativa'],
                                                ['Em expansão', 'Em expansão'],
                                                ['Rede ou múltiplas unidades', 'Rede ou múltiplas unidades'],
                                            ]}
                                            error={fieldErrors.school_stage}
                                        />
                                        <SelectField
                                            id="school-priority"
                                            label="Prioridade inicial *"
                                            value={form.priority_area}
                                            onChange={(value) => updateField('priority_area', value)}
                                            options={[
                                                ['Comercial e matrículas', 'Comercial e matrículas'],
                                                ['Pedagógico e experiência do aluno', 'Pedagógico e experiência do aluno'],
                                                ['Agenda e operação', 'Agenda e operação'],
                                                ['Financeiro e contratos', 'Financeiro e contratos'],
                                                ['Acessos, dados e configurações', 'Acessos, dados e configurações'],
                                            ]}
                                            error={fieldErrors.priority_area}
                                        />
                                    </div>

                                    <TextAreaField
                                        id="school-bottleneck"
                                        label="Principal gargalo da operação *"
                                        value={form.main_bottleneck}
                                        onChange={(value) => updateField('main_bottleneck', value)}
                                        placeholder="Ex.: os contatos chegam pelo WhatsApp, mas a equipe perde o histórico entre a aula experimental e a matrícula."
                                        required
                                        error={fieldErrors.main_bottleneck}
                                    />
                                    <TextAreaField
                                        id="school-tools"
                                        label="Ferramentas usadas hoje (opcional)"
                                        value={form.current_tools}
                                        onChange={(value) => updateField('current_tools', value)}
                                        placeholder="Ex.: planilhas, agenda online, sistema financeiro e WhatsApp. Não informe senhas ou credenciais."
                                    />

                                    <button type="submit" disabled={loading} className="hub-button hub-button--inverse w-full justify-center disabled:cursor-not-allowed disabled:opacity-60">
                                        {loading ? <><Loader2 className="animate-spin" size={17} />Enviando contexto...</> : <>Solicitar diagnóstico<ArrowRight size={17} /></>}
                                    </button>
                                    <p className="text-center text-[10px] leading-5 text-slate-500">
                                        Ao enviar, você autoriza o contato para análise desta solicitação. O envio não cria tenant, conta, assinatura ou cobrança.
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
    min?: number;
    error?: string;
}> = ({ id, icon: Icon, label, value, onChange, type = 'text', required = false, placeholder, autoComplete, min, error }) => (
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

const SelectField: React.FC<{
    id: string;
    label: string;
    value: string;
    onChange: (value: string) => void;
    options: Array<[string, string]>;
    error?: string;
}> = ({ id, label, value, onChange, options, error }) => (
    <div>
        <label htmlFor={id} className="mb-2 block text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">{label}</label>
        <select
            id={id}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            required
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            className={`w-full rounded-2xl border bg-[#1d2430] px-4 py-3 text-sm text-white outline-none transition focus:ring-2 ${error
                ? 'border-rose-300/70 focus:border-rose-300 focus:ring-rose-300/15'
                : 'border-white/10 focus:border-emerald-300 focus:ring-emerald-300/15'}`}
        >
            <option value="">Selecione</option>
            {options.map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}
        </select>
        {error && <p id={`${id}-error`} className="mt-2 text-xs leading-5 text-rose-200">{error}</p>}
    </div>
);

const TextAreaField: React.FC<{
    id: string;
    label: string;
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    required?: boolean;
    error?: string;
}> = ({ id, label, value, onChange, placeholder, required = false, error }) => (
    <div>
        <label htmlFor={id} className="mb-2 block text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">{label}</label>
        <textarea
            id={id}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            rows={4}
            maxLength={800}
            required={required}
            placeholder={placeholder}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            className={`w-full resize-none rounded-2xl border bg-white/5 px-4 py-3 text-sm leading-6 text-white outline-none transition placeholder:text-slate-500 focus:ring-2 ${error
                ? 'border-rose-300/70 focus:border-rose-300 focus:ring-rose-300/15'
                : 'border-white/10 focus:border-emerald-300 focus:ring-emerald-300/15'}`}
        />
        {error && <p id={`${id}-error`} className="mt-2 text-xs leading-5 text-rose-200">{error}</p>}
    </div>
);

export default SchoolSignupPage;
