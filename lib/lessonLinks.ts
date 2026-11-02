/**
 * Links das aulas vindos de `my_lesson_links` (o servidor decide qual link vale:
 * sala da escola, sala ainda sendo preparada, link pessoal ou nenhum). Aqui fica
 * só o que a tela precisa: ler a resposta, achar a aula que vai começar e
 * montar o link de entrada da direção.
 */

export type LessonLinkKind = 'escola' | 'preparando' | 'pessoal' | 'sem_link';

export interface LessonLink {
  kind: 'aula' | 'experimental';
  id: string;
  classDate: string;
  startsAt: Date;
  endsAt: Date;
  teacherId: string | null;
  teacherName: string;
  studentId: string | null;
  studentName: string;
  link: string | null;
  linkKind: LessonLinkKind;
}

export interface LessonLinksResult {
  lessons: LessonLink[];
  organizerEmail: string | null;
}

const KINDS: LessonLinkKind[] = ['escola', 'preparando', 'pessoal', 'sem_link'];

function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function parseLessonLinks(data: unknown): LessonLinksResult {
  const root = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const rows = Array.isArray(root.lessons) ? root.lessons : [];
  const lessons: LessonLink[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const startsAt = new Date(String(r.starts_at || ''));
    const endsAt = new Date(String(r.ends_at || ''));
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || !r.id) continue;
    const linkKind = KINDS.includes(r.link_kind as LessonLinkKind) ? (r.link_kind as LessonLinkKind) : 'sem_link';
    const link = linkKind === 'preparando' || linkKind === 'sem_link' ? null : httpsUrl(r.link);
    lessons.push({
      kind: r.kind === 'experimental' ? 'experimental' : 'aula',
      id: String(r.id),
      classDate: String(r.class_date || ''),
      startsAt,
      endsAt,
      teacherId: r.teacher_id ? String(r.teacher_id) : null,
      teacherName: String(r.teacher_name || 'Professor'),
      studentId: r.student_id ? String(r.student_id) : null,
      studentName: String(r.student_name || (r.kind === 'experimental' ? 'Aula experimental' : 'Aluno')),
      link,
      // Link que não passou na validação não pode ser anunciado como pronto.
      linkKind: link || linkKind === 'preparando' ? linkKind : 'sem_link',
    });
  }
  lessons.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const organizer = typeof root.organizer_email === 'string' && root.organizer_email.includes('@') ? root.organizer_email : null;
  return { lessons, organizerEmail: organizer };
}

export type LessonMoment = 'encerrada' | 'agora' | 'em_breve' | 'depois';

/** "Em breve" = começa nos próximos `soonMinutes`. */
export function lessonMoment(lesson: LessonLink, now: Date, soonMinutes = 10): LessonMoment {
  const t = now.getTime();
  if (t >= lesson.endsAt.getTime()) return 'encerrada';
  if (t >= lesson.startsAt.getTime()) return 'agora';
  if (lesson.startsAt.getTime() - t <= soonMinutes * 60_000) return 'em_breve';
  return 'depois';
}

/**
 * Aula do aviso: começa em até 10 minutos ou começou há menos de 10 (quem
 * entra atrasado na plataforma ainda vê o link). Fechada = não volta.
 */
export function lessonToAnnounce(lessons: LessonLink[], now: Date, dismissed: ReadonlySet<string>): LessonLink | null {
  const t = now.getTime();
  return lessons.find(lesson => {
    if (dismissed.has(lessonKey(lesson))) return false;
    const start = lesson.startsAt.getTime();
    return t >= start - 10 * 60_000 && t < Math.min(start + 10 * 60_000, lesson.endsAt.getTime());
  }) || null;
}

export function lessonKey(lesson: LessonLink): string {
  return `${lesson.kind}:${lesson.id}:${lesson.startsAt.toISOString()}`;
}

/**
 * Link da direção: a sala da escola pertence à conta central; `authuser` abre
 * o Meet já nessa conta, que entra sem pedir para participar. Link pessoal de
 * aluno/professor não é da escola: abre como está (aí é preciso ser admitido).
 */
export function directorJoinUrl(lesson: LessonLink, organizerEmail: string | null): string | null {
  if (!lesson.link) return null;
  if (lesson.linkKind !== 'escola' || !organizerEmail) return lesson.link;
  const url = new URL(lesson.link);
  url.searchParams.set('authuser', organizerEmail);
  return url.toString();
}

export function formatLessonTime(date: Date): string {
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
}

export const LINK_KIND_LABEL: Record<LessonLinkKind, string> = {
  escola: 'Sala da escola',
  preparando: 'Sala sendo preparada',
  pessoal: 'Link pessoal',
  sem_link: 'Sem link',
};
