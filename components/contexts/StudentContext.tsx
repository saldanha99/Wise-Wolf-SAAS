import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { supabase } from '../../lib/supabase';
import { AlertCircle, CreditCard, LogOut, RefreshCw } from 'lucide-react';
import { getSchoolInfo } from '../../lib/schoolInfo';
import { buildSchoolSupportContact, type SupportContact } from '../../lib/supportContact';

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
    _error?: string;
}

interface StudentContextType {
    data: StudentData | null;
    loading: boolean;
    refresh: () => Promise<void>;
}

const StudentContext = createContext<StudentContextType | undefined>(undefined);

type BlockingReason = 'financial' | 'unavailable' | null;

interface StudentProviderProps {
    children: ReactNode;
    userId: string;
    tenantId: string;
    onLogout: () => void | Promise<void>;
}

const unavailableData = (): StudentData => ({
    profile: {},
    gamification: { xp: 0, level: 1, streak: 0, nextLevelProgress: 0 },
    billing: { status: 'SUSPENDED', oldestDue: null },
    nextClass: null,
    _error: 'CONTEXT_UNAVAILABLE',
});

export const StudentProvider = ({ children, userId, tenantId, onLogout }: StudentProviderProps) => {
    const [data, setData] = useState<StudentData | null>(null);
    const [loading, setLoading] = useState(true);
    const [supportContact, setSupportContact] = useState<SupportContact | null>(null);
    const [blockingReason, setBlockingReason] = useState<BlockingReason>(null);

    const fetchStudentData = async () => {
        setLoading(true);
        setData(null);
        setBlockingReason(null);
        try {
            const { data: contextData, error } = await supabase.functions.invoke('student-context');
            if (error) throw error;
            const profile = contextData?.profile;
            const validProfile = profile?.id === userId &&
                profile?.role === 'STUDENT' &&
                profile?.tenant_id === tenantId;
            const validBilling = ['OK', 'OVERDUE', 'SUSPENDED'].includes(contextData?.billing?.status);
            if (contextData?._error || !validProfile || !validBilling) {
                throw new Error('invalid_student_context');
            }
            setData(contextData as StudentData);
            setBlockingReason(contextData.billing.status === 'SUSPENDED' ? 'financial' : null);
        } catch {
            setData(unavailableData());
            setBlockingReason('unavailable');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (userId) {
            fetchStudentData();
        }
    }, [userId]);

    useEffect(() => {
        let active = true;
        void getSchoolInfo(tenantId).then((school) => {
            if (active) {
                setSupportContact(buildSchoolSupportContact(
                    school,
                    'Olá! Preciso de ajuda para regularizar meu acesso.',
                ));
            }
        });
        return () => {
            active = false;
        };
    }, [tenantId]);

    if (loading) {
        return (
            <div className="flex min-h-dvh flex-col items-center justify-center bg-brand-surface-2 p-8 text-center dark:bg-slate-950">
                <RefreshCw className="mb-4 animate-spin text-tenant-primary" size={36} />
                <p className="text-xs font-black uppercase tracking-widest text-brand-muted">Validando seu acesso...</p>
            </div>
        );
    }

    // --- GLOBAL BLOCKING VIEW (SUSPENDED) ---
    if (blockingReason || data?.billing?.status === 'SUSPENDED') {
        const isFinancialBlock = blockingReason === 'financial';
        return (
            <div className="flex min-h-dvh flex-col items-center justify-center bg-brand-surface-2 p-6 text-center animate-in fade-in dark:bg-slate-950 sm:p-8">
                <div className="mb-6 rounded-full bg-red-100 p-6 text-red-600 dark:bg-red-900/30">
                    {isFinancialBlock ? <CreditCard size={64} /> : <AlertCircle size={64} />}
                </div>
                <h1 className="mb-4 text-3xl font-black text-brand-text">
                    {isFinancialBlock ? 'Acesso Temporariamente Suspenso' : 'Não foi possível validar seu acesso'}
                </h1>
                <p className="mb-8 max-w-md font-medium leading-relaxed text-brand-muted">
                    {isFinancialBlock
                        ? 'Identificamos uma pendência financeira superior a 7 dias. Para retomar seu acesso às aulas e ao tutor Wolfie, regularize sua situação.'
                        : 'Sua sessão e sua situação financeira não puderam ser confirmadas agora. Tente novamente; nenhum conteúdo foi liberado sem essa validação.'}
                </p>
                <div className="flex w-full max-w-md flex-col gap-3 sm:flex-row sm:flex-wrap sm:justify-center">
                    <button
                        type="button"
                        onClick={() => void fetchStudentData()}
                        className="flex-1 rounded-2xl bg-tenant-primary px-6 py-4 font-black uppercase tracking-widest text-white transition-transform hover:scale-[1.02]"
                    >
                        {isFinancialBlock ? 'Já paguei — atualizar' : 'Tentar novamente'}
                    </button>
                    {supportContact ? (
                        <a
                            href={supportContact.href}
                            target={supportContact.href.startsWith('https://') ? '_blank' : undefined}
                            rel={supportContact.href.startsWith('https://') ? 'noopener noreferrer' : undefined}
                            className="flex-1 rounded-2xl border border-brand-border px-6 py-4 font-bold uppercase tracking-widest transition-colors hover:bg-brand-surface-2 dark:border-brand-border dark:hover:bg-brand-surface-2"
                        >
                            {supportContact.label}
                        </a>
                    ) : (
                        <p className="flex-1 rounded-2xl border border-brand-border px-5 py-3 text-sm font-bold text-brand-muted" role="status">
                            Consulte os contatos da secretaria no seu contrato.
                        </p>
                    )}
                    <button
                        type="button"
                        onClick={() => void onLogout()}
                        className="inline-flex w-full items-center justify-center gap-2 rounded-2xl px-6 py-3 text-sm font-black uppercase tracking-widest text-brand-muted transition-colors hover:bg-brand-surface"
                    >
                        <LogOut size={16} /> Sair e trocar de conta
                    </button>
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
