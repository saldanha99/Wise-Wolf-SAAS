import React from 'react';
import { Layout, Globe } from 'lucide-react';
import LandingPageEditor from './marketing/LandingPageEditor';

interface LandingPageBuilderProps {
    tenantId: string;
}

const LandingPageBuilder: React.FC<LandingPageBuilderProps> = ({ tenantId }) => {
    return (
        <div className="space-y-6 animate-in fade-in duration-500 font-sans">
            {/* Header Section */}
            <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 bg-white dark:bg-slate-900 p-6 rounded-[32px] shadow-[0px_4px_24px_rgba(0,0,0,0.02)] border border-slate-50 dark:border-slate-800">
                <div>
                    <h2 className="text-2xl md:text-3xl font-bold text-slate-900 dark:text-white flex items-center gap-3">
                        Páginas & Marketing
                    </h2>
                    <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">
                        Crie landing pages de alta conversão para sua escola.
                    </p>
                </div>
                <div className="bg-purple-50 dark:bg-purple-900/20 p-3 rounded-2xl text-purple-600 dark:text-purple-400">
                    <Layout size={24} />
                </div>
            </header>

            {/* Main Content Area */}
            <div className="min-h-[600px] bg-white dark:bg-slate-900 rounded-[32px] border border-slate-50 dark:border-slate-800 shadow-xl shadow-slate-200/50 dark:shadow-none overflow-hidden animate-in fade-in slide-in-from-right-4 duration-500">
                <LandingPageEditor tenantId={tenantId} />
            </div>
        </div>
    );
};

export default LandingPageBuilder;
