import React, { useState, useEffect } from 'react';
import { Search, RefreshCw, Upload, FileText, Trash2, Users, ChevronRight, BookOpen } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { User, UserRole } from '../types';
import confetti from 'canvas-confetti';
import { PEDAGOGICAL_BOOKS, PROFILE_SAFE_COLS } from '../constants';
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
  const [newMaterial, setNewMaterial] = useState({ title: '', level: 'A1', type: 'PDF', file: null as File | null, url: '', category: 'General', niche: 'GENERAL', collection_id: '' as string, part_number: '' as string });
  // Catálogo de nichos da escola (base + customizados) — fonte única via list_niches.
  const [niches, setNiches] = useState<{ key: string; label: string }[]>([]);
  const [newNicheLabel, setNewNicheLabel] = useState('');
  const [showNewNiche, setShowNewNiche] = useState(false);
  const [editingMaterial, setEditingMaterial] = useState<any | null>(null);
  // Livros / coleções (agrupam partes de um material fracionado)
  const [collections, setCollections] = useState<any[]>([]);
  const [showNewCollection, setShowNewCollection] = useState(false);
  const [newCollection, setNewCollection] = useState({ title: '', niche: 'GENERAL', level: 'A1' });
  const [editingCollection, setEditingCollection] = useState<any | null>(null);

  // Fallback caso a escola ainda não tenha nichos no catálogo (escolas novas).
  const BASE_NICHES = [
    { key: 'GENERAL', label: '🌎 Geral' }, { key: 'MEDICINE', label: '🏥 Medicina' },
    { key: 'TECH', label: '💻 Tech' }, { key: 'BUSINESS', label: '💼 Business' },
    { key: 'TRAVEL', label: '✈️ Viagem' },
  ];
  const nicheOptions = niches.length ? niches : BASE_NICHES;
  const nicheLabelMap = Object.fromEntries(nicheOptions.map(n => [n.key, n.label]));

  const isTeacher = user.role === UserRole.TEACHER;
  const canUpload = isTeacher || user.role === UserRole.SCHOOL_ADMIN || user.role === UserRole.SUPER_ADMIN;

  // Carrega catálogo de nichos (base + customizados) e livros da escola
  const loadNiches = () => supabase.rpc('list_niches').then(({ data }) => { if (Array.isArray(data)) setNiches(data); });
  const loadCollections = async () => {
    const { data } = await supabase.from('pedagogical_collections').select('*').order('title');
    if (Array.isArray(data)) setCollections(data);
  };
  useEffect(() => { loadNiches(); loadCollections(); }, [tenantId]);

  const addNiche = async () => {
    const label = newNicheLabel.trim();
    if (label.length < 2) return;
    const { data } = await supabase.rpc('upsert_niche', { p_label: label });
    if (data?.ok) {
      setNiches(prev => prev.some(n => n.key === data.key) ? prev : [...prev, { key: data.key, label: data.label }]);
      setNewMaterial(m => ({ ...m, niche: data.key }));
      setNewNicheLabel(''); setShowNewNiche(false);
    } else alert('Erro ao criar nicho.');
  };

  // Cria um livro (coleção) que agrupará as partes do material fracionado
  const addCollection = async () => {
    if (newCollection.title.trim().length < 2) return alert('Dê um nome ao livro.');
    const { data } = await supabase.rpc('upsert_collection', {
      p_id: null, p_title: newCollection.title.trim(), p_niche: newCollection.niche, p_level: newCollection.level, p_cover: null,
    });
    if (data?.ok) {
      await loadCollections();
      // já seleciona o livro recém-criado no formulário de material
      setNewMaterial(m => ({ ...m, collection_id: data.id, niche: newCollection.niche, level: newCollection.level }));
      setNewCollection({ title: '', niche: 'GENERAL', level: 'A1' });
      setShowNewCollection(false);
    } else alert('Erro ao criar livro.');
  };

  const saveCollectionEdit = async () => {
    if (!editingCollection) return;
    const { data } = await supabase.rpc('upsert_collection', {
      p_id: editingCollection.id, p_title: editingCollection.title,
      p_niche: editingCollection.niche, p_level: editingCollection.level_tag, p_cover: editingCollection.cover_url || null,
    });
    if (data?.ok) { await loadCollections(); setEditingCollection(null); }
    else alert('Erro ao salvar livro.');
  };

  const handleDeleteCollection = async (id: string) => {
    if (!confirm('Excluir este livro? As partes não são apagadas — voltam a ser materiais avulsos.')) return;
    const { data } = await supabase.rpc('delete_collection', { p_id: id });
    if (data?.ok) { await loadCollections(); fetchMaterials(); }
    else alert('Erro ao excluir livro.');
  };

  const saveMaterialEdit = async () => {
    if (!editingMaterial) return;
    const { data } = await supabase.rpc('update_material', { p_id: editingMaterial.id, p: {
      title: editingMaterial.title, niche: editingMaterial.niche, level_tag: editingMaterial.level_tag, type: editingMaterial.type,
    }});
    if (!data?.ok) return alert('Erro ao salvar edição.');
    // Vínculo com livro/parte (campo separado, via RPC própria)
    const partNum = editingMaterial.part_number !== '' && editingMaterial.part_number != null ? Number(editingMaterial.part_number) : null;
    await supabase.rpc('set_material_collection', {
      p_material_id: editingMaterial.id,
      p_collection_id: editingMaterial.collection_id || null,
      p_part_number: partNum,
    });
    setMaterials(prev => prev.map(m => m.id === editingMaterial.id ? { ...m, ...editingMaterial, part_number: partNum, collection_id: editingMaterial.collection_id || null } : m));
    setEditingMaterial(null);
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
        .select(PROFILE_SAFE_COLS)
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

      // Auto-recuperação: se uma publicação anterior falhou por indisponibilidade
      // temporária, a própria tela administrativa tenta novamente sem duplicar itens.
      const recoverableIds = visibleMaterials
        .filter(m => {
          const syncPending = ['PENDING', 'FAILED'].includes(m.hub_sync_status);
          const sameTenant = String(m.tenant_id) === String(targetTenant);
          const canRetry = user.role === UserRole.SUPER_ADMIN ||
            (sameTenant && (user.role === UserRole.SCHOOL_ADMIN || m.uploaded_by === user.id));
          return (m.approval_status || 'APPROVED') === 'APPROVED' && syncPending && canRetry;
        })
        .slice(0, 10)
        .map(m => m.id);
      if (recoverableIds.length > 0) {
        void supabase.functions.invoke('sync-hub-material', {
          body: { materialIds: recoverableIds },
        }).then(({ error: syncError }) => {
          if (syncError) console.warn('A recuperação automática de materiais do Hub ficará para a próxima tentativa.', syncError);
        });
      }
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
        niche: newMaterial.niche,
        collection_id: newMaterial.collection_id || null, // livro (opcional)
        part_number: newMaterial.part_number !== '' ? Number(newMaterial.part_number) : null, // ordem da parte
      }).select().single();

      if (error) {
        console.error('Database Insert Error:', error);
        throw new Error(`Erro de Banco de Dados: ${error.message} (${error.code})`);
      }

      let hubSyncPending = false;
      if (approvalStatus === 'APPROVED') {
        const { data: syncResult, error: syncError } = await supabase.functions.invoke('sync-hub-material', {
          body: { materialId: data.id },
        });
        hubSyncPending = Boolean(syncError || syncResult?.ok === false);
        if (hubSyncPending) {
          console.warn('Material salvo; sincronização com o Hub ficará pendente.', syncError || syncResult);
        }
      }

      setMaterials(prev => [data, ...prev]);
      alert(approvalStatus === 'PENDING'
        ? '✅ Material enviado para aprovação do diretor. Depois da aprovação, ele entra automaticamente na Biblioteca do Hub.'
        : hubSyncPending
          ? '✅ Material salvo. A cópia para a Biblioteca do Hub ficou na fila e poderá ser reprocessada.'
          : '✅ Material salvo e publicado na Biblioteca do Hub!');
      setNewMaterial(m => ({ title: '', level: m.level, type: 'PDF', file: null, url: '', category: 'General', niche: m.niche, collection_id: m.collection_id, part_number: m.part_number !== '' ? String(Number(m.part_number) + 1) : '' }));
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
                {/* Nicho: catálogo dinâmico (base + custom) + criar novo */}
                <div>
                  <label className="text-[10px] font-black text-brand-muted uppercase tracking-wider">Nicho</label>
                  <div className="flex gap-2 items-center mt-1">
                    <select value={newMaterial.niche} onChange={e => setNewMaterial({ ...newMaterial, niche: e.target.value })} className="flex-1 p-2 bg-brand-surface-2 rounded-xl text-xs font-bold">
                      {nicheOptions.map(n => <option key={n.key} value={n.key}>{n.label}</option>)}
                    </select>
                    <button type="button" onClick={() => setShowNewNiche(s => !s)} className="px-3 py-2 bg-brand-surface-2 rounded-xl text-xs font-black text-tenant-primary" title="Criar novo nicho">+ Nicho</button>
                  </div>
                </div>
                {showNewNiche && (
                  <div className="flex gap-2">
                    <input value={newNicheLabel} onChange={e => setNewNicheLabel(e.target.value)} placeholder="Nome do novo nicho (ex: Jurídico)" className="flex-1 p-2 bg-brand-surface-2 rounded-xl text-xs" />
                    <button type="button" onClick={addNiche} className="px-3 py-2 bg-emerald-500 text-white rounded-xl text-xs font-black">Salvar</button>
                  </div>
                )}

                {/* Livro (opcional): agrupa partes de um material fracionado */}
                <div>
                  <label className="text-[10px] font-black text-brand-muted uppercase tracking-wider">Livro (opcional — p/ material fracionado)</label>
                  <div className="flex gap-2 items-center mt-1">
                    <select value={newMaterial.collection_id} onChange={e => setNewMaterial({ ...newMaterial, collection_id: e.target.value })} className="flex-1 p-2 bg-brand-surface-2 rounded-xl text-xs font-bold">
                      <option value="">— Avulso (sem livro) —</option>
                      {collections.map(c => <option key={c.id} value={c.id}>{(nicheLabelMap[c.niche] ? nicheLabelMap[c.niche].replace(/^[^\s\w]+\s*/, '') + ' · ' : '')}{c.level_tag ? c.level_tag + ' · ' : ''}{c.title}</option>)}
                    </select>
                    <button type="button" onClick={() => setShowNewCollection(s => !s)} className="px-3 py-2 bg-brand-surface-2 rounded-xl text-xs font-black text-tenant-primary" title="Criar novo livro">+ Livro</button>
                  </div>
                  {newMaterial.collection_id && (
                    <input type="number" min={1} value={newMaterial.part_number} onChange={e => setNewMaterial({ ...newMaterial, part_number: e.target.value })} placeholder="Nº da parte (1, 2, 3...)" className="w-full mt-2 p-2 bg-brand-surface-2 rounded-xl text-xs font-bold" />
                  )}
                </div>
                {showNewCollection && (
                  <div className="p-3 bg-brand-surface-2/50 rounded-xl space-y-2 border border-brand-border">
                    <input value={newCollection.title} onChange={e => setNewCollection({ ...newCollection, title: e.target.value })} placeholder="Nome do livro (ex: English for Kids A1)" className="w-full p-2 bg-brand-surface rounded-lg text-xs" />
                    <div className="flex gap-2">
                      <select value={newCollection.niche} onChange={e => setNewCollection({ ...newCollection, niche: e.target.value })} className="flex-1 p-2 bg-brand-surface rounded-lg text-xs font-bold">
                        {nicheOptions.map(n => <option key={n.key} value={n.key}>{n.label}</option>)}
                      </select>
                      <select value={newCollection.level} onChange={e => setNewCollection({ ...newCollection, level: e.target.value })} className="flex-1 p-2 bg-brand-surface rounded-lg text-xs font-bold">
                        {modulesList.map(m => <option key={m} value={m}>{m}</option>)}
                      </select>
                    </div>
                    <button type="button" onClick={addCollection} className="w-full py-2 bg-emerald-500 text-white rounded-lg text-xs font-black">Criar livro</button>
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
                collections={collections}
                nicheLabels={nicheLabelMap}
                onDelete={showSidebar ? handleDeleteMaterial : undefined}
                onEdit={showSidebar ? (m: any) => setEditingMaterial({ ...m, collection_id: m.collection_id || '', part_number: m.part_number ?? '' }) : undefined}
                onEditCollection={showSidebar ? (c: any) => setEditingCollection({ ...c }) : undefined}
                onDeleteCollection={showSidebar ? handleDeleteCollection : undefined}
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
                {nicheOptions.map(n => <option key={n.key} value={n.key}>{n.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-bold text-brand-muted">Livro (opcional)</label>
              <select value={editingMaterial.collection_id || ''} onChange={e => setEditingMaterial({ ...editingMaterial, collection_id: e.target.value })} className="w-full p-2 bg-brand-surface-2 rounded-xl text-xs font-bold mt-1">
                <option value="">— Avulso (sem livro) —</option>
                {collections.map(c => <option key={c.id} value={c.id}>{c.level_tag ? c.level_tag + ' · ' : ''}{c.title}</option>)}
              </select>
              {editingMaterial.collection_id && (
                <input type="number" min={1} value={editingMaterial.part_number ?? ''} onChange={e => setEditingMaterial({ ...editingMaterial, part_number: e.target.value })} placeholder="Nº da parte (1, 2, 3...)" className="w-full mt-2 p-2 bg-brand-surface-2 rounded-xl text-xs font-bold" />
              )}
            </div>
            <div className="flex gap-2 pt-2">
              <button onClick={() => setEditingMaterial(null)} className="flex-1 py-2.5 rounded-xl border border-brand-border text-brand-muted text-sm font-bold">Cancelar</button>
              <button onClick={saveMaterialEdit} className="flex-1 py-2.5 rounded-xl bg-tenant-primary text-white text-sm font-bold">Salvar</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de edição de livro (diretor) */}
      {editingCollection && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setEditingCollection(null)}>
          <div className="bg-brand-surface rounded-3xl border border-brand-border shadow-2xl p-6 w-full max-w-md space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-black text-brand-text">Editar livro</h3>
            <div>
              <label className="text-xs font-bold text-brand-muted">Nome do livro</label>
              <input value={editingCollection.title || ''} onChange={e => setEditingCollection({ ...editingCollection, title: e.target.value })} className="w-full p-3 bg-brand-surface-2 rounded-xl text-sm font-bold mt-1" />
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="text-xs font-bold text-brand-muted">Nicho</label>
                <select value={editingCollection.niche || 'GENERAL'} onChange={e => setEditingCollection({ ...editingCollection, niche: e.target.value })} className="w-full p-2 bg-brand-surface-2 rounded-xl text-xs font-bold mt-1">
                  {nicheOptions.map(n => <option key={n.key} value={n.key}>{n.label}</option>)}
                </select>
              </div>
              <div className="flex-1">
                <label className="text-xs font-bold text-brand-muted">Nível</label>
                <select value={editingCollection.level_tag || 'A1'} onChange={e => setEditingCollection({ ...editingCollection, level_tag: e.target.value })} className="w-full p-2 bg-brand-surface-2 rounded-xl text-xs font-bold mt-1">
                  {modulesList.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <button onClick={() => setEditingCollection(null)} className="flex-1 py-2.5 rounded-xl border border-brand-border text-brand-muted text-sm font-bold">Cancelar</button>
              <button onClick={saveCollectionEdit} className="flex-1 py-2.5 rounded-xl bg-tenant-primary text-white text-sm font-bold">Salvar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PedagogicalConfig;
