import React, { useState, useEffect, lazy, Suspense } from 'react';
import { whatsappService } from './services/whatsappService';
import { supabase } from './lib/supabase';
import { MOCK_TENANTS, MOCK_STUDENTS_LIST } from './constants';
import { UserRole, Tenant, User, Teacher, Reschedule } from './types';
import { Menu, X, Sun, Moon, Bell, Search, User as UserIcon, Shield, LogOut, Loader2 } from 'lucide-react';

// Lazy Load Components
const TeacherDashboard = lazy(() => import('./components/TeacherDashboard'));
const LessonLauncher = lazy(() => import('./components/LessonLauncher'));
const StudentsList = lazy(() => import('./components/StudentsList'));
const AvailabilityHeatmap = lazy(() => import('./components/AvailabilityHeatmap'));
const FinancialReport = lazy(() => import('./components/FinancialReport'));
const SuperAdminDashboard = lazy(() => import('./components/SuperAdminDashboard'));
const PendingLessons = lazy(() => import('./components/PendingLessons'));
const TeacherAvailabilityEditor = lazy(() => import('./components/TeacherAvailabilityEditor'));
const TeacherScheduleExplorer = lazy(() => import('./components/TeacherScheduleExplorer'));
const SchoolAdminDashboard = lazy(() => import('./components/SchoolAdminDashboard'));
const InvoiceManager = lazy(() => import('./components/InvoiceManager'));
const PedagogicalConfig = lazy(() => import('./components/PedagogicalConfig'));
const TenantSettings = lazy(() => import('./components/TenantSettings'));
const StudentBilling = lazy(() => import('./components/StudentBilling'));
const TeacherInvoices = lazy(() => import('./components/TeacherInvoices'));
const TeacherPayments = lazy(() => import('./components/TeacherPayments'));
const LessonPlannerAI = lazy(() => import('./components/LessonPlannerAI'));
const StudentDashboard = lazy(() => import('./components/StudentDashboard'));
const StudentSchedule = lazy(() => import('./components/StudentSchedule'));
const EvolutionView = lazy(() => import('./components/EvolutionView'));
const TeacherProfile = lazy(() => import('./components/TeacherProfile'));
const TeacherReschedules = lazy(() => import('./components/TeacherReschedules'));
const TeacherManagement = lazy(() => import('./components/TeacherManagement'));
const MeetingLinksView = lazy(() => import('./components/MeetingLinksView'));
const TeacherFinancials = lazy(() => import('./components/TeacherFinancials'));
const StudentMaterials = lazy(() => import('./components/StudentMaterials'));
const StudentPedagogicalView = lazy(() => import('./components/StudentPedagogicalView'));
const WhatsappConfig = lazy(() => import('./components/WhatsappConfig'));
const CRMPage = lazy(() => import('./components/CRMPage'));
const LandingPageBuilder = lazy(() => import('./components/LandingPageBuilder'));
const SaasLandingPage = lazy(() => import('./components/landing/SaasLandingPage'));
const StudentLandingTemplate = lazy(() => import('./components/landing/StudentLandingTemplate'));
const PublicRegistration = lazy(() => import('./components/PublicRegistration'));
const TeacherOnboarding = lazy(() => import('./components/TeacherOnboarding'));
const SuspensionPage = lazy(() => import('./components/SuspensionPage'));
const SmartFinder = lazy(() => import('./components/SmartFinder'));
const ClaimOpportunity = lazy(() => import('./components/ClaimOpportunity'));
const WolfieTutor = lazy(() => import('./components/WolfieTutor'));
const WolfieLab = lazy(() => import('./components/WolfieLab'));
const TrialsToContracts = lazy(() => import('./components/TrialsToContracts'));
const StudentAITutor = lazy(() => import('./src/pages/student/StudentAITutor'));
const HRModule = lazy(() => import('./components/HRModule'));
const TeacherTrainingAdmin = lazy(() => import('./components/training/TeacherTrainingAdmin'));
const TeacherTrainingView = lazy(() => import('./components/training/TeacherTrainingView'));
const ManualTrialScheduler = lazy(() => import('./components/ManualTrialScheduler'));
const AffiliatePanel = lazy(() => import('./components/AffiliatePanel'));
const TeacherInviteGenerator = lazy(() => import('./components/TeacherInviteGenerator'));
const PublicContractView = lazy(() => import('./components/PublicContractView'));

// Static Components (Core UI)
import ModernSidebar from './components/ModernSidebar';
import Login from './components/Login';
import ProtectedRoute from './components/ProtectedRoute';
import { StudentProvider } from './components/contexts/StudentContext';
import NotificationCenter, { Notification } from './components/NotificationCenter';

const App: React.FC = () => {
  const [user, setUser] = useState<User | null>(null);
  const [currentTenant, setCurrentTenant] = useState<Tenant | null>(null);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false); // Mobile
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false); // Desktop

  const [explorerInitialState, setExplorerInitialState] = useState<{ teacherName?: string, autoAllocate?: boolean } | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    return (localStorage.getItem('theme') as 'light' | 'dark') ||
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  });

  // State for Real Data
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [reschedules, setReschedules] = useState<Reschedule[]>([]);
  const [students, setStudents] = useState<any[]>([]); // Cache students for selection
  const [pendingLessonsCount, setPendingLessonsCount] = useState(0);

  // Loading State
  const [isLoading, setIsLoading] = useState(false);

  // Notifications State
  const [showNotifications, setShowNotifications] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([
    {
      id: '1',
      title: 'Bem-vindo ao Novo Portal 🐺',
      description: 'Sua interface Wise Wolf foi atualizada com melhorias de velocidade e design premium.',
      type: 'info',
      timestamp: 'Agora',
      isRead: false
    },
    {
      id: '2',
      title: 'Mês de Março Encerrado',
      description: 'As pendências de março foram zeradas conforme a política de fechamento mensal.',
      type: 'success',
      timestamp: 'Há 2h',
      isRead: true
    },
    {
      id: '3',
      title: 'Lançamento de Aulas',
      description: 'Não esqueça de lançar suas aulas de hoje para manter seu faturamento em dia.',
      type: 'urgent',
      timestamp: 'Hoje',
      isRead: false
    }
  ]);

  // Fetch Initial Data on Login
  const loadAppData = async () => {
    if (!user || !user.tenantId) return;
    setIsLoading(true);
    try {
      // 1. Setup Tenant Branding
      if (user.tenantId !== 'master') {
        const { data: tenantData } = await supabase.from('tenants').select('*').eq('id', user.tenantId).single();
        if (tenantData) {
          setCurrentTenant({
            id: tenantData.id,
            name: tenantData.name,
            domain: tenantData.domain,
            branding: tenantData.branding,
            studentLimit: tenantData.student_limit,
            teacherLimit: tenantData.teacher_limit,
            whatsapp_api_url: tenantData.whatsapp_api_url,
            whatsapp_api_key: tenantData.whatsapp_api_key,
            whatsapp_enabled: tenantData.whatsapp_enabled
          });
          document.documentElement.style.setProperty('--primary-color', tenantData.branding.primaryColor);
          document.documentElement.style.setProperty('--secondary-color', tenantData.branding.secondaryColor);
          document.title = `${tenantData.name} - Portal EduCore`;
        }
      }

      // 2. Fetch Teachers
      const { data: teachersData } = await supabase
        .from('profiles')
        .select('*')
        .eq('role', 'TEACHER')
        .eq('tenant_id', user.tenantId);

      // 3. Fetch Students
      const { data: studentsData } = await supabase
        .from('profiles')
        .select('*')
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
            hourlyRate: t.hourly_rate || 50,
            pixKey: t.pix_key || '',
            phone: t.phone || '',
            studentsCount: uniqueStudents.size,
            classesCount: teacherBookings.length,
            retention: '100%',
            tpi: 100,
            status: 'Ativo',
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
          .select('booking_id, reschedule_id, student_id, class_date')
          .eq('teacher_id', user.id)
          .gte('class_date', threeDaysAgo.toISOString().split('T')[0]);

        const daysOfWeek = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
        let count = 0;

        for (let i = 1; i <= 30; i++) {
          const checkDate = new Date();
          checkDate.setDate(now.getDate() - i);
          const dayName = daysOfWeek[checkDate.getDay()];
          const dateStr = checkDate.toISOString().split('T')[0];
          
          if (checkDate.getMonth() !== now.getMonth() || checkDate.getFullYear() !== now.getFullYear()) {
            continue;
          }

          if (dayName === 'Domingo') continue;

          const { data: bks } = await supabase.from('bookings').select('id, time_slot, student_id, start_date').eq('teacher_id', user.id).eq('day_of_week', dayName);
          bks?.forEach(b => {
            if (b.start_date && dateStr < b.start_date) return;

            const hasLog = logs?.some(l => {
              return (l.booking_id && String(l.booking_id) === String(b.id) && l.class_date === dateStr) ||
                (String(l.student_id) === String(b.student_id) && l.class_date === dateStr);
            });
            if (!hasLog) count++;
          });

          const { data: rps } = await supabase.from('reschedules').select('id, time, student_id').eq('teacher_id', user.id).eq('date', dateStr);
          rps?.forEach(r => {
            const hasLog = logs?.some(l =>
              (l.reschedule_id && String(l.reschedule_id) === String(r.id)) // Reschedules are unique per date/ID by design
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

  const handleLogout = () => {
    setUser(null);
    setCurrentTenant(null);
    setActiveTab('dashboard');
    setIsSidebarOpen(false);
    setExplorerInitialState(null);
    document.documentElement.style.setProperty('--primary-color', '#002366');
    document.documentElement.style.setProperty('--secondary-color', '#D32F2F');
  };

  // --- ROUTING LOGIC (Simple Client-Side Router) ---
  const path = window.location.pathname;

  if (path === '/claim-opportunity') {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('id');
    return <ClaimOpportunity opportunityId={id} />;
  }

  if (path === '/new-saas') {
    return <SaasLandingPage />;
  }

  if (path === '/new-student') {
    return <StudentLandingTemplate />;
  }

  if (path === '/matricula') {
    return <PublicRegistration />;
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
  // --------------------------------------------------

  if (!user) {
    return <Login onLogin={setUser} />;
  }

  // --- FINANCIAL LOCK MOVED TO ProtectedRoute.tsx ---

  const handleUpdateTenant = (newBranding: any) => {
    if (currentTenant) {
      setCurrentTenant({ ...currentTenant, branding: newBranding });
      document.documentElement.style.setProperty('--primary-color', newBranding.primaryColor);
      document.documentElement.style.setProperty('--secondary-color', newBranding.secondaryColor);
    }
  };

  const renderContent = () => {
    // SECURITY GUARD: Strict Student Access Check
    if (user.role === UserRole.STUDENT) {
      const allowedStudentTabs = ['dashboard', 'ai-tutor', 'schedule', 'meeting_links', 'materials', 'financial', 'evolution', 'profile', 'referral'];
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

    const contentMap: Record<string, React.ReactNode> = {
      'dashboard': user.role === UserRole.SUPER_ADMIN ? <SuperAdminDashboard /> :
        user.role === UserRole.SCHOOL_ADMIN ?
          <SchoolAdminDashboard
            teachers={teachers}
            tenantId={currentTenant?.id}
            userRole={user.role}
            onViewTeacherSchedule={(name) => {
              setExplorerInitialState({ teacherName: name, autoAllocate: false });
              setActiveTab('schedule_explorer');
            }}
          /> :
          user.role === UserRole.STUDENT ? <StudentDashboard user={user} tenantId={currentTenant?.id} /> :
            <TeacherDashboard user={user} tenantId={currentTenant?.id} onNavigate={(tab) => { setActiveTab(tab); setIsSidebarOpen(false); }} />,

      'approvals': <InvoiceManager tenantId={currentTenant?.id} />,
      'payments': <TeacherPayments tenantId={currentTenant?.id} />,
      'pedagogical': <PedagogicalConfig user={user} tenantId={currentTenant?.id} />,
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
      'schedule_explorer': <TeacherScheduleExplorer
        user={user}
        teachers={teachers}
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
      'ai-tutor': <StudentAITutor user={user} />,
      'wolfie-lab': <WolfieLab tenantId={currentTenant?.id} />,
      'trials': <TrialsToContracts tenantId={currentTenant?.id} user={user} />,
      'hr': <HRModule user={user} tenantId={currentTenant?.id} />,
      'training': user.role === UserRole.SCHOOL_ADMIN || user.role === UserRole.SUPER_ADMIN || user.is_trainer
        ? <TeacherTrainingAdmin tenantId={currentTenant?.id || ''} currentUser={user} />
        : <TeacherTrainingView tenantId={currentTenant?.id || ''} teacherId={user.id} />,
      'referral': <AffiliatePanel user={user} />,
      'recruiting': <div className="max-w-md mx-auto py-10"><TeacherInviteGenerator tenantId={currentTenant?.id || ''} /></div>,
      'contract_teacher': <PublicContractView id={user.id} />,
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
    <div className={`flex min-h-screen w-full ${theme === 'dark' ? 'dark' : ''}`}>
      <div className="flex w-full bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-sans">
        <ModernSidebar
          tenant={{ ...currentTenant, branding: currentBranding } as any}
          user={user}
          activeTab={activeTab}
          setActiveTab={(tab) => {
            setActiveTab(tab);
          }}
          pendingLessonsCount={pendingLessonsCount}
          onLogout={handleLogout}
          isOpen={isSidebarOpen}
          setIsOpen={setIsSidebarOpen}
          isCollapsed={isSidebarCollapsed}
          setIsCollapsed={setIsSidebarCollapsed}
          theme={theme}
          toggleTheme={toggleTheme}
        />

        <main className={`
          flex-1 flex flex-col min-w-0 transition-all duration-300 ease-in-out
          ${isSidebarCollapsed ? 'lg:ml-0' : 'lg:ml-0'} 
        `}>
          {/* Top Header inside main */}
          <header className="sticky top-0 z-40 w-full bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-gray-200 dark:border-gray-800">
            <div className="flex h-16 items-center justify-between px-6">

              {/* Mobile Toggle */}
              <div className="flex items-center gap-4 lg:hidden">
                <button onClick={() => setIsSidebarOpen(true)} className="p-2 text-gray-600 dark:text-gray-400">
                  <Menu size={20} />
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
                      'automation': 'Automação',
                      'evolution': 'Evolução',
                      'teachers': 'Professores',
                      'schedule_explorer': 'Explorador de Agenda',
                      'approvals': 'Aprovações',
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
              <div className="flex items-center gap-4">
                {/* Search - Visual only for now */}
                <div className="hidden md:flex relative group">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4 group-focus-within:text-blue-500 transition-colors" />
                  <input
                    type="text"
                    placeholder="Buscar..."
                    className="pl-9 pr-4 py-2 bg-gray-100 dark:bg-slate-800 rounded-full text-sm border-none focus:ring-2 focus:ring-blue-500/50 w-64 transition-all"
                  />
                </div>

                <div className="relative">
                  <button 
                    onClick={() => setShowNotifications(!showNotifications)}
                    className={`relative p-2 rounded-full transition-colors ${showNotifications ? 'bg-indigo-50 dark:bg-indigo-900/20 text-tenant-primary' : 'hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-600 dark:text-gray-400'}`}
                  >
                    <Bell className="w-5 h-5" />
                    {notifications.some(n => !n.isRead) && (
                      <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-red-500 rounded-full border-2 border-white dark:border-slate-900" />
                    )}
                  </button>

                  {showNotifications && (
                    <NotificationCenter 
                      notifications={notifications}
                      onClose={() => setShowNotifications(false)}
                      onMarkAsRead={(id) => setNotifications(notifications.map(n => n.id === id ? { ...n, isRead: true } : n))}
                      onClearAll={() => setNotifications([])}
                    />
                  )}
                </div>

                <button onClick={toggleTheme} className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-600 dark:text-gray-400 transition-colors">
                  {theme === 'light' ? <Moon className="w-5 h-5" /> : <Sun className="w-5 h-5" />}
                </button>

                <div className="h-8 w-[1px] bg-gray-200 dark:bg-gray-700 mx-2" />

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

          <div className="p-4 md:p-6 lg:p-8 flex-1 overflow-x-hidden">
            <div className="mx-auto w-full max-w-7xl animate-in fade-in slide-in-from-bottom-4 duration-500">
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
      <StudentProvider userId={user.id}>
        {appLayout}
      </StudentProvider>
    );
  }

  return appLayout;
};

export default App;
