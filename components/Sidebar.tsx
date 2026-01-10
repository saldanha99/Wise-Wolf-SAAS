
import React from 'react';
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
  ChevronLeft,
  ChevronRight,
  Menu,
  X,
  CreditCard,
  Sparkles,
  Book,
  Activity,
  Video,
  GraduationCap,
  Zap,

  CalendarClock,
  Wallet,
  LucideIcon,
  CheckCircle,
  Palette,
  Sun,
  Moon
} from 'lucide-react';
import { Tenant, User as UserType, UserRole } from '../types';

interface SidebarProps {
  tenant: Tenant;
  user: UserType;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  pendingLessonsCount: number;
  onLogout: () => void;
  isOpen?: boolean;
  onClose?: () => void;
  theme: 'light' | 'dark';
  toggleTheme: () => void;
}

interface MenuItem {
  id: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
}

const Sidebar: React.FC<SidebarProps> = ({
  tenant,
  user,
  activeTab,
  setActiveTab,
  pendingLessonsCount,
  onLogout,
  isOpen,
  onClose,
  theme,
  toggleTheme
}) => {
  const teacherMenu: MenuItem[] = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'lessons', label: 'Lançar Aula', icon: BookOpen },
    { id: 'pending', label: 'Aulas Pendentes', icon: AlertCircle, badge: pendingLessonsCount },
    { id: 'meeting_links', label: 'Links de Aula', icon: Video },
    { id: 'students', label: 'Seus Alunos', icon: Users },
    { id: 'lesson-planner-ai', label: 'Plano de Aula IA', icon: Sparkles },
    { id: 'schedule', label: 'Disponibilidade', icon: Calendar },
    { id: 'invoices', label: 'Notas Fiscais', icon: FileText },
    { id: 'teacher-financials', label: 'Cofre do Professor', icon: DollarSign },
    { id: 'reschedules', label: 'Reposições', icon: Repeat },
    { id: 'pedagogical', label: 'Gestão Pedagógica', icon: Book },
  ];

  const studentMenu: MenuItem[] = [
    { id: 'dashboard', label: 'Meu Portal', icon: LayoutDashboard },
    { id: 'schedule', label: 'Minhas Aulas', icon: Calendar },
    { id: 'meeting_links', label: 'Links de Aula', icon: Video },
    { id: 'materials', label: 'Materiais Didáticos', icon: Book },
    { id: 'financial', label: 'Financeiro', icon: CreditCard },
    { id: 'automation', label: 'Automação Smart', icon: Zap },
    { id: 'evolution', label: 'Minha Evolução', icon: Sparkles },
  ];

  const schoolAdminMenu: MenuItem[] = [
    { id: 'dashboard', label: 'Dashboard Escola', icon: Activity },
    { id: 'teachers', label: 'Gestão Professores', icon: Users },
    { id: 'students', label: 'Carteira de Alunos', icon: GraduationCap },
    { id: 'schedule_explorer', label: 'Mapa de Aulas', icon: CalendarClock },
    { id: 'approvals', label: 'Acolhimento/NF', icon: CheckCircle },
    { id: 'payments', label: 'Pagamentos', icon: DollarSign },
    { id: 'financial', label: 'Financeiro Unidade', icon: Wallet },
    { id: 'pedagogical', label: 'Config. Pedagógica', icon: Book },
    { id: 'automation', label: 'Automação Smart', icon: Zap },
    { id: 'settings_school', label: 'Custom Branding', icon: Palette },
    { id: 'marketing', label: 'Site & Vendas', icon: Globe },
  ];

  const superAdminMenu: MenuItem[] = [
    { id: 'dashboard', label: 'Visão Global', icon: Shield },
    { id: 'tenants', label: 'Gestão de Tenants', icon: Globe },
    { id: 'billing', label: 'Faturamento SaaS', icon: DollarSign },
    { id: 'settings', label: 'Infra Config', icon: Settings },
  ];

  const getMenuItems = () => {
    if (user.role === UserRole.SUPER_ADMIN) return superAdminMenu;
    if (user.role === UserRole.SCHOOL_ADMIN) return schoolAdminMenu;
    if (user.role === UserRole.STUDENT) return studentMenu;
    return teacherMenu;
  };

  const menuItems = getMenuItems();

  return (
    <div className={`
      fixed inset-y-0 left-0 z-[100] w-64 bg-white dark:bg-slate-900 border-r dark:border-slate-800 flex flex-col shadow-2xl lg:shadow-none
      transition-transform duration-300 ease-in-out
      ${isOpen ? 'translate-x-0' : '-translate-x-full'}
      lg:translate-x-0
    `}>
      <div className="p-6 border-b dark:border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {user.role === UserRole.SUPER_ADMIN ? (
            <div className="w-10 h-10 bg-gray-900 dark:bg-white dark:text-slate-900 rounded-lg flex items-center justify-center text-white">
              <Shield size={20} />
            </div>
          ) : (
            <img src={tenant.branding.logoUrl} alt="Logo" className="w-10 h-10 rounded-lg object-cover bg-white p-0.5 shadow-inner" />
          )}
          <div className="overflow-hidden">
            <h1 className="font-black text-[11px] leading-tight text-gray-800 dark:text-slate-100 truncate uppercase tracking-tight">
              {user.role === UserRole.SUPER_ADMIN ? 'EduCore Admin' : tenant.name}
            </h1>
            <span className="text-[9px] text-gray-400 dark:text-slate-500 uppercase tracking-[0.2em] font-black truncate block mt-0.5">
              {user.role === UserRole.SCHOOL_ADMIN ? 'Gestor Unidade' :
                user.role === UserRole.STUDENT ? 'Área do Aluno' :
                  user.role.replace('_', ' ')}
            </span>
          </div>
        </div>
        <button onClick={onClose} className="lg:hidden p-2 text-gray-400 dark:text-slate-500 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg">
          <X size={20} />
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto py-4 scrollbar-hide">
        {menuItems.map((item) => (
          <button
            key={item.id}
            onClick={() => {
              setActiveTab(item.id);
              if (onClose) onClose();
            }}
            className={`w-full flex items-center gap-3 px-6 py-4 text-[11px] font-black uppercase tracking-widest transition-all relative ${activeTab === item.id
              ? 'text-tenant-primary dark:text-slate-100 bg-blue-50/30 dark:bg-slate-800/50'
              : 'text-gray-400 dark:text-slate-500 hover:bg-gray-50 dark:hover:bg-slate-800/30'
              }`}
          >
            {activeTab === item.id && (
              <div className="absolute left-0 top-1 bottom-1 w-1 bg-tenant-primary dark:bg-slate-200 rounded-r shadow-[0_0_10px_rgba(var(--primary-color),0.5)]" />
            )}
            <item.icon size={18} strokeWidth={activeTab === item.id ? 2.5 : 2} />
            <span className="truncate">{item.label}</span>
            {item.badge !== undefined && item.badge > 0 && (
              <span className="ml-auto bg-red-600 text-white text-[9px] px-1.5 py-0.5 rounded-full font-black animate-pulse">
                {item.badge}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="p-4 border-t dark:border-slate-800 bg-gray-50/30 dark:bg-slate-900/50">
        <button
          onClick={() => {
            setActiveTab('profile');
            if (onClose) onClose();
          }}
          className="flex items-center justify-between mb-6 px-2 w-full text-left group cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition-all"
        >
          <div className="flex items-center gap-3 overflow-hidden p-2">
            <div className="relative">
              <img src={user.avatar} className="w-10 h-10 rounded-2xl border-2 border-white dark:border-slate-700 shadow-md group-hover:scale-110 transition-transform" alt="Avatar" />
              <div className="absolute -bottom-1 -right-1 w-3 h-3 bg-green-500 border-2 border-white dark:border-slate-900 rounded-full" />
            </div>
            <div className="overflow-hidden flex-1">
              <p className="text-xs font-black text-gray-800 dark:text-slate-200 truncate uppercase tracking-tight group-hover:text-tenant-primary dark:group-hover:text-white transition-colors">{user.name}</p>
              <p className="text-[10px] text-gray-400 dark:text-slate-500 truncate font-medium">Editar Perfil</p>
            </div>
          </div>

          <div className="bg-slate-200 dark:bg-slate-800 p-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity">
            <Settings size={14} className="text-slate-500 dark:text-slate-300" />
          </div>
        </button>
        <button
          onClick={onLogout}
          className="w-full flex items-center justify-center gap-2 px-4 py-4 text-[10px] text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-2xl transition-all font-black uppercase tracking-widest border border-red-50 dark:border-red-900/20 shadow-sm"
        >
          <LogOut size={16} />
          <span>Encerrar Sessão</span>
        </button>
      </div>
    </div>
  );
};

export default Sidebar;
