// Rascunho da página de matrícula: o que o aluno já digitou sobrevive ao F5
// e a fechar e reabrir o link no mesmo aparelho. Fica no navegador dele, por
// link (oferta), e some quando a matrícula termina ou depois de 7 dias.
// Senha e dados do cartão NUNCA entram aqui.

export interface EnrollmentDraft {
    name: string;
    email: string;
    phone: string;
    cpf: string;
    postalCode: string;
    address: string;
    addressNumber: string;
    billingType: 'PIX' | 'BOLETO' | 'CREDIT_CARD';
}

const PREFIX = 'wisewolf.enrollmentDraft.';
export const ENROLLMENT_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const TEXT_FIELDS = ['name', 'email', 'phone', 'cpf', 'postalCode', 'address', 'addressNumber'] as const;
const BILLING_TYPES = ['PIX', 'BOLETO', 'CREDIT_CARD'] as const;

const keyFor = (offerId: string) => `${PREFIX}${offerId}`;

const storage = (): Storage | null => {
    try {
        return typeof window !== 'undefined' ? window.localStorage : null;
    } catch {
        return null;
    }
};

export function loadEnrollmentDraft(offerId: string | null | undefined, now = Date.now()): Partial<EnrollmentDraft> | null {
    if (!offerId) return null;
    const store = storage();
    if (!store) return null;
    try {
        const raw = store.getItem(keyFor(offerId));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { savedAt?: unknown; draft?: Record<string, unknown> };
        if (typeof parsed.savedAt !== 'number' || now - parsed.savedAt > ENROLLMENT_DRAFT_TTL_MS || !parsed.draft) {
            store.removeItem(keyFor(offerId));
            return null;
        }
        const draft: Partial<EnrollmentDraft> = {};
        for (const field of TEXT_FIELDS) {
            const value = parsed.draft[field];
            if (typeof value === 'string' && value.length <= 300) draft[field] = value;
        }
        const billing = parsed.draft.billingType;
        if (typeof billing === 'string' && (BILLING_TYPES as readonly string[]).includes(billing)) {
            draft.billingType = billing as EnrollmentDraft['billingType'];
        }
        return Object.keys(draft).length > 0 ? draft : null;
    } catch {
        return null;
    }
}

export function saveEnrollmentDraft(offerId: string | null | undefined, draft: EnrollmentDraft, now = Date.now()): void {
    if (!offerId) return;
    const store = storage();
    if (!store) return;
    // Só os campos conhecidos: nada de senha ou cartão, mesmo que venham no objeto.
    const clean: Record<string, string> = {};
    for (const field of TEXT_FIELDS) clean[field] = String(draft[field] ?? '').slice(0, 300);
    clean.billingType = draft.billingType;
    const empty = TEXT_FIELDS.every(field => !clean[field].trim());
    try {
        if (empty) store.removeItem(keyFor(offerId));
        else store.setItem(keyFor(offerId), JSON.stringify({ savedAt: now, draft: clean }));
    } catch {
        // Navegador sem armazenamento (aba anônima, cota cheia): segue sem rascunho.
    }
}

export function clearEnrollmentDraft(offerId: string | null | undefined): void {
    if (!offerId) return;
    try {
        storage()?.removeItem(keyFor(offerId));
    } catch {
        // idem
    }
}
