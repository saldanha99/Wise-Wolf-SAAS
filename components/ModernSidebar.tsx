import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bot,
    Mic,
    LayoutDashboard,
    BookOpen,
    Target,
    Repeat,
    AlertCircle,
    Users,
    Calendar,
    FileText,
    DollarSign,
    Shield,
    Globe,
    Settings,
    LogOut,
    ChevronDown,
    ChevronsRight,
    CreditCard,
    Sparkles,
    Book,
    Activity,
    Video,
    GraduationCap,
    Zap,
    CalendarClock,
    Wallet,
    CheckCircle,
    Palette,
    Bell,
    HelpCircle,
    Search,
    School,
    Brain, // Added
    Briefcase,
    Gift,
    UserPlus,
    TrendingUp,
    ShieldAlert,
    X
} from 'lucide-react';
import {
    Tenant,
    TenantMembershipOption,
    User as UserType,
    UserRole,
} from '../types';

interface ModernSidebarProps {
    tenant: Tenant;
    user: UserType;
    activeTab: string;
    setActiveTab: (tab: string) => void;
    pendingLessonsCount: number;
    onLogout: () => void;
    isOpen: boolean; // Mobile open state
    setIsOpen: (open: boolean) => void; // Mobile set open
    isCollapsed: boolean; // Desktop collapsed state
    setIsCollapsed: (collapsed: boolean) => void; // Desktop set collapsed
    theme: 'light' | 'dark';
    toggleTheme: () => void;
    pendingCounts?: Record<string, number>; // contadores de pendência por área (badges)
    tenantMemberships?: TenantMembershipOption[];
    onTenantSwitch?: (tenantId: string) => Promise<void>;
}

interface MenuItem {
    id: string;
    label: string;
    icon: React.ElementType;
    badge?: number | string;
    section?: string;        // grupo do menu (ex: "Pessoas", "Financeiro")
    badgeKey?: string;       // chave em pendingCounts que vira badge (ex: "acolhimento")
}

const ModernSidebar: React.FC<ModernSidebarProps> = ({
    tenant,
    user,
    activeTab,
    setActiveTab,
    pendingLessonsCount,
    onLogout,
    isOpen,
    setIsOpen,
    isCollapsed,
    setIsCollapsed,
    theme,
    toggleTheme,
    pendingCounts = {},
    tenantMemberships = [],
    onTenantSwitch,
}) => {
    const [isMobile, setIsMobile] = useState(() =>
        typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches
    );
    const navRef = useRef<HTMLElement>(null);
    const menuScrollRef = useRef<HTMLDivElement>(null);
    const returnFocusRef = useRef<HTMLElement | null>(null);
    const tenantMenuRef = useRef<HTMLDivElement>(null);
    const [tenantMenuOpen, setTenantMenuOpen] = useState(false);
    const [switchingTenantId, setSwitchingTenantId] = useState<string | null>(null);

    const getMenuButtons = useCallback((): HTMLElement[] => {
        const scroller = menuScrollRef.current;
        if (!scroller) return [];

        return Array.from(
            scroller.querySelectorAll<HTMLElement>('[data-sidebar-menu-item="true"]')
        );
    }, []);

    const ensureMenuItemVisible = useCallback((item: HTMLElement | null) => {
        const scroller = menuScrollRef.current;
        if (!scroller || !item || !scroller.contains(item)) return;

        const scrollerRect = scroller.getBoundingClientRect();
        const itemRect = item.getBoundingClientRect();
        const scrollPadding = 8;

        if (itemRect.top < scrollerRect.top + scrollPadding) {
            scroller.scrollTop += itemRect.top - scrollerRect.top - scrollPadding;
        } else if (itemRect.bottom > scrollerRect.bottom - scrollPadding) {
            scroller.scrollTop += itemRect.bottom - scrollerRect.bottom + scrollPadding;
        }
    }, []);

    useEffect(() => {
        const media = window.matchMedia('(max-width: 1023px)');
        const handleChange = (event: MediaQueryListEvent) => setIsMobile(event.matches);

        setIsMobile(media.matches);
        media.addEventListener('change', handleChange);
        return () => media.removeEventListener('change', handleChange);
    }, []);

    useEffect(() => {
        if (!isMobile || !isOpen) return;

        returnFocusRef.current = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;

        const previousBodyOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';

        const focusFrame = window.requestAnimationFrame(() => {
            const activeItem = navRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
            const firstItem = getMenuButtons()[0];
            const target = activeItem || firstItem;
            ensureMenuItemVisible(target ?? null);
            target?.focus();
        });

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                setIsOpen(false);
                return;
            }

            if (event.key !== 'Tab' || !navRef.current) return;

            const focusable = (Array.from(
                navRef.current.querySelectorAll<HTMLElement>('[data-sidebar-focusable="true"]:not([disabled])')
            ) as HTMLElement[]).filter((element) => element.getClientRects().length > 0);
            if (focusable.length === 0) return;

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
            document.body.style.overflow = previousBodyOverflow;
            window.requestAnimationFrame(() => returnFocusRef.current?.focus());
        };
    }, [ensureMenuItemVisible, getMenuButtons, isMobile, isOpen, setIsOpen]);

    useEffect(() => {
        if (!tenantMenuOpen) return;
        const closeOnOutsideClick = (event: MouseEvent) => {
            if (
                tenantMenuRef.current &&
                event.target instanceof Node &&
                !tenantMenuRef.current.contains(event.target)
            ) {
                setTenantMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', closeOnOutsideClick);
        return () => document.removeEventListener('mousedown', closeOnOutsideClick);
    }, [tenantMenuOpen]);

    const teacherMenu: MenuItem[] = [
        { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
        { id: 'lessons', label: 'Lançar Aula', icon: BookOpen },
        { id: 'pending', label: 'Pendentes', icon: AlertCircle, badge: pendingLessonsCount },
        { id: 'meeting_links', label: 'Links de Aula', icon: Video },
        { id: 'students', label: 'Alunos', icon: Users },
        { id: 'lesson-planner-ai', label: 'Planner IA', icon: Sparkles },
        { id: 'wolfie-lab', label: 'Wolfie Lab', icon: Brain }, // Added
        { id: 'class_skills', label: 'Skills da Turma', icon: Activity },
        { id: 'msg_settings', label: 'Mensagens', icon: Bell },
        { id: 'teacher_workflows', label: 'Saída / Ausência', icon: AlertCircle },
        { id: 'schedule', label: 'Agenda', icon: Calendar },
        { id: 'invoices', label: 'Notas Fiscais', icon: FileText },
        { id: 'teacher-financials', label: 'Financeiro', icon: DollarSign },
        { id: 'reschedules', label: 'Reposições', icon: Repeat },
        { id: 'pedagogical', label: 'Pedagógico', icon: Book },
        { id: 'training', label: 'Treinamentos', icon: GraduationCap },
        { id: 'oral-tests', label: 'Testes Orais', icon: Mic },
        { id: 'automation', label: 'Smart', icon: Zap },
        { id: 'referral', label: 'Indicações', icon: Gift },
        { id: 'contract_teacher', label: 'Meu Contrato', icon: FileText },
    ];

    const studentMenu: MenuItem[] = [
        { id: 'dashboard', label: 'Meu Portal', icon: LayoutDashboard },
        // Nomes explícitos: "Wolfie Tutor" x "Praticar" não diziam ao aluno qual
        // era a prática livre e qual era a trilha do professor.
        { id: 'ai-tutor', label: 'Praticar com o Wolfie', icon: Sparkles, badge: 'NOVO' as any },
        { id: 'practice', label: 'Minhas Trilhas', icon: Target },
        { id: 'schedule', label: 'Aulas', icon: Calendar },
        { id: 'meeting_links', label: 'Links', icon: Video },
        { id: 'materials', label: 'Materiais', icon: Book },
        { id: 'financial', label: 'Financeiro', icon: CreditCard },
        { id: 'evolution', label: 'Evolução', icon: Sparkles },
        { id: 'training', label: 'Treinamentos', icon: GraduationCap },
        { id: 'referral', label: 'Indicações', icon: Gift },
    ];

    const schoolAdminMenu: MenuItem[] = [
        // ── Visão geral ──
        { id: 'dashboard', label: 'Início', icon: LayoutDashboard, section: 'Visão geral' },
        { id: 'wolfie-lab', label: 'Wolfie Lab', icon: Brain, section: 'Visão geral' },
        // ── Pessoas ──
        { id: 'students', label: 'Alunos', icon: GraduationCap, section: 'Pessoas' },
        { id: 'student-insights', label: 'Painel de Alunos', icon: TrendingUp, section: 'Pessoas' },
        { id: 'teachers', label: 'Professores', icon: Users, section: 'Pessoas' },
        { id: 'teacher-insights', label: 'Gestão de Profs', icon: ShieldAlert, section: 'Pessoas' },
        { id: 'approvals', label: 'Acolhimento (Docs)', icon: CheckCircle, section: 'Pessoas', badgeKey: 'acolhimento' },
        { id: 'recruiting', label: 'Recrutamento', icon: UserPlus, section: 'Pessoas' },
        { id: 'hr', label: 'Recursos Humanos', icon: Briefcase, section: 'Pessoas' },
        // ── Aulas ──
        { id: 'schedule_explorer', label: 'Mapa de Aulas', icon: CalendarClock, section: 'Aulas' },
        { id: 'attendance-disputes', label: 'Verificar Presença', icon: ShieldAlert, section: 'Aulas', badgeKey: 'presenca' },
        { id: 'trials', label: 'Agendar Experimental', icon: Zap, section: 'Aulas' },
        { id: 'trial-settlement', label: 'Pagar Exp./Treino', icon: CheckCircle, section: 'Aulas', badgeKey: 'trials' },
        { id: 'oral-tests', label: 'Testes Orais', icon: Mic, section: 'Aulas' },
        // ── Pedagógico ──
        { id: 'pedagogical', label: 'Biblioteca', icon: Book, section: 'Pedagógico' },
        { id: 'material-approvals', label: 'Aprovar Materiais', icon: FileText, section: 'Pedagógico', badgeKey: 'materiais' },
        { id: 'learning_paths_builder', label: 'Trilhas', icon: Target, section: 'Pedagógico' },
        { id: 'class_skills', label: 'Skills da Turma', icon: Activity, section: 'Pedagógico' },
        { id: 'training', label: 'Treinamentos', icon: GraduationCap, section: 'Pedagógico' },
        // ── Financeiro ──
        { id: 'student-payments', label: 'Mensalidades (Alunos)', icon: CreditCard, section: 'Financeiro' },
        { id: 'payments', label: 'Repasse a Profs', icon: DollarSign, section: 'Financeiro' },
        { id: 'cashflow', label: 'Fluxo de Caixa', icon: Wallet, section: 'Financeiro' },
        { id: 'margin', label: 'Custo e Margem', icon: TrendingUp, section: 'Financeiro' },
        { id: 'ai-costs', label: 'Custo de IA', icon: Bot },
        { id: 'verify-rooms', label: 'Verificar Salas', icon: Video, section: 'Aulas' },
        { id: 'financial', label: 'Lançamentos do Caixa', icon: Wallet, section: 'Financeiro' },
        // ── Crescimento ──
        { id: 'crm', label: 'CRM & Funil', icon: Users, section: 'Crescimento' },
        { id: 'marketing', label: 'Site & Vendas', icon: Globe, section: 'Crescimento' },
        { id: 'referral-admin', label: 'Indicações', icon: Gift, section: 'Crescimento' },
        { id: 'vendors-mgmt', label: 'Vendedores', icon: TrendingUp, section: 'Crescimento' },
        // ── Configurações ──
        { id: 'contracts', label: 'Contratos', icon: FileText, section: 'Configurações' },
        { id: 'settings_school', label: 'Branding', icon: Palette, section: 'Configurações' },
        { id: 'automation', label: 'WhatsApp (Conexão)', icon: Zap, section: 'Configurações' },
        { id: 'automations', label: 'Disparos WhatsApp', icon: Bell, section: 'Configurações' },
        { id: 'tenant_advanced', label: 'Config. Avançada', icon: Settings, section: 'Configurações' },
        { id: 'admin_workflows', label: 'Workflows', icon: Repeat, section: 'Configurações' },
    ];

    const superAdminMenu: MenuItem[] = [
        { id: 'dashboard', label: 'Visão Global', icon: Shield },
        { id: 'tenants', label: 'Tenants', icon: Globe },
        { id: 'billing', label: 'Faturamento', icon: DollarSign },
        { id: 'settings', label: 'Infra', icon: Settings },
        { id: 'automation', label: 'Smart', icon: Zap },
    ];

    const salespersonMenu: MenuItem[] = [
        { id: 'vendor_dashboard', label: 'Dashboard', icon: TrendingUp },
        { id: 'vendor_schedule', label: 'Agenda Professores', icon: CalendarClock },
        { id: 'vendor_trial', label: 'Link Experimental', icon: Zap },
        { id: 'vendor_enrollment', label: 'Gerar Matrícula', icon: UserPlus },
        { id: 'vendor_commissions', label: 'Minhas Comissões', icon: DollarSign },
    ];

    const getMenuItems = () => {
        if (user.role === UserRole.SUPER_ADMIN) return superAdminMenu;
        if (user.role === UserRole.SCHOOL_ADMIN) return schoolAdminMenu;
        if (user.role === UserRole.STUDENT) return studentMenu;
        if (user.role === UserRole.SALESPERSON) return salespersonMenu;
        return teacherMenu;
    };

    const menuItems = getMenuItems();
    const expanded = isMobile || !isCollapsed;
    const drawerHidden = isMobile && !isOpen;

    useEffect(() => {
        if (drawerHidden) return;

        const focusFrame = window.requestAnimationFrame(() => {
            const activeItem = getMenuButtons().find(
                (item) => item.dataset.sidebarItemId === activeTab
            );
            ensureMenuItemVisible(activeItem ?? null);
        });

        return () => window.cancelAnimationFrame(focusFrame);
    }, [activeTab, drawerHidden, ensureMenuItemVisible, expanded, getMenuButtons]);

    const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;

        const currentItem = event.target instanceof HTMLElement
            ? event.target.closest<HTMLElement>('[data-sidebar-menu-item="true"]')
            : null;
        if (!currentItem) return;

        const items = getMenuButtons().filter((item) => item.getClientRects().length > 0);
        const currentIndex = items.indexOf(currentItem);
        if (currentIndex < 0 || items.length === 0) return;

        event.preventDefault();

        const nextIndex = event.key === 'Home'
            ? 0
            : event.key === 'End'
                ? items.length - 1
                : event.key === 'ArrowDown'
                    ? Math.min(currentIndex + 1, items.length - 1)
                    : Math.max(currentIndex - 1, 0);
        const nextItem = items[nextIndex];
        ensureMenuItemVisible(nextItem);
        nextItem.focus();
    };

    return (
        <>
            <div
                aria-hidden="true"
                className={`fixed inset-0 z-[90] bg-black/60 lg:hidden transition-opacity ${isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                onClick={() => setIsOpen(false)}
            />

            <nav
                ref={navRef}
                id="app-primary-navigation"
                aria-label="Navegação principal"
                aria-hidden={drawerHidden || undefined}
                inert={drawerHidden || undefined}
                className={`
          fixed inset-y-0 left-0 lg:sticky lg:top-0 lg:left-auto z-[100] h-dvh min-h-0 shrink-0
          transition-all duration-300 ease-in-out bg-brand-surface border-r border-brand-border
          ${isOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
          ${expanded ? 'w-64' : 'w-20'}
          p-3 grid grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden shadow-[4px_0_24px_rgba(0,0,0,0.2)]
        `}
            >
                <div ref={tenantMenuRef} className="relative flex-none mb-3 pb-3">
                    <button
                        type="button"
                        onClick={() => {
                            if (expanded && tenantMemberships.length > 1) {
                                setTenantMenuOpen((open) => !open);
                            }
                        }}
                        className={`flex w-full items-center ${expanded ? 'justify-start px-2' : 'justify-center'} rounded-xl py-2 text-left transition-colors hover:bg-brand-surface-2`}
                        aria-label={tenantMemberships.length > 1 ? 'Selecionar instituição' : tenant.name}
                        aria-haspopup={tenantMemberships.length > 1 ? 'listbox' : undefined}
                        aria-expanded={tenantMemberships.length > 1 ? tenantMenuOpen : undefined}
                        data-sidebar-focusable="true"
                    >
                        <div className="flex items-center gap-3 w-full">
                            {user.role === UserRole.SUPER_ADMIN ? (
                                <div className="grid size-10 shrink-0 place-content-center rounded-xl bg-gradient-to-br from-brand-accent to-brand-accent-hover shadow-lg text-white">
                                    <Shield size={20} aria-hidden="true" />
                                </div>
                            ) : tenant.branding?.logoUrl ? (
                                <img
                                    src={tenant.branding.logoUrl}
                                    alt={tenant.name}
                                    className={`object-contain transition-all duration-300 ${expanded ? 'h-14 max-w-[180px]' : 'h-8 w-8'} rounded-md`}
                                />
                            ) : (
                                <div className="grid size-10 shrink-0 place-content-center rounded-xl bg-gradient-to-br from-brand-accent to-brand-accent-hover shadow-lg text-white">
                                    <School size={20} aria-hidden="true" />
                                </div>
                            )}

                            {expanded && (
                                <div className={`overflow-hidden flex-1 ${tenant.branding?.logoUrl && user.role !== UserRole.SUPER_ADMIN ? 'hidden' : ''}`}>
                                    <h3 className="block text-sm font-bold text-brand-text truncate max-w-[120px]">
                                        {user.role === UserRole.SUPER_ADMIN ? 'EduCore SaaS' : tenant.name}
                                    </h3>
                                    <span className="block text-[10px] uppercase font-black tracking-widest text-brand-muted truncate">
                                        {tenantMemberships.length > 1 ? 'Trocar instituição' : user.role.replace('_', ' ')}
                                    </span>
                                </div>
                            )}

                            {expanded && tenantMemberships.length > 1 && (
                                <ChevronDown
                                    size={17}
                                    aria-hidden="true"
                                    className={`ml-auto shrink-0 text-brand-muted transition-transform ${tenantMenuOpen ? 'rotate-180' : ''}`}
                                />
                            )}
                        </div>
                    </button>

                    {isMobile && (
                        <button
                            type="button"
                            onClick={() => setIsOpen(false)}
                            className="absolute right-0 top-2 grid size-10 shrink-0 place-content-center rounded-xl text-brand-muted hover:bg-brand-surface-2 hover:text-brand-text"
                            aria-label="Fechar menu"
                            data-sidebar-focusable="true"
                        >
                            <X size={20} aria-hidden="true" />
                        </button>
                    )}

                    {expanded && tenantMenuOpen && tenantMemberships.length > 1 && (
                        <div
                            role="listbox"
                            aria-label="Instituições disponíveis"
                            className="absolute left-0 right-0 top-full z-50 mt-1 rounded-2xl border border-brand-border bg-brand-surface p-2 shadow-2xl"
                        >
                            <div className="px-2 pb-2 pt-1 text-[9px] font-black uppercase tracking-[0.18em] text-brand-muted">
                                Seu ambiente
                            </div>
                            <div className="max-h-60 space-y-1 overflow-y-auto">
                                {tenantMemberships.map((membership) => (
                                    <button
                                        key={membership.tenant_id}
                                        type="button"
                                        role="option"
                                        aria-selected={membership.is_active}
                                        disabled={membership.is_active || Boolean(switchingTenantId)}
                                        onClick={async () => {
                                            if (!onTenantSwitch || membership.is_active) return;
                                            setSwitchingTenantId(membership.tenant_id);
                                            try {
                                                await onTenantSwitch(membership.tenant_id);
                                                setTenantMenuOpen(false);
                                                if (isMobile) setIsOpen(false);
                                            } finally {
                                                setSwitchingTenantId(null);
                                            }
                                        }}
                                        className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
                                            membership.is_active
                                                ? 'bg-brand-accent/10 text-brand-accent'
                                                : 'text-brand-text hover:bg-brand-surface-2'
                                        } disabled:cursor-default`}
                                    >
                                        <div className="grid size-9 shrink-0 place-content-center rounded-xl bg-brand-surface-2">
                                            {switchingTenantId === membership.tenant_id
                                                ? <span className="size-4 animate-spin rounded-full border-2 border-brand-muted border-t-brand-accent" />
                                                : <School size={17} aria-hidden="true" />}
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <span className="block truncate text-xs font-black">
                                                {membership.tenant_name}
                                            </span>
                                            <span className="block truncate text-[9px] font-bold uppercase tracking-wider text-brand-muted">
                                                {membership.role.replace('_', ' ')}
                                            </span>
                                        </div>
                                        {membership.is_active && (
                                            <CheckCircle size={16} aria-hidden="true" />
                                        )}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                <div
                    ref={menuScrollRef}
                    aria-label="Seções do sistema"
                    className="min-h-0 space-y-1 overflow-y-auto overscroll-contain scroll-py-2 pb-2 pr-1 [scrollbar-gutter:stable]"
                    data-sidebar-scroll-region="true"
                    onKeyDown={handleMenuKeyDown}
                >
                    {menuItems.map((item, idx) => {
                        // Cabeçalho de seção: aparece quando a seção muda (só em menus agrupados)
                        const prevSection = idx > 0 ? menuItems[idx - 1].section : undefined;
                        const showHeader = !!item.section && item.section !== prevSection;
                        // Badge: número fixo OU contador de pendência via badgeKey
                        const badge = item.badge ?? (item.badgeKey ? pendingCounts[item.badgeKey] : undefined);
                        return (
                            <React.Fragment key={item.id}>
                                {showHeader && expanded && (
                                    <div className="px-3 pt-4 pb-1 text-[10px] font-black text-brand-muted uppercase tracking-widest">
                                        {item.section}
                                    </div>
                                )}
                                {showHeader && !expanded && idx > 0 && (
                                    <div className="my-2 mx-3 border-t border-brand-border" />
                                )}
                                <Option
                                    Icon={item.icon}
                                    title={item.label}
                                    selected={activeTab}
                                    itemId={item.id}
                                    setSelected={(id: string) => {
                                        setActiveTab(id);
                                        if (window.innerWidth < 1024) setIsOpen(false);
                                    }}
                                    open={expanded}
                                    notifs={badge}
                                    onFocus={ensureMenuItemVisible}
                                />
                            </React.Fragment>
                        );
                    })}
                </div>

                <div
                    className="relative z-10 mt-3 border-t border-brand-border bg-brand-surface pt-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] lg:pb-0"
                    data-sidebar-footer="true"
                >
                    <div className="space-y-1">
                        {expanded && (
                            <div className="px-3 py-2 text-[10px] font-black text-brand-muted uppercase tracking-widest">
                                Conta
                            </div>
                        )}
                        <Option
                            Icon={Settings}
                            title="Meu Perfil"
                            selected={activeTab}
                            itemId={'profile'}
                            setSelected={(id: string) => {
                                setActiveTab(id);
                                if (window.innerWidth < 1024) setIsOpen(false);
                            }}
                            open={expanded}
                        />
                        <button
                            type="button"
                            onClick={onLogout}
                            className="relative flex h-11 w-full items-center rounded-xl transition-all duration-200 text-red-500 hover:bg-red-500/10"
                            aria-label="Sair"
                            title={!expanded ? 'Sair' : undefined}
                            data-sidebar-focusable="true"
                        >
                            <div className="grid h-full w-12 place-content-center">
                                <LogOut className="h-5 w-5" aria-hidden="true" />
                            </div>
                            {expanded && <span className="text-sm font-bold">Sair</span>}
                        </button>
                    </div>

                    <button
                        type="button"
                        onClick={() => setIsCollapsed(!isCollapsed)}
                        className="hidden lg:flex mt-2 w-full border-t border-brand-border transition-colors hover:bg-brand-surface-2 items-center rounded-b-xl px-1 py-2"
                        aria-label={expanded ? 'Recolher menu' : 'Expandir menu'}
                        aria-expanded={expanded}
                        title={!expanded ? 'Expandir menu' : undefined}
                        data-sidebar-focusable="true"
                    >
                        <div className="grid size-10 place-content-center">
                            <ChevronsRight
                                aria-hidden="true"
                                className={`h-5 w-5 transition-transform duration-300 text-brand-muted ${!expanded ? "rotate-180" : ""
                                    }`}
                            />
                        </div>
                        {expanded && (
                            <span className="text-sm font-bold text-brand-muted ml-2">
                                Recolher
                            </span>
                        )}
                    </button>
                </div>
            </nav>
        </>
    );
};

interface OptionProps {
    Icon: React.ElementType;
    title: string;
    selected: string;
    setSelected: (id: string) => void;
    itemId: string;
    open: boolean;
    notifs?: number | string;
    onFocus?: (item: HTMLElement) => void;
}

const Option = ({ Icon, title, selected, setSelected, itemId, open, notifs, onFocus }: OptionProps) => {
    const isSelected = selected === itemId;
    const hasNotification = typeof notifs === 'number' ? notifs > 0 : Boolean(notifs);
    const accessibleLabel = typeof notifs === 'number' && notifs > 0
        ? `${title}, ${notifs} ${notifs === 1 ? 'pendência' : 'pendências'}`
        : typeof notifs === 'string' && notifs
            ? `${title}, ${notifs}`
            : title;

    return (
        <button
            type="button"
            onClick={() => setSelected(itemId)}
            className={`relative flex h-11 w-full items-center rounded-xl transition-all duration-200 group mb-1 border border-transparent ${isSelected
                ? "bg-brand-surface-2 border-brand-accent/30 text-brand-accent shadow-[inset_0_0_12px_rgba(var(--brand-accent),0.1)]"
                : "text-brand-muted hover:bg-brand-surface-2 hover:text-brand-text hover:border-brand-border"
                }`}
            title={!open ? title : undefined}
            aria-label={accessibleLabel}
            aria-current={isSelected ? 'page' : undefined}
            data-sidebar-focusable="true"
            data-sidebar-item-id={itemId}
            data-sidebar-menu-item={itemId === 'profile' ? undefined : 'true'}
            onFocus={(event) => onFocus?.(event.currentTarget)}
        >
            <div className="grid h-full w-12 place-content-center relative">
                <Icon
                    aria-hidden="true"
                    className={`h-5 w-5 transition-transform ${isSelected ? 'scale-110' : 'group-hover:scale-110'}`}
                    strokeWidth={isSelected ? 2.5 : 2}
                />
                {!open && isSelected && (
                    <div
                        aria-hidden="true"
                        className="absolute right-2 top-1/2 -translate-y-1/2 w-1.5 h-1.5 bg-brand-accent rounded-full shadow-[0_0_8px_rgba(var(--brand-accent),1)]"
                    />
                )}
            </div>

            {open && (
                <span
                    className={`text-sm font-bold transition-opacity duration-200 truncate ${open ? 'opacity-100' : 'opacity-0'
                        }`}
                >
                    {title}
                </span>
            )}

            {hasNotification && (
                <span
                    aria-hidden="true"
                    className={`${open ? 'absolute right-3' : 'absolute top-1 right-2'} flex min-h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] text-white font-bold shadow-[0_0_10px_rgba(239,68,68,0.5)] border border-red-400`}
                >
                    {notifs}
                </span>
            )}
        </button>
    );
};

export default ModernSidebar;
