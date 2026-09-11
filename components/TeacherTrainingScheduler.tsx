import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

type Teacher = { id: string; name: string; is_trainer: boolean };
type Training = { id: string; trainer_name: string; trainee_name: string; starts_at: string; status: string; invitation_status: string | null };
const statusLabels: Record<string, string> = { PENDING: 'Aguardando aceite', CONFIRMED: 'Confirmado · R$ 16 previstos', DECLINED: 'Convite recusado', CANCELLED: 'Cancelado', COMPLETED: 'Concluído · R$ 16 no fechamento' };
const inputClass = 'w-full px-3 py-3 rounded-xl border border-brand-border bg-brand-surface-2 text-brand-text';
const brtDate = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(date);

export default function TeacherTrainingScheduler({ tenantId }: { tenantId: string }) {
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [sessions, setSessions] = useState<Training[]>([]);
  const [trainer, setTrainer] = useState('');
  const [trainee, setTrainee] = useState('');
  const [date, setDate] = useState(brtDate(new Date()));
  const [time, setTime] = useState('16:30');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [request, setRequest] = useState(() => crypto.randomUUID());
  const load = async () => {
    const { data, error: failure } = await supabase.rpc('teacher_training_scheduler_data', { p_tenant: tenantId });
    if (failure) throw failure;
    setTeachers(data.teachers || []);
    setSessions(data.sessions || []);
    const trainers = (data.teachers || []).filter((t: Teacher) => t.is_trainer);
    if (trainers.length === 1) setTrainer(trainers[0].id);
  };
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    supabase.rpc('teacher_training_scheduler_data', { p_tenant: tenantId }).then(({ data, error: failure }) => {
      if (!active) return;
      setLoading(false);
      if (failure) { setError('Não foi possível carregar os teachers. Feche e abra o lançador para tentar novamente.'); return; }
      setTeachers(data?.teachers || []); setSessions(data?.sessions || []);
      const trainers = (data?.teachers || []).filter((t: Teacher) => t.is_trainer);
      if (trainers.length === 1) setTrainer(trainers[0].id);
    });
    return () => { active = false; };
  }, [tenantId]);
  const changed = () => { setRequest(crypto.randomUUID()); setNotice(''); };
  const schedule = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      const startsAt = new Date(`${date}T${time}:00-03:00`);
      if (!trainer || !trainee || trainer === trainee || !Number.isFinite(startsAt.getTime())) throw new Error('Selecione o treinador, outro teacher e um horário válido.');
      const { data, error: failure } = await supabase.rpc('schedule_teacher_training', { p_tenant: tenantId, p_request_id: request, p_trainer: trainer, p_trainee: trainee, p_start: startsAt.toISOString() });
      if (failure) throw failure;
      if (!data?.ok) throw new Error('Não foi possível registrar o treinamento.');
      setNotice('Treinamento registrado. O convite entrou na fila do WhatsApp para o teacher aceitar.');
      // Keep the request key on an uncertain response; change it only for a new form.
      await load();
    } catch (failure: any) { setError(failure.message || 'Não foi possível agendar. Tente novamente.'); }
    finally { setBusy(false); }
  };
  const cancel = async (id: string) => {
    setBusy(true); setError('');
    try {
      const { error: failure } = await supabase.rpc('cancel_teacher_training', { p_id: id });
      if (failure) throw failure;
      setNotice('Treinamento cancelado. O horário foi liberado e não gerou pagamento.'); await load();
    } catch (failure: any) { setError(failure.message || 'Não foi possível cancelar.'); }
    finally { setBusy(false); }
  };
  return <div className="space-y-6 text-brand-text">
    <p className="text-sm text-brand-muted">Escolha quem ministra e quem recebe o treinamento. O convite vai para o WhatsApp cadastrado do novo teacher.</p>
    {loading ? <p role="status">Carregando teachers e treinamentos…</p> : <form onSubmit={schedule} className="space-y-4">
      <label className="block text-sm font-semibold">Treinador habilitado<select aria-label="Treinador habilitado" className={inputClass} value={trainer} disabled={busy} onChange={e => { setTrainer(e.target.value); changed(); }} required><option value="">Selecione</option>{teachers.filter(t => t.is_trainer).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      <label className="block text-sm font-semibold">Teacher que receberá o treinamento<select aria-label="Teacher que receberá o treinamento" className={inputClass} value={trainee} disabled={busy} onChange={e => { setTrainee(e.target.value); changed(); }} required><option value="">Selecione o teacher cadastrado</option>{teachers.filter(t => t.id !== trainer).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      <div className="grid grid-cols-2 gap-3"><label className="text-sm font-semibold">Data<input aria-label="Data do treinamento" type="date" required min={brtDate(new Date())} value={date} disabled={busy} onChange={e => { setDate(e.target.value); changed(); }} className={inputClass} /></label><label className="text-sm font-semibold">Horário de Brasília<input aria-label="Horário do treinamento" type="time" required step="1800" value={time} disabled={busy} onChange={e => { setTime(e.target.value); changed(); }} className={inputClass} /></label></div>
      <div className="rounded-xl border border-brand-border p-4 text-sm"><strong>30 minutos · R$ 16,00 para o treinador</strong><p className="mt-1 text-brand-muted">O aceite confirma o horário. O valor entra no fechamento depois que o treinador registrar o treinamento realizado no lançador de aulas.</p></div>
      <button type="submit" disabled={busy || !trainer || !trainee} className="w-full bg-orange-600 text-white rounded-xl px-4 py-3 font-bold disabled:opacity-50">{busy ? 'Salvando…' : 'Agendar e enviar convite'}</button>
    </form>}
    {error && <p role="alert" className="text-red-600 text-sm">{error}</p>}
    {notice && <p role="status" className="text-green-600 text-sm">{notice}</p>}
    <div className="space-y-3"><div className="flex justify-between items-center"><h3 className="font-bold">Treinamentos recentes</h3><button disabled={busy || loading} className="text-sm underline" onClick={() => { setBusy(true); load().catch(() => setError('Não foi possível atualizar os treinamentos.')).finally(() => setBusy(false)); }}>Atualizar</button></div>
      {!loading && !sessions.length && <p className="text-sm text-brand-muted">Os treinamentos agendados aparecerão aqui.</p>}
      {sessions.map(s => <article key={s.id} className="border border-brand-border rounded-xl p-4 text-sm space-y-2"><p><strong>{s.trainer_name}</strong> → {s.trainee_name}</p><p>{new Date(s.starts_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' })} · Brasília</p><p className="font-semibold">{s.status === 'PENDING' && new Date(s.starts_at).getTime() <= Date.now() ? 'Convite expirado' : statusLabels[s.status] || s.status}</p>{s.status === 'PENDING' && <p className="text-brand-muted">{['failed','uncertain'].includes(s.invitation_status || '') ? 'O WhatsApp precisa de conferência pela gestão.' : ['accepted','sent','delivered','read'].includes(s.invitation_status || '') ? 'Convite enviado ao WhatsApp cadastrado.' : 'Convite aguardando envio pelo WhatsApp.'}</p>}{['PENDING','CONFIRMED'].includes(s.status) && <button disabled={busy} className="underline text-red-600" onClick={() => cancel(s.id)}>Cancelar treinamento</button>}</article>)}
    </div>
  </div>;
}
