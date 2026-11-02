// Reserva de agenda para aluno que começa numa data futura: a escola paga ao
// professor (pagamento interno, entra na folha) para segurar o horário até o
// início. O aluno não paga nada disso. Quem grava e confere tudo é o banco
// (`create_enrollment_offer_with_future_hold` / `list_future_start_holds`);
// aqui só ficam as conversões da tela.

export const HOLD_AMOUNT_MAX = 1000;

export interface FutureStartHoldSlot {
    hold_id: string;
    offer_id: string;
    teacher_id: string;
    teacher_name: string | null;
    student_label: string;
    day_of_week: number;
    class_time: string;
    hold_until: string;
    amount: number;
    month_year: string;
    status: 'ACTIVE' | 'RELEASED';
    blocking: boolean;
}

/**
 * Valor digitado em reais → número com 2 casas, ou null se inválido.
 * Aceita "30", "30,5", "30,00", "R$ 1.234,50" e "30.5".
 */
export const parseHoldAmount = (input: string): number | null => {
    const cleaned = input.replace(/R\$/gi, '').replace(/\s/g, '');
    if (!cleaned || !/^[0-9.,]+$/.test(cleaned)) return null;
    const normalized = cleaned.includes(',')
        ? cleaned.replace(/\./g, '').replace(',', '.')
        : cleaned;
    if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
    const value = Number(normalized);
    if (!Number.isFinite(value) || value <= 0 || value > HOLD_AMOUNT_MAX) return null;
    return Math.round(value * 100) / 100;
};

/** Só existe reserva quando as aulas começam DEPOIS de hoje (datas YYYY-MM-DD). */
export const holdAllowedForStart = (startDate: string, today: string): boolean =>
    /^\d{4}-\d{2}-\d{2}$/.test(startDate) && startDate > today;

/** "2026-11-05" → "05/11". */
export const formatHoldDay = (ymd: string): string => {
    const [, month, day] = ymd.split('-');
    return day && month ? `${day}/${month}` : ymd;
};

const isHoldSlot = (value: unknown): value is FutureStartHoldSlot => {
    if (!value || typeof value !== 'object') return false;
    const row = value as Record<string, unknown>;
    return typeof row.hold_id === 'string'
        && typeof row.teacher_id === 'string'
        && typeof row.day_of_week === 'number'
        && typeof row.class_time === 'string'
        && typeof row.hold_until === 'string';
};

/** Resposta jsonb de `list_future_start_holds` → linhas válidas. */
export const parseHoldSlots = (data: unknown): FutureStartHoldSlot[] =>
    Array.isArray(data) ? data.filter(isHoldSlot) : [];
