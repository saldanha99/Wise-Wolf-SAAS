import React, { useMemo, useState } from 'react';
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
    Zap,
    GraduationCap,
} from 'lucide-react';
import { Kpi3D, PageHero3D, Ring3D, Tilt3D, type Tone } from './depth/Depth3D';
import { Teacher, UserRole } from '../types';
import { calculateTeacherStreak, filterTeachersByView, getTeacherLifecycle, TeacherListView } from '../lib/teacherManagement';
import { TEACHER_SPECIALIZATIONS } from '../constants';

import { supabase } from '../lib/supabase';
import TeacherInviteGenerator from './TeacherInviteGenerator';
import TeacherFinancials from './TeacherFinancials';
import AbsenceCoverageManager from './AbsenceCoverageManager';
import TeacherTurboOverview, { type TeacherTurboRow } from './TeacherTurboOverview';

const CardAction: React.FC<{ tone: Tone; icon: React.ReactNode; label: string; onClick: () => void; title?: string; ariaLabel?: string }> = ({ tone, icon, label, onClick, title, ariaLabel }) => (
    <button
        type="button"
        onClick={onClick}
        title={title || label}
        aria-label={ariaLabel}
        className={`ww-lift tone-${tone} inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-[10px] font-black uppercase tracking-wider`}
        style={{ color: 'rgb(var(--tone))', borderColor: 'rgb(var(--tone) / 0.28)', background: 'rgb(var(--tone) / 0.08)' }}
    >
        {icon} {label}
    </button>
);

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
    const [listView, setListView] = useState<TeacherListView>('active');
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
    const [viewingFinancialsId, setViewingFinancialsId] = useState<string | null>(null);

    // Ciclo de vida do professor (suspender/desligar/reativar) via school-admin.
    // suspended/offboarded tira o professor do cruzamento de agenda e do lançamento de aula.
    // Estado otimista local: o badge usa lifecycle_status canônico (não o legado teacher.status).
    const [lifecycleById, setLifecycleById] = useState<Record<string, string>>({});
    const [coverageTeacher, setCoverageTeacher] = useState<{ id: string; name: string } | null>(null);
    const effLifecycle = (t: Teacher): string => getTeacherLifecycle(t, lifecycleById[t.id]);

    const setTeacherLifecycle = async (teacher: any, status: 'active' | 'suspended' | 'offboarded') => {
        const labels: Record<string, string> = {
            suspended: `Suspender ${teacher.name}?\n\nO professor SAI do cruzamento de agenda e para de receber agenda diária/notificações. Reversível.\n\nNovas oportunidades são enviadas individualmente e ficam bloqueadas para professores suspensos. Confira também a participação dele nos grupos antigos da escola.`,
            offboarded: `Desligar ${teacher.name} definitivamente?\n\nSai do cruzamento de agenda e do lançamento de aula. Lembre de transferir os alunos dele (Transferência de Professor).\n\nNovas oportunidades e novos aceites ficam bloqueados para o professor desligado. Confira também a participação dele nos grupos antigos da escola.`,
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
        hourlyRate: '8.00',
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
                    alert('Professor cadastrado! Um convite seguro para definir a senha foi enviado por e-mail.');
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

    const filteredTeachers = filterTeachersByView<Teacher>(teachers, listView, searchTerm, lifecycleById);
    const activeTeachersCount = teachers.filter((teacher) => effLifecycle(teacher) === 'active').length;
    const inactiveTeachersCount = teachers.length - activeTeachersCount;

    // Turbo, ofensiva e carteira pela regra oficial (list_teacher_turbo_overview),
    // a mesma da seção "Ofensiva do Turbo".
    const [turboRows, setTurboRows] = useState<TeacherTurboRow[] | null>(null);
    const turboById = useMemo(() => Object.fromEntries((turboRows || []).map(r => [r.teacher_id, r])) as Record<string, TeacherTurboRow>, [turboRows]);
    const turboTotals = useMemo(() => ({
        active: (turboRows || []).filter(r => r.turbo_status === 'ACTIVE').length,
        building: (turboRows || []).filter(r => r.turbo_status === 'BUILDING').length,
        suspended: (turboRows || []).filter(r => r.turbo_status === 'SUSPENDED').length,
    }), [turboRows]);
    const carteiraTotal = teachers
        .filter(t => effLifecycle(t) === 'active')
        .reduce((sum, t) => sum + Number(turboById[t.id]?.students_active ?? t.studentsCount ?? 0), 0);

    return (
        <div className="ww-stage space-y-6 md:space-y-8 animate-in fade-in duration-500">
            <PageHero3D
                icon={<Users size={26} />}
                eyebrow="Professores"
                title="Gestão do Corpo Docente"
                subtitle="Administre os professores, contratos e atribuições."
                actions={
                    <>
                        <button
                            onClick={() => setIsInviteModalOpen(true)}
                            className="ww-lift w-full md:w-auto bg-brand-surface text-tenant-primary dark:text-brand-accent border border-tenant-primary/25 dark:border-brand-border px-5 py-3 rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-2 whitespace-nowrap shadow-sm"
                        >
                            <Link size={17} /> Convidar (Link)
                        </button>
                        <button
                            onClick={() => setIsModalOpen(true)}
                            className="ww-block tone-brand w-full md:w-auto px-5 py-3 font-black text-xs uppercase tracking-widest flex items-center justify-center gap-2 whitespace-nowrap"
                        >
                            <Plus size={17} className="relative" /> <span className="relative">Novo Professor</span>
                        </button>
                    </>
                }
            />

            {/* Números do corpo docente */}
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
                <Kpi3D
                    icon={<Users size={20} />}
                    tone="sky"
                    label="Professores ativos"
                    value={`${activeTeachersCount}`}
                    hint={`${teachers.length} no total · ${inactiveTeachersCount} suspenso${inactiveTeachersCount === 1 ? '' : 's'} ou desligado${inactiveTeachersCount === 1 ? '' : 's'}`}
                    ring={teachers.length ? (100 * activeTeachersCount) / teachers.length : 0}
                />
                <Kpi3D
                    icon={<GraduationCap size={20} />}
                    tone="emerald"
                    label="Alunos na carteira"
                    value={`${carteiraTotal}`}
                    hint={activeTeachersCount ? `média de ${(carteiraTotal / activeTeachersCount).toFixed(1).replace('.', ',')} por professor ativo` : 'Nenhum professor ativo'}
                />
                <Kpi3D
                    icon={<Zap size={20} />}
                    tone="orange"
                    label="Turbo ativo"
                    value={turboRows ? `${turboTotals.active}` : '—'}
                    hint={turboRows
                        ? `${turboTotals.building} em construção${turboTotals.suspended ? ` · ${turboTotals.suspended} para analisar` : ''}`
                        : 'Calculando pela regra oficial…'}
                />
                <Kpi3D
                    icon={<Briefcase size={20} />}
                    tone="violet"
                    label="Custo hora médio"
                    value={(() => {
                        const rates = teachers.map(t => Number(t.hourlyRate || 0)).filter(v => v > 0);
                        const avg = rates.length ? rates.reduce((s, v) => s + v, 0) / rates.length : 0;
                        return `R$ ${avg.toFixed(2).replace('.', ',')}`;
                    })()}
                    hint="Valor cadastrado no perfil; a folha usa a faixa de cada aula"
                />
            </div>

            <TeacherTurboOverview tenantId={currentTenantId} onRows={setTurboRows} />

            {/* Lista */}
            <section className="ww-slab overflow-hidden">
                <div className="p-5 sm:p-6 border-b border-brand-border/60 flex flex-col lg:flex-row justify-between lg:items-center gap-4">
                    <div className="flex items-center gap-3">
                        <div className="ww-orb tone-brand h-11 w-11"><Users size={18} /></div>
                        <div>
                            <h3 className="font-black text-brand-text">Lista de Professores</h3>
                            <p className="text-xs text-brand-muted">Toque no cartão para ver a agenda; as ações ficam embaixo.</p>
                        </div>
                    </div>
                    <div className="flex flex-col sm:flex-row gap-2 w-full lg:w-auto">
                        <div className="flex gap-1 rounded-2xl border border-brand-border bg-brand-surface-2/60 p-1" role="tablist" aria-label="Filtrar professores por situação">
                            <button
                                type="button"
                                role="tab"
                                aria-selected={listView === 'active'}
                                onClick={() => setListView('active')}
                                className={`flex-1 px-4 py-2 rounded-xl text-[11px] font-black uppercase tracking-wider whitespace-nowrap ${listView === 'active' ? 'ww-block tone-emerald' : 'text-brand-muted hover:text-brand-text'}`}
                            >
                                <span className="relative">Ativos ({activeTeachersCount})</span>
                            </button>
                            <button
                                type="button"
                                role="tab"
                                aria-selected={listView === 'inactive'}
                                onClick={() => setListView('inactive')}
                                className={`flex-1 px-4 py-2 rounded-xl text-[11px] font-black uppercase tracking-wider whitespace-nowrap ${listView === 'inactive' ? 'ww-block tone-amber' : 'text-brand-muted hover:text-brand-text'}`}
                            >
                                <span className="relative">Suspensos / desligados ({inactiveTeachersCount})</span>
                            </button>
                        </div>
                        <div className="relative w-full sm:w-64">
                            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-brand-muted" size={15} />
                            <input
                                type="text"
                                placeholder="Buscar por nome ou email..."
                                value={searchTerm}
                                onChange={e => setSearchTerm(e.target.value)}
                                className="w-full pl-10 pr-4 py-2.5 bg-brand-surface-2/70 border border-brand-border focus:border-tenant-primary rounded-xl text-sm text-brand-text outline-hidden transition-all"
                            />
                        </div>
                    </div>
                </div>

                <div data-tour="teachers-cards" className="p-4 sm:p-5 grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-4">
                    {filteredTeachers.map(teacher => {
                        const lc = effLifecycle(teacher);
                        const statusTone = lc === 'offboarded' ? 'rose' : lc === 'suspended' || teacher.status === 'Férias' ? 'amber' : 'emerald';
                        const statusLabel = lc === 'offboarded' ? 'Desligado' : lc === 'suspended' ? 'Suspenso' : teacher.status;
                        const turbo = turboById[teacher.id];
                        // A ofensiva e a carteira vêm da regra oficial do servidor
                        // quando ela já chegou; antes disso, a conta local de sempre.
                        const localStreak = calculateTeacherStreak(teacher.createdAt, teacher.lastTeacherAbsenceAt);
                        const streakDays = turbo ? Number(turbo.streak_days || 0) : localStreak.consecutiveDays;
                        const students = turbo ? Number(turbo.students_active || 0) : teacher.studentsCount;
                        const turboLabel = turbo
                            ? turbo.turbo_status === 'ACTIVE' ? 'Turbo ativo'
                                : turbo.turbo_status === 'BUILDING' ? `Turbo em ${turbo.days_to_activate}d`
                                    : turbo.turbo_status === 'SUSPENDED' ? 'Turbo em análise'
                                        : `Faltam ${turbo.students_missing} aluno${turbo.students_missing === 1 ? '' : 's'}`
                            : '—';
                        const turboTone = turbo?.turbo_status === 'ACTIVE' ? 'orange' : turbo?.turbo_status === 'SUSPENDED' ? 'rose' : turbo?.turbo_status === 'BUILDING' ? 'sky' : 'slate';
                        const tpiTone = teacher.tpi >= 90 ? 'emerald' : teacher.tpi >= 70 ? 'amber' : 'rose';

                        return (
                            <Tilt3D key={teacher.id} as="article" max={4} className="ww-slab p-4 sm:p-5 flex flex-col gap-4">
                                <button
                                    type="button"
                                    onClick={() => onViewTeacherSchedule?.(teacher.name, 'view')}
                                    className="flex items-start gap-3 min-w-0 text-left"
                                    title="Ver agenda"
                                >
                                    <span className="relative shrink-0">
                                        {teacher.avatar
                                            ? <img src={teacher.avatar} alt="" className="w-14 h-14 rounded-2xl object-cover shadow-lg ring-4 ring-white/70 dark:ring-white/10" />
                                            : <span className="ww-orb tone-brand w-14 h-14 text-base font-black">{teacher.name.split(' ').slice(0, 2).map(p => p[0]).join('')}</span>}
                                        <span className={`absolute -bottom-1 -right-1 h-4 w-4 rounded-full ring-2 ring-brand-surface tone-${statusTone}`} style={{ background: 'rgb(var(--tone))' }} aria-hidden="true" />
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span className="block font-black text-brand-text truncate">{teacher.name}</span>
                                        <span className="block text-xs text-brand-muted truncate">{teacher.email}</span>
                                        <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                            <span className={`tone-${statusTone} px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider border`} style={{ color: 'rgb(var(--tone))', borderColor: 'rgb(var(--tone) / 0.3)', background: 'rgb(var(--tone) / 0.1)' }}>
                                                {statusLabel}
                                            </span>
                                            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-brand-muted"><BookOpen size={11} className="text-tenant-primary dark:text-brand-accent" /> {teacher.module}</span>
                                        </span>
                                    </span>
                                    <Ring3D value={teacher.tpi} tone={tpiTone} size={50} unit="" label={`Avaliação TPI ${teacher.tpi} de 100`} />
                                </button>

                                {(teacher.specializations || []).length > 0 && (
                                    <div className="flex flex-wrap gap-1.5 -mt-1">
                                        {(teacher.specializations || []).slice(0, 4).map(s => (
                                            <span key={s} className="px-2 py-0.5 bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[9px] font-black rounded-full border border-amber-500/25">
                                                {s}
                                            </span>
                                        ))}
                                        {(teacher.specializations || []).length > 4 && (
                                            <span className="px-2 py-0.5 bg-brand-surface-2 text-brand-muted text-[9px] font-black rounded-full">
                                                +{(teacher.specializations || []).length - 4}
                                            </span>
                                        )}
                                    </div>
                                )}

                                <div className="grid grid-cols-3 gap-2">
                                    <div className="rounded-xl bg-brand-surface-2/70 p-2.5 shadow-inner">
                                        <p className="text-[9px] font-black uppercase tracking-wider text-brand-muted flex items-center gap-1"><GraduationCap size={11} /> Alunos</p>
                                        <p className="text-lg font-black text-brand-text leading-tight">{students}</p>
                                    </div>
                                    <div className="rounded-xl bg-orange-500/10 p-2.5 shadow-inner">
                                        <p className="text-[9px] font-black uppercase tracking-wider text-orange-600 dark:text-orange-400 flex items-center gap-1"><Flame size={11} /> Ofensiva</p>
                                        <p className="text-lg font-black text-brand-text leading-tight">{streakDays}<span className="text-[10px] font-bold text-brand-muted"> {streakDays === 1 ? 'dia' : 'dias'}</span></p>
                                    </div>
                                    <div className={`tone-${turboTone} rounded-xl p-2.5 shadow-inner`} style={{ background: 'rgb(var(--tone) / 0.1)' }} title={teacher.turboBlockedBy ? `Motivo: ${teacher.turboBlockedBy}` : undefined}>
                                        <p className="text-[9px] font-black uppercase tracking-wider flex items-center gap-1" style={{ color: 'rgb(var(--tone))' }}><Zap size={11} /> Turbo</p>
                                        <p className="text-[11px] font-black text-brand-text leading-tight mt-1">{turboLabel}</p>
                                    </div>
                                </div>

                                <div className="mt-auto flex flex-wrap gap-1.5 pt-3 border-t border-brand-border/60">
                                    <CardAction tone="brand" icon={<BookOpen size={14} />} label="Agenda" onClick={() => onViewTeacherSchedule?.(teacher.name, 'view')} />
                                    <CardAction tone="slate" icon={<Briefcase size={14} />} label="Editar" ariaLabel={`Editar ${teacher.name}`} onClick={() => handleEdit(teacher)} />
                                    <CardAction tone="emerald" icon={<DollarSign size={14} />} label="Financeiro" onClick={() => setViewingFinancialsId(teacher.id)} />
                                    <CardAction tone="amber" icon={<CalendarOff size={14} />} label="Ausência" title="Registrar ausência e cobrir aulas" onClick={() => setCoverageTeacher({ id: teacher.id, name: teacher.name })} />
                                    {lc === 'active' ? (
                                        <>
                                            <CardAction tone="amber" icon={<UserX size={14} />} label="Suspender" title="Suspender (sai do cruzamento de agenda)" onClick={() => setTeacherLifecycle(teacher, 'suspended')} />
                                            <CardAction tone="rose" icon={<AlertTriangle size={14} />} label="Desligar" title="Desligar definitivamente" onClick={() => setTeacherLifecycle(teacher, 'offboarded')} />
                                        </>
                                    ) : (
                                        <CardAction tone="emerald" icon={<UserCheck size={14} />} label="Reativar" title="Reativar professor" onClick={() => setTeacherLifecycle(teacher, 'active')} />
                                    )}
                                </div>
                            </Tilt3D>
                        );
                    })}
                    {filteredTeachers.length === 0 && (
                        <div className="col-span-full px-6 py-12 text-center text-brand-muted">
                            <span className="ww-orb tone-slate h-14 w-14 mx-auto mb-3"><Users size={24} /></span>
                            <p className="text-sm font-bold text-brand-text">Nenhum professor encontrado</p>
                            <p className="text-xs">Tente buscar por outro termo ou adicione um novo.</p>
                        </div>
                    )}
                </div>
            </section>

            {/* Add Teacher Modal */}
            {isModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs animate-in fade-in duration-200">
                    <div className="bg-brand-surface w-full max-w-2xl rounded-4xl shadow-2xl border border-gray-100 dark:border-brand-border overflow-hidden flex flex-col max-h-[90vh]">
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
                                                    className="w-full px-4 py-3 bg-brand-surface border border-gray-200 dark:border-brand-border rounded-xl text-sm font-medium focus:ring-2 focus:ring-tenant-primary/20 focus:border-tenant-primary outline-hidden transition-all"
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
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs animate-in fade-in duration-200">
                    <div className="bg-brand-surface w-full max-w-md rounded-4xl shadow-2xl border border-gray-100 dark:border-brand-border overflow-hidden relative">
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
                <div className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-300">
                    <div className="bg-brand-surface w-full max-w-5xl rounded-4xl shadow-2xl border border-gray-100 dark:border-brand-border overflow-hidden flex flex-col max-h-[90vh]">
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
                className="w-full pl-10 pr-4 py-3 bg-brand-surface border border-gray-200 dark:border-brand-border rounded-xl text-sm font-medium focus:ring-2 focus:ring-tenant-primary/20 focus:border-tenant-primary outline-hidden transition-all"
            />
        </div>
    </div>
);

export default TeacherManagement;
