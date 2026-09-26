import React, { useCallback, useEffect, useState } from 'react';
import { CalendarCheck, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import {
  consentErrorMessage,
  formatDecisionDate,
  GUARDIAN_PHONE_UNCONFIRMED_TEXT,
  type GuardianReason,
} from '../lib/lessonRecordingConsent';

// Data de nascimento cadastrada pela ESCOLA (direção ou coordenação), com
// trilha. É a única prova de maioridade que o termo de registro das aulas
// aceita: sem ela, quem responde pelo link é o responsável (migration
// 20260926200000). Nunca é digitada no link público.

type BirthDateRecord = {
  ok: boolean;
  profile_birth_date: string | null;
  school_birth_date: string | null;
  recorded_at: string | null;
  recorded_by_name: string | null;
  is_kids: boolean;
  guardian_reason: GuardianReason | null;
  /** Telefone do responsável que recebe o código (só o confirmado pela escola). */
  guardian_code_phone_masked?: string | null;
  guardian_phone_unconfirmed?: boolean;
};

const REASON_TEXT: Record<GuardianReason | 'ADULT', string> = {
  ADULT: 'Maior de idade pela data da escola: o próprio aluno pode responder o termo de registro das aulas.',
  MINOR: 'Menor de idade: o termo de registro das aulas é respondido pelo responsável.',
  KIDS: 'Turma infantil: o termo de registro das aulas é respondido pelo responsável.',
  AGE_UNKNOWN: 'Sem data confirmada pela escola: o termo de registro das aulas é respondido pelo responsável.',
};

function todayIso(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

export default function StudentBirthDateField({
  studentId,
  compact = false,
  onSaved,
}: {
  studentId: string;
  compact?: boolean;
  onSaved?: (reason: GuardianReason | null) => void;
}) {
  const [record, setRecord] = useState<BirthDateRecord | null>(null);
  const [hidden, setHidden] = useState(false);
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  const load = useCallback(async () => {
    const { data, error: rpcError } = await supabase.rpc('get_student_birth_date_record', { p_student_id: studentId });
    if (rpcError || !data?.ok) {
      // Sem permissão (professor) ou rota ainda não publicada: o campo não aparece.
      setHidden(true);
      return;
    }
    const next = data as BirthDateRecord;
    setRecord(next);
    setValue(next.school_birth_date || next.profile_birth_date || '');
  }, [studentId]);
  useEffect(() => { void load(); }, [load]);

  async function save() {
    setError(''); setSaved('');
    if (value && value > todayIso()) { setError('A data de nascimento não pode estar no futuro.'); return; }
    if (!value) {
      if (!record?.school_birth_date && !record?.profile_birth_date) { setError('Informe a data de nascimento.'); return; }
      if (!window.confirm('Apagar a data de nascimento? Sem ela, quem responde o termo de registro das aulas é o responsável.')) return;
    }
    setBusy(true);
    const { data, error: rpcError } = await supabase.rpc('set_student_birth_date', {
      p_student_id: studentId,
      p_birth_date: value || null,
      p_reason: reason.trim() || null,
    });
    setBusy(false);
    if (rpcError || !data?.ok) { setError(consentErrorMessage(rpcError?.message)); return; }
    setReason('');
    setSaved(data.unchanged ? 'Essa data já estava confirmada.' : 'Data de nascimento confirmada pela escola.');
    await load();
    onSaved?.((data.guardian_reason as GuardianReason | null) ?? null);
  }

  if (hidden) return null;
  if (!record) {
    return <p className="flex items-center gap-2 text-xs text-slate-500"><Loader2 size={12} className="animate-spin" /> Carregando data de nascimento…</p>;
  }

  const confirmed = !!record.school_birth_date;
  const pendingProfileDate = !confirmed && !!record.profile_birth_date;
  const reasonText = REASON_TEXT[record.guardian_reason || 'ADULT'];

  return <div data-tour="student-birth-date" className={compact ? 'space-y-2' : 'space-y-2 pt-4 border-t border-brand-border'}>
    <label className="block">
      <span className="text-[10px] font-black uppercase tracking-widest text-brand-muted flex items-center gap-1.5">
        <CalendarCheck size={12} /> Data de nascimento (confirmada pela escola)
      </span>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          type="date"
          value={value}
          max={todayIso()}
          min="1900-01-01"
          onChange={event => setValue(event.target.value)}
          aria-label="Data de nascimento"
          className="rounded-xl border border-brand-border bg-brand-surface-2 px-3 py-2 text-sm font-bold text-brand-text outline-none focus:ring-2 focus:ring-tenant-primary dark:bg-slate-950 dark:text-slate-200"
        />
        <input
          value={reason}
          onChange={event => setReason(event.target.value)}
          maxLength={500}
          placeholder="Como a escola conferiu (opcional)"
          aria-label="Como a escola conferiu a data"
          className="min-w-[12rem] flex-1 rounded-xl border border-brand-border bg-brand-surface-2 px-3 py-2 text-sm text-brand-text outline-none focus:ring-2 focus:ring-tenant-primary dark:bg-slate-950 dark:text-slate-200"
        />
        <button type="button" disabled={busy} onClick={() => void save()}
          className="rounded-xl bg-emerald-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-40">
          {busy ? 'Salvando…' : confirmed ? 'Salvar data' : 'Confirmar data'}
        </button>
      </div>
    </label>
    <p className="text-xs text-slate-500">
      {confirmed
        ? `Confirmada${record.recorded_by_name ? ` por ${record.recorded_by_name}` : ''}${record.recorded_at ? ` em ${formatDecisionDate(record.recorded_at)}` : ''}. `
        : pendingProfileDate
          ? 'A data do cadastro ainda não foi confirmada pela escola. '
          : 'Sem data de nascimento cadastrada. '}
      {reasonText}
    </p>
    {record.guardian_reason && 'guardian_code_phone_masked' in record && <p className="text-xs text-slate-500">
      {record.guardian_code_phone_masked
        ? `O código do termo vai para o WhatsApp do responsável ${record.guardian_code_phone_masked}.`
        : record.guardian_phone_unconfirmed
          ? GUARDIAN_PHONE_UNCONFIRMED_TEXT
          : 'Sem telefone do responsável confirmado pela escola: cadastre em “Contatos verificados” para o código do termo poder sair.'}
    </p>}
    {error && <p role="alert" className="text-xs font-semibold text-red-600">{error}</p>}
    {saved && <p role="status" className="text-xs font-semibold text-emerald-700">{saved}</p>}
  </div>;
}
