import React from 'react';
import {
  AlertTriangle, Brain, CalendarCheck, CalendarClock, ChevronRight, Edit3, Eye, Folder,
  MessageCircle, PauseCircle, PlayCircle, UserX,
} from 'lucide-react';
import {
  attentionReasons, initialsOf, lastClassLabel, rosterStage, scheduleLabel,
  type RosterOverview, type RosterPermissions, type RosterStudent,
} from '../../lib/studentRoster';

export type RosterCardStudent = RosterStudent & {
  img?: string;
  phone?: string;
  interests?: string[];
  occupation?: string;
  currentModuleStatus?: string;
};

type Props = {
  student: RosterCardStudent;
  overview?: RosterOverview;
  permissions: RosterPermissions;
  showTeachers: boolean;
  onOpenProfile: () => void;
  onEdit: () => void;
  onMaterials: () => void;
  onWolf: () => void;
  onSchedule: () => void;
  onToggleStatus: () => void;
  onOffboard: () => void;
};

/** Telefone salvo sem DDI (11 dígitos) ganha o 55 para o wa.me abrir a conversa certa. */
export const whatsappNumber = (phone?: string) => {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.length <= 11 ? `55${digits}` : digits;
};

const STAGE_STYLE = {
  active: { bar: 'from-blue-500 via-indigo-500 to-violet-500', pill: '', label: '' },
  attention: { bar: 'from-rose-500 to-orange-400', pill: '', label: '' },
  paused: { bar: 'from-amber-300 to-amber-500', pill: 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300', label: 'Em pausa' },
  offboarded: { bar: 'from-slate-400 to-slate-500', pill: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300', label: 'Encerrado' },
} as const;

/** Anel de frequência: verde a partir de 80%, âmbar de 60%, vermelho abaixo. */
const FrequencyRing: React.FC<{ rate: number | null | undefined }> = ({ rate }) => {
  const value = rate == null ? null : Math.max(0, Math.min(100, rate));
  const color = value == null ? 'text-brand-muted' : value >= 80 ? 'text-emerald-500' : value >= 60 ? 'text-amber-500' : 'text-rose-500';
  const circumference = 2 * Math.PI * 16;
  return (
    <div className="relative h-12 w-12 shrink-0" aria-label={value == null ? 'Frequência sem dados' : `Frequência de ${value}%`}>
      <svg viewBox="0 0 40 40" className="h-12 w-12 -rotate-90">
        <circle cx="20" cy="20" r="16" fill="none" strokeWidth="4" className="stroke-brand-surface-2" />
        {value != null && (
          <circle
            cx="20" cy="20" r="16" fill="none" strokeWidth="4" strokeLinecap="round"
            className={`stroke-current ${color} transition-[stroke-dashoffset] duration-700`}
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - value / 100)}
          />
        )}
      </svg>
      <span className={`absolute inset-0 flex items-center justify-center text-[11px] font-black ${color}`}>
        {value == null ? '—' : `${value}%`}
      </span>
    </div>
  );
};

const QuickAction: React.FC<{
  icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean; title: string; tone: string;
}> = ({ icon, label, onClick, disabled, title, tone }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    title={title}
    aria-label={title}
    className={`group/action flex min-h-14 flex-col items-center justify-center gap-1 rounded-2xl border border-brand-border bg-brand-surface-2/60 px-1 py-2 transition-all hover:-translate-y-0.5 hover:border-transparent hover:shadow-lg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0 ${tone}`}
  >
    <span className="transition-transform group-hover/action:scale-110">{icon}</span>
    <span className="text-[10px] font-bold leading-none">{label}</span>
  </button>
);

const StudentRosterCard: React.FC<Props> = ({
  student, overview: ov, permissions, showTeachers,
  onOpenProfile, onEdit, onMaterials, onWolf, onSchedule, onToggleStatus, onOffboard,
}) => {
  const stage = rosterStage(student);
  const reasons = stage === 'active' ? attentionReasons(ov, permissions.canSeeMoney) : [];
  const attention = stage === 'active' && !!ov && ov.risk_level !== 'LOW' && reasons.length > 0;
  const style = STAGE_STYLE[attention ? 'attention' : stage];
  const schedule = scheduleLabel(student.scheduleSlots) || student.fixed_schedule || '';
  const phone = whatsappNumber(student.phone);
  const firstName = student.name.split(' ')[0];
  const overdue = permissions.canSeeMoney ? Number(ov?.overdue_count || 0) : 0;
  const interests = (student.interests || []).filter(Boolean);
  const occupation = student.occupation && student.occupation !== 'Não informado' ? student.occupation : '';

  return (
    <article
      className={`group relative flex h-full flex-col overflow-hidden rounded-3xl border bg-brand-surface shadow-[0_18px_40px_-28px_rgba(15,23,42,0.5)] transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_30px_60px_-30px_rgba(37,99,235,0.45)] ${attention ? 'border-rose-300/60 dark:border-rose-500/30' : 'border-brand-border'} ${stage !== 'active' ? 'opacity-80' : ''}`}
      aria-label={`Aluno ${student.name}`}
    >
      <div className={`h-1.5 w-full bg-gradient-to-r ${style.bar}`} />

      <div className="flex flex-1 flex-col gap-4 p-5">
        {/* Identidade */}
        <button type="button" onClick={onOpenProfile} className="flex items-start gap-3 text-left" aria-label={`Abrir ficha 360° de ${student.name}`}>
          {student.img && !student.img.includes('ui-avatars.com') ? (
            <img src={student.img} alt="" className="h-12 w-12 shrink-0 rounded-2xl object-cover ring-2 ring-brand-border" />
          ) : (
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-violet-600 text-sm font-black text-white shadow-md">
              {initialsOf(student.name)}
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-base font-black leading-tight text-brand-text group-hover:text-tenant-primary" title={student.name}>{student.name}</span>
            <span className="mt-1 flex flex-wrap items-center gap-1.5">
              <span className="rounded-full bg-tenant-primary/10 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-tenant-primary dark:bg-blue-500/15 dark:text-blue-300">
                {student.levelBadge !== 'N/A' ? student.levelBadge : 'Sem nível'}
              </span>
              {style.label && (
                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wide ${style.pill}`}>
                  <UserX size={10} /> {style.label}
                </span>
              )}
              {overdue > 0 && (
                <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-red-700 dark:bg-red-950/50 dark:text-red-300">
                  {overdue} em atraso
                </span>
              )}
            </span>
            {showTeachers && (
              <span className="mt-1 block truncate text-[11px] font-semibold text-brand-muted">
                {student.assignedTeachers.length > 0 ? `com ${student.assignedTeachers.join(' e ')}` : 'Sem professor na agenda'}
              </span>
            )}
          </span>
          <ChevronRight size={16} className="mt-1 shrink-0 text-brand-muted transition-transform group-hover:translate-x-0.5" />
        </button>

        {/* Saúde do aluno */}
        <div className="flex items-center gap-3 rounded-2xl bg-brand-surface-2/70 p-3">
          <FrequencyRing rate={ov?.attendance_rate} />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-[10px] font-black uppercase tracking-widest text-brand-muted">Frequência · 90 dias</p>
            <p className={`text-xs font-bold ${ov?.days_since_last != null && ov.days_since_last > 30 ? 'text-orange-600 dark:text-orange-400' : 'text-brand-text'}`}>
              {lastClassLabel(ov?.days_since_last)}
            </p>
            {ov && (ov.attended_90 != null || ov.absent_90 != null) && (
              <p className="text-[11px] text-brand-muted">{ov.attended_90 || 0} aulas · {ov.absent_90 || 0} faltas</p>
            )}
          </div>
        </div>

        {/* Horário fixo */}
        <div>
          <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-brand-muted">
            <CalendarClock size={12} /> Horário fixo
          </p>
          {student.scheduleSlots.length > 0 ? (
            <div className="flex flex-wrap gap-1.5" title={schedule}>
              {student.scheduleSlots.map(slot => (
                <span key={`${slot.day}-${slot.time}`} className="rounded-xl border border-brand-border bg-brand-surface px-2.5 py-1 text-xs font-black text-brand-text">
                  {slot.day} <span className="font-semibold text-brand-muted">{slot.time}</span>
                </span>
              ))}
            </div>
          ) : (
            <p className="rounded-xl border border-dashed border-brand-border px-3 py-2 text-xs font-semibold text-brand-muted">
              {stage === 'active' ? 'Sem aula fixa na agenda' : 'Horários liberados'}
            </p>
          )}
        </div>

        {/* Por que pede atenção */}
        {attention && (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-rose-900 dark:border-rose-500/30 dark:bg-rose-950/30 dark:text-rose-200">
            <p className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest">
              <AlertTriangle size={12} /> {ov?.risk_level === 'HIGH' ? 'Risco alto' : 'Pede atenção'}
            </p>
            <p className="mt-1 text-xs font-semibold leading-relaxed">{reasons.join(' · ')}</p>
          </div>
        )}

        {(interests.length > 0 || occupation) && (
          <div className="flex flex-wrap gap-1.5">
            {occupation && (
              <span className="rounded-lg bg-brand-surface-2 px-2 py-1 text-[10px] font-bold text-brand-muted">{occupation}</span>
            )}
            {interests.slice(0, 4).map(interest => (
              <span key={interest} className="rounded-lg bg-orange-100 px-2 py-1 text-[10px] font-bold text-orange-700 dark:bg-orange-900/30 dark:text-orange-300">{interest}</span>
            ))}
            {interests.length > 4 && <span className="px-1 py-1 text-[10px] font-bold text-brand-muted">+{interests.length - 4}</span>}
          </div>
        )}

        <div className="mt-auto space-y-2 pt-1">
          {/* Ações do dia a dia */}
          <div className={`grid gap-2 ${permissions.canChangeSchedule ? 'grid-cols-4' : 'grid-cols-3'}`}>
            <QuickAction
              icon={<MessageCircle size={18} className="text-emerald-600 dark:text-emerald-400" />}
              label="WhatsApp" tone="hover:bg-emerald-50 dark:hover:bg-emerald-950/30"
              disabled={!phone}
              title={phone ? `Abrir conversa com ${firstName} no WhatsApp` : 'Aluno sem telefone cadastrado'}
              onClick={() => window.open(`https://wa.me/${phone}?text=${encodeURIComponent(`Olá, ${firstName}! 🐺`)}`, '_blank', 'noopener')}
            />
            <QuickAction
              icon={<Folder size={18} className="text-violet-600 dark:text-violet-400" />}
              label="Materiais" tone="hover:bg-violet-50 dark:hover:bg-violet-950/30"
              title={`Materiais de ${firstName}`} onClick={onMaterials}
            />
            <QuickAction
              icon={<Brain size={18} className="text-indigo-600 dark:text-indigo-400" />}
              label="Wolf AI" tone="hover:bg-indigo-50 dark:hover:bg-indigo-950/30"
              title={`Perfil Wolf Intelligence de ${firstName}`} onClick={onWolf}
            />
            {permissions.canChangeSchedule && (
              <QuickAction
                icon={<CalendarCheck size={18} className="text-cyan-600 dark:text-cyan-400" />}
                label="Agenda" tone="hover:bg-cyan-50 dark:hover:bg-cyan-950/30"
                disabled={stage !== 'active'}
                title="Trocar dia ou horário combinado com o aluno" onClick={onSchedule}
              />
            )}
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onOpenProfile}
              className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-2xl bg-tenant-primary px-3 text-xs font-black uppercase tracking-wide text-white shadow-lg shadow-tenant-primary/20 transition-transform hover:scale-[1.02]"
              aria-label={`Ver ficha completa de ${student.name}`}
            >
              <Eye size={15} /> Ficha 360°
            </button>
            {permissions.canEdit && (
              <button
                type="button"
                onClick={onEdit}
                className="flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-2xl border border-brand-border px-3 text-xs font-black uppercase text-brand-muted transition-colors hover:bg-brand-surface-2 hover:text-brand-text"
                title={permissions.canManageLifecycle ? 'Editar cadastro' : 'Editar dados pedagógicos'}
                aria-label={`Editar perfil de ${student.name}`}
              >
                <Edit3 size={15} /> <span className="hidden sm:inline">Editar</span>
              </button>
            )}
          </div>

          {permissions.canManageLifecycle && stage !== 'offboarded' && (
            <div className="flex gap-2 border-t border-brand-border pt-2">
              <button
                type="button"
                onClick={onToggleStatus}
                className={`flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-xl text-[11px] font-black uppercase transition-colors ${stage === 'paused' ? 'text-emerald-700 hover:bg-emerald-50 dark:text-emerald-300 dark:hover:bg-emerald-950/30' : 'text-amber-700 hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-950/30'}`}
                title={stage === 'paused' ? 'Reativar matrícula e assinatura' : 'Pausar temporariamente; ação reversível'}
                aria-label={stage === 'paused' ? `Reativar matrícula de ${student.name}` : `Pausar temporariamente a matrícula de ${student.name}`}
              >
                {stage === 'paused' ? <PlayCircle size={14} /> : <PauseCircle size={14} />}
                {stage === 'paused' ? 'Reativar' : 'Pausar'}
              </button>
              <button
                type="button"
                onClick={onOffboard}
                className="flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-xl text-[11px] font-black uppercase text-red-700 transition-colors hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/30"
                title="Encerrar matrícula definitivamente"
                aria-label={`Encerrar definitivamente a matrícula de ${student.name}`}
              >
                <AlertTriangle size={14} /> Encerrar
              </button>
            </div>
          )}
        </div>
      </div>
    </article>
  );
};

export default StudentRosterCard;
