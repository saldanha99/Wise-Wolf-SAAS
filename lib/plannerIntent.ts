/**
 * "Planejar esta aula": o botão em Aulas de Hoje manda o professor para o
 * Planner IA já com o aluno escolhido. A intenção viaja pelo sessionStorage
 * (a troca de aba é por estado do App, sem rota), e é consumida uma vez só —
 * abrir o Planner pelo menu depois não reaproveita um aluno antigo.
 */
export interface PlannerIntent {
  studentId: string;
  studentName?: string;
  /** Objetivo sugerido para a caixa de pedido (ex.: "aula de hoje às 16:30"). */
  request?: string;
}

const KEY = 'wisewolf.planner.intent';

export function setPlannerIntent(intent: PlannerIntent): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(intent));
  } catch {
    // Sem storage (modo privado, cota): o professor escolhe o aluno na mão.
  }
}

export function takePlannerIntent(): PlannerIntent | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    sessionStorage.removeItem(KEY);
    const parsed = JSON.parse(raw) as Partial<PlannerIntent>;
    if (!parsed || typeof parsed.studentId !== 'string' || !parsed.studentId) return null;
    return {
      studentId: parsed.studentId,
      studentName: typeof parsed.studentName === 'string' ? parsed.studentName : undefined,
      request: typeof parsed.request === 'string' ? parsed.request : undefined,
    };
  } catch {
    return null;
  }
}
