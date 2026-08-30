import React, { useEffect, useState } from 'react';
import { ShieldAlert, ChevronRight } from 'lucide-react';
import { supabase } from '../lib/supabase';

// Banner no topo do portal do aluno: avisa quando há aulas pendentes de auditoria
// e leva (scroll) até a seção StudentAuditPanel (#auditoria-aulas).

const StudentAuditReminder: React.FC = () => {
  const [pending, setPending] = useState(0);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.rpc('my_attendance_audits');
      const n = Array.isArray(data)
        ? data.filter((a: any) => !a.student_response && a.can_correct === true).length
        : 0;
      setPending(n);
    })();
  }, []);

  if (pending === 0) return null;

  const goToAudit = () => {
    document.getElementById('auditoria-aulas')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <button
      onClick={goToAudit}
      className="w-full flex items-center gap-3 px-5 py-3.5 rounded-2xl bg-gradient-to-r from-amber-500 to-orange-500 text-white shadow-lg shadow-amber-500/30 hover:brightness-105 transition-all text-left"
    >
      <ShieldAlert size={20} className="shrink-0" />
      <div className="flex-1">
        <p className="font-black text-sm leading-tight">
          Você tem {pending} aula{pending > 1 ? 's' : ''} pra confirmar
        </p>
        <p className="text-[11px] text-white/85">Toque para contar o que aconteceu {pending > 1 ? 'com elas' : 'com ela'} — leva 1 segundo.</p>
      </div>
      <ChevronRight size={20} className="shrink-0" />
    </button>
  );
};

export default StudentAuditReminder;
