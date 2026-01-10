
import React, { useState, useEffect } from 'react';
import { Video, Search, ExternalLink, Copy, CheckCircle, Smartphone, Monitor, Shield, Zap, RefreshCw } from 'lucide-react';
import { supabase } from '../lib/supabase';
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
            // Fetch all students in the tenant to show their links
            // Alternatively, fetch only students that have bookings with this teacher
            const { data: studentsData } = await supabase
                .from('profiles')
                .select('id, full_name, avatar_url, meeting_link, module')
                .eq('role', 'STUDENT')
                .eq('tenant_id', tenantId);

            setStudents(studentsData || []);
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
            setStudentLink(data?.meeting_link || null);
        } catch (err) {
            console.error('Error fetching student link:', err);
        } finally {
            setLoading(false);
        }
    };

    const handleCopy = (link: string, id: string) => {
        navigator.clipboard.writeText(link);
        setCopySuccess(id);
        setTimeout(() => setCopySuccess(null), 2000);
    };

    if (loading) return (
        <div className="flex flex-col items-center justify-center h-96 text-slate-400">
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
                <h2 className="text-3xl font-black text-slate-800 dark:text-white tracking-tight">Central de Acessos</h2>
                <p className="text-slate-500 dark:text-slate-400 mt-1">
                    {user.role === UserRole.TEACHER
                        ? 'Acesse rapidamente as salas virtuais de todos os seus alunos.'
                        : 'Sua sala de aula fixa para todos os encontros virtuais.'}
                </p>
            </header>

            {user.role === UserRole.STUDENT && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    <div className="bg-gradient-to-br from-tenant-primary to-blue-900 p-10 rounded-[3rem] text-white shadow-2xl relative overflow-hidden group">
                        <div className="absolute right-0 top-0 w-64 h-64 bg-white/10 rounded-full blur-3xl -mr-32 -mt-32" />

                        <div className="relative z-10">
                            <div className="p-4 bg-white/10 rounded-2xl w-fit mb-8 backdrop-blur-md border border-white/20">
                                <Video size={32} className="text-white" />
                            </div>
                            <h3 className="text-4xl font-black tracking-tight mb-4">Sua Sala Virtual</h3>
                            <p className="text-blue-100 text-lg mb-10 max-w-md leading-relaxed">
                                Este é o seu link permanente. Utilize-o para todas as suas aulas com qualquer professor da nossa rede.
                            </p>

                            <div className="flex flex-col sm:flex-row gap-4">
                                <a
                                    href={studentLink || '#'}
                                    target="_blank"
                                    className="bg-white text-tenant-primary px-8 py-5 rounded-2xl font-black text-sm uppercase flex items-center justify-center gap-3 hover:scale-105 transition-all shadow-xl shadow-black/20"
                                >
                                    <Monitor size={20} /> Entrar Agora
                                </a>
                                <button
                                    onClick={() => handleCopy(studentLink || '', 'me')}
                                    className="bg-white/10 hover:bg-white/20 text-white px-8 py-5 rounded-2xl font-black text-sm uppercase flex items-center justify-center gap-3 transition-all border border-white/20 backdrop-blur-md"
                                >
                                    {copySuccess === 'me' ? <CheckCircle size={20} className="text-emerald-400" /> : <Copy size={20} />}
                                    {copySuccess === 'me' ? 'Copiado!' : 'Copiar Link'}
                                </button>
                            </div>
                        </div>
                    </div>

                    <div className="space-y-6">
                        <div className="bg-slate-50 dark:bg-slate-900/50 p-8 rounded-[2.5rem] border border-slate-100 dark:border-slate-800">
                            <div className="flex items-center gap-4 mb-4">
                                <div className="p-3 bg-blue-100 dark:bg-blue-900/30 text-blue-600 rounded-xl">
                                    <Shield size={20} />
                                </div>
                                <h4 className="font-black text-slate-800 dark:text-slate-200 text-sm uppercase tracking-widest">Conexão Segura</h4>
                            </div>
                            <p className="text-sm text-slate-500 dark:text-slate-400">Nossas salas são monitoradas pela coordenação para garantir a melhor qualidade pedagógica para você.</p>
                        </div>

                        <div className="bg-white dark:bg-slate-900 p-8 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 shadow-sm">
                            <div className="flex items-center gap-4 mb-4">
                                <div className="p-3 bg-amber-100 dark:bg-amber-900/30 text-amber-600 rounded-xl">
                                    <Smartphone size={20} />
                                </div>
                                <h4 className="font-black text-slate-800 dark:text-slate-200 text-sm uppercase tracking-widest">Acesso Mobile</h4>
                            </div>
                            <p className="text-sm text-slate-500 dark:text-slate-400">Você pode acessar sua aula pelo celular. Certifique-se de ter o app Google Meet instalado.</p>
                        </div>
                    </div>
                </div>
            )}

            {user.role === UserRole.TEACHER && (
                <div className="space-y-6">
                    <div className="flex flex-col md:flex-row justify-between items-center gap-6">
                        <div className="relative w-full md:w-96 group">
                            <Search className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                            <input
                                type="text"
                                placeholder="Buscar aluno por nome..."
                                value={searchTerm}
                                onChange={e => setSearchTerm(e.target.value)}
                                className="w-full pl-14 pr-6 py-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl outline-none focus:ring-4 focus:ring-tenant-primary/10 transition-all font-medium text-slate-700 dark:text-slate-200 shadow-sm"
                            />
                        </div>
                        <div className="bg-blue-50 dark:bg-blue-900/20 text-blue-600 px-6 py-3 rounded-2xl border border-blue-100 dark:border-blue-900/30 font-bold text-xs flex items-center gap-3">
                            <Zap size={16} fill="currentColor" /> Clique no link para conectar instantaneamente
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                        {filteredStudents.map((student) => (
                            <div key={student.id} className="group bg-white dark:bg-slate-900 p-6 rounded-[2rem] border border-slate-100 dark:border-slate-800 hover:shadow-2xl hover:shadow-slate-200/50 dark:hover:shadow-black/40 transition-all">
                                <div className="flex items-center gap-4 mb-6">
                                    <div className="w-12 h-12 rounded-xl overflow-hidden bg-slate-100">
                                        <img src={student.avatar_url || `https://ui-avatars.com/api/?name=${student.full_name}`} alt="" className="w-full h-full object-cover" />
                                    </div>
                                    <div className="overflow-hidden">
                                        <h4 className="font-black text-slate-800 dark:text-white text-sm truncate">{student.full_name}</h4>
                                        <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">{student.module || 'Sem Módulo'}</p>
                                    </div>
                                </div>

                                <div className="space-y-3">
                                    <a
                                        href={student.meeting_link || '#'}
                                        target="_blank"
                                        className="w-full py-3 bg-tenant-primary text-white rounded-xl font-bold text-[11px] uppercase tracking-widest flex items-center justify-center gap-2 hover:opacity-90 transition-opacity"
                                    >
                                        <Video size={14} /> Entrar na Sala
                                    </a>
                                    <button
                                        onClick={() => handleCopy(student.meeting_link || '', student.id)}
                                        className="w-full py-3 bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-xl font-bold text-[11px] uppercase tracking-widest flex items-center justify-center gap-2 hover:bg-slate-100 dark:hover:bg-slate-700 transition-all"
                                    >
                                        {copySuccess === student.id ? <CheckCircle size={14} className="text-emerald-500" /> : <Copy size={14} />}
                                        {copySuccess === student.id ? 'Copiado!' : 'Copiar Link'}
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>

                    {filteredStudents.length === 0 && (
                        <div className="py-20 text-center bg-slate-50 dark:bg-slate-900/50 rounded-[3rem] border-2 border-dashed border-slate-200 dark:border-slate-800">
                            <Video size={48} className="text-slate-200 mx-auto mb-4" />
                            <p className="text-slate-400 font-black uppercase text-xs tracking-widest">Nenhum aluno encontrado para "{searchTerm}"</p>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default MeetingLinksView;
