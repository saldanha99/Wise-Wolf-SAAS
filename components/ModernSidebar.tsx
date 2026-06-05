import React, { useState } from 'react';
import {
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
    ShieldAlert
} from 'lucide-react';
import { Tenant, User as UserType, UserRole } from '../types';

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
}

interface MenuItem {
    id: string;
    label: string;
    icon: React.ElementType;
    badge?: number;
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
    pendingCounts = {}
}) => {

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
        { id: 'automation', label: 'Smart', icon: Zap },
        { id: 'referral', label: 'Indicações', icon: Gift },
        { id: 'contract_teacher', label: 'Meu Contrato', icon: FileText },
    ];

    const studentMenu: MenuItem[] = [
        { id: 'dashboard', label: 'Meu Portal', icon: LayoutDashboard },
        { id: 'ai-tutor', label: 'Wolfie Tutor', icon: Sparkles, badge: 'NOVO' as any },
        { id: 'practice', label: 'Praticar', icon: Target },
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
    const open = !isCollapsed;

    return (
        <>
            <div
                className={`fixed inset-0 z-[90] bg-black/60 lg:hidden transition-opacity ${isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                onClick={() => setIsOpen(false)}
            />

            <nav
                className={`
          fixed lg:sticky top-0 left-0 z-[100] h-screen shrink-0 
          transition-all duration-300 ease-in-out bg-brand-surface border-r border-brand-border
          ${isOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
          ${open ? 'w-64' : 'w-20'} 
          p-3 flex flex-col shadow-[4px_0_24px_rgba(0,0,0,0.2)]
        `}
            >
                <div className="mb-6 pb-4">
                    <div className={`flex items-center ${open ? 'justify-start px-2' : 'justify-center'} rounded-xl py-2 transition-colors hover:bg-brand-surface-2`}>
                        <div className="flex items-center gap-3 w-full">
                            {user.role === UserRole.SUPER_ADMIN ? (
                                <div className="grid size-10 shrink-0 place-content-center rounded-xl bg-gradient-to-br from-brand-accent to-brand-accent-hover shadow-lg text-white">
                                    <Shield size={20} />
                                </div>
                            ) : tenant.branding?.logoUrl ? (
                                <img
                                    src={tenant.branding.logoUrl}
                                    alt={tenant.name}
                                    className={`object-contain transition-all duration-300 ${open ? 'h-14 max-w-[180px]' : 'h-8 w-8'} rounded-md`}
                                />
                            ) : (
                                <div className="grid size-10 shrink-0 place-content-center rounded-xl bg-gradient-to-br from-brand-accent to-brand-accent-hover shadow-lg text-white">
                                    <School size={20} />
                                </div>
                            )}

                            {open && (
                                <div className={`overflow-hidden flex-1 ${tenant.branding?.logoUrl && user.role !== UserRole.SUPER_ADMIN ? 'hidden' : ''}`}>
                                    <h3 className="block text-sm font-bold text-brand-text truncate max-w-[120px]">
                                        {user.role === UserRole.SUPER_ADMIN ? 'EduCore SaaS' : tenant.name}
                                    </h3>
                                    <span className="block text-[10px] uppercase font-black tracking-widest text-brand-muted truncate">
                                        {user.role.replace('_', ' ')}
                                    </span>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                <div className="space-y-1 mb-8 flex-1 overflow-y-auto scrollbar-hide">
                    {menuItems.map((item, idx) => {
                        // Cabeçalho de seção: aparece quando a seção muda (só em menus agrupados)
                        const prevSection = idx > 0 ? menuItems[idx - 1].section : undefined;
                        const showHeader = !!item.section && item.section !== prevSection;
                        // Badge: número fixo OU contador de pendência via badgeKey
                        const badge = item.badge ?? (item.badgeKey ? pendingCounts[item.badgeKey] : undefined);
                        return (
                            <React.Fragment key={item.id}>
                                {showHeader && open && (
                                    <div className="px-3 pt-4 pb-1 text-[10px] font-black text-brand-muted uppercase tracking-widest">
                                        {item.section}
                                    </div>
                                )}
                                {showHeader && !open && idx > 0 && (
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
                                    open={open}
                                    notifs={badge}
                                />
                            </React.Fragment>
                        );
                    })}
                </div>

                <div className="border-t border-brand-border pt-4 space-y-1 mb-12">
                    {open && (
                        <div className="px-3 py-2 text-[10px] font-black text-brand-muted uppercase tracking-widest">
                            Conta
                        </div>
                    )}
                    <Option
                        Icon={Settings}
                        title="Meu Perfil"
                        selected={activeTab}
                        itemId={'profile'}
                        setSelected={setActiveTab}
                        open={open}
                    />
                    <button
                        onClick={onLogout}
                        className={`relative flex h-11 w-full items-center rounded-xl transition-all duration-200 text-red-500 hover:bg-red-500/10`}
                    >
                        <div className="grid h-full w-12 place-content-center">
                            <LogOut className="h-5 w-5" />
                        </div>
                        {open && <span className="text-sm font-bold">Sair</span>}
                    </button>
                </div>

                <button
                    onClick={() => setIsCollapsed(!isCollapsed)}
                    className="hidden lg:flex absolute bottom-0 left-0 right-0 border-t border-brand-border transition-colors hover:bg-brand-surface-2 items-center p-4"
                >
                    <div className="grid size-10 place-content-center">
                        <ChevronsRight
                            className={`h-5 w-5 transition-transform duration-300 text-brand-muted ${!open ? "rotate-180" : ""
                                }`}
                        />
                    </div>
                    {open && (
                        <span className="text-sm font-bold text-brand-muted ml-2">
                            Recolher
                        </span>
                    )}
                </button>
            </nav>
        </>
    );
};

const Option = ({ Icon, title, selected, setSelected, itemId, open, notifs }: any) => {
    const isSelected = selected === itemId;

    return (
        <button
            onClick={() => setSelected(itemId)}
            className={`relative flex h-11 w-full items-center rounded-xl transition-all duration-200 group mb-1 border border-transparent ${isSelected
                ? "bg-brand-surface-2 border-brand-accent/30 text-brand-accent shadow-[inset_0_0_12px_rgba(var(--brand-accent),0.1)]"
                : "text-brand-muted hover:bg-brand-surface-2 hover:text-brand-text hover:border-brand-border"
                }`}
            title={!open ? title : ''}
        >
            <div className="grid h-full w-12 place-content-center relative">
                <Icon className={`h-5 w-5 transition-transform ${isSelected ? 'scale-110' : 'group-hover:scale-110'}`} strokeWidth={isSelected ? 2.5 : 2} />
                {!open && isSelected && (
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 w-1.5 h-1.5 bg-brand-accent rounded-full shadow-[0_0_8px_rgba(var(--brand-accent),1)]" />
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

            {notifs && notifs > 0 && (
                <span className={`${open ? 'absolute right-3' : 'absolute top-1 right-2'} flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-[10px] text-white font-bold shadow-[0_0_10px_rgba(239,68,68,0.5)] border border-red-400`}>
                    {notifs}
                </span>
            )}
        </button>
    );
};

export default ModernSidebar;
