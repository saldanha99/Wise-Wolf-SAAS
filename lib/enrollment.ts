export type EnrollmentQuote = {
    installmentCount: number;
    installmentValue: number;
    installmentSubtotal: number;
    enrollmentFee: number;
    proRataValue: number;
    dueToday: number;
    total: number;
    firstDueDate: string;
};

export type EnrollmentProRataTerms = {
    enabled: boolean;
    value: number;
};

const money = (value: unknown): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const roundMoney = (value: number): number =>
    Math.round((value + Number.EPSILON) * 100) / 100;

export function normalizeEnrollmentProRataTerms(
    contractData: Record<string, unknown> | null,
): EnrollmentProRataTerms {
    const enabled = contractData?.enableProRata === true
        && Number(contractData?.planDuration) !== 0;
    return {
        enabled,
        value: enabled ? money(contractData?.proRataValue) : 0,
    };
}

export const digitsOnly = (value: string): string => value.replace(/\D/g, '');

export function isValidCpf(value: string): boolean {
    const cpf = digitsOnly(value);
    if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;

    const calculateDigit = (length: number): number => {
        let sum = 0;
        for (let index = 0; index < length; index += 1) {
            sum += Number(cpf[index]) * (length + 1 - index);
        }
        const digit = (sum * 10) % 11;
        return digit === 10 ? 0 : digit;
    };

    return calculateDigit(9) === Number(cpf[9])
        && calculateDigit(10) === Number(cpf[10]);
}

export function formatCpf(value: string): string {
    const cpf = digitsOnly(value).slice(0, 11);
    return cpf
        .replace(/^(\d{3})(\d)/, '$1.$2')
        .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
        .replace(/\.(\d{3})(\d)/, '.$1-$2');
}

export function normalizeEmail(value: string): string {
    return value.trim().toLowerCase();
}

export function isValidEmail(value: string): boolean {
    const normalized = normalizeEmail(value);
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalized);
}

export function isValidBrazilianMobile(value: string): boolean {
    let phone = digitsOnly(value);
    if (phone.length === 13 && phone.startsWith('55')) phone = phone.slice(2);

    if (!/^[1-9]{2}9\d{8}$/.test(phone)) return false;
    return !/^(\d)\1{8}$/.test(phone.slice(2));
}

export function isValidCreditCardNumber(value: string): boolean {
    const number = digitsOnly(value);
    if (number.length < 13 || number.length > 19 || /^(\d)\1+$/.test(number)) return false;

    let sum = 0;
    let double = false;
    for (let index = number.length - 1; index >= 0; index -= 1) {
        let digit = Number(number[index]);
        if (double) {
            digit *= 2;
            if (digit > 9) digit -= 9;
        }
        sum += digit;
        double = !double;
    }
    return sum % 10 === 0;
}

export function isValidCardExpiry(value: string, now = new Date()): boolean {
    const match = value.match(/^(\d{2})\/(\d{2}|\d{4})$/);
    if (!match) return false;
    const month = Number(match[1]);
    const rawYear = Number(match[2]);
    const year = match[2].length === 2 ? 2000 + rawYear : rawYear;
    if (month < 1 || month > 12) return false;
    const expiryBoundary = new Date(year, month, 1);
    const currentBoundary = new Date(now.getFullYear(), now.getMonth(), 1);
    return expiryBoundary > currentBoundary;
}

export function calculateFirstDueDate(
    dueDayValue: unknown,
    billingStartMonth?: string,
    now = new Date(),
): string {
    const dueDay = Math.min(Math.max(Number(dueDayValue) || 10, 1), 31);
    const saoPauloParts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(now);
    const currentYear = Number(saoPauloParts.find(part => part.type === 'year')?.value);
    const currentMonth = Number(saoPauloParts.find(part => part.type === 'month')?.value);
    const currentDay = Number(saoPauloParts.find(part => part.type === 'day')?.value);
    let year = currentYear;
    let monthIndex = currentMonth - 1;

    if (billingStartMonth && /^\d{4}-\d{2}$/.test(billingStartMonth)) {
        const [startYear, startMonth] = billingStartMonth.split('-').map(Number);
        year = startYear;
        monthIndex = startMonth - 1;
    } else if (currentDay >= dueDay) {
        monthIndex += 1;
    }

    const todayUtc = Date.UTC(currentYear, currentMonth - 1, currentDay);
    let normalizedYear = year + Math.floor(monthIndex / 12);
    let normalizedMonth = ((monthIndex % 12) + 12) % 12;
    let lastDay = new Date(Date.UTC(normalizedYear, normalizedMonth + 1, 0)).getUTCDate();
    let candidateUtc = Date.UTC(normalizedYear, normalizedMonth, Math.min(dueDay, lastDay));

    // Um mês configurado no passado nunca pode produzir vencimento vencido.
    while (candidateUtc < todayUtc) {
        monthIndex += 1;
        normalizedYear = year + Math.floor(monthIndex / 12);
        normalizedMonth = ((monthIndex % 12) + 12) % 12;
        lastDay = new Date(Date.UTC(normalizedYear, normalizedMonth + 1, 0)).getUTCDate();
        candidateUtc = Date.UTC(normalizedYear, normalizedMonth, Math.min(dueDay, lastDay));
    }

    const date = new Date(candidateUtc);
    return [
        date.getUTCFullYear(),
        String(date.getUTCMonth() + 1).padStart(2, '0'),
        String(date.getUTCDate()).padStart(2, '0'),
    ].join('-');
}

export function calculateEnrollmentQuote(contractData: Record<string, unknown> | null): EnrollmentQuote {
    const duration = Number(contractData?.planDuration);
    const installmentCount = duration === 0 ? 1 : Math.max(duration || 1, 1);
    const installmentValue = money(contractData?.value);
    const installmentSubtotal = roundMoney(installmentValue * installmentCount);
    const enrollmentFee = contractData?.requiresEnrollment === false
        ? 0
        : money(contractData?.enrollmentFee);
    const proRataValue = normalizeEnrollmentProRataTerms(contractData).value;
    const dueToday = roundMoney(duration === 0
        ? installmentValue
        : enrollmentFee + proRataValue);

    return {
        installmentCount,
        installmentValue,
        installmentSubtotal,
        enrollmentFee,
        proRataValue,
        dueToday,
        total: roundMoney(installmentSubtotal + enrollmentFee + proRataValue),
        firstDueDate: typeof contractData?.firstBillingDate === 'string'
            && /^\d{4}-\d{2}-\d{2}$/.test(contractData.firstBillingDate)
            ? contractData.firstBillingDate
            : calculateFirstDueDate(
                contractData?.dueDay,
                typeof contractData?.billingStartMonth === 'string'
                    ? contractData.billingStartMonth
                    : undefined,
            ),
    };
}

export function formatBrl(value: number): string {
    return value.toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL',
    });
}

export function formatDateBr(value: string): string {
    const [year, month, day] = value.split('-');
    return year && month && day ? `${day}/${month}/${year}` : value;
}
