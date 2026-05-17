import React, { useState, useEffect } from 'react';
import { Video, BookOpen, Clock, Star, TrendingUp, Sparkles, Download, CreditCard, ChevronRight, CheckCircle, RefreshCw, Target, Zap, Award, Medal, MessageSquareText, FileText, X } from 'lucide-react';
import { getPedagogicalSuggestion } from '../services/geminiService';
import { supabase } from '../lib/supabase';
import { User as UserType } from '../types';
import GamificationHeader from './GamificationHeader';
import ContractView from './ContractView';
import StudentActivities from './StudentActivities';
import { gamificationService } from '../services/gamificationService';
import confetti from 'canvas-confetti';
import { PEDAGOGICAL_BOOKS } from '../constants';
import { useStudentContext } from './contexts/StudentContext';

interface StudentDashboardProps {
  user: UserType;
  tenantId?: string;
}

const StudentDashboard: React.FC<StudentDashboardProps> = ({ user, tenantId }) => {
  const { data: studentContext, loading: contextLoading, refresh } = useStudentContext();

  // Local state for non-critical dashboard extras
  const [suggestion, setSuggestion] = useState<string>('Carregando sua dica personalizada...');
  const [recentLogs, setRecentLogs] = useState<any[]>([]);
  const [leaderboard, setLeaderboard] = useState<any[]>([]);
  const [assignedTeacher, setAssignedTeacher] = useState<any>(null);
  const [showContract, setShowContract] = useState(false);
  const [minutesToClass, setMinutesToClass] = useState<number | null>(null);

  // Derived state from Context
  const profile = studentContext?.profile;
  const gamification = studentContext?.gamification || { xp: 0, level: 1, streak: 0, nextLevelProgress: 0 };

  // Construct nextClass object
  const nextClass = studentContext?.nextClass ? (() => {
    const nc = studentContext.nextClass;
    const [h, m] = (nc.time_slot || '00:00').split(':').map(Number);
    // Fallback date logic if start_time isn't precise (legacy support)
    const rawDate = nc.start_time ? new Date(nc.start_time) : new Date().setHours(h, m, 0, 0);

    return {
      time: nc.time_slot,
      teacher: assignedTeacher?.full_name || 'Professor',
      meet: profile?.meeting_link || null,
      rawDate: typeof rawDate === 'number' ? new Date(rawDate) : rawDate
    };
  })() : null;

  // Effect: Fetch Dashboard Extras (Teacher, Leaderboard, Tip, Logs)
  useEffect(() => {
    if (user && studentContext) {
      const fetchExtras = async () => {
        const effectiveTenantId = tenantId || profile?.tenant_id;

        // 1. Teacher Name (if next class exists and unknown)
        if (studentContext.nextClass?.teacher_id && !assignedTeacher) {
          const { data } = await supabase.from('profiles').select('id, full_name, phone, avatar_url').eq('id', studentContext.nextClass.teacher_id).single();
          if (data) setAssignedTeacher(data);
        }

        // 2. Leaderboard
        if (effectiveTenantId && leaderboard.length === 0) {
          const { data: lb } = await supabase.from('profiles').select('full_name, xp').eq('role', 'STUDENT').eq('tenant_id', effectiveTenantId).order('xp', { ascending: false }).limit(5);
          if (lb) setLeaderboard(lb);
        }

        // 3. Tip
        if (suggestion === 'Carregando sua dica personalizada...') {
          try {
            const tip = await getPedagogicalSuggestion(profile?.module || 'Estudante', 'Foco em evolução contínua');
            setSuggestion(tip);
          } catch {
            setSuggestion("Pratique 15 minutos hoje para manter sua fluência.");
          }
        }

        // 4. Logs
        if (recentLogs.length === 0) {
          const { data: logs } = await supabase.from('class_logs').select(`id, created_at, presence, student_confirmed, content, teacher:teacher_id(full_name)`).eq('student_id', user.id).order('created_at', { ascending: false }).limit(5);
          setRecentLogs(logs || []);
        }
      };
      fetchExtras();
    }
  }, [user, studentContext, tenantId, profile]);

  useEffect(() => {
    if (nextClass && nextClass.rawDate) {
      const diff = new Date(nextClass.rawDate).getTime() - new Date().getTime();
      const mins = Math.floor(diff / 1000 / 60);
      setMinutesToClass(mins);
    }
  }, [nextClass]);

    const handleConfirmLog = async (logId: string) => {
        try {
            const { error } = await supabase.from('class_logs').update({ student_confirmed: true }).eq('id', logId);
            if (error) throw error;

            const effectiveTenantId = tenantId || profile?.tenant_id;
            if (effectiveTenantId) {
                const result = await gamificationService.addXP(user.id, effectiveTenantId, 100, 'ATTENDANCE', logId);
                if (result?.leveledUp) {
                    confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 }, colors: ['#002366', '#D32F2F', '#FFD700'] });
                }
            }
            setRecentLogs(prev => prev.map(log => log.id === logId ? { ...log, student_confirmed: true } : log));

            refresh(); // Sync context
        } catch (err) { console.error(err); }
    };

  if (contextLoading) return (
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

      {/* 1. HERO SECTION: Premium Welcome Header */}
      <div className="relative rounded-[3rem] overflow-hidden bg-gradient-to-br from-violet-600 via-indigo-600 to-blue-600 shadow-2xl shadow-indigo-500/30 text-white p-8 md:p-12">
        {/* Dynamic Background Gradients */}
        <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-white/10 rounded-full blur-[80px] -translate-y-1/2 translate-x-1/3"></div>
        <div className="absolute bottom-0 left-0 w-[400px] h-[400px] bg-black/10 rounded-full blur-[60px] translate-y-1/3 -translate-x-1/3"></div>

        <div className="relative z-10 flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
          <div>
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/5 backdrop-blur-xl border border-white/10 text-[10px] font-black uppercase tracking-widest mb-6 text-indigo-300 shadow-inner">
              <Sparkles size={12} className="text-indigo-400" />
              <span>Portal Premium</span>
            </div>
            <h1 className="text-3xl md:text-5xl lg:text-6xl font-black tracking-tighter mb-3 bg-clip-text text-transparent bg-gradient-to-r from-white to-slate-400">
              Olá, {user.name.split(' ')[0]}! 👋
            </h1>
            <p className="text-slate-400 font-medium text-lg max-w-md">Vamos evoluir 1% hoje? Sua jornada rumo à fluência continua agora.</p>
          </div>

          {/* Documentation Alerts (Fixed Logic) */}
          {profile?.documentation_status === 'PENDING' ? (
            <div className="bg-red-500/10 backdrop-blur-xl border border-red-500/20 p-5 rounded-3xl flex items-center gap-4 transition-all hover:bg-red-500/20 cursor-pointer shadow-[0_0_30px_-10px_rgba(239,68,68,0.3)]" onClick={() => setShowContract(true)}>
              <div className="p-3 bg-red-500 text-white rounded-2xl shadow-lg">
                <FileText size={24} />
              </div>
              <div>
                <p className="text-[10px] font-black uppercase text-red-400 tracking-wider">Atenção Necessária</p>
                <p className="text-sm font-bold text-white tracking-tight">Assinar Contrato</p>
              </div>
              <ChevronRight size={18} className="ml-2 text-red-300" />
            </div>
          ) : (
            <div className="bg-white/10 backdrop-blur-xl border border-white/20 p-5 rounded-3xl flex items-center gap-4 transition-all hover:bg-white/20 cursor-pointer" onClick={() => setShowContract(true)}>
              <div className="p-3 bg-white/20 text-white rounded-2xl shadow-lg">
                <FileText size={24} />
              </div>
              <div>
                <p className="text-[10px] font-black uppercase text-slate-300 tracking-wider">Documentos</p>
                <p className="text-sm font-bold text-white tracking-tight">Meu Contrato</p>
              </div>
              <ChevronRight size={18} className="ml-2 text-slate-300" />
            </div>
          )}
        </div>
      </div>

      {/* 2. STATS ROW */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white/70 backdrop-blur-xl dark:bg-slate-900/80 p-6 rounded-[2rem] border border-white dark:border-slate-800 shadow-xl shadow-slate-200/50 dark:shadow-none hover:-translate-y-1 transition-transform flex flex-col justify-between h-44 group relative overflow-hidden">
          <div className="absolute -top-10 -right-10 w-40 h-40 bg-gradient-to-b from-orange-400/20 to-transparent rounded-full blur-3xl group-hover:from-orange-400/30 transition-colors"></div>
          <div className="flex justify-between items-start z-10">
            <div className="p-3 bg-gradient-to-br from-orange-100 to-orange-50 dark:from-orange-500/20 dark:to-orange-500/5 text-orange-500 rounded-2xl shadow-sm border border-orange-100 dark:border-orange-500/20">
              <Zap size={24} className="fill-current" />
            </div>
            <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500">Ofensiva</span>
          </div>
          <div className="z-10 mt-4">
            <h3 className="text-4xl font-black text-slate-800 dark:text-white tracking-tighter flex items-baseline gap-1">
              {gamification.streak || 0} <span className="text-sm font-bold text-slate-400 tracking-normal">dias</span>
            </h3>
            <p className="text-xs font-bold text-orange-500 mt-1">Sua constância é a chave!</p>
          </div>
        </div>

        <div className="bg-white/70 backdrop-blur-xl dark:bg-slate-900/80 p-6 rounded-[2rem] border border-white dark:border-slate-800 shadow-xl shadow-slate-200/50 dark:shadow-none hover:-translate-y-1 transition-transform flex flex-col justify-between h-44 group relative overflow-hidden">
          <div className="absolute -top-10 -right-10 w-40 h-40 bg-gradient-to-b from-purple-400/20 to-transparent rounded-full blur-3xl group-hover:from-purple-400/30 transition-colors"></div>
          <div className="flex justify-between items-start z-10">
            <div className="p-3 bg-gradient-to-br from-purple-100 to-purple-50 dark:from-purple-500/20 dark:to-purple-500/5 text-purple-600 rounded-2xl shadow-sm border border-purple-100 dark:border-purple-500/20">
              <Star size={24} className="fill-current" />
            </div>
            <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500">Milestones</span>
          </div>
          <div className="z-10 w-full mt-4">
            <h3 className="text-4xl font-black text-slate-800 dark:text-white tracking-tighter flex items-baseline gap-1 mb-3">
              {gamification.xp || 0} <span className="text-sm font-bold text-slate-400 tracking-normal">xp</span>
            </h3>
            <div className="w-full h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden shadow-inner">
              <div className="h-full bg-gradient-to-r from-purple-400 to-indigo-500 rounded-full" style={{ width: `${Math.min(gamification.nextLevelProgress || 0, 100)}%` }}></div>
            </div>
          </div>
        </div>

        <div className="bg-white/70 backdrop-blur-xl dark:bg-slate-900/80 p-6 rounded-[2rem] border border-white dark:border-slate-800 shadow-xl shadow-slate-200/50 dark:shadow-none hover:-translate-y-1 transition-transform flex flex-col justify-between h-44 group relative overflow-hidden">
          <div className="absolute -top-10 -right-10 w-40 h-40 bg-gradient-to-b from-blue-400/20 to-transparent rounded-full blur-3xl group-hover:from-blue-400/30 transition-colors"></div>
          <div className="flex justify-between items-start z-10">
            <div className="p-3 bg-gradient-to-br from-blue-100 to-blue-50 dark:from-blue-500/20 dark:to-blue-500/5 text-blue-600 rounded-2xl shadow-sm border border-blue-100 dark:border-blue-500/20">
              <Award size={24} className="fill-current" />
            </div>
            <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 dark:text-slate-500">Evolução</span>
          </div>
          <div className="z-10 mt-4">
            <h3 className="text-4xl font-black text-slate-800 dark:text-white tracking-tighter flex items-baseline gap-2">
              <span className="text-sm font-bold text-slate-400 tracking-normal">NÍVEL</span> {gamification.level || 1}
            </h3>
            <p className="text-xs font-bold text-blue-600 dark:text-blue-400 mt-1 uppercase tracking-wider">Módulo Atual {profile?.module || 'A1'}</p>
          </div>
        </div>
      </div>

      {/* 3. SMART ACTION: Next Class */}
      {isUrgentClass && nextClass ? (
        <div className="bg-indigo-600 text-white rounded-[3rem] p-8 md:p-10 shadow-[0_20px_40px_-15px_rgba(79,70,229,0.5)] relative overflow-hidden animate-in zoom-in-95 duration-500">
          <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/cubes.png')] opacity-10"></div>
          <div className="absolute top-0 right-0 w-[400px] h-[400px] bg-indigo-400/40 rounded-full blur-[80px] opacity-80 pointer-events-none translate-x-1/3 -translate-y-1/3 text-blend-screen"></div>

          <div className="relative z-10 flex flex-col md:flex-row items-center justify-between gap-8">
            <div className="flex flex-col md:flex-row items-center gap-6 text-center md:text-left">
              <div className="relative">
                <div className="w-24 h-24 bg-white/10 backdrop-blur-md rounded-[2rem] flex items-center justify-center border border-white/20 shadow-inner">
                  <div className="w-16 h-16 bg-white shrink-0 rounded-2xl flex items-center justify-center animate-pulse shadow-lg text-indigo-600">
                    <Video size={36} className="fill-indigo-600/20" />
                  </div>
                </div>
                <div className="absolute -bottom-3 -right-3 bg-red-500 text-white text-[10px] font-black px-3 py-1.5 rounded-full border-4 border-indigo-600 shadow-xl">
                  AO VIVO
                </div>
              </div>
              <div className="pt-2">
                <p className="text-indigo-200 font-bold uppercase tracking-[0.2em] text-[10px] md:text-xs mb-2">Preparado para Falar?</p>
                <h2 className="text-3xl md:text-5xl font-black tracking-tighter mb-2 text-white drop-shadow-sm leading-tight">Sua aula vai começar!</h2>
                <p className="text-indigo-100 font-medium text-sm md:text-lg">Professor(a) <b>{nextClass.teacher}</b> te espera na sala.</p>
              </div>
            </div>
            <div className="flex flex-col items-stretch md:items-center gap-3 w-full md:w-auto mt-4 md:mt-0">
              {nextClass.meet ? (
                <a href={nextClass.meet} target="_blank" rel="noopener noreferrer" className="w-full md:w-auto px-12 py-5 bg-white text-indigo-600 rounded-2xl font-black text-sm uppercase tracking-widest hover:scale-105 active:scale-95 transition-all shadow-[0_10px_20px_-10px_rgba(0,0,0,0.3)] flex items-center justify-center gap-3 group">
                  <Video size={18} className="group-hover:scale-110 transition-transform" />
                  Entrar na Sala
                </a>
              ) : (
                <div className="w-full md:w-auto px-12 py-5 bg-white/50 text-indigo-400 rounded-2xl font-black text-sm uppercase tracking-widest flex items-center justify-center gap-3 cursor-not-allowed">
                  <Video size={18} />
                  Link não configurado
                </div>
              )}
              <p className="text-[11px] font-black text-indigo-200 uppercase tracking-widest text-center">
                {minutesToClass && minutesToClass > 0 ? `Começa em ${minutesToClass} minutos` : 'A sala já está aberta!'}
              </p>
            </div>
          </div>
        </div>
      ) : (
        /* Regular Next Class Card */
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 bg-white/80 backdrop-blur-xl dark:bg-slate-900 p-8 rounded-[3rem] border border-white dark:border-slate-800 shadow-xl shadow-slate-200/40 dark:shadow-none flex flex-col justify-center relative overflow-hidden group">
            <div className="absolute right-0 top-0 w-1/2 h-full bg-gradient-to-l from-indigo-50/50 to-transparent dark:from-indigo-900/10 opacity-50 transition-opacity"></div>

            <h3 className="font-black text-slate-800 dark:text-white text-sm uppercase tracking-widest mb-6 flex items-center gap-2 relative z-10">
              <Clock size={16} className="text-indigo-400" /> Próximo Encontro
            </h3>

            {nextClass ? (
              <div className="flex flex-col md:flex-row items-center gap-8 relative z-10 w-full justify-between pr-4">
                <div className="text-center md:text-left flex-1">
                  <h2 className="text-5xl font-black text-slate-800 dark:text-white tracking-tighter drop-shadow-sm">{nextClass.time}</h2>
                  <p className="text-slate-500 font-medium mt-2 text-lg">com Professor(a) <span className="font-bold text-slate-700 dark:text-slate-300">{nextClass.teacher}</span></p>
                </div>
                <div className="h-16 w-px bg-slate-200 dark:bg-slate-800 hidden md:block"></div>
                {nextClass.meet ? (
                  <a href={nextClass.meet} target="_blank" rel="noopener noreferrer" className="w-full md:w-auto md:min-w-[180px] bg-slate-900 dark:bg-slate-800 text-white px-8 py-4 rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-indigo-600 dark:hover:bg-indigo-600 transition-colors flex items-center justify-center gap-3 shadow-lg shadow-slate-900/10">
                    Ver Link <ChevronRight size={16} />
                  </a>
                ) : (
                  <div className="w-full md:w-auto md:min-w-[180px] bg-slate-200 dark:bg-slate-800 text-slate-400 px-8 py-4 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-3 cursor-not-allowed">
                    Sem Link
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center gap-4 py-8 text-center relative z-10">
                <div className="w-20 h-20 bg-slate-50 dark:bg-slate-800 rounded-3xl rotate-3 flex items-center justify-center text-slate-300 shadow-inner border border-slate-100">
                  <Clock size={32} />
                </div>
                <div>
                  <p className="text-slate-800 dark:text-white font-black text-xl mb-1">Agenda Livre!</p>
                  <p className="text-sm font-medium text-slate-500">Volte depois para checar o seu horário.</p>
                </div>
              </div>
            )}
          </div>

          {/* Support Card */}
          <div className="bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-900/10 dark:to-teal-900/10 p-8 rounded-[3rem] border border-emerald-100 dark:border-emerald-900/30 flex flex-col justify-between items-center text-center shadow-lg shadow-emerald-100/30 relative overflow-hidden">
            <div className="absolute -top-10 -left-10 w-32 h-32 bg-emerald-400/20 rounded-full blur-2xl"></div>
            <div className="p-4 bg-white/80 backdrop-blur border border-white dark:bg-emerald-900/50 text-emerald-600 rounded-[2rem] mb-4 shadow-sm relative z-10 rotate-[-5deg]">
              <MessageSquareText size={32} />
            </div>
            <div className="relative z-10 mb-6">
              <h4 className="font-black text-emerald-900 dark:text-emerald-100 text-xl tracking-tight mb-2">Precisa de Ajuda?</h4>
              <p className="text-sm text-emerald-700/80 dark:text-emerald-300/80 font-medium">Converse direto com o suporte pedagógico no WhatsApp.</p>
            </div>
            {assignedTeacher && (
              <a href={`https://wa.me/${assignedTeacher.phone}`} target="_blank" className="w-full relative z-10 py-4 bg-emerald-500 text-white rounded-2xl text-[11px] font-black uppercase tracking-widest hover:bg-emerald-600 transition-colors shadow-[0_10px_20px_-10px_rgba(16,185,129,0.5)] flex items-center justify-center gap-2">
                <MessageSquareText size={16} /> Falar no WhatsApp
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

      {/* 5. COMPLEMENTARY ACTIVITIES */}
      <StudentActivities userId={user.id} tenantId={tenantId || profile?.tenant_id} />

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
