import React, { useState, useEffect } from 'react';
import { Search, ExternalLink, Video, Star, MessageCircle, Info, RefreshCw, BookOpen, Briefcase, Phone, Copy, UserPlus, Edit3, Trash2, Users, ChevronRight } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { User as UserType, UserRole, Teacher } from '../types';
import StudentProfileForm from './StudentProfileForm';
import TeacherPedagogicalModal from './TeacherPedagogicalModal';

interface StudentsListProps {
  tenantId?: string;
  user?: UserType;
  teachers?: Teacher[];
}

const StudentsList: React.FC<StudentsListProps> = ({ tenantId, user, teachers = [] }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedTeacherId, setSelectedTeacherId] = useState<string | 'ALL'>('ALL');

  const [students, setStudents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingStudent, setEditingStudent] = useState<any | null>(null);
  const [pedagogicalStudent, setPedagogicalStudent] = useState<any | null>(null);

  useEffect(() => {
    if (tenantId) fetchStudents();
  }, [tenantId, user?.id]);

  const fetchStudents = async () => {
    setLoading(true);
    try {
      // 1. Fetch Students
      let query = supabase
        .from('profiles')
        .select('*')
        .eq('role', 'STUDENT')
        .eq('tenant_id', tenantId);

      // If teacher, filter students they have bookings with
      if (user?.role === UserRole.TEACHER) {
        const { data: teacherBookings } = await supabase
          .from('bookings')
          .select('student_id')
          .eq('teacher_id', user.id);

        const studentIds = Array.from(new Set(teacherBookings?.map(b => b.student_id) || []));
        if (studentIds.length > 0) {
          query = query.in('id', studentIds);
        } else {
          setStudents([]);
          setLoading(false);
          return;
        }
      }

      const { data: studentsData, error: studentError } = await query;
      if (studentError) throw studentError;

      // 2. Fetch Bookings to find teachers
      const { data: bookingsData } = await supabase
        .from('bookings')
        .select('student_id, teacher_id, teacher:teacher_id(id, full_name)')
        .eq('tenant_id', tenantId);

      if (studentsData) {
        const mappedStudents = studentsData.map(s => {
          // Find teachers for this student
          const studentBookings = bookingsData?.filter(b => b.student_id === s.id) || [];
          const assignedTeacherIds = Array.from(new Set(studentBookings.map(b => b.teacher_id)));
          const teacherNames = Array.from(new Set(studentBookings.map(b => (b.teacher as any)?.full_name))).filter(Boolean);

          return {
            id: s.id,
            name: s.full_name || 'Nome Indefinido',
            levelBadge: s.module?.split(' ')[0] || 'N/A',
            currentModuleStatus: s.module || 'Não iniciado',
            interests: s.interests || [],
            correctionPreference: 'PADRÃO',
            occupation: s.occupation || 'Não informado',
            phone: s.phone || '',
            img: s.avatar_url || `https://ui-avatars.com/api/?name=${s.full_name}`,
            meetingLink: s.meeting_link || '',
            assignedTeachers: teacherNames,
            assignedTeacherIds: assignedTeacherIds, // For filtering
            createdAt: s.created_at
          };
        });
        setStudents(mappedStudents);
      }
    } catch (err) {
      console.error('Error fetching students:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateStudent = async (formData: any) => {
    if (!editingStudent) return;

    try {
      const { error } = await supabase
        .from('profiles')
        .update({
          full_name: formData.name,
          module: formData.currentModuleStatus,
          interests: formData.interests,
          occupation: formData.occupation,
          phone: formData.phone,
          meeting_link: formData.meeting_link,
          avatar_url: formData.img
        })
        .eq('id', editingStudent.id);

      if (error) throw error;

      alert('Perfil do aluno atualizado com sucesso!');
      setEditingStudent(null);
      fetchStudents();
    } catch (err: any) {
      alert('Erro ao atualizar aluno: ' + err.message);
    }
  };

  const handleDeleteStudent = async () => {
    if (!editingStudent) return;
    if (!confirm('ATENÇÃO: Isso excluirá PERMANENTEMENTE o aluno e todo o histórico (Aulas, Financeiro, Reposições). Deseja realmente continuar?')) return;

    try {
      // 1. Delete Dependencies first to avoid FK constraints

      // Class Logs
      const { error: logError } = await supabase.from('class_logs').delete().eq('student_id', editingStudent.id);
      if (logError) console.error('Error deleting logs:', logError); // Log but continue

      // Reschedules
      const { error: resError } = await supabase.from('reschedules').delete().eq('student_id', editingStudent.id);
      if (resError) console.error('Error deleting reschedules:', resError);

      // Bookings
      const { error: bookError } = await supabase.from('bookings').delete().eq('student_id', editingStudent.id);
      if (bookError) throw bookError;

      // Note: Financial Records might also need deletion if linked directly, 
      // but usually they are linked via bookings or manually. 
      // Attempting to delete from 'financial_records' if it exists and has student_id
      const { error: finError } = await supabase.from('financial_records').delete().eq('student_id', editingStudent.id);
      if (finError && finError.code !== '42P01') console.error('Error deleting financials:', finError); // Ignore table not found

      // 2. Delete Profile
      const { error } = await supabase.from('profiles').delete().eq('id', editingStudent.id);

      if (error) throw error;

      alert('Aluno e histórico removidos com sucesso.');
      setEditingStudent(null);
      fetchStudents();
    } catch (err: any) {
      alert('Erro ao remover aluno: ' + err.message);
    }
  };

  // Filter Logic
  const filteredStudents = students.filter(s => {
    const matchesSearch = s.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      s.occupation.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesTeacher = selectedTeacherId === 'ALL' || s.assignedTeacherIds.includes(selectedTeacherId);

    return matchesSearch && matchesTeacher;
  });

  const showSidebar = user?.role === UserRole.SCHOOL_ADMIN || user?.role === UserRole.SUPER_ADMIN;

  return (
    <div className="flex flex-col xl:flex-row gap-6 h-[calc(100vh-6rem)] animate-in fade-in duration-500 relative">

      {/* Sidebar: Teacher Filter (Admins Only) */}
      {showSidebar && (
        <div className="w-full xl:w-72 bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 rounded-[2rem] flex flex-col shadow-sm shrink-0">
          <div className="p-5 border-b border-slate-100 dark:border-slate-800">
            <h3 className="font-black text-slate-800 dark:text-slate-100 text-[10px] uppercase tracking-widest mb-3 flex items-center gap-2">
              <Users size={14} className="text-tenant-primary" /> Filtrar por Professor
            </h3>
            {/* Optional Search inside sidebar could go here */}
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-2 custom-scrollbar">
            <button
              onClick={() => setSelectedTeacherId('ALL')}
              className={`w-full p-3 rounded-xl border transition-all flex items-center gap-3 text-left group ${selectedTeacherId === 'ALL'
                ? 'bg-slate-800 border-slate-800 text-white shadow-lg'
                : 'bg-white dark:bg-slate-900 border-slate-50 dark:border-slate-800 hover:border-slate-300'
                }`}
            >
              <div className="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
                <Users size={14} className={selectedTeacherId === 'ALL' ? 'text-slate-800' : 'text-slate-400'} />
              </div>
              <span className={`text-[10px] font-black uppercase tracking-wide flex-1 ${selectedTeacherId === 'ALL' ? 'text-white' : 'text-slate-600 dark:text-slate-400'}`}>
                Todos os Alunos
              </span>
              {selectedTeacherId === 'ALL' && <ChevronRight size={12} />}
            </button>

            {teachers.map(teacher => (
              <button
                key={teacher.id}
                onClick={() => setSelectedTeacherId(teacher.id)}
                className={`w-full p-3 rounded-xl border transition-all flex items-center gap-3 text-left group ${selectedTeacherId === teacher.id
                  ? 'bg-tenant-primary border-tenant-primary text-white shadow-lg shadow-tenant-primary/20'
                  : 'bg-white dark:bg-slate-900 border-slate-50 dark:border-slate-800 hover:border-tenant-primary/30'
                  }`}
              >
                <img src={teacher.avatar} className="w-8 h-8 rounded-lg border-2 border-white/20" alt="" />
                <div className="flex-1 overflow-hidden">
                  <p className={`text-[10px] font-black truncate leading-tight ${selectedTeacherId === teacher.id ? 'text-white' : 'text-slate-700 dark:text-slate-300'}`}>
                    {teacher.name}
                  </p>
                </div>
                {selectedTeacherId === teacher.id && <ChevronRight size={12} />}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 flex flex-col gap-6 overflow-hidden">
        {/* Header Search */}
        <div className="flex flex-col md:flex-row justify-between items-center gap-4 bg-white dark:bg-slate-900 p-4 rounded-[2rem] border border-slate-100 dark:border-slate-800 shrink-0">
          <div className="flex items-center gap-4 w-full">
            <div className="p-3 bg-slate-50 dark:bg-slate-800 rounded-full">
              <Search size={20} className="text-slate-400" />
            </div>
            <input
              className="flex-1 bg-transparent outline-none text-sm font-bold text-slate-700 dark:text-slate-200 placeholder:text-slate-400"
              placeholder="Buscar aluno por nome, profissão..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2 px-4 py-1 bg-slate-50 dark:bg-slate-800 rounded-full">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-[10px] font-black uppercase text-slate-500 tracking-widest">{filteredStudents.length} Alunos</span>
          </div>
        </div>

        {/* Grid */}
        <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 pb-20">
            {loading ? (
              <div className="col-span-full py-20 flex flex-col items-center justify-center text-slate-400">
                <RefreshCw className="animate-spin mb-4" size={32} />
                <p className="text-xs font-black uppercase tracking-widest">Carregando Alunos...</p>
              </div>
            ) : filteredStudents.map((student, i) => (
              <div key={i} className="group bg-white dark:bg-slate-900 rounded-[2rem] border border-slate-100 dark:border-slate-800 p-6 hover:shadow-2xl hover:shadow-slate-200/50 dark:hover:shadow-black/40 transition-all duration-300 relative overflow-hidden h-fit">

                {/* Header: Name & Edit */}
                <div className="flex justify-between items-start mb-6">
                  <div className="flex-1 pr-4">
                    <h3 className="font-black text-slate-800 dark:text-white text-lg leading-tight tracking-tight mb-1">{student.name}</h3>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <div className="w-8 h-8 rounded-full bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center text-purple-600 dark:text-purple-400 font-black text-xs">
                      {student.levelBadge}
                    </div>
                    <button
                      onClick={() => setEditingStudent({ ...student, meeting_link: student.meetingLink })}
                      className="w-8 h-8 rounded-full bg-tenant-primary/10 text-tenant-primary flex items-center justify-center hover:bg-tenant-primary hover:text-white transition-all shadow-sm"
                      title="Editar Perfil"
                    >
                      <Edit3 size={14} />
                    </button>
                  </div>
                </div>

                {/* Content Sections */}
                <div className="space-y-5">

                  {/* Module */}
                  <div>
                    <h4 className="text-[10px] uppercase font-black text-slate-400 tracking-widest mb-1.5">Módulo Atual</h4>
                    <div className="inline-block px-3 py-1.5 bg-blue-500 text-white rounded-lg text-[10px] font-black uppercase tracking-wide shadow-lg shadow-blue-500/20">
                      {student.currentModuleStatus}
                    </div>
                  </div>

                  {/* Interests */}
                  <div>
                    <h4 className="text-[10px] uppercase font-black text-slate-400 tracking-widest mb-2 flex items-center gap-1.5">
                      <BookOpen size={12} /> Interesses
                    </h4>
                    <div className="flex flex-wrap gap-2">
                      {student.interests.map((interest: string, idx: number) => (
                        <span key={idx} className="px-2.5 py-1 bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 rounded-md text-[9px] font-bold uppercase tracking-wider">
                          {interest}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Occupation */}
                  <div>
                    <h4 className="text-[10px] uppercase font-black text-slate-400 tracking-widest mb-1.5 flex items-center gap-1.5">
                      <Briefcase size={12} /> Ocupação
                    </h4>
                    <div className="inline-block px-3 py-1 border border-pink-200 dark:border-pink-900 text-pink-500 dark:text-pink-400 rounded-full text-[10px] font-black uppercase tracking-wide">
                      {student.occupation}
                    </div>
                  </div>

                  {/* Assigned Teachers */}
                  <div>
                    <h4 className="text-[10px] uppercase font-black text-slate-400 tracking-widest mb-1.5 flex items-center gap-1.5">
                      <UserPlus size={12} className="text-blue-500" /> Professor Atribuído
                    </h4>
                    <div className="flex flex-wrap gap-1">
                      {student.assignedTeachers?.length > 0 ? (
                        student.assignedTeachers.map((t: string, idx: number) => (
                          <span key={idx} className="px-2 py-1 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 rounded-lg text-[10px] font-black uppercase tracking-tight">
                            {t}
                          </span>
                        ))
                      ) : (
                        <span className="text-[10px] text-slate-400 font-medium italic">Nenhum professor alocado</span>
                      )}
                    </div>
                  </div>

                  {/* Contact Info */}
                  <div className="grid grid-cols-2 gap-4 pt-2">
                    <div>
                      <h4 className="text-[10px] uppercase font-black text-slate-400 tracking-widest mb-1.5 flex items-center gap-1.5">
                        <Phone size={12} /> WhatsApp
                      </h4>
                      <p className="text-xs font-bold text-slate-700 dark:text-slate-200">{student.phone || 'N/A'}</p>
                    </div>
                    <div>
                      <h4 className="text-[10px] uppercase font-black text-slate-400 tracking-widest mb-1.5 flex items-center gap-1.5">
                        <Video size={12} /> Link Aula
                      </h4>
                      <p className="text-[10px] font-medium text-slate-500 truncate">{student.meetingLink || 'N/A'}</p>
                    </div>
                  </div>

                </div>

                {/* Footer */}
                <div className="mt-8 pt-6 border-t border-slate-100 dark:border-slate-800">
                  <button
                    className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 text-xs font-black uppercase hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                    onClick={() => setEditingStudent({ ...student, meeting_link: student.meetingLink })}
                  >
                    <Info size={14} /> Editar Perfil Completo
                  </button>
                </div>

              </div>
            ))}
          </div>

          {!loading && filteredStudents.length === 0 && (
            <div className="py-24 text-center bg-white dark:bg-slate-900 rounded-[3rem] border border-dashed border-slate-200 dark:border-slate-800">
              <div className="inline-block p-4 rounded-full bg-slate-50 dark:bg-slate-800 mb-4">
                <Search size={24} className="text-slate-300" />
              </div>
              <p className="text-slate-400 dark:text-slate-600 font-black uppercase text-xs tracking-widest">Nenhum aluno encontrado para "{searchTerm}"</p>
            </div>
          )}
        </div>
      </div>


      {/* Edit Modal */}
      {editingStudent && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-black/60 backdrop-blur-sm animate-in fade-in duration-300">
          <StudentProfileForm
            initialData={editingStudent}
            onSubmit={handleUpdateStudent}
            onCancel={() => setEditingStudent(null)}
            onDelete={(user?.role === 'SCHOOL_ADMIN' || user?.role === 'SUPER_ADMIN') ? handleDeleteStudent : undefined}
            title={editingStudent.name}
          />
        </div>
      )}
    </div>
  );
};

export default StudentsList;
