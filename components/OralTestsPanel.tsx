import React, { useEffect, useMemo, useState } from 'react';
import { Mic, CalendarClock, CheckCircle, RefreshCw, Star, AlertCircle, GraduationCap, ShieldCheck, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { UserRole } from '../types';

// PAINEL DE TESTES ORAIS
// Regra: todo aluno precisa de um teste oral obrigatório a cada ~45 dias, aplicado por um
// PROFESSOR APTO (can_oral_test) ou pela DIRETORIA — NUNCA pelo professor do próprio aluno.
// Não é pago à parte: o professor apto aplica no próprio horário já agendado e lança a aula
// normalmente (fluxo padrão). Este painel só rastreia o checkpoint (pendente → agendado → feito).
//
// Detecção/aviso rodam no backend (edge oral-test-scan + cron). Aqui o admin gerencia aptidão,
// agenda e conclui; o professor apto vê e conclui os testes atribuídos a ele.

interface OralTestsPanelProps {
  user: { id: string; role: UserRole };
  tenantId?: string;
}

interface OralTest {
  id: string;
  student_id: string;
  native_teacher_id: string | null;
  examiner_id: string | null;
  status: 'DUE' | 'SCHEDULED' | 'DONE' | 'SKIPPED';
  cycle_start: string;
  due_date: string;
  scheduled_at: string | null;
  score: number | null;
  result: string | null;
  notes: string | null;
  done_at: string | null;
}

interface TeacherRow { id: string; full_name: string; can_oral_test: boolean; }

const brandCard = 'bg-brand-surface border border-brand-border rounded-2xl shadow-sm';

const OralTestsPanel: React.FC<OralTestsPanelProps> = ({ user, tenantId }) => {
  const isAdmin = user.role === UserRole.SCHOOL_ADMIN || user.role === UserRole.SUPER_ADMIN;
  const [loading, setLoading] = useState(true);
  const [tests, setTests] = useState<OralTest[]>([]);
  const [teachers, setTeachers] = useState<TeacherRow[]>([]);
  const [studentNames, setStudentNames] = useState<Record<string, string>>({});
  const [scheduling, setScheduling] = useState<OralTest | null>(null);
  const [finishing, setFinishing] = useState<OralTest | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const teacherName = (id: string | null) => id ? (teachers.find(t => t.id === id)?.full_name || '—') : '—';
  const aptTeachers = useMemo(() => teachers.filter(t => t.can_oral_test), [teachers]);

  const load = async () => {
    if (!tenantId) return;
    setLoading(true);
    try {
      // Professores (para aptidão e para nomear examinadores)
      const { data: profs } = await supabase.from('profiles')
        .select('id, full_name, can_oral_test')
        .eq('tenant_id', tenantId).eq('role', 'TEACHER').order('full_name');
      setTeachers((profs || []) as TeacherRow[]);

      // Testes
      let q = supabase.from('oral_tests').select('*').eq('tenant_id', tenantId);
      if (!isAdmin) q = q.eq('examiner_id', user.id); // professor vê só os seus
      const { data: ot } = await q.order('due_date', { ascending: true });
      const list = (ot || []) as OralTest[];
      setTests(list);

      // Nomes dos alunos
      const studentIds = [...new Set(list.map(t => t.student_id))];
      if (studentIds.length) {
        const { data: studs } = await supabase.from('profiles').select('id, full_name').in('id', studentIds);
        const map: Record<string, string> = {};
        (studs || []).forEach((s: any) => { map[s.id] = (s.full_name || 'Aluno').trim(); });
        setStudentNames(map);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tenantId]);

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 3000); };

  const runDetection = async () => {
    if (!tenantId) return;
    setLoading(true);
    await supabase.rpc('detect_due_oral_tests', { p_tenant: tenantId });
    await load();
    flash('Lista atualizada.');
  };

  const toggleApt = async (t: TeacherRow) => {
    const next = !t.can_oral_test;
    setTeachers(prev => prev.map(x => x.id === t.id ? { ...x, can_oral_test: next } : x));
    const { error } = await supabase.from('profiles').update({ can_oral_test: next }).eq('id', t.id);
    if (error) { flash('Erro ao salvar aptidão.'); setTeachers(prev => prev.map(x => x.id === t.id ? { ...x, can_oral_test: !next } : x)); }
    else flash(next ? `${t.full_name.split(' ')[0]} agora aplica teste oral.` : `${t.full_name.split(' ')[0]} não aplica mais.`);
  };

  const pending = tests.filter(t => t.status === 'DUE' || t.status === 'SCHEDULED');
  const done = tests.filter(t => t.status === 'DONE').slice(0, 30);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-tenant-primary/10 text-tenant-primary flex items-center justify-center"><Mic size={22} /></div>
          <div>
            <h1 className="text-xl font-black text-brand-text">Testes Orais</h1>
            <p className="text-sm text-brand-muted">Checkpoint obrigatório a cada ~45 dias — aplicado por professor apto ou pela diretoria, nunca pelo professor do próprio aluno.</p>
          </div>
        </div>
        {isAdmin && (
          <button onClick={runDetection} className="flex items-center gap-2 px-4 py-2 rounded-xl bg-tenant-primary text-white text-sm font-bold hover:opacity-90">
            <RefreshCw size={16} /> Atualizar pendências
          </button>
        )}
      </div>

      {/* Aptidão dos professores (admin) */}
      {isAdmin && (
        <div className={`${brandCard} p-5`}>
          <div className="flex items-center gap-2 mb-3"><ShieldCheck size={18} className="text-tenant-primary" /><h2 className="font-black text-brand-text">Professores aptos a aplicar</h2></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {teachers.map(t => (
              <button key={t.id} onClick={() => toggleApt(t)}
                className={`flex items-center justify-between px-3 py-2.5 rounded-xl border text-sm transition ${t.can_oral_test ? 'border-tenant-primary bg-tenant-primary/10 text-brand-text font-bold' : 'border-brand-border text-brand-muted hover:border-tenant-primary/40'}`}>
                <span className="truncate">{t.full_name}</span>
                <span className={`ml-2 shrink-0 w-9 h-5 rounded-full flex items-center px-0.5 transition ${t.can_oral_test ? 'bg-tenant-primary justify-end' : 'bg-gray-300 dark:bg-gray-600 justify-start'}`}>
                  <span className="w-4 h-4 rounded-full bg-white" />
                </span>
              </button>
            ))}
            {teachers.length === 0 && <p className="text-sm text-brand-muted">Nenhum professor cadastrado.</p>}
          </div>
        </div>
      )}

      {/* Pendentes */}
      <div className={`${brandCard} p-5`}>
        <div className="flex items-center gap-2 mb-4"><AlertCircle size={18} className="text-amber-500" /><h2 className="font-black text-brand-text">Pendentes {pending.length > 0 && <span className="text-brand-muted font-medium">({pending.length})</span>}</h2></div>
        {loading ? <p className="text-sm text-brand-muted">Carregando…</p> : pending.length === 0 ? (
          <p className="text-sm text-brand-muted flex items-center gap-2"><CheckCircle size={16} className="text-green-500" /> Nenhum teste oral pendente. 🎉</p>
        ) : (
          <div className="space-y-2">
            {pending.map(t => (
              <div key={t.id} className="flex items-center justify-between gap-3 p-3 rounded-xl border border-brand-border flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <GraduationCap size={16} className="text-tenant-primary shrink-0" />
                    <span className="font-bold text-brand-text truncate">{studentNames[t.student_id] || 'Aluno'}</span>
                    {t.status === 'SCHEDULED' && <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-600">Agendado</span>}
                    {t.status === 'DUE' && <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600">No prazo</span>}
                  </div>
                  <p className="text-xs text-brand-muted mt-0.5">
                    Prof. do aluno: <b>{teacherName(t.native_teacher_id)}</b> · Vence {new Date(t.due_date).toLocaleDateString('pt-BR')}
                    {t.status === 'SCHEDULED' && t.scheduled_at && <> · Examinador: <b>{t.examiner_id ? teacherName(t.examiner_id) : 'Diretoria'}</b> em {new Date(t.scheduled_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</>}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {isAdmin && <button onClick={() => setScheduling(t)} className="px-3 py-1.5 rounded-lg text-xs font-bold border border-tenant-primary text-tenant-primary hover:bg-tenant-primary/10 flex items-center gap-1"><CalendarClock size={14} /> {t.status === 'SCHEDULED' ? 'Reagendar' : 'Agendar'}</button>}
                  {(isAdmin || t.examiner_id === user.id) && <button onClick={() => setFinishing(t)} className="px-3 py-1.5 rounded-lg text-xs font-bold bg-green-600 text-white hover:bg-green-700 flex items-center gap-1"><CheckCircle size={14} /> Concluir</button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Concluídos */}
      {done.length > 0 && (
        <div className={`${brandCard} p-5`}>
          <div className="flex items-center gap-2 mb-4"><CheckCircle size={18} className="text-green-500" /><h2 className="font-black text-brand-text">Concluídos recentemente</h2></div>
          <div className="space-y-2">
            {done.map(t => (
              <div key={t.id} className="flex items-center justify-between gap-3 p-3 rounded-xl border border-brand-border text-sm flex-wrap">
                <span className="font-bold text-brand-text truncate">{studentNames[t.student_id] || 'Aluno'}</span>
                <div className="flex items-center gap-3 text-xs text-brand-muted">
                  {typeof t.score === 'number' && <span className="flex items-center gap-1 text-amber-500 font-bold"><Star size={13} /> {t.score}/10</span>}
                  <span>Examinador: {t.examiner_id ? teacherName(t.examiner_id) : 'Diretoria'}</span>
                  <span>{t.done_at ? new Date(t.done_at).toLocaleDateString('pt-BR') : ''}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {scheduling && <ScheduleModal test={scheduling} aptTeachers={aptTeachers} onClose={() => setScheduling(null)} onSaved={() => { setScheduling(null); load(); flash('Teste oral agendado.'); }} />}
      {finishing && <FinishModal test={finishing} onClose={() => setFinishing(null)} onSaved={() => { setFinishing(null); load(); flash('Teste oral concluído. Lance a aula normalmente pelo seu horário.'); }} />}

      {toast && <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] px-4 py-2.5 rounded-xl bg-brand-text text-brand-surface text-sm font-bold shadow-lg">{toast}</div>}
    </div>
  );
};

// ---- Modal: Agendar ----
const ScheduleModal: React.FC<{ test: OralTest; aptTeachers: TeacherRow[]; onClose: () => void; onSaved: () => void; }> = ({ test, aptTeachers, onClose, onSaved }) => {
  // Exclui o professor do próprio aluno da lista de examinadores.
  const options = aptTeachers.filter(t => t.id !== test.native_teacher_id);
  const [examiner, setExaminer] = useState<string>('DIRETORIA');
  const [when, setWhen] = useState<string>('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    const payload: any = {
      examiner_id: examiner === 'DIRETORIA' ? null : examiner,
      scheduled_at: when ? new Date(when).toISOString() : null,
      status: 'SCHEDULED',
    };
    const { error } = await supabase.from('oral_tests').update(payload).eq('id', test.id);
    setSaving(false);
    if (error) { alert('Erro ao agendar: ' + error.message); return; }
    onSaved();
  };

  return (
    <ModalShell title="Agendar teste oral" onClose={onClose}>
      <p className="text-xs text-brand-muted mb-3">O examinador não pode ser o professor do próprio aluno.</p>
      <label className="block text-xs font-bold text-brand-muted mb-1">Examinador</label>
      <select value={examiner} onChange={e => setExaminer(e.target.value)} className="w-full mb-3 px-3 py-2.5 rounded-xl border border-brand-border bg-brand-surface text-brand-text text-sm">
        <option value="DIRETORIA">Diretoria (não pago)</option>
        {options.map(t => <option key={t.id} value={t.id}>{t.full_name} (professor apto)</option>)}
      </select>
      {options.length === 0 && <p className="text-xs text-amber-600 mb-3">Nenhum professor apto disponível (além do professor do aluno). Marque aptos ou use a Diretoria.</p>}
      <label className="block text-xs font-bold text-brand-muted mb-1">Data e hora</label>
      <input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} className="w-full mb-4 px-3 py-2.5 rounded-xl border border-brand-border bg-brand-surface text-brand-text text-sm" />
      <button disabled={saving} onClick={save} className="w-full py-2.5 rounded-xl bg-tenant-primary text-white font-bold text-sm disabled:opacity-50">{saving ? 'Salvando…' : 'Agendar'}</button>
    </ModalShell>
  );
};

// ---- Modal: Concluir ----
const FinishModal: React.FC<{ test: OralTest; onClose: () => void; onSaved: () => void; }> = ({ test, onClose, onSaved }) => {
  const [score, setScore] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    const payload: any = {
      status: 'DONE',
      done_at: new Date().toISOString(),
      score: score === '' ? null : Math.max(0, Math.min(10, parseInt(score, 10) || 0)),
      notes: notes || null,
    };
    const { error } = await supabase.from('oral_tests').update(payload).eq('id', test.id);
    setSaving(false);
    if (error) { alert('Erro ao concluir: ' + error.message); return; }
    onSaved();
  };

  return (
    <ModalShell title="Concluir teste oral" onClose={onClose}>
      <p className="text-xs text-brand-muted mb-3">O aluno consegue se apresentar em inglês? Registre a nota e observações. <b>Lembre-se de lançar a aula normalmente pelo seu horário</b> — o pagamento é o padrão da aula.</p>
      <label className="block text-xs font-bold text-brand-muted mb-1">Nota (0–10)</label>
      <input type="number" min={0} max={10} value={score} onChange={e => setScore(e.target.value)} className="w-full mb-3 px-3 py-2.5 rounded-xl border border-brand-border bg-brand-surface text-brand-text text-sm" placeholder="Ex.: 7" />
      <label className="block text-xs font-bold text-brand-muted mb-1">Observações</label>
      <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} className="w-full mb-4 px-3 py-2.5 rounded-xl border border-brand-border bg-brand-surface text-brand-text text-sm" placeholder="Como o aluno se saiu, pontos fortes/fracos…" />
      <button disabled={saving} onClick={save} className="w-full py-2.5 rounded-xl bg-green-600 text-white font-bold text-sm disabled:opacity-50">{saving ? 'Salvando…' : 'Marcar como concluído'}</button>
    </ModalShell>
  );
};

const ModalShell: React.FC<{ title: string; onClose: () => void; children: React.ReactNode; }> = ({ title, onClose, children }) => (
  <div className="fixed inset-0 z-[150] bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
    <div className="bg-brand-surface rounded-2xl shadow-2xl w-full max-w-md max-h-[90dvh] overflow-y-auto p-5" onClick={e => e.stopPropagation()}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-black text-brand-text">{title}</h3>
        <button onClick={onClose} className="text-brand-muted hover:text-brand-text"><X size={20} /></button>
      </div>
      {children}
    </div>
  </div>
);

export default OralTestsPanel;
