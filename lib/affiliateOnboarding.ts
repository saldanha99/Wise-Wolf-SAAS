/**
 * Página pública do convite de afiliado (/vendor-onboarding?offer=<uuid>) —
 * regras puras da tela: marca da escola, validação do formulário, tradução dos
 * erros do cadastro e cópia do cupom. As regras do programa (comissão,
 * liquidação, saque) continuam em `affiliateProgram.ts`.
 */
import { DEFAULT_PRIMARY_COLOR, normalizeHexColor } from './tenant-branding';

export interface AffiliateBrand {
    /** Cor principal da escola, "#RRGGBB". Sempre legível com texto branco. */
    primary: string;
    /** A mesma cor em canais "R G B", para `rgb(var(--aff-rgb) / .08)`. */
    primaryRgb: string;
    /** Cor de apoio (só decoração da faixa); nula quando falta ou não dá contraste. */
    secondary: string | null;
    logoUrl: string | null;
}

const HEX6 = /^#[0-9a-fA-F]{6}$/;
const HTTPS_URL = /^https:\/\/[^\s"<>]+$/;

/** Contraste mínimo AA para texto normal (WCAG 2.x). */
export const AA_CONTRAST = 4.5;

function channels(hex: string): [number, number, number] {
    const raw = hex.replace('#', '');
    return [0, 2, 4].map(start => Number.parseInt(raw.slice(start, start + 2), 16)) as [number, number, number];
}

function relativeLuminance(hex: string): number {
    const [r, g, b] = channels(hex).map(value => {
        const c = value / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contraste da cor contra o branco (1 a 21). */
export function contrastWithWhite(hex: string): number {
    return 1.05 / (relativeLuminance(hex) + 0.05);
}

/**
 * Marca da escola vinda do convite. A faixa do topo, o cupom e o botão levam
 * texto branco sobre a cor principal — cor clara demais (amarelo, rosa-bebê)
 * cai no padrão do app em vez de deixar o texto ilegível.
 */
export function resolveAffiliateBrand(offer: {
    brandPrimary?: unknown;
    brandSecondary?: unknown;
    schoolLogoUrl?: unknown;
} | null | undefined): AffiliateBrand {
    const candidate = typeof offer?.brandPrimary === 'string' && HEX6.test(offer.brandPrimary)
        ? normalizeHexColor(offer.brandPrimary, DEFAULT_PRIMARY_COLOR)
        : null;
    const primary = candidate && contrastWithWhite(candidate) >= AA_CONTRAST ? candidate : DEFAULT_PRIMARY_COLOR;
    const secondary = typeof offer?.brandSecondary === 'string' && HEX6.test(offer.brandSecondary)
        && contrastWithWhite(offer.brandSecondary) >= AA_CONTRAST
        ? normalizeHexColor(offer.brandSecondary, DEFAULT_PRIMARY_COLOR)
        : null;
    const logoUrl = typeof offer?.schoolLogoUrl === 'string' && HTTPS_URL.test(offer.schoolLogoUrl)
        ? offer.schoolLogoUrl
        : null;
    return { primary, primaryRgb: channels(primary).join(' '), secondary, logoUrl };
}

/** "Wise Wolf Languages" → "WW"; usado quando a escola não tem logo. */
export function schoolMonogram(schoolName: string | null | undefined): string {
    const words = (schoolName || '').trim().split(/\s+/).filter(word => /^[\p{L}\p{N}]/u.test(word));
    return words.slice(0, 2).map(word => word[0].toUpperCase()).join('');
}

export function firstName(fullName: string | null | undefined): string {
    return (fullName || '').trim().split(/\s+/)[0] || '';
}

export type AffiliateSignupField = 'name' | 'email' | 'password' | 'phone' | 'terms';

export interface AffiliateSignupInput {
    name: string;
    email: string;
    password: string;
    phone: string;
    acceptedTerms: boolean;
}

/** Mesma checagem do e-mail no `register-vendor`. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validação antes do envio. Espelha o `register-vendor` (nome ≥ 2, e-mail,
 * senha ≥ 8, WhatsApp opcional com 10 a 15 dígitos, aceite obrigatório) para a
 * pessoa saber o que corrigir sem ir e voltar ao servidor.
 */
export function validateAffiliateSignup(input: AffiliateSignupInput): { field: AffiliateSignupField; message: string } | null {
    const name = input.name.trim();
    const email = input.email.trim();
    if (!name || !email || !input.password) {
        const field: AffiliateSignupField = !name ? 'name' : !email ? 'email' : 'password';
        return { field, message: 'Preencha todos os campos obrigatórios.' };
    }
    if (name.length < 2) return { field: 'name', message: 'Informe o seu nome completo.' };
    if (!EMAIL_PATTERN.test(email)) return { field: 'email', message: 'Confira o e-mail: ele parece incompleto.' };
    if (input.password.length < 8) return { field: 'password', message: 'A senha precisa ter pelo menos 8 caracteres.' };
    const phoneDigits = input.phone.replace(/\D/g, '');
    if (phoneDigits && (phoneDigits.length < 10 || phoneDigits.length > 15)) {
        return { field: 'phone', message: 'Informe o WhatsApp com DDD, por exemplo (11) 99999-9999.' };
    }
    if (!input.acceptedTerms) {
        return { field: 'terms', message: 'Para continuar, confirme que leu e concorda com as regras do programa.' };
    }
    return null;
}

const GENERIC_REGISTRATION_ERROR = 'Não foi possível criar a sua conta agora. Tente de novo em instantes.';

/**
 * O `register-vendor` responde em português sem acento e o supabase-js
 * troca qualquer resposta não-2xx por "Edge Function returned a non-2xx
 * status code". Aqui vira uma frase que diz o que fazer.
 */
export function vendorRegistrationErrorMessage(raw: string | null | undefined): string {
    const text = (raw || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    if (!text) return GENERIC_REGISTRATION_ERROR;
    if (text.includes('already registered') || text.includes('already been registered') || text.includes('ja cadastrado')) {
        return 'Este e-mail já está cadastrado.';
    }
    if (text.includes('revise os dados')) {
        return 'Revise os dados: nome completo, e-mail válido, senha com pelo menos 8 caracteres e WhatsApp com DDD.';
    }
    if (text.includes('convite invalido') || text.includes('expirado')) {
        return 'Este convite é inválido, venceu ou já está sendo usado. Peça um novo link à escola.';
    }
    if (text.includes('nao foi possivel concluir')) {
        return 'Não foi possível concluir o cadastro. Se você já tem conta com este e-mail, entre pelo login; senão, tente de novo em instantes.';
    }
    if (text.includes('indisponivel')) return 'Cadastro temporariamente indisponível. Tente de novo em instantes.';
    return GENERIC_REGISTRATION_ERROR;
}

/** Lê a mensagem do corpo de um erro não-2xx do `functions.invoke`. */
export async function functionErrorText(error: unknown): Promise<string> {
    const record = error && typeof error === 'object' ? error as { message?: unknown; context?: unknown } : {};
    const context = record.context as { json?: () => Promise<unknown> } | undefined;
    try {
        const body = await context?.json?.();
        if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
            return (body as { error: string }).error;
        }
    } catch {
        // Sem corpo legível (rede caiu, proxy devolveu HTML): fica a mensagem do erro.
    }
    return typeof record.message === 'string' ? record.message : '';
}

/**
 * Copia o texto. A API de clipboard falha em navegador embutido (Instagram,
 * WhatsApp antigo) e fora de contexto seguro; aí tenta o caminho antigo.
 * `false` = não copiou, e a tela oferece o código selecionado para copiar à mão.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
    try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // Permissão negada ou contexto inseguro: tenta o caminho antigo abaixo.
    }
    if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    try {
        area.select();
        return document.execCommand('copy');
    } catch {
        return false;
    } finally {
        area.remove();
    }
}
