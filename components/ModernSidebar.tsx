import React, { useState } from 'react';
import {
    LayoutDashboard,
    BookOpen,
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
    School
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
}

interface MenuItem {
    id: string;
    label: string;
    icon: React.ElementType;
    badge?: number;
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
    toggleTheme
}) => {

    const teacherMenu: MenuItem[] = [
        { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
        { id: 'lessons', label: 'Lançar Aula', icon: BookOpen },
        { id: 'pending', label: 'Pendentes', icon: AlertCircle, badge: pendingLessonsCount },
        { id: 'meeting_links', label: 'Links de Aula', icon: Video },
        { id: 'students', label: 'Alunos', icon: Users },
        { id: 'lesson-planner-ai', label: 'Planner IA', icon: Sparkles },
        { id: 'schedule', label: 'Agenda', icon: Calendar },
        { id: 'invoices', label: 'Notas Fiscais', icon: FileText },
        { id: 'teacher-financials', label: 'Financeiro', icon: DollarSign },
        { id: 'reschedules', label: 'Reposições', icon: Repeat },
        { id: 'pedagogical', label: 'Pedagógico', icon: Book },
        { id: 'automation', label: 'Smart', icon: Zap },
    ];

    const studentMenu: MenuItem[] = [
        { id: 'dashboard', label: 'Meu Portal', icon: LayoutDashboard },
        { id: 'schedule', label: 'Aulas', icon: Calendar },
        { id: 'meeting_links', label: 'Links', icon: Video },
        { id: 'materials', label: 'Materiais', icon: Book },
        { id: 'financial', label: 'Financeiro', icon: CreditCard },
        { id: 'evolution', label: 'Evolução', icon: Sparkles },
    ];

    const schoolAdminMenu: MenuItem[] = [
        { id: 'dashboard', label: 'Dashboard', icon: Activity },
        { id: 'teachers', label: 'Professores', icon: Users },
        { id: 'students', label: 'Alunos', icon: GraduationCap },
        { id: 'schedule_explorer', label: 'Mapa Aulas', icon: CalendarClock },
        { id: 'approvals', label: 'Acolhimento', icon: CheckCircle },
        { id: 'payments', label: 'Pagamentos', icon: DollarSign },
        { id: 'financial', label: 'Caixa', icon: Wallet },
        { id: 'pedagogical', label: 'Pedagógico', icon: Book },
        { id: 'automation', label: 'Smart', icon: Zap },
        { id: 'settings_school', label: 'Branding', icon: Palette },
        { id: 'marketing', label: 'Site & Vendas', icon: Globe },
    ];

    const superAdminMenu: MenuItem[] = [
        { id: 'dashboard', label: 'Visão Global', icon: Shield },
        { id: 'tenants', label: 'Tenants', icon: Globe },
        { id: 'billing', label: 'Faturamento', icon: DollarSign },
        { id: 'settings', label: 'Infra', icon: Settings },
        { id: 'automation', label: 'Smart', icon: Zap },
    ];

    const getMenuItems = () => {
        if (user.role === UserRole.SUPER_ADMIN) return superAdminMenu;
        if (user.role === UserRole.SCHOOL_ADMIN) return schoolAdminMenu;
        if (user.role === UserRole.STUDENT) return studentMenu;
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
          transition-all duration-300 ease-in-out bg-white dark:bg-gray-900 border-r border-transparent
          ${isOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
          ${open ? 'w-64' : 'w-20'} 
          p-3 flex flex-col shadow-[4px_0_24px_rgba(0,0,0,0.02)]
        `}
            >
                <div className="mb-6 pb-4">
                    <div className={`flex items-center ${open ? 'justify-between px-2' : 'justify-center'} rounded-xl py-2 transition-colors hover:bg-slate-50 dark:hover:bg-gray-800`}>
                        <div className="flex items-center gap-3">
                            <div className="grid size-10 shrink-0 place-content-center rounded-xl bg-gradient-to-br from-purple-600 to-blue-600 shadow-lg shadow-purple-500/20 text-white">
                                {user.role === UserRole.SUPER_ADMIN ? <Shield size={20} /> : (
                                    tenant.branding.logoUrl ?
                                        <img src={tenant.branding.logoUrl} alt="Logo" className="w-8 h-8 object-contain" /> :
                                        <School size={20} />
                                )}
                            </div>

                            {open && (
                                <div className="overflow-hidden">
                                    <h3 className="block text-sm font-bold text-gray-900 dark:text-gray-100 truncate max-w-[120px]">
                                        {user.role === UserRole.SUPER_ADMIN ? 'EduCore SaaS' : tenant.name}
                                    </h3>
                                    <span className="block text-xs text-gray-500 dark:text-gray-400 truncate font-medium">
                                        {user.role.replace('_', ' ').toLowerCase()}
                                    </span>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                <div className="space-y-1 mb-8 flex-1 overflow-y-auto scrollbar-hide">
                    {menuItems.map((item) => (
                        <Option
                            key={item.id}
                            Icon={item.icon}
                            title={item.label}
                            selected={activeTab}
                            itemId={item.id}
                            setSelected={(id: string) => {
                                setActiveTab(id);
                                if (window.innerWidth < 1024) setIsOpen(false);
                            }}
                            open={open}
                            notifs={item.badge}
                        />
                    ))}
                </div>

                <div className="border-t border-slate-100 dark:border-gray-800 pt-4 space-y-1 mb-12">
                    {open && (
                        <div className="px-3 py-2 text-xs font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wide">
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
                        className={`relative flex h-11 w-full items-center rounded-xl transition-all duration-200 text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/10`}
                    >
                        <div className="grid h-full w-12 place-content-center">
                            <LogOut className="h-5 w-5" />
                        </div>
                        {open && <span className="text-sm font-bold">Sair</span>}
                    </button>
                </div>

                <button
                    onClick={() => setIsCollapsed(!isCollapsed)}
                    className="hidden lg:flex absolute bottom-0 left-0 right-0 border-t border-slate-100 dark:border-gray-800 transition-colors hover:bg-slate-50 dark:hover:bg-gray-800 items-center p-4"
                >
                    <div className="grid size-10 place-content-center">
                        <ChevronsRight
                            className={`h-5 w-5 transition-transform duration-300 text-slate-400 dark:text-gray-500 ${!open ? "rotate-180" : ""
                                }`}
                        />
                    </div>
                    {open && (
                        <span className="text-sm font-bold text-slate-500 dark:text-gray-400 ml-2">
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
            className={`relative flex h-11 w-full items-center rounded-xl transition-all duration-200 group mb-1 ${isSelected
                ? "bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 shadow-sm"
                : "text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-200"
                }`}
            title={!open ? title : ''}
        >
            <div className="grid h-full w-12 place-content-center relative">
                <Icon className={`h-5 w-5 transition-transform ${isSelected ? 'scale-110' : 'group-hover:scale-110'}`} strokeWidth={isSelected ? 2.5 : 2} />
                {!open && isSelected && (
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 w-1.5 h-1.5 bg-purple-600 rounded-full" />
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
                <span className={`${open ? 'absolute right-3' : 'absolute top-1 right-2'} flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-[10px] text-white font-bold shadow-md ring-2 ring-white dark:ring-slate-900`}>
                    {notifs}
                </span>
            )}
        </button>
    );
};

export default ModernSidebar;
