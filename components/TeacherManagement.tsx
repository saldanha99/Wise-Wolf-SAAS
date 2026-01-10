import React, { useState } from 'react';
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
    RefreshCw
} from 'lucide-react';
import { Teacher, UserRole } from '../types';

import { supabase } from '../lib/supabase';

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
        whatsappInstance: ''
    };
    const [formData, setFormData] = useState({ ...initialFormState, status: 'Ativo' });
    const [editingTeacherId, setEditingTeacherId] = useState<string | null>(null);

    const handleEdit = (teacher: Teacher) => {
        setEditingTeacherId(teacher.id);
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
            whatsappInstance: (teacher as any).whatsappInstance || ''
        } as any);
        setIsModalOpen(true);
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
                        whatsapp_instance: (formData as any).whatsappInstance
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
                } else {
                    // 2. Try to Create Auth Account
                    const { data: authData, error: authError } = await supabase.auth.signUp({
                        email: formData.email,
                        password: '123456',
                    });

                    if (authError) {
                        if (authError.message.includes('already registered')) {
                            throw new Error("Este e-mail está vinculado a outra escola. O isolamento de dados impede o compartilhamento de e-mails entre unidades.");
                        } else {
                            throw authError;
                        }
                    } else if (authData.user) {
                        targetId = authData.user.id;
                    }
                }

                if (!targetId) throw new Error("Não foi possível processar o cadastro.");

                // 3. Upsert Profile (Strictly for this tenant)
                const { error: profileError } = await supabase.from('profiles').upsert({
                    id: targetId,
                    full_name: formData.name,
                    email: formData.email,
                    role: UserRole.TEACHER,
                    tenant_id: currentTenantId,
                    module: formData.module,
                    phone: formData.phone,
                    hourly_rate: parseFloat(formData.hourlyRate),
                    pix_key: formData.pixKey,
                    status: 'Ativo',
                    avatar_url: `https://ui-avatars.com/api/?name=${formData.name}&background=random`
                });

                if (profileError) throw profileError;

                // 4. Update UI state
                const newTeacher: Teacher = {
                    id: targetId,
                    name: formData.name,
                    email: formData.email,
                    role: UserRole.TEACHER,
                    avatar: `https://ui-avatars.com/api/?name=${formData.name}&background=random`,
                    module: formData.module,
                    modules: [formData.module],
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
                alert(`Professor ${formData.name} configurado com sucesso!`);
            }

            setIsModalOpen(false);
            setEditingTeacherId(null);
            setFormData(initialFormState as any);
        } catch (err: any) {
            alert("Erro ao salvar: " + err.message);
        } finally {
            setIsSaving(false);
        }
    };

    const filteredTeachers = teachers.filter(t =>
        t.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        t.email.toLowerCase().includes(searchTerm.toLowerCase())
    );

    return (
        <div className="space-y-6 md:space-y-8 animate-in fade-in duration-500">
            <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                    <h2 className="text-2xl md:text-3xl font-black text-gray-800 dark:text-slate-100 tracking-tight flex items-center gap-3">
                        <Users className="text-tenant-primary" size={28} /> Gestão do Corpo Docente
                    </h2>
                    <p className="text-gray-500 dark:text-slate-400 text-sm">Administre os professores, contratos e atribuições.</p>
                </div>
                <button
                    onClick={() => setIsModalOpen(true)}
                    className="bg-tenant-primary text-white px-6 py-3 rounded-xl font-bold text-xs uppercase tracking-widest hover:brightness-110 transition-all shadow-lg shadow-tenant-primary/20 flex items-center gap-2"
                >
                    <Plus size={18} /> Novo Professor
                </button>
            </header>

            {/* Stats Overview */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-white dark:bg-slate-900 p-6 rounded-[2rem] border border-gray-100 dark:border-slate-800 shadow-sm flex items-center gap-4">
                    <div className="p-3 bg-blue-50 dark:bg-blue-900/20 text-blue-600 rounded-xl"><Users size={24} /></div>
                    <div>
                        <p className="text-xs text-gray-400 uppercase font-black tracking-widest">Total Professores</p>
                        <p className="text-2xl font-black text-gray-800 dark:text-white">{teachers.length}</p>
                    </div>
                </div>
                <div className="bg-white dark:bg-slate-900 p-6 rounded-[2rem] border border-gray-100 dark:border-slate-800 shadow-sm flex items-center gap-4">
                    <div className="p-3 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 rounded-xl"><CheckCircle size={24} /></div>
                    <div>
                        <p className="text-xs text-gray-400 uppercase font-black tracking-widest">Ativos</p>
                        <p className="text-2xl font-black text-gray-800 dark:text-white">{teachers.filter(t => t.status === 'Ativo').length}</p>
                    </div>
                </div>
                <div className="bg-white dark:bg-slate-900 p-6 rounded-[2rem] border border-gray-100 dark:border-slate-800 shadow-sm flex items-center gap-4">
                    <div className="p-3 bg-purple-50 dark:bg-purple-900/20 text-purple-600 rounded-xl"><Briefcase size={24} /></div>
                    <div>
                        <p className="text-xs text-gray-400 uppercase font-black tracking-widest">Custo Hora Médio</p>
                        <p className="text-2xl font-black text-gray-800 dark:text-white">R$ 42,00</p>
                    </div>
                </div>
            </div>

            {/* Main List */}
            <div className="bg-white dark:bg-slate-900 border border-gray-100 dark:border-slate-800 rounded-[2.5rem] shadow-sm overflow-hidden">
                <div className="p-6 border-b dark:border-slate-800 flex flex-col sm:flex-row justify-between items-center gap-4">
                    <h3 className="font-black text-gray-800 dark:text-slate-200 text-xs uppercase tracking-widest">Lista de Professores</h3>
                    <div className="relative w-full sm:w-72">
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                        <input
                            type="text"
                            placeholder="Buscar por nome ou email..."
                            value={searchTerm}
                            onChange={e => setSearchTerm(e.target.value)}
                            className="w-full pl-12 pr-4 py-3 bg-gray-50 dark:bg-slate-800 border border-transparent focus:border-tenant-primary rounded-xl text-sm outline-none transition-all"
                        />
                    </div>
                </div>

                <div className="overflow-x-auto">
                    <table className="w-full text-left">
                        <thead className="bg-gray-50/50 dark:bg-slate-800/50 text-[10px] uppercase font-black text-gray-500 dark:text-slate-400">
                            <tr>
                                <th className="px-6 py-4">Professor</th>
                                <th className="px-6 py-4">Status</th>
                                <th className="px-6 py-4">Módulo Principal</th>
                                <th className="px-6 py-4">Alunos</th>
                                <th className="px-6 py-4">Avaliação (TPI)</th>
                                <th className="px-6 py-4 text-right">Ações</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
                            {filteredTeachers.map(teacher => (
                                <tr key={teacher.id} className="hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors group">
                                    <td className="px-6 py-4">
                                        <div className="flex items-center gap-3">
                                            <img src={teacher.avatar} alt="" className="w-10 h-10 rounded-xl object-cover shadow-sm border border-gray-100 dark:border-slate-700" />
                                            <div>
                                                <p className="font-bold text-sm text-gray-800 dark:text-slate-200">{teacher.name}</p>
                                                <p className="text-xs text-gray-400 dark:text-slate-500">{teacher.email}</p>
                                            </div>
                                        </div>
                                    </td>
                                    <td className="px-6 py-4">
                                        <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wide border ${teacher.status === 'Ativo' ? 'bg-emerald-50 text-emerald-600 border-emerald-100 dark:bg-emerald-900/20 dark:border-emerald-900/30' :
                                            teacher.status === 'Férias' ? 'bg-amber-50 text-amber-600 border-amber-100 dark:bg-amber-900/20 dark:border-amber-900/30' :
                                                'bg-red-50 text-red-600 border-red-100 dark:bg-red-900/20 dark:border-red-900/30'
                                            }`}>
                                            {teacher.status}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4">
                                        <div className="flex items-center gap-2">
                                            <BookOpen size={14} className="text-tenant-primary" />
                                            <span className="text-xs font-bold text-gray-600 dark:text-slate-300">{teacher.module}</span>
                                        </div>
                                    </td>
                                    <td className="px-6 py-4">
                                        <div className="flex items-center gap-2">
                                            <Users size={14} className="text-gray-400" />
                                            <span className="text-xs font-bold text-gray-600 dark:text-slate-300">{teacher.studentsCount}</span>
                                        </div>
                                    </td>
                                    <td className="px-6 py-4">
                                        <div className="flex items-center gap-2">
                                            <div className="flex-1 w-20 h-1.5 bg-gray-100 dark:bg-slate-800 rounded-full overflow-hidden">
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
                                                className="p-2 text-tenant-primary hover:bg-blue-50 dark:hover:bg-slate-800 rounded-lg transition-all"
                                                title="Ver Agenda"
                                            >
                                                <BookOpen size={18} />
                                            </button>
                                            <button
                                                onClick={() => handleEdit(teacher)}
                                                className="p-2 text-gray-400 hover:text-tenant-primary hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg transition-all"
                                                title="Editar Professor"
                                            >
                                                <Briefcase size={18} />
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                            {filteredTeachers.length === 0 && (
                                <tr>
                                    <td colSpan={6} className="px-6 py-12 text-center">
                                        <div className="flex flex-col items-center justify-center text-gray-300 dark:text-slate-600">
                                            <Users size={48} className="mb-4 opacity-50" />
                                            <p className="text-sm font-bold">Nenhum professor encontrado</p>
                                            <p className="text-xs">Tente buscar por outro termo ou adicione um novo.</p>
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
                    <div className="bg-white dark:bg-slate-900 w-full max-w-2xl rounded-[2rem] shadow-2xl border border-gray-100 dark:border-slate-800 overflow-hidden flex flex-col max-h-[90vh]">
                        <div className="p-6 border-b dark:border-slate-800 flex justify-between items-center bg-gray-50/50 dark:bg-slate-800/50">
                            <h3 className="text-lg font-black text-gray-800 dark:text-white flex items-center gap-2">
                                <UserPlusIcon /> {editingTeacherId ? 'Editar Professor' : 'Novo Professor'}
                            </h3>
                            <button onClick={() => { setIsModalOpen(false); setEditingTeacherId(null); setFormData(initialFormState as any); }} className="p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded-xl transition-colors">
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
                                        <Input label="Valor Hora/Aula (R$)" placeholder="0.00" value={formData.hourlyRate} onChange={e => setFormData({ ...formData, hourlyRate: e.target.value })} icon={<DollarSign size={16} />} />
                                        <Input label="Chave PIX" placeholder="CPF, Email ou Aleatória" value={formData.pixKey} onChange={e => setFormData({ ...formData, pixKey: e.target.value })} icon={<Award size={16} />} />

                                        {editingTeacherId && (
                                            <div className="space-y-1.5 text-left">
                                                <label className="text-[10px] font-black uppercase tracking-widest text-gray-400 ml-1">Status do Professor</label>
                                                <select
                                                    value={(formData as any).status}
                                                    onChange={e => setFormData({ ...formData, status: e.target.value } as any)}
                                                    className="w-full px-4 py-3 bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-xl text-sm font-medium focus:ring-2 focus:ring-tenant-primary/20 focus:border-tenant-primary outline-none transition-all"
                                                >
                                                    <option value="Ativo">Ativo</option>
                                                    <option value="Férias">Férias</option>
                                                    <option value="Inativo">Inativo</option>
                                                </select>
                                            </div>
                                        )}
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

                        <div className="p-6 border-t dark:border-slate-800 bg-gray-50/50 dark:bg-slate-800/50 flex justify-end gap-3">
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
                className="w-full pl-10 pr-4 py-3 bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-xl text-sm font-medium focus:ring-2 focus:ring-tenant-primary/20 focus:border-tenant-primary outline-none transition-all"
            />
        </div>
    </div>
);

export default TeacherManagement;
