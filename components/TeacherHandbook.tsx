import React, { useMemo, useState } from 'react';
import {
    AlertTriangle,
    ArrowRight,
    BadgeCheck,
    Ban,
    BookOpen,
    CalendarCheck,
    CalendarX,
    CheckCircle2,
    Coins,
    FileSignature,
    GraduationCap,
    LayoutDashboard,
    Lightbulb,
    Presentation,
    Repeat,
    Search,
    ShieldCheck,
    Shuffle,
    Users,
    Video,
} from 'lucide-react';
import { useTeacherHandbookAck } from '../lib/useTeacherHandbookAck';
import {
    searchTeacherHandbook,
    TEACHER_HANDBOOK_SECTIONS,
    type HandbookSection,
    type HandbookTone,
} from '../lib/teacherHandbook';

const ICONS: Record<HandbookSection['icon'], React.ElementType> = {
    school: GraduationCap,
    contract: FileSignature,
    money: Coins,
    exchange: Shuffle,
    record: Video,
    calendar: CalendarCheck,
    cover: Users,
    holiday: CalendarX,
    repeat: Repeat,
    trial: BookOpen,
    student: Ban,
    platform: LayoutDashboard,
    demo: Presentation,
};

const TONE: Record<HandbookTone, { label: string; className: string; icon: React.ElementType }> = {
    rule: {
        label: 'Obrigatório',
        className: 'bg-brand-accent/10 text-brand-accent border-brand-accent/20',
        icon: ShieldCheck,
    },
    tip: {
        label: 'Boa prática',
        className: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-300 dark:border-emerald-800/40',
        icon: Lightbulb,
    },
    warning: {
        label: 'Atenção',
        className: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-300 dark:border-red-800/40',
        icon: AlertTriangle,
    },
};

interface Props {
    userId: string;
    onNavigate: (tab: string) => void;
}

/**
 * Manual do Professor — o treinamento obrigatório da escola em uma tela só.
 * Conteúdo em `lib/teacherHandbook.ts`; a confirmação de leitura fica em
 * `feature_tour_views` (`useTeacherHandbookAck`).
 */
const TeacherHandbook: React.FC<Props> = ({ userId, onNavigate }) => {
    const [query, setQuery] = useState('');
    const [agreed, setAgreed] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState(false);
    const { acknowledged, acknowledge } = useTeacherHandbookAck(userId);

    const sections = useMemo(() => searchTeacherHandbook(query), [query]);
    const searching = query.trim().length > 0;

    const goTo = (id: string) => {
        document.getElementById(`pilar-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    const confirm = async () => {
        setSaving(true);
        setSaveError(false);
        const ok = await acknowledge();
        setSaving(false);
        if (!ok) setSaveError(true);
    };

    return (
        <div className="max-w-5xl mx-auto space-y-8 animate-fade-in-up font-sans pb-12">
            {/* Capa */}
            <header
                data-tour="teacher-handbook"
                className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-[#000F66] via-[#1A2690] to-[#2B3AB8] text-white p-6 md:p-10 shadow-xl"
            >
                <div className="absolute -right-16 -top-16 w-64 h-64 rounded-full bg-white/5" aria-hidden />
                <div className="absolute right-10 bottom-[-60px] w-40 h-40 rounded-full bg-[#E31B23]/20" aria-hidden />
                <div className="relative space-y-4">
                    <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-[11px] font-bold uppercase tracking-widest">
                        <GraduationCap size={14} /> Treinamento obrigatório
                    </span>
                    <h1 className="text-3xl md:text-4xl font-black tracking-tight">Manual do Professor Wise Wolf</h1>
                    <p className="max-w-2xl text-white/80 text-sm md:text-base leading-relaxed">
                        Os pilares para usar a plataforma, cuidar do aluno e trabalhar com a escola. Leia tudo uma vez,
                        confirme no final e volte aqui sempre que tiver dúvida — o manual fica no seu menu.
                    </p>
                    <div className="flex flex-wrap items-center gap-3 pt-2">
                        {acknowledged === true ? (
                            <span className="inline-flex items-center gap-2 rounded-xl bg-emerald-500/20 border border-emerald-300/30 px-4 py-2 text-sm font-bold">
                                <BadgeCheck size={18} /> Treinamento concluído
                            </span>
                        ) : (
                            <span className="inline-flex items-center gap-2 rounded-xl bg-[#E31B23] px-4 py-2 text-sm font-bold shadow-lg">
                                <AlertTriangle size={18} /> Leitura pendente — confirme no final
                            </span>
                        )}
                        <span className="text-xs text-white/70">{TEACHER_HANDBOOK_SECTIONS.length} pilares · ~10 min de leitura</span>
                    </div>
                </div>
            </header>

            {/* Busca + índice */}
            <section className="space-y-4">
                <label className="relative block">
                    <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-brand-muted" />
                    <input
                        type="search"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Buscar: reposição, feriado, teacher exchange, turbo…"
                        className="w-full rounded-2xl border border-brand-border bg-brand-surface py-3.5 pl-11 pr-4 text-sm text-brand-text outline-none focus:ring-2 focus:ring-brand-accent/40"
                    />
                </label>
                {!searching && (
                    <nav className="flex flex-wrap gap-2" aria-label="Pilares do manual">
                        {TEACHER_HANDBOOK_SECTIONS.map(section => (
                            <button
                                key={section.id}
                                type="button"
                                onClick={() => goTo(section.id)}
                                className="rounded-full border border-brand-border bg-brand-surface px-3 py-1.5 text-xs font-semibold text-brand-text hover:border-brand-accent hover:text-brand-accent transition-colors"
                            >
                                {section.order}. {section.title}
                            </button>
                        ))}
                    </nav>
                )}
            </section>

            {/* Pilares */}
            <div className="space-y-5">
                {sections.length === 0 && (
                    <p className="rounded-2xl border border-dashed border-brand-border p-8 text-center text-sm text-brand-muted">
                        Nada encontrado para “{query}”. Tente outra palavra ou use o botão Ajuda.
                    </p>
                )}
                {sections.map(section => {
                    const Icon = ICONS[section.icon];
                    return (
                        <article
                            key={section.id}
                            id={`pilar-${section.id}`}
                            className="scroll-mt-24 rounded-3xl border border-brand-border bg-brand-surface p-5 md:p-7 shadow-sm"
                        >
                            <div className="flex items-start gap-4">
                                <div className="shrink-0 w-12 h-12 rounded-2xl bg-brand-accent text-white flex items-center justify-center shadow-md">
                                    <Icon size={22} />
                                </div>
                                <div className="min-w-0">
                                    <p className="text-[11px] font-bold uppercase tracking-widest text-brand-muted">Pilar {section.order}</p>
                                    <h2 className="text-xl md:text-2xl font-black text-brand-text">{section.title}</h2>
                                    <p className="mt-1 text-sm md:text-base font-semibold text-[#E31B23]">{section.headline}</p>
                                </div>
                            </div>

                            <ul className="mt-5 space-y-3">
                                {section.points.map((point, index) => {
                                    const tone = TONE[point.tone ?? 'tip'];
                                    const ToneIcon = tone.icon;
                                    return (
                                        <li key={index} className="flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-3">
                                            <span className={`inline-flex shrink-0 items-center gap-1 self-start rounded-lg border px-2 py-1 text-[10px] font-bold uppercase tracking-wide ${tone.className}`}>
                                                <ToneIcon size={12} /> {tone.label}
                                            </span>
                                            <span className="text-sm leading-relaxed text-brand-text">{point.text}</span>
                                        </li>
                                    );
                                })}
                            </ul>

                            {section.links && section.links.length > 0 && (
                                <div className="mt-5 flex flex-wrap gap-2 border-t border-brand-border pt-4">
                                    {section.links.map(link => (
                                        <button
                                            key={link.tab}
                                            type="button"
                                            onClick={() => onNavigate(link.tab)}
                                            className="inline-flex items-center gap-1.5 rounded-xl bg-brand-surface-2 px-3 py-2 text-xs font-bold text-brand-accent hover:bg-brand-accent hover:text-white transition-colors"
                                        >
                                            {link.label} <ArrowRight size={14} />
                                        </button>
                                    ))}
                                </div>
                            )}
                        </article>
                    );
                })}
            </div>

            {/* Confirmação */}
            {!searching && (
                <section className="rounded-3xl border-2 border-brand-accent/30 bg-brand-surface-2 p-6 md:p-8">
                    {acknowledged === true ? (
                        <div className="flex items-center gap-4">
                            <CheckCircle2 size={40} className="shrink-0 text-emerald-600" />
                            <div>
                                <h2 className="text-xl font-black text-brand-text">Você concluiu o treinamento</h2>
                                <p className="text-sm text-brand-muted">
                                    O manual continua aqui para consulta. Mudou alguma regra? A escola atualiza e avisa.
                                </p>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            <h2 className="text-xl font-black text-brand-text">Confirme que leu o manual</h2>
                            <label className="flex items-start gap-3 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={agreed}
                                    onChange={(event) => setAgreed(event.target.checked)}
                                    className="mt-1 h-5 w-5 rounded accent-[#1A2690]"
                                />
                                <span className="text-sm text-brand-text leading-relaxed">
                                    Li e entendi os {TEACHER_HANDBOOK_SECTIONS.length} pilares: uso só o material e a plataforma da escola,
                                    não faço cobrança ao aluno, aviso ausências com no mínimo 24 horas, cumpro as 4 reposições,
                                    uso o Guia Gramatical nas experimentais e sigo o Teacher Exchange.
                                </span>
                            </label>
                            <button
                                type="button"
                                disabled={!agreed || saving}
                                onClick={confirm}
                                className="inline-flex items-center gap-2 rounded-xl bg-brand-accent px-6 py-3 text-sm font-bold text-white shadow-lg hover:bg-brand-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                            >
                                <BadgeCheck size={18} /> {saving ? 'Registrando…' : 'Concluí o treinamento'}
                            </button>
                            {saveError && (
                                <p className="text-sm font-semibold text-red-600">
                                    Não foi possível registrar agora. Verifique a conexão e tente de novo.
                                </p>
                            )}
                        </div>
                    )}
                </section>
            )}
        </div>
    );
};

export default TeacherHandbook;
