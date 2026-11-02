import { useCallback, useEffect, useState } from 'react';

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

export interface StudentDossierLinkState {
  /** Aluno cujo dossiê o link abriu, enquanto a pessoa estiver nele. */
  focusStudentId: string | null;
  /**
   * Tour (boas-vindas ou novidade) fica esperando enquanto o dossiê do link
   * está aberto: o tour troca de aba no primeiro passo e tiraria a pessoa do
   * dossiê que ela acabou de abrir — e o link já teria sido usado.
   */
  holdsTours: boolean;
  /** A pessoa saiu do dossiê do link (fechou, abriu outra coisa, pediu um tour). */
  release: () => void;
}

/**
 * O link no App. A URL volta para "/" na hora (o dossiê abre só nesta visita),
 * mas o FOCO fica guardado até a pessoa sair do dossiê — "Fechar dossiê",
 * outra sessão ou outro dossiê no painel, outra tela pelo menu. Enquanto isso o
 * painel reabre o dossiê se for montado de novo e os tours esperam.
 */
export function useStudentDossierLink(
  user: { id: string; role: string } | null | undefined,
  activeTab: string,
  setActiveTab: (tab: string) => void,
): StudentDossierLinkState {
  const [focusStudentId, setFocusStudentId] = useState<string | null>(null);
  const userId = user?.id;
  const userRole = user?.role;
  useEffect(() => {
    const destination = studentDossierDestination(
      window.location,
      userId && userRole ? { id: userId, role: userRole } : null,
    );
    if (!destination) return;
    setActiveTab(destination.tab);
    setFocusStudentId(destination.studentId);
    try {
      window.history.replaceState(window.history.state, '', '/');
    } catch {
      // Sem history (navegador restrito): o dossiê abre do mesmo jeito.
    }
  }, [userId, userRole, setActiveTab]);
  // Foi para outra tela pelo menu com o dossiê aberto: o link já foi usado.
  useEffect(() => {
    if (focusStudentId && activeTab !== 'lesson-sessions') setFocusStudentId(null);
  }, [activeTab, focusStudentId]);
  const release = useCallback(() => setFocusStudentId(null), []);
  return { focusStudentId, holdsTours: focusStudentId !== null, release };
}
