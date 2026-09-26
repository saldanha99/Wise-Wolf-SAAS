// Relatório de presença do Meet (recurso do Google Workspace Business Plus).
//
// O Google gera, depois de cada reunião da sala da escola, uma planilha com
// nome, e-mail, horário de entrada, horário de saída e duração de cada
// participante, e a guarda no Drive do organizador. É o recurso que o próprio
// Google oferece para controle de presença — a integração NÃO coleta
// participantes pela API do Meet, que o Google diz não ser destinada a
// acompanhamento de desempenho.
//
// Aqui fica só o que é puro (sem rede): ler a planilha exportada em CSV,
// reconhecer as colunas em português ou inglês e resumir professor × aluno.
// O que o resumo vira (aviso na Central de Qualidade, nunca desconto) é
// decidido no banco, comparando com o lançamento da aula.

export type AttendanceRow = {
  name: string;
  email: string | null;
  joinedAt: string | null;
  leftAt: string | null;
  durationSeconds: number | null;
};

export type ParticipantRole = "TEACHER" | "ORGANIZER" | "STUDENT";

export type AttendanceSummary = {
  teacherFirstJoinAt: string | null;
  teacherSeconds: number;
  studentFirstJoinAt: string | null;
  studentSeconds: number;
  participants: Array<AttendanceRow & { role: ParticipantRole }>;
};

/** CSV do Drive (RFC 4180): vírgula, aspas duplas, quebra de linha dentro de aspas. */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let field = "", row: string[] = [], quoted = false;
  const textInput = input.replace(/^﻿/, "");
  for (let i = 0; i < textInput.length; i++) {
    const char = textInput[i];
    if (quoted) {
      if (char === '"' && textInput[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && textInput[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.map((r) => r.map((cell) => cell.trim()));
}

const fold = (value: string) =>
  value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

type Columns = {
  firstName: number;
  lastName: number;
  name: number;
  email: number;
  joined: number;
  exited: number;
  duration: number;
};

const HEADER_PATTERNS: Record<keyof Columns, RegExp[]> = {
  firstName: [/^first name$/, /^nome$/, /^primeiro nome$/],
  lastName: [/^last name$/, /^sobrenome$/, /^ultimo nome$/],
  name: [/^name$/, /^participant$/, /^participante$/, /^nome completo$/],
  email: [/^e-?mail$/, /^endereco de e-?mail$/, /^email address$/],
  joined: [/joined/, /entrou/, /entrada/, /^join time$/],
  exited: [/exited/, /left/, /^saiu/, /saida/, /^leave time$/],
  duration: [/duration/, /duracao/, /tempo/],
};

/** Acha a linha de cabeçalho: a planilha pode ter linhas de título antes dela. */
export function findHeader(
  rows: string[][],
): { index: number; columns: Columns } | null {
  for (let index = 0; index < Math.min(rows.length, 15); index++) {
    const cells = rows[index].map(fold);
    const columns: Columns = {
      firstName: -1,
      lastName: -1,
      name: -1,
      email: -1,
      joined: -1,
      exited: -1,
      duration: -1,
    };
    cells.forEach((cell, position) => {
      for (const key of Object.keys(HEADER_PATTERNS) as (keyof Columns)[]) {
        if (
          columns[key] === -1 &&
          HEADER_PATTERNS[key].some((re) => re.test(cell))
        ) {
          columns[key] = position;
          break;
        }
      }
    });
    const hasName = columns.name >= 0 || columns.firstName >= 0;
    const hasTime = columns.joined >= 0 || columns.duration >= 0;
    if (hasName && hasTime) return { index, columns };
  }
  return null;
}

/** "1 h 5 min", "35 min", "35 min 12 s", "00:35:12", "35:12", "2100 s", "1h05". */
export function parseDuration(value: string): number | null {
  const raw = fold(value);
  if (!raw) return null;
  const clock = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (clock) {
    const [, a, b, c] = clock;
    // "0:35" pode ser h:mm ou m:ss — ambíguo; quem decide é entrada × saída.
    if (c === undefined) return null;
    return Number(a) * 3600 + Number(b) * 60 + Number(c);
  }
  let seconds = 0, matched = false;
  const units: [RegExp, number][] = [
    [/(\d+)\s*(h|hr|hrs|hora|horas|hour|hours)\b/, 3600],
    [/(\d+)\s*(min|mins|minuto|minutos|minute|minutes|m)\b/, 60],
    [/(\d+)\s*(s|seg|segundo|segundos|sec|secs|second|seconds)\b/, 1],
  ];
  for (const [re, factor] of units) {
    const found = raw.match(re);
    if (found) {
      seconds += Number(found[1]) * factor;
      matched = true;
    }
  }
  const compact = raw.match(/^(\d+)h(\d{1,2})$/);
  if (!matched && compact) {
    return Number(compact[1]) * 3600 + Number(compact[2]) * 60;
  }
  return matched ? seconds : null;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  fev: 2,
  feb: 2,
  mar: 3,
  abr: 4,
  apr: 4,
  mai: 5,
  may: 5,
  jun: 6,
  jul: 7,
  ago: 8,
  aug: 8,
  set: 9,
  sep: 9,
  out: 10,
  oct: 10,
  nov: 11,
  dez: 12,
  dec: 12,
};

/**
 * Horário da planilha → ISO UTC. A planilha usa o fuso da conta organizadora
 * (a escola: America/Sao_Paulo, UTC-3 sem horário de verão). Horário sem data
 * usa a data (local) do início da reunião.
 */
export function parseTimeOnDate(
  value: string,
  conferenceStartIso: string,
  offsetMinutes = -180,
): string | null {
  const raw = fold(value).replace(/\s+/g, " ");
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}/.test(raw)) {
    const parsed = Date.parse(value.trim());
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  const start = Date.parse(conferenceStartIso);
  if (!Number.isFinite(start)) return null;
  const local = new Date(start + offsetMinutes * 60000);
  let year = local.getUTCFullYear(),
    month = local.getUTCMonth() + 1,
    day = local.getUTCDate();

  const dmy = raw.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  const ymd = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  const named = raw.match(/([a-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})/) ||
    raw.match(/(\d{1,2}) de ([a-z]{3})[a-z]*\.? de (\d{4})/);
  if (dmy) {
    [day, month, year] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])];
  } else if (ymd) {
    [year, month, day] = [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])];
  } else if (named) {
    const isEnglish = /^[a-z]/.test(named[1]);
    const monthName = isEnglish ? named[1] : named[2];
    if (MONTHS[monthName]) {
      month = MONTHS[monthName];
      day = Number(isEnglish ? named[2] : named[1]);
      year = Number(named[3]);
    }
  }

  const clock = raw.match(
    /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(a\.? ?m\.?|p\.? ?m\.?)?/,
  );
  if (!clock) return null;
  let hour = Number(clock[1]);
  const minute = Number(clock[2]), second = Number(clock[3] || 0);
  const meridiem = clock[4]?.replace(/[^ap]/g, "");
  if (meridiem === "p" && hour < 12) hour += 12;
  if (meridiem === "a" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const utc = Date.UTC(year, month - 1, day, hour, minute, second) -
    offsetMinutes * 60000;
  return Number.isFinite(utc) ? new Date(utc).toISOString() : null;
}

export function parseAttendanceReport(
  csv: string,
  conferenceStartIso: string,
): { rows: AttendanceRow[] } | {
  error: "attendance_header_not_found" | "attendance_rows_empty";
} {
  const table = parseCsv(csv);
  const header = findHeader(table);
  if (!header) return { error: "attendance_header_not_found" };
  const { columns } = header;
  const cell = (row: string[], position: number) =>
    position >= 0 && position < row.length ? row[position] : "";
  const rows: AttendanceRow[] = [];
  for (const row of table.slice(header.index + 1)) {
    if (!row.some((value) => value)) continue;
    const name = columns.name >= 0
      ? cell(row, columns.name)
      : [cell(row, columns.firstName), cell(row, columns.lastName)].filter(
        Boolean,
      ).join(" ");
    const emailCell = cell(row, columns.email).toLowerCase();
    const joinedAt = parseTimeOnDate(
      cell(row, columns.joined),
      conferenceStartIso,
    );
    const leftAt = parseTimeOnDate(
      cell(row, columns.exited),
      conferenceStartIso,
    );
    let durationSeconds = parseDuration(cell(row, columns.duration));
    if (durationSeconds === null && joinedAt && leftAt) {
      durationSeconds = Math.max(
        0,
        Math.round((Date.parse(leftAt) - Date.parse(joinedAt)) / 1000),
      );
    }
    if (!name && !emailCell) continue;
    rows.push({
      name: name.slice(0, 200),
      email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailCell)
        ? emailCell.slice(0, 254)
        : null,
      joinedAt,
      leftAt,
      durationSeconds,
    });
  }
  return rows.length ? { rows } : { error: "attendance_rows_empty" };
}

const sameName = (a: string, b: string) => {
  const x = fold(a).replace(/[^a-z ]/g, "").split(" ").filter(Boolean);
  const y = fold(b).replace(/[^a-z ]/g, "").split(" ").filter(Boolean);
  return x.length > 0 && y.length > 0 && x[0] === y[0] &&
    x[x.length - 1] === y[y.length - 1];
};

/**
 * Quem é quem numa sala exclusiva da aula: o organizador é a conta da escola,
 * o professor é o coanfitrião (e-mail do cadastro dele; nome como reserva), e
 * qualquer outra pessoa é o aluno (ou o responsável, na aula de criança).
 */
export function summarizeAttendance(
  rows: AttendanceRow[],
  identity: {
    teacherEmail: string | null;
    teacherName: string | null;
    organizerEmail: string | null;
  },
): AttendanceSummary {
  const teacherEmail = identity.teacherEmail?.toLowerCase() || null;
  const organizerEmail = identity.organizerEmail?.toLowerCase() || null;
  const participants = rows.map((row) => {
    let role: ParticipantRole = "STUDENT";
    if (row.email && organizerEmail && row.email === organizerEmail) {
      role = "ORGANIZER";
    } else if (row.email && teacherEmail && row.email === teacherEmail) {
      role = "TEACHER";
    } else if (
      !row.email && identity.teacherName &&
      sameName(row.name, identity.teacherName)
    ) role = "TEACHER";
    return { ...row, role };
  });
  const earliest = (list: typeof participants) =>
    list.map((p) => p.joinedAt).filter((v): v is string => !!v).sort()[0] ||
    null;
  const total = (list: typeof participants) =>
    list.reduce((sum, p) => sum + (p.durationSeconds || 0), 0);
  const teacher = participants.filter((p) => p.role === "TEACHER");
  const student = participants.filter((p) => p.role === "STUDENT");
  return {
    teacherFirstJoinAt: earliest(teacher),
    teacherSeconds: total(teacher),
    studentFirstJoinAt: earliest(student),
    studentSeconds: total(student),
    participants,
  };
}

const MEETING_CODE = /[a-z]{3,4}-[a-z]{3,4}-[a-z]{3,4}/gi;

/**
 * O nome traz o código de OUTRA sala? O relatório real se chama "Relatório de
 * participação em <código> (...)": com código diferente, é a planilha de outra
 * aula — muitas vezes a anterior do mesmo professor, que cita o mesmo e-mail.
 */
export const namesOtherMeeting = (
  name: string,
  meetingCode: string | null,
): boolean =>
  (name.match(MEETING_CODE) || []).some((found) =>
    found.toLowerCase() !== (meetingCode || "").toLowerCase()
  );

/** Planilha da reunião certa: nome com o código da sala; senão, a que cita o professor. */
export function pickAttendanceReport<T extends { name: string; csv?: string }>(
  candidates: T[],
  meetingCode: string | null,
  teacherEmail: string | null,
): T | null {
  const code = meetingCode?.toLowerCase() || "";
  if (code) {
    const byName = candidates.filter((c) =>
      c.name.toLowerCase().includes(code)
    );
    if (byName.length === 1) return byName[0];
    // Plano B nunca escolhe planilha com código de outra sala.
    candidates = candidates.filter((c) => !namesOtherMeeting(c.name, code));
  }
  if (teacherEmail) {
    const email = teacherEmail.toLowerCase();
    const byTeacher = candidates.filter((c) =>
      (c.csv || "").toLowerCase().includes(email)
    );
    if (byTeacher.length === 1) return byTeacher[0];
  }
  return null;
}

/**
 * Nome de relatório de presença do Meet ("Relatório de participação em
 * abc-defg-hij (...)", medido em 26/09/2026; em inglês "attendance"/"participant").
 * O plano B (procurar o e-mail do professor dentro da planilha) só abre planilhas
 * com esse nome — com drive.readonly, qualquer planilha da escola criada na
 * janela da aula seria candidata.
 */
export const looksLikeAttendanceReport = (name: string): boolean =>
  /particip|attendance|presen[cç]a/i.test(name);

export const meetingCodeFromUri = (
  uri: string | null | undefined,
): string | null => {
  const match = String(uri || "").match(
    /meet\.google\.com\/([a-z]{3,4}-[a-z]{3,4}-[a-z]{3,4})/i,
  );
  return match ? match[1].toLowerCase() : null;
};
