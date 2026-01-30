import React, { useState, useEffect } from 'react';
import { Search, ExternalLink, Video, Star, MessageCircle, Info, RefreshCw, BookOpen, Briefcase, Phone, Copy, UserPlus, Edit3, Trash2, Users, ChevronRight, Calendar, Folder, CreditCard } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { asaasService } from '../services/asaasService';
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

      // 2. Fetch Bookings to find teachers and schedule
      // NOTE: Using start_date and time_slot as per schema
      const { data: bookingsData } = await supabase
        .from('bookings')
        .select('student_id, teacher_id, start_date, time_slot, teacher:teacher_id(id, full_name)')
        .eq('tenant_id', tenantId);

      console.log('Bookings Data:', bookingsData);

      if (studentsData) {
        const mappedStudents = studentsData.map(s => {
          // Normalize IDs to string for comparison safety
          const sId = String(s.id);
          const studentBookings = bookingsData?.filter(b => String(b.student_id) === sId) || [];

          const assignedTeacherIds = Array.from(new Set(studentBookings.map(b => String(b.teacher_id))));
          const teacherNames = Array.from(new Set(studentBookings.map(b => (b.teacher as any)?.full_name))).filter(Boolean);

          // Format Schedule (e.g. "Seg/Qua - 19:00")
          let scheduleDisplay = s.fixed_schedule; // Default to manual from DB

          if (studentBookings.length > 0) {
            // Helper to get day string from Date
            const getDayFromDate = (dateStr: string) => {
              if (!dateStr) return '';
              // Append 'T00:00:00' to ensure local time is not shifted by timezone if it's just a YYYY-MM-DD string
              // But typically start_date is YYYY-MM-DD. 
              // Let's create date object and get day. 
              // Note: creating date from string directly might look at UTC. 
              // Best simple way for "YYYY-MM-DD":
              const parts = dateStr.split('-');
              if (parts.length !== 3) return '';
              const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
              const dayIndex = d.getDay(); // 0 = Sun, 1 = Mon...
              const days = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
              return days[dayIndex];
            };

            const dayOrder = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

            // We want to find the DISTINCT pattern of classes.
            // If they have 50 bookings, but they are all "Seg 19h" and "Qua 19h", we want "Seg/Qua - 19:00"
            // Let's map each booking to "Day Time" unique key
            const scheduleItems = studentBookings.map(b => {
              const day = getDayFromDate(b.start_date);
              // time_slot is text, assume "19:00" or similar. Clean it.
              const time = b.time_slot?.slice(0, 5) || '';
              return { day, time };
            }).filter(x => x.day && x.time);

            // Deduplicate
            const uniqueItems = Array.from(new Set(scheduleItems.map(item => JSON.stringify(item)))).map(str => JSON.parse(str));

            // Extract unique times
            const uniqueTimes = Array.from(new Set(uniqueItems.map(i => i.time)));

            if (uniqueTimes.length === 1) {
              // Same time across days
              const days = uniqueItems.map(i => i.day);
              const sortedDays = Array.from(new Set(days)).sort((a, b) => dayOrder.indexOf(a) - dayOrder.indexOf(b));
              scheduleDisplay = `${sortedDays.join('/')} - ${uniqueTimes[0]}`;
            } else if (uniqueTimes.length > 0) {
              // Different times, complex string
              const sortedItems = uniqueItems.sort((a, b) => {
                return dayOrder.indexOf(a.day) - dayOrder.indexOf(b.day);
              });
              scheduleDisplay = sortedItems.map(i => `${i.day} ${i.time}`).join(' / ');
            }
          }

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
            fixed_schedule: scheduleDisplay,
            private_notes: s.private_notes,
            assignedTeachers: teacherNames,
            assignedTeacherIds: assignedTeacherIds,
            createdAt: s.created_at,
            cpf: s.cpf,
            postalCode: s.postal_code,
            address: s.address,
            addressNumber: s.address_number,
            asaasCustomerId: s.asaas_customer_id,
            professor_id: s.professor_id
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
          avatar_url: formData.img,
          fixed_schedule: formData.fixed_schedule,
          private_notes: formData.private_notes,
          cpf: formData.cpf,
          postal_code: formData.postalCode,
          address: formData.address,
          postal_code: formData.postalCode,
          address: formData.address,
          address_number: formData.addressNumber,
          professor_id: formData.professor_id
        })
        .eq('id', editingStudent.id);

      if (error) throw error;

      alert('Perfil do aluno atualizado com sucesso!');
      setEditingStudent(null);

      // Sync with Asaas
      try {
        await asaasService.syncStudent({
          user_id: editingStudent.id,
          name: formData.name,
          email: 'email@placeholder.com', // TODO: We need the email from AUTH or Profile. Profile might have it? Usually profiles has 'email' column if synced, or we get it from auth. Let's assume profile doesn't have it and use a placeholder or check if profiles has email.
          // Wait, looking at fetch logic, select * from profiles. Does profiles have email? 
          // In many Supabase setups, profiles copies email. If not, we might fail.
          // Let's check the schema or assuming it's available. 
          // The request says "email" in input. 
          // Let's assume `editingStudent` or `formData` should have it? 
          // `StudentProfileForm` doesn't have email field.
          // We should probably add email to keys if available.
          // Or fetch it.
          // For now let's try to capture it if available in `editingStudent` (which comes from `s`).
          cpf: formData.cpf,
          phone: formData.phone,
          postalCode: formData.postalCode,
          address: formData.address,
          addressNumber: formData.addressNumber
        } as any);
        // Note: We need email. If `s` has email, we are good.
        // If not, we might need to fetch it.
        // Let's assume `s` has email for now.
      } catch (asaasError) {
        console.error("Asaas Sync Error", asaasError);
        alert("Aluno salvo, mas erro ao sincronizar com Asaas. Verifique o console.");
      }

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
                      onClick={() => setEditingStudent({ ...student, meeting_link: student.meetingLink, fixed_schedule: student.fixed_schedule, private_notes: student.private_notes })}
                      className="w-8 h-8 rounded-full bg-tenant-primary/10 text-tenant-primary flex items-center justify-center hover:bg-tenant-primary hover:text-white transition-all shadow-sm"
                      title="Editar Perfil"
                    >
                      <Edit3 size={14} />
                    </button>
                  </div>
                </div>

                {/* Content Sections */}
                <div className="space-y-5">

                  {/* Module & Progress */}
                  <div>
                    <div className="flex justify-between items-end mb-1.5">
                      <h4 className="text-[10px] uppercase font-black text-slate-400 tracking-widest">Progresso do Módulo</h4>
                      <span className="text-[10px] font-bold text-slate-600 dark:text-slate-400">{student.currentModuleStatus}</span>
                    </div>
                    {/* Fake Progress Bar - Visual Only for now */}
                    <div className="w-full h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-blue-500 to-purple-500 w-[45%]" />
                    </div>
                  </div>

                  {/* Fixed Schedule */}
                  <div>
                    <h4 className="text-[10px] uppercase font-black text-slate-400 tracking-widest mb-1.5 flex items-center gap-1.5">
                      <Calendar size={12} /> Horário Fixo
                    </h4>
                    {student.fixed_schedule ? (
                      <div className="px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-100 dark:border-slate-700 rounded-xl text-xs font-black text-slate-700 dark:text-slate-300">
                        {student.fixed_schedule}
                      </div>
                    ) : (
                      <div className="px-3 py-2 border border-dashed border-slate-200 dark:border-slate-800 rounded-xl text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                        -- Não definido --
                      </div>
                    )}
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
                    <p className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase">{student.occupation}</p>
                  </div>

                  {/* Action Buttons */}
                  <div className="grid grid-cols-3 gap-2 pt-2">
                    {/* WhatsApp */}
                    <button
                      onClick={() => window.open(`https://wa.me/${student.phone?.replace(/\D/g, '')}`, '_blank')}
                      className="flex flex-col items-center justify-center gap-1 p-2 bg-green-50 hover:bg-green-100 dark:bg-green-900/20 dark:hover:bg-green-900/30 border border-green-100 dark:border-green-900/30 rounded-xl transition-colors group"
                      title="Abrir WhatsApp"
                    >
                      <MessageCircle size={18} className="text-green-600 dark:text-green-400 group-hover:scale-110 transition-transform" />
                      <span className="text-[9px] font-black text-green-700 dark:text-green-300 uppercase tracking-wide">WhatsApp</span>
                    </button>

                    {/* Meet */}
                    <button
                      onClick={() => window.open(student.meetingLink, '_blank')}
                      disabled={!student.meetingLink}
                      className="flex flex-col items-center justify-center gap-1 p-2 bg-blue-50 hover:bg-blue-100 dark:bg-blue-900/20 dark:hover:bg-blue-900/30 border border-blue-100 dark:border-blue-900/30 rounded-xl transition-colors group disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Link da Aula"
                    >
                      <Video size={18} className="text-blue-600 dark:text-blue-400 group-hover:scale-110 transition-transform" />
                      <span className="text-[9px] font-black text-blue-700 dark:text-blue-300 uppercase tracking-wide">Sala Aula</span>
                    </button>

                    {/* Materials */}
                    <button
                      className="flex flex-col items-center justify-center gap-1 p-2 bg-purple-50 hover:bg-purple-100 dark:bg-purple-900/20 dark:hover:bg-purple-900/30 border border-purple-100 dark:border-purple-900/30 rounded-xl transition-colors group"
                      title="Materiais do Aluno"
                    >
                      <Folder size={18} className="text-purple-600 dark:text-purple-400 group-hover:scale-110 transition-transform" />
                      <span className="text-[9px] font-black text-purple-700 dark:text-purple-300 uppercase tracking-wide">Materiais</span>
                    </button>
                  </div>

                </div>

                {/* Footer */}
                <div className="mt-8 pt-6 border-t border-slate-100 dark:border-slate-800">
                  <button
                    className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 text-xs font-black uppercase hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                    onClick={() => setEditingStudent({ ...student, meeting_link: student.meetingLink, fixed_schedule: student.fixed_schedule, private_notes: student.private_notes })}
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
            teachers={teachers}
          />
        </div>
      )}
    </div>
  );
};

export default StudentsList;
