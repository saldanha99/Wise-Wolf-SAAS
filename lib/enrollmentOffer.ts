import { calculateFirstDueDate } from './enrollment';

export type EnrollmentScheduleSlot = {
    day?: string;
    weekday?: string;
    time: string;
    teacherId?: string | null;
};

export type ProRataPreview = {
    firstBillingDate: string;
    classCount: number;
    pricePerClass: number;
    value: number;
};

type EnrollmentOfferActor = {
    id?: unknown;
    role?: unknown;
} | null | undefined;

/**
 * A comissão da oferta pertence somente a um vendedor autenticado. Diretores e
 * outros papéis podem criar a matrícula, mas nunca devem ser serializados como
 * vendorId apenas porque abriram a mesma tela.
 */
export const resolveEnrollmentOfferVendorId = (
    actor: EnrollmentOfferActor,
): string | undefined => {
    if (actor?.role !== 'SALESPERSON' || typeof actor.id !== 'string') {
        return undefined;
    }
    const actorId = actor.id.trim();
    return actorId || undefined;
};

const WEEKDAY_INDEX: Record<string, number> = {
    sunday: 0,
    domingo: 0,
    monday: 1,
    segunda: 1,
    segundafeira: 1,
    tuesday: 2,
    terca: 2,
    tercafeira: 2,
    wednesday: 3,
    quarta: 3,
    quartafeira: 3,
    thursday: 4,
    quinta: 4,
    quintafeira: 4,
    friday: 5,
    sexta: 5,
    sextafeira: 5,
    saturday: 6,
    sabado: 6,
};

const fold = (value: string) => value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z]/gi, '')
    .toLowerCase();

export const weekdayIndex = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6) {
        return value;
    }
    if (typeof value !== 'string') return null;
    return WEEKDAY_INDEX[fold(value)] ?? null;
};

export const normalizeEnrollmentTime = (value: unknown): string | null => {
    const match = String(value ?? '').trim().match(/^(\d{1,2}):(\d{2})/);
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
};

export const dateInSaoPaulo = (now = new Date()): string => {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(now);
    const read = (type: Intl.DateTimeFormatPartTypes) =>
        parts.find(part => part.type === type)?.value || '';
    return `${read('year')}-${read('month')}-${read('day')}`;
};

const parseIsoDateUtc = (value: string): Date | null => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
        ? date
        : null;
};

const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

/**
 * Prévia para a tela. O banco recalcula os mesmos termos e ignora qualquer
 * valor monetário informado pelo navegador.
 */
export function calculateEnrollmentProRataPreview(params: {
    enabled: boolean;
    monthlyFee: number;
    classesPerWeek: number;
    dueDay: number;
    billingStartMonth?: string;
    startDate: string;
    schedule: EnrollmentScheduleSlot[];
    now?: Date;
}): ProRataPreview {
    const firstBillingDate = calculateFirstDueDate(
        params.dueDay,
        params.billingStartMonth,
        params.now,
    );
    const empty = { firstBillingDate, classCount: 0, pricePerClass: 0, value: 0 };
    if (!params.enabled || params.monthlyFee <= 0 || params.classesPerWeek <= 0) return empty;

    const start = parseIsoDateUtc(params.startDate);
    const end = parseIsoDateUtc(firstBillingDate);
    if (!start || !end || start >= end) return empty;

    const weekdays = params.schedule
        .map(slot => weekdayIndex(slot.day ?? slot.weekday))
        .filter((day): day is number => day !== null);
    if (weekdays.length === 0) return empty;

    let classCount = 0;
    const cursor = new Date(start);
    while (cursor < end) {
        const cursorDay = cursor.getUTCDay();
        classCount += weekdays.filter(day => day === cursorDay).length;
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    // Cada aula precisa ter um valor monetario reproduzivel em centavos. O
    // total usa exatamente esse valor exibido, evitando uma previa como
    // "R$ 8,33 x 5 = R$ 41,67" causada por casas decimais ocultas.
    const pricePerClass = roundMoney(params.monthlyFee / (params.classesPerWeek * 4));
    return {
        firstBillingDate,
        classCount,
        pricePerClass,
        value: roundMoney(pricePerClass * classCount),
    };
}

const ENROLLMENT_OFFER_ERRORS: Array<[string, string]> = [
    ['permission denied for table enrollment_offer_command_receipts', 'O serviço seguro de matrícula está temporariamente indisponível. Nenhum link foi criado. Tente novamente em alguns instantes.'],
    ['authentication_required', 'Sua sessão expirou. Entre novamente para gerar o link de matrícula.'],
    ['active_tenant_required', 'Selecione uma unidade ativa antes de gerar o link de matrícula.'],
    ['cross_tenant_enrollment_denied', 'A unidade do formulário não corresponde à unidade ativa da sua sessão. Atualize a página e tente novamente.'],
    ['tenant_inactive', 'A unidade está inativa e não pode emitir novos links de matrícula.'],
    ['inactive_enrollment_actor', 'O professor ou vendedor vinculado não está ativo nesta unidade. Atualize os responsáveis e tente novamente.'],
    ['inactive_guardian', 'O responsável financeiro não está ativo nesta unidade. Atualize o cadastro antes de gerar o link.'],
    ['enrollment_offer_scope_mismatch', 'A oferta não pôde ser vinculada à unidade ativa. Atualize a página e tente novamente.'],
    ['permission_denied', 'Seu perfil não possui autorização para gerar links de matrícula nesta unidade.'],
    ['tenant_legal_identity_incomplete', 'Antes de gerar contratos, complete a Identidade da escola e envie a assinatura do representante em um arquivo privado válido: Configurações → Central da escola → Identidade da escola.'],
    ['enrollment_schedule_required', 'Selecione o professor e preencha todos os horários da grade.'],
    ['enrollment_schedule_cardinality_mismatch', 'A quantidade de horários precisa ser exatamente igual à frequência semanal do plano.'],
    ['invalid_enrollment_schedule', 'Revise os dias, horários e professores da grade.'],
    ['duplicate_enrollment_schedule_slot', 'A grade contém um horário repetido. Escolha horários distintos.'],
    ['inactive_enrollment_teacher', 'Um dos professores não está mais ativo nesta escola. Escolha outro professor.'],
    ['teacher_slot_unavailable', 'O professor não disponibilizou um dos horários selecionados. Atualize a grade.'],
    ['teacher_slot_occupied', 'Um dos horários selecionados já está ocupado. Atualize a grade antes de gerar o link.'],
    ['enrollment_schedule_reserved', 'Esse horário acabou de ser reservado por outra matrícula. Escolha outro slot.'],
    ['enrollment_schedule_changed', 'A disponibilidade mudou desde a criação do link. Gere uma nova grade antes de continuar.'],
    ['dependent_student_phone_invalid', 'Informe um WhatsApp válido do aluno, separado do telefone do responsável financeiro.'],
    ['dependent_guardian_contact_invalid', 'O responsável financeiro precisa ter nome, CPF, e-mail e WhatsApp válidos antes da criação do link. Atualize o cadastro do titular.'],
    ['pro_rata_not_applicable', 'O prorrata não se aplica a plano de aula avulsa. Desative essa opção ou escolha um plano recorrente.'],
    ['invalid_enrollment_billing_period', 'Revise a data de início e o mês do primeiro vencimento.'],
    ['enrollment_first_billing_date_passed', 'O primeiro vencimento desta oferta já passou. Gere um novo link com datas atualizadas.'],
    ['42501', 'Não foi possível confirmar sua autorização para gerar o link. Atualize a sessão e tente novamente.'],
];

export const enrollmentOfferErrorMessage = (error: unknown): string => {
    if (typeof error === 'string') {
        const mapped = ENROLLMENT_OFFER_ERRORS.find(([key]) => error.toLowerCase().includes(key));
        return mapped?.[1] || 'Não foi possível gerar o link seguro. Revise os dados e tente novamente.';
    }
    const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
    const raw = [record.message, record.details, record.hint, record.code]
        .filter(value => typeof value === 'string')
        .join(' ')
        .toLowerCase();
    const mapped = ENROLLMENT_OFFER_ERRORS.find(([key]) => raw.includes(key));
    return mapped?.[1] || 'Não foi possível gerar o link seguro. Revise os dados e tente novamente.';
};
