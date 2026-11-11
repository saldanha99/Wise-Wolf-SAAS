/**
 * Funil das aulas experimentais (tela do diretor, Aulas → Agendar).
 *
 * Só APRESENTAÇÃO: decide em que etapa o lead está, qual é a próxima ação que
 * a tela destaca e se ele está parado. Nenhuma regra de negócio mora aqui — o
 * que pode ou não ser feito continua sendo decidido pelas RPCs
 * (`update_trial_outcome_secure`, `create_enrollment_offer`,
 * `cancel_trial_opportunity`) e pela edge `school-admin`.
 */

export type TrialStage = 'SCHEDULED' | 'DONE' | 'LINK_SENT' | 'WON' | 'LOST';

/** Ação que a tela mostra como botão principal do lead. */
export type TrialNextAction =
    | 'MARK_DONE'      // a aula já passou: registrar o resultado
    | 'AWAIT'          // aula futura: nada a fazer além de esperar (ou remarcar)
    | 'RESCHEDULE'     // falta, cancelamento ou remarcação pendente
    | 'GENERATE_LINK'  // aula feita, falta o link de matrícula
    | 'RESEND_LINK'    // link enviado, aguardando o aluno
    | 'NONE';          // convertido ou perdido

export interface TrialPipelineInput {
    conversion_status: string | null | undefined;
    trial_status: string | null | undefined;
}

/** Duração da experimental — mesma conta da RPC que só deixa concluir depois do fim. */
export const TRIAL_DURATION_MS = 30 * 60 * 1000;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const STAGE_ORDER: TrialStage[] = ['SCHEDULED', 'DONE', 'LINK_SENT', 'WON', 'LOST'];

export function trialStage(opp: TrialPipelineInput, hasLink: boolean): TrialStage {
    if (opp.conversion_status === 'WON') return 'WON';
    if (opp.conversion_status === 'LOST') return 'LOST';
    if (opp.trial_status === 'DONE') return hasLink ? 'LINK_SENT' : 'DONE';
    return 'SCHEDULED';
}

export function trialNextAction(
    opp: TrialPipelineInput,
    hasLink: boolean,
    trialStart: Date | null,
    now: Date,
): TrialNextAction {
    const stage = trialStage(opp, hasLink);
    if (stage === 'WON' || stage === 'LOST') return 'NONE';
    if (stage === 'LINK_SENT') return 'RESEND_LINK';
    if (stage === 'DONE') return 'GENERATE_LINK';
    const status = opp.trial_status || '';
    if (status === 'NO_SHOW_STUDENT' || status === 'NO_SHOW_TEACHER' || status === 'CANCELLED') return 'RESCHEDULE';
    // Sem horário conhecido, o que sobra a fazer é registrar o resultado (a RPC barra se for cedo).
    if (!trialStart) return 'MARK_DONE';
    return trialStart.getTime() + TRIAL_DURATION_MS <= now.getTime() ? 'MARK_DONE' : 'AWAIT';
}

/**
 * O lead está parado? Devolve o motivo em português, ou nulo.
 * Prazos escolhidos para a rotina da escola: aula sem resultado 2 h depois do
 * fim, aula feita sem link há 1 dia, link sem matrícula há 3 dias.
 */
export function trialAttention(
    opp: TrialPipelineInput,
    hasLink: boolean,
    trialStart: Date | null,
    linkCreatedAt: Date | null,
    now: Date,
): string | null {
    const action = trialNextAction(opp, hasLink, trialStart, now);
    const nowMs = now.getTime();
    if (action === 'RESCHEDULE') {
        if (opp.trial_status === 'NO_SHOW_STUDENT') return 'O aluno faltou — remarque';
        if (opp.trial_status === 'NO_SHOW_TEACHER') return 'O professor faltou — remarque';
        return 'Experimental cancelada — remarque ou encerre';
    }
    if (action === 'MARK_DONE' && trialStart) {
        const late = nowMs - (trialStart.getTime() + TRIAL_DURATION_MS);
        if (late >= 2 * HOUR) return `Aula passou ${elapsed(late)} sem resultado`;
    }
    if (action === 'GENERATE_LINK' && trialStart) {
        const since = nowMs - trialStart.getTime();
        if (since >= DAY) return `Aula feita ${elapsed(since)} e sem link`;
    }
    if (action === 'RESEND_LINK' && linkCreatedAt) {
        const since = nowMs - linkCreatedAt.getTime();
        if (since >= 3 * DAY) return `Link enviado ${elapsed(since)} sem matrícula`;
    }
    return null;
}

function elapsed(ms: number): string {
    const hours = Math.floor(ms / HOUR);
    if (hours < 24) return `há ${hours} h`;
    const days = Math.floor(ms / DAY);
    return days === 1 ? 'há 1 dia' : `há ${days} dias`;
}

const SP_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });
const SP_TIME = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
const SP_WEEKDAY = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'short' });
const SP_DATE = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });

const dayNumber = (date: Date): number => Date.parse(`${SP_DAY.format(date)}T00:00:00Z`) / DAY;

/** "hoje às 09:00", "amanhã às 16:30", "ontem às 21:00", "qua 04/11 às 09:00" — no fuso da escola. */
export function relativeTrialLabel(start: Date, now: Date): string {
    const diff = dayNumber(start) - dayNumber(now);
    const time = SP_TIME.format(start);
    if (diff === 0) return `hoje às ${time}`;
    if (diff === 1) return `amanhã às ${time}`;
    if (diff === -1) return `ontem às ${time}`;
    const weekday = SP_WEEKDAY.format(start).replace('.', '');
    return `${weekday} ${SP_DATE.format(start)} às ${time}`;
}

/** Telefone legível: 5511987654321 → +55 (11) 98765-4321. Formato desconhecido volta como veio. */
export function formatBrazilPhone(raw: string | null | undefined): string {
    const digits = String(raw || '').replace(/\D/g, '');
    const local = digits.startsWith('55') && digits.length >= 12 ? digits.slice(2) : digits;
    if (local.length === 11) return `+55 (${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`;
    if (local.length === 10) return `+55 (${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`;
    return String(raw || '');
}

/** Link `wa.me` do lead, ou nulo se o telefone não tem dígitos suficientes. */
export function whatsappHref(raw: string | null | undefined): string | null {
    const digits = String(raw || '').replace(/\D/g, '');
    if (digits.length < 10) return null;
    return `https://wa.me/${digits.length <= 11 ? `55${digits}` : digits}`;
}

// =============================================================
// ORGANIZAÇÃO DA LISTA (11/11/2026)
//
// A direção não achava a experimental já realizada para gerar o link: a lista
// misturava todas as etapas, sem busca, ordenada pela data de criação do
// pedido. Agora a lista é agrupada pela PRÓXIMA AÇÃO — o que precisa de alguém
// vem primeiro — e dá para buscar por nome ou telefone.
// =============================================================

const NEXT_ACTION_GROUPS: { action: TrialNextAction; title: string }[] = [
    { action: 'GENERATE_LINK', title: 'Aula feita — gerar link de matrícula' },
    { action: 'MARK_DONE', title: 'Aula passou — registrar o resultado' },
    { action: 'RESCHEDULE', title: 'Faltou ou cancelou — remarcar' },
    { action: 'RESEND_LINK', title: 'Link enviado — aguardando o aluno' },
    { action: 'AWAIT', title: 'Agendadas' },
    { action: 'NONE', title: 'Encerradas' },
];

export interface TrialListRow {
    action: TrialNextAction;
    attention: string | null;
    start: Date | null;
    createdAt: string | null | undefined;
}

const foldSearch = (value: string): string =>
    value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Busca por nome (sem acento, qualquer parte) ou por dígitos do telefone. */
export function matchesTrialSearch(
    query: string,
    name: string | null | undefined,
    phone: string | null | undefined,
): boolean {
    const folded = foldSearch(query);
    if (!folded) return true;
    if (foldSearch(String(name || '')).includes(folded)) return true;
    const digits = folded.replace(/\D/g, '');
    return digits.length >= 3 && String(phone || '').replace(/\D/g, '').includes(digits);
}

function rowTime(row: TrialListRow): number {
    if (row.start) return row.start.getTime();
    const created = Date.parse(String(row.createdAt || ''));
    return Number.isFinite(created) ? created : 0;
}

/**
 * Grupos na ordem em que a escola age. Dentro do grupo: parados primeiro; depois
 * a aula mais recente (aula futura: a mais próxima primeiro).
 */
export function groupTrialRows<T extends TrialListRow>(rows: T[]): { title: string; action: TrialNextAction; rows: T[] }[] {
    return NEXT_ACTION_GROUPS
        .map(group => {
            const inGroup = rows.filter(row => row.action === group.action);
            const future = group.action === 'AWAIT';
            inGroup.sort((a, b) => {
                if (Boolean(a.attention) !== Boolean(b.attention)) return a.attention ? -1 : 1;
                return future ? rowTime(a) - rowTime(b) : rowTime(b) - rowTime(a);
            });
            return { title: group.title, action: group.action, rows: inGroup };
        })
        .filter(group => group.rows.length > 0);
}
