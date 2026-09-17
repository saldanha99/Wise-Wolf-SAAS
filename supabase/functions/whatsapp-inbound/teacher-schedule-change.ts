/**
 * PROFESSOR TROCA HORÁRIO DO ALUNO PELO WHATSAPP — leitura do pedido e texto da
 * confirmação. Sem banco e sem rede; quem resolve nomes, guarda a proposta e
 * aplica (agindo como o professor) é o `index.ts` com as RPCs
 * `teacher_schedule_change_*` (migration 20260917190000).
 *
 * O caso (Teacher Mateus, 17/09/2026): "O aluno Felipe trocou pra 14:30 e a
 * Isabella para as 14" — a coordenação fazia na mão. Agora o bot mostra o que
 * entendeu (aluno, dia, atual → novo), pergunta "confirma?" e aplica no SIM.
 */

export interface ScheduleChangeEntry {
  name: string;
  newTime: string;
  newDay: string | null;
  oldTime: string | null;
  oldDay: string | null;
}

export interface CandidateSlot {
  booking_id: string;
  day: string;
  time: string;
}

export interface CandidateStudent {
  student_id: string;
  student_name: string;
  slots: CandidateSlot[];
}

export interface ProposedChange {
  booking_id: string;
  day: string;
  old_time: string;
  new_day: string;
  new_time: string;
}

export interface ProposedStudent {
  student_id: string;
  student_name: string;
  changes: ProposedChange[];
  /** Aulas do aluno que já estavam no horário pedido (não mudam). */
  already: CandidateSlot[];
  /** Mudanças que chocam com outra aula fixa do professor (ficam de fora). */
  conflicts?: Array<ProposedChange & { occupant: string }>;
}

/** Aula fixa na agenda do professor (para o choque ser dito ANTES do "confirma?"). */
export interface BusySlot {
  booking_id: string;
  day: string;
  time: string;
  student_name: string;
}

/**
 * Separa, antes de perguntar, o que choca com outra aula do professor. Aula
 * que a PRÓPRIA proposta tira do lugar não ocupa mais o slot (Isabella vai
 * para quinta 14:00, de onde o Felipe sai para 14:30) — por isso o conjunto
 * das aulas em movimento é descontado da agenda ocupada.
 */
export function annotateConflicts(
  students: ProposedStudent[],
  busy: BusySlot[],
): ProposedStudent[] {
  const moving = new Set(
    students.flatMap((st) => st.changes.map((c) => c.booking_id)),
  );
  return students.map((st) => {
    const changes: ProposedChange[] = [];
    const conflicts: Array<ProposedChange & { occupant: string }> = [];
    for (const c of st.changes) {
      const hit = busy.find((b) =>
        b.booking_id !== c.booking_id && !moving.has(b.booking_id) &&
        b.day === c.new_day && b.time === c.new_time
      );
      if (hit) conflicts.push({ ...c, occupant: hit.student_name });
      else changes.push(c);
    }
    return { ...st, changes, conflicts };
  });
}

const fold = (text: string): string =>
  String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase();

const WEEKDAYS: Record<string, string> = {
  segunda: "Segunda",
  terca: "Terça",
  quarta: "Quarta",
  quinta: "Quinta",
  sexta: "Sexta",
  sabado: "Sábado",
};

const CHANGE_VERB =
  /\b(trocou|mudou|passou|alterou|vai passar|vai mudar|vai trocar|passa|muda|troca|mudar|trocar|alterar|remarcou|ficou)\b/;
const TIME =
  /\b(\d{1,2})(?:\s*[:h]\s*(\d{2})|\s*h)?\b(?!\s*(?:dias?|min|minutos|meses|anos|x\b))/;

function normalizeTime(hour: string, minute?: string): string | null {
  const h = Number(hour);
  const m = minute ? Number(minute) : 0;
  if (!Number.isFinite(h) || h < 6 || h > 23) return null;
  if (m !== 0 && m !== 30) return null;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function findTimes(text: string): string[] {
  const out: string[] = [];
  for (
    const m of text.matchAll(
      /\b(\d{1,2})(?:\s*[:h]\s*(\d{2})|\s*h)?\b(?!\s*(?:dias?|min|minutos|meses|anos|x\b))/g,
    )
  ) {
    const t = normalizeTime(m[1], m[2]);
    if (t) out.push(t);
  }
  return out;
}

function findDays(text: string): string[] {
  const out: string[] = [];
  for (const [key, name] of Object.entries(WEEKDAYS)) {
    if (new RegExp(`\\b${key}s?(?:-feira)?\\b`).test(text)) out.push(name);
  }
  return out;
}

/**
 * Nome do aluno no pedaço: o que vem antes do verbo/preposição de troca, sem
 * "o aluno"/"a aluna"/artigo. Devolve null se sobrar nada parecido com nome.
 */
function extractName(segment: string): string | null {
  let s = segment.replace(/^\s*(?:e\s+)?/, "");
  s = s.replace(/^(?:o|a|os|as)\s+(?:alun[oa]s?|estudante)\s+/i, "");
  s = s.replace(/^(?:o|a)\s+/i, "");
  const m = s.match(
    /^([a-z][a-z' ]{1,60}?)\s+(?:trocou|mudou|passou|alterou|vai|passa|muda|troca|remarcou|ficou|de\b|das\b|para\b|pra\b|as\b|às\b|no\b|na\b)/,
  );
  const name = (m ? m[1] : "").trim();
  if (!name || /^(?:aula|aulas|horario|horarios)$/.test(name)) return null;
  return name;
}

/**
 * "O aluno Felipe trocou pra 14:30 e a Isabella para as 14" → duas entradas.
 * "Ana de segunda 14:00 para quarta 15:00" → uma entrada com origem e destino.
 * Sem verbo de troca e sem preposição de destino, ou sem horário, devolve null.
 */
export function parseTeacherScheduleChange(
  text: string,
): ScheduleChangeEntry[] | null {
  const source = fold(text).replace(/[\n\r]+/g, " ").replace(/\s+/g, " ")
    .trim();
  if (!source) return null;
  const hasVerb = CHANGE_VERB.test(source);
  const hasDestination = /\b(?:para|pra|as|às)\b/.test(source);
  if (!hasVerb && !hasDestination) return null;
  if (!TIME.test(source)) return null;

  // Divide em pedidos: " e " seguido de um nome + destino/verbo com horário.
  const segments = source.split(
    /\s+e\s+(?=(?:o|a)\s+(?:alun[oa]\s+)?[a-z]|[a-z][a-z']+\s+(?:trocou|mudou|passou|para|pra|de|das|vai|fica|ficou))/,
  );
  const entries: ScheduleChangeEntry[] = [];
  for (const raw of segments) {
    const segment = raw.trim();
    if (!segment) continue;
    const times = findTimes(segment);
    if (!times.length) continue;
    const name = extractName(segment);
    if (!name) continue;
    const days = findDays(segment);
    let oldTime: string | null = null;
    let newTime: string;
    let oldDay: string | null = null;
    let newDay: string | null = null;
    // "de X para Y" / "das X para as Y": origem e destino explícitos.
    const fromTo = segment.match(
      /\b(?:de|das?)\s+(?:(segunda|terca|quarta|quinta|sexta|sabado)\S*\s+)?(?:as\s+|às\s+)?(\d{1,2}(?:\s*[:h]\s*\d{2}|\s*h)?)\b[^0-9]{0,30}?\b(?:para|pra)\s+(?:as\s+|às\s+|a\s+)?(?:(segunda|terca|quarta|quinta|sexta|sabado)\S*\s+)?(?:as\s+|às\s+)?(\d{1,2}(?:\s*[:h]\s*\d{2}|\s*h)?)\b/,
    );
    if (fromTo) {
      const [, dayA, timeA, dayB, timeB] = fromTo;
      oldTime = findTimes(timeA)[0] || null;
      newTime = findTimes(timeB)[0] || times[times.length - 1];
      oldDay = dayA ? WEEKDAYS[dayA] || null : null;
      newDay = dayB ? WEEKDAYS[dayB] || null : null;
    } else {
      newTime = times[times.length - 1];
      if (days.length === 1) newDay = days[0];
      else if (days.length === 2) {
        oldDay = days[0];
        newDay = days[1];
      }
    }
    entries.push({ name, newTime, newDay, oldTime, oldDay });
  }
  return entries.length ? entries : null;
}

/**
 * Casa a entrada com as aulas do aluno: com dia/horário de origem, só as que
 * batem; sem origem, todas as aulas que ainda não estão no horário novo. Aula
 * que já está no horário pedido não muda (e é dita na confirmação).
 */
export function proposeChanges(
  entry: ScheduleChangeEntry,
  student: CandidateStudent,
): ProposedStudent {
  const changes: ProposedChange[] = [];
  const already: CandidateSlot[] = [];
  for (const slot of student.slots) {
    if (entry.oldDay && slot.day !== entry.oldDay) continue;
    if (entry.oldTime && slot.time !== entry.oldTime) continue;
    if (
      !entry.oldDay && !entry.oldTime && entry.newDay &&
      slot.day !== entry.newDay
    ) {
      continue;
    }
    const newDay = entry.newDay && entry.oldDay ? entry.newDay : slot.day;
    if (slot.time === entry.newTime && newDay === slot.day) {
      already.push(slot);
      continue;
    }
    changes.push({
      booking_id: slot.booking_id,
      day: slot.day,
      old_time: slot.time,
      new_day: newDay,
      new_time: entry.newTime,
    });
  }
  return {
    student_id: student.student_id,
    student_name: student.student_name,
    changes,
    already,
  };
}

const firstName = (raw: string | null | undefined): string =>
  String(raw || "").trim().split(/\s+/)[0] || "";

function ddmm(iso: string): string {
  const [y, m, d] = String(iso || "").split("-");
  return y && m && d ? `${d}/${m}` : iso;
}

/** O que o bot entendeu, para o professor confirmar. */
export function scheduleChangeConfirmationMessage(input: {
  students: ProposedStudent[];
  unknownNames: string[];
  ambiguous: Array<{ name: string; options: string[] }>;
  effectiveFrom: string;
}): string {
  const lines: string[] = [];
  const withChanges = input.students.filter((s) => s.changes.length > 0);
  if (withChanges.length) {
    lines.push("Entendi a troca de horário:");
    for (const student of withChanges) {
      lines.push(`\n*${student.student_name}*`);
      for (const c of student.changes) {
        lines.push(
          c.new_day !== c.day
            ? `• ${c.day} ${c.old_time} → ${c.new_day} ${c.new_time}`
            : `• ${c.day} ${c.old_time} → ${c.new_time}`,
        );
      }
      for (const c of student.conflicts || []) {
        lines.push(
          `⚠️ ${c.day} ${c.old_time} → ${c.new_time}: ${c.new_day} ${c.new_time} já é de ${
            firstName(c.occupant)
          } — essa fica como está.`,
        );
      }
      if (student.already.length) {
        lines.push(
          `_(${
            student.already.map((s) => `${s.day} ${s.time}`).join(", ")
          } já ${student.already.length === 1 ? "está" : "estão"} assim)_`,
        );
      }
    }
  }
  for (const student of input.students.filter((s) => !s.changes.length)) {
    const conflicts = student.conflicts || [];
    if (conflicts.length) {
      lines.push(
        `\n*${student.student_name}*: ${
          conflicts.map((c) =>
            `${c.new_day} ${c.new_time} já é de ${firstName(c.occupant)}`
          ).join("; ")
        } — não dá para mudar sem mexer nessa outra aula. Me diz outro horário ou fala com a coordenação.`,
      );
      continue;
    }
    lines.push(
      `\n*${student.student_name}*: as aulas já estão nesse horário (${
        student.already.map((s) => `${s.day} ${s.time}`).join(", ")
      }) — nada a mudar.`,
    );
  }
  for (const a of input.ambiguous) {
    lines.push(
      `\nTem mais de um(a) *${a.name}* na sua agenda: ${
        a.options.join(" ou ")
      }. Me diz o nome completo.`,
    );
  }
  for (const name of input.unknownNames) {
    lines.push(
      `\nNão achei *${name}* entre os seus alunos com aula fixa — confere o nome?`,
    );
  }
  if (withChanges.length) {
    lines.push(
      `\nVale a partir de ${
        ddmm(input.effectiveFrom)
      }; as aulas anteriores ficam no horário antigo. Confirma? Responda *sim* ou *não*.`,
    );
  }
  return lines.join("\n").trim();
}

/** Resultado da aplicação, aula a aula, para o professor. */
export function scheduleChangeAppliedMessage(input: {
  applied: Array<{
    student_name: string;
    day: string;
    old_time: string;
    new_day: string;
    new_time: string;
  }>;
  errors: Array<{
    student_name: string;
    day: string;
    old_time: string;
    new_day: string;
    new_time: string;
    occupant?: string | null;
    error: string;
  }>;
  effectiveFrom: string;
}): string {
  const lines: string[] = [];
  const byStudent = (rows: Array<{ student_name: string }>) => {
    const map = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = map.get(row.student_name) || [];
      list.push(row);
      map.set(row.student_name, list);
    }
    return map;
  };
  if (input.applied.length) {
    lines.push(`✅ Atualizado a partir de ${ddmm(input.effectiveFrom)}:`);
    for (const [student, rows] of byStudent(input.applied)) {
      lines.push(
        `*${student}*: ${
          (rows as typeof input.applied).map((r) =>
            r.new_day !== r.day
              ? `${r.day} ${r.old_time} → ${r.new_day} ${r.new_time}`
              : `${r.day} ${r.old_time} → ${r.new_time}`
          ).join(", ")
        }`,
      );
    }
  }
  if (input.errors.length) {
    lines.push(input.applied.length ? "\nNão mudou:" : "Não consegui mudar:");
    for (const e of input.errors) {
      const occupant = e.occupant
        ? ` — ${e.occupant} já está nesse horário`
        : "";
      const reason = /choque de agenda/i.test(e.error)
        ? `${e.new_day} ${e.new_time} ocupado${occupant}`
        : e.error;
      lines.push(
        `⚠️ *${
          firstName(e.student_name)
        }* ${e.day} ${e.old_time}: ${reason}. Ficou como estava.`,
      );
    }
  }
  if (input.applied.length) {
    lines.push(
      "\nA agenda já está com o horário novo e a Gestão foi avisada no grupo.",
    );
  }
  if (!input.applied.length && !input.errors.length) {
    lines.push("Nada precisou mudar — as aulas já estavam nesse horário.");
  }
  return lines.join("\n");
}
