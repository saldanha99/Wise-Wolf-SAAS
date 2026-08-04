// Data local no formato YYYY-MM-DD. NUNCA use toISOString() para data de aula:
// toISOString() converte para UTC e, depois das 21h no Brasil (UTC-3), a data pula
// para o dia seguinte — o dia da semana (getDay, local) fica de um dia e a data de
// outro. Foi isso que gerou aulas fantasma/duplicadas no fechamento dos professores.
export const localYMD = (d: Date): string => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
};

// Mês local (YYYY-MM). Mesmo motivo do localYMD: depois das 21h no Brasil o
// toISOString() já está no dia seguinte — e no ÚLTIMO dia do mês isso vira o mês
// seguinte, fazendo o fechamento apontar para o mês errado justamente na noite em
// que o professor fecha.
export const localMonth = (d: Date = new Date()): string => localYMD(d).slice(0, 7);

// Janela [start, endExclusive) de um mês YYYY-MM, em aritmética de string pura.
// NUNCA use new Date('2026-07') + setMonth() para isso: '2026-07' é lido como UTC,
// no fuso do Brasil cai em 30/06 21h e o setMonth() erra o limite — ora cortando o
// último dia do mês (aulas do dia 31 sumiam do fechamento), ora incluindo os
// primeiros dias do mês seguinte (aula contada em dois meses).
export const monthRange = (month: string): { start: string; endExclusive: string } => {
    const [y, m] = month.split('-').map(Number);
    const nextY = m === 12 ? y + 1 : y;
    const nextM = m === 12 ? 1 : m + 1;
    return {
        start: `${month}-01`,
        endExclusive: `${nextY}-${String(nextM).padStart(2, '0')}-01`,
    };
};

// Últimos n meses (YYYY-MM), do atual para trás. Não use setMonth(-i) sobre a data
// de hoje: no dia 31 o "mês anterior" estoura para o mês seguinte (31/07 → 31/06 →
// 01/07) e a lista repete um mês e pula outro — bem no dia do fechamento.
export const recentMonths = (n: number, from: Date = new Date()): string[] => {
    const y = from.getFullYear();
    const m = from.getMonth(); // 0-11
    return Array.from({ length: n }, (_, i) => localMonth(new Date(y, m - i, 1)));
};

// Lê uma data de calendário ('YYYY-MM-DD' ou 'DD/MM/YYYY') como data LOCAL.
// NUNCA use new Date('2026-07-23') para isso: a string ISO só com data é lida como
// UTC, e no fuso do Brasil vira 22/07 às 21h — o getDay() devolve QUARTA para uma
// quinta-feira. Era esse deslocamento que jogava a reposição uma coluna à esquerda
// na grade do Explorador de Agenda.
// Devolve null para o que não é data (ex.: reposição ainda 'Pendente').
export const parseLocalDate = (value: string | null | undefined): Date | null => {
    if (!value) return null;
    const raw = value.trim();

    const br = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (br) return new Date(Number(br[3]), Number(br[2]) - 1, Number(br[1]));

    const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));

    return null;
};

export const isBusinessDay = (date: Date): boolean => {
    const day = date.getDay();
    // 0 = Sunday, 6 = Saturday
    return day !== 0 && day !== 6;
};

export const getNthBusinessDay = (year: number, month: number, n: number): Date => {
    const date = new Date(year, month, 1);
    let businessDaysCount = 0;

    // Loop until we find the Nth business day
    while (businessDaysCount < n) {
        if (isBusinessDay(date)) {
            businessDaysCount++;
        }
        if (businessDaysCount < n) {
            date.setDate(date.getDate() + 1);
        }
    }
    return date;
};

export const getFinancialCutoffDate = (currentDate: Date = new Date()): Date => {
    // Returns the 10th business day of the CURRENT month
    return getNthBusinessDay(currentDate.getFullYear(), currentDate.getMonth(), 10);
};

export const shouldExpireLesson = (lessonRawDate: string): boolean => {
    const lessonDate = new Date(lessonRawDate);
    const now = new Date();

    // Safety check for invalid dates
    if (isNaN(lessonDate.getTime())) return false;

    // 1. If lesson is in the future or current month, it NEVER expires by Hard Limit
    // (We compare Year and Month)
    if (lessonDate.getFullYear() > now.getFullYear()) return false;
    if (lessonDate.getFullYear() === now.getFullYear() && lessonDate.getMonth() >= now.getMonth()) return false;

    // 2. Lesson is from a previous month. 
    // Check if we are PAST the 10th Business Day of the CURRENT month.
    const cutoffDate = getFinancialCutoffDate(now);

    // If Now is AFTER the cutoff date (e.g. Now is 15th, Cutoff was 12th) -> EXPIRE
    // We compare time values to be precise, or just dates. 
    // Let's assume Cutoff happens at 00:00 of that day? Or end of day? 
    // Usually "Until the 10th" means inclusive. So if today IS the 10th, it's open. 
    // If today is 11th, it's closed.

    // Reset hours for accurate date comparison
    const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const cutoffMidnight = new Date(cutoffDate.getFullYear(), cutoffDate.getMonth(), cutoffDate.getDate());

    return nowMidnight > cutoffMidnight;
};
