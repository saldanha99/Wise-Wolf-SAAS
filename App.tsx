import React, { useState, useEffect, useMemo, useRef, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { whatsappService } from './services/whatsappService';
import { supabase } from './lib/supabase';
import { MOCK_TENANTS, MOCK_STUDENTS_LIST, PROFILE_SAFE_COLS } from './constants';
import {
  UserRole,
  Tenant,
  TenantMembershipOption,
  User,
  Teacher,
  Reschedule,
} from './types';
import { Menu, X, Sun, Moon, Bell, Search, User as UserIcon, Shield, LogOut, Loader2 } from 'lucide-react';
import { resolveTenantFromHostname, getTenantPublicUrl, ResolvedTenant } from './lib/tenant-resolver';
import { loadAppUser } from './lib/auth-user';
import { applyTenantBranding, resetTenantBranding } from './lib/tenant-branding';

// Lazy Load Components
const TeacherDashboard = lazy(() => import('./components/TeacherDashboard'));
const LessonLauncher = lazy(() => import('./components/LessonLauncher'));
const StudentsList = lazy(() => import('./components/StudentsList'));
const AvailabilityHeatmap = lazy(() => import('./components/AvailabilityHeatmap'));
const FinancialReport = lazy(() => import('./components/FinancialReport'));
const SuperAdminDashboard = lazy(() => import('./components/SuperAdminDashboard'));
const SuperAdminMetrics = lazy(() => import('./components/SuperAdminMetrics'));
const PendingLessons = lazy(() => import('./components/PendingLessons'));
const TeacherAvailabilityEditor = lazy(() => import('./components/TeacherAvailabilityEditor'));
const TeacherScheduleExplorer = lazy(() => import('./components/TeacherScheduleExplorer'));
const SchoolAdminDashboard = lazy(() => import('./components/SchoolAdminDashboard'));
const PedagogicalConfig = lazy(() => import('./components/PedagogicalConfig'));
const LearningPathsBuilder = lazy(() => import('./components/LearningPathsBuilder'));
const ClassSkillsDashboard = lazy(() => import('./components/ClassSkillsDashboard'));
const TeacherMessageSettings = lazy(() => import('./components/TeacherMessageSettings'));
const TenantSettings = lazy(() => import('./components/TenantSettings'));
const StudentBilling = lazy(() => import('./components/StudentBilling'));
const TeacherInvoices = lazy(() => import('./components/TeacherInvoices'));
const TeacherPayments = lazy(() => import('./components/TeacherPayments'));
const LessonPlannerAI = lazy(() => import('./components/LessonPlannerAI'));
const StudentDashboard = lazy(() => import('./components/StudentDashboard'));
const StudentPracticeHub = lazy(() => import('./components/StudentPracticeHub'));
const StudentSchedule = lazy(() => import('./components/StudentSchedule'));
const EvolutionView = lazy(() => import('./components/EvolutionView'));
const TeacherProfile = lazy(() => import('./components/TeacherProfile'));
const TeacherReschedules = lazy(() => import('./components/TeacherReschedules'));
const TeacherManagement = lazy(() => import('./components/TeacherManagement'));
const OralTestsPanel = lazy(() => import('./components/OralTestsPanel'));
const MeetingLinksView = lazy(() => import('./components/MeetingLinksView'));
const TeacherFinancials = lazy(() => import('./components/TeacherFinancials'));
const AttendanceDisputes = lazy(() => import('./components/AttendanceDisputes'));
const TrialTrainingSettlement = lazy(() => import('./components/TrialTrainingSettlement'));
const ContractManagement = lazy(() => import('./components/ContractManagement'));
const AdminPaymentsList = lazy(() => import('./components/AdminPaymentsList'));
const StudentInsightsBoard = lazy(() => import('./components/StudentInsightsBoard'));
const TeacherInsightsBoard = lazy(() => import('./components/TeacherInsightsBoard'));
const VendorManagement = lazy(() => import('./components/VendorManagement'));
const ReferralAdmin = lazy(() => import('./components/ReferralAdmin'));
const CashflowPanel = lazy(() => import('./components/CashflowPanel'));
const AiCostPanel = lazy(() => import('./components/AiCostPanel'));
const MeetingLinkVerifier = lazy(() => import('./components/MeetingLinkVerifier'));
const AutomationPanel = lazy(() => import('./components/AutomationPanel'));
const MaterialApprovals = lazy(() => import('./components/MaterialApprovals'));
const StudentMaterials = lazy(() => import('./components/StudentMaterials'));
const StudentPedagogicalView = lazy(() => import('./components/StudentPedagogicalView'));
const WhatsappConfig = lazy(() => import('./components/WhatsappConfig'));
const CRMPage = lazy(() => import('./components/CRMPage'));
const LandingPageBuilder = lazy(() => import('./components/LandingPageBuilder'));
const SaasLandingPage = lazy(() => import('./components/landing/SaasLandingPage'));
const WiseWolfLanding = lazy(() => import('./components/landing/WiseWolfLanding'));
const StudentLandingTemplate = lazy(() => import('./components/landing/StudentLandingTemplate'));
const PublicRegistration = lazy(() => import('./components/PublicRegistration'));
const ConfirmAttendance = lazy(() => import('./components/ConfirmAttendance'));
const TeacherTransferAccept = lazy(() => import('./components/TeacherTransferAccept'));
const TeacherOnboarding = lazy(() => import('./components/TeacherOnboarding'));
const VendorOnboarding = lazy(() => import('./components/VendorOnboarding'));
const SchoolSignupPage = lazy(() => import('./components/SchoolSignupPage'));
const TeacherEntrepreneurSignup = lazy(() => import('./components/TeacherEntrepreneurSignup'));
const TenantAdvancedSettings = lazy(() => import('./components/TenantAdvancedSettings'));
const TeacherWorkflows = lazy(() => import('./components/TeacherWorkflows'));
const AdminWorkflowsPanel = lazy(() => import('./components/AdminWorkflowsPanel'));
const SuspensionPage = lazy(() => import('./components/SuspensionPage'));
const SmartFinder = lazy(() => import('./components/SmartFinder'));
const ClaimOpportunity = lazy(() => import('./components/ClaimOpportunity'));
const BookInterview = lazy(() => import('./components/BookInterview'));
const PublicTrialConfirmation = lazy(() => import('./components/PublicTrialConfirmation'));
const WolfieLab = lazy(() => import('./components/WolfieLab'));
const TeacherNudges = lazy(() => import('./components/TeacherNudges'));
const StudentOpportunitiesBoard = lazy(() => import('./components/StudentOpportunitiesBoard'));
const TeacherApplyLanding = lazy(() => import('./components/TeacherApplyLanding'));
const TrialsToContracts = lazy(() => import('./components/TrialsToContracts'));
const StudentAITutor = lazy(() => import('./src/pages/student/StudentAITutor'));
const HRModule = lazy(() => import('./components/HRModule'));
const TrainingAdmin = lazy(() => import('./components/training/TrainingAdmin'));
const TrainingView = lazy(() => import('./components/training/TrainingView'));
const ManualTrialScheduler = lazy(() => import('./components/ManualTrialScheduler'));
const AffiliatePanel = lazy(() => import('./components/AffiliatePanel'));
const TeacherInviteGenerator = lazy(() => import('./components/TeacherInviteGenerator'));
const VendorInviteGenerator = lazy(() => import('./components/VendorInviteGenerator'));
const PublicContractView = lazy(() => import('./components/PublicContractView'));
const VendorDashboard = lazy(() => import('./components/VendorDashboard'));
const VendorTrialLinkGenerator = lazy(() => import('./components/VendorTrialLinkGenerator'));
const RegistrationLinkGenerator = lazy(() => import('./components/RegistrationLinkGenerator'));
const ReferralLanding = lazy(() => import('./components/ReferralLanding'));
const VendedorLanding = lazy(() => import('./components/VendedorLanding'));

// Static Components (Core UI)
import ModernSidebar from './components/ModernSidebar';
import Login from './components/Login';
import ProtectedRoute from './components/ProtectedRoute';
import { StudentProvider } from './components/contexts/StudentContext';

interface NavigationSearchItem {
  tab: string;
  label: string;
  group: string;
  keywords?: string;
}

const ROLE_NAVIGATION_ITEMS: Record<UserRole, NavigationSearchItem[]> = {
  [UserRole.SUPER_ADMIN]: [
    { tab: 'dashboard', label: 'Visão Global', group: 'Administração' },
    { tab: 'tenants', label: 'Tenants', group: 'Administração' },
    { tab: 'billing', label: 'Faturamento', group: 'Administração' },
    { tab: 'settings', label: 'Infraestrutura', group: 'Administração' },
    { tab: 'automation', label: 'Smart', group: 'Administração' },
  ],
  [UserRole.SCHOOL_ADMIN]: [
    { tab: 'dashboard', label: 'Início', group: 'Visão geral', keywords: 'dashboard painel' },
    { tab: 'wolfie-lab', label: 'Wolfie Lab', group: 'Visão geral' },
    { tab: 'students', label: 'Alunos', group: 'Pessoas' },
    { tab: 'student-insights', label: 'Painel de Alunos', group: 'Pessoas' },
    { tab: 'teachers', label: 'Professores', group: 'Pessoas' },
    { tab: 'teacher-insights', label: 'Gestão de Professores', group: 'Pessoas' },
    { tab: 'approvals', label: 'Acolhimento (Docs)', group: 'Pessoas', keywords: 'documentos contratos alunos' },
    { tab: 'recruiting', label: 'Recrutamento', group: 'Pessoas' },
    { tab: 'hr', label: 'Recursos Humanos', group: 'Pessoas', keywords: 'rh' },
    { tab: 'schedule_explorer', label: 'Mapa de Aulas', group: 'Aulas', keywords: 'agenda horários' },
    { tab: 'attendance-disputes', label: 'Verificar Presença', group: 'Aulas' },
    { tab: 'trials', label: 'Agendar Experimental', group: 'Aulas' },
    { tab: 'trial-settlement', label: 'Pagar Experimental/Treino', group: 'Aulas' },
    { tab: 'oral-tests', label: 'Testes Orais', group: 'Aulas' },
    { tab: 'pedagogical', label: 'Biblioteca', group: 'Pedagógico' },
    { tab: 'material-approvals', label: 'Aprovar Materiais', group: 'Pedagógico' },
    { tab: 'learning_paths_builder', label: 'Trilhas', group: 'Pedagógico' },
    { tab: 'class_skills', label: 'Skills da Turma', group: 'Pedagógico' },
    { tab: 'training', label: 'Treinamentos', group: 'Pedagógico' },
    { tab: 'student-payments', label: 'Mensalidades dos Alunos', group: 'Financeiro' },
    { tab: 'payments', label: 'Repasse a Professores', group: 'Financeiro' },
    { tab: 'cashflow', label: 'Fluxo de Caixa', group: 'Financeiro' },
    { tab: 'ai-costs', label: 'Custo de IA', group: 'Financeiro' },
    { tab: 'verify-rooms', label: 'Verificar Salas', group: 'Aulas' },
    { tab: 'financial', label: 'Lançamentos do Caixa', group: 'Financeiro' },
    { tab: 'crm', label: 'CRM & Funil', group: 'Crescimento' },
    { tab: 'marketing', label: 'Site & Vendas', group: 'Crescimento' },
    { tab: 'referral-admin', label: 'Indicações', group: 'Crescimento' },
    { tab: 'vendors-mgmt', label: 'Vendedores', group: 'Crescimento' },
    { tab: 'contracts', label: 'Contratos', group: 'Configurações' },
    { tab: 'settings_school', label: 'Branding', group: 'Configurações' },
    { tab: 'automation', label: 'WhatsApp (Conexão)', group: 'Configurações' },
    { tab: 'automations', label: 'Disparos WhatsApp', group: 'Configurações' },
    { tab: 'tenant_advanced', label: 'Configuração Avançada', group: 'Configurações' },
    { tab: 'admin_workflows', label: 'Workflows', group: 'Configurações' },
    { tab: 'profile', label: 'Meu Perfil', group: 'Conta' },
  ],
  [UserRole.TEACHER]: [
    { tab: 'dashboard', label: 'Dashboard', group: 'Professor' },
    { tab: 'lessons', label: 'Lançar Aula', group: 'Professor' },
    { tab: 'pending', label: 'Pendentes', group: 'Professor' },
    { tab: 'meeting_links', label: 'Links de Aula', group: 'Professor' },
    { tab: 'students', label: 'Alunos', group: 'Professor' },
    { tab: 'lesson-planner-ai', label: 'Planner IA', group: 'Professor' },
    { tab: 'wolfie-lab', label: 'Wolfie Lab', group: 'Professor' },
    { tab: 'class_skills', label: 'Skills da Turma', group: 'Professor' },
    { tab: 'msg_settings', label: 'Mensagens', group: 'Professor' },
    { tab: 'teacher_workflows', label: 'Saída / Ausência', group: 'Professor' },
    { tab: 'schedule', label: 'Agenda', group: 'Professor' },
    { tab: 'invoices', label: 'Notas Fiscais', group: 'Professor' },
    { tab: 'teacher-financials', label: 'Financeiro', group: 'Professor' },
    { tab: 'reschedules', label: 'Reposições', group: 'Professor' },
    { tab: 'pedagogical', label: 'Pedagógico', group: 'Professor' },
    { tab: 'training', label: 'Treinamentos', group: 'Professor' },
    { tab: 'oral-tests', label: 'Testes Orais', group: 'Professor' },
    { tab: 'automation', label: 'Smart', group: 'Professor' },
    { tab: 'referral', label: 'Indicações', group: 'Professor' },
    { tab: 'contract_teacher', label: 'Meu Contrato', group: 'Professor' },
    { tab: 'profile', label: 'Meu Perfil', group: 'Conta' },
  ],
  [UserRole.STUDENT]: [
    { tab: 'dashboard', label: 'Meu Portal', group: 'Aluno', keywords: 'início dashboard' },
    { tab: 'ai-tutor', label: 'Praticar com o Wolfie', group: 'Aluno' },
    { tab: 'practice', label: 'Minhas Trilhas', group: 'Aluno' },
    { tab: 'schedule', label: 'Aulas', group: 'Aluno' },
    { tab: 'meeting_links', label: 'Links', group: 'Aluno' },
    { tab: 'materials', label: 'Materiais', group: 'Aluno' },
    { tab: 'financial', label: 'Financeiro', group: 'Aluno' },
    { tab: 'evolution', label: 'Evolução', group: 'Aluno' },
    { tab: 'training', label: 'Treinamentos', group: 'Aluno' },
    { tab: 'referral', label: 'Indicações', group: 'Aluno' },
    { tab: 'profile', label: 'Meu Perfil', group: 'Conta' },
  ],
  [UserRole.SALESPERSON]: [
    { tab: 'vendor_dashboard', label: 'Dashboard', group: 'Vendas' },
    { tab: 'vendor_schedule', label: 'Agenda de Professores', group: 'Vendas' },
    { tab: 'vendor_trial', label: 'Link Experimental', group: 'Vendas' },
    { tab: 'vendor_enrollment', label: 'Gerar Matrícula', group: 'Vendas' },
    { tab: 'vendor_commissions', label: 'Minhas Comissões', group: 'Vendas' },
    { tab: 'profile', label: 'Meu Perfil', group: 'Conta' },
  ],
  [UserRole.NON_STUDENT]: [
    { tab: 'hub', label: 'Wise Wolf Hub', group: 'Hub' },
  ],
};

const NOTIFICATION_ITEMS: { key: string; label: string; tab: string }[] = [
  { key: 'acolhimento', label: 'Documentos de aluno para aprovar', tab: 'approvals' },
  { key: 'presenca', label: 'Conflitos de presença para resolver', tab: 'attendance-disputes' },
  { key: 'materiais', label: 'Materiais para aprovar', tab: 'material-approvals' },
  { key: 'trials', label: 'Experimentais/treinos para liquidar', tab: 'trial-settlement' },
  { key: 'fechamentos', label: 'Fechamentos de professor pendentes', tab: 'payments' },
  { key: 'pagamentos_retidos', label: 'Pagamentos retidos por conflito', tab: 'attendance-disputes' },
];

const normalizeSearchText = (value: string) =>
  value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');

const App: React.FC = () => {
  const [user, setUser] = useState<User | null>(null);
  const [currentTenant, setCurrentTenant] = useState<Tenant | null>(null);
  const [tenantMemberships, setTenantMemberships] = useState<TenantMembershipOption[]>([]);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false); // Mobile
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false); // Desktop
  const [notifOpen, setNotifOpen] = useState(false); // Dropdown de notificações (pendências do diretor)
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchActiveIndex, setSearchActiveIndex] = useState(0);
  const [notifPosition, setNotifPosition] = useState({ top: 72, left: 12, width: 320 });
  const mainScrollRef = useRef<HTMLElement>(null);
  const searchContainerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const notifButtonRef = useRef<HTMLButtonElement>(null);
  const notifPanelRef = useRef<HTMLDivElement>(null);

  const [explorerInitialState, setExplorerInitialState] = useState<{ teacherName?: string, autoAllocate?: boolean } | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    return (localStorage.getItem('theme') as 'light' | 'dark') ||
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  });

  // Tenant resolvido pelo hostname (subdomínio ou domínio próprio) — pré-login
  const [hostnameTenant, setHostnameTenant] = useState<ResolvedTenant | null>(null);

  // State for Real Data
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [reschedules, setReschedules] = useState<Reschedule[]>([]);
  const [students, setStudents] = useState<any[]>([]); // Cache students for selection
  const [pendingLessonsCount, setPendingLessonsCount] = useState(0);
  const [pendingCounts, setPendingCounts] = useState<Record<string, number>>({}); // pendências do diretor (badges)

  // Loading State
  const [isLoading, setIsLoading] = useState(false);
  const [isRestoringSession, setIsRestoringSession] = useState(true);

  const navigationSearchItems = user ? ROLE_NAVIGATION_ITEMS[user.role] : [];
  const filteredSearchItems = useMemo(() => {
    const normalizedQuery = normalizeSearchText(searchQuery.trim());
    const matches = normalizedQuery
      ? navigationSearchItems.filter((item) =>
        normalizeSearchText(`${item.label} ${item.group} ${item.keywords || ''}`).includes(normalizedQuery)
      )
      : navigationSearchItems;

    return matches.slice(0, 10);
  }, [navigationSearchItems, searchQuery]);

  const canSeeDirectorNotifications = user?.role === UserRole.SCHOOL_ADMIN || user?.role === UserRole.SUPER_ADMIN;
  const activeNotifications = canSeeDirectorNotifications
    ? NOTIFICATION_ITEMS.filter((item) => (pendingCounts[item.key] || 0) > 0)
    : [];
  const notificationTotal = activeNotifications.reduce(
    (sum, item) => sum + (pendingCounts[item.key] || 0),
    0
  );

  useEffect(() => {
    mainScrollRef.current?.scrollTo({ top: 0, left: 0 });
  }, [activeTab]);

  useEffect(() => {
    setSearchActiveIndex(0);
  }, [searchQuery, user?.role]);

  useEffect(() => {
    if (user?.role === UserRole.NON_STUDENT) window.location.replace('/hub');
  }, [user?.role]);

  useEffect(() => {
    if (!searchOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!searchContainerRef.current?.contains(event.target as Node)) {
        setSearchOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [searchOpen]);

  useEffect(() => {
    if (!notifOpen) return;

    const updatePosition = () => {
      const trigger = notifButtonRef.current;
      if (!trigger) return;

      const rect = trigger.getBoundingClientRect();
      const margin = window.innerWidth < 640 ? 12 : 16;
      const width = Math.min(320, window.innerWidth - (margin * 2));
      const left = Math.min(
        Math.max(margin, rect.right - width),
        window.innerWidth - margin - width
      );

      setNotifPosition({
        top: rect.bottom + 8,
        left,
        width,
      });
    };

    const closeAndRestoreFocus = () => {
      setNotifOpen(false);
      window.requestAnimationFrame(() => notifButtonRef.current?.focus());
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeAndRestoreFocus();
        return;
      }

      if (event.key !== 'Tab' || !notifPanelRef.current) return;

      const focusable = Array.from(
        notifPanelRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')
      ) as HTMLElement[];

      if (focusable.length === 0) {
        event.preventDefault();
        notifPanelRef.current.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === notifPanelRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    updatePosition();
    const focusFrame = window.requestAnimationFrame(() => notifPanelRef.current?.focus());
    window.addEventListener('resize', updatePosition);
    window.visualViewport?.addEventListener('resize', updatePosition);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener('resize', updatePosition);
      window.visualViewport?.removeEventListener('resize', updatePosition);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [notifOpen]);

  // Restaura a sessão persistida pelo Supabase depois de refresh/reabertura da aba.
  useEffect(() => {
    let mounted = true;

    const restoreSession = async () => {
      try {
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) throw sessionError;
        if (!session?.user) return;

        const restoredUser = await loadAppUser(session.user.id);
        if (!restoredUser) {
          await supabase.auth.signOut();
          return;
        }

        if (mounted) setUser(restoredUser);
      } catch (error) {
        console.error('Session restore error:', error);
      } finally {
        if (mounted) setIsRestoringSession(false);
      }
    };

    void restoreSession();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT' && mounted) {
        setUser(null);
        setCurrentTenant(null);
        setTenantMemberships([]);
        setPendingCounts({});
        setPendingLessonsCount(0);
        setTeachers([]);
        setStudents([]);
        setReschedules([]);
        setNotifOpen(false);
        setSearchOpen(false);
        setSearchQuery('');
        setActiveTab('dashboard');
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  // Resolve tenant pelo hostname ao inicializar (antes do login)
  useEffect(() => {
    resolveTenantFromHostname().then(tenant => {
      setHostnameTenant(tenant);
      if (tenant?.branding) {
        // Aplica branding do tenant na tela de login
        applyTenantBranding(tenant.branding.primaryColor, tenant.branding.secondaryColor);
        document.title = `${tenant.name} — Portal do Aluno`;
      }
    });
  }, []);

  // Fetch Initial Data on Login
  const loadAppData = async () => {
    if (!user || !user.tenantId) return;
    setIsLoading(true);
    try {
      const { data: membershipsData, error: membershipsError } = await supabase
        .rpc('get_my_tenant_memberships');
      if (membershipsError) throw membershipsError;
      setTenantMemberships(
        ((membershipsData || []) as any[]).map((membership) => ({
          tenant_id: membership.tenant_id,
          tenant_name: membership.tenant_name,
          domain: membership.domain,
          branding: membership.branding,
          role: membership.role as UserRole,
          is_primary: Boolean(membership.is_primary),
          is_active: Boolean(membership.is_active),
        })),
      );

      // 1. Setup Tenant Branding
      if (user.tenantId !== 'master') {
        const { data: tenantData } = await supabase
          .rpc('get_my_tenant_config')
          .maybeSingle();
        const resolvedTenantData = tenantData as any;
        if (resolvedTenantData) {
          const safeBranding = applyTenantBranding(
            resolvedTenantData.branding?.primaryColor,
            resolvedTenantData.branding?.secondaryColor,
          );
          setCurrentTenant({
            id: resolvedTenantData.id,
            name: resolvedTenantData.name,
            domain: resolvedTenantData.domain,
            branding: { ...resolvedTenantData.branding, ...safeBranding },
            studentLimit: resolvedTenantData.student_limit,
            teacherLimit: resolvedTenantData.teacher_limit,
            whatsapp_enabled: resolvedTenantData.whatsapp_enabled,
            school_info: resolvedTenantData.school_info ?? null,
          });
          document.title = `${resolvedTenantData.name} - Portal EduCore`;
        } else {
          // Rede de segurança: se o tenant não vier (RPC indisponível, permissão nova,
          // rede), NUNCA deixe currentTenant nulo — o id do tenant é a chave que as telas
          // usam para gravar (class_logs, teacher_closings). Sem ele, o Lançamento de Aulas
          // ficava carregando para sempre e o Fechamento do professor quebrava em
          // "null value in column tenant_id". Perde-se só o branding, não a operação.
          const fallbackBranding = applyTenantBranding(undefined, undefined);
          setCurrentTenant(prev => prev ?? {
            id: user.tenantId,
            name: hostnameTenant?.name || '',
            domain: '',
            branding: { logoUrl: '', faviconUrl: '', ...fallbackBranding },
            studentLimit: 0,
            teacherLimit: 0,
          });
        }
      }

      // 2. Fetch Teachers (sem o trio financeiro — vem via get_tenant_teacher_pay p/ admin)
      const { data: teachersData } = await supabase
        .from('profiles')
        .select(PROFILE_SAFE_COLS)
        .eq('role', 'TEACHER')
        .eq('tenant_id', user.tenantId);

      // 2b. Pay autoritativo (hourly_rate/pix) — RPC só retorna p/ admin/coordenador.
      const { data: payRows } = await supabase.rpc('get_tenant_teacher_pay');
      const payById = new Map<string, any>((payRows as any[] || []).map((p: any) => [p.id, p]));

      // 3. Fetch Students
      const { data: studentsData } = await supabase
        .from('profiles')
        .select(PROFILE_SAFE_COLS)
        .eq('role', 'STUDENT')
        .eq('tenant_id', user.tenantId);

      // 4. Fetch All Bookings
      const { data: allBookings } = await supabase
        .from('bookings')
        .select('teacher_id, student_id')
        .eq('tenant_id', user.tenantId);

      if (studentsData) {
        let filteredStudents = studentsData;
        
        if (user.role === UserRole.TEACHER && allBookings) {
          const teacherStudentIds = new Set(allBookings.filter(b => b.teacher_id === user.id).map(b => b.student_id));
          filteredStudents = studentsData.filter(s => teacherStudentIds.has(s.id));
        }

        setStudents(filteredStudents.map(s => ({
          id: s.id,
          name: s.full_name,
          // full_name e phone são usados pelo aviso de reposição no WhatsApp
          // (App → onAdd → whatsappService). Sem eles o envio era sempre pulado.
          full_name: s.full_name,
          phone: s.phone,
          module: s.module || 'N/A',
          currentBookPart: s.current_book_part,
          evaluationUnlocked: s.evaluation_unlocked
        })));
      }

      if (teachersData) {
        const formattedTeachers: Teacher[] = teachersData.map((t: any) => {
          const teacherBookings = allBookings?.filter(b => b.teacher_id === t.id) || [];
          const uniqueStudents = new Set(teacherBookings.map(b => b.student_id));

          return {
            id: t.id,
            tenantId: t.tenant_id,
            name: t.full_name,
            email: t.email,
            role: UserRole.TEACHER,
            avatar: t.avatar_url || `https://ui-avatars.com/api/?name=${t.full_name}`,
            module: t.module || 'General',
            modules: [t.module || 'General'],
            specializations: t.specializations || [],
            hourlyRate: payById.get(t.id)?.hourly_rate ?? 8.00,
            pixKey: payById.get(t.id)?.pix_key ?? '',
            phone: t.phone || '',
            studentsCount: uniqueStudents.size,
            classesCount: teacherBookings.length,
            retention: '100%',
            tpi: 100,
            status: 'Ativo',
            lifecycle_status: t.lifecycle_status || 'active',
            occupancy: t.occupancy || 0
          };
        });
        setTeachers(formattedTeachers);
      }

      // 5. Fetch Reschedules
      let reschedulesQuery = supabase
        .from('reschedules')
        .select(`
            id,
            date,
            time,
            original_booking_id,
            teacher:teacher_id(full_name),
            student:student_id(full_name),
            teacher_id,
            student_id
        `)
        .eq('tenant_id', user.tenantId);

      if (user.role === UserRole.TEACHER) {
        reschedulesQuery = reschedulesQuery.eq('teacher_id', user.id);
      }

      const { data: reschedulesData } = await reschedulesQuery;

      if (reschedulesData) {
        const formattedReschedules: Reschedule[] = reschedulesData.map((r: any) => ({
          id: r.id,
          date: r.date,
          teacherName: r.teacher?.full_name || 'Desconhecido',
          studentName: r.student?.full_name || 'Desconhecido',
          repoId: r.original_booking_id ? 100 : 0, // Simplified indicator
          originalLessonId: 0,
          teacherId: r.teacher_id,
          studentId: r.student_id,
          time: r.time
        }));
        setReschedules(formattedReschedules as any);
      }

      // (Inside loadAppData after fetching teachers and reschedules)
      if (user.role === UserRole.TEACHER) {
        const now = new Date();
        const threeDaysAgo = new Date();
        threeDaysAgo.setDate(now.getDate() - 3);

        const { data: logs } = await supabase
          .from('class_logs')
          .select('booking_id, reschedule_id, student_id, created_at')
          .eq('teacher_id', user.id)
          .eq('tenant_id', user.tenantId)
          .gte('created_at', threeDaysAgo.toISOString());

        const daysOfWeek = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
        let count = 0;

        // Loop through last 7 to 30 days to count PENDING (Critical) lessons
        // Grace period is 7 days. Older than 30 days is ignored for performance.
        for (let i = 7; i <= 30; i++) {
          const checkDate = new Date();
          checkDate.setDate(now.getDate() - i);
          const dayName = daysOfWeek[checkDate.getDay()];
          const dateStr = checkDate.toISOString().split('T')[0];

          if (dayName === 'Domingo') continue;

          const { data: bks } = await supabase.from('bookings').select('id, time_slot, student_id, start_date').eq('teacher_id', user.id).eq('day_of_week', dayName);
          bks?.forEach(b => {
            if (b.start_date && dateStr < b.start_date) return;
            // No time check needed as we are > 7 days ago

            const hasLog = logs?.some(l => {
              const lDate = l.created_at.split('T')[0];
              return (l.booking_id && String(l.booking_id) === String(b.id) && lDate === dateStr) ||
                (String(l.student_id) === String(b.student_id) && lDate === dateStr);
            });
            if (!hasLog) count++;
          });

          const { data: rps } = await supabase.from('reschedules').select('id, time, student_id').eq('teacher_id', user.id).eq('date', dateStr);
          rps?.forEach(r => {
            const hasLog = logs?.some(l =>
              (l.reschedule_id && String(l.reschedule_id) === String(r.id)) ||
              (String(l.student_id) === String(r.student_id) && l.created_at.split('T')[0] === dateStr)
            );
            if (!hasLog) count++;
          });
        }
        setPendingLessonsCount(count);
      }

    } catch (error) {
      console.error('Error fetching data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (user && user.tenantId) {
      loadAppData();
    }
  }, [user]);

  // Contadores de pendência do diretor (badges do menu + Central de Pendências)
  const refreshPendingCounts = React.useCallback(async () => {
    if (!user || (user.role !== UserRole.SCHOOL_ADMIN && user.role !== UserRole.SUPER_ADMIN)) {
      setPendingCounts({});
      return;
    }
    try {
      const { data } = await supabase.rpc('director_pending_counts');
      if (data && typeof data === 'object') setPendingCounts(data as Record<string, number>);
    } catch (e) { /* silencioso — badges são best-effort */ }
  }, [user]);

  useEffect(() => { refreshPendingCounts(); }, [refreshPendingCounts, activeTab]);

  // Handle Theme
  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme(prev => prev === 'light' ? 'dark' : 'light');

  const navigateFromSearch = (item: NavigationSearchItem) => {
    setActiveTab(item.tab);
    setSearchQuery('');
    setSearchOpen(false);
    setSearchActiveIndex(0);
    setNotifOpen(false);
    setIsSidebarOpen(false);

    window.requestAnimationFrame(() => {
      mainScrollRef.current?.scrollTo({ top: 0, left: 0 });
      mainScrollRef.current?.focus({ preventScroll: true });
    });
  };

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSearchOpen(true);
      setSearchActiveIndex((index) =>
        filteredSearchItems.length === 0 ? 0 : Math.min(index + 1, filteredSearchItems.length - 1)
      );
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSearchOpen(true);
      setSearchActiveIndex((index) =>
        filteredSearchItems.length === 0 ? 0 : Math.max(index - 1, 0)
      );
    } else if (event.key === 'Enter' && filteredSearchItems[searchActiveIndex]) {
      event.preventDefault();
      navigateFromSearch(filteredSearchItems[searchActiveIndex]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setSearchOpen(false);
      setSearchQuery('');
    }
  };

  const closeNotifications = (restoreFocus = true) => {
    setNotifOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => notifButtonRef.current?.focus());
    }
  };

  const handleLogout = async () => {
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    } catch (error) {
      console.error('Logout error:', error);
      // Mesmo sem rede, remove a sessão persistida deste navegador para que um
      // refresh não autentique novamente o usuário que acabou de sair.
      const { error: localError } = await supabase.auth.signOut({ scope: 'local' });
      if (localError) console.error('Local logout error:', localError);
    } finally {
      setUser(null);
      setCurrentTenant(null);
      setPendingCounts({});
      setPendingLessonsCount(0);
      setTeachers([]);
      setStudents([]);
      setReschedules([]);
      setNotifOpen(false);
      setSearchOpen(false);
      setSearchQuery('');
      setActiveTab('dashboard');
      setIsSidebarOpen(false);
      setExplorerInitialState(null);
      resetTenantBranding();
    }
  };

  // --- ROUTING LOGIC (Simple Client-Side Router) ---
  const path = window.location.pathname;

  if (path === '/claim-opportunity') {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('id');
    return <ClaimOpportunity opportunityId={id} />;
  }

  // Candidato a professor agenda a entrevista com o diretor (link enviado pela Michelle/RH)
  if (path === '/book-interview') {
    const params = new URLSearchParams(window.location.search);
    return <BookInterview token={params.get('t')} />;
  }

  if (path === '/experimental') {
    const params = new URLSearchParams(window.location.search);
    let legacyOpportunityId: string | null = null;
    const legacyData = params.get('data');
    if (legacyData) {
      try {
        const decoded = JSON.parse(decodeURIComponent(escape(atob(legacyData))));
        legacyOpportunityId = decoded?.opportunityId || null;
      } catch { /* o componente exibirá link inválido */ }
    }
    return <PublicTrialConfirmation token={params.get('token')} legacyOpportunityId={legacyOpportunityId} />;
  }

  if (path === '/new-saas') {
    return <SaasLandingPage />;
  }
  if (path === '/lp' || path === '/wisewolf' || path === '/assine') {
    return <WiseWolfLanding />;
  }

  if (path === '/new-student') {
    return <StudentLandingTemplate />;
  }

  if (path === '/matricula') {
    return <PublicRegistration />;
  }

  // Banco de talentos: candidatura pública de professores (tráfego pago)
  if (path === '/quero-ensinar') {
    return <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-slate-950"><Loader2 className="animate-spin text-violet-400" size={32} /></div>}>
      <TeacherApplyLanding />
    </Suspense>;
  }

  // Confirmação de presença pelo aluno (link 1-clique do WhatsApp) — público, sem login
  if (path === '/confirmar-presenca' || path.startsWith('/confirmar-presenca')) {
    return <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-slate-950"><Loader2 className="animate-spin text-emerald-400" size={32} /></div>}>
      <ConfirmAttendance />
    </Suspense>;
  }

  // Aceite de transferência de aluno pelo novo professor (link público, sem login)
  if (path === '/transferencia' || path.startsWith('/transferencia')) {
    return <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-slate-950"><Loader2 className="animate-spin text-emerald-400" size={32} /></div>}>
      <TeacherTransferAccept />
    </Suspense>;
  }

  if (path === '/indicacao') {
    return (
      <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-slate-950"><Loader2 className="animate-spin text-emerald-400" size={32} /></div>}>
        <ReferralLanding />
      </Suspense>
    );
  }

  if (path === '/vendedores' || path === '/seja-vendedor') {
    return (
      <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-slate-950"><Loader2 className="animate-spin text-emerald-400" size={32} /></div>}>
        <VendedorLanding />
      </Suspense>
    );
  }

  if (path === '/view-contract') {
    return <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><Loader2 className="animate-spin text-slate-400" /></div>}>
      <PublicContractView />
    </Suspense>;
  }

  // Esta verificação deve vir ANTES de qualquer <AuthProvider> ou verificação de sessão
  if (path === '/teacher-onboarding' || path.startsWith('/teacher-onboarding')) {
    return <TeacherOnboarding />;
  }
  if (path === '/vendor-onboarding' || path.startsWith('/vendor-onboarding')) {
    return <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><Loader2 className="animate-spin text-slate-400" /></div>}>
      <VendorOnboarding />
    </Suspense>;
  }
  if (path === '/comece' || path === '/signup' || path.startsWith('/comece')) {
    return <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><Loader2 className="animate-spin text-slate-400" /></div>}>
      <SchoolSignupPage />
    </Suspense>;
  }
  // Signup do Professor Empreendedor — Wise Wolf For Teachers
  // Aceita ?ref=<tenantId> para rastrear escola mãe
  if (path === '/seja-professor' || path === '/teacher-signup') {
    const _tsParams = new URLSearchParams(window.location.search);
    const parentTenantId = _tsParams.get('ref') || undefined;
    const referrerTeacherId = _tsParams.get('ref_teacher') || undefined;
    return <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><Loader2 className="animate-spin text-slate-400" /></div>}>
      <TeacherEntrepreneurSignup parentTenantId={parentTenantId} referrerTeacherId={referrerTeacherId} />
    </Suspense>;
  }
  // --------------------------------------------------

  if (isRestoringSession) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-200" role="status" aria-live="polite">
        <Loader2 className="animate-spin mr-3 text-blue-400" aria-hidden="true" />
        Restaurando sessão...
      </div>
    );
  }

  if (!user) {
    return <Login onLogin={setUser} />;
  }

  if (user.role === UserRole.NON_STUDENT) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-200" role="status">
        <Loader2 className="animate-spin mr-3 text-violet-400" aria-hidden="true" />
        Abrindo o Wise Wolf Hub...
      </div>
    );
  }

  // --- FINANCIAL LOCK MOVED TO ProtectedRoute.tsx ---

  const handleUpdateTenant = (newBranding: any) => {
    if (currentTenant) {
      const safeBranding = applyTenantBranding(
        newBranding?.primaryColor,
        newBranding?.secondaryColor,
      );
      setCurrentTenant({
        ...currentTenant,
        branding: { ...newBranding, ...safeBranding },
      });
    }
  };

  const handleTenantSwitch = async (tenantId: string) => {
    if (!user || tenantId === user.tenantId) return;
    const { error } = await supabase.rpc('switch_my_tenant', {
      p_tenant_id: tenantId,
    });
    if (error) {
      console.error('Tenant switch failed:', { code: error.code });
      window.alert('Não foi possível trocar de instituição. Atualize a página e tente novamente.');
      return;
    }

    const switchedUser = await loadAppUser(user.id);
    if (!switchedUser) {
      await supabase.auth.signOut();
      return;
    }

    setActiveTab('dashboard');
    setCurrentTenant(null);
    setPendingCounts({});
    setPendingLessonsCount(0);
    setTeachers([]);
    setStudents([]);
    setReschedules([]);
    setUser(switchedUser);
  };

  const renderContent = () => {
    // SECURITY GUARD: Strict Vendor Access Check
    if (user.role === UserRole.SALESPERSON) {
      const allowedVendorTabs = ['vendor_dashboard', 'vendor_schedule', 'vendor_trial', 'vendor_enrollment', 'vendor_commissions', 'profile'];
      if (!allowedVendorTabs.includes(activeTab)) {
        setActiveTab('vendor_dashboard');
        return null;
      }
    }

    // SECURITY GUARD: Strict Student Access Check
    if (user.role === UserRole.STUDENT) {
      const allowedStudentTabs = ['dashboard', 'ai-tutor', 'practice', 'schedule', 'meeting_links', 'materials', 'financial', 'evolution', 'profile', 'referral', 'training'];
      if (!allowedStudentTabs.includes(activeTab)) {
        return (
          <div className="flex flex-col items-center justify-center min-h-[500px] text-center bg-white dark:bg-slate-900 rounded-[3rem] border border-red-100 dark:border-red-900/30 shadow-xl overflow-hidden relative">
            <div className="absolute top-0 right-0 p-12 opacity-10 blur-xl">
              <Shield size={200} className="text-red-500" />
            </div>
            <div className="w-24 h-24 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 rounded-full flex items-center justify-center mb-6 shadow-2xl relative z-10 animate-bounce">
              <LogOut size={48} />
            </div>
            <h2 className="text-4xl font-black text-slate-800 dark:text-white uppercase tracking-tighter mb-4 relative z-10">Acesso Restrito</h2>
            <p className="text-slate-500 dark:text-slate-400 px-8 max-w-lg mb-8 relative z-10">
              Parece que você navegou para uma área não autorizada para alunos. Como medida de segurança, seu acesso a esta página foi bloqueado.
            </p>
            <button onClick={() => setActiveTab('dashboard')} className="px-8 py-4 bg-red-600 text-white font-black uppercase text-sm tracking-widest rounded-xl hover:bg-red-700 hover:scale-105 active:scale-95 transition-all relative z-10 shadow-[0_10px_20px_-10px_rgba(220,38,38,0.5)]">
              Voltar ao Meu Portal
            </button>
          </div>
        );
      }
    }

    // SECURITY GUARD: Strict Teacher Access Check
    if (user.role === UserRole.TEACHER) {
      const allowedTeacherTabs = ROLE_NAVIGATION_ITEMS[UserRole.TEACHER].map((item) => item.tab);
      if (!allowedTeacherTabs.includes(activeTab)) {
        setActiveTab('dashboard');
        return null;
      }
    }

    // SECURITY GUARD: Strict School Admin Access Check
    // Mantém o diretor dentro do escopo dele (abas de aluno/professor/vendedor
    // não pertencem aqui). Redireciona silenciosamente ao Início.
    if (user.role === UserRole.SCHOOL_ADMIN) {
      const allowedAdminTabs = [
        'dashboard', 'wolfie-lab', 'students', 'student-insights', 'teachers', 'teacher-insights',
        'approvals', 'recruiting', 'hr', 'schedule_explorer', 'attendance-disputes', 'trials',
        'trial-settlement', 'pedagogical', 'material-approvals', 'learning_paths_builder',
        'class_skills', 'training', 'oral-tests', 'payments', 'student-payments', 'cashflow', 'ai-costs', 'verify-rooms', 'financial',
        'crm', 'marketing', 'referral-admin', 'vendors-mgmt', 'contracts', 'settings_school',
        'automation', 'automations', 'tenant_advanced', 'admin_workflows', 'profile'
      ];
      if (!allowedAdminTabs.includes(activeTab)) {
        setActiveTab('dashboard');
        return null;
      }
    }

    // Professores ATIVOS (lifecycle_status='active') — usado em tudo que é agenda,
    // agendamento e disparo. Professor suspenso/desligado (offboarded) NÃO deve
    // aparecer no mapa/explorador de agenda nem ser sugerido para novas aulas.
    // A lista COMPLETA (`teachers`) continua indo só para o CRUD de professores
    // (TeacherManagement), onde o diretor precisa ver e reativar os inativos.
    const activeTeachers = teachers.filter(t => ((t as any).lifecycle_status || 'active') === 'active');

    const contentMap: Record<string, React.ReactNode> = {
      'dashboard': user.role === UserRole.SUPER_ADMIN ? <SuperAdminDashboard /> :
        user.role === UserRole.SCHOOL_ADMIN ?
          <SchoolAdminDashboard
            teachers={activeTeachers}
            tenantId={currentTenant?.id}
            userRole={user.role}
            onNavigate={setActiveTab}
            onViewTeacherSchedule={(name) => {
              setExplorerInitialState({ teacherName: name, autoAllocate: false });
              setActiveTab('schedule_explorer');
            }}
          /> :
          user.role === UserRole.STUDENT ? <StudentDashboard user={user} tenantId={currentTenant?.id} /> :
          user.role === UserRole.SALESPERSON ? <VendorDashboard user={user} tenantId={currentTenant?.id} teachers={activeTeachers} onNavigate={setActiveTab} /> :
            <>
              {/* Funil pós-contratação: pop-up diário de responsabilidades do professor */}
              <TeacherNudges userId={user.id} pendingLessons={pendingLessonsCount} onNavigate={(tab) => { setActiveTab(tab); setIsSidebarOpen(false); }} />
              <StudentOpportunitiesBoard userId={user.id} />
              <TeacherDashboard user={user} tenantId={currentTenant?.id} onNavigate={(tab) => { setActiveTab(tab); setIsSidebarOpen(false); }} />
            </>,

      'approvals': <ContractManagement tenantId={currentTenant?.id} />,
      'payments': <TeacherPayments tenantId={currentTenant?.id} />,
      'pedagogical': <PedagogicalConfig user={user} tenantId={currentTenant?.id} />,
      'learning_paths_builder': <LearningPathsBuilder user={user} tenantId={currentTenant?.id} />,
      'class_skills': <ClassSkillsDashboard user={user} tenantId={currentTenant?.id} />,
      'msg_settings': <TeacherMessageSettings user={user} />,
      'tenant_advanced': <TenantAdvancedSettings user={user} tenantId={currentTenant?.id} />,
      'contracts': <ContractManagement tenantId={currentTenant?.id} />,
      'student-payments': <AdminPaymentsList tenantId={currentTenant?.id} />,
      'teacher_workflows': <TeacherWorkflows user={user} />,
      'admin_workflows': <AdminWorkflowsPanel user={user} tenantId={currentTenant?.id} />,
      'student_billing': <StudentBilling user={user} />,

      'settings_school': <TenantSettings tenant={currentTenant!} onUpdate={handleUpdateTenant} />,
      'crm': <CRMPage tenantId={currentTenant?.id || ''} />,
      'marketing': <LandingPageBuilder tenantId={currentTenant?.id || ''} />,
      'automation': <WhatsappConfig user={user} tenantId={currentTenant?.id} />,
      'lessons': <LessonLauncher user={user} tenantId={currentTenant?.id} onRefresh={loadAppData} />,
      'pending': <PendingLessons user={user} tenantId={currentTenant?.id} onRegister={() => setActiveTab('lessons')} onRefresh={loadAppData} />,
      'students': <StudentsList tenantId={currentTenant?.id} user={user} teachers={teachers} />,
      'teachers': <TeacherManagement
        teachers={teachers}
        currentTenantId={currentTenant?.id}
        onAddTeacher={(t) => setTeachers([...teachers, t])}
        onEditTeacher={(updated) => setTeachers(teachers.map(t => t.id === updated.id ? updated : t))}
        onViewTeacherSchedule={(name) => {
          setExplorerInitialState({ teacherName: name, autoAllocate: false });
          setActiveTab('schedule_explorer');
        }}
      />,
      'oral-tests': <OralTestsPanel user={user} tenantId={currentTenant?.id} />,
      'schedule_explorer': <TeacherScheduleExplorer
        user={user}
        teachers={activeTeachers}
        initialTeacherName={explorerInitialState?.teacherName}
        autoAllocate={explorerInitialState?.autoAllocate}
        reschedules={reschedules}
        currentTenantId={currentTenant?.id}
        onRefresh={loadAppData}
      />,
      'schedule': user.role === UserRole.STUDENT ?
        <StudentSchedule user={user} tenantId={currentTenant?.id} /> :
        <TeacherAvailabilityEditor teacherId={user.id} tenantId={currentTenant?.id} />,
      'invoices': <TeacherInvoices user={user} tenantId={currentTenant?.id} />,
      'lesson-planner-ai': <LessonPlannerAI user={user} tenantId={currentTenant?.id} />,
      'financial': user.role === UserRole.STUDENT ? <StudentBilling user={user} /> : <FinancialReport role={user.role} tenantId={currentTenant?.id} />,
      'billing': <SuperAdminDashboard />,
      'tenants': <SuperAdminDashboard />,
      'materials': user.role === UserRole.STUDENT ? <StudentPedagogicalView user={user} tenantId={currentTenant?.id} /> : <PedagogicalConfig user={user} tenantId={currentTenant?.id} />,
      'reschedules': <TeacherReschedules
        reschedules={reschedules}
        students={students}
        onAdd={async (data) => {
          const payload: any = {
            student_id: data.studentId,
            teacher_id: user.id,
            tenant_id: user.tenantId,
            date: data.date,
            time: data.time
          };
          if (data.id) payload.id = data.id;

          const { error } = await supabase.from('reschedules').upsert(payload);
          if (error) {
            console.error('Save Reschedule Error:', error);
            alert(`Erro ao salvar reposição: ${error.message}`);
          } else {
            // Automation: Send WhatsApp Confirmation
            const student = students.find(s => s.id === data.studentId);
            if (student && student.phone && data.date !== 'Pendente') {
              whatsappService.sendRescheduleConfirmation(
                user.tenantId,
                user.id,
                'default', // Instance Name (TODO: Fetch dynamically)
                student.full_name || student.name,
                student.phone,
                data.date,
                data.time
              );
            }
            loadAppData();
          }
        }}
        onDelete={async (id) => {
          const { error } = await supabase.from('reschedules').delete().eq('id', id);
          if (error) alert('Erro ao deletar: ' + error.message);
          else loadAppData();
        }}
      />,
      'evolution': <EvolutionView user={user} />,
      'profile': <TeacherProfile />,
      'meeting_links': <MeetingLinksView user={user} tenantId={currentTenant?.id} />,
      'teacher-financials': <TeacherFinancials user={user} tenantId={currentTenant?.id} />,
      'attendance-disputes': <AttendanceDisputes user={user} tenantId={currentTenant?.id} />,
      'trial-settlement': <TrialTrainingSettlement user={user} tenantId={currentTenant?.id} />,
      'student-insights': <StudentInsightsBoard user={user} tenantId={currentTenant?.id} />,
      'teacher-insights': <TeacherInsightsBoard user={user} tenantId={currentTenant?.id} />,
      'vendors-mgmt': <VendorManagement user={user} tenantId={currentTenant?.id} />,
      'referral-admin': <ReferralAdmin user={user} tenantId={currentTenant?.id} />,
      'cashflow': <CashflowPanel user={user} tenantId={currentTenant?.id} />,
      'ai-costs': <AiCostPanel />,
      'verify-rooms': <MeetingLinkVerifier />,
      'automations': <AutomationPanel user={user} tenantId={currentTenant?.id} />,
      'material-approvals': <MaterialApprovals user={user} tenantId={currentTenant?.id} />,
      'ai-tutor': <StudentAITutor user={user} />,
      'practice': <StudentPracticeHub userId={user.id} tenantId={currentTenant?.id} wolfieConfig={user.wolfieSettings} />,
      'wolfie-lab': <WolfieLab tenantId={currentTenant?.id} />,
      'trials': <TrialsToContracts tenantId={currentTenant?.id} user={user} />,
      'hr': <HRModule user={user} tenantId={currentTenant?.id} />,
      'training': user.role === UserRole.SCHOOL_ADMIN || user.role === UserRole.SUPER_ADMIN || (user as any).is_trainer
        ? <TrainingAdmin tenantId={currentTenant?.id || ''} currentUser={user} />
        : <TrainingView user={user} />,
      'referral': <AffiliatePanel user={user} />,
      'recruiting': <div className="max-w-2xl mx-auto py-6 space-y-4">
        <TeacherInviteGenerator tenantId={currentTenant?.id || ''} />
        <VendorInviteGenerator tenantId={currentTenant?.id || ''} />
      </div>,
      'contract_teacher': <PublicContractView id={user.id} />,

      // VENDEDOR tabs
      'vendor_dashboard': <VendorDashboard user={user} tenantId={currentTenant?.id} teachers={activeTeachers} onNavigate={setActiveTab} />,
      'vendor_schedule': <TeacherScheduleExplorer
        user={user}
        teachers={activeTeachers}
        reschedules={[]}
        currentTenantId={currentTenant?.id}
      />,
      'vendor_trial': <div className="max-w-3xl mx-auto py-6"><VendorTrialLinkGenerator user={user} tenantId={currentTenant?.id} teachers={activeTeachers} /></div>,
      'vendor_enrollment': <div className="max-w-3xl mx-auto py-6"><RegistrationLinkGenerator teachers={activeTeachers} tenantId={currentTenant?.id || ''} vendorId={user.id} /></div>,
      'vendor_commissions': <VendorDashboard user={user} tenantId={currentTenant?.id} teachers={activeTeachers} onNavigate={setActiveTab} />,
    };

    return contentMap[activeTab] || contentMap['dashboard'];
  };

  const currentBranding = currentTenant?.branding || {
    logoUrl: '',
    primaryColor: '#002366',
    secondaryColor: '#D32F2F',
    faviconUrl: ''
  };

  if (user.role === UserRole.SUPER_ADMIN) {
    return <SuperAdminDashboard onLogout={handleLogout} />;
  }

  const appLayout = (
    <div className={`app-shell flex h-dvh max-h-dvh w-full overflow-hidden ${theme === 'dark' ? 'dark' : ''}`}>
      <div className="flex h-full min-h-0 w-full overflow-hidden bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-sans">
        <ModernSidebar
          tenant={{ ...currentTenant, branding: currentBranding } as any}
          user={user}
          activeTab={activeTab}
          setActiveTab={(tab) => {
            setActiveTab(tab);
          }}
          pendingLessonsCount={pendingLessonsCount}
          pendingCounts={pendingCounts}
          onLogout={handleLogout}
          isOpen={isSidebarOpen}
          setIsOpen={setIsSidebarOpen}
          isCollapsed={isSidebarCollapsed}
          setIsCollapsed={setIsSidebarCollapsed}
          theme={theme}
          toggleTheme={toggleTheme}
          tenantMemberships={tenantMemberships}
          onTenantSwitch={handleTenantSwitch}
        />

        <main
          ref={mainScrollRef}
          tabIndex={-1}
          aria-label="Conteúdo principal"
          className={`
          app-main-scroll flex-1 flex flex-col min-w-0 min-h-0 h-full overflow-y-auto overflow-x-clip outline-none transition-all duration-300 ease-in-out
          ${isSidebarCollapsed ? 'lg:ml-0' : 'lg:ml-0'} 
        `}>
          {/* Top Header inside main */}
          <header className="sticky top-0 z-40 w-full bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-gray-200 dark:border-gray-800">
            <div className="flex h-16 items-center justify-between px-3 sm:px-6">

              {/* Mobile Toggle */}
              <div className="flex items-center gap-2 lg:hidden min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => setIsSidebarOpen(true)}
                  className="p-2 -ml-1 shrink-0 text-gray-600 dark:text-gray-400"
                  aria-label="Abrir menu"
                  aria-controls="app-primary-navigation"
                  aria-expanded={isSidebarOpen}
                >
                  <Menu size={22} />
                </button>
                <span className="font-bold text-sm text-gray-800 dark:text-white truncate">
                  {currentTenant?.name || 'EduCore'}
                </span>
              </div>

              {/* Left side (Breadcrumbs or Page Title) */}
              <div className="hidden lg:block">
                <h2 className="text-lg font-bold text-gray-800 dark:text-gray-100 capitalize">
                  {(() => {
                    const titles: Record<string, string> = {
                      'dashboard': 'Dashboard',
                      'lessons': 'Lançar Aula',
                      'pending': 'Aulas Pendentes',
                      'meeting_links': 'Links de Reunião',
                      'students': 'Alunos',
                      'lesson-planner-ai': 'Planejador IA',
                      'schedule': 'Agenda',
                      'invoices': 'Notas Fiscais',
                      'teacher-financials': 'Financeiro',
                      'reschedules': 'Reposições',
                      'pedagogical': 'Pedagógico',
                      'materials': 'Materiais',
                      'financial': 'Financeiro',
                      'ai-tutor': 'Praticar com o Wolfie',
                      'practice': 'Minhas Trilhas',
                      'automation': 'Automação',
                      'evolution': 'Evolução',
                      'teachers': 'Professores',
                      'oral-tests': 'Testes Orais',
                      'schedule_explorer': 'Explorador de Agenda',
                      'approvals': 'Acolhimento (Docs)',
                      'payments': 'Pagamentos',
                      'settings_school': 'Configurações da Escola',
                      'crm': 'CRM & Vendas',
                      'marketing': 'Páginas & Marketing',
                      'hr': 'Recursos Humanos',
                      'tenants': 'Tenants',
                      'billing': 'Faturamento',
                      'settings': 'Configurações',
                      'profile': 'Meu Perfil',
                      'referral': 'Indicações & Afiliação',
                      'recruiting': 'Recrutamento'
                    };
                    return titles[activeTab] || activeTab.replace('_', ' ');
                  })()}
                </h2>
              </div>

              {/* Right side actions */}
              <div className="flex items-center gap-1 sm:gap-4 shrink-0">
                <div ref={searchContainerRef} className="hidden md:block relative group">
                  <label htmlFor="app-header-search" className="sr-only">
                    Buscar uma tela do sistema
                  </label>
                  <Search
                    aria-hidden="true"
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4 group-focus-within:text-blue-500 transition-colors"
                  />
                  <input
                    ref={searchInputRef}
                    id="app-header-search"
                    type="search"
                    value={searchQuery}
                    placeholder="Buscar uma tela..."
                    autoComplete="off"
                    role="combobox"
                    aria-autocomplete="list"
                    aria-controls="app-header-search-results"
                    aria-expanded={searchOpen}
                    aria-activedescendant={
                      searchOpen && filteredSearchItems[searchActiveIndex]
                        ? `app-search-option-${filteredSearchItems[searchActiveIndex].tab}`
                        : undefined
                    }
                    onFocus={() => setSearchOpen(true)}
                    onChange={(event) => {
                      setSearchQuery(event.target.value);
                      setSearchOpen(true);
                    }}
                    onKeyDown={handleSearchKeyDown}
                    className="pl-9 pr-9 py-2 bg-gray-100 dark:bg-slate-800 rounded-full text-sm border-none focus:ring-2 focus:ring-blue-500/50 w-64 transition-all"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => {
                        setSearchQuery('');
                        setSearchOpen(true);
                        searchInputRef.current?.focus();
                      }}
                      className="absolute right-1 top-1/2 -translate-y-1/2 grid size-8 place-content-center rounded-full text-gray-400 hover:bg-gray-200 dark:hover:bg-slate-700 hover:text-gray-700 dark:hover:text-gray-100"
                      aria-label="Limpar busca"
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  )}

                  {searchOpen && (
                    <div
                      id="app-header-search-results"
                      role="listbox"
                      aria-label="Telas disponíveis"
                      className="absolute left-0 right-0 top-full mt-2 max-h-80 overflow-y-auto rounded-2xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-2 shadow-2xl z-[60]"
                    >
                      {filteredSearchItems.length === 0 ? (
                        <p role="status" className="px-3 py-5 text-center text-sm text-gray-500 dark:text-slate-400">
                          Nenhuma tela encontrada.
                        </p>
                      ) : (
                        filteredSearchItems.map((item, index) => (
                          <button
                            type="button"
                            id={`app-search-option-${item.tab}`}
                            key={item.tab}
                            role="option"
                            aria-selected={index === searchActiveIndex}
                            onMouseEnter={() => setSearchActiveIndex(index)}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => navigateFromSearch(item)}
                            className={`w-full rounded-xl px-3 py-2.5 text-left transition-colors ${
                              index === searchActiveIndex
                                ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300'
                                : 'text-gray-700 hover:bg-gray-50 dark:text-slate-200 dark:hover:bg-slate-800'
                            }`}
                          >
                            <span className="block text-sm font-bold">{item.label}</span>
                            <span className="block text-[10px] uppercase tracking-wider text-gray-400 dark:text-slate-500">
                              {item.group}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>

                {canSeeDirectorNotifications && (<>
                <button
                  ref={notifButtonRef}
                  type="button"
                  onClick={() => {
                    if (notifOpen) closeNotifications(false);
                    else setNotifOpen(true);
                  }}
                  className="relative p-2 rounded-full hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-600 dark:text-gray-400 transition-colors"
                  aria-label={
                    notificationTotal > 0
                      ? `Notificações, ${notificationTotal} ${notificationTotal === 1 ? 'pendência' : 'pendências'}`
                      : 'Notificações, nenhuma pendência'
                  }
                  aria-haspopup="dialog"
                  aria-expanded={notifOpen}
                  aria-controls="app-notifications-panel"
                >
                  <Bell className="w-5 h-5" aria-hidden="true" />
                  {notificationTotal > 0 && (
                    <span
                      aria-hidden="true"
                      className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 flex items-center justify-center bg-red-500 text-white text-[10px] font-black rounded-full border-2 border-white dark:border-slate-900"
                    >
                      {notificationTotal > 99 ? '99+' : notificationTotal}
                    </span>
                  )}
                </button>

                {notifOpen && createPortal(
                  <>
                    <button
                      type="button"
                      className="fixed inset-0 z-[110] cursor-default bg-black/10 sm:bg-transparent"
                      aria-label="Fechar notificações"
                      tabIndex={-1}
                      onClick={() => closeNotifications()}
                    />
                    <div
                      ref={notifPanelRef}
                      id="app-notifications-panel"
                      role="dialog"
                      aria-modal="true"
                      aria-labelledby="app-notifications-title"
                      tabIndex={-1}
                      style={{
                        top: notifPosition.top,
                        left: notifPosition.left,
                        width: notifPosition.width,
                        maxHeight: `calc(100dvh - ${notifPosition.top + 12}px)`,
                      }}
                      className="fixed z-[120] flex flex-col overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-2xl outline-none dark:border-slate-800 dark:bg-slate-900"
                    >
                      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-gray-100 px-4 py-3 dark:border-slate-800">
                        <div className="min-w-0">
                          <h2 id="app-notifications-title" className="font-black text-sm text-gray-800 dark:text-slate-100">
                            Pendências
                          </h2>
                          {notificationTotal > 0 && (
                            <p className="text-[10px] font-bold text-red-500">
                              {notificationTotal} aguardando ação
                            </p>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => closeNotifications()}
                          className="grid size-9 shrink-0 place-content-center rounded-full text-gray-500 hover:bg-gray-100 hover:text-gray-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                          aria-label="Fechar notificações"
                        >
                          <X size={16} aria-hidden="true" />
                        </button>
                      </div>
                      {activeNotifications.length === 0 ? (
                        <div className="overflow-y-auto px-4 py-8 text-center text-sm text-gray-400">
                          🎉 Tudo em dia! Nenhuma pendência.
                        </div>
                      ) : (
                        <div className="min-h-0 overflow-y-auto overscroll-contain">
                          {activeNotifications.map((item) => (
                            <button
                              type="button"
                              key={item.key}
                              onClick={() => {
                                setActiveTab(item.tab);
                                setIsSidebarOpen(false);
                                closeNotifications(false);
                                window.requestAnimationFrame(() => mainScrollRef.current?.focus({ preventScroll: true }));
                              }}
                              className="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-slate-800 text-left transition-colors border-b border-gray-50 dark:border-slate-800/50 last:border-0"
                            >
                              <span className="text-sm text-gray-700 dark:text-slate-200">{item.label}</span>
                              <span
                                aria-label={`${pendingCounts[item.key]} pendências`}
                                className="shrink-0 min-w-[22px] h-[22px] px-1.5 flex items-center justify-center bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-300 text-xs font-black rounded-full"
                              >
                                {pendingCounts[item.key]}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </>,
                  document.body
                )}
                </>)}

                <button
                  type="button"
                  onClick={toggleTheme}
                  className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-600 dark:text-gray-400 transition-colors"
                  aria-label={theme === 'light' ? 'Ativar tema escuro' : 'Ativar tema claro'}
                  title={theme === 'light' ? 'Ativar tema escuro' : 'Ativar tema claro'}
                >
                  {theme === 'light'
                    ? <Moon className="w-5 h-5" aria-hidden="true" />
                    : <Sun className="w-5 h-5" aria-hidden="true" />}
                </button>

                <div className="hidden sm:block h-8 w-[1px] bg-gray-200 dark:bg-gray-700 mx-2" />

                <div className="flex items-center gap-3">
                  <div className="text-right hidden md:block">
                    <p className="text-sm font-bold text-gray-900 dark:text-gray-100 leading-none">{user.name}</p>
                    <p className="text-left text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wide mt-1">
                      {(() => {
                        const roles: Record<string, string> = {
                          'SUPER_ADMIN': 'Super Admin',
                          'SCHOOL_ADMIN': 'Diretor',
                          'TEACHER': 'Professor',
                          'STUDENT': 'Aluno'
                        };
                        return roles[user.role] || user.role;
                      })()}
                    </p>
                  </div>
                  <div className="w-9 h-9 rounded-full bg-gradient-to-tr from-blue-500 to-purple-500 p-[2px]">
                    <img src={user.avatar} className="w-full h-full rounded-full object-cover border-2 border-white dark:border-slate-900" alt="Avatar" />
                  </div>
                </div>
              </div>
            </div>
          </header>

          <div className="p-4 md:p-6 lg:p-8 flex-1 min-h-0 overflow-x-clip">
            <div className={`mx-auto w-full animate-in fade-in slide-in-from-bottom-4 duration-500 ${['schedule_explorer', 'schedule', 'reschedules'].includes(activeTab) ? 'max-w-full px-2' : 'max-w-7xl'}`}>
              <Suspense fallback={
                <div className="flex flex-col items-center justify-center min-h-[400px] gap-4 w-full">
                  <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                  <p className="text-gray-500 font-medium animate-pulse">Carregando módulo...</p>
                </div>
              }>
                {renderContent()}
              </Suspense>
            </div>
          </div>

        </main>
      </div>
      {(user.role === UserRole.SCHOOL_ADMIN || user.role === UserRole.SUPER_ADMIN) && <SmartFinder user={user} />}
    </div>
  );

  if (user.role === UserRole.STUDENT) {
    return (
      <StudentProvider userId={user.id} tenantId={user.tenantId} onLogout={handleLogout}>
        {appLayout}
      </StudentProvider>
    );
  }

  return appLayout;
};

export default App;
