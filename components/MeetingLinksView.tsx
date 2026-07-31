
import React, { useState, useEffect } from 'react';
import { Video, Search, ExternalLink, Copy, CheckCircle, Smartphone, Monitor, Shield, Zap, RefreshCw, Edit2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { safeMeetingLink } from '../lib/meetingLink';
import { User as UserType, UserRole } from '../types';

interface MeetingLinksViewProps {
    user: UserType;
    tenantId?: string;
}



const MeetingLinksView: React.FC<MeetingLinksViewProps> = ({ user, tenantId }) => {
    const [loading, setLoading] = useState(true);
    const [students, setStudents] = useState<any[]>([]);
    const [searchTerm, setSearchTerm] = useState('');
    const [studentLink, setStudentLink] = useState<string | null>(null);
    const [copySuccess, setCopySuccess] = useState<string | null>(null);

    // Edit Modal State
    const [editingStudent, setEditingStudent] = useState<any | null>(null);
    const [newLink, setNewLink] = useState('');
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        if (user.role === UserRole.TEACHER) {
            fetchTeacherDirectory();
        } else if (user.role === UserRole.STUDENT) {
            fetchStudentPersonalLink();
        }
    }, [user, tenantId]);

    const fetchTeacherDirectory = async () => {
        setLoading(true);
        try {
            // 1. Fetch students natively assigned to this professor
            const { data: assignedStudents } = await supabase
                .from('profiles')
                .select('id, full_name, avatar_url, meeting_link, module')
                .eq('role', 'STUDENT')
                .eq('tenant_id', tenantId)
                .eq('professor_id', user.id);

            // 2. Fetch students linked via Schedule (Bookings)
            const { data: bookings } = await supabase
                .from('bookings')
                .select('student_id')
                .eq('teacher_id', user.id);

            let scheduledStudentIds: string[] = [];
            if (bookings) {
                scheduledStudentIds = bookings.map((b: any) => b.student_id);
            }

            // 3. Fetch details for scheduled students (if any)
            let scheduledStudents: any[] = [];
            if (scheduledStudentIds.length > 0) {
                const { data: scheduledData } = await supabase
                    .from('profiles')
                    .select('id, full_name, avatar_url, meeting_link, module')
                    .in('id', scheduledStudentIds)
                    .eq('tenant_id', tenantId); // Security check

                if (scheduledData) scheduledStudents = scheduledData;
            }

            // 4. Merge and Deduplicate
            const allStudents = [...(assignedStudents || []), ...scheduledStudents];
            const uniqueStudents = Array.from(new Map(allStudents.map(item => [item.id, item])).values());

            setStudents(uniqueStudents);
        } catch (err) {
            console.error('Error fetching links directory:', err);
        } finally {
            setLoading(false);
        }
    };

    const fetchStudentPersonalLink = async () => {
        setLoading(true);
        try {
            const { data } = await supabase
                .from('profiles')
                .select('meeting_link')
                .eq('id', user.id)
                .single();
            setStudentLink(safeMeetingLink(data?.meeting_link));
        } catch (err) {
            console.error('Error fetching student link:', err);
        } finally {
            setLoading(false);
        }
    };

    const handleCopy = (link: string, id: string) => {
        if (!link) return;
        navigator.clipboard.writeText(link);
        setCopySuccess(id);
        setTimeout(() => setCopySuccess(null), 2000);
    };

    const openEditModal = (student: any) => {
        setEditingStudent(student);
        setNewLink(student.meeting_link || '');
    };

    const handleUpdateLink = async () => {
        if (!editingStudent) return;
        const normalizedLink = newLink.trim() ? safeMeetingLink(newLink) : null;
        if (newLink.trim() && !normalizedLink) {
            alert('Link inválido. Cole o endereço real da sala (Meet, Zoom, Teams). Não invente um código — um link morto é pior que nenhum link.');
            return;
        }
        setIsSaving(true);
        try {
            const { error } = await supabase
                .from('profiles')
                .update({ meeting_link: normalizedLink })
                .eq('id', editingStudent.id);

            if (error) throw error;

            // Update local state
            setStudents(prev => prev.map(s => s.id === editingStudent.id ? { ...s, meeting_link: normalizedLink } : s));
            setEditingStudent(null);
        } catch (err) {
            alert('Erro ao salvar link.');
            console.error(err);
        } finally {
            setIsSaving(false);
        }
    };

    if (loading) return (
        <div className="flex flex-col items-center justify-center h-96 text-brand-muted">
            <RefreshCw className="animate-spin mb-4" size={32} />
            <p className="text-sm font-bold uppercase tracking-widest">Sincronizando Caminhos...</p>
        </div>
    );

    const filteredStudents = students.filter(s =>
        s.full_name.toLowerCase().includes(searchTerm.toLowerCase())
    );

    return (
        <div className="space-y-8 animate-in fade-in duration-700">
            <header>
                <h2 className="text-3xl font-black text-brand-text tracking-tight">Central de Acessos</h2>
                <p className="text-brand-muted mt-1">
                    {user.role === UserRole.TEACHER
                        ? 'Acesse e gerencie as salas virtuais dos seus alunos.'
                        : 'Sua sala de aula fixa para todos os encontros virtuais.'}
                </p>
            </header>

            {user.role === UserRole.STUDENT && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    <div className="bg-blue-950 bg-gradient-to-br from-tenant-primary to-blue-900 p-6 sm:p-10 rounded-[2rem] sm:rounded-[3rem] text-white shadow-2xl relative overflow-hidden group">
                        <div className="absolute right-0 top-0 w-64 h-64 bg-white/10 rounded-full blur-3xl -mr-32 -mt-32" />

                        <div className="relative z-10">
                            <div className="p-4 bg-white/10 rounded-2xl w-fit mb-6 sm:mb-8 backdrop-blur-md border border-white/20">
                                <Video size={32} className="text-white" />
                            </div>
                            <h3 className="text-2xl sm:text-4xl font-black tracking-tight mb-4">Sua Sala Virtual</h3>
                            <p className="text-blue-100 text-base sm:text-lg mb-7 sm:mb-10 max-w-md leading-relaxed">
                                Este é o seu link permanente. Utilize-o para todas as suas aulas com qualquer professor da nossa rede.
                            </p>

                            {studentLink ? (
                                <div className="flex flex-col sm:flex-row gap-4">
                                    <a
                                        href={studentLink}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="bg-white text-blue-950 px-6 sm:px-8 py-4 sm:py-5 rounded-2xl font-black text-sm uppercase flex items-center justify-center gap-3 hover:scale-[1.02] sm:hover:scale-105 transition-all shadow-xl shadow-black/20"
                                    >
                                        <Monitor size={20} /> Entrar Agora
                                    </a>
                                    <button
                                        type="button"
                                        onClick={() => handleCopy(studentLink, 'me')}
                                        className="bg-white/10 hover:bg-white/20 text-white px-6 sm:px-8 py-4 sm:py-5 rounded-2xl font-black text-sm uppercase flex items-center justify-center gap-3 transition-all border border-white/20 backdrop-blur-md"
                                    >
                                        {copySuccess === 'me' ? <CheckCircle size={20} className="text-emerald-400" /> : <Copy size={20} />}
                                        {copySuccess === 'me' ? 'Copiado!' : 'Copiar Link'}
                                    </button>
                                </div>
                            ) : (
                                <div className="rounded-2xl border border-amber-300/40 bg-amber-300/10 p-4 text-sm font-bold text-amber-100" role="status">
                                    Seu link ainda não foi cadastrado. Fale com a secretaria ou com seu professor.
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="space-y-6">
                        <div className="bg-brand-surface-2 dark:bg-brand-surface/50 p-8 rounded-[2.5rem] border border-brand-border">
                            <div className="flex items-center gap-4 mb-4">
                                <div className="p-3 bg-blue-100 dark:bg-blue-900/30 text-blue-600 rounded-xl">
                                    <Shield size={20} />
                                </div>
                                <h4 className="font-black text-brand-text dark:text-slate-200 text-sm uppercase tracking-widest">Conexão Segura</h4>
                            </div>
                            <p className="text-sm text-brand-muted">Nossas salas são monitoradas pela coordenação para garantir a melhor qualidade pedagógica para você.</p>
                        </div>

                        <div className="bg-brand-surface p-8 rounded-[2.5rem] border border-brand-border shadow-sm">
                            <div className="flex items-center gap-4 mb-4">
                                <div className="p-3 bg-amber-100 dark:bg-amber-900/30 text-amber-600 rounded-xl">
                                    <Smartphone size={20} />
                                </div>
                                <h4 className="font-black text-brand-text dark:text-slate-200 text-sm uppercase tracking-widest">Acesso Mobile</h4>
                            </div>
                            <p className="text-sm text-brand-muted">Você pode acessar sua aula pelo celular. Certifique-se de ter o app Google Meet instalado.</p>
                        </div>
                    </div>
                </div>
            )}

            {user.role === UserRole.TEACHER && (
                <div className="space-y-6">
                    <div className="flex flex-col md:flex-row justify-between items-center gap-6">
                        <div className="relative w-full md:w-96 group">
                            <Search className="absolute left-5 top-1/2 -translate-y-1/2 text-brand-muted" size={18} />
                            <input
                                type="text"
                                placeholder="Buscar aluno por nome..."
                                value={searchTerm}
                                onChange={e => setSearchTerm(e.target.value)}
                                className="w-full pl-14 pr-6 py-4 bg-brand-surface border border-brand-border dark:border-brand-border rounded-2xl outline-none focus:ring-4 focus:ring-tenant-primary/10 transition-all font-medium text-brand-text dark:text-slate-200 shadow-sm"
                            />
                        </div>
                        <div className="bg-blue-50 dark:bg-blue-900/20 text-blue-600 px-6 py-3 rounded-2xl border border-blue-100 dark:border-blue-900/30 font-bold text-xs flex items-center gap-3">
                            <Zap size={16} fill="currentColor" /> Alunos vinculados à sua conta
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                        {filteredStudents.map((student) => {
                            const meetingLink = safeMeetingLink(student.meeting_link);
                            return (
                            <div key={student.id} className="group bg-brand-surface p-6 rounded-[2rem] border border-brand-border hover:shadow-2xl hover:shadow-slate-200/50 dark:hover:shadow-black/40 transition-all">
                                <div className="flex items-center gap-4 mb-6">
                                    <div className="w-12 h-12 rounded-xl overflow-hidden bg-brand-surface-2">
                                        <img src={student.avatar_url || `https://ui-avatars.com/api/?name=${student.full_name}`} alt="" className="w-full h-full object-cover" />
                                    </div>
                                    <div className="overflow-hidden">
                                        <h4 className="font-black text-brand-text text-sm truncate">{student.full_name}</h4>
                                        <p className="text-[10px] text-brand-muted font-bold uppercase tracking-widest">{student.module || 'Sem Módulo'}</p>
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    {meetingLink ? (
                                        <a
                                            href={meetingLink}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="w-full py-3 bg-tenant-primary text-white rounded-xl font-bold text-[11px] uppercase tracking-widest flex items-center justify-center gap-2 hover:opacity-90 transition-opacity"
                                        >
                                            <Video size={14} /> Entrar na Sala
                                        </a>
                                    ) : (
                                        <div className="w-full py-3 bg-brand-surface-2 text-brand-muted rounded-xl font-bold text-[11px] uppercase tracking-widest flex items-center justify-center gap-2" role="status">
                                            <Video size={14} /> Link não cadastrado
                                        </div>
                                    )}

                                    <div className="flex gap-2">
                                        <button
                                            type="button"
                                            onClick={() => meetingLink && handleCopy(meetingLink, student.id)}
                                            disabled={!meetingLink}
                                            className="flex-1 py-3 bg-brand-surface-2 text-brand-muted rounded-xl font-bold text-[11px] uppercase tracking-widest flex items-center justify-center gap-2 hover:bg-brand-surface-2 dark:hover:bg-slate-700 transition-all disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            {copySuccess === student.id ? <CheckCircle size={14} className="text-emerald-500" /> : <Copy size={14} />}
                                            {copySuccess === student.id ? 'Copiado!' : 'Copiar'}
                                        </button>
                                        <button
                                            onClick={() => openEditModal(student)}
                                            className="px-3 py-3 bg-brand-surface-2 text-brand-muted rounded-xl hover:bg-brand-surface-2 dark:hover:bg-slate-700 hover:text-tenant-primary transition-all flex items-center gap-2"
                                            title="Editar Link Permanente"
                                        >
                                            <Edit2 size={14} />
                                        </button>
                                    </div>
                                </div>
                            </div>
                            );
                        })}
                    </div>

                    {filteredStudents.length === 0 && (
                        <div className="py-20 text-center bg-brand-surface-2 dark:bg-brand-surface/50 rounded-[3rem] border-2 border-dashed border-brand-border dark:border-brand-border">
                            <Video size={48} className="text-slate-200 mx-auto mb-4" />
                            <p className="text-brand-muted font-black uppercase text-xs tracking-widest">Nenhum aluno encontrado para "{searchTerm}"</p>
                        </div>
                    )}
                </div>
            )}

            {/* Edit Modal */}
            {editingStudent && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
                    <div className="bg-brand-surface w-full max-w-md rounded-[2.5rem] shadow-2xl p-6 sm:p-8 border border-white/10 relative max-h-[90dvh] overflow-y-auto">
                        <h3 className="text-lg font-black text-brand-text mb-2">Editar Sala de Aula</h3>
                        <p className="text-sm text-brand-muted mb-6">Defina o link permanente para <strong>{editingStudent.full_name}</strong>.</p>

                        <div className="space-y-4">
                            <div>
                                <label className="text-[10px] uppercase font-black tracking-widest text-brand-muted ml-2">Link da Reunião (Meet/Zoom)</label>
                                <input
                                    className="w-full p-4 bg-brand-surface-2 border border-brand-border rounded-2xl outline-none font-bold text-sm focus:ring-2 focus:ring-tenant-primary"
                                    placeholder="https://meet.google.com/..."
                                    value={newLink}
                                    onChange={e => setNewLink(e.target.value)}
                                />
                            </div>

                            <div className="flex gap-3 pt-2">
                                <button
                                    onClick={() => setEditingStudent(null)}
                                    className="flex-1 py-4 rounded-xl font-bold text-xs uppercase tracking-widest text-brand-muted hover:bg-brand-surface-2 dark:hover:bg-brand-surface-2 transition-colors"
                                >
                                    Cancelar
                                </button>
                                <button
                                    onClick={handleUpdateLink}
                                    disabled={isSaving}
                                    className="flex-1 py-4 bg-tenant-primary text-white rounded-xl font-bold text-xs uppercase tracking-widest hover:brightness-110 transition-colors shadow-lg shadow-tenant-primary/20"
                                >
                                    {isSaving ? 'Salvando...' : 'Salvar Link'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default MeetingLinksView;
