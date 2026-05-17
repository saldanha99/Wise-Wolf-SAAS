import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { supabase } from '../../lib/supabase';
import { CreditCard, RefreshCw } from 'lucide-react';

interface StudentData {
    profile: any;
    gamification: {
        xp: number;
        level: number;
        streak: number;
        nextLevelProgress: number;
    };
    billing: {
        status: 'OK' | 'OVERDUE' | 'SUSPENDED';
        oldestDue: string | null;
    };
    nextClass: any;
}

interface StudentContextType {
    data: StudentData | null;
    loading: boolean;
    refresh: () => Promise<void>;
}

const StudentContext = createContext<StudentContextType | undefined>(undefined);

export const StudentProvider = ({ children, userId }: { children: ReactNode, userId: string }) => {
    const [data, setData] = useState<StudentData | null>(null);
    const [loading, setLoading] = useState(true);

    const fetchStudentData = async () => {
        setLoading(true);
        try {
            console.log('🔄 StudentContext: Fetching fresh data...');
            const { data: contextData, error } = await supabase.functions.invoke('student-context');
            if (error) throw error;
            setData(contextData);
        } catch (err) {
            console.error('❌ StudentContext Error:', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (userId) {
            fetchStudentData();
        }
    }, [userId]);

    // --- GLOBAL BLOCKING VIEW (SUSPENDED) ---
    if (!loading && data?.billing?.status === 'SUSPENDED') {
        return (
            <div className="flex flex-col items-center justify-center min-h-screen bg-brand-surface-2 dark:bg-slate-950 text-center p-8 animate-in fade-in">
                <div className="p-6 bg-red-100 dark:bg-red-900/30 text-red-600 rounded-full mb-6">
                    <CreditCard size={64} />
                </div>
                <h1 className="text-3xl font-black text-brand-text mb-4">Acesso Temporariamente Suspenso</h1>
                <p className="max-w-md text-brand-muted font-medium leading-relaxed mb-8">
                    Identificamos uma pendência financeira superior a 7 dias.
                    Para retomar seu acesso às aulas e ao tutor Wolfie, por favor regularize sua situação.
                </p>
                <div className="flex gap-4">
                    <button
                        onClick={() => window.location.reload()}
                        className="px-8 py-4 bg-tenant-primary text-white rounded-2xl font-black uppercase tracking-widest hover:scale-105 transition-transform"
                    >
                        Já Paguei (Atualizar)
                    </button>
                    <a
                        href="https://wa.me/5511999999999"
                        target="_blank"
                        className="px-8 py-4 border border-brand-border dark:border-brand-border rounded-2xl font-bold uppercase tracking-widest hover:bg-brand-surface-2 dark:hover:bg-brand-surface-2 transition-colors"
                    >
                        Suporte
                    </a>
                </div>
            </div>
        );
    }

    return (
        <StudentContext.Provider value={{ data, loading, refresh: fetchStudentData }}>
            {children}
        </StudentContext.Provider>
    );
};

export const useStudentContext = () => {
    const context = useContext(StudentContext);
    if (!context) {
        throw new Error('useStudentContext must be used within a StudentProvider');
    }
    return context;
};
