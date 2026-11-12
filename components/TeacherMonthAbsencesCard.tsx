import React, { useEffect, useState } from 'react';
import { Repeat } from 'lucide-react';
import { supabase } from '../lib/supabase';

interface Row { id: string; fault_type: string | null; student: { full_name: string | null } | { full_name: string | null }[] | null }

/**
 * Aviso interno ao professor (direção, 12/11/2026): as faltas do mês que
 * ainda pedem reposição. O aluno só recebe "combine a reposição com seu
 * professor"; quem organiza é o professor, por aqui. Falta de mês anterior
 * não gera reposição e não aparece.
 */
export default function TeacherMonthAbsencesCard({ teacherId, onOpen }: { teacherId: string; onOpen?: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    let active = true;
    const monthStart = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }).slice(0, 8) + '01';
    void (async () => {
      const { data, error } = await supabase
        .from('reschedules')
        .select('id, fault_type, student:student_id(full_name)')
        .eq('teacher_id', teacherId)
        .is('used_at', null)
        .is('closed_reason', null)
        .or('date.is.null,date.eq.Pendente')
        .gte('created_at', `${monthStart}T03:00:00Z`)
        .order('created_at', { ascending: true })
        .limit(50);
      if (active) setRows(error ? [] : ((data || []) as Row[]));
    })();
    return () => { active = false; };
  }, [teacherId]);

  if (!rows || rows.length === 0) return null;

  const names = rows.map((r) => {
    const s = Array.isArray(r.student) ? r.student[0] : r.student;
    return (s?.full_name || 'Aluno').split(/\s+/)[0];
  });
  const fromTeacher = rows.filter((r) => r.fault_type === 'TEACHER').length;

  return (
    <section data-tour="teacher-month-absences" className="rounded-3xl border border-amber-500/30 bg-amber-500/5 p-5">
      <div className="flex items-start gap-3">
        <div className="ww-orb tone-amber h-10 w-10 shrink-0"><Repeat size={18} /></div>
        <div className="min-w-0 flex-1">
          <h3 className="font-black text-brand-text">
            {rows.length === 1 ? '1 reposição deste mês para combinar' : `${rows.length} reposições deste mês para combinar`}
          </h3>
          <p className="mt-1 text-sm text-brand-muted">
            {names.slice(0, 6).join(', ')}{names.length > 6 ? ` e mais ${names.length - 6}` : ''}.
            {fromTeacher > 0 ? ` ${fromTeacher} ${fromTeacher === 1 ? 'é' : 'são'} de falta sua.` : ''}
            {' '}O aluno recebe só "combine sua reposição com seu professor": quem marca o horário é você.
          </p>
          {onOpen && (
            <button type="button" onClick={onOpen} className="mt-3 rounded-xl bg-amber-600 px-4 py-2 text-xs font-black text-white hover:bg-amber-700">
              Organizar reposições
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
