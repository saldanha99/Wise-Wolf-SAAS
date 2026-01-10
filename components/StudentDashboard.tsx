import React, { useState, useEffect } from 'react';
import { Video, BookOpen, Clock, Star, TrendingUp, Sparkles, Download, CreditCard, ChevronRight, CheckCircle, RefreshCw, Target, Zap, Award, Medal, MessageSquareText } from 'lucide-react';
import { getPedagogicalSuggestion } from '../services/geminiService';
import { supabase } from '../lib/supabase';
import { User as UserType } from '../types';
import GamificationHeader from './GamificationHeader';
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

  useEffect(() => {
    if (user && tenantId) {
      fetchStudentData();
    }
  }, [user, tenantId]);

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

      // 2. Fetch Next Class and Teacher
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
        // Set the primary teacher for support
        setAssignedTeacher(bookings[0].teacher);

        // Find next one today
        const now = new Date();
        const curH = now.getHours();
        const curM = now.getMinutes();

        const todayBookings = bookings.filter(b => b.day_of_week === todayDay);
        const upcoming = todayBookings.filter(b => {
          const [h, m] = (b as any).time_slot.split(':').map(Number);
          return h > curH || (h === curH && m > curM);
        }).sort((a, b) => (a as any).time_slot.localeCompare((b as any).time_slot))[0];

        if (upcoming) {
          setNextClass({
            time: `Hoje às ${(upcoming as any).time_slot}`,
            teacher: (upcoming.teacher as any)?.full_name,
            meet: prof?.meeting_link || '#'
          });
        }
      }

      // 3. Fetch Leaderboard (Hall da Fama)
      const { data: lb } = await supabase
        .from('profiles')
        .select('full_name, xp')
        .eq('role', 'STUDENT')
        .eq('tenant_id', tenantId)
        .order('xp', { ascending: false })
        .limit(5);

      if (lb) setLeaderboard(lb);

      // 4. Tip
      const tip = await getPedagogicalSuggestion(prof?.module || 'Estudante', 'Foco em evolução contínua');
      setSuggestion(tip);

      // 5. Fetch Recent Logs
      const { data: logs } = await supabase
        .from('class_logs')
        .select(`
          id, created_at, presence, student_confirmed, content,
          teacher:teacher_id(full_name)
        `)
        .eq('student_id', user.id)
        .order('created_at', { ascending: false })
        .limit(5);

      setRecentLogs(logs || []);

      // 6. Update Streak
      await gamificationService.updateStreak(user.id);

    } catch (err) {
      console.error('Student Dashboard error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmLog = async (logId: string) => {
    try {
      const { error } = await supabase
        .from('class_logs')
        .update({ student_confirmed: true })
        .eq('id', logId);

      if (error) throw error;

      // Award XP for Confirmation
      const result = await gamificationService.addXP(user.id, 100);
      if (result?.leveledUp) {
        confetti({
          particleCount: 150,
          spread: 70,
          origin: { y: 0.6 },
          colors: ['#002366', '#D32F2F', '#FFD700']
        });
      }

      setRecentLogs(prev => prev.map(log =>
        log.id === logId ? { ...log, student_confirmed: true } : log
      ));
    } catch (err) {
      console.error('Error confirming log:', err);
    }
  };

  if (loading) return (
    <div className="flex flex-col items-center justify-center h-96 text-slate-400">
      <RefreshCw className="animate-spin mb-4" size={32} />
      <p className="text-sm font-bold uppercase tracking-widest">Sincronizando seu Portal...</p>
    </div>
  );

  const currentModule = profile?.module || 'A1';
  const currentPartKey = profile?.current_book_part || `${currentModule}-1`;
  const currentPartIndex = parseInt(currentPartKey.split('-')[1]) || 1;
  const currentPartData = ((PEDAGOGICAL_BOOKS as any)[currentModule] || []).find((p: any) => p.part === currentPartIndex);

  return (
    <div className="space-y-6 md:space-y-8 animate-in fade-in duration-700 pb-10">
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h2 className="text-2xl md:text-3xl font-black text-gray-800 dark:text-slate-100 tracking-tight">Portal do Aluno</h2>
          <p className="text-gray-500 dark:text-slate-400 text-sm italic">Olá, {user.name.split(' ')[0]}! Sua jornada rumo à fluência continua!</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-4 py-2 bg-white dark:bg-slate-900 rounded-2xl border border-gray-100 dark:border-slate-800 shadow-sm shadow-black/5">
            <Star className="text-amber-500 fill-amber-500" size={16} />
            <span className="text-xs font-black text-gray-700 dark:text-slate-200">Aluno {currentModule}</span>
          </div>
        </div>
      </header>

      <GamificationHeader
        xp={profile?.xp || 0}
        level={profile?.level || 1}
        streak={profile?.streak_count || 0}
      />

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Support Hub */}
        <div className="lg:col-span-1 bg-white dark:bg-slate-900 p-8 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 shadow-sm flex flex-col justify-between group overflow-hidden relative">
          <div className="absolute -top-10 -right-10 w-32 h-32 bg-tenant-primary/5 rounded-full blur-2xl group-hover:bg-tenant-primary/20 transition-all" />
          <div className="relative z-10">
            <div className="p-3 bg-tenant-primary/10 text-tenant-primary rounded-2xl w-fit mb-4">
              <MessageSquareText size={20} />
            </div>
            <h4 className="text-sm font-black text-slate-800 dark:text-white mb-2">Suporte Direto</h4>
            <p className="text-[10px] text-slate-500 mb-6 font-medium leading-relaxed">Dúvidas sobre o material ou precisa trocar um horário?</p>

            {assignedTeacher && (
              <div className="flex items-center gap-3 mb-6 p-3 bg-slate-50 dark:bg-slate-800/50 rounded-2xl border border-slate-100 dark:border-slate-700">
                <img src={assignedTeacher.avatar_url || `https://ui-avatars.com/api/?name=${assignedTeacher.full_name}`} className="w-8 h-8 rounded-lg" alt="" />
                <div className="overflow-hidden">
                  <p className="text-[10px] font-black text-slate-800 dark:text-white truncate">{assignedTeacher.full_name}</p>
                  <p className="text-[8px] text-slate-400 font-bold uppercase">Professor(a)</p>
                </div>
              </div>
            )}
          </div>
          <div className="relative z-10 space-y-2">
            <a
              href={`https://wa.me/${assignedTeacher?.phone || ''}`}
              target="_blank"
              className="flex items-center justify-center gap-2 w-full py-4 bg-[#25D366] text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:scale-[1.02] active:scale-95 transition-all shadow-lg shadow-emerald-500/10"
            >
              CHAMAR NO WHATSAPP
            </a>
          </div>
        </div>

        {/* Next Class Hero */}
        <div className="lg:col-span-3 bg-white dark:bg-slate-900 p-8 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 shadow-sm relative overflow-hidden group">
          <div className="absolute right-0 top-0 bottom-0 w-1/2 bg-gradient-to-l from-tenant-primary/5 to-transparent pointer-events-none" />

          <div className="relative z-10 flex flex-col md:flex-row h-full items-center gap-8">
            <div className="flex-1">
              {nextClass ? (
                <>
                  <div className="flex items-center gap-2 mb-4">
                    <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                    <span className="text-emerald-500 text-[10px] font-black uppercase tracking-widest">Próxima Aula</span>
                  </div>
                  <h3 className="text-4xl font-black text-slate-800 dark:text-white tracking-tight leading-tight mb-2">{nextClass.time}</h3>
                  <p className="text-slate-500 dark:text-slate-400 text-sm font-medium">Você tem um encontro marcado com <b>{nextClass.teacher}</b>.</p>
                  <div className="mt-8 flex flex-col sm:flex-row gap-3">
                    <a
                      href={nextClass.meet}
                      target="_blank"
                      className="bg-tenant-primary text-white px-8 py-4 rounded-xl font-black text-xs inline-flex items-center justify-center gap-3 hover:scale-105 active:scale-95 transition-all shadow-xl shadow-tenant-primary/20"
                    >
                      <Video size={18} /> ENTRAR NA AULA
                    </a>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2 mb-4">
                    <div className="w-2 h-2 rounded-full bg-slate-300 dark:bg-slate-600" />
                    <span className="text-slate-400 text-[10px] font-black uppercase tracking-widest">Sem aulas para hoje</span>
                  </div>
                  <h3 className="text-3xl font-black text-slate-800 dark:text-white mb-2">Continue focado!</h3>
                  <p className="text-slate-500 dark:text-slate-400 text-sm font-medium">Aproveite para revisar seu material didático ou fazer a missão do dia.</p>
                  {profile?.meeting_link && (
                    <div className="mt-8">
                      <a
                        href={profile.meeting_link}
                        target="_blank"
                        className="bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 px-6 py-3 rounded-xl font-bold text-[10px] uppercase tracking-widest inline-flex items-center gap-2 transition-all"
                      >
                        <Video size={14} /> Minha Sala Fixa
                      </a>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="w-full md:w-64 bg-slate-50 dark:bg-slate-800/50 rounded-[2rem] border border-slate-100 dark:border-slate-800 p-6 flex flex-col items-center justify-center text-center">
              <div className="p-4 bg-tenant-primary/10 text-tenant-primary rounded-2xl mb-4 group-hover:rotate-12 transition-transform">
                <BookOpen size={32} />
              </div>
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Livro Atual</p>
              <h4 className="text-sm font-black text-slate-800 dark:text-white mb-4">Part {currentPartIndex} • {currentModule}</h4>
              <button
                onClick={() => currentPartData && window.open(currentPartData.url, '_blank')}
                disabled={!currentPartData}
                className="w-full py-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-tenant-primary hover:text-white hover:border-tenant-primary transition-all disabled:opacity-50"
              >
                ABRIR MATERIAL
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Anti-fraud Confirmation */}
        <div className="lg:col-span-2 bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 shadow-sm overflow-hidden flex flex-col">
          <div className="p-8 border-b dark:border-slate-800 flex justify-between items-center bg-slate-50/50 dark:bg-slate-800/30 text-slate-700 dark:text-slate-200">
            <h3 className="font-black text-xs uppercase tracking-widest flex items-center gap-3">
              <CheckCircle size={18} className="text-tenant-primary" /> Conferência de Aulas Realizadas
            </h3>
          </div>
          <div className="overflow-x-auto flex-1">
            <table className="w-full">
              <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
                {recentLogs.length > 0 ? recentLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
                    <td className="px-8 py-5">
                      <div className="flex items-center gap-4">
                        <div className={`p-2 rounded-lg ${log.presence === 'Presença' ? 'bg-emerald-100 text-emerald-600' : 'bg-red-100 text-red-600'}`}>
                          {log.presence === 'Presença' ? <CheckCircle size={14} /> : <Target size={14} />}
                        </div>
                        <div className="flex flex-col">
                          <span className="text-sm font-bold text-slate-800 dark:text-slate-100">{new Date(log.created_at).toLocaleDateString('pt-BR')}</span>
                          <span className="text-[10px] text-slate-400 font-black uppercase tracking-tighter">Prof: {log.teacher?.full_name}</span>
                        </div>
                      </div>
                    </td>
                    <td className="px-8 py-5 text-right">
                      {log.student_confirmed ? (
                        <span className="inline-flex items-center gap-2 px-3 py-1.5 bg-emerald-50 dark:bg-emerald-900/10 text-emerald-600 text-[9px] font-black uppercase tracking-widest rounded-lg border border-emerald-100 dark:border-emerald-900/30">
                          CONFERIDA ✓
                        </span>
                      ) : (
                        <button
                          onClick={() => handleConfirmLog(log.id)}
                          className="px-6 py-3 bg-tenant-primary text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:scale-105 transition-all shadow-lg shadow-tenant-primary/20 active:scale-95"
                        >
                          CONFERIR AULA
                        </button>
                      )}
                    </td>
                  </tr>
                )) : (
                  <tr>
                    <td colSpan={2} className="px-8 py-16 text-center">
                      <Clock className="mx-auto text-slate-200 mb-2" size={32} />
                      <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest italic font-medium">Aguardando seu primeiro lançamento.</p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* AI Assistant Suggestion */}
        <div className="bg-amber-50 dark:bg-amber-900/10 p-8 rounded-[3rem] border border-amber-100 dark:border-amber-900/30 shadow-sm flex flex-col justify-between group">
          <div>
            <div className="flex items-center gap-2 text-amber-600 dark:text-amber-500 mb-6 bg-white dark:bg-slate-900 w-fit px-3 py-1.5 rounded-full shadow-sm">
              <Sparkles size={16} className="animate-pulse" />
              <span className="text-[10px] font-black uppercase tracking-widest">Coaching IA</span>
            </div>
            <p className="text-sm text-amber-900 dark:text-amber-200 leading-relaxed font-bold italic mb-8">
              "{suggestion}"
            </p>
          </div>
          <button
            onClick={() => alert("Gerando plano de estudos personalizado para o próximo mês...")}
            className="flex items-center justify-between w-full p-4 bg-white dark:bg-slate-900 rounded-2xl text-[10px] font-black text-amber-700 dark:text-amber-500 uppercase tracking-widest hover:scale-[1.02] transition-all shadow-sm group-hover:shadow-md"
          >
            <span>Ver plano personalizado</span>
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Lesson Notes (Diário de Bordo) */}
        <div className="bg-white dark:bg-slate-900 p-8 rounded-[2.5rem] border border-gray-100 dark:border-slate-800 shadow-sm">
          <h3 className="font-black text-gray-800 dark:text-slate-200 text-xs uppercase tracking-widest mb-6 flex items-center gap-3">
            <BookOpen size={18} className="text-tenant-primary" /> Notas Pedagógicas (Resumo das Aulas)
          </h3>
          <div className="space-y-4 max-h-[350px] overflow-y-auto pr-2 custom-scrollbar">
            {recentLogs.filter(l => l.presence?.toUpperCase() === 'PRESENÇA' || l.presence === 'Presença').map((log, i) => (
              <div key={i} className="p-5 bg-slate-50 dark:bg-slate-800/50 rounded-2xl border border-slate-100 dark:border-slate-800 hover:border-tenant-primary transition-all group relative overflow-hidden">
                <div className="flex justify-between items-start mb-3">
                  <div className="flex flex-col">
                    <p className="text-[10px] font-black text-tenant-primary uppercase tracking-widest">{new Date(log.created_at).toLocaleDateString('pt-BR')}</p>
                    <span className="text-[9px] font-bold text-slate-400">Tópico abordado em aula:</span>
                  </div>
                </div>
                <p className="text-xs text-slate-700 dark:text-slate-300 font-bold leading-relaxed">
                  {log.content || 'Consolidação de vocabulário e prática de conversação.'}
                </p>
              </div>
            ))}
            {recentLogs.filter(l => l.presence?.toUpperCase() === 'PRESENÇA' || l.presence === 'Presença').length === 0 && (
              <div className="py-12 text-center text-slate-300 text-[10px] uppercase font-black tracking-widest flex flex-col items-center gap-4">
                <BookOpen size={32} strokeWidth={1} />
                O histórico das suas aulas aparecerá aqui.
              </div>
            )}
          </div>
        </div>

        {/* Weekly Hall of Fame */}
        <div className="bg-white dark:bg-slate-900 p-8 rounded-[2.5rem] border border-gray-100 dark:border-slate-800 shadow-sm">
          <div className="flex justify-between items-center mb-6">
            <h3 className="font-black text-gray-800 dark:text-slate-200 text-xs uppercase tracking-widest flex items-center gap-3">
              <Medal size={18} className="text-amber-500" /> Hall da Fama (Mestres do XP)
            </h3>
            <span className="text-[9px] font-black text-amber-500 bg-amber-50 dark:bg-amber-900/10 px-2 py-1 rounded-lg uppercase tracking-widest animate-pulse">Live</span>
          </div>
          <div className="space-y-3">
            {leaderboard.map((rank, i) => {
              const isMe = rank.full_name === profile?.full_name;
              return (
                <div key={i} className={`flex items-center justify-between p-4 rounded-2xl transition-all ${isMe ? 'bg-tenant-primary text-white shadow-xl shadow-tenant-primary/20 scale-[1.02]' : 'bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-800'}`}>
                  <div className="flex items-center gap-4">
                    <div className={`w-6 h-6 rounded flex items-center justify-center text-[10px] font-black ${i === 0 ? 'bg-amber-400 text-white' : i === 1 ? 'bg-slate-300 text-slate-600' : i === 2 ? 'bg-orange-400 text-white' : 'text-slate-400'}`}>
                      #{i + 1}
                    </div>
                    <div className="flex items-center gap-3">
                      <img src={`https://ui-avatars.com/api/?name=${rank.full_name}&background=random`} className="w-8 h-8 rounded-full border-2 border-white/20" alt="" />
                      <span className={`text-xs font-black ${isMe ? 'text-white' : 'text-slate-700 dark:text-slate-200'}`}>{rank.full_name}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Zap size={10} className={isMe ? 'text-white' : 'text-amber-500'} />
                    <span className="text-[10px] font-black tracking-tight">{rank.xp} XP</span>
                  </div>
                </div>
              );
            })}
            {leaderboard.length === 0 && (
              <div className="text-center py-10 text-slate-400 text-[10px] uppercase font-black tracking-widest">Calculando ranking...</div>
            )}
          </div>
          <button className="w-full mt-6 py-4 text-[9px] font-black uppercase text-slate-400 hover:text-tenant-primary transition-colors text-center tracking-widest border-t dark:border-slate-800">
            Ver Ranking Completo
          </button>
        </div>
      </div>
    </div>
  );
};

export default StudentDashboard;
