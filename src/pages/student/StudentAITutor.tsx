import React from 'react';
import WolfieTutor from '../../../components/WolfieTutor';
import { Sparkles } from 'lucide-react';

const StudentAITutor: React.FC<{ user: any }> = ({ user }) => {
    return (
        <div className="flex flex-col h-full space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-black text-slate-800 dark:text-white flex items-center gap-2">
                        <Sparkles className="text-indigo-600 dark:text-indigo-400" />
                        Wolfie AI Tutor <span className="text-2xl">🐺</span>
                    </h1>
                    <p className="text-slate-500 dark:text-slate-400 font-medium">
                        Pratique conversação em tempo real com sua IA nativa.
                    </p>
                </div>
                <div className="hidden md:block">
                    <span className="px-3 py-1 bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 rounded-full text-xs font-bold uppercase tracking-wide">
                        Beta
                    </span>
                </div>
            </div>

            <div className="flex-1 min-h-0">
                <WolfieTutor user={user} />
            </div>
        </div>
    );
};

export default StudentAITutor;
