/**
 * PROFESSOR MARCA / REMARCA / DESMARCA REPOSIÇÃO PELO WHATSAPP — leitura do
 * pedido e textos de confirmação. Sem banco e sem rede; quem resolve o aluno
 * nas reposições abertas, guarda a proposta e aplica (agindo como o professor,
 * pela MESMA RPC da tela) é o `index.ts` com as RPCs
 * `teacher_reschedule_*` (migration 20260918110000).
 *
 * O caso (Flávio, 18/09/2026): "passou a reposição que tinha marcado para
 * hoje" e a direção não sabia horário nem motivo — a reposição nem existia no
 * sistema. Agora: "a reposição do Theo passou para terça 15h" → o bot mostra o
 * que entendeu, pergunta "confirma?" (e o motivo) e aplica no SIM. A trilha
 * grava origem `whatsapp_professor`; coordenação e família são avisadas.
 */

export type RescheduleMoveAction = "marcar" | "remarcar" | "desmarcar";

export interface RescheduleMoveEntry {
  /** Nome do aluno como escrito (sem acento, minúsculo); null = "minha reposição". */
  name: string | null;
  action: RescheduleMoveAction;
  /** Data alvo (YYYY-MM-DD) — só para marcar/remarcar. */
  date: string | null;
  /** Horário alvo (HH:MM) — só para marcar/remarcar. */
  time: string | null;
  /** Horário de origem citado ("das 16:00 para as 17:00"), para escolher qual reposição. */
  fromTime: string | null;
  /** Motivo dito na própria mensagem ("porque…", "motivo: …"). */
  reason: string | null;
}

export interface OpenReschedule {
  id: string;
  date: string;
  time: string;
  fault_type: string | null;
  marcada: boolean;
}

export interface RescheduleCandidateStudent {
  student_id: string;
  student_name: string;
  reschedules: OpenReschedule[];
}

export interface RescheduleProposalItem {
  action: RescheduleMoveAction;
  reschedule_id: string;
  student_name: string;
  from_date: string | null;
  from_time: string | null;
  date: string | null;
  time: string | null;
}

const fold = (text: string): string =>
  String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const WEEKDAY_INDEX: Record<string, number> = {
  domingo: 0,
  segunda: 1,
  terca: 2,
  quarta: 3,
  quinta: 4,
  sexta: 5,
  sabado: 6,
};
const WEEKDAY_SHORT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

function normalizeTime(hour: string, minute?: string): string | null {
  const h = Number(hour);
  const m = minute ? Number(minute) : 0;
  if (!Number.isFinite(h) || h < 6 || h > 23) return null;
  if (m !== 0 && m !== 30) return null;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const TIME_RE =
  /\b(\d{1,2})(?:\s*[:h]\s*(\d{2})|\s*h)\b(?!\s*(?:dias?|min|minutos|meses|anos|x\b))/g;

function findTimes(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TIME_RE)) {
    const t = normalizeTime(m[1], m[2]);
    if (t) out.push(t);
  }
  return out;
}

/** Data de hoje/amanhã/dia da semana/dd/mm no fuso da escola. `now` é a hora em Brasília. */
export function resolveDate(
  text: string,
  now: Date,
  time: string | null,
): string | null {
  const whole = fold(text);
  // "de hoje 20h passou para segunda 20h": o dia que vale é o de DESTINO — o
  // que vem depois do último "para/pra".
  const cut = Math.max(whole.lastIndexOf(" para "), whole.lastIndexOf(" pra "));
  const s = cut >= 0 ? whole.slice(cut) : whole;
  const base = new Date(now.getTime());
  const ymd = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${
      String(d.getDate()).padStart(2, "0")
    }`;
  const explicit = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (explicit) {
    const d = Number(explicit[1]);
    const m = Number(explicit[2]);
    let y = explicit[3] ? Number(explicit[3]) : base.getFullYear();
    if (y < 100) y += 2000;
    const candidate = new Date(y, m - 1, d);
    if (!explicit[3] && candidate.getTime() < base.getTime() - 86400000 * 1) {
      candidate.setFullYear(y + 1);
    }
    return Number.isNaN(candidate.getTime()) ? null : ymd(candidate);
  }
  if (/\bhoje\b/.test(s)) return ymd(base);
  if (/\bamanha\b/.test(s)) {
    const d = new Date(base.getTime() + 86400000);
    return ymd(d);
  }
  const dia = s.match(/\bdia\s+(\d{1,2})\b/);
  if (dia) {
    const d = Number(dia[1]);
    const candidate = new Date(base.getFullYear(), base.getMonth(), d);
    if (candidate.getTime() < base.getTime() - 86400000) {
      candidate.setMonth(candidate.getMonth() + 1);
    }
    return ymd(candidate);
  }
  for (const [key, idx] of Object.entries(WEEKDAY_INDEX)) {
    if (new RegExp(`\\b${key}(?:-feira)?\\b`).test(s)) {
      const todayIdx = base.getDay();
      let delta = (idx - todayIdx + 7) % 7;
      if (delta === 0) {
        // Mesmo dia da semana: é hoje se o horário ainda não passou, senão daqui a 7 dias.
        const hhmm = `${String(base.getHours()).padStart(2, "0")}:${
          String(base.getMinutes()).padStart(2, "0")
        }`;
        if (!time || time <= hhmm) delta = 7;
      }
      const d = new Date(base.getTime() + delta * 86400000);
      return ymd(d);
    }
  }
  return null;
}

/**
 * "a reposição do Theo passou para terça 15h" → remarcar Theo ter 15:00.
 * "marca a reposição da Ana amanhã às 16:30 porque ela pediu" → marcar + motivo.
 * "desmarca a reposição do Vinícius, ele viajou" → desmarcar + motivo.
 * Sem a palavra reposição, devolve null — a troca de horário fixo tem parser próprio.
 */
export function parseTeacherRescheduleMessage(
  text: string,
  now: Date,
): RescheduleMoveEntry | null {
  const source = fold(text).replace(/[\n\r]+/g, " ").replace(/\s+/g, " ")
    .trim();
  if (!source || !/\breposi[cç]/.test(source)) return null;

  let reason: string | null = null;
  const reasonMatch = source.match(
    /\b(?:porque|pq|por que|motivo:?)\s+(.{3,200})$/,
  );
  if (reasonMatch) reason = reasonMatch[1].trim().replace(/[.!]+$/, "");
  const body = reasonMatch ? source.slice(0, reasonMatch.index).trim() : source;

  const isCancel =
    /\b(desmarc\w*|cancel\w*|nao vai (?:mais )?(?:ter|rolar|acontecer)|caiu)\b/
      .test(body);
  const isBook =
    /\b(marc\w*|agend\w*|combin\w*|fic\w* (?:marcad|para|pra))\b/.test(body) &&
    !isCancel;
  const isMove =
    /\b(passou|mudou|remarc\w*|troc\w*|alter\w*|vai passar|vai mudar|passa|muda|adiou|adiar|antecip\w*)\b/
      .test(body);

  // Nome: "reposição do/da/de <nome>" até verbo/preposição.
  let name: string | null = null;
  const nameMatch = body.match(
    /reposi[cç][aã]o\s+(?:d[oa]s?|de)\s+(?:alun[oa]\s+)?([a-z][a-z' ]{1,60}?)(?=\s*[,.;]|\s*$|\s+(?:passou|mudou|remarc|troc|alter|vai|passa|muda|adiou|adiar|antecip|fic|de\b|das?\b|para\b|pra\b|as\b|hoje\b|amanha\b|segunda|terca|quarta|quinta|sexta|sabado|dia\b))/,
  );
  if (nameMatch) name = nameMatch[1].trim();
  if (name && /^(hoje|amanha|minha|meu|essa|esse|aquela|aquele)$/.test(name)) {
    name = null;
  }

  const times = findTimes(body);
  let fromTime: string | null = null;
  let time: string | null = null;
  const fromTo = body.match(
    /\b(?:de|das?)\s+(?:as\s+)?(\d{1,2}(?:\s*[:h]\s*\d{2}|\s*h))\b[^0-9]{0,40}?\b(?:para|pra)\s+(?:as\s+|a\s+)?(?:[a-z-]+\s+)?(?:as\s+)?(\d{1,2}(?:\s*[:h]\s*\d{2}|\s*h))\b/,
  );
  if (fromTo) {
    fromTime = findTimes(fromTo[1])[0] || null;
    time = findTimes(fromTo[2])[0] || null;
  } else if (times.length) {
    time = times[times.length - 1];
  }
  const date = isCancel ? null : resolveDate(body, now, time);

  let action: RescheduleMoveAction;
  if (isCancel) action = "desmarcar";
  else if (isBook && !isMove) action = "marcar";
  else if (isMove) action = "remarcar";
  else if (time || date) action = "marcar";
  else return null;

  if (action !== "desmarcar" && (!time || !date)) {
    // Sem data OU sem horário não dá para marcar — o bot pergunta o que falta.
    return { name, action, date, time, fromTime, reason };
  }
  return { name, action, date, time, fromTime, reason };
}

/** Escolhe a reposição alvo entre as abertas do aluno; devolve o que precisa ser perguntado. */
export function proposeRescheduleMove(
  entry: RescheduleMoveEntry,
  student: RescheduleCandidateStudent,
): { item: RescheduleProposalItem | null; ask: string | null } {
  const dated = student.reschedules.filter((r) => r.marcada);
  const undated = student.reschedules.filter((r) => !r.marcada);
  const first = student.student_name.trim().split(/\s+/)[0] ||
    student.student_name;

  if (entry.action === "desmarcar") {
    if (!dated.length) {
      return {
        item: null,
        ask: `${first} não tem reposição marcada — nada a desmarcar.`,
      };
    }
    const chosen = pickDated(dated, entry.fromTime);
    if (!chosen) {
      return {
        item: null,
        ask: `${first} tem ${dated.length} reposições marcadas (${
          dated.map(fmtSlot).join(", ")
        }). Qual delas? Me diz o horário.`,
      };
    }
    return {
      item: {
        action: "desmarcar",
        reschedule_id: chosen.id,
        student_name: student.student_name,
        from_date: chosen.date,
        from_time: chosen.time,
        date: null,
        time: null,
      },
      ask: null,
    };
  }

  if (!entry.date || !entry.time) {
    return {
      item: null,
      ask: `Para ${
        entry.action === "remarcar" ? "remarcar" : "marcar"
      } a reposição de ${first} preciso do dia e do horário (ex.: terça 15:00).`,
    };
  }

  if (
    entry.action === "remarcar" ||
    (entry.action === "marcar" && !undated.length && dated.length)
  ) {
    if (!dated.length) {
      if (!undated.length) {
        return {
          item: null,
          ask: `${first} não tem reposição em aberto com você.`,
        };
      }
      const chosen = oldest(undated);
      return {
        item: {
          action: "marcar",
          reschedule_id: chosen.id,
          student_name: student.student_name,
          from_date: null,
          from_time: null,
          date: entry.date,
          time: entry.time,
        },
        ask: null,
      };
    }
    const chosen = pickDated(dated, entry.fromTime);
    if (!chosen) {
      return {
        item: null,
        ask: `${first} tem ${dated.length} reposições marcadas (${
          dated.map(fmtSlot).join(", ")
        }). Qual delas muda? Me diz o horário atual.`,
      };
    }
    return {
      item: {
        action: "remarcar",
        reschedule_id: chosen.id,
        student_name: student.student_name,
        from_date: chosen.date,
        from_time: chosen.time,
        date: entry.date,
        time: entry.time,
      },
      ask: null,
    };
  }

  // marcar: a mais antiga sem data.
  if (!undated.length) {
    return {
      item: null,
      ask: `${first} não tem reposição em aberto com você.`,
    };
  }
  const chosen = oldest(undated);
  return {
    item: {
      action: "marcar",
      reschedule_id: chosen.id,
      student_name: student.student_name,
      from_date: null,
      from_time: null,
      date: entry.date,
      time: entry.time,
    },
    ask: null,
  };
}

function pickDated(
  dated: OpenReschedule[],
  fromTime: string | null,
): OpenReschedule | null {
  if (dated.length === 1) return dated[0];
  if (fromTime) {
    const hit = dated.filter((r) => r.time === fromTime);
    if (hit.length === 1) return hit[0];
  }
  return null;
}

function oldest(list: OpenReschedule[]): OpenReschedule {
  return [...list].sort((a, b) =>
    `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`)
  )[0];
}

export function fmtSlot(
  r: { date: string | null; time: string | null },
): string {
  if (!r.date || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
    return r.time || "sem data";
  }
  const [y, m, d] = r.date.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return `${WEEKDAY_SHORT[dt.getDay()]} ${String(d).padStart(2, "0")}/${
    String(m).padStart(2, "0")
  } ${r.time || ""}`.trim();
}

/** O que o bot entendeu, para o professor confirmar (e dizer o motivo). */
export function rescheduleMoveConfirmationMessage(input: {
  item: RescheduleProposalItem | null;
  ask: string | null;
  ambiguous: string[] | null;
  unknownName: string | null;
  reason: string | null;
}): string {
  if (input.ambiguous && input.ambiguous.length) {
    return `Tem mais de um aluno com esse nome nas suas reposições: ${
      input.ambiguous.join(" ou ")
    }. Me diz o nome completo.`;
  }
  if (input.unknownName) {
    return `Não achei *${input.unknownName}* entre os seus alunos com reposição em aberto — confere o nome? (Reposição nasce da falta lançada em Lançar Aula.)`;
  }
  if (input.ask) return input.ask;
  const it = input.item!;
  const first = it.student_name.trim().split(/\s+/)[0] || it.student_name;
  const tail = input.reason
    ? `\nMotivo: ${input.reason}.\n\nConfirma? Responda *sim* ou *não*.`
    : `\n\nConfirma? Responda *sim* — se quiser, com o motivo junto (ex.: "sim, aluno pediu") — ou *não*.`;
  if (it.action === "desmarcar") {
    return `Entendi: *desmarcar* a reposição de *${first}* que estava ${
      fmtSlot({ date: it.from_date, time: it.from_time })
    }. A coordenação e a família serão avisadas.${tail}`;
  }
  if (it.action === "remarcar") {
    return `Entendi: reposição de *${first}* ${
      fmtSlot({ date: it.from_date, time: it.from_time })
    } → *${
      fmtSlot({ date: it.date, time: it.time })
    }*. A coordenação e a família serão avisadas.${tail}`;
  }
  return `Entendi: reposição de *${first}* marcada para *${
    fmtSlot({ date: it.date, time: it.time })
  }*. A coordenação e a família serão avisadas.${tail}`;
}

/** Resultado da aplicação para o professor. */
export function rescheduleMoveAppliedMessage(input: {
  applied: Array<
    RescheduleProposalItem & {
      result?: { event?: { em_cima_da_hora?: boolean } };
    }
  >;
  errors: Array<RescheduleProposalItem & { error: string }>;
}): string {
  const lines: string[] = [];
  for (const a of input.applied) {
    const first = a.student_name.trim().split(/\s+/)[0] || a.student_name;
    const urgent = a.result?.event?.em_cima_da_hora
      ? " ⚠️ (em cima da hora — sai destacado para a coordenação)"
      : "";
    if (a.action === "desmarcar") {
      lines.push(`✅ Reposição de ${first} desmarcada.${urgent}`);
    } else {lines.push(
        `✅ Reposição de ${first}: *${
          fmtSlot({ date: a.date, time: a.time })
        }*.${urgent}`,
      );}
  }
  for (const e of input.errors) {
    const first = e.student_name.trim().split(/\s+/)[0] || e.student_name;
    const why = /must_be_future/.test(e.error)
      ? "esse horário já passou"
      : /participant_inactive/.test(e.error)
      ? "o aluno não está ativo"
      : /motivo_obrigatorio/.test(e.error)
      ? "faltou o motivo"
      : "não consegui aplicar";
    lines.push(`⚠️ Reposição de ${first}: ${why}. Ficou como estava.`);
  }
  if (input.applied.length) {
    lines.push(
      "\nA coordenação e a família já foram avisadas. Depois da aula, lance em *Lançar Aula*.",
    );
  }
  if (!lines.length) lines.push("Nada mudou.");
  return lines.join("\n");
}

/** "sim, aluno pediu" → { yes: true, reason: "aluno pediu" }; "não" → { yes: false }. */
export function parseConfirmationWithReason(
  text: string,
): { yes: boolean; reason: string | null } | null {
  const raw = String(text || "").trim();
  const s = fold(raw);
  if (/^(nao|n|cancela|cancelar|deixa|esquece)\b/.test(s)) {
    return { yes: false, reason: null };
  }
  if (!/^(?:sim|s|ok|confirmo|confirma|pode|isso|certo|beleza|blz)\b/.test(s)) {
    return null;
  }
  // O motivo sai do texto original (com acento), depois do "sim".
  const m = raw.match(/^\s*\S+\b[\s,.:;-]*(.*)$/s);
  const reason = (m ? m[1] : "").trim().replace(/[.!]+$/, "");
  return { yes: true, reason: reason.length >= 3 ? reason : null };
}
