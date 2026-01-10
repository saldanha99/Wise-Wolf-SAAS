
import React, { useState, useEffect } from 'react';
import { whatsappService } from './services/whatsappService';
import { supabase } from './lib/supabase';
import ModernSidebar from './components/ModernSidebar'; // New Sidebar
import Login from './components/Login';
import TeacherDashboard from './components/TeacherDashboard';
import LessonLauncher from './components/LessonLauncher';
import StudentsList from './components/StudentsList';
import AvailabilityHeatmap from './components/AvailabilityHeatmap';
import FinancialReport from './components/FinancialReport';
import SuperAdminDashboard from './components/SuperAdminDashboard';
import PendingLessons from './components/PendingLessons';
import TeacherAvailabilityEditor from './components/TeacherAvailabilityEditor';
import TeacherScheduleExplorer from './components/TeacherScheduleExplorer';
import SchoolAdminDashboard from './components/SchoolAdminDashboard';
import InvoiceManager from './components/InvoiceManager';
import PedagogicalConfig from './components/PedagogicalConfig';
import TenantSettings from './components/TenantSettings';
import StudentBilling from './components/StudentBilling';
import TeacherInvoices from './components/TeacherInvoices';
import TeacherPayments from './components/TeacherPayments';
import LessonPlannerAI from './components/LessonPlannerAI';
import StudentDashboard from './components/StudentDashboard';
import StudentSchedule from './components/StudentSchedule';
import EvolutionView from './components/EvolutionView';
import TeacherProfile from './components/TeacherProfile';
import TeacherReschedules from './components/TeacherReschedules';
import TeacherManagement from './components/TeacherManagement';
import MeetingLinksView from './components/MeetingLinksView';
import TeacherFinancials from './components/TeacherFinancials';
import StudentMaterials from './components/StudentMaterials';
import StudentPedagogicalView from './components/StudentPedagogicalView';
import WhatsappConfig from './components/WhatsappConfig';
import MarketingManager from './components/marketing/MarketingManager';
import { MOCK_TENANTS, MOCK_STUDENTS_LIST } from './constants';
import { UserRole, Tenant, User, Teacher, Reschedule } from './types';
import { Menu, X, Sun, Moon, Bell, Search, User as UserIcon } from 'lucide-react';
import SaasLandingPage from './components/landing/SaasLandingPage';
import StudentLandingTemplate from './components/landing/StudentLandingTemplate';

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

      if (studentsData) {
        setStudents(studentsData.map(s => ({
          id: s.id,
          name: s.full_name,
          module: s.module || 'N/A',
          currentBookPart: s.current_book_part,
          evaluationUnlocked: s.evaluation_unlocked
        })));
      }

      // 4. Fetch All Bookings
      const { data: allBookings } = await supabase
        .from('bookings')
        .select('teacher_id, student_id')
        .eq('tenant_id', user.tenantId);

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
      const { data: reschedulesData } = await supabase
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

  if (path === '/new-saas') {
    return <SaasLandingPage />;
  }

  if (path === '/new-student') {
    return <StudentLandingTemplate />;
  }
  // --------------------------------------------------

  if (!user) {
    return <Login onLogin={setUser} />;
  }

  const handleUpdateTenant = (newBranding: any) => {
    if (currentTenant) {
      setCurrentTenant({ ...currentTenant, branding: newBranding });
      document.documentElement.style.setProperty('--primary-color', newBranding.primaryColor);
      document.documentElement.style.setProperty('--secondary-color', newBranding.secondaryColor);
    }
  };

  const renderContent = () => {
    const contentMap: Record<string, React.ReactNode> = {
      'dashboard': user.role === UserRole.SUPER_ADMIN ? <SuperAdminDashboard /> :
        user.role === UserRole.SCHOOL_ADMIN ?
          <SchoolAdminDashboard
            teachers={teachers}
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
      'marketing': <MarketingManager tenantId={currentTenant?.id || ''} />,
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
      'evolution': <EvolutionView />,
      'profile': <TeacherProfile />,
      'meeting_links': <MeetingLinksView user={user} tenantId={currentTenant?.id} />,
      'teacher-financials': <TeacherFinancials user={user} tenantId={currentTenant?.id} />,
    };

    return contentMap[activeTab] || contentMap['dashboard'];
  };

  const currentBranding = currentTenant?.branding || {
    logoUrl: '',
    primaryColor: '#002366',
    secondaryColor: '#D32F2F',
    faviconUrl: ''
  };

  return (
    <div className={`flex min-h-screen w-full ${theme === 'dark' ? 'dark' : ''}`}>
      <div className="flex w-full bg-gradient-to-br from-slate-50 to-purple-50 dark:from-slate-950 dark:to-slate-900 text-slate-900 dark:text-slate-100 font-sans">

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
                      'marketing': 'Site & Vendas',
                      'tenants': 'Tenants',
                      'billing': 'Faturamento',
                      'settings': 'Configurações',
                      'profile': 'Meu Perfil'
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

                <button className="relative p-2 rounded-full hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-600 dark:text-gray-400 transition-colors">
                  <Bell className="w-5 h-5" />
                  <span className="absolute top-1 right-1 w-2.5 h-2.5 bg-red-500 rounded-full border-2 border-white dark:border-slate-900" />
                </button>

                <button onClick={toggleTheme} className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-600 dark:text-gray-400 transition-colors">
                  {theme === 'light' ? <Moon className="w-5 h-5" /> : <Sun className="w-5 h-5" />}
                </button>

                <div className="h-8 w-[1px] bg-gray-200 dark:bg-gray-700 mx-2" />

                <div className="flex items-center gap-3">
                  <div className="text-right hidden md:block">
                    <p className="text-sm font-bold text-gray-900 dark:text-gray-100 leading-none">{user.name}</p>
                    <p className="text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wide mt-1">
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

          <div className="p-6 md:p-8 flex-1 overflow-x-hidden">
            <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-7xl mx-auto">
              {renderContent()}
            </div>
          </div>

        </main>
      </div>
    </div>
  );
};

export default App;
