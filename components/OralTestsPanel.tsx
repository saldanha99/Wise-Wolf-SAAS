import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [updatingTeacherId, setUpdatingTeacherId] = useState<string | null>(null);

  const teacherName = (id: string | null) => id ? (teachers.find(t => t.id === id)?.full_name || '—') : '—';
  const aptTeachers = useMemo(() => teachers.filter(t => t.can_oral_test), [teachers]);

  const load = async () => {
    if (!tenantId) {
      setLoading(false);
      setLoadError('Não foi possível identificar a escola deste usuário.');
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      // Professores (para aptidão e para nomear examinadores)
      const { data: profs, error: teachersError } = await supabase.from('profiles')
        .select('id, full_name, can_oral_test')
        .eq('tenant_id', tenantId).eq('role', 'TEACHER').order('full_name');
      if (teachersError) throw teachersError;
      setTeachers((profs || []) as TeacherRow[]);

      // Testes
      let q = supabase.from('oral_tests').select('*').eq('tenant_id', tenantId);
      if (!isAdmin) q = q.eq('examiner_id', user.id); // professor vê só os seus
      const { data: ot, error: testsError } = await q.order('due_date', { ascending: true });
      if (testsError) throw testsError;
      const list = (ot || []) as OralTest[];
      setTests(list);

      // Nomes dos alunos
      const studentIds = [...new Set(list.map(t => t.student_id))];
      if (studentIds.length) {
        const { data: studs, error: studentsError } = await supabase.from('profiles').select('id, full_name').in('id', studentIds);
        if (studentsError) throw studentsError;
        const map: Record<string, string> = {};
        (studs || []).forEach((s: any) => { map[s.id] = (s.full_name || 'Aluno').trim(); });
        setStudentNames(map);
      } else {
        setStudentNames({});
      }
    } catch (error) {
      console.error('Oral tests load error:', error);
      setLoadError('Não foi possível carregar os testes orais e professores aptos.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tenantId]);

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 3000); };

  const runDetection = async () => {
    if (!tenantId) return;
    setLoading(true);
    try {
      const { error } = await supabase.rpc('detect_due_oral_tests', { p_tenant: tenantId });
      if (error) throw error;
      await load();
      flash('Lista atualizada.');
    } catch (error) {
      console.error('Oral test detection error:', error);
      setLoading(false);
      flash('Não foi possível atualizar as pendências.');
    }
  };

  const toggleApt = async (t: TeacherRow) => {
    const next = !t.can_oral_test;
    setUpdatingTeacherId(t.id);
    setTeachers(prev => prev.map(x => x.id === t.id ? { ...x, can_oral_test: next } : x));
    try {
      const { error } = await supabase.rpc('set_teacher_oral_test_eligibility', {
        p_teacher_id: t.id,
        p_enabled: next,
      });
      if (error) throw error;
      flash(next ? `${t.full_name.split(' ')[0]} agora aplica teste oral.` : `${t.full_name.split(' ')[0]} não aplica mais.`);
    } catch (error) {
      console.error('Oral test eligibility update error:', error);
      flash('Erro ao salvar aptidão.');
      setTeachers(prev => prev.map(x => x.id === t.id ? { ...x, can_oral_test: !next } : x));
    } finally {
      setUpdatingTeacherId(null);
    }
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

      {loadError && (
        <div className="flex flex-col items-start justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200 sm:flex-row sm:items-center" role="alert">
          <div className="flex items-center gap-2 text-sm font-bold">
            <AlertCircle size={18} className="shrink-0" />
            <span>{loadError}</span>
          </div>
          <button type="button" onClick={load} className="shrink-0 rounded-xl bg-red-600 px-4 py-2 text-xs font-bold text-white hover:bg-red-700">
            Tentar novamente
          </button>
        </div>
      )}

      {/* Aptidão dos professores (admin) */}
      {isAdmin && (
        <div className={`${brandCard} p-5`}>
          <div className="flex items-center gap-2 mb-3"><ShieldCheck size={18} className="text-tenant-primary" /><h2 className="font-black text-brand-text">Professores aptos a aplicar</h2></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {teachers.map(t => (
              <button key={t.id} onClick={() => toggleApt(t)}
                type="button"
                role="switch"
                aria-checked={t.can_oral_test}
                aria-label={`${t.full_name}: ${t.can_oral_test ? 'apto' : 'não apto'} para aplicar teste oral`}
                disabled={updatingTeacherId === t.id}
                className={`flex items-center justify-between px-3 py-2.5 rounded-xl border text-sm transition ${t.can_oral_test ? 'border-tenant-primary bg-tenant-primary/10 text-brand-text font-bold' : 'border-brand-border text-brand-muted hover:border-tenant-primary/40'}`}>
                <span className="truncate">{t.full_name}</span>
                <span aria-hidden="true" className={`ml-2 shrink-0 w-9 h-5 rounded-full flex items-center px-0.5 transition ${t.can_oral_test ? 'bg-tenant-primary justify-end' : 'bg-gray-300 dark:bg-gray-600 justify-start'} ${updatingTeacherId === t.id ? 'opacity-50' : ''}`}>
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
        {loading ? <p className="text-sm text-brand-muted" role="status">Carregando…</p> : loadError ? (
          <p className="text-sm text-brand-muted">A lista ficará disponível após recarregar os dados.</p>
        ) : pending.length === 0 ? (
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

      {toast && <div role="status" aria-live="polite" className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] max-w-[calc(100vw-2rem)] px-4 py-2.5 rounded-xl bg-brand-text text-brand-surface text-sm font-bold shadow-lg">{toast}</div>}
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
    if (!when) {
      alert('Informe a data e a hora do teste.');
      return;
    }
    setSaving(true);
    const { error } = await supabase.rpc('schedule_oral_test', {
      p_test_id: test.id,
      p_examiner_id: examiner === 'DIRETORIA' ? null : examiner,
      p_scheduled_at: new Date(when).toISOString(),
    });
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
      <input type="datetime-local" required value={when} onChange={e => setWhen(e.target.value)} className="w-full mb-4 px-3 py-2.5 rounded-xl border border-brand-border bg-brand-surface text-brand-text text-sm" />
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
    const parsedScore = score === '' ? null : Number.parseInt(score, 10);
    const { error } = await supabase.rpc('complete_oral_test', {
      p_test_id: test.id,
      p_score: Number.isInteger(parsedScore) ? parsedScore : null,
      p_notes: notes.trim() || null,
    });
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

const ModalShell: React.FC<{ title: string; onClose: () => void; children: React.ReactNode; }> = ({ title, onClose, children }) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = 'hidden';

    const focusFrame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      const initialFocus = dialog?.querySelector<HTMLElement>('[data-dialog-initial-focus="true"]');
      (initialFocus || dialog)?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }

      if (event.key !== 'Tab') return;
      const focusable = (Array.from(dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )) as HTMLElement[]).filter(element => element.getAttribute('aria-hidden') !== 'true');

      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const focusIsOutside = !(document.activeElement instanceof Node) || !dialog.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || focusIsOutside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || focusIsOutside)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-[150] bg-black/50 flex items-center justify-center p-4" onClick={() => onCloseRef.current()}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="bg-brand-surface rounded-2xl shadow-2xl w-full max-w-md max-h-[90dvh] overflow-y-auto p-5"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 id={titleId} className="font-black text-brand-text">{title}</h3>
          <button
            type="button"
            onClick={() => onCloseRef.current()}
            aria-label={`Fechar ${title}`}
            data-dialog-initial-focus="true"
            className="text-brand-muted hover:text-brand-text"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
};

export default OralTestsPanel;
