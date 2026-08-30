/**
 * Início em um toque.
 *
 * Motivo: o funil real mostrou 52 alunos ativos e só 16 que já usaram o
 * Wolfie. O caminho era um wizard de 4 etapas — Experiência (29 a 67 opções),
 * Nível, Setor, Formato — antes de a IA rodar. E 85% dos alunos já têm nível
 * cadastrado: o wizard perguntava o que o sistema já sabia.
 *
 * Aqui decidimos um ponto de partida a partir do que já é conhecido. O wizard
 * continua existindo como escolha deliberada, não como pedágio.
 */

import type {
  CefrLevel,
  WolfieOverview,
  WolfieRecentSession,
  WolfieSelection,
  WolfieSubject,
  WolfieUserSummary,
} from "./types.ts";

const CEFR: readonly CefrLevel[] = ["A1", "A2", "B1", "B2", "C1", "C2"];

/** Nível intermediário: erra menos para ambos os lados quando nada se sabe. */
const FALLBACK_LEVEL: CefrLevel = "B1";

/** Conversação é o formato mais usado (375 sessões contra 20 do wizard). */
const FALLBACK_SUBJECT: WolfieSubject = "conversation" as WolfieSubject;

/**
 * Extrai um nível CEFR de texto livre. `module` vem digitado por humano
 * ("B1", "Inglês B1", "b1 - intermediário"), então não dá para comparar direto.
 */
export function parseCefrLevel(value: unknown): CefrLevel | null {
  if (typeof value !== "string") return null;
  const match = value.toUpperCase().match(/\b([ABC][12])\b/);
  if (!match) return null;
  const found = match[1] as CefrLevel;
  return CEFR.includes(found) ? found : null;
}

/**
 * Nível conhecido, em ordem de confiança: o que a IA estimou observando o
 * aluno vale mais que o cadastro manual, que vale mais que o chute.
 */
export function resolveKnownLevel(
  estimatedLevel: unknown,
  profileModule: unknown,
): { level: CefrLevel; known: boolean } {
  const estimated = parseCefrLevel(estimatedLevel);
  if (estimated) return { level: estimated, known: true };
  const declared = parseCefrLevel(profileModule);
  if (declared) return { level: declared, known: true };
  return { level: FALLBACK_LEVEL, known: false };
}

/** A sessão mais recente que valha a pena repetir como ponto de partida. */
export function lastMeaningfulSession(
  overview: WolfieOverview | null,
): WolfieRecentSession | null {
  const recent = overview?.recentSessions ?? [];
  for (const session of recent) {
    // "conversation" não é um subject gerável pelo fluxo de atividades.
    if (session.subject && session.subject !== "conversation") return session;
  }
  return null;
}

export interface WolfieAssignment {
  id: string;
  topic: string;
  note?: string | null;
  teacher_name?: string | null;
}

export interface QuickStartPlan {
  /** Preenchido quando a prática nasce de uma tarefa do professor. */
  assignmentId?: string;
  selection: WolfieSelection;
  /** Rótulo curto para o botão, no idioma do aluno. */
  label: string;
  /** Por que este ponto de partida — mostrado em letra pequena. */
  reason: string;
  /** Falso quando tivemos de chutar o nível; a UI oferece ajuste. */
  levelKnown: boolean;
}

/**
 * Monta o ponto de partida. Nunca falha: sempre devolve algo praticável, ou o
 * aluno voltaria a encarar o wizard, que é exatamente o problema.
 */
export function buildQuickStartPlan(
  user: WolfieUserSummary | null,
  overview: WolfieOverview | null,
  estimatedLevel?: unknown,
  assignment?: WolfieAssignment | null,
): QuickStartPlan {
  const { level, known } = resolveKnownLevel(estimatedLevel, user?.module);
  const previous = lastMeaningfulSession(overview);

  // A tarefa do professor vence tudo: é o único empurrão que vem de fora e
  // ataca o motivo real de o Wolfie ser pouco usado — ninguém pedir.
  if (assignment?.topic) {
    return {
      assignmentId: assignment.id,
      selection: {
        subject: FALLBACK_SUBJECT,
        level: previous?.cefr_level ?? level,
        sector: assignment.topic,
      },
      label: "Fazer a tarefa",
      reason: assignment.teacher_name
        ? `${assignment.teacher_name.split(" ")[0]} pediu: ${assignment.topic}`
        : `Tarefa do professor: ${assignment.topic}`,
      levelKnown: true,
    };
  }

  if (previous) {
    return {
      selection: {
        subject: previous.subject as WolfieSubject,
        level: previous.cefr_level ?? level,
        sector: previous.sector ?? undefined,
      },
      label: "Continuar praticando",
      reason: "Retoma de onde você parou.",
      levelKnown: true,
    };
  }

  const sector = typeof user?.occupation === "string" && user.occupation.trim()
    ? user.occupation.trim()
    : undefined;

  return {
    selection: { subject: FALLBACK_SUBJECT, level, sector },
    label: "Começar a praticar",
    reason: known
      ? `Conversa livre no seu nível (${level}).`
      : "Conversa livre. Ajustamos o nível conforme você fala.",
    levelKnown: known,
  };
}

/**
 * Há sessão inacabada para retomar? É o atalho mais forte: o aluno já investiu
 * esforço nela.
 */
export function resumableSession(overview: WolfieOverview | null) {
  return overview?.resumableSessions?.[0] ?? null;
}
