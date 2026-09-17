import React, { useEffect, useMemo, useState } from 'react';
import {
    AlertTriangle,
    ChevronDown,
    ExternalLink,
    LifeBuoy,
    MessageCircle,
    Search,
    Sparkles,
    X,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import {
    searchTeacherSupportGuides,
    TEACHER_SUPPORT_GUIDES,
    whatsappLink,
    type TeacherSupportAction,
    type TeacherSupportGuide,
} from '../lib/teacherSupportGuides';

interface SupportContacts {
    school_name: string | null;
    school_whatsapp: string | null;
    coordinator_name: string | null;
    coordinator_whatsapp: string | null;
}

interface Props {
    onNavigate: (tab: string) => void;
}

/**
 * Central de Ajuda do professor — botão flutuante, sempre visível, com os
 * guias de `lib/teacherSupportGuides.ts` e atalhos que agem: "Avisar a
 * escola" abre o WhatsApp da escola com a mensagem que o bot entende.
 *
 * Os contatos vêm de `teacher_support_contacts()` (o número da instância
 * central e a coordenação do tenant); sem eles, os botões de WhatsApp somem e
 * os guias continuam valendo.
 */
const TeacherSupportCenter: React.FC<Props> = ({ onNavigate }) => {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [expanded, setExpanded] = useState<string | null>(null);
    const [contacts, setContacts] = useState<SupportContacts | null>(null);

    useEffect(() => {
        if (!open || contacts) return;
        let active = true;
        supabase.rpc('teacher_support_contacts').then(({ data }) => {
            if (active && data && typeof data === 'object') setContacts(data as SupportContacts);
        });
        return () => { active = false; };
    }, [open, contacts]);

    useEffect(() => {
        if (!open) return;
        const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open]);

    const guides = useMemo(() => searchTeacherSupportGuides(query), [query]);

    const schoolLink = (text?: string) => whatsappLink(contacts?.school_whatsapp || '', text);
    const coordinationLink = (text?: string) => whatsappLink(contacts?.coordinator_whatsapp || '', text);

    const actionHref = (action: TeacherSupportAction): string | null => {
        if (action.kind === 'whatsapp-school') return schoolLink(action.text);
        if (action.kind === 'whatsapp-coordination') return coordinationLink(action.text);
        return null;
    };

    const runNavigate = (tab: string) => {
        setOpen(false);
        onNavigate(tab);
    };

    const renderAction = (guide: TeacherSupportGuide, action: TeacherSupportAction, index: number) => {
        if (action.kind === 'navigate') {
            return (
                <button
                    key={`${guide.id}-${index}`}
                    type="button"
                    onClick={() => runNavigate(action.tab)}
                    className="px-3 py-2 rounded-lg text-xs font-bold bg-brand-accent/10 text-brand-accent hover:bg-brand-accent/20 transition-colors"
                >
                    {action.label}
                </button>
            );
        }
        const href = actionHref(action);
        if (!href) return null;
        return (
            <a
                key={`${guide.id}-${index}`}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3 py-2 rounded-lg text-xs font-bold bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 transition-colors inline-flex items-center gap-1.5"
            >
                <MessageCircle size={12} /> {action.label}
            </a>
        );
    };

    const quickAbsence = schoolLink('Não vou conseguir dar aula hoje');
    const quickCoordination = coordinationLink();

    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(v => !v)}
                data-tour="teacher-support"
                aria-label="Ajuda do professor"
                aria-expanded={open}
                className="fixed right-4 z-[70] bottom-[calc(4.75rem+env(safe-area-inset-bottom,0px))] lg:bottom-6 lg:right-6 h-12 px-4 rounded-full shadow-lg border border-brand-border bg-brand-surface text-brand-text hover:border-brand-accent/50 hover:shadow-xl transition-all flex items-center gap-2 text-sm font-bold"
            >
                <LifeBuoy size={18} className="text-brand-accent" />
                <span>Ajuda</span>
            </button>

            {open && (
                <div
                    className="fixed inset-0 z-[75] bg-black/30 lg:bg-transparent"
                    onClick={() => setOpen(false)}
                    aria-hidden="true"
                />
            )}

            {open && (
                <section
                    role="dialog"
                    aria-label="Central de Ajuda do professor"
                    className="fixed z-[76] inset-x-0 bottom-0 max-h-[85vh] rounded-t-2xl lg:inset-x-auto lg:right-6 lg:bottom-20 lg:w-[440px] lg:max-h-[78vh] lg:rounded-2xl bg-brand-surface border border-brand-border shadow-2xl flex flex-col overflow-hidden"
                >
                    <header className="p-4 border-b border-brand-border flex items-start gap-3">
                        <div className="w-9 h-9 rounded-xl bg-brand-accent/10 text-brand-accent flex items-center justify-center shrink-0">
                            <LifeBuoy size={18} />
                        </div>
                        <div className="flex-1 min-w-0">
                            <h2 className="text-sm font-bold text-brand-text">Central de Ajuda</h2>
                            <p className="text-xs text-brand-muted">O que fazer em cada situação — na plataforma e no WhatsApp da escola.</p>
                        </div>
                        <button
                            type="button"
                            onClick={() => setOpen(false)}
                            aria-label="Fechar"
                            className="w-8 h-8 rounded-lg text-brand-muted hover:bg-brand-surface-2 flex items-center justify-center"
                        >
                            <X size={16} />
                        </button>
                    </header>

                    <div className="p-4 space-y-4 overflow-y-auto custom-scrollbar">
                        <div className="grid grid-cols-3 gap-2">
                            <a
                                href={quickAbsence || undefined}
                                target="_blank"
                                rel="noopener noreferrer"
                                aria-disabled={!quickAbsence}
                                className={`rounded-xl border p-3 text-left flex flex-col gap-1.5 transition-colors ${quickAbsence
                                    ? 'border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/15'
                                    : 'border-brand-border bg-brand-surface-2 opacity-60 pointer-events-none'}`}
                            >
                                <AlertTriangle size={16} className="text-amber-500" />
                                <span className="text-[11px] font-bold text-brand-text leading-tight">Não vou dar aula</span>
                                <span className="text-[10px] text-brand-muted leading-tight">Avisar a escola pelo WhatsApp</span>
                            </a>
                            <button
                                type="button"
                                onClick={() => runNavigate('lesson-planner-ai')}
                                className="rounded-xl border border-brand-accent/30 bg-brand-accent/10 hover:bg-brand-accent/15 p-3 text-left flex flex-col gap-1.5 transition-colors"
                            >
                                <Sparkles size={16} className="text-brand-accent" />
                                <span className="text-[11px] font-bold text-brand-text leading-tight">Planejar aula</span>
                                <span className="text-[10px] text-brand-muted leading-tight">Plano de 30 min com a IA</span>
                            </button>
                            <a
                                href={quickCoordination || undefined}
                                target="_blank"
                                rel="noopener noreferrer"
                                aria-disabled={!quickCoordination}
                                className={`rounded-xl border p-3 text-left flex flex-col gap-1.5 transition-colors ${quickCoordination
                                    ? 'border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/15'
                                    : 'border-brand-border bg-brand-surface-2 opacity-60 pointer-events-none'}`}
                            >
                                <MessageCircle size={16} className="text-emerald-500" />
                                <span className="text-[11px] font-bold text-brand-text leading-tight">Coordenação</span>
                                <span className="text-[10px] text-brand-muted leading-tight">
                                    {contacts?.coordinator_name ? contacts.coordinator_name.split(' ')[0] : 'Falar no WhatsApp'}
                                </span>
                            </a>
                        </div>

                        <label className="flex items-center gap-2 rounded-xl border border-brand-border bg-brand-surface-2 px-3 py-2">
                            <Search size={14} className="text-brand-muted shrink-0" />
                            <input
                                type="search"
                                value={query}
                                onChange={e => setQuery(e.target.value)}
                                placeholder="Buscar: falta, experimental, pix, QR…"
                                className="flex-1 bg-transparent outline-none text-sm text-brand-text placeholder:text-brand-muted"
                            />
                        </label>

                        <ul className="space-y-2">
                            {guides.length === 0 && (
                                <li className="text-xs text-brand-muted p-3 text-center">
                                    Nada com essas palavras. Tente outra, ou fale com a coordenação.
                                </li>
                            )}
                            {guides.map(guide => {
                                const isOpen = expanded === guide.id || (Boolean(query) && guides.length <= 2);
                                return (
                                    <li key={guide.id} className="rounded-xl border border-brand-border bg-brand-surface-2 overflow-hidden">
                                        <button
                                            type="button"
                                            onClick={() => setExpanded(isOpen && expanded === guide.id ? null : guide.id)}
                                            aria-expanded={isOpen}
                                            className="w-full text-left p-3 flex items-start gap-2"
                                        >
                                            <div className="flex-1 min-w-0">
                                                <p className="text-sm font-bold text-brand-text leading-snug">{guide.title}</p>
                                                <p className="text-xs text-brand-muted mt-0.5">{guide.summary}</p>
                                            </div>
                                            <ChevronDown size={16} className={`text-brand-muted shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                                        </button>
                                        {isOpen && (
                                            <div className="px-3 pb-3 space-y-3">
                                                <ol className="space-y-1.5 list-decimal pl-4">
                                                    {guide.steps.map((step, index) => (
                                                        <li key={index} className="text-xs text-brand-text leading-relaxed">{step}</li>
                                                    ))}
                                                </ol>
                                                {guide.actions && guide.actions.length > 0 && (
                                                    <div className="flex flex-wrap gap-2">
                                                        {guide.actions.map((action, index) => renderAction(guide, action, index))}
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>

                        {contacts?.school_whatsapp && (
                            <p className="text-[10px] text-brand-muted text-center flex items-center justify-center gap-1">
                                <ExternalLink size={10} /> Os botões de WhatsApp abrem uma conversa com a mensagem pronta; você só confirma o envio.
                            </p>
                        )}
                    </div>
                </section>
            )}
        </>
    );
};

export default TeacherSupportCenter;
