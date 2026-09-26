/**
 * Link com login do dossiê do aluno (migration 20260928100000).
 *
 * O substituto (cobertura confirmada, reposição com data) e o novo titular de
 * uma transferência recebem no WhatsApp `<portal>/dossie-do-aluno?aluno=<id>` —
 * nunca o conteúdo do dossiê em texto. O servidor monta o link em
 * `coverage_briefing_enqueue` e em `private.teacher_transfer_dossier_enqueue`
 * com este MESMO caminho.
 *
 * O link é só DESTINO, não autorização: sem login a tela é a de login; logado,
 * abre "Salas e continuidade" com o dossiê daquele aluno, e quem decide se a
 * pessoa lê é o servidor (`get_student_handover` → can_read_student_pedagogy:
 * professor do aluno, transferência aceita, substituto ou reposição do dia
 * anterior ao seguinte da aula, coordenação e direção).
 */
export const STUDENT_DOSSIER_PATH = '/dossie-do-aluno';

/** Recusa do servidor ao abrir pelo link: explica o prazo em vez de "vinculação". */
export const DOSSIER_LINK_DENIED =
  'Este dossiê não está liberado para você agora. Quem cobre uma aula ou dá uma reposição marcada lê o dossiê do dia anterior ao dia seguinte da aula; fora disso, fale com a coordenação.';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Papéis que têm a aba "Salas e continuidade" (onde o dossiê abre).
const DOSSIER_ROLES = new Set(['TEACHER', 'COORDINATOR', 'SCHOOL_ADMIN']);

export interface StudentDossierDestination {
  tab: 'lesson-sessions';
  studentId: string;
}

export function studentDossierDestination(
  location: { pathname: string; search: string },
  user: { id: string; role: string } | null | undefined,
): StudentDossierDestination | null {
  if (!user?.id || !DOSSIER_ROLES.has(user.role)) return null;
  const path = location.pathname.replace(/\/+$/, '') || '/';
  if (path !== STUDENT_DOSSIER_PATH) return null;
  const studentId = new URLSearchParams(location.search).get('aluno')?.trim() ?? '';
  if (!UUID_PATTERN.test(studentId)) return null;
  return { tab: 'lesson-sessions', studentId: studentId.toLowerCase() };
}
