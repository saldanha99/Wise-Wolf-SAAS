import React, { useMemo, useState } from 'react';
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
  const known = [
    'O professor de destino não está disponível em todos os horários atuais do aluno.',
    'O professor de destino já possui aula em um dos horários do aluno.',
    'A matrícula possui uma reserva de horário vinculada. Regularize a oferta antes da transferência.',
    'O aluno não possui aulas fixas ativas com o professor atual.',
    'Escolha um professor diferente do atual.',
    'Informe o motivo da transferência (mínimo de 8 caracteres).',
  ];
  return known.find(item => message.includes(item))
    || 'Não foi possível concluir a transferência. Atualize a página e tente novamente.';
};

const DirectTeacherTransferModal: React.FC<DirectTeacherTransferModalProps> = ({
  student,
  teachers,
  currentSchedules,
  onClose,
  onTransferred,
}) => {
  const [toTeacher, setToTeacher] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const options = useMemo(
    () => teachers.filter(teacher => teacher.id !== student.professor_id && teacher.lifecycle_status !== 'offboarded' && teacher.lifecycle_status !== 'suspended'),
    [teachers, student.professor_id],
  );
  const targetName = options.find(teacher => teacher.id === toTeacher)?.name || 'novo professor';
  const schedules = currentSchedules
    .map(schedule => `${schedule.day_of_week} ${schedule.time_slot.slice(0, 5)}`)
    .join(' · ');

  const transfer = async () => {
    if (!toTeacher || reason.trim().length < 8) return;
    const confirmed = window.confirm(
      `Transferir definitivamente ${student.full_name} para ${targetName}?\n\n` +
      `Horários mantidos: ${schedules || 'nenhum horário fixo'}\n\n` +
      'A mudança é imediata e não depende de aceite.',
    );
    if (!confirmed) return;

    setSaving(true);
    setError('');
    const { data, error: rpcError } = await supabase.rpc('admin_transfer_student_teacher', {
      p_student_id: student.id,
      p_to_teacher: toTeacher,
      p_reason: reason.trim(),
    });
    setSaving(false);

    if (rpcError || data?.ok === false) {
      setError(friendlyTransferError(rpcError?.message || data?.error || ''));
      return;
    }

    setSuccess(`${student.full_name} agora é aluno(a) de ${data?.to_teacher_name || targetName}.`);
    await onTransferred(toTeacher);
  };

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-lg overflow-hidden rounded-3xl border border-brand-border bg-brand-surface shadow-2xl" onClick={event => event.stopPropagation()}>
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
            A Gestão troca o professor principal e todas as aulas fixas ativas de <b>{student.full_name}</b> em uma única operação. Os dias e horários atuais são mantidos: <b>{schedules || 'nenhum horário fixo'}</b>.
          </div>

          <label className="block text-xs font-bold text-brand-text">
            Novo professor
            <select aria-label="Novo professor" value={toTeacher} onChange={event => { setToTeacher(event.target.value); setError(''); }} disabled={saving || Boolean(success)} className="mt-1 w-full rounded-xl border border-brand-border bg-brand-surface-2 p-3 text-sm">
              <option value="">Selecione...</option>
              {options.map(teacher => <option key={teacher.id} value={teacher.id}>{teacher.name}</option>)}
            </select>
          </label>

          <label className="block text-xs font-bold text-brand-text">
            Motivo
            <textarea aria-label="Motivo da transferência" value={reason} onChange={event => { setReason(event.target.value); setError(''); }} disabled={saving || Boolean(success)} maxLength={1000} placeholder="Explique o motivo (mínimo de 8 caracteres)." className="mt-1 min-h-24 w-full rounded-xl border border-brand-border bg-brand-surface-2 p-3 text-sm" />
          </label>

          {error && <p role="alert" className="rounded-xl bg-red-500/10 p-3 text-sm font-bold text-red-500">{error}</p>}
          {success && <p role="status" className="flex items-center gap-2 rounded-xl bg-emerald-500/10 p-3 text-sm font-bold text-emerald-600"><CheckCircle2 size={17} />{success}</p>}

          <div className="flex justify-end gap-3">
            <button type="button" onClick={onClose} className="rounded-xl px-5 py-3 text-xs font-black uppercase text-brand-muted hover:bg-brand-surface-2">{success ? 'Fechar' : 'Cancelar'}</button>
            {!success && (
              <button type="button" onClick={transfer} disabled={saving || !toTeacher || reason.trim().length < 8} className="flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-3 text-xs font-black uppercase text-white disabled:cursor-not-allowed disabled:opacity-40">
                {saving ? <Loader2 size={15} className="animate-spin" /> : <ArrowRightLeft size={15} />}
                Transferir agora
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default DirectTeacherTransferModal;
