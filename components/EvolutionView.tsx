
import React, { useState, useEffect } from 'react';
import { MessageSquareText } from 'lucide-react';
import CompetencyRadarChart from './CompetencyRadarChart';
import AIReportCard from './AIReportCard';

interface EvolutionViewProps {
  user?: any;
}

const EvolutionView: React.FC<EvolutionViewProps> = ({ user }) => {

  return (
    <div className="space-y-6 md:space-y-8 animate-in fade-in duration-700">
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h2 className="text-2xl md:text-3xl font-black text-gray-800 dark:text-slate-100 tracking-tight">Sua Evolução</h2>
          <p className="text-gray-500 dark:text-slate-400 text-sm">Baseado em dados reais de suas últimas 12 aulas.</p>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Radar Chart Card (Refactored) */}
        <CompetencyRadarChart
          currentData={[
            { subject: 'Speaking', score: 85 },
            { subject: 'Listening', score: 70 },
            { subject: 'Writing', score: 60 },
            { subject: 'Grammar', score: 90 },
            { subject: 'Vocabulary', score: 75 },
          ]}
          previousData={[
            { subject: 'Speaking', score: 80 },
            { subject: 'Listening', score: 65 },
            { subject: 'Writing', score: 55 },
            { subject: 'Grammar', score: 88 },
            { subject: 'Vocabulary', score: 70 },
          ]}
        />

        {/* AI Analysis Card */}
        <div className="flex flex-col gap-6">
          <AIReportCard studentId={user?.id} />

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
