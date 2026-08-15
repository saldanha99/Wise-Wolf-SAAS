import React, { useEffect, useState } from 'react';
import {
    Users,
    Search,
    Plus,
    MoreHorizontal,
    Mail,
    Phone,
    Award,
    TrendingUp,
    DollarSign,
    Briefcase,
    X,
    CheckCircle,
    Save,
    BookOpen,
    RefreshCw,
    Link,
    FileText,
    UserX,
    UserCheck,
    AlertTriangle,
    CalendarOff,
    Flame,
    Zap
} from 'lucide-react';
import { Teacher, UserRole } from '../types';
import { TEACHER_SPECIALIZATIONS } from '../constants';
import {
    effectiveTeacherLifecycle,
    parseTeacherOrganizationSnapshot,
    teacherMatchesListView,
    type TeacherLifecycle,
    type TeacherListView,
    type TeacherOrganizationSnapshot,
} from '../lib/teacherOrganization';

import { supabase } from '../lib/supabase';
import TeacherInviteGenerator from './TeacherInviteGenerator';
import TeacherFinancials from './TeacherFinancials';
import AbsenceCoverageManager from './AbsenceCoverageManager';

interface TeacherManagementProps {
    teachers: Teacher[];
    currentTenantId?: string;
    onAddTeacher: (teacher: Teacher) => void;
    onEditTeacher?: (teacher: Teacher) => void;
    onViewTeacherSchedule?: (teacherName: string, action?: 'view' | 'allocate') => void;
}

const TeacherManagement: React.FC<TeacherManagementProps> = ({ teachers, currentTenantId, onAddTeacher, onEditTeacher, onViewTeacherSchedule }) => {
    // ... Existing state remains same
    const [searchTerm, setSearchTerm] = useState('');
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
    const [viewingFinancialsId, setViewingFinancialsId] = useState<string | null>(null);
    const [listView, setListView] = useState<TeacherListView>('active');
    const [turboById, setTurboById] = useState<Record<string, TeacherOrganizationSnapshot | null>>({});
    const [turboLoadState, setTurboLoadState] = useState<'loading' | 'ready'>('loading');

    const handleListTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
        let nextView: TeacherListView | null = null;
        if (event.key === 'ArrowRight' || event.key === 'End') nextView = 'inactive';
        if (event.key === 'ArrowLeft' || event.key === 'Home') nextView = 'active';
        if (!nextView) return;

        event.preventDefault();
        setListView(nextView);
        document.getElementById(`teacher-${nextView}-tab`)?.focus();
    };

    // Ciclo de vida do professor (suspender/desligar/reativar) via school-admin.
    // suspended/offboarded tira o professor do cruzamento de agenda e do lançamento de aula.
    // Estado otimista local: o badge usa lifecycle_status canônico (não o legado teacher.status).
    const [lifecycleById, setLifecycleById] = useState<Record<string, TeacherLifecycle>>({});
    const [coverageTeacher, setCoverageTeacher] = useState<{ id: string; name: string } | null>(null);
    const effLifecycle = (teacher: Teacher): TeacherLifecycle =>
        effectiveTeacherLifecycle(teacher, lifecycleById[teacher.id]);

    useEffect(() => {
        let cancelled = false;

        const loadTurboSnapshots = async () => {
            if (!teachers.length) {
                setTurboById({});
                setTurboLoadState('ready');
                return;
            }

            setTurboLoadState('loading');
            const entries = await Promise.all(teachers.map(async teacher => {
                try {
                    const { data, error } = await supabase.rpc('teacher_turbo_status', {
                        p_teacher: teacher.id,
                    });
                    if (error) throw error;

                    const snapshot = parseTeacherOrganizationSnapshot(data);
                    if (!snapshot) throw new Error('resposta inválida da teacher_turbo_status');
                    return [teacher.id, snapshot] as const;
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    console.warn(`Não foi possível carregar a organização de ${teacher.id}:`, message);
                    return [teacher.id, null] as const;
                }
            }));

            if (!cancelled) {
                setTurboById(Object.fromEntries(entries));
                setTurboLoadState('ready');
            }
        };

        void loadTurboSnapshots();
        return () => { cancelled = true; };
    }, [teachers]);

    const setTeacherLifecycle = async (teacher: Teacher, status: TeacherLifecycle) => {
        const labels: Record<string, string> = {
            suspended: `Suspender ${teacher.name}?\n\nO professor SAI do cruzamento de agenda e para de receber agenda diária/notificações. Reversível.\n\n⚠️ Os convites de aula experimental são enviados no GRUPO de WhatsApp dos professores. Para ele parar de recebê-los, remova-o do grupo manualmente no WhatsApp.`,
            offboarded: `Desligar ${teacher.name} definitivamente?\n\nSai do cruzamento de agenda e do lançamento de aula. Lembre de transferir os alunos dele (Transferência de Professor).\n\n⚠️ Remova-o também do GRUPO de WhatsApp dos professores — os convites de experimental são disparados no grupo e o sistema não consegue barrar por lá.`,
            active: `Reativar ${teacher.name}?\n\nVolta ao cruzamento de agenda e às automações.`,
        };
        const reason = status === 'active' ? null : window.prompt(labels[status] + '\n\nMotivo:', '');
        if (status !== 'active' && reason === null) return;
        if (status === 'active' && !window.confirm(labels.active)) return;
        try {
            const { data, error } = await supabase.functions.invoke('school-admin', {
                body: { action: 'setTeacherLifecycle', teacherId: teacher.id, status, reason: reason || undefined },
            });
            if (error || (data && (data as any).ok === false)) throw new Error(error?.message || (data as any)?.error || 'falha');
            setLifecycleById(prev => ({ ...prev, [teacher.id]: status }));
        } catch (err: any) {
            alert('Erro ao alterar status do professor: ' + (err.message || 'tente novamente.'));
        }
    };

    // New Teacher Form State
    const initialFormState = {
        name: '',
        email: '',
        phone: '',
        module: 'Inglês Geral',
        hourlyRate: '35.00',
        pixKey: '',
        bio: '',
        status: 'Ativo',
        meetingLink: '',
        whatsappInstance: '',
        contractUrl: ''
    };
    const [formData, setFormData] = useState({ ...initialFormState, status: 'Ativo' });
    const [editingTeacherId, setEditingTeacherId] = useState<string | null>(null);
    const [selectedSpecs, setSelectedSpecs] = useState<string[]>([]);

    const handleEdit = (teacher: Teacher) => {
        setEditingTeacherId(teacher.id);
        setSelectedSpecs(teacher.specializations || []);
        setFormData({
            name: teacher.name,
            email: teacher.email,
            phone: teacher.phone || '',
            module: teacher.module || '',
            hourlyRate: (teacher.hourlyRate || 0).toString(),
            pixKey: teacher.pixKey || '',
            bio: '',
            status: teacher.status || 'Ativo',
            meetingLink: (teacher as any).meetingLink || '',
            whatsappInstance: (teacher as any).whatsappInstance || '',
            contractUrl: (teacher as any).contractUrl || ''
        } as any);
        setIsModalOpen(true);
    };

    const toggleSpec = (spec: string) => {
        setSelectedSpecs(prev =>
            prev.includes(spec) ? prev.filter(s => s !== spec) : [...prev, spec]
        );
    };

    const handleSave = async () => {
        if (!formData.name || !formData.email || !currentTenantId) {
            alert("Erro: Dados incompletos ou unidade não identificada.");
            return;
        }
        setIsSaving(true);

        try {
            if (editingTeacherId) {
                // UPDATE Mode
                const { error } = await supabase
                    .from('profiles')
                    .update({
                        full_name: formData.name,
                        module: formData.module,
                        phone: formData.phone,
                        hourly_rate: parseFloat(formData.hourlyRate),
                        pix_key: formData.pixKey,
                        status: (formData as any).status,
                        meeting_link: (formData as any).meetingLink,
                        whatsapp_instance: (formData as any).whatsappInstance,
                        contract_url: (formData as any).contractUrl || null,
                        specializations: selectedSpecs
                    })
                    .eq('id', editingTeacherId);

                if (error) throw error;

                if (onEditTeacher) {
                    onEditTeacher({
                        ...teachers.find(t => t.id === editingTeacherId)!,
                        name: formData.name,
                        module: formData.module,
                        phone: formData.phone,
                        hourlyRate: parseFloat(formData.hourlyRate),
                        pixKey: formData.pixKey,
                        status: (formData as any).status as any,
                        meetingLink: (formData as any).meetingLink,
                        contractUrl: (formData as any).contractUrl,
                        whatsappInstance: (formData as any).whatsappInstance
                    });
                }
                alert("Dados do professor atualizados com sucesso!");
            } else {
                // CREATE Mode
                let targetId = null;

                // 1. Check if profile already exists for THIS email in THIS tenant
                const { data: existingInTenant } = await supabase
                    .from('profiles')
                    .select('id')
                    .eq('email', formData.email)
                    .eq('tenant_id', currentTenantId)
                    .single();

                if (existingInTenant) {
                    targetId = existingInTenant.id;
                    alert("Este e-mail já está vinculado a um perfil nesta unidade.");
                    return; // Stop here if exists in tenant
                } else {
                    // 2. Call Edge Function to Create User & Profile
                    const { data: funcData, error: funcError } = await supabase.functions.invoke('create-teacher-account', {
                        body: {
                            name: formData.name,
                            email: formData.email,
                            phone: formData.phone,
                            hourlyRate: parseFloat(formData.hourlyRate),
                            pixKey: formData.pixKey,
                            zoomLink: (formData as any).meetingLink,
                            whatsappId: (formData as any).whatsappInstance,
                            contractUrl: (formData as any).contractUrl,
                            tenantId: currentTenantId // Critical for multi-tenancy
                        }
                    });

                    if (funcError) {
                        throw new Error(funcError.message || "Erro ao criar conta via servidor.");
                    }

                    if (funcData?.error) {
                        throw new Error(funcData.error);
                    }

                    targetId = funcData.user.id;

                    // Success!
                    alert(`Professor cadastrado! Acesso: Senha 123456`);
                }

                if (!targetId) throw new Error("Não foi possível processar o cadastro.");

                // 4. Update UI state (Optimistic update)
                const newTeacher: Teacher = {
                    id: targetId,
                    name: formData.name,
                    email: formData.email,
                    role: UserRole.TEACHER,
                    avatar: `https://ui-avatars.com/api/?name=${formData.name}&background=random`,
                    module: formData.module,
                    modules: [formData.module],
                    specializations: selectedSpecs,
                    hourlyRate: parseFloat(formData.hourlyRate),
                    pixKey: formData.pixKey,
                    phone: formData.phone,
                    studentsCount: 0,
                    classesCount: 0,
                    retention: '100%',
                    tpi: 100,
                    status: 'Ativo',
                    lifecycle_status: 'active',
                    occupancy: 0
                };

                onAddTeacher(newTeacher);
            }

            setIsModalOpen(false);
            setEditingTeacherId(null);
            setSelectedSpecs([]);
            setFormData(initialFormState as any);
        } catch (err: any) {
            alert("Erro ao salvar: " + err.message);
        } finally {
            setIsSaving(false);
        }
    };

    const activeCount = teachers.filter(t => effLifecycle(t) === 'active').length;
    const inactiveCount = teachers.length - activeCount;
    const normalizedSearch = searchTerm.trim().toLocaleLowerCase('pt-BR');
    const filteredTeachers = teachers.filter(t => {
        const lifecycleMatches = teacherMatchesListView(t, listView, lifecycleById[t.id]);
        const searchMatches = !normalizedSearch ||
            t.name.toLocaleLowerCase('pt-BR').includes(normalizedSearch) ||
            t.email.toLocaleLowerCase('pt-BR').includes(normalizedSearch);
        return lifecycleMatches && searchMatches;
    });

    return (
        <div className="space-y-6 md:space-y-8 animate-in fade-in duration-500">
            <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                    <h2 className="text-2xl md:text-3xl font-black text-gray-800 dark:text-slate-100 tracking-tight flex items-center gap-3">
                        <Users className="text-tenant-primary" size={28} /> Gestão do Corpo Docente
                    </h2>
                    <p className="text-gray-500 dark:text-brand-muted text-sm">Administre os professores, contratos e atribuições.</p>
                </div>
                <div className="w-full md:w-auto flex flex-col sm:flex-row gap-3">
                    <button
                        onClick={() => setIsInviteModalOpen(true)}
                        className="w-full md:w-auto bg-brand-surface text-tenant-primary border border-tenant-primary/20 px-6 py-3 rounded-xl font-bold text-xs uppercase tracking-widest hover:bg-tenant-primary/5 transition-all flex items-center justify-center gap-2 whitespace-nowrap"
                    >
                        <Link size={18} /> Convidar (Link)
                    </button>
                    <button
                        onClick={() => setIsModalOpen(true)}
                        className="w-full md:w-auto bg-[#002366] bg-tenant-primary text-white px-6 py-3 rounded-xl font-bold text-xs uppercase tracking-widest hover:brightness-110 transition-all shadow-lg shadow-tenant-primary/20 flex items-center justify-center gap-2 whitespace-nowrap"
                    >
                        <Plus size={18} /> Novo Professor
                    </button>
                </div>
            </header>

            {/* Stats Overview */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-brand-surface p-6 rounded-[2rem] border border-gray-100 dark:border-brand-border shadow-sm flex items-center gap-4">
                    <div className="p-3 bg-blue-50 dark:bg-blue-900/20 text-blue-600 rounded-xl"><Users size={24} /></div>
                    <div>
                        <p className="text-xs text-gray-400 uppercase font-black tracking-widest">Total Professores</p>
                        <p className="text-2xl font-black text-gray-800 dark:text-white">{teachers.length}</p>
                    </div>
                </div>
                <div className="bg-brand-surface p-6 rounded-[2rem] border border-gray-100 dark:border-brand-border shadow-sm flex items-center gap-4">
                    <div className="p-3 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 rounded-xl"><CheckCircle size={24} /></div>
                    <div>
                        <p className="text-xs text-gray-400 uppercase font-black tracking-widest">Ativos</p>
                        <p className="text-2xl font-black text-gray-800 dark:text-white">{activeCount}</p>
                    </div>
                </div>
                <div className="bg-brand-surface p-6 rounded-[2rem] border border-gray-100 dark:border-brand-border shadow-sm flex items-center gap-4">
                    <div className="p-3 bg-purple-50 dark:bg-purple-900/20 text-purple-600 rounded-xl"><Briefcase size={24} /></div>
                    <div>
                        <p className="text-xs text-gray-400 uppercase font-black tracking-widest">Custo Hora Médio</p>
                        <p className="text-2xl font-black text-gray-800 dark:text-white">{(() => {
                          const rates = teachers.map(t => Number(t.hourlyRate || 0)).filter(v => v > 0);
                          const avg = rates.length ? rates.reduce((s, v) => s + v, 0) / rates.length : 0;
                          return `R$ ${avg.toFixed(2).replace('.', ',')}`;
                        })()}</p>
                    </div>
                </div>
            </div>

            {/* Main List */}
            <div className="bg-brand-surface border border-gray-100 dark:border-brand-border rounded-[2.5rem] shadow-sm overflow-hidden">
                <div className="p-6 border-b dark:border-brand-border flex flex-col gap-4">
                    <div className="flex flex-col sm:flex-row justify-between items-center gap-4">
                        <h3 className="font-black text-gray-800 dark:text-slate-200 text-xs uppercase tracking-widest">Lista de Professores</h3>
                        <div className="relative w-full sm:w-72">
                            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                            <input
                                type="text"
                                placeholder="Buscar por nome ou email..."
                                aria-label="Buscar professores por nome ou e-mail"
                                value={searchTerm}
                                onChange={e => setSearchTerm(e.target.value)}
                                className="w-full pl-12 pr-4 py-3 bg-gray-50 dark:bg-brand-surface-2 border border-transparent focus:border-tenant-primary focus-visible:ring-2 focus-visible:ring-tenant-primary/30 rounded-xl text-sm outline-none transition-all"
                            />
                        </div>
                    </div>
                    <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.8fr)] gap-2 sm:flex" role="tablist" aria-label="Status dos professores">
                        <button
                            id="teacher-active-tab"
                            type="button"
                            role="tab"
                            aria-selected={listView === 'active'}
                            aria-controls="teacher-mobile-list teacher-desktop-list"
                            onClick={() => setListView('active')}
                            onKeyDown={handleListTabKeyDown}
                            className={`px-3 sm:px-4 py-2.5 rounded-xl text-[10px] sm:text-xs font-black uppercase tracking-wider transition-colors sm:whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tenant-primary focus-visible:ring-offset-2 ${listView === 'active' ? 'bg-tenant-primary text-white shadow-sm' : 'bg-gray-50 dark:bg-brand-surface-2 text-gray-500 hover:text-tenant-primary'}`}
                        >
                            Ativos ({activeCount})
                        </button>
                        <button
                            id="teacher-inactive-tab"
                            type="button"
                            role="tab"
                            aria-selected={listView === 'inactive'}
                            aria-controls="teacher-mobile-list teacher-desktop-list"
                            onClick={() => setListView('inactive')}
                            onKeyDown={handleListTabKeyDown}
                            className={`px-3 sm:px-4 py-2.5 rounded-xl text-[10px] sm:text-xs font-black uppercase tracking-wider transition-colors sm:whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 ${listView === 'inactive' ? 'bg-amber-500 text-white shadow-sm' : 'bg-gray-50 dark:bg-brand-surface-2 text-gray-500 hover:text-amber-600'}`}
                        >
                            Suspensos / Desligados ({inactiveCount})
                        </button>
                    </div>
                </div>

                <div
                    id="teacher-mobile-list"
                    role="tabpanel"
                    aria-labelledby={listView === 'active' ? 'teacher-active-tab' : 'teacher-inactive-tab'}
                    className="md:hidden divide-y divide-gray-100 dark:divide-slate-800"
                >
                    {filteredTeachers.map(teacher => {
                        const lc = effLifecycle(teacher);
                        const turbo = turboById[teacher.id];
                        const turboIsLoading = turboLoadState === 'loading' && turbo === undefined;
                        const statusClass = lc === 'offboarded'
                            ? 'bg-red-50 text-red-600 border-red-100 dark:bg-red-900/20 dark:border-red-900/30'
                            : lc === 'suspended'
                                ? 'bg-amber-50 text-amber-600 border-amber-100 dark:bg-amber-900/20 dark:border-amber-900/30'
                                : teacher.status === 'Férias'
                                    ? 'bg-amber-50 text-amber-600 border-amber-100 dark:bg-amber-900/20 dark:border-amber-900/30'
                                    : 'bg-emerald-50 text-emerald-600 border-emerald-100 dark:bg-emerald-900/20 dark:border-emerald-900/30';
                        const statusLabel = lc === 'offboarded' ? 'Desligado' : lc === 'suspended' ? 'Suspenso' : teacher.status;

                        return (
                            <article key={teacher.id} className="p-4 sm:p-5 space-y-4">
                                <div className="flex items-start gap-3 min-w-0">
                                    <img src={teacher.avatar} alt="" className="w-12 h-12 rounded-xl object-cover shadow-sm border border-gray-100 dark:border-brand-border shrink-0" />
                                    <div className="min-w-0 flex-1">
                                        <p className="font-bold text-sm text-gray-800 dark:text-slate-200 truncate">{teacher.name}</p>
                                        <p className="text-xs text-gray-400 dark:text-brand-muted truncate">{teacher.email}</p>
                                    </div>
                                    <span className={`shrink-0 px-2.5 py-1 rounded-full text-[9px] font-black uppercase tracking-wide border whitespace-nowrap ${statusClass}`}>
                                        {statusLabel}
                                    </span>
                                </div>

                                <div className="grid grid-cols-2 gap-3 text-xs">
                                    <div className="rounded-xl bg-gray-50 dark:bg-brand-surface-2 p-3 min-w-0">
                                        <p className="text-[9px] font-black uppercase tracking-widest text-gray-400 mb-1">Módulo</p>
                                        <p className="font-bold text-gray-700 dark:text-slate-200 truncate">{teacher.module}</p>
                                    </div>
                                    <div className="rounded-xl bg-gray-50 dark:bg-brand-surface-2 p-3">
                                        <p className="text-[9px] font-black uppercase tracking-widest text-gray-400 mb-1">Alunos</p>
                                        <p className="font-black text-gray-700 dark:text-slate-200">{teacher.studentsCount}</p>
                                    </div>
                                    <div className="rounded-xl bg-orange-50 dark:bg-orange-900/15 p-3">
                                        <p className="text-[9px] font-black uppercase tracking-widest text-orange-500 mb-1 flex items-center gap-1"><Flame size={12} /> Ofensiva</p>
                                        <p className="font-black text-gray-700 dark:text-slate-200" aria-live="polite">
                                            {turboIsLoading ? 'Carregando…' : turbo ? `${turbo.currentStreak} dias` : 'Indisponível'}
                                        </p>
                                        {turbo && <p className="text-[9px] text-gray-400">sem faltar</p>}
                                    </div>
                                    <div className="rounded-xl bg-violet-50 dark:bg-violet-900/15 p-3">
                                        <p className="text-[9px] font-black uppercase tracking-widest text-violet-500 mb-1 flex items-center gap-1"><Zap size={12} /> Modo Turbo</p>
                                        <p className={`font-black ${turbo?.enabled ? 'text-emerald-600' : 'text-gray-500 dark:text-slate-300'}`} aria-live="polite">
                                            {turboIsLoading ? 'Carregando…' : turbo ? (turbo.enabled ? 'Ligado' : 'Desligado') : 'Indisponível'}
                                        </p>
                                    </div>
                                </div>

                                {(teacher.specializations || []).length > 0 && (
                                    <div className="flex flex-wrap gap-1.5">
                                        {(teacher.specializations || []).map(s => (
                                            <span key={s} className="px-2 py-1 bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 text-[9px] font-black rounded-full border border-amber-100 dark:border-amber-800">
                                                {s}
                                            </span>
                                        ))}
                                    </div>
                                )}

                                <div>
                                    <div className="flex items-center justify-between mb-1.5">
                                        <span className="text-[9px] font-black uppercase tracking-widest text-gray-400">Avaliação (TPI)</span>
                                        <span className="text-xs font-black text-gray-700 dark:text-slate-300">{teacher.tpi}</span>
                                    </div>
                                    <div className="w-full h-2 bg-gray-100 dark:bg-brand-surface-2 rounded-full overflow-hidden">
                                        <div
                                            className={`h-full rounded-full ${teacher.tpi >= 90 ? 'bg-emerald-500' : teacher.tpi >= 70 ? 'bg-amber-500' : 'bg-red-500'}`}
                                            style={{ width: `${teacher.tpi}%` }}
                                        />
                                    </div>
                                </div>

                                <div className="grid grid-cols-2 gap-2">
                                    <button onClick={() => onViewTeacherSchedule?.(teacher.name, 'view')} className="px-3 py-2.5 rounded-xl bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 text-[10px] font-black uppercase flex items-center justify-center gap-2">
                                        <BookOpen size={15} /> Agenda
                                    </button>
                                    <button onClick={() => handleEdit(teacher)} className="px-3 py-2.5 rounded-xl bg-gray-100 dark:bg-brand-surface-2 text-gray-700 dark:text-slate-300 text-[10px] font-black uppercase flex items-center justify-center gap-2">
                                        <Briefcase size={15} /> Editar
                                    </button>
                                    <button onClick={() => setViewingFinancialsId(teacher.id)} className="px-3 py-2.5 rounded-xl bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 text-[10px] font-black uppercase flex items-center justify-center gap-2">
                                        <DollarSign size={15} /> Financeiro
                                    </button>
                                    <button onClick={() => setCoverageTeacher({ id: teacher.id, name: teacher.name })} className="px-3 py-2.5 rounded-xl bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 text-[10px] font-black uppercase flex items-center justify-center gap-2">
                                        <CalendarOff size={15} /> Ausência
                                    </button>
                                    {lc === 'active' ? (
                                        <>
                                            <button onClick={() => setTeacherLifecycle(teacher, 'suspended')} className="px-3 py-2.5 rounded-xl border border-amber-200 dark:border-amber-900/40 text-amber-600 text-[10px] font-black uppercase flex items-center justify-center gap-2">
                                                <UserX size={15} /> Suspender
                                            </button>
                                            <button onClick={() => setTeacherLifecycle(teacher, 'offboarded')} className="px-3 py-2.5 rounded-xl border border-red-200 dark:border-red-900/40 text-red-600 text-[10px] font-black uppercase flex items-center justify-center gap-2">
                                                <AlertTriangle size={15} /> Desligar
                                            </button>
                                        </>
                                    ) : (
                                        <button onClick={() => setTeacherLifecycle(teacher, 'active')} className="col-span-2 px-3 py-2.5 rounded-xl border border-emerald-200 dark:border-emerald-900/40 text-emerald-600 text-[10px] font-black uppercase flex items-center justify-center gap-2">
                                            <UserCheck size={15} /> Reativar professor
                                        </button>
                                    )}
                                </div>
                            </article>
                        );
                    })}
                    {filteredTeachers.length === 0 && (
                        <div className="px-6 py-12 text-center text-gray-400 dark:text-brand-muted">
                            <Users size={40} className="mb-3 mx-auto opacity-50" />
                            <p className="text-sm font-bold">
                                {normalizedSearch ? 'Nenhum professor encontrado' : listView === 'active' ? 'Nenhum professor ativo' : 'Nenhum professor suspenso ou desligado'}
                            </p>
                            <p className="text-xs">{normalizedSearch ? 'Tente buscar por outro termo.' : 'Não há professores neste status.'}</p>
                        </div>
                    )}
                </div>

                <div
                    id="teacher-desktop-list"
                    role="tabpanel"
                    aria-labelledby={listView === 'active' ? 'teacher-active-tab' : 'teacher-inactive-tab'}
                    className="hidden md:block overflow-x-auto"
                >
                    <table className="w-full min-w-[1180px] table-fixed text-left">
                        <colgroup>
                            <col className="w-[260px]" />
                            <col className="w-[105px]" />
                            <col className="w-[145px]" />
                            <col className="w-[75px]" />
                            <col className="w-[110px]" />
                            <col className="w-[115px]" />
                            <col className="w-[130px]" />
                            <col className="w-[240px]" />
                        </colgroup>
                        <thead className="bg-gray-50/50 dark:bg-brand-surface-2/50 text-[10px] uppercase font-black text-gray-500 dark:text-brand-muted">
                            <tr>
                                <th className="px-6 py-4">Professor</th>
                                <th className="px-6 py-4">Status</th>
                                <th className="px-6 py-4">Módulo Principal</th>
                                <th className="px-6 py-4">Alunos</th>
                                <th className="px-6 py-4">Ofensiva</th>
                                <th className="px-6 py-4">Modo Turbo</th>
                                <th className="px-6 py-4">Avaliação (TPI)</th>
                                <th className="px-6 py-4 text-right">Ações</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
                            {filteredTeachers.map(teacher => {
                                const turbo = turboById[teacher.id];
                                const turboIsLoading = turboLoadState === 'loading' && turbo === undefined;
                                return (
                                <tr key={teacher.id} className="hover:bg-gray-50 dark:hover:bg-brand-surface-2/50 transition-colors group">
                                    <td className="px-6 py-4 whitespace-nowrap">
                                        <div className="flex items-center gap-3">
                                            <img src={teacher.avatar} alt="" className="w-10 h-10 rounded-xl object-cover shadow-sm border border-gray-100 dark:border-brand-border" />
                                            <div className="min-w-0">
                                                <p className="font-bold text-sm text-gray-800 dark:text-slate-200">{teacher.name}</p>
                                                <p className="truncate text-xs text-gray-400 dark:text-brand-muted" title={teacher.email}>{teacher.email}</p>
                                            </div>
                                        </div>
                                    </td>
                                    <td className="px-6 py-4">
                                        {(() => {
                                            const lc = effLifecycle(teacher);
                                            const cls = lc === 'offboarded'
                                                ? 'bg-red-50 text-red-600 border-red-100 dark:bg-red-900/20 dark:border-red-900/30'
                                                : lc === 'suspended'
                                                    ? 'bg-amber-50 text-amber-600 border-amber-100 dark:bg-amber-900/20 dark:border-amber-900/30'
                                                    : teacher.status === 'Férias'
                                                        ? 'bg-amber-50 text-amber-600 border-amber-100 dark:bg-amber-900/20 dark:border-amber-900/30'
                                                        : 'bg-emerald-50 text-emerald-600 border-emerald-100 dark:bg-emerald-900/20 dark:border-emerald-900/30';
                                            const label = lc === 'offboarded' ? 'Desligado' : lc === 'suspended' ? 'Suspenso' : teacher.status;
                                            return (
                                                <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wide border ${cls}`}>
                                                    {label}
                                                </span>
                                            );
                                        })()}
                                    </td>
                                    <td className="px-6 py-4">
                                        <div className="flex flex-col gap-1">
                                            <div className="flex items-center gap-2">
                                                <BookOpen size={14} className="text-tenant-primary shrink-0" />
                                                <span className="text-xs font-bold text-gray-600 dark:text-slate-300">{teacher.module}</span>
                                            </div>
                                            {(teacher.specializations || []).length > 0 && (
                                                <div className="flex flex-wrap gap-1 mt-1">
                                                    {(teacher.specializations || []).slice(0, 2).map(s => (
                                                        <span key={s} className="px-2 py-0.5 bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 text-[9px] font-black rounded-full border border-amber-100 dark:border-amber-800">
                                                            {s}
                                                        </span>
                                                    ))}
                                                    {(teacher.specializations || []).length > 2 && (
                                                        <span className="px-2 py-0.5 bg-gray-100 dark:bg-brand-surface-2 text-gray-400 text-[9px] font-black rounded-full">
                                                            +{(teacher.specializations || []).length - 2}
                                                        </span>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </td>
                                    <td className="px-6 py-4">
                                        <div className="flex items-center gap-2">
                                            <Users size={14} className="text-gray-400" />
                                            <span className="text-xs font-bold text-gray-600 dark:text-slate-300">{teacher.studentsCount}</span>
                                        </div>
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap">
                                        <div className="flex items-center gap-2 text-orange-600">
                                            <Flame size={16} />
                                            <span className="text-xs font-black" aria-live="polite">
                                                {turboIsLoading ? 'Carregando…' : turbo ? `${turbo.currentStreak} dias` : 'Indisponível'}
                                            </span>
                                        </div>
                                        {turbo && <span className="text-[9px] text-gray-400">sem faltar</span>}
                                    </td>
                                    <td className="px-6 py-4 whitespace-nowrap">
                                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-black uppercase ${turbo?.enabled ? 'bg-emerald-50 text-emerald-600 border-emerald-100 dark:bg-emerald-900/20 dark:border-emerald-900/30' : 'bg-gray-50 text-gray-500 border-gray-200 dark:bg-brand-surface-2 dark:border-brand-border'}`} aria-live="polite">
                                            <Zap size={12} />
                                            {turboIsLoading ? 'Carregando…' : turbo ? (turbo.enabled ? 'Ligado' : 'Desligado') : 'Indisponível'}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4">
                                        <div className="flex items-center gap-2">
                                            <div className="flex-1 w-20 h-1.5 bg-gray-100 dark:bg-brand-surface-2 rounded-full overflow-hidden">
                                                <div
                                                    className={`h-full rounded-full ${teacher.tpi >= 90 ? 'bg-emerald-500' : teacher.tpi >= 70 ? 'bg-amber-500' : 'bg-red-500'}`}
                                                    style={{ width: `${teacher.tpi}%` }}
                                                />
                                            </div>
                                            <span className="text-xs font-black text-gray-700 dark:text-slate-300">{teacher.tpi}</span>
                                        </div>
                                    </td>
                                    <td className="px-6 py-4 text-right">
                                        <div className="flex items-center justify-end gap-2">
                                            <button
                                                onClick={() => onViewTeacherSchedule?.(teacher.name, 'view')}
                                                className="p-2 text-tenant-primary hover:bg-blue-50 dark:hover:bg-brand-surface-2 rounded-lg transition-all"
                                                title="Ver Agenda"
                                                aria-label={`Ver agenda de ${teacher.name}`}
                                            >
                                                <BookOpen size={18} />
                                            </button>
                                            <button
                                                onClick={() => handleEdit(teacher)}
                                                className="p-2 text-gray-400 hover:text-tenant-primary hover:bg-gray-100 dark:hover:bg-brand-surface-2 rounded-lg transition-all"
                                                title="Editar Professor"
                                                aria-label={`Editar ${teacher.name}`}
                                            >
                                                <Briefcase size={18} />
                                            </button>
                                            <button
                                                onClick={() => setViewingFinancialsId(teacher.id)}
                                                className="p-2 text-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 rounded-lg transition-all"
                                                title="Ver Financeiro"
                                                aria-label={`Ver financeiro de ${teacher.name}`}
                                            >
                                                <DollarSign size={18} />
                                            </button>
                                            <button
                                                onClick={() => setCoverageTeacher({ id: teacher.id, name: teacher.name })}
                                                className="p-2 text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-900/20 rounded-lg transition-all"
                                                title="Registrar ausência e cobrir aulas"
                                                aria-label={`Registrar ausência de ${teacher.name}`}
                                            >
                                                <CalendarOff size={18} />
                                            </button>
                                            {(() => {
                                                const lc = effLifecycle(teacher);
                                                return lc === 'active' ? (
                                                    <>
                                                        <button
                                                            onClick={() => setTeacherLifecycle(teacher, 'suspended')}
                                                            className="p-2 text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-900/20 rounded-lg transition-all"
                                                            title="Suspender (sai do cruzamento de agenda)"
                                                            aria-label={`Suspender ${teacher.name}`}
                                                        >
                                                            <UserX size={18} />
                                                        </button>
                                                        <button
                                                            onClick={() => setTeacherLifecycle(teacher, 'offboarded')}
                                                            className="p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-all"
                                                            title="Desligar definitivamente"
                                                            aria-label={`Desligar ${teacher.name}`}
                                                        >
                                                            <AlertTriangle size={18} />
                                                        </button>
                                                    </>
                                                ) : (
                                                    <button
                                                        onClick={() => setTeacherLifecycle(teacher, 'active')}
                                                        className="p-2 text-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 rounded-lg transition-all"
                                                        title="Reativar professor"
                                                        aria-label={`Reativar ${teacher.name}`}
                                                    >
                                                        <UserCheck size={18} />
                                                    </button>
                                                );
                                            })()}
                                        </div>
                                    </td>
                                </tr>
                                );
                            })}
                            {filteredTeachers.length === 0 && (
                                <tr>
                                    <td colSpan={8} className="px-6 py-12 text-center">
                                        <div className="flex flex-col items-center justify-center text-gray-300 dark:text-brand-muted">
                                            <Users size={48} className="mb-4 opacity-50" />
                                            <p className="text-sm font-bold">
                                                {normalizedSearch ? 'Nenhum professor encontrado' : listView === 'active' ? 'Nenhum professor ativo' : 'Nenhum professor suspenso ou desligado'}
                                            </p>
                                            <p className="text-xs">{normalizedSearch ? 'Tente buscar por outro termo.' : 'Não há professores neste status.'}</p>
                                        </div>
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Add Teacher Modal */}
            {isModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
                    <div className="bg-brand-surface w-full max-w-2xl rounded-[2rem] shadow-2xl border border-gray-100 dark:border-brand-border overflow-hidden flex flex-col max-h-[90vh]">
                        <div className="p-6 border-b dark:border-brand-border flex justify-between items-center bg-gray-50/50 dark:bg-brand-surface-2/50">
                            <h3 className="text-lg font-black text-gray-800 dark:text-white flex items-center gap-2">
                                <UserPlusIcon /> {editingTeacherId ? 'Editar Professor' : 'Novo Professor'}
                            </h3>
                            <button onClick={() => { setIsModalOpen(false); setEditingTeacherId(null); setFormData(initialFormState as any); }} className="p-2 hover:bg-black/5 dark:hover:bg-brand-surface/5 rounded-xl transition-colors">
                                <X size={20} className="text-gray-500" />
                            </button>
                        </div>

                        <div className="p-8 overflow-y-auto space-y-6">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                {/* Personal Info */}
                                <div className="space-y-4 md:col-span-2">
                                    <h4 className="text-xs font-black uppercase tracking-widest text-tenant-primary flex items-center gap-2">
                                        <span className="w-1.5 h-1.5 rounded-full bg-tenant-primary" /> Informações Pessoais
                                    </h4>
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        <Input label="Nome Completo" placeholder="Ex: Ana Clara Souza" value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} icon={<Users size={16} />} />
                                        <Input label="Email Corporativo" placeholder="ana.souza@escola.com" value={formData.email} onChange={e => setFormData({ ...formData, email: e.target.value })} icon={<Mail size={16} />} />
                                        <Input label="Telefone / WhatsApp" placeholder="(11) 99999-9999" value={formData.phone} onChange={e => setFormData({ ...formData, phone: e.target.value })} icon={<Phone size={16} />} />
                                    </div>
                                </div>

                                {/* Contract Info */}
                                <div className="space-y-4 md:col-span-2">
                                    <h4 className="text-xs font-black uppercase tracking-widest text-emerald-600 flex items-center gap-2">
                                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-600" /> Dados Contratuais
                                    </h4>
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        <Input label="Módulo Principal" placeholder="Ex: Business English" value={formData.module} onChange={e => setFormData({ ...formData, module: e.target.value })} icon={<BookOpen size={16} />} />
                                        <Input label="Valor por Aula (30 min) (R$)" placeholder="0.00" value={formData.hourlyRate} onChange={e => setFormData({ ...formData, hourlyRate: e.target.value })} icon={<DollarSign size={16} />} />
                                        <Input label="Chave PIX" placeholder="CPF, Email ou Aleatória" value={formData.pixKey} onChange={e => setFormData({ ...formData, pixKey: e.target.value })} icon={<Award size={16} />} />
                                        <Input label="Link do Contrato" placeholder="https://link-do-contrato.pdf" value={(formData as any).contractUrl} onChange={e => setFormData({ ...formData, contractUrl: e.target.value } as any)} icon={<FileText size={16} />} />

                                        {editingTeacherId && (
                                            <div className="space-y-1.5 text-left">
                                                <label className="text-[10px] font-black uppercase tracking-widest text-gray-400 ml-1">Status do Professor</label>
                                                <select
                                                    value={(formData as any).status}
                                                    onChange={e => setFormData({ ...formData, status: e.target.value } as any)}
                                                    className="w-full px-4 py-3 bg-brand-surface border border-gray-200 dark:border-brand-border rounded-xl text-sm font-medium focus:ring-2 focus:ring-tenant-primary/20 focus:border-tenant-primary outline-none transition-all"
                                                >
                                                    <option value="Ativo">Ativo</option>
                                                    <option value="Férias">Férias</option>
                                                    <option value="Inativo">Inativo</option>
                                                </select>
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* Especialização */}
                                <div className="space-y-4 md:col-span-2">
                                    <h4 className="text-xs font-black uppercase tracking-widest text-amber-600 flex items-center gap-2">
                                        <span className="w-1.5 h-1.5 rounded-full bg-amber-600" /> Especialização (selecione todas que se aplicam)
                                    </h4>
                                    <div className="flex flex-wrap gap-2">
                                        {TEACHER_SPECIALIZATIONS.map(spec => (
                                            <button
                                                key={spec}
                                                type="button"
                                                onClick={() => toggleSpec(spec)}
                                                className={`px-4 py-2 rounded-full text-xs font-bold border transition-all ${
                                                    selectedSpecs.includes(spec)
                                                        ? 'bg-amber-500 text-white border-amber-500 shadow-md'
                                                        : 'bg-brand-surface dark:bg-brand-surface-2 text-gray-500 dark:text-brand-muted border-gray-200 dark:border-brand-border hover:border-amber-400 hover:text-amber-600'
                                                }`}
                                            >
                                                {selectedSpecs.includes(spec) ? '✓ ' : ''}{spec}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                {/* Technical Info */}
                                <div className="space-y-4 md:col-span-2">
                                    <h4 className="text-xs font-black uppercase tracking-widest text-blue-600 flex items-center gap-2">
                                        <span className="w-1.5 h-1.5 rounded-full bg-blue-600" /> Configurações Técnicas
                                    </h4>
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        <Input label="Link da Sala (Zoom/Meet)" placeholder="https://meet.google.com/..." value={(formData as any).meetingLink} onChange={e => setFormData({ ...formData, meetingLink: e.target.value } as any)} icon={<RefreshCw size={16} />} />
                                        <Input label="Instancia WhatsApp" placeholder="ex: prof-lobo-01" value={(formData as any).whatsappInstance} onChange={e => setFormData({ ...formData, whatsappInstance: e.target.value } as any)} icon={<Phone size={16} />} />
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="p-6 border-t dark:border-brand-border bg-gray-50/50 dark:bg-brand-surface-2/50 flex justify-end gap-3">
                            <button
                                onClick={() => { setIsModalOpen(false); setEditingTeacherId(null); setFormData(initialFormState as any); }}
                                className="px-6 py-3 rounded-xl text-xs font-bold uppercase tracking-widest text-gray-500 hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors"
                            >
                                Cancelar
                            </button>
                            <button
                                onClick={handleSave}
                                disabled={isSaving || !formData.name || !formData.email}
                                className="bg-tenant-primary text-white px-8 py-3 rounded-xl font-bold text-xs uppercase tracking-widest hover:brightness-110 transition-all shadow-lg shadow-tenant-primary/20 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {isSaving ? <Briefcase className="animate-spin" size={16} /> : <Save size={16} />}
                                {isSaving ? 'Salvando...' : (editingTeacherId ? 'Salvar Alterações' : 'Cadastrar Professor')}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {isInviteModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
                    <div className="bg-brand-surface w-full max-w-md rounded-[2rem] shadow-2xl border border-gray-100 dark:border-brand-border overflow-hidden relative">
                        <button
                            onClick={() => setIsInviteModalOpen(false)}
                            className="absolute top-4 right-4 p-2 hover:bg-gray-100 dark:hover:bg-brand-surface-2 rounded-full transition-colors z-10"
                        >
                            <X size={20} className="text-gray-400" />
                        </button>
                        <TeacherInviteGenerator tenantId={currentTenantId || ''} />
                    </div>
                </div>
            )}

            {viewingFinancialsId && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-300">
                    <div className="bg-brand-surface w-full max-w-5xl rounded-[2rem] shadow-2xl border border-gray-100 dark:border-brand-border overflow-hidden flex flex-col max-h-[90vh]">
                        <div className="p-6 border-b dark:border-brand-border flex justify-between items-center bg-gray-50/50 dark:bg-brand-surface-2/50 shrink-0">
                            <h3 className="text-lg font-black text-gray-800 dark:text-white flex items-center gap-2">
                                <DollarSign className="text-emerald-500" />
                                Financeiro: {teachers.find(t => t.id === viewingFinancialsId)?.name}
                            </h3>
                            <button onClick={() => setViewingFinancialsId(null)} className="p-2 hover:bg-black/5 dark:hover:bg-brand-surface/5 rounded-xl transition-colors">
                                <X size={20} className="text-gray-500" />
                            </button>
                        </div>
                        <div className="p-6 overflow-y-auto">
                            <TeacherFinancials
                                user={teachers.find(t => t.id === viewingFinancialsId) as any}
                                tenantId={currentTenantId}
                                viewOnly={true}
                                /* Direção: libera a edição de valor base e duração por aluno.
                                   A RPC set_student_month_pay revalida o papel no servidor. */
                                directorMode={true}
                            />
                        </div>
                    </div>
                </div>
            )}

            {coverageTeacher && (
                <AbsenceCoverageManager teacher={coverageTeacher} onClose={() => setCoverageTeacher(null)} />
            )}
        </div>
    );
};

// Helper Components
const UserPlusIcon = () => (
    <div className="w-8 h-8 rounded-lg bg-tenant-primary/10 text-tenant-primary flex items-center justify-center">
        <Plus size={18} strokeWidth={3} />
    </div>
);

const Input = ({ label, placeholder, value, onChange, icon }: any) => (
    <div className="space-y-1.5">
        <label className="text-[10px] font-black uppercase tracking-widest text-gray-400 ml-1">{label}</label>
        <div className="relative">
            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none">
                {icon}
            </div>
            <input
                type="text"
                value={value}
                onChange={onChange}
                placeholder={placeholder}
                className="w-full pl-10 pr-4 py-3 bg-brand-surface border border-gray-200 dark:border-brand-border rounded-xl text-sm font-medium focus:ring-2 focus:ring-tenant-primary/20 focus:border-tenant-primary outline-none transition-all"
            />
        </div>
    </div>
);

export default TeacherManagement;
