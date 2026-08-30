import React, { useState } from 'react';
import { X, CalendarOff, Search, Send, Zap, CheckCircle, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { normalizeWeekdayToIndex } from '../lib/weekday';

// Fase 2 — Substituição temporária: a coordenação registra a ausência de um professor,
// o sistema lista as aulas do período e sugere substitutos (slots livres, já filtrados
// por ciclo de vida). A confirmação vai por link de WhatsApp (handshake) ou é forçada.
// Backend: edge function coverage-admin + accept-coverage.

interface AffectedClass {
  bookingId: string;
  studentId: string;
  studentName: string;
  classDate: string;
  classTime: string;
  dow: number;
}
interface Candidate {
  teacher_id: string;
  teacher_name: string;
  teacher_phone?: string;
}
interface Props {
  teacher: { id: string; name: string };
  onClose: () => void;
}

const AbsenceCoverageManager: React.FC<Props> = ({ teacher, onClose }) => {
  const today = new Date().toISOString().split('T')[0];
  const [startsAt, setStartsAt] = useState(today);
  const [endsAt, setEndsAt] = useState(today);
  const [reason, setReason] = useState('');
  const [loadingClasses, setLoadingClasses] = useState(false);
  const [absenceId, setAbsenceId] = useState<string | null>(null);
  const [classes, setClasses] = useState<AffectedClass[]>([]);
  const [candidatesByKey, setCandidatesByKey] = useState<Record<string, Candidate[]>>({});
  const [searchingKey, setSearchingKey] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Record<string, string>>({}); // key -> coverTeacherId
  const [mode, setMode] = useState<'request' | 'force'>('request');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<number | null>(null);

  const getFunctionErrorMessage = (error: unknown, data: any) => {
    if (data?.error && typeof data.error === 'string') return data.error;
    if (typeof error === 'string') return error;
    if (!error) return null;
    if (typeof (error as any).message === 'string') return (error as any).message;
    if (typeof (error as any).context?.body === 'string') {
      try {
        const parsed = JSON.parse((error as any).context.body);
        if (parsed?.error && typeof parsed.error === 'string') return parsed.error;
        return JSON.stringify(parsed);
      } catch {
        return (error as any).context.body;
      }
    }
    if (typeof (error as any).status === 'number') {
      return `HTTP ${(error as any).status}`;
    }
    return 'falha';
  };

  const localDateKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const getCallerTenantId = async () => {
    const { data: sessionData } = await supabase.auth.getSession();
    const callerId = sessionData?.session?.user?.id;
    if (!callerId) return null;
    const { data: callerProfile } = await supabase
      .from('profiles')
      .select('tenant_id')
      .eq('id', callerId)
      .maybeSingle();
    return callerProfile?.tenant_id || null;
  };

  const resolveTenantId = async () => {
    const { data: teacherProfile } = await supabase
      .from('profiles')
      .select('tenant_id')
      .eq('id', teacher.id)
      .maybeSingle();
    return teacherProfile?.tenant_id || (await getCallerTenantId());
  };

  const createLocalAbsence = async () => {
    const tenantId = await resolveTenantId();
    const { data: absence, error } = await supabase
      .from('teacher_absences')
      .insert({
        teacher_id: teacher.id,
        tenant_id: tenantId,
        starts_at: startsAt,
        ends_at: endsAt,
        reason: reason || null,
        status: 'active',
      })
      .select()
      .single();
    if (error) throw error;
    return absence as any;
  };

  const buildFallbackClasses = async () => {
    const tenantId = await resolveTenantId();
    const start = new Date(`${startsAt}T00:00:00`);
    const end = new Date(`${endsAt}T00:00:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new Error('Período inválido.');
    }
    if (end < start) {
      throw new Error('Data de fim inválida.');
    }

    let bookingQuery = supabase
      .from('bookings')
      .select('id, student_id, day_of_week, time_slot, student:student_id(full_name)')
      .eq('teacher_id', teacher.id)
      .neq('status', 'CANCELLED');
    if (tenantId) bookingQuery = bookingQuery.eq('tenant_id', tenantId);
    const { data: bookings, error: bookingsError } = await bookingQuery;
    if (bookingsError) throw bookingsError;

    const classes: AffectedClass[] = [];
    for (const b of bookings || []) {
      const dIndex = normalizeWeekdayToIndex((b as any).day_of_week);
      if (dIndex < 0) continue;
      const student = Array.isArray((b as any).student) ? (b as any).student[0] : (b as any).student;
      for (let cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
        if (cursor.getDay() !== dIndex) continue;
        classes.push({
          bookingId: (b as any).id,
          studentId: (b as any).student_id,
          studentName: student?.full_name || 'Aluno',
          classDate: localDateKey(cursor),
          classTime: (b as any).time_slot || '',
          dow: dIndex,
        });
      }
    }

    return classes.sort((a, b) => (a.classDate + a.classTime).localeCompare(b.classDate + b.classTime));
  };

  const keyOf = (c: AffectedClass) => `${c.bookingId}_${c.classDate}`;

  const listClasses = async () => {
    setError(''); setLoadingClasses(true); setClasses([]); setAbsenceId(null);
    try {
      const { data, error } = await supabase.functions.invoke('coverage-admin', {
        body: { action: 'createAbsence', teacherId: teacher.id, startsAt, endsAt, reason: reason || null },
      });
      if (error || !data?.ok) throw new Error(getFunctionErrorMessage(error, data) || 'falha');
      setAbsenceId(data.absence.id);
      setClasses(data.classes || []);
      if (!data.classes?.length) setError('Nenhuma aula recorrente encontrada nesse período.');
    } catch (e: any) {
      try {
        const fallbackClasses = await buildFallbackClasses();
        const fallbackAbsence = await createLocalAbsence();
        setAbsenceId(fallbackAbsence.id);
        setClasses(fallbackClasses);
        if (!fallbackClasses.length) setError('Nenhuma aula recorrente encontrada nesse período.');
      } catch (localErr: any) {
        setError('Erro ao listar aulas: ' + (localErr.message || 'tente novamente.'));
      }
    } finally {
      setLoadingClasses(false);
    }
  };

  const searchSubs = async (c: AffectedClass) => {
    const key = keyOf(c);
    setSearchingKey(key);
    try {
      // `date` é o que permite à busca descartar quem já tem aula avulsa ou
      // reposição naquele dia — sem ela, só a agenda fixa é checada e o
      // "substituto livre" pode estar ocupado. `excludeTeacherId` tira o próprio
      // ausente no servidor (antes era filtrado só na tela).
      const { data } = await supabase.functions.invoke('search-slots', {
        body: { day: c.dow, time: c.classTime, date: c.classDate, excludeTeacherId: teacher.id },
      });
      if (data?.error) {
        setError(`Busca de substitutos falhou: ${data.error}`);
        setCandidatesByKey(prev => ({ ...prev, [key]: [] }));
        return;
      }
      const cands: Candidate[] = (data?.slots || []).filter((s: Candidate) => s.teacher_id !== teacher.id);
      setCandidatesByKey(prev => ({ ...prev, [key]: cands }));
    } catch {
      setCandidatesByKey(prev => ({ ...prev, [key]: [] }));
    } finally {
      setSearchingKey(null);
    }
  };

  const submit = async () => {
    const items = classes
      .filter(c => chosen[keyOf(c)])
      .map(c => ({
        bookingId: c.bookingId, studentId: c.studentId, classDate: c.classDate,
        classTime: c.classTime, studentName: c.studentName, coverTeacherId: chosen[keyOf(c)],
      }));
    if (!items.length) { setError('Escolha pelo menos um substituto.'); return; }
    setSending(true); setError('');
    try {
      const { data, error } = await supabase.functions.invoke('coverage-admin', {
        body: { action: 'requestCoverage', absenceId, mode, items },
      });
      if (error || !data?.ok) throw new Error(getFunctionErrorMessage(error, data) || 'falha');
      setDone((data.results || []).filter((r: any) => r.coverage).length);
    } catch (e: any) {
      setError('Erro ao enviar coberturas: ' + (e.message || 'tente novamente.'));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-brand-surface rounded-3xl w-full max-w-2xl border border-brand-border shadow-2xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-brand-border">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-50 dark:bg-amber-900/20 flex items-center justify-center">
              <CalendarOff size={18} className="text-amber-500" />
            </div>
            <div>
              <h2 className="font-black text-brand-text dark:text-slate-100">Ausência & Cobertura</h2>
              <p className="text-xs text-brand-muted">{teacher.name}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-brand-surface-2 rounded-full text-brand-muted"><X size={18} /></button>
        </div>

        <div className="p-5 overflow-y-auto">
          {done !== null ? (
            <div className="text-center py-8">
              <CheckCircle size={48} className="text-emerald-500 mx-auto mb-3" />
              <h3 className="font-black text-lg text-brand-text dark:text-slate-100">{done} cobertura(s) {mode === 'force' ? 'aplicada(s)' : 'enviada(s)'}</h3>
              <p className="text-sm text-brand-muted mt-1">
                {mode === 'force'
                  ? 'Os substitutos foram escalados. As aulas já aparecem na agenda deles.'
                  : 'Os substitutos receberam o link de confirmação por WhatsApp. A aula só muda quando aceitarem.'}
              </p>
              <button onClick={onClose} className="mt-6 px-6 py-3 rounded-2xl bg-tenant-primary text-white text-xs font-black uppercase">Fechar</button>
            </div>
          ) : (
            <>
              {/* Período da ausência */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-brand-muted ml-1">Início</label>
                  <input type="date" value={startsAt} min={today} onChange={e => setStartsAt(e.target.value)}
                    className="w-full mt-1 px-3 py-2.5 rounded-xl border border-brand-border bg-brand-surface-2 text-sm text-brand-text" />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-brand-muted ml-1">Fim</label>
                  <input type="date" value={endsAt} min={startsAt} onChange={e => setEndsAt(e.target.value)}
                    className="w-full mt-1 px-3 py-2.5 rounded-xl border border-brand-border bg-brand-surface-2 text-sm text-brand-text" />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase tracking-widest text-brand-muted ml-1">Motivo</label>
                  <input type="text" value={reason} onChange={e => setReason(e.target.value)} placeholder="Saúde, etc."
                    className="w-full mt-1 px-3 py-2.5 rounded-xl border border-brand-border bg-brand-surface-2 text-sm text-brand-text" />
                </div>
              </div>
              <button onClick={listClasses} disabled={loadingClasses}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl bg-tenant-primary/10 text-tenant-primary text-xs font-black uppercase hover:bg-tenant-primary hover:text-white transition-colors mb-4">
                {loadingClasses ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />} Listar aulas do período
              </button>

              {/* Aulas afetadas */}
              {classes.length > 0 && (
                <div className="space-y-2 mb-4">
                  {classes.map(c => {
                    const key = keyOf(c);
                    const cands = candidatesByKey[key];
                    return (
                      <div key={key} className="border border-brand-border rounded-2xl p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-sm">
                            <span className="font-black text-brand-text dark:text-slate-200">
                              {new Date(c.classDate + 'T00:00:00').toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' })}
                            </span>
                            <span className="text-brand-muted"> · {c.classTime} · {c.studentName}</span>
                          </div>
                          <button onClick={() => searchSubs(c)} disabled={searchingKey === key}
                            className="shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-lg border border-brand-border text-[10px] font-black uppercase text-brand-muted hover:bg-brand-surface-2">
                            {searchingKey === key ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />} Substitutos
                          </button>
                        </div>
                        {cands && (
                          cands.length > 0 ? (
                            <select value={chosen[key] || ''} onChange={e => setChosen(prev => ({ ...prev, [key]: e.target.value }))}
                              className="w-full mt-2 px-3 py-2 rounded-xl border border-brand-border bg-brand-surface-2 text-sm text-brand-text">
                              <option value="">— escolher substituto livre —</option>
                              {cands.map(t => <option key={t.teacher_id} value={t.teacher_id}>{t.teacher_name}</option>)}
                            </select>
                          ) : (
                            <p className="mt-2 text-xs text-amber-500 font-bold">Nenhum professor livre nesse horário.</p>
                          )
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Modo + enviar */}
              {classes.length > 0 && (
                <>
                  <div className="flex gap-2 mb-3">
                    <button onClick={() => setMode('request')}
                      className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-[10px] font-black uppercase border transition-colors ${mode === 'request' ? 'bg-tenant-primary text-white border-tenant-primary' : 'border-brand-border text-brand-muted'}`}>
                      <Send size={12} /> Confirmar por WhatsApp
                    </button>
                    <button onClick={() => setMode('force')}
                      className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-[10px] font-black uppercase border transition-colors ${mode === 'force' ? 'bg-red-500 text-white border-red-500' : 'border-brand-border text-brand-muted'}`}>
                      <Zap size={12} /> Forçar (urgência)
                    </button>
                  </div>
                  <button onClick={submit} disabled={sending}
                    className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl bg-tenant-primary text-white text-xs font-black uppercase hover:opacity-90 transition-opacity">
                    {sending ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
                    {mode === 'force' ? 'Escalar substitutos agora' : 'Enviar pedidos de cobertura'}
                  </button>
                  <p className="text-[11px] text-brand-muted text-center mt-2">
                    {mode === 'force'
                      ? 'A aula é movida na hora para o substituto, sem esperar confirmação (fica registrado como forçado).'
                      : 'O substituto recebe um link no WhatsApp; a aula só muda quando ele aceitar.'}
                  </p>
                </>
              )}

              {error && <p className="text-red-500 text-sm font-bold text-center mt-3">{error}</p>}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default AbsenceCoverageManager;
