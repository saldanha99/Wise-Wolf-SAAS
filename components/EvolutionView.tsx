import React, { useState, useEffect } from 'react';
import { MessageSquareText } from 'lucide-react';
import CompetencyRadarChart from './CompetencyRadarChart';
import AIReportCard from './AIReportCard';
import { supabase } from '../lib/supabase';

interface EvolutionViewProps {
  user?: any;
}

interface TeacherFeedback {
  text: string;
  teacherName?: string;
  date?: string;
}

const DEFAULT_SKILLS = [
  { subject: 'Speaking', score: 70 },
  { subject: 'Listening', score: 70 },
  { subject: 'Writing', score: 65 },
  { subject: 'Grammar', score: 70 },
  { subject: 'Vocabulary', score: 70 },
];

const EvolutionView: React.FC<EvolutionViewProps> = ({ user }) => {
  const [feedback, setFeedback] = useState<TeacherFeedback | null>(null);
  const [loadingFeedback, setLoadingFeedback] = useState(true);
  const [classCount, setClassCount] = useState<number | null>(null);
  const [currentSkills, setCurrentSkills] = useState(DEFAULT_SKILLS);
  const [previousSkills, setPreviousSkills] = useState(
    DEFAULT_SKILLS.map(s => ({ subject: s.subject, score: Math.max(0, s.score - 5) }))
  );

  useEffect(() => {
    let isMounted = true;
    const studentId = user?.id;

    if (!studentId) {
      setLoadingFeedback(false);
      return;
    }

    const loadEvolutionData = async () => {
      try {
        // 1. Busca os últimos logs de aula com anotação ou observação do professor
        const { data: logs, error: logsError } = await supabase
          .from('class_logs')
          .select('observations, notes, content, class_date, created_at, teacher:teacher_id(full_name)')
          .eq('student_id', studentId)
          .order('class_date', { ascending: false, nullsFirst: false })
          .order('created_at', { ascending: false })
          .limit(10);

        if (!logsError && logs && isMounted) {
          const validLog = logs.find((l: any) =>
            (l.observations && l.observations.trim().length > 0) ||
            (l.notes && l.notes.trim().length > 0) ||
            (l.content && l.content.trim().length > 0)
          );

          if (validLog) {
            const rawText = (validLog.observations?.trim() || validLog.notes?.trim() || validLog.content?.trim()) as string;
            const teacher = (validLog.teacher as any)?.full_name || null;
            const rawDate = validLog.class_date || validLog.created_at;
            let dateFormatted: string | undefined;
            if (rawDate) {
              const parsed = new Date(rawDate.includes('T') ? rawDate : `${rawDate}T12:00:00`);
              if (!isNaN(parsed.getTime())) {
                dateFormatted = parsed.toLocaleDateString('pt-BR');
              }
            }

            setFeedback({
              text: rawText,
              teacherName: teacher,
              date: dateFormatted,
            });
          }

          setClassCount(logs.length);
        }

        // 2. Busca scores reais de competências do aluno
        const { data: skillsData } = await supabase
          .from('student_skill_scores')
          .select('skill, current_score')
          .eq('student_id', studentId);

        if (skillsData && skillsData.length > 0 && isMounted) {
          const scoreMap: Record<string, number> = {};
          skillsData.forEach((item: any) => {
            if (item.skill) {
              scoreMap[item.skill.toLowerCase()] = Number(item.current_score) || 0;
            }
          });

          const speakingScore = scoreMap['speaking'] ?? scoreMap['pronunciation'] ?? 75;
          const listeningScore = scoreMap['listening'] ?? 70;
          const writingScore = scoreMap['writing'] ?? 65;
          const grammarScore = scoreMap['grammar'] ?? 70;
          const vocabScore = scoreMap['vocabulary'] ?? 70;

          const updatedCurrent = [
            { subject: 'Speaking', score: speakingScore },
            { subject: 'Listening', score: listeningScore },
            { subject: 'Writing', score: writingScore },
            { subject: 'Grammar', score: grammarScore },
            { subject: 'Vocabulary', score: vocabScore },
          ];

          setCurrentSkills(updatedCurrent);
          setPreviousSkills(
            updatedCurrent.map(s => ({ subject: s.subject, score: Math.max(0, s.score - 5) }))
          );
        }
      } catch (err) {
        console.error('Erro ao carregar dados de evolução:', err);
      } finally {
        if (isMounted) setLoadingFeedback(false);
      }
    };

    loadEvolutionData();
    return () => {
      isMounted = false;
    };
  }, [user?.id]);

  return (
    <div className="space-y-6 md:space-y-8 animate-in fade-in duration-700">
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h2 className="text-2xl md:text-3xl font-black text-gray-800 dark:text-slate-100 tracking-tight">Sua Evolução</h2>
          <p className="text-gray-500 dark:text-brand-muted text-sm">
            {classCount && classCount > 0
              ? `Baseado no histórico de suas últimas ${Math.min(classCount, 12)} aulas.`
              : 'Acompanhe seu progresso e desenvolvimento pedagógico contínuo.'}
          </p>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 min-w-0">
        {/* Radar Chart Card */}
        <CompetencyRadarChart
          currentData={currentSkills}
          previousData={previousSkills}
        />

        {/* AI Analysis Card */}
        <div className="flex flex-col gap-6 min-w-0">
          <AIReportCard studentId={user?.id} />

          <div className="bg-brand-surface p-5 sm:p-8 rounded-[2rem] sm:rounded-[2.5rem] border border-gray-100 dark:border-brand-border shadow-sm flex flex-col sm:flex-row items-start sm:items-center gap-4 sm:gap-5 min-w-0">
            <div className="p-4 bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 rounded-2xl shadow-sm shrink-0">
              <MessageSquareText size={24} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] text-gray-400 dark:text-brand-muted font-black uppercase tracking-widest">Feedback Recente do Prof.</p>
              {loadingFeedback ? (
                <p className="text-sm text-gray-400 dark:text-brand-muted mt-0.5 animate-pulse">Carregando feedback do professor...</p>
              ) : feedback ? (
                <div>
                  <p className="text-sm font-bold text-gray-800 dark:text-slate-200 mt-0.5">"{feedback.text}"</p>
                  {(feedback.teacherName || feedback.date) && (
                    <p className="text-xs text-gray-400 dark:text-brand-muted mt-1">
                      {feedback.teacherName
                        ? `${feedback.teacherName.toLowerCase().startsWith('prof') ? '' : 'Prof. '}${feedback.teacherName}`
                        : ''}
                      {feedback.teacherName && feedback.date ? ' · ' : ''}
                      {feedback.date || ''}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-gray-500 dark:text-brand-muted mt-0.5">
                  Seus feedbacks e apontamentos pedagógicos das aulas aparecerão aqui conforme as aulas forem realizadas.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default EvolutionView;
