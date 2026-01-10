import React, { useState } from 'react';
import { Kanban, Edit3, Layout, Settings, ExternalLink } from 'lucide-react';
import LandingPageEditor from './LandingPageEditor';
import LeadsKanban from './LeadsKanban';

interface MarketingManagerProps {
  tenantId: string;
}

const MarketingManager: React.FC<MarketingManagerProps> = ({ tenantId }) => {
  const [activeTab, setActiveTab] = useState<'editor' | 'leads'>('leads');

  return (
    <div className="space-y-6 animate-in fade-in duration-500 font-sans">
      {/* Header Section - Glass Style */}
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 bg-white dark:bg-slate-900 p-6 rounded-[32px] shadow-[0px_4px_24px_rgba(0,0,0,0.02)] border border-slate-50 dark:border-slate-800">
        <div>
          <h2 className="text-2xl md:text-3xl font-bold text-slate-900 dark:text-white flex items-center gap-3">
            Site & Vendas
          </h2>
          <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">
            Gerencie sua presença online e acompanhe o funil de matrículas.
          </p>
        </div>

        <div className="flex bg-slate-100 dark:bg-slate-800 p-1.5 rounded-2xl">
          <button
            onClick={() => setActiveTab('leads')}
            className={`px-6 py-2.5 rounded-xl text-xs font-bold uppercase tracking-widest flex items-center gap-2 transition-all duration-300 ${activeTab === 'leads'
                ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/30'
                : 'text-slate-500 hover:text-slate-700 hover:bg-white/50 dark:hover:bg-slate-700/50'
              }`}
          >
            <Kanban size={16} strokeWidth={2.5} /> Pipeline
          </button>
          <button
            onClick={() => setActiveTab('editor')}
            className={`px-6 py-2.5 rounded-xl text-xs font-bold uppercase tracking-widest flex items-center gap-2 transition-all duration-300 ${activeTab === 'editor'
                ? 'bg-purple-600 text-white shadow-lg shadow-purple-500/30'
                : 'text-slate-500 hover:text-slate-700 hover:bg-white/50 dark:hover:bg-slate-700/50'
              }`}
          >
            <Edit3 size={16} strokeWidth={2.5} /> Editor Web
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="min-h-[600px]">
        {activeTab === 'editor' ? (
          <div className="bg-white dark:bg-slate-900 rounded-[32px] border border-slate-50 dark:border-slate-800 shadow-xl shadow-slate-200/50 dark:shadow-none overflow-hidden animate-in fade-in slide-in-from-right-4 duration-500">
            <LandingPageEditor tenantId={tenantId} />
          </div>
        ) : (
          <div className="animate-in fade-in slide-in-from-left-4 duration-500">
            <LeadsKanban tenantId={tenantId} />
          </div>
        )}
      </div>
    </div>
  );
};

export default MarketingManager;
