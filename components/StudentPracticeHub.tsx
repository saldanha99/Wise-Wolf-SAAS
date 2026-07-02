import React from 'react';
import { Target, Sparkles, Zap } from 'lucide-react';
import StudentLearningPaths from './StudentLearningPaths';
import StudentActivities from './StudentActivities';

interface StudentPracticeHubProps {
    userId: string;
    tenantId?: string;
    wolfieConfig?: any;
}

/**
 * Hub de Prática — reúne Trilhas Didáticas e Atividades Complementares
 * em uma página dedicada acessível pelo sidebar do aluno.
 */
const StudentPracticeHub: React.FC<StudentPracticeHubProps> = ({ userId, tenantId, wolfieConfig }) => {
    return (
        <div className="space-y-4 sm:space-y-8 animate-fade-in-up pb-8 sm:pb-20 font-sans">

            {/* Cabeçalho da seção */}
            <div className="relative rounded-[2.5rem] overflow-hidden bg-gradient-to-br from-violet-700 via-purple-700 to-indigo-700 shadow-2xl shadow-violet-500/20 text-white p-5 sm:p-8 md:p-10">
                {/* Efeitos de fundo */}
                <div className="absolute top-0 right-0 w-[400px] h-[400px] bg-white/5 rounded-full blur-[80px] -translate-y-1/2 translate-x-1/3 pointer-events-none" />
                <div className="absolute bottom-0 left-0 w-[300px] h-[300px] bg-black/10 rounded-full blur-[60px] translate-y-1/2 -translate-x-1/4 pointer-events-none" />

                <div className="relative z-10 flex items-center gap-4 md:gap-6">
                    <div className="hidden sm:flex w-16 h-16 rounded-2xl bg-white/15 backdrop-blur-sm border border-white/20 items-center justify-center shadow-lg shrink-0">
                        <Target size={32} className="text-white" />
                    </div>
                    <div>
                        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/15 border border-white/20 text-[10px] font-black uppercase tracking-widest mb-3 text-white/90">
                            <Sparkles size={10} />
                            <span>Personalizado por IA</span>
                        </div>
                        <h1 className="text-2xl md:text-3xl font-black text-white tracking-tight mb-1">
                            Hora de Praticar
                        </h1>
                        <p className="text-white/70 text-sm font-medium max-w-lg">
                            Suas trilhas didáticas e atividades complementares — tudo em um só lugar para acelerar sua evolução.
                        </p>
                    </div>

                    {/* Stat pill */}
                    <div className="ml-auto hidden md:flex items-center gap-2 px-4 py-2 bg-white/10 backdrop-blur-sm border border-white/20 rounded-2xl shrink-0">
                        <Zap size={14} className="text-amber-300" />
                        <span className="text-xs font-black text-white/90 uppercase tracking-wider">Ganhe XP completando</span>
                    </div>
                </div>
            </div>

            {/* Trilhas Didáticas */}
            <StudentLearningPaths
                userId={userId}
                tenantId={tenantId}
                wolfieConfig={wolfieConfig}
            />

            {/* Atividades Complementares geradas por IA */}
            <StudentActivities
                userId={userId}
                tenantId={tenantId}
            />

        </div>
    );
};

export default StudentPracticeHub;
