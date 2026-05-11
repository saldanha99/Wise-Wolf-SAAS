import React from 'react';
import { Flame, Star, Trophy, Zap } from 'lucide-react';

interface GamificationHeaderProps {
    xp: number;
    level: number;
    streak: number;
    nextLevelXp?: number;
}

const GamificationHeader: React.FC<GamificationHeaderProps> = ({ xp, level, streak, nextLevelXp = 1000 }) => {
    const progress = (xp % nextLevelXp) / (nextLevelXp / 100);

    return (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
            {/* Level Card */}
            <div className="bg-white dark:bg-slate-900 p-4 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-sm flex items-center gap-4 group hover:border-tenant-primary transition-all">
                <div className="w-12 h-12 bg-tenant-primary/10 rounded-2xl flex items-center justify-center text-tenant-primary group-hover:scale-110 transition-transform">
                    <Trophy size={24} />
                </div>
                <div className="flex-1">
                    <div className="flex justify-between items-end mb-1">
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Nível Atual</p>
                        <p className="text-xs font-black text-tenant-primary">LEVEL {level}</p>
                    </div>
                    <div className="w-full bg-slate-100 dark:bg-slate-800 h-2 rounded-full overflow-hidden">
                        <div
                            className="bg-tenant-primary h-full transition-all duration-1000 shadow-[0_0_8px_rgba(var(--primary-color),0.4)]"
                            style={{ width: `${progress}%` }}
                        />
                    </div>
                </div>
            </div>

            {/* XP Card */}
            <div className="bg-white dark:bg-slate-900 p-4 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-sm flex items-center gap-4 group hover:border-amber-500 transition-all">
                <div className="w-12 h-12 bg-amber-500/10 rounded-2xl flex items-center justify-center text-amber-500 group-hover:scale-110 transition-transform">
                    <Zap size={24} />
                </div>
                <div>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Experiência</p>
                    <div className="flex items-baseline gap-1">
                        <span className="text-xl font-black text-slate-800 dark:text-white">{xp}</span>
                        <span className="text-[10px] font-bold text-slate-400">XP Total</span>
                    </div>
                </div>
            </div>

            {/* Streak Card */}
            <div className="bg-white dark:bg-slate-900 p-4 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-sm flex items-center gap-4 group hover:border-orange-600 transition-all">
                <div className="w-12 h-12 bg-orange-600/10 rounded-2xl flex items-center justify-center text-orange-600 group-hover:animate-bounce transition-transform">
                    <Flame size={24} />
                </div>
                <div>
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Ofensiva</p>
                    <div className="flex items-baseline gap-1">
                        <span className="text-xl font-black text-slate-800 dark:text-white">{streak}</span>
                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-tight">Dias Seguidos</span>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default GamificationHeader;
