import React, { useState, useEffect } from 'react';
import { Search, RefreshCw, Upload, FileText, Trash2, Users, ChevronRight, BookOpen } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { User, UserRole } from '../types';
import confetti from 'canvas-confetti';
import { PEDAGOGICAL_BOOKS } from '../constants';
import TeacherPedagogicalModal from './TeacherPedagogicalModal';
import MaterialsLibrary from './MaterialsLibrary';

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
  const [newMaterial, setNewMaterial] = useState({ title: '', level: 'A1', type: 'PDF', file: null as File | null, url: '', category: 'General', niche: 'GENERAL' });
  const [selectedNiche, setSelectedNiche] = useState('ALL');
  const [customNiches, setCustomNiches] = useState<{ key: string; label: string }[]>([]);
  const [newNicheLabel, setNewNicheLabel] = useState('');
  const [showNewNiche, setShowNewNiche] = useState(false);
  const [editingMaterial, setEditingMaterial] = useState<any | null>(null);

  const isTeacher = user.role === UserRole.TEACHER;
  const canUpload = isTeacher || user.role === UserRole.SCHOOL_ADMIN || user.role === UserRole.SUPER_ADMIN;

  // Carrega nichos customizados da escola
  useEffect(() => {
    supabase.rpc('list_niches').then(({ data }) => { if (Array.isArray(data)) setCustomNiches(data); });
  }, [tenantId]);

  const addNiche = async () => {
    const label = newNicheLabel.trim();
    if (label.length < 2) return;
    const { data } = await supabase.rpc('upsert_niche', { p_label: label });
    if (data?.ok) {
      setCustomNiches(prev => prev.some(n => n.key === data.key) ? prev : [...prev, { key: data.key, label: data.label }]);
      setNewMaterial(m => ({ ...m, niche: data.key }));
      setNewNicheLabel(''); setShowNewNiche(false);
    } else alert('Erro ao criar nicho.');
  };

  const saveMaterialEdit = async () => {
    if (!editingMaterial) return;
    const { data } = await supabase.rpc('update_material', { p_id: editingMaterial.id, p: {
      title: editingMaterial.title, niche: editingMaterial.niche, level_tag: editingMaterial.level_tag, type: editingMaterial.type,
    }});
    if (data?.ok) {
      setMaterials(prev => prev.map(m => m.id === editingMaterial.id ? { ...m, ...editingMaterial } : m));
      setEditingMaterial(null);
    } else alert('Erro ao salvar edição.');
  };

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

      // Visível: escopo correto E (aprovado OU é do próprio usuário, p/ ele acompanhar o status).
      // Pendentes/reprovados de OUTROS não aparecem no banco.
      const visibleMaterials = data?.filter(m => {
        const mine = m.uploaded_by === user.id;
        const approved = (m.approval_status || 'APPROVED') === 'APPROVED';
        const scopeOk = m.scope === 'GLOBAL' ||
          String(m.tenant_id) === String(targetTenant) ||
          (m.scope === 'PRIVATE' && mine);
        return scopeOk && (approved || mine);
      }) || [];

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
      // Material do professor entra como PENDENTE de aprovação do diretor; admin já entra aprovado
      const approvalStatus = isTeacher ? 'PENDING' : 'APPROVED';

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
        scope: scope,
        approval_status: approvalStatus,
        niche: newMaterial.niche // Add niche to payload
      }).select().single();

      if (error) {
        console.error('Database Insert Error:', error);
        throw new Error(`Erro de Banco de Dados: ${error.message} (${error.code})`);
      }

      setMaterials(prev => [data, ...prev]);
      alert(approvalStatus === 'PENDING'
        ? '✅ Material enviado para aprovação do diretor. Assim que for aprovado, entra no banco de materiais.'
        : 'Material salvo com sucesso!');
      setNewMaterial({ title: '', level: 'A1', type: 'PDF', file: null, url: '', category: 'General', niche: 'GENERAL' });
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

  const filteredMaterials = materials.filter(m => {
    if (selectedNiche === 'ALL') return true;
    // Handle cases where old materials might not have a niche or default to GENERAL
    const niche = m.niche || 'GENERAL';
    return niche === selectedNiche;
  });

  return (
    <div className="space-y-6 animate-in fade-in duration-500 h-[calc(100vh-8rem)] flex flex-col">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 shrink-0">
        <div>
          <h2 className="text-3xl font-black text-brand-text tracking-tight">Gestão Pedagógica</h2>
          <p className="text-brand-muted text-sm">Biblioteca Master e Currículo.</p>
        </div>
        <div className="flex overflow-x-auto gap-2 p-1 bg-brand-surface-2 dark:bg-brand-surface-2 rounded-xl">
          <button onClick={() => setActiveTab('allocation')} className={`shrink-0 whitespace-nowrap px-4 py-2 rounded-lg text-xs font-black uppercase tracking-widest transition-all ${activeTab === 'allocation' ? 'bg-brand-surface dark:bg-slate-700 shadow-sm text-tenant-primary dark:text-white' : 'text-brand-muted'}`}>Atribuições</button>
          <button onClick={() => setActiveTab('materials')} className={`shrink-0 whitespace-nowrap px-4 py-2 rounded-lg text-xs font-black uppercase tracking-widest transition-all ${activeTab === 'materials' ? 'bg-brand-surface dark:bg-slate-700 shadow-sm text-tenant-primary dark:text-white' : 'text-brand-muted'}`}>Biblioteca</button>
        </div>
      </div>

      {activeTab === 'allocation' && (
        <div className="flex-1 flex gap-6 overflow-hidden">
          {/* Allocation Table */}
          <div className="flex-1 bg-brand-surface border border-brand-border rounded-[2rem] flex flex-col overflow-hidden shadow-sm p-4">
            <div className="mb-4 flex gap-4">
              <input value={searchTerm} onChange={e => setSearchTerm(e.target.value)} placeholder="Buscar aluno..." className="p-2 border rounded-lg flex-1 bg-transparent" />
            </div>
            <div className="overflow-y-auto overflow-x-auto flex-1">
              <table className="w-full text-left min-w-[400px]">
                <thead className="bg-brand-surface-2 text-[10px] uppercase font-black text-brand-muted">
                  <tr><th className="p-3">Aluno</th><th className="p-3">Módulo</th><th className="p-3">Progresso</th><th className="p-3 text-right">Ações</th></tr>
                </thead>
                <tbody>
                  {filteredStudents.map(s => (
                    <tr key={s.id} className="border-b border-brand-border hover:bg-brand-surface-2 dark:hover:bg-brand-surface-2/50 transition-colors group">
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
          {canUpload && (
            <div className="bg-brand-surface border border-brand-border rounded-[2.5rem] p-8 h-fit">
              <h3 className="text-xl font-black mb-2 flex items-center gap-2"><Upload size={20} className="text-tenant-primary" /> Novo Material</h3>
              {isTeacher && <p className="text-[11px] text-amber-600 mb-4">📋 Seu material vai para aprovação do diretor antes de entrar no banco.</p>}
              <div className="space-y-4">
                <input value={newMaterial.title} onChange={e => setNewMaterial({ ...newMaterial, title: e.target.value })} className="w-full p-3 bg-brand-surface-2 rounded-xl text-sm font-bold outline-none" placeholder="Título" />
                <div className="flex gap-2">
                  <select value={newMaterial.type} onChange={e => setNewMaterial({ ...newMaterial, type: e.target.value as any })} className="flex-1 p-2 bg-brand-surface-2 rounded-xl text-xs font-bold">
                    <option value="PDF">PDF</option>
                    <option value="VIDEO">Vídeo (URL)</option>
                    <option value="LINK">Link</option>
                  </select>
                  <select value={newMaterial.level} onChange={e => setNewMaterial({ ...newMaterial, level: e.target.value })} className="flex-1 p-2 bg-brand-surface-2 rounded-xl text-xs font-bold">
                    {modulesList.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                {/* Nicho: predefinidos + custom + criar novo */}
                <div className="flex gap-2 items-center">
                  <select value={newMaterial.niche} onChange={e => setNewMaterial({ ...newMaterial, niche: e.target.value })} className="flex-1 p-2 bg-brand-surface-2 rounded-xl text-xs font-bold">
                    <option value="GENERAL">🌎 Geral</option>
                    <option value="MEDICINE">🏥 Medicina</option>
                    <option value="TECH">💻 Tech</option>
                    <option value="BUSINESS">💼 Business</option>
                    <option value="TRAVEL">✈️ Viagem</option>
                    <option value="KIDS">🧸 Crianças</option>
                    <option value="TOEFL_IELTS">🎓 TOEFL/IELTS</option>
                    <option value="CONVERSATION">💬 Conversação</option>
                    {customNiches.map(n => <option key={n.key} value={n.key}>{n.label}</option>)}
                  </select>
                  <button type="button" onClick={() => setShowNewNiche(s => !s)} className="px-3 py-2 bg-brand-surface-2 rounded-xl text-xs font-black text-tenant-primary" title="Criar novo nicho">+ Nicho</button>
                </div>
                {showNewNiche && (
                  <div className="flex gap-2">
                    <input value={newNicheLabel} onChange={e => setNewNicheLabel(e.target.value)} placeholder="Nome do novo nicho (ex: Jurídico)" className="flex-1 p-2 bg-brand-surface-2 rounded-xl text-xs" />
                    <button type="button" onClick={addNiche} className="px-3 py-2 bg-emerald-500 text-white rounded-xl text-xs font-black">Salvar</button>
                  </div>
                )}
                {newMaterial.type === 'PDF' ? (
                  <div className="p-4 border-2 border-dashed rounded-xl text-center"><input type="file" accept=".pdf" onChange={e => setNewMaterial({ ...newMaterial, file: e.target.files?.[0] || null })} className="hidden" id="file-up" /><label htmlFor="file-up" className="cursor-pointer text-xs font-bold text-brand-muted">{newMaterial.file ? newMaterial.file.name : 'Selecionar PDF'}</label></div>
                ) : (
                  <input value={newMaterial.url} onChange={e => setNewMaterial({ ...newMaterial, url: e.target.value })} className="w-full p-3 bg-brand-surface-2 rounded-xl text-sm" placeholder="https://..." />
                )}
                <button onClick={handleUploadMaterial} disabled={uploading} className="w-full py-3 bg-tenant-primary text-white rounded-xl font-black uppercase tracking-widest hover:scale-105 transition-all">{uploading ? 'Enviando...' : (isTeacher ? 'Enviar para aprovação' : 'Salvar Material')}</button>
              </div>
            </div>
          )}

          <div className={`${canUpload ? 'md:col-span-2' : 'md:col-span-3'} bg-brand-surface border border-brand-border rounded-[2.5rem] p-8 flex flex-col`}>
            <h3 className="text-xl font-black mb-6">Biblioteca Master</h3>
            <div className="flex-1 overflow-y-auto custom-scrollbar">
              <MaterialsLibrary
                materials={materials}
                onDelete={showSidebar ? handleDeleteMaterial : undefined}
                onEdit={showSidebar ? (m: any) => setEditingMaterial({ ...m }) : undefined}
                emptyText="Nenhum material na biblioteca ainda. Suba o primeiro no painel ao lado."
              />
            </div>
          </div>
        </div>
      )}

      {/* Modal de edição de material (diretor) */}
      {editingMaterial && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setEditingMaterial(null)}>
          <div className="bg-brand-surface rounded-3xl border border-brand-border shadow-2xl p-6 w-full max-w-md space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-black text-brand-text">Editar material</h3>
            <div>
              <label className="text-xs font-bold text-brand-muted">Título</label>
              <input value={editingMaterial.title || ''} onChange={e => setEditingMaterial({ ...editingMaterial, title: e.target.value })} className="w-full p-3 bg-brand-surface-2 rounded-xl text-sm font-bold mt-1" />
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="text-xs font-bold text-brand-muted">Nível</label>
                <select value={editingMaterial.level_tag || 'A1'} onChange={e => setEditingMaterial({ ...editingMaterial, level_tag: e.target.value })} className="w-full p-2 bg-brand-surface-2 rounded-xl text-xs font-bold mt-1">
                  {modulesList.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div className="flex-1">
                <label className="text-xs font-bold text-brand-muted">Tipo</label>
                <select value={editingMaterial.type || 'PDF'} onChange={e => setEditingMaterial({ ...editingMaterial, type: e.target.value })} className="w-full p-2 bg-brand-surface-2 rounded-xl text-xs font-bold mt-1">
                  <option value="PDF">PDF</option><option value="VIDEO">Vídeo</option><option value="LINK">Link</option>
                </select>
              </div>
            </div>
            <div>
              <label className="text-xs font-bold text-brand-muted">Nicho</label>
              <select value={editingMaterial.niche || 'GENERAL'} onChange={e => setEditingMaterial({ ...editingMaterial, niche: e.target.value })} className="w-full p-2 bg-brand-surface-2 rounded-xl text-xs font-bold mt-1">
                <option value="GENERAL">🌎 Geral</option>
                <option value="MEDICINE">🏥 Medicina</option>
                <option value="TECH">💻 Tech</option>
                <option value="BUSINESS">💼 Business</option>
                <option value="TRAVEL">✈️ Viagem</option>
                <option value="KIDS">🧸 Crianças</option>
                <option value="TOEFL_IELTS">🎓 TOEFL/IELTS</option>
                <option value="CONVERSATION">💬 Conversação</option>
                {customNiches.map(n => <option key={n.key} value={n.key}>{n.label}</option>)}
              </select>
            </div>
            <div className="flex gap-2 pt-2">
              <button onClick={() => setEditingMaterial(null)} className="flex-1 py-2.5 rounded-xl border border-brand-border text-brand-muted text-sm font-bold">Cancelar</button>
              <button onClick={saveMaterialEdit} className="flex-1 py-2.5 rounded-xl bg-tenant-primary text-white text-sm font-bold">Salvar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PedagogicalConfig;
