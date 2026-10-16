import React, { useRef, useState } from 'react';
import { X, CalendarOff, Search, Send, Zap, CheckCircle, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { localYMD } from '../lib/dateUtils';

interface AffectedClass {
  bookingId: string;
  studentId: string;
  studentName: string;
  classDate: string;
  classTime: string;
  dow: number;
}
interface Candidate { teacher_id: string; teacher_name: string }
interface CoverageResult {
  coverage?: { booking_id: string; class_date: string };
  item?: { bookingId: string; classDate: string };
  error?: string;
  warning?: string;
}
interface Props { teacher: { id: string; name: string }; onClose: () => void }

const keyOf = (c: Pick<AffectedClass, 'bookingId' | 'classDate'>) => `${c.bookingId}_${c.classDate}`;

/** O erro HTTP da edge leva o motivo no corpo, e não em error.message. */
async function functionMessage(error: unknown, data: { error?: string } | null): Promise<string> {
  if (data?.error) return data.error;
  if (error && typeof error === 'object' && 'context' in error && error.context instanceof Response) {
    const body = await error.context.clone().json().catch(() => null);
    if (typeof body?.error === 'string') return body.error;
  }
  return error instanceof Error ? error.message : 'Tente novamente.';
}

const AbsenceCoverageManager: React.FC<Props> = ({ teacher, onClose }) => {
  const today = localYMD(new Date());
  const [startsAt, setStartsAt] = useState(today);
  const [endsAt, setEndsAt] = useState(today);
  const [reason, setReason] = useState('');
  const [loadingClasses, setLoadingClasses] = useState(false);
  const [absenceId, setAbsenceId] = useState<string | null>(null);
  const [classes, setClasses] = useState<AffectedClass[]>([]);
  const [candidatesByKey, setCandidatesByKey] = useState<Record<string, Candidate[]>>({});
  const [searchingKey, setSearchingKey] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [rates, setRates] = useState<Record<string, string>>({});
  const [canSetRate, setCanSetRate] = useState(false);
  const [mode, setMode] = useState<'request' | 'force'>('request');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<number | null>(null);
  const [doneWarnings, setDoneWarnings] = useState<string[]>([]);
  const [completedCount, setCompletedCount] = useState(0);
  const generation = useRef(0);

  const invalidate = () => {
    generation.current += 1;
    setClasses([]); setAbsenceId(null); setChosen({}); setRates({});
    setCandidatesByKey({}); setSearchingKey(null); setCanSetRate(false);
    setError(''); setDoneWarnings([]); setCompletedCount(0); setLoadingClasses(false);
  };

  const listClasses = async () => {
    invalidate();
    const current = generation.current;
    if (!startsAt || !endsAt || endsAt < startsAt) { setError('Informe um período válido.'); return; }
    setLoadingClasses(true);
    try {
      // Listar é somente leitura. Nunca remontar a agenda no navegador se a consulta falhar.
      const { data, error } = await supabase.functions.invoke('coverage-admin', {
        body: { action: 'previewAbsence', teacherId: teacher.id, startsAt, endsAt, reason: reason || null },
      });
      if (error || !data?.ok) throw new Error(await functionMessage(error, data));
      if (current !== generation.current) return;
      setClasses(data.classes || []); setCanSetRate(data.canSetRate === true);
      if (!data.classes?.length) setError('Nenhuma aula disponível para cobertura nesse período. Aulas já cobertas, antecipadas ou excluídas não entram na seleção.');
    } catch (e) {
      if (current === generation.current) setError('Erro ao listar aulas: ' + (e instanceof Error ? e.message : 'Tente novamente.'));
    } finally {
      if (current === generation.current) setLoadingClasses(false);
    }
  };

  const searchSubs = async (c: AffectedClass) => {
    const key = keyOf(c); const current = generation.current;
    setSearchingKey(key); setError('');
    try {
      const { data, error } = await supabase.functions.invoke('coverage-admin', {
        body: { action: 'searchSubstitutes', bookingId: c.bookingId, classDate: c.classDate, classTime: c.classTime },
      });
      if (error || !data?.ok) throw new Error(await functionMessage(error, data));
      if (current !== generation.current) return;
      setCandidatesByKey(prev => ({ ...prev, [key]: data.slots || [] }));
      setChosen(prev => ({ ...prev, [key]: '' }));
    } catch (e) {
      if (current === generation.current) setError('Busca de substitutos falhou: ' + (e instanceof Error ? e.message : 'Tente novamente.'));
    } finally {
      if (current === generation.current) setSearchingKey(null);
    }
  };

  const submit = async () => {
    const selected = classes.filter(c => chosen[keyOf(c)]);
    if (!selected.length) { setError('Escolha pelo menos um substituto.'); return; }
    const items = [];
    for (const c of selected) {
      const raw = canSetRate ? rates[keyOf(c)]?.trim() : '';
      const offeredRate = raw ? Number(raw.replace(',', '.')) : null;
      if (offeredRate !== null && (!Number.isFinite(offeredRate) || offeredRate <= 0 || offeredRate > 10000 || Math.abs(offeredRate * 100 - Math.round(offeredRate * 100)) > 0.000001)) {
        setError('Informe um valor entre R$ 0,01 e R$ 10.000,00, com até duas casas decimais.'); return;
      }
      items.push({ ...c, coverTeacherId: chosen[keyOf(c)], ...(offeredRate === null ? {} : { offeredRate }) });
    }
    if (items.length > 50) { setError('Envie até 50 aulas por vez.'); return; }
    setSending(true); setError('');
    try {
      let id = absenceId;
      if (!id) {
        const { data, error } = await supabase.functions.invoke('coverage-admin', {
          body: { action: 'createAbsence', teacherId: teacher.id, startsAt, endsAt, reason: reason || null },
        });
        if (error || !data?.ok || !data.absence?.id) throw new Error(await functionMessage(error, data));
        id = data.absence.id as string; setAbsenceId(id);
      }
      const { data, error } = await supabase.functions.invoke('coverage-admin', { body: { action: 'requestCoverage', absenceId: id, mode, items } });
      // Um 502 também pode conter o resultado de cada item (inclusive envio
      // incerto). Preserva essas ressalvas e nunca trata incerteza como entrega.
      const response = data || (error && typeof error === 'object' && 'context' in error && error.context instanceof Response
        ? await error.context.clone().json().catch(() => null) : null);
      if (!response?.ok && !Array.isArray(response?.results)) throw new Error(await functionMessage(error, response));
      const results = (response.results || []) as CoverageResult[];
      const created = results.filter(r => r.coverage);
      const warnings = results.flatMap(r => r.warning ? [r.warning] : []);
      setDoneWarnings(prev => Array.from(new Set([...prev, ...warnings])));
      const completedKeys = new Set(created.map(r => `${r.coverage!.booking_id}_${r.coverage!.class_date}`));
      const failures = results.filter(r => !r.coverage);
      setCompletedCount(prev => prev + created.length);
      if (failures.length || created.length !== items.length) {
        // Mantém os erros visíveis; um retry não repete os convites já criados.
        setClasses(prev => prev.filter(c => !completedKeys.has(keyOf(c))));
        setChosen({});
        setError(`${created.length} cobertura(s) concluída(s) nesta tentativa. Confira as pendências: ${failures.map(r => `${r.item?.classDate || ''}: ${r.error || 'requer revisão'}`).join('; ') || 'resultado incompleto'}`);
      } else setDone(completedCount + created.length);
    } catch (e) {
      setError('Erro ao enviar coberturas: ' + (e instanceof Error ? e.message : 'Tente novamente.'));
    } finally { setSending(false); }
  };

  return (
    <div className="fixed inset-0 z-110 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs" onClick={() => !sending && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Ausência e cobertura" className="bg-brand-surface rounded-3xl w-full max-w-2xl border border-brand-border shadow-2xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-brand-border">
          <div className="flex items-center gap-3">
            <CalendarOff size={24} className="text-amber-500" />
            <div><h2 className="font-black text-brand-text">Ausência & Cobertura</h2><p className="text-xs text-brand-muted">{teacher.name}</p></div>
          </div>
          <button aria-label="Fechar" disabled={sending} onClick={onClose} className="p-2 rounded-full text-brand-muted"><X size={18} /></button>
        </div>
        <div className="p-5 overflow-y-auto">
          {done !== null ? (
            <div className="text-center py-8">
              <CheckCircle size={48} className="text-emerald-500 mx-auto mb-3" />
              <h3 className="font-black text-lg text-brand-text">{done} cobertura(s) {mode === 'force' ? 'aplicada(s)' : 'enviada(s)'}</h3>
              <p className="text-sm text-brand-muted mt-1">{mode === 'force'
                ? 'Os substitutos foram escalados. O pacote da aula segue pela fila de avisos; confira as ressalvas abaixo.'
                : 'O WhatsApp aceitou o envio dos convites. A cobertura só será confirmada quando cada substituto aceitar.'}</p>
              <p className="text-xs text-brand-muted mt-2">O valor definido pela direção vale por aula de 30 minutos e entra no pagamento após o lançamento da aula pagável.</p>
              <button onClick={onClose} className="mt-6 px-6 py-3 rounded-2xl bg-tenant-primary text-white text-xs font-black uppercase">Fechar</button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
                <label className="text-xs text-brand-muted">Início
                  <input type="date" value={startsAt} min={today} disabled={sending} onChange={e => { invalidate(); setStartsAt(e.target.value); }} className="w-full mt-1 px-3 py-2.5 rounded-xl border border-brand-border bg-brand-surface-2 text-sm text-brand-text" />
                </label>
                <label className="text-xs text-brand-muted">Fim
                  <input type="date" value={endsAt} min={startsAt} disabled={sending} onChange={e => { invalidate(); setEndsAt(e.target.value); }} className="w-full mt-1 px-3 py-2.5 rounded-xl border border-brand-border bg-brand-surface-2 text-sm text-brand-text" />
                </label>
                <label className="text-xs text-brand-muted">Motivo
                  <input type="text" value={reason} maxLength={500} disabled={sending} onChange={e => { invalidate(); setReason(e.target.value); }} placeholder="Saúde, etc." className="w-full mt-1 px-3 py-2.5 rounded-xl border border-brand-border bg-brand-surface-2 text-sm text-brand-text" />
                </label>
              </div>
              <button onClick={listClasses} disabled={loadingClasses || sending} className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl bg-tenant-primary/10 text-tenant-primary text-xs font-black uppercase mb-4">
                {loadingClasses ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />} Listar aulas do período
              </button>
              {classes.length > 0 && <p className="text-xs text-brand-muted mb-3">{classes.length} aula(s), com horários vigentes em cada data. Cada linha representa 30 minutos; uma aula de 1 hora aparece em duas partes.</p>}
              <div className="space-y-2 mb-4">
                {classes.map(c => {
                  const key = keyOf(c); const cands = candidatesByKey[key];
                  const label = `${c.studentName}, ${c.classDate}, ${c.classTime}`;
                  return (
                    <div key={key} className="border border-brand-border rounded-2xl p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-sm min-w-0 break-words">
                          <span className="font-black text-brand-text">{new Date(c.classDate + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' })}</span>
                          <span className="text-brand-muted"> · {c.classTime} · {c.studentName}</span>
                        </div>
                        <button aria-label={`Buscar substitutos para ${label}`} onClick={() => searchSubs(c)} disabled={searchingKey !== null || sending} className="shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-lg border border-brand-border text-[10px] font-black uppercase text-brand-muted">
                          {searchingKey === key ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />} Substitutos
                        </button>
                      </div>
                      {cands && (cands.length ? (
                        <select aria-label={`Substituto para ${label}`} value={chosen[key] || ''} disabled={sending} onChange={e => setChosen(prev => ({ ...prev, [key]: e.target.value }))} className="w-full mt-2 px-3 py-2 rounded-xl border border-brand-border bg-brand-surface-2 text-sm text-brand-text">
                          <option value="">— escolher substituto livre —</option>
                          {cands.map(t => <option key={t.teacher_id} value={t.teacher_id}>{t.teacher_name}</option>)}
                        </select>
                      ) : <p className="mt-2 text-xs text-amber-500 font-bold">Nenhum professor livre nesse horário.</p>)}
                      {canSetRate && (
                        <label className="block text-xs text-brand-muted mt-3">Valor por aula de 30 min (R$) · somente direção
                          <input aria-label={`Valor da cobertura para ${label}`} type="text" inputMode="decimal" value={rates[key] || ''} disabled={sending} onChange={e => setRates(prev => ({ ...prev, [key]: e.target.value }))} placeholder="Tarifa normal do professor" className="w-full mt-1 px-3 py-2 rounded-xl border border-brand-border bg-brand-surface-2 text-sm text-brand-text" />
                          <span className="block mt-1">Em branco, mantém a tarifa normal. O valor informado fica fixado no convite.</span>
                        </label>
                      )}
                    </div>
                  );
                })}
              </div>
              {classes.length > 0 && <>
                <div className="flex gap-2 mb-3">
                  <button disabled={sending} onClick={() => setMode('request')} className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-[10px] font-black uppercase border ${mode === 'request' ? 'bg-tenant-primary text-white border-tenant-primary' : 'border-brand-border text-brand-muted'}`}><Send size={12} /> Confirmar por WhatsApp</button>
                  <button disabled={sending} onClick={() => setMode('force')} className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-[10px] font-black uppercase border ${mode === 'force' ? 'bg-red-500 text-white border-red-500' : 'border-brand-border text-brand-muted'}`}><Zap size={12} /> Forçar (urgência)</button>
                </div>
                <button onClick={submit} disabled={sending || !classes.some(c => chosen[keyOf(c)])} className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl bg-tenant-primary text-white text-xs font-black uppercase disabled:opacity-50">
                  {sending ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}{mode === 'force' ? 'Escalar substitutos agora' : 'Enviar pedidos de cobertura'}
                </button>
                <p className="text-[11px] text-brand-muted text-center mt-2">{mode === 'force' ? 'A cobertura é confirmada na hora, sem esperar aceite.' : 'O substituto recebe um link no WhatsApp; a cobertura só é confirmada quando ele aceitar.'}</p>
              </>}
            </>
          )}
          {doneWarnings.map(warning => <p key={warning} role="alert" className="text-xs font-bold text-amber-600 mt-2">⚠️ {warning}</p>)}
          {error && <p role="alert" className="text-red-500 text-sm font-bold text-center mt-3">{error}</p>}
        </div>
      </div>
    </div>
  );
};
export default AbsenceCoverageManager;
