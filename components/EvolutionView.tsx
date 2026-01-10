
import React, { useState, useEffect } from 'react';
import { Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer } from 'recharts';
import { Sparkles, TrendingUp, Target, BrainCircuit, MessageSquareText, RefreshCw } from 'lucide-react';
import { getPedagogicalSuggestion } from '../services/geminiService';

const EvolutionView: React.FC = () => {
  const [aiAnalysis, setAiAnalysis] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  
  const skillData = [
    { subject: 'Speaking', A: 85, fullMark: 100 },
    { subject: 'Listening', A: 70, fullMark: 100 },
    { subject: 'Writing', A: 60, fullMark: 100 },
    { subject: 'Grammar', A: 90, fullMark: 100 },
    { subject: 'Vocabulary', A: 75, fullMark: 100 },
  ];

  useEffect(() => {
    fetchAnalysis();
  }, []);

  const fetchAnalysis = async () => {
    setIsLoading(true);
    const result = await getPedagogicalSuggestion('B2', 'Desempenho excelente em Speaking e Grammar, necessita reforço em Listening e Writing acadêmico.');
    setAiAnalysis(result);
    setIsLoading(false);
  };

  return (
    <div className="space-y-6 md:space-y-8 animate-in fade-in duration-700">
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h2 className="text-2xl md:text-3xl font-black text-gray-800 dark:text-slate-100 tracking-tight">Sua Evolução</h2>
          <p className="text-gray-500 dark:text-slate-400 text-sm">Baseado em dados reais de suas últimas 12 aulas.</p>
        </div>
        <button 
          onClick={fetchAnalysis}
          className="text-tenant-primary text-[10px] font-black uppercase tracking-widest flex items-center gap-2 hover:bg-blue-50 dark:hover:bg-slate-800 px-4 py-2 rounded-xl transition-all"
        >
          <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} /> Recalcular Insights
        </button>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Radar Chart Card */}
        <div className="bg-white dark:bg-slate-900 p-8 rounded-[2.5rem] border border-gray-100 dark:border-slate-800 shadow-sm flex flex-col">
          <h3 className="text-xs font-black text-gray-800 dark:text-slate-200 uppercase tracking-widest mb-8 flex items-center gap-2">
             <Target size={18} className="text-tenant-primary" /> Matriz de Competências
          </h3>
          <div className="h-80 w-full flex-1">
            <ResponsiveContainer width="100%" height="100%">
              <RadarChart cx="50%" cy="50%" outerRadius="80%" data={skillData}>
                <PolarGrid stroke="#e2e8f0" className="dark:opacity-10" />
                <PolarAngleAxis dataKey="subject" tick={{ fill: '#94a3b8', fontSize: 10, fontWeight: 'bold' }} />
                <PolarRadiusAxis angle={30} domain={[0, 100]} tick={false} axisLine={false} />
                <Radar
                  name="Aluno"
                  dataKey="A"
                  stroke="var(--primary-color)"
                  fill="var(--primary-color)"
                  fillOpacity={0.4}
                />
              </RadarChart>
            </ResponsiveContainer>
          </div>
          <div className="grid grid-cols-5 gap-2 mt-8">
             {skillData.map((s, i) => (
               <div key={i} className="text-center">
                  <p className="text-[8px] font-black text-gray-400 uppercase tracking-tighter truncate">{s.subject}</p>
                  <p className="text-sm font-black text-tenant-primary">{s.A}%</p>
               </div>
             ))}
          </div>
        </div>

        {/* AI Analysis Card */}
        <div className="flex flex-col gap-6">
          <div className="bg-gradient-to-br from-tenant-primary to-indigo-900 p-8 rounded-[2.5rem] text-white shadow-xl relative overflow-hidden group flex-1 flex flex-col justify-between">
             <div className="absolute top-0 right-0 p-8 opacity-10 group-hover:scale-110 transition-transform">
                <BrainCircuit size={120} />
             </div>
             <div className="relative z-10">
                <div className="flex items-center gap-2 mb-6">
                  <div className="p-2 bg-white/20 rounded-xl backdrop-blur-md">
                    <Sparkles size={20} />
                  </div>
                  <span className="text-[10px] font-black uppercase tracking-widest">Relatório Inteligente (IA)</span>
                </div>
                <h4 className="text-xl font-bold mb-4 tracking-tight">Análise de Desempenho</h4>
                <div className="min-h-[100px]">
                  {isLoading ? (
                    <div className="flex items-center gap-2 text-blue-100/60 italic text-sm animate-pulse">
                      <RefreshCw size={14} className="animate-spin" /> Analisando padrões de aprendizagem...
                    </div>
                  ) : (
                    <p className="text-blue-100 text-sm leading-relaxed font-medium italic">
                      "{aiAnalysis}"
                    </p>
                  )}
                </div>
             </div>
             <div className="mt-8 p-5 bg-white/10 rounded-2xl border border-white/10 backdrop-blur-sm relative z-10">
                <p className="text-[10px] font-black uppercase tracking-widest text-blue-100/60 mb-1">Próximo Milestone</p>
                <p className="text-xs font-bold">Concluir o Módulo B2 (Estimado: 4 semanas)</p>
             </div>
          </div>

          <div className="bg-white dark:bg-slate-900 p-8 rounded-[2.5rem] border border-gray-100 dark:border-slate-800 shadow-sm flex items-center gap-5">
             <div className="p-4 bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 rounded-2xl shadow-sm">
                <MessageSquareText size={24} />
             </div>
             <div>
                <p className="text-[10px] text-gray-400 dark:text-slate-500 font-black uppercase tracking-widest">Feedback Recente do Prof.</p>
                <p className="text-sm font-bold text-gray-800 dark:text-slate-200 mt-0.5">"Julia está muito mais confiante para falar sobre temas técnicos em reuniões!"</p>
             </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default EvolutionView;
