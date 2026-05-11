import React, { useState } from 'react';
import { Zap, MessageSquare, Settings as SettingsIcon } from 'lucide-react';
import EvolutionConnection from './EvolutionConnection';
import { User as UserType } from '../types';

interface WhatsappConfigProps {
    user: UserType;
    tenantId?: string;
}

const WhatsappConfig: React.FC<WhatsappConfigProps> = ({ user, tenantId }) => {
    const [activeTab, setActiveTab] = useState<'connection' | 'templates'>('connection');

    return (
        <div className="max-w-6xl mx-auto space-y-8 animate-in fade-in duration-500">

            {/* Header */}
            <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
                <div>
                    <h2 className="text-4xl font-black text-slate-800 dark:text-white tracking-tighter">Automação Smart ⚡</h2>
                    <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">Conecte seu WhatsApp e configure mensagens automáticas.</p>
                </div>
            </div>

            {/* Tabs */}
            <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-xl w-fit">
                <button
                    onClick={() => setActiveTab('connection')}
                    className={`px-6 py-2.5 rounded-lg text-xs font-black uppercase tracking-widest transition-all ${activeTab === 'connection' ? 'bg-white dark:bg-slate-700 text-slate-800 dark:text-white shadow-sm' : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'}`}
                >
                    <span className="flex items-center gap-2"><SettingsIcon size={14} /> Conexão</span>
                </button>
                <button
                    onClick={() => setActiveTab('templates')}
                    className={`px-6 py-2.5 rounded-lg text-xs font-black uppercase tracking-widest transition-all ${activeTab === 'templates' ? 'bg-white dark:bg-slate-700 text-slate-800 dark:text-white shadow-sm' : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'}`}
                >
                    <span className="flex items-center gap-2"><MessageSquare size={14} /> Templates</span>
                </button>
            </div>

            {/* Content */}
            <div className="min-h-[500px]">
                {activeTab === 'connection' && (
                    <EvolutionConnection user={user} tenantId={tenantId} />
                )}

                {activeTab === 'templates' && (
                    <div className="flex flex-col items-center justify-center h-64 text-slate-400 bg-white dark:bg-slate-900 rounded-[2.5rem] border border-dashed border-slate-200 dark:border-slate-800">
                        <div className="w-16 h-16 bg-slate-50 dark:bg-slate-800 rounded-2xl flex items-center justify-center mb-4">
                            <Zap size={24} className="text-slate-300" />
                        </div>
                        <p className="text-sm font-bold uppercase tracking-widest">Em Breve: Editor de Templates</p>
                        <p className="text-xs text-slate-400 mt-2 max-w-sm text-center">Você poderá criar mensagens personalizadas para lembretes, cobranças e boas-vindas.</p>
                    </div>
                )}
            </div>

        </div>
    );
};

export default WhatsappConfig;
