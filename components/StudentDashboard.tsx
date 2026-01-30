import React, { useState, useEffect } from 'react';
import { Video, BookOpen, Clock, Star, TrendingUp, Sparkles, Download, CreditCard, ChevronRight, CheckCircle, RefreshCw, Target, Zap, Award, Medal, MessageSquareText, FileText, X } from 'lucide-react';
import { getPedagogicalSuggestion } from '../services/geminiService';
import { supabase } from '../lib/supabase';
import { User as UserType } from '../types';
import GamificationHeader from './GamificationHeader';
import ContractView from './ContractView';
import { gamificationService } from '../services/gamificationService';
import confetti from 'canvas-confetti';
import { PEDAGOGICAL_BOOKS } from '../constants';

interface StudentDashboardProps {
  user: UserType;
  tenantId?: string;
}

const StudentDashboard: React.FC<StudentDashboardProps> = ({ user, tenantId }) => {
  const [suggestion, setSuggestion] = useState<string>('Carregando sua dica personalizada...');
  const [loading, setLoading] = useState(true);
  const [nextClass, setNextClass] = useState<any>(null);
  const [profile, setProfile] = useState<any>(null);
  const [recentLogs, setRecentLogs] = useState<any[]>([]);
  const [leaderboard, setLeaderboard] = useState<any[]>([]);
  const [assignedTeacher, setAssignedTeacher] = useState<any>(null);
  const [showContract, setShowContract] = useState(false);

  // Calculate time diff for "Smart Action"
  const [minutesToClass, setMinutesToClass] = useState<number | null>(null);

  useEffect(() => {
    if (user) {
      fetchStudentData();
    }
  }, [user]);

  useEffect(() => {
    if (nextClass && nextClass.rawDate) {
      const diff = new Date(nextClass.rawDate).getTime() - new Date().getTime();
      const mins = Math.floor(diff / 1000 / 60);
      setMinutesToClass(mins);
    }
  }, [nextClass]);

  const fetchStudentData = async () => {
    setLoading(true);
    try {
      // 1. Fetch Profile
      const { data: prof } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .single();
      setProfile(prof);

      // Resolve Tenant ID (Prop or Profile)
      const effectiveTenantId = tenantId || prof?.tenant_id;

      // 2. Fetch Next Class
      const DAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
      const todayDay = DAYS[new Date().getDay()];

      const { data: bookings } = await supabase
        .from('bookings')
        .select(`
          id, time_slot, day_of_week,
          teacher:teacher_id(id, full_name, phone, avatar_url)
        `)
        .eq('student_id', user.id);

      if (bookings && bookings.length > 0) {
        setAssignedTeacher(bookings[0].teacher);

        const now = new Date();
        const curH = now.getHours();
        const curM = now.getMinutes();

        const todayBookings = bookings.filter(b => b.day_of_week === todayDay);
        // Sort by time
        const upcoming = todayBookings.filter(b => {
          const [h, m] = (b as any).time_slot.split(':').map(Number);
          return h > curH || (h === curH && m > curM);
        }).sort((a, b) => (a as any).time_slot.localeCompare((b as any).time_slot))[0];

        if (upcoming) {
          // Construct Date Object for Countdown
          const [h, m] = (upcoming as any).time_slot.split(':').map(Number);
          const classDate = new Date();
          classDate.setHours(h, m, 0, 0);

          setNextClass({
            time: (upcoming as any).time_slot,
            teacher: (upcoming.teacher as any)?.full_name,
            meet: prof?.meeting_link || '#',
            rawDate: classDate
          });
        }
      }

      // 3. Leaderboard, Logs, etc
      if (effectiveTenantId) {
        const { data: lb } = await supabase.from('profiles').select('full_name, xp').eq('role', 'STUDENT').eq('tenant_id', effectiveTenantId).order('xp', { ascending: false }).limit(5);
        if (lb) setLeaderboard(lb);
      }

      // Tip with fail-safe
      try {
        const tip = await getPedagogicalSuggestion(prof?.module || 'Estudante', 'Foco em evolução contínua');
        setSuggestion(tip);
      } catch (e) {
        setSuggestion("Pratique 15 minutos hoje para manter sua fluência.");
      }

      const { data: logs } = await supabase.from('class_logs').select(`id, created_at, presence, student_confirmed, content, teacher:teacher_id(full_name)`).eq('student_id', user.id).order('created_at', { ascending: false }).limit(5);
      setRecentLogs(logs || []);

      await gamificationService.updateStreak(user.id);
    } catch (err) {
      console.error('Student Dashboard error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmLog = async (logId: string) => {
    try {
      const { error } = await supabase.from('class_logs').update({ student_confirmed: true }).eq('id', logId);
      if (error) throw error;
      const result = await gamificationService.addXP(user.id, 100);
      if (result?.leveledUp) {
        confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 }, colors: ['#002366', '#D32F2F', '#FFD700'] });
      }
      setRecentLogs(prev => prev.map(log => log.id === logId ? { ...log, student_confirmed: true } : log));
    } catch (err) { console.error(err); }
  };

  if (loading) return (
    <div className="flex flex-col items-center justify-center h-screen bg-slate-50 dark:bg-slate-950">
      <div className="relative">
        <div className="absolute inset-0 bg-indigo-500 blur-xl opacity-20 animate-pulse rounded-full"></div>
        <RefreshCw className="animate-spin relative z-10 text-indigo-600 dark:text-indigo-400" size={48} />
      </div>
      <p className="text-sm font-black uppercase tracking-widest mt-4 text-slate-400 animate-pulse">Carregando sua experiência...</p>
    </div>
  );

  const isUrgentClass = minutesToClass !== null && minutesToClass <= 30 && minutesToClass >= -10;
  const currentModule = profile?.module || 'A1';
  const currentPartKey = profile?.current_book_part || `${currentModule}-1`;
  const currentPartIndex = parseInt(currentPartKey.split('-')[1]) || 1;
  const currentPartData = ((PEDAGOGICAL_BOOKS as any)[currentModule] || []).find((p: any) => p.part === currentPartIndex);


  return (
    <div className="space-y-8 animate-in fade-in duration-700 pb-20 font-sans">

      {/* 1. HERO SECTION: Gradient & Greeting */}
      <div className="relative rounded-[3rem] overflow-hidden bg-gradient-to-br from-violet-600 via-indigo-600 to-blue-600 shadow-2xl shadow-indigo-500/30 text-white p-8 md:p-12">
        <div className="absolute top-0 right-0 p-32 bg-white/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2"></div>
        <div className="absolute bottom-0 left-0 p-24 bg-black/10 rounded-full blur-2xl translate-y-1/2 -translate-x-1/2"></div>

        <div className="relative z-10 flex flex-col md:flex-row justify-between items-start md:items-end gap-6">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/20 backdrop-blur-md border border-white/20 text-[10px] font-black uppercase tracking-widest mb-4">
              <Sparkles size={12} className="text-yellow-300" />
              <span>Portal do Aluno Premium</span>
            </div>
            <h1 className="text-3xl md:text-5xl font-black tracking-tight mb-2">Olá, {user.name.split(' ')[0]}! 👋</h1>
            <p className="text-indigo-100 font-medium text-lg max-w-md opacity-90">Vamos evoluir 1% hoje? Sua jornada rumo à fluência continua agora.</p>
          </div>

          {/* Documentation Alerts */}
          {profile?.documentation_status !== 'APPROVED' && (
            <div className="bg-white/10 backdrop-blur-md border border-white/20 p-4 rounded-2xl flex items-center gap-3 max-w-xs transition-transform hover:scale-105 cursor-pointer" onClick={() => setShowContract(true)}>
              <div className="p-2 bg-yellow-400 text-yellow-900 rounded-lg shadow-lg shadow-yellow-400/20">
                <FileText size={20} />
              </div>
              <div>
                <p className="text-[10px] font-black uppercase text-yellow-300 tracking-wider">Atenção</p>
                <p className="text-xs font-bold text-white">Documentação Pendente</p>
              </div>
              <ChevronRight size={16} className="ml-auto opacity-50" />
            </div>
          )}
        </div>
      </div>

      {/* 2. STATS ROW */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white dark:bg-slate-900 p-6 rounded-[2rem] border border-orange-100 dark:border-orange-900/30 shadow-xl shadow-orange-500/5 hover:transform hover:scale-[1.02] transition-all flex flex-col justify-between h-40 group relative overflow-hidden">
          <div className="absolute top-0 right-0 p-16 bg-orange-500/5 rounded-full blur-2xl -translate-y-1/2 translate-x-1/2 group-hover:bg-orange-500/10 transition-colors"></div>
          <div className="flex justify-between items-start z-10">
            <div className="p-3 bg-orange-100 dark:bg-orange-900/30 text-orange-600 rounded-2xl">
              <Zap size={24} className="fill-current" />
            </div>
            <span className="text-[10px] font-black uppercase tracking-widest text-orange-400">Ofensiva</span>
          </div>
          <div className="z-10">
            <h3 className="text-3xl font-black text-slate-800 dark:text-white">{profile?.streak_count || 0} <span className="text-sm font-bold text-slate-400">dias</span></h3>
            <p className="text-xs font-bold text-orange-600 dark:text-orange-400">Continue praticando!</p>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 p-6 rounded-[2rem] border border-purple-100 dark:border-purple-900/30 shadow-xl shadow-purple-500/5 hover:transform hover:scale-[1.02] transition-all flex flex-col justify-between h-40 group relative overflow-hidden">
          <div className="absolute top-0 right-0 p-16 bg-purple-500/5 rounded-full blur-2xl -translate-y-1/2 translate-x-1/2 group-hover:bg-purple-500/10 transition-colors"></div>
          <div className="flex justify-between items-start z-10">
            <div className="p-3 bg-purple-100 dark:bg-purple-900/30 text-purple-600 rounded-2xl">
              <Star size={24} className="fill-current" />
            </div>
            <span className="text-[10px] font-black uppercase tracking-widest text-purple-400">XP Total</span>
          </div>
          <div className="z-10 w-full">
            <h3 className="text-3xl font-black text-slate-800 dark:text-white mb-2">{profile?.xp || 0} <span className="text-sm font-bold text-slate-400">xp</span></h3>
            <div className="w-full h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
              <div className="h-full bg-purple-500 rounded-full" style={{ width: `${Math.min((profile?.xp || 0) % 1000 / 10, 100)}%` }}></div>
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 p-6 rounded-[2rem] border border-blue-100 dark:border-blue-900/30 shadow-xl shadow-blue-500/5 hover:transform hover:scale-[1.02] transition-all flex flex-col justify-between h-40 group relative overflow-hidden">
          <div className="absolute top-0 right-0 p-16 bg-blue-500/5 rounded-full blur-2xl -translate-y-1/2 translate-x-1/2 group-hover:bg-blue-500/10 transition-colors"></div>
          <div className="flex justify-between items-start z-10">
            <div className="p-3 bg-blue-100 dark:bg-blue-900/30 text-blue-600 rounded-2xl">
              <Award size={24} />
            </div>
            <span className="text-[10px] font-black uppercase tracking-widest text-blue-400">Nível</span>
          </div>
          <div className="z-10">
            <h3 className="text-2xl font-black text-slate-800 dark:text-white">{profile?.module || 'Iniciante'}</h3>
            <p className="text-xs font-bold text-blue-600 dark:text-blue-400">Módulo Atual</p>
          </div>
        </div>
      </div>

      {/* 3. SMART ACTION: Next Class */}
      {isUrgentClass && nextClass ? (
        <div className="bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded-[2.5rem] p-8 md:p-10 shadow-2xl relative overflow-hidden animate-in zoom-in-95 duration-500 border-4 border-white dark:border-slate-800 ring-4 ring-indigo-500/20">
          <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-500 rounded-full blur-[100px] opacity-50 pointer-events-none"></div>
          <div className="relative z-10 flex flex-col md:flex-row items-center justify-between gap-8">
            <div className="flex items-center gap-6">
              <div className="relative">
                <div className="w-20 h-20 bg-indigo-600 rounded-full flex items-center justify-center animate-pulse">
                  <Video size={32} className="text-white" />
                </div>
                <div className="absolute -bottom-2 -right-2 bg-red-500 text-white text-[10px] font-black px-2 py-1 rounded-full border-2 border-slate-900">
                  AO VIVO
                </div>
              </div>
              <div>
                <p className="text-indigo-300 dark:text-indigo-600 font-bold uppercase tracking-widest text-xs mb-1">Sua aula começa em breve</p>
                <h2 className="text-3xl md:text-4xl font-black tracking-tight mb-2">Hora de Praticar!</h2>
                <p className="text-slate-400 dark:text-slate-600 font-medium">Professor(a) <b>{nextClass.teacher}</b> está te esperando.</p>
              </div>
            </div>
            <div className="flex flex-col items-center gap-2 w-full md:w-auto">
              <a href={nextClass.meet} target="_blank" className="w-full md:w-auto px-10 py-5 bg-white dark:bg-slate-900 text-slate-900 dark:text-white rounded-2xl font-black text-sm uppercase tracking-widest hover:scale-105 active:scale-95 transition-all shadow-xl flex items-center justify-center gap-3">
                <Video size={18} />
                Entrar Agora
              </a>
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
                {minutesToClass && minutesToClass > 0 ? `Em ${minutesToClass} min` : 'Agora!'}
              </p>
            </div>
          </div>
        </div>
      ) : (
        /* Regular Next Class Card */
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 bg-white dark:bg-slate-900 p-8 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 shadow-sm flex flex-col justify-center relative overflow-hidden group">
            <div className="absolute right-0 top-0 w-1/3 h-full bg-gradient-to-l from-slate-50 to-transparent dark:from-slate-800 opacity-50 group-hover:opacity-100 transition-opacity"></div>

            <h3 className="font-black text-slate-800 dark:text-white text-lg mb-6 flex items-center gap-2 relative z-10">
              <Clock size={20} className="text-slate-400" /> Próxima Aula
            </h3>

            {nextClass ? (
              <div className="flex flex-col md:flex-row items-center gap-6 relative z-10">
                <div className="text-center md:text-left">
                  <h2 className="text-4xl font-black text-slate-800 dark:text-white tracking-tighter">{nextClass.time}</h2>
                  <p className="text-slate-500 font-bold mt-1">com {nextClass.teacher}</p>
                </div>
                <div className="h-12 w-px bg-slate-200 dark:bg-slate-700 hidden md:block"></div>
                <a href={nextClass.meet} target="_blank" className="bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 px-6 py-3 rounded-xl font-bold text-xs uppercase tracking-widest hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors flex items-center gap-2">
                  Ver Link <ChevronRight size={14} />
                </a>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center gap-4 py-6 text-center relative z-10">
                <div className="w-16 h-16 bg-slate-50 dark:bg-slate-800 rounded-full flex items-center justify-center text-slate-300">
                  <Clock size={24} />
                </div>
                <div>
                  <p className="text-slate-800 dark:text-white font-bold">Tudo livre por hoje!</p>
                  <p className="text-xs text-slate-500">Aproveite para descansar ou revisar o conteúdo.</p>
                </div>
              </div>
            )}
          </div>

          {/* Support Card */}
          <div className="bg-emerald-50 dark:bg-emerald-900/10 p-8 rounded-[2.5rem] border border-emerald-100 dark:border-emerald-900/30 flex flex-col justify-between items-center text-center">
            <div className="p-4 bg-white dark:bg-emerald-900/50 text-emerald-600 rounded-full mb-4 shadow-sm">
              <MessageSquareText size={24} />
            </div>
            <div>
              <h4 className="font-black text-emerald-900 dark:text-emerald-100 mb-1">Dúvidas?</h4>
              <p className="text-xs text-emerald-700/80 dark:text-emerald-300/80 font-medium mb-6">Fale direto com seu professor no WhatsApp.</p>
            </div>
            {assignedTeacher && (
              <a href={`https://wa.me/${assignedTeacher.phone}`} target="_blank" className="w-full py-3 bg-emerald-500 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-emerald-600 transition-colors shadow-lg shadow-emerald-500/20">
                Chamar Agora
              </a>
            )}
          </div>
        </div>
      )}

      {/* 4. CONTENT & HISTORY */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="bg-white dark:bg-slate-900 p-8 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 shadow-sm">
          <div className="flex justify-between items-center mb-6">
            <h3 className="font-black text-slate-800 dark:text-white text-sm uppercase tracking-widest">Histórico Recente</h3>
            <button className="text-xs font-bold text-slate-400 hover:text-tenant-primary transition-colors">Ver tudo</button>
          </div>
          <div className="space-y-4">
            {recentLogs.slice(0, 3).map(log => (
              <div key={log.id} className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-800/50 rounded-2xl border border-slate-100 dark:border-slate-800">
                <div className="flex items-center gap-4">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${log.presence === 'Presença' ? 'bg-emerald-100 text-emerald-600' : 'bg-red-100 text-red-600'}`}>
                    {log.presence === 'Presença' ? <CheckCircle size={16} /> : <X size={16} />}
                  </div>
                  <div>
                    <p className="font-bold text-slate-700 dark:text-slate-200 text-xs">{new Date(log.created_at).toLocaleDateString('pt-BR')}</p>
                    <p className="text-[9px] font-black text-slate-400 uppercase tracking-wider">{log.teacher?.full_name}</p>
                  </div>
                </div>
                {!log.student_confirmed && (
                  <button onClick={() => handleConfirmLog(log.id)} className="px-4 py-2 bg-tenant-primary text-white text-[9px] font-black uppercase tracking-widest rounded-lg hover:bg-purple-700">Conferir</button>
                )}
              </div>
            ))}
            {recentLogs.length === 0 && <p className="text-center text-slate-400 text-xs py-8">Nenhuma aula registrada ainda.</p>}
          </div>
        </div>

        <div className="bg-gradient-to-br from-amber-50 to-orange-50 dark:from-slate-900 dark:to-slate-900 p-8 rounded-[2.5rem] border border-orange-100 dark:border-slate-800 flex flex-col justify-center text-center md:text-left relative overflow-hidden">
          <div className="absolute top-0 right-0 w-32 h-32 bg-orange-400 rounded-full blur-3xl opacity-10"></div>
          <div className="relative z-10">
            <div className="inline-flex items-center gap-2 px-3 py-1 bg-white dark:bg-slate-800 rounded-full shadow-sm text-amber-500 text-[10px] font-black uppercase tracking-widest mb-4">
              <Sparkles size={12} />
              <span>Dica do Coach IA</span>
            </div>
            <p className="text-lg font-bold text-slate-800 dark:text-slate-200 italic mb-6">"{suggestion}"</p>

            <div className="p-4 bg-white dark:bg-slate-800 rounded-2xl flex items-center gap-4 shadow-sm border border-orange-100 dark:border-slate-700">
              <div className="w-10 h-10 rounded-full bg-slate-100 dark:bg-slate-700 flex items-center justify-center text-slate-400">
                <Target size={18} />
              </div>
              <div className="text-left">
                <p className="text-[10px] uppercase font-black text-slate-400 tracking-wider">Próxima Missão</p>
                <p className="text-xs font-bold text-slate-700 dark:text-slate-300">Revisar vocabulário da Unidade {profile?.module || 1}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {showContract && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in">
          <div className="bg-white rounded-[2rem] w-full max-w-4xl max-h-[90vh] overflow-y-auto relative shadow-2xl">
            <button
              onClick={() => setShowContract(false)}
              className="absolute top-6 right-6 p-2 bg-slate-100 rounded-full hover:bg-slate-200 transition-colors z-50"
            >
              <X size={20} className="text-slate-600" />
            </button>
            <div className="p-8">
              <ContractView userId={user.id} classFrequency={profile?.class_frequency ? parseInt(profile.class_frequency) : (nextClass ? 2 : 1)} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default StudentDashboard;
