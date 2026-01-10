import React, { useState, useEffect } from 'react';
import { Search, RefreshCw, Upload, FileText, Trash2, Users, ChevronRight, BookOpen } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { User, UserRole } from '../types';
import confetti from 'canvas-confetti';
import { PEDAGOGICAL_BOOKS } from '../constants';
import TeacherPedagogicalModal from './TeacherPedagogicalModal';

interface PedagogicalConfigProps {
  user: User;
  tenantId?: string;
}

const PedagogicalConfig: React.FC<PedagogicalConfigProps> = ({ user, tenantId }) => {
  const [activeTab, setActiveTab] = useState<'allocation' | 'materials'>('allocation');
  const [loading, setLoading] = useState(true);

  // Allocation State
  const [students, setStudents] = useState<any[]>([]);
  const [teachers, setTeachers] = useState<any[]>([]);
  const [selectedTeacherId, setSelectedTeacherId] = useState<string | 'ALL'>('ALL');
  const [searchTerm, setSearchTerm] = useState('');
  const [pedagogicalStudent, setPedagogicalStudent] = useState<any | null>(null);

  // Materials State
  const [materials, setMaterials] = useState<any[]>([]);
  const [uploading, setUploading] = useState(false);
  const [newMaterial, setNewMaterial] = useState({ title: '', level: 'A1', type: 'PDF', file: null as File | null, url: '', category: 'General' });

  useEffect(() => {
    fetchMaterials();
    fetchStudents();
  }, [user.tenantId, tenantId]);

  const fetchStudents = async () => {
    try {
      const targetTenant = tenantId || user.tenantId;

      // 1. Fetch all students for this tenant
      const { data: allStudents, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('role', 'STUDENT')
        .eq('tenant_id', targetTenant);

      if (error) throw error;
      if (!allStudents) return;

      // 2. Identify Assignments (Who is my student?)
      // For Admins -> Show ALL. For Teachers -> Show ONLY theirs.
      let myStudentIds = new Set<string>();

      if (user.role === 'TEACHER') {
        const { data: bookings } = await supabase
          .from('bookings')
          .select('student_id')
          .eq('teacher_id', user.id);

        bookings?.forEach(b => myStudentIds.add(b.student_id));
      }

      // Map to view format
      const formatted = allStudents.map(s => ({
        id: s.id,
        name: s.full_name,
        currentModule: s.module || 'N/A',
        currentBookPart: s.current_book_part || 'Início',
        assignedTeacherIds: [] // (Optional) Could fetch relation if needed
      })).filter(s => {
        // Filter logic: Admin sees all, Teacher sees only theirs
        if (user.role === 'TEACHER') {
          return myStudentIds.has(s.id);
        }
        return true;
      });

      setStudents(formatted);
    } catch (err) {
      console.error('Error fetching students:', err);
    }
  };

  const fetchMaterials = async () => {
    try {
      const targetTenant = tenantId || user.tenantId;

      const { data, error } = await supabase
        .from('pedagogical_materials')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Fetch Error:', error);
        return;
      }

      // Filter: Global OR (Tenant AND Correct ID) OR (Private AND Owner)
      const visibleMaterials = data?.filter(m =>
        m.scope === 'GLOBAL' ||
        String(m.tenant_id) === String(targetTenant) ||
        (m.scope === 'PRIVATE' && m.uploaded_by === user.id)
      ) || [];

      setMaterials(visibleMaterials);
    } catch (err) {
      console.error(err);
    }
  };

  // --- Render Helpers ---

  const handleUploadMaterial = async () => {
    if (!newMaterial.title) return alert('Título obrigatório');
    setUploading(true);
    try {
      let finalUrl = newMaterial.url;
      if (newMaterial.type === 'PDF' && newMaterial.file) {
        const fileExt = newMaterial.file.name.split('.').pop();
        const fileName = `materials/${Date.now()}.${fileExt}`;
        if (newMaterial.file.size > 500 * 1024 * 1024) throw new Error('O arquivo deve ter menos de 500MB. Para arquivos maiores, aumente o limite no Supabase.');
        const { error: upErr } = await supabase.storage.from('materials').upload(fileName, newMaterial.file);
        if (upErr) throw upErr;
        const { data: { publicUrl } } = supabase.storage.from('materials').getPublicUrl(fileName);
        finalUrl = publicUrl;
      }

      const userRole = user.role;
      const isTeacher = userRole === 'TEACHER';
      const scope = isTeacher ? 'PRIVATE' : 'TENANT';

      const targetTenantId = tenantId || user.tenantId;
      if (!targetTenantId) {
        alert('Erro Crítico: ID da Unidade não identificado. Recarregue a página.');
        setUploading(false);
        return;
      }

      const { data, error } = await supabase.from('pedagogical_materials').insert({
        tenant_id: targetTenantId,
        title: newMaterial.title,
        file_url: finalUrl,
        type: newMaterial.type,
        level_tag: newMaterial.level,
        category: newMaterial.category,
        uploaded_by: user.id,
        scope: scope
      }).select().single();

      if (error) {
        console.error('Database Insert Error:', error);
        throw new Error(`Erro de Banco de Dados: ${error.message} (${error.code})`);
      }

      setMaterials(prev => [data, ...prev]);
      alert('Material salvo com sucesso!');
      setNewMaterial({ title: '', level: 'A1', type: 'PDF', file: null, url: '', category: 'General' });
    } catch (err: any) {
      console.error('Upload Error Details:', err);
      alert(`Erro ao salvar: ${err.message || JSON.stringify(err)}`);
    } finally { setUploading(false); }
  };

  const handleDeleteMaterial = async (id: string) => {
    if (!confirm('Tem certeza que deseja excluir este material?')) return;
    try {
      const { error } = await supabase.from('pedagogical_materials').delete().eq('id', id);
      if (error) throw error;
      setMaterials(prev => prev.filter(m => m.id !== id));
    } catch (err: any) { alert('Erro ao excluir: ' + err.message); }
  };

  // --- Render Helpers ---
  const modulesList = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  const showSidebar = user.role === UserRole.SCHOOL_ADMIN || user.role === UserRole.SUPER_ADMIN;

  // Filtered Students (Legacy Allocation Tab)
  const filteredStudents = students.filter(s => {
    const matchesSearch = s.name.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesTeacher = selectedTeacherId === 'ALL' || s.assignedTeacherIds.includes(selectedTeacherId);
    return matchesSearch && matchesTeacher;
  });

  return (
    <div className="space-y-6 animate-in fade-in duration-500 h-[calc(100vh-8rem)] flex flex-col">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 shrink-0">
        <div>
          <h2 className="text-3xl font-black text-slate-800 dark:text-white tracking-tight">Gestão Pedagógica</h2>
          <p className="text-slate-500 dark:text-slate-400 text-sm">Biblioteca Master e Currículo.</p>
        </div>
        <div className="flex gap-2 p-1 bg-slate-100 dark:bg-slate-800 rounded-xl">
          <button onClick={() => setActiveTab('allocation')} className={`px-4 py-2 rounded-lg text-xs font-black uppercase tracking-widest transition-all ${activeTab === 'allocation' ? 'bg-white dark:bg-slate-700 shadow-sm text-tenant-primary dark:text-white' : 'text-slate-400'}`}>Atribuições</button>
          <button onClick={() => setActiveTab('materials')} className={`px-4 py-2 rounded-lg text-xs font-black uppercase tracking-widest transition-all ${activeTab === 'materials' ? 'bg-white dark:bg-slate-700 shadow-sm text-tenant-primary dark:text-white' : 'text-slate-400'}`}>Biblioteca</button>
        </div>
      </div>

      {activeTab === 'allocation' && (
        <div className="flex-1 flex gap-6 overflow-hidden">
          {/* Allocation Table */}
          <div className="flex-1 bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 rounded-[2rem] flex flex-col overflow-hidden shadow-sm p-4">
            <div className="mb-4 flex gap-4">
              <input value={searchTerm} onChange={e => setSearchTerm(e.target.value)} placeholder="Buscar aluno..." className="p-2 border rounded-lg flex-1 bg-transparent" />
            </div>
            <div className="overflow-y-auto flex-1">
              <table className="w-full text-left">
                <thead className="bg-slate-50 dark:bg-slate-800 text-[10px] uppercase font-black text-slate-400">
                  <tr><th className="p-3">Aluno</th><th className="p-3">Módulo</th><th className="p-3">Progresso</th><th className="p-3 text-right">Ações</th></tr>
                </thead>
                <tbody>
                  {filteredStudents.map(s => (
                    <tr key={s.id} className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors group">
                      <td className="p-3 font-bold text-xs">{s.name}</td>
                      <td className="p-3 text-xs">{s.currentModule}</td>
                      <td className="p-3 text-xs">{s.currentBookPart}</td>
                      <td className="p-3 text-right">
                        <button
                          onClick={() => setPedagogicalStudent(s)}
                          className="px-3 py-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 text-[10px] font-black uppercase hover:bg-indigo-100 transition-colors"
                        >
                          Atribuir / Gerenciar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {pedagogicalStudent && (
        <TeacherPedagogicalModal
          student={pedagogicalStudent}
          onClose={() => setPedagogicalStudent(null)}
        />
      )}

      {activeTab === 'materials' && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 h-full min-h-0">
          {showSidebar && (
            <div className="bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 rounded-[2.5rem] p-8 h-fit">
              <h3 className="text-xl font-black mb-6 flex items-center gap-2"><Upload size={20} className="text-tenant-primary" /> Novo Material</h3>
              <div className="space-y-4">
                <input value={newMaterial.title} onChange={e => setNewMaterial({ ...newMaterial, title: e.target.value })} className="w-full p-3 bg-slate-50 dark:bg-slate-800 rounded-xl text-sm font-bold outline-none" placeholder="Título" />
                <div className="flex gap-2">
                  <select value={newMaterial.type} onChange={e => setNewMaterial({ ...newMaterial, type: e.target.value as any })} className="flex-1 p-2 bg-slate-50 dark:bg-slate-800 rounded-xl text-xs font-bold">
                    <option value="PDF">PDF</option>
                    <option value="VIDEO">Vídeo (URL)</option>
                    <option value="LINK">Link</option>
                  </select>
                  <select value={newMaterial.level} onChange={e => setNewMaterial({ ...newMaterial, level: e.target.value })} className="flex-1 p-2 bg-slate-50 dark:bg-slate-800 rounded-xl text-xs font-bold">
                    {modulesList.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                {newMaterial.type === 'PDF' ? (
                  <div className="p-4 border-2 border-dashed rounded-xl text-center"><input type="file" accept=".pdf" onChange={e => setNewMaterial({ ...newMaterial, file: e.target.files?.[0] || null })} className="hidden" id="file-up" /><label htmlFor="file-up" className="cursor-pointer text-xs font-bold text-slate-500">{newMaterial.file ? newMaterial.file.name : 'Selecionar PDF'}</label></div>
                ) : (
                  <input value={newMaterial.url} onChange={e => setNewMaterial({ ...newMaterial, url: e.target.value })} className="w-full p-3 bg-slate-50 dark:bg-slate-800 rounded-xl text-sm" placeholder="https://..." />
                )}
                <button onClick={handleUploadMaterial} disabled={uploading} className="w-full py-3 bg-tenant-primary text-white rounded-xl font-black uppercase tracking-widest hover:scale-105 transition-all">{uploading ? 'Enviando...' : 'Salvar Material'}</button>
              </div>
            </div>
          )}

          <div className={`${showSidebar ? 'md:col-span-2' : 'md:col-span-3'} bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 rounded-[2.5rem] p-8 flex flex-col`}>
            <h3 className="text-xl font-black mb-6">Biblioteca Master</h3>
            <div className="flex-1 overflow-y-auto space-y-3 custom-scrollbar">
              {materials.map(m => (
                <div key={m.id} className="p-4 rounded-xl border border-slate-100 dark:border-slate-800 flex items-center justify-between hover:bg-slate-50 dark:hover:bg-slate-800/50 group">
                  <div className="flex items-center gap-4">
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold text-xs ${m.type === 'PDF' ? 'bg-red-500' : m.type === 'VIDEO' ? 'bg-blue-500' : 'bg-green-500'}`}>{m.type}</div>
                    <div>
                      <h4 className="font-bold text-sm text-slate-800 dark:text-white flex items-center gap-2">
                        {m.title}
                        {m.scope === 'PRIVATE' && <span className="text-[9px] bg-indigo-100 text-indigo-500 px-1.5 rounded uppercase">Privado</span>}
                      </h4>
                      <div className="flex gap-2 mt-1"><span className="text-[10px] bg-slate-100 dark:bg-slate-800 px-1.5 rounded uppercase font-black text-slate-500">{m.level_tag}</span></div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <a href={m.file_url} target="_blank" rel="noreferrer" className="text-xs font-bold text-indigo-500 hover:underline">Acessar</a>
                    {showSidebar && (
                      <button onClick={() => handleDeleteMaterial(m.id)} className="p-2 text-slate-400 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"><Trash2 size={16} /></button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PedagogicalConfig;
