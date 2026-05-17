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
                    <h2 className="text-4xl font-black text-brand-text tracking-tighter">Automação Smart ⚡</h2>
                    <p className="text-brand-muted text-sm mt-1">Conecte seu WhatsApp e configure mensagens automáticas.</p>
                </div>
            </div>

            {/* Tabs */}
            <div className="flex items-center gap-1 p-1 bg-brand-surface-2 dark:bg-brand-surface-2 rounded-xl w-fit">
                <button
                    onClick={() => setActiveTab('connection')}
                    className={`px-6 py-2.5 rounded-lg text-xs font-black uppercase tracking-widest transition-all ${activeTab === 'connection' ? 'bg-brand-surface dark:bg-slate-700 text-brand-text shadow-sm' : 'text-brand-muted hover:text-brand-muted dark:hover:text-slate-300'}`}
                >
                    <span className="flex items-center gap-2"><SettingsIcon size={14} /> Conexão</span>
                </button>
                <button
                    onClick={() => setActiveTab('templates')}
                    className={`px-6 py-2.5 rounded-lg text-xs font-black uppercase tracking-widest transition-all ${activeTab === 'templates' ? 'bg-brand-surface dark:bg-slate-700 text-brand-text shadow-sm' : 'text-brand-muted hover:text-brand-muted dark:hover:text-slate-300'}`}
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
                    <div className="flex flex-col items-center justify-center h-64 text-brand-muted bg-brand-surface rounded-[2.5rem] border border-dashed border-brand-border dark:border-brand-border">
                        <div className="w-16 h-16 bg-brand-surface-2 rounded-2xl flex items-center justify-center mb-4">
                            <Zap size={24} className="text-slate-300" />
                        </div>
                        <p className="text-sm font-bold uppercase tracking-widest">Em Breve: Editor de Templates</p>
                        <p className="text-xs text-brand-muted mt-2 max-w-sm text-center">Você poderá criar mensagens personalizadas para lembretes, cobranças e boas-vindas.</p>
                    </div>
                )}
            </div>

        </div>
    );
};

export default WhatsappConfig;
