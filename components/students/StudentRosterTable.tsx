import React from 'react';
import { AlertTriangle, ChevronRight } from 'lucide-react';
import {
  attentionReasons, initialsOf, lastClassLabel, rosterStage, scheduleLabel,
  type RosterOverview, type RosterStudent,
} from '../../lib/studentRoster';

type Props = {
  students: RosterStudent[];
  overviewMap: Record<string, RosterOverview | undefined>;
  showTeachers: boolean;
  canSeeMoney: boolean;
  onOpenProfile: (student: RosterStudent) => void;
};

const STAGE_LABEL = { active: 'Ativo', paused: 'Em pausa', offboarded: 'Encerrado' } as const;
const STAGE_CLASS = {
  active: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300',
  paused: 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
  offboarded: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
} as const;

/** Lista compacta: uma linha por aluno, para varrer a escola inteira de uma vez. */
const StudentRosterTable: React.FC<Props> = ({ students, overviewMap, showTeachers, canSeeMoney, onOpenProfile }) => {
  if (students.length === 0) return null;
  return (
    <div className="overflow-hidden rounded-3xl border border-brand-border bg-brand-surface">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-xs">
          <thead className="border-b border-brand-border bg-brand-surface-2/60 text-[10px] font-black uppercase tracking-widest text-brand-muted">
            <tr>
              <th className="px-4 py-3">Aluno</th>
              {showTeachers && <th className="px-4 py-3">Professor</th>}
              <th className="px-4 py-3">Horário fixo</th>
              <th className="px-4 py-3">Frequência</th>
              <th className="px-4 py-3">Última aula</th>
              <th className="px-4 py-3">Situação</th>
              <th className="px-4 py-3"><span className="sr-only">Abrir ficha</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-brand-border">
            {students.map(student => {
              const ov = overviewMap[student.id];
              const stage = rosterStage(student);
              const reasons = stage === 'active' ? attentionReasons(ov, canSeeMoney) : [];
              const attention = reasons.length > 0 && !!ov && ov.risk_level !== 'LOW';
              const overdue = canSeeMoney ? Number(ov?.overdue_count || 0) : 0;
              const rate = ov?.attendance_rate;
              return (
                <tr
                  key={student.id}
                  onClick={() => onOpenProfile(student)}
                  className="cursor-pointer transition-colors hover:bg-brand-surface-2/60"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-violet-600 text-[11px] font-black text-white">
                        {initialsOf(student.name)}
                      </span>
                      <div className="min-w-0">
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); onOpenProfile(student); }}
                          className="block max-w-[14rem] truncate text-left text-sm font-black text-brand-text hover:text-tenant-primary"
                        >
                          {student.name}
                        </button>
                        <span className="text-[10px] font-bold uppercase text-brand-muted">{student.levelBadge !== 'N/A' ? student.levelBadge : 'Sem nível'}</span>
                      </div>
                    </div>
                  </td>
                  {showTeachers && (
                    <td className="px-4 py-3 font-semibold text-brand-text">
                      {student.assignedTeachers.length > 0 ? student.assignedTeachers.join(', ') : <span className="text-brand-muted">—</span>}
                    </td>
                  )}
                  <td className="px-4 py-3 font-bold text-brand-text">
                    {scheduleLabel(student.scheduleSlots) || <span className="font-semibold text-brand-muted">Sem horário</span>}
                  </td>
                  <td className="px-4 py-3">
                    {rate == null ? <span className="text-brand-muted">—</span> : (
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-16 overflow-hidden rounded-full bg-brand-surface-2">
                          <div
                            className={`h-full rounded-full ${rate >= 80 ? 'bg-emerald-500' : rate >= 60 ? 'bg-amber-500' : 'bg-rose-500'}`}
                            style={{ width: `${Math.max(0, Math.min(100, rate))}%` }}
                          />
                        </div>
                        <span className="font-black text-brand-text">{rate}%</span>
                      </div>
                    )}
                  </td>
                  <td className={`px-4 py-3 font-semibold ${ov?.days_since_last != null && ov.days_since_last > 30 ? 'text-orange-600 dark:text-orange-400' : 'text-brand-muted'}`}>
                    {lastClassLabel(ov?.days_since_last).replace('Última aula ', '')}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-1">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-black uppercase ${STAGE_CLASS[stage]}`}>{STAGE_LABEL[stage]}</span>
                      {attention && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-black uppercase text-rose-700 dark:bg-rose-950/50 dark:text-rose-300" title={reasons.join(' · ')}>
                          <AlertTriangle size={10} /> Atenção
                        </span>
                      )}
                      {overdue > 0 && (
                        <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-black uppercase text-red-700 dark:bg-red-950/50 dark:text-red-300">{overdue} em atraso</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right text-brand-muted"><ChevronRight size={16} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default StudentRosterTable;
