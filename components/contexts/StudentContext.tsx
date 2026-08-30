import React, { createContext, useContext, useEffect, useState, ReactNode, Suspense } from 'react';
import { supabase } from '../../lib/supabase';
import { AlertCircle, CreditCard, FileText, LifeBuoy, LogOut, RefreshCw } from 'lucide-react';
import { getSchoolInfo } from '../../lib/schoolInfo';
import { buildSchoolSupportContact, type SupportContact } from '../../lib/supportContact';

const StudentBilling = React.lazy(() => import('../StudentBilling'));
const ContractView = React.lazy(() => import('../ContractView'));

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
    access?: {
        status: 'ACTIVE' | 'PENDING_ACTIVATION' | 'UNAVAILABLE';
        enrollmentState: string | null;
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

type BlockingReason = 'activation' | 'financial' | 'unavailable' | null;

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
    access: { status: 'UNAVAILABLE', enrollmentState: null },
    nextClass: null,
    _error: 'CONTEXT_UNAVAILABLE',
});

interface SuspendedStudentShellProps {
    userId: string;
    tenantId: string;
    mode: 'activation' | 'financial';
    supportContact: SupportContact | null;
    logoutError: string | null;
    onRefresh: () => Promise<void>;
    onLogout: () => Promise<void>;
}

const SuspendedStudentShell = ({
    userId,
    tenantId,
    mode,
    supportContact,
    logoutError,
    onRefresh,
    onLogout,
}: SuspendedStudentShellProps) => {
    const [section, setSection] = useState<'financial' | 'contract'>('financial');
    const isActivationPending = mode === 'activation';

    return (
        <div className="min-h-dvh bg-brand-surface-2 text-brand-text animate-in fade-in dark:bg-slate-950">
            <header className="border-b border-brand-border bg-brand-surface/95 px-4 py-5 shadow-sm backdrop-blur dark:bg-slate-950/95 sm:px-8">
                <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                    <div className="flex min-w-0 items-start gap-4">
                        <div className={`rounded-2xl p-3 ${isActivationPending ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30' : 'bg-red-100 text-red-600 dark:bg-red-900/30'}`}>
                            <CreditCard size={28} />
                        </div>
                        <div className="min-w-0">
                            <p className={`text-xs font-black uppercase tracking-[0.18em] ${isActivationPending ? 'text-amber-700' : 'text-red-600'}`}>
                                {isActivationPending ? 'Ativação em andamento' : 'Modo de regularização'}
                            </p>
                            <h1 className="mt-1 text-2xl font-black tracking-tight sm:text-3xl">
                                {isActivationPending ? 'Conclua o pagamento para liberar seus estudos' : 'Acesso pedagógico temporariamente suspenso'}
                            </h1>
                            <p className="mt-2 max-w-2xl text-sm font-medium leading-relaxed text-brand-muted">
                                {isActivationPending
                                    ? 'Sua matrícula ainda não tem confirmação financeira. Até a confirmação, você pode concluir o pagamento, consultar o contrato, falar com o suporte ou sair da conta.'
                                    : 'Aulas, materiais e o tutor Wolfie ficam indisponíveis enquanto houver a pendência. Seu financeiro, contrato, suporte e saída da conta continuam acessíveis.'}
                            </p>
                        </div>
                    </div>

                    <div className="flex flex-col gap-2 sm:flex-row">
                        <button
                            type="button"
                            onClick={() => void onRefresh()}
                            className="inline-flex items-center justify-center gap-2 rounded-xl bg-tenant-primary px-4 py-3 text-xs font-black uppercase tracking-widest text-white"
                        >
                            <RefreshCw size={15} /> {isActivationPending ? 'Verificar pagamento' : 'Já paguei — atualizar'}
                        </button>
                        {supportContact ? (
                            <a
                                href={supportContact.href}
                                target={supportContact.href.startsWith('https://') ? '_blank' : undefined}
                                rel={supportContact.href.startsWith('https://') ? 'noopener noreferrer' : undefined}
                                className="inline-flex items-center justify-center gap-2 rounded-xl border border-brand-border bg-brand-surface px-4 py-3 text-xs font-black uppercase tracking-widest"
                            >
                                <LifeBuoy size={15} /> {supportContact.label}
                            </a>
                        ) : (
                            <button
                                type="button"
                                onClick={() => setSection('contract')}
                                className="inline-flex items-center justify-center gap-2 rounded-xl border border-brand-border bg-brand-surface px-4 py-3 text-xs font-black uppercase tracking-widest"
                            >
                                <LifeBuoy size={15} /> Contatos no contrato
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={() => void onLogout()}
                            className="inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-xs font-black uppercase tracking-widest text-brand-muted hover:bg-brand-surface"
                        >
                            <LogOut size={15} /> Sair
                        </button>
                    </div>
                </div>
                {logoutError && (
                    <p className="mx-auto mt-4 w-full max-w-7xl rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700" role="alert">
                        {logoutError}
                    </p>
                )}
            </header>

            <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-8 sm:py-8">
                <nav className="mb-6 grid grid-cols-2 gap-2 rounded-2xl border border-brand-border bg-brand-surface p-2" aria-label="Áreas disponíveis durante a restrição">
                    <button
                        type="button"
                        onClick={() => setSection('financial')}
                        aria-current={section === 'financial' ? 'page' : undefined}
                        className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-xs font-black uppercase tracking-widest transition-colors ${section === 'financial' ? 'bg-tenant-primary text-white' : 'text-brand-muted hover:bg-brand-surface-2'}`}
                    >
                        <CreditCard size={16} /> Financeiro
                    </button>
                    <button
                        type="button"
                        onClick={() => setSection('contract')}
                        aria-current={section === 'contract' ? 'page' : undefined}
                        className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-xs font-black uppercase tracking-widest transition-colors ${section === 'contract' ? 'bg-tenant-primary text-white' : 'text-brand-muted hover:bg-brand-surface-2'}`}
                    >
                        <FileText size={16} /> Contrato
                    </button>
                </nav>

                <Suspense fallback={(
                    <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-brand-muted" role="status">
                        <RefreshCw className="animate-spin" size={28} />
                        <p className="text-xs font-black uppercase tracking-widest">Carregando área segura...</p>
                    </div>
                )}>
                    {section === 'financial'
                        ? <StudentBilling user={{ id: userId, tenantId }} />
                        : <ContractView userId={userId} />}
                </Suspense>
            </main>
        </div>
    );
};

export const StudentProvider = ({ children, userId, tenantId, onLogout }: StudentProviderProps) => {
    const [data, setData] = useState<StudentData | null>(null);
    const [loading, setLoading] = useState(true);
    const [supportContact, setSupportContact] = useState<SupportContact | null>(null);
    const [blockingReason, setBlockingReason] = useState<BlockingReason>(null);
    const [logoutError, setLogoutError] = useState<string | null>(null);

    const logout = async () => {
        setLogoutError(null);
        try {
            await onLogout();
        } catch {
            setLogoutError('Não foi possível encerrar a sessão. Tente novamente.');
        }
    };

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
            const accessStatus = contextData?.access?.status;
            const validAccess = accessStatus === undefined || ['ACTIVE', 'PENDING_ACTIVATION'].includes(accessStatus);
            if (contextData?._error || !validProfile || !validBilling || !validAccess) {
                throw new Error('invalid_student_context');
            }
            setData(contextData as StudentData);
            setBlockingReason(
                accessStatus === 'PENDING_ACTIVATION'
                    ? 'activation'
                    : contextData.billing.status === 'SUSPENDED'
                        ? 'financial'
                        : null,
            );
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
    }, [userId, tenantId]);

    useEffect(() => {
        let active = true;
        void getSchoolInfo(tenantId)
            .then((school) => {
                if (active) {
                    setSupportContact(buildSchoolSupportContact(
                        school,
                        'Olá! Preciso de ajuda para regularizar meu acesso.',
                    ));
                }
            })
            .catch(() => {
                if (active) setSupportContact(null);
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

    if (blockingReason === 'unavailable' || !data) {
        return (
            <div className="flex min-h-dvh flex-col items-center justify-center bg-brand-surface-2 p-6 text-center animate-in fade-in dark:bg-slate-950 sm:p-8">
                <div className="mb-6 rounded-full bg-red-100 p-6 text-red-600 dark:bg-red-900/30">
                    <AlertCircle size={64} />
                </div>
                <h1 className="mb-4 text-3xl font-black text-brand-text">Não foi possível validar seu acesso</h1>
                <p className="mb-8 max-w-md font-medium leading-relaxed text-brand-muted">
                    Sua sessão e sua situação financeira não puderam ser confirmadas agora. Tente novamente; nenhum conteúdo foi liberado sem essa validação.
                </p>
                <div className="flex w-full max-w-md flex-col gap-3 sm:flex-row sm:flex-wrap sm:justify-center">
                    <button
                        type="button"
                        onClick={() => void fetchStudentData()}
                        className="flex-1 rounded-2xl bg-tenant-primary px-6 py-4 font-black uppercase tracking-widest text-white transition-transform hover:scale-[1.02]"
                    >
                        Tentar novamente
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
                        onClick={() => void logout()}
                        className="inline-flex w-full items-center justify-center gap-2 rounded-2xl px-6 py-3 text-sm font-black uppercase tracking-widest text-brand-muted transition-colors hover:bg-brand-surface"
                    >
                        <LogOut size={16} /> Sair e trocar de conta
                    </button>
                    {logoutError && (
                        <p className="w-full rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700" role="alert">
                            {logoutError}
                        </p>
                    )}
                </div>
            </div>
        );
    }

    const contextValue = { data, loading, refresh: fetchStudentData };

    if (blockingReason === 'activation' || blockingReason === 'financial' || data.billing.status === 'SUSPENDED') {
        return (
            <StudentContext.Provider value={contextValue}>
                <SuspendedStudentShell
                    userId={userId}
                    tenantId={tenantId}
                    mode={blockingReason === 'activation' ? 'activation' : 'financial'}
                    supportContact={supportContact}
                    logoutError={logoutError}
                    onRefresh={fetchStudentData}
                    onLogout={logout}
                />
            </StudentContext.Provider>
        );
    }

    return (
        <StudentContext.Provider value={contextValue}>
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
