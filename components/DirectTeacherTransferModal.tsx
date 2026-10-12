import React, { useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft, CheckCircle2, Loader2, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Teacher } from '../types';

interface DirectTeacherTransferModalProps {
  student: { id: string; full_name: string; professor_id?: string | null };
  teachers: Teacher[];
  currentSchedules: Array<{ day_of_week: string; time_slot: string }>;
  onClose: () => void;
  onTransferred: (teacherId: string) => void | Promise<void>;
}

const friendlyTransferError = (message: string) => {
  const codes: Record<string, string> = {
    active_teacher_transfer_exists: 'Já existe uma transferência em andamento para este aluno. Confira-a antes de criar outra.',
    teacher_transfer_schedule_conflict: 'Um dos horários escolhidos não está mais disponível. Atualize a lista.',
    teacher_transfer_frequency_changed: 'A quantidade de aulas mudou desde a programação. Confira a agenda do aluno.',
    teacher_transfer_student_changed: 'O cadastro do aluno mudou. Confira sua situação e professor atual.',
  };
  const code = Object.keys(codes).find(key => message.includes(key));
  if (code) return codes[code];
  const known = [
    'O professor de destino não está disponível em todos os horários atuais do aluno.',
    'O professor de destino já possui aula em um dos horários do aluno.',
    'A matrícula possui uma reserva de horário vinculada. Regularize a oferta antes da transferência.',
    'O aluno não possui aulas fixas ativas com o professor atual.',
    'Escolha um professor diferente do atual.',
    'Informe o motivo da transferência (mínimo de 8 caracteres).',
    'Um dos horários escolhidos não está mais disponível. Atualize a lista.',
    'A transferência anterior foi cancelada ou recusada.',
    'Mantenha a quantidade de aulas contratada na transferência.',
    'A confirmação anterior possui outros dados.',
    'Data de início inválida.',
    'Conclua a matrícula em andamento antes da transferência.',
    'O professor de destino não está ativo nesta escola.',
    'Escolha aluno ativo e professor diferente do atual.',
  ];
  return known.find(item => message.includes(item))
    || 'Não foi possível concluir a transferência. Atualize a página e tente novamente.';
};

const DirectTeacherTransferModal: React.FC<DirectTeacherTransferModalProps> = ({
  student,
  currentSchedules,
  onClose,
  onTransferred,
}) => {
  const [toTeacher, setToTeacher] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [mode, setMode] = useState<'KEEP' | 'CHANGE'>('KEEP');
  const [cutover, setCutover] = useState(() => {
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  });
  const [available, setAvailable] = useState<Array<{ id: string; name: string; slots: Array<{ day_of_week: string; time_slot: string }> }>>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Array<{ day_of_week: string; time_slot: string }>>([]);
  const [requestId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setSelected([]); setToTeacher(''); setError('');
    void Promise.resolve(supabase.rpc('get_student_transfer_options', { p_student_id: student.id, p_cutover: cutover })).then(({ data, error: queryError }) => {
      if (cancelled) return;
      if (queryError || data?.ok !== true || !Array.isArray(data.teachers)) {
        setAvailable([]); setError('Não foi possível consultar a disponibilidade. Tente novamente.');
      } else setAvailable(data.teachers);
      setLoading(false);
    }).catch(() => {
      if (!cancelled) { setAvailable([]); setLoading(false); setError('Não foi possível consultar a disponibilidade. Tente novamente.'); }
    });
    return () => { cancelled = true; };
  }, [student.id, cutover]);

  const options = useMemo(
    () => available.filter(teacher => teacher.id !== student.professor_id && (mode === 'CHANGE' || currentSchedules.every(schedule => teacher.slots.some(slot => slot.day_of_week === schedule.day_of_week && slot.time_slot === schedule.time_slot.slice(0, 5))))),
    [available, student.professor_id, currentSchedules, mode],
  );
  const chosenSlots = mode === 'KEEP' ? currentSchedules.map(slot => ({ ...slot, time_slot: slot.time_slot.slice(0, 5) })) : selected;
  const freeSlots = available.find(teacher => teacher.id === toTeacher)?.slots || [];
  const targetName = options.find(teacher => teacher.id === toTeacher)?.name || 'novo professor';
  const schedules = currentSchedules
    .map(schedule => `${schedule.day_of_week} ${schedule.time_slot.slice(0, 5)}`)
    .join(' · ');

  const transfer = async () => {
    if (!toTeacher || loading || chosenSlots.length !== currentSchedules.length || !chosenSlots.length || reason.trim().length < 8) return;
    const confirmed = window.confirm(
      `Transferir definitivamente ${student.full_name} para ${targetName}?\n\n` +
      `Início: ${cutover}. Horários: ${chosenSlots.map(slot => `${slot.day_of_week} ${slot.time_slot}`).join(' · ')}\n\n` +
      'A transferência é definitiva, aplicada na data de início. Não altera mensalidade ou contrato.',
    );
    if (!confirmed) return;

    setSaving(true);
    setError('');
    try {
    const { data, error: rpcError } = await supabase.rpc('admin_schedule_student_transfer', {
      p_student_id: student.id,
      p_to_teacher: toTeacher,
      p_reason: reason.trim(),
      p_slots: chosenSlots,
      p_cutover: cutover,
      p_request_id: requestId,
    });
    setSaving(false);

    if (rpcError || data?.ok !== true || !['APPLIED', 'ACCEPTED'].includes(data.status)) {
      setError(friendlyTransferError(rpcError?.message || data?.error || ''));
      return;
    }

    // O aviso ao novo titular sai por gatilho em teacher_transfers (20260928100000),
    // pela fila da instância central — só com WhatsApp no cadastro dele.
    setSuccess(`Transferência definitiva de ${student.full_name} para ${data?.to_teacher_name || targetName} ${data?.status === 'APPLIED' ? 'aplicada' : 'programada'} para ${cutover}. Não depende de aceite pelo link.`);
    await onTransferred(data?.status === 'APPLIED' ? toTeacher : student.professor_id || '');
    } catch {
      setError('Não foi possível confirmar o resultado. Confira a transferência antes de tentar novamente.');
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-120 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs" onClick={onClose}>
      <div data-tour="definitive-transfer-schedule" className="w-full max-w-lg max-h-[90dvh] overflow-y-auto rounded-3xl border border-brand-border bg-brand-surface shadow-2xl" onClick={event => event.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-brand-border bg-brand-surface-2/50 px-6 py-5">
          <div className="flex items-center gap-2">
            <ArrowRightLeft size={18} className="text-indigo-500" />
            <div>
              <h3 className="font-black text-brand-text">Transferência definitiva</h3>
              <p className="text-xs text-brand-muted">Sem cobertura temporária e sem etapa de aceite</p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Fechar" className="rounded-full p-2 text-brand-muted hover:bg-brand-surface-2"><X size={18} /></button>
        </div>

        <div className="space-y-5 p-6">
          <div className="rounded-2xl border border-indigo-500/20 bg-indigo-500/10 p-4 text-xs leading-relaxed text-indigo-700 dark:text-indigo-300">
            A Gestão transfere as aulas fixas de <b>{student.full_name}</b>, preservando a quantidade contratada e o histórico. Agenda atual: <b>{schedules || 'nenhum horário fixo'}</b>.
          </div>
          <label className="block text-xs font-bold">Início da transferência
            <input aria-label="Início da transferência" type="date" value={cutover} onChange={event => setCutover(event.target.value)} disabled={saving || Boolean(success)} className="mt-1 w-full rounded-xl border border-brand-border bg-brand-surface-2 p-3" />
          </label>
          <label className="block text-xs font-bold">Horários
            <select aria-label="Modo dos horários" value={mode} onChange={event => { setMode(event.target.value as 'KEEP' | 'CHANGE'); setToTeacher(''); setSelected([]); }} disabled={saving || Boolean(success)} className="mt-1 w-full rounded-xl border border-brand-border bg-brand-surface-2 p-3">
              <option value="KEEP">Manter os mesmos horários</option><option value="CHANGE">Escolher novos horários</option>
            </select>
          </label>

          <label className="block text-xs font-bold text-brand-text">
            Novo professor
            <select aria-label="Novo professor" value={toTeacher} onChange={event => { setToTeacher(event.target.value); setSelected([]); setError(''); }} disabled={loading || saving || Boolean(success)} className="mt-1 w-full rounded-xl border border-brand-border bg-brand-surface-2 p-3 text-sm">
              <option value="">Selecione...</option>
              {options.map(teacher => <option key={teacher.id} value={teacher.id}>{teacher.name}</option>)}
            </select>
          </label>
          {loading && <p role="status">Conferindo disponibilidade...</p>}
          {!loading && mode === 'KEEP' && options.length === 0 && <p role="status">Nenhum teacher livre em todos os horários atuais. Use Escolher novos horários.</p>}
          {mode === 'CHANGE' && toTeacher && <div className="space-y-2"><p className="text-xs">Selecione {currentSchedules.length} horário(s) de 30 minutos. Selecionados: {selected.length}.</p>
            <div className="flex flex-wrap gap-2">{freeSlots.map(slot => {
              const active = selected.some(item => item.day_of_week === slot.day_of_week && item.time_slot === slot.time_slot);
              return <button key={`${slot.day_of_week}-${slot.time_slot}`} type="button" aria-pressed={active} disabled={saving || Boolean(success) || (!active && selected.length >= currentSchedules.length)} className={`rounded-lg border p-2 text-xs ${active ? 'bg-indigo-600 text-white' : 'border-brand-border'}`} onClick={() => setSelected(previous => active ? previous.filter(item => item.day_of_week !== slot.day_of_week || item.time_slot !== slot.time_slot) : [...previous, slot])}>{slot.day_of_week} {slot.time_slot}</button>;
            })}</div></div>}

          <label className="block text-xs font-bold text-brand-text">
            Motivo
            <textarea aria-label="Motivo da transferência" value={reason} onChange={event => { setReason(event.target.value); setError(''); }} disabled={saving || Boolean(success)} maxLength={1000} placeholder="Explique o motivo (mínimo de 8 caracteres)." className="mt-1 min-h-24 w-full rounded-xl border border-brand-border bg-brand-surface-2 p-3 text-sm" />
          </label>

          {error && <p role="alert" className="rounded-xl bg-red-500/10 p-3 text-sm font-bold text-red-500">{error}</p>}
          {success && <p role="status" className="flex items-center gap-2 rounded-xl bg-emerald-500/10 p-3 text-sm font-bold text-emerald-600"><CheckCircle2 size={17} />{success}</p>}

          <div className="flex justify-end gap-3">
            <button type="button" onClick={onClose} className="rounded-xl px-5 py-3 text-xs font-black uppercase text-brand-muted hover:bg-brand-surface-2">{success ? 'Fechar' : 'Cancelar'}</button>
            {!success && (
              <button type="button" onClick={transfer} disabled={loading || saving || !toTeacher || !chosenSlots.length || chosenSlots.length !== currentSchedules.length || reason.trim().length < 8} className="flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-3 text-xs font-black uppercase text-white disabled:cursor-not-allowed disabled:opacity-40">
                {saving ? <Loader2 size={15} className="animate-spin" /> : <ArrowRightLeft size={15} />}
                Confirmar transferência
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default DirectTeacherTransferModal;
