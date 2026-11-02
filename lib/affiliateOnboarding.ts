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
 *
 * ⚠️ A trava mede BRANCO SÓLIDO sobre a cor. Por isso a página escreve sobre a
 * cor da escola só em branco sólido e escurece (nunca clareia) o fundo por
 * decoração: branco a 75% sobre #2563EB — o azul do próprio app — dá 3,6:1.
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

/**
 * Fundo da faixa do topo. A decoração só ESCURECE a cor da escola (ou usa a cor
 * de apoio, que passou pela mesma trava): o texto por cima é branco sólido, e
 * clarear com branco translúcido derrubava o contraste nas cores no limite.
 */
export function affiliateBandBackground(brand: AffiliateBrand): string {
    const glow = brand.secondary
        ? `radial-gradient(120% 90% at 100% 0%, ${brand.secondary} 0%, transparent 60%)`
        : 'radial-gradient(120% 90% at 100% 0%, rgba(0,0,0,0.22) 0%, transparent 55%)';
    return `${glow}, radial-gradient(80% 70% at 0% 100%, rgba(0,0,0,0.14) 0%, transparent 70%), ${brand.primary}`;
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
    if (text.includes('conta de aluno vinculada')) {
        return 'Entre na conta de aluno que recebeu este convite e tente novamente.';
    }
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
 *
 * O caminho antigo seleciona um textarea escondido — o que leva o foco para
 * ele, e remover o textarea deixava o foco no `body` (quem usa teclado ou leitor
 * de tela recomeçava do topo da página). O foco e a seleção de antes voltam.
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
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const selection = document.getSelection();
    const previousRanges = selection
        ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index))
        : [];
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.setAttribute('aria-hidden', 'true');
    area.tabIndex = -1;
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '0';
    area.style.opacity = '0';
    // 16 px: abaixo disso o iOS dá zoom na página ao focar o campo.
    area.style.fontSize = '16px';
    document.body.appendChild(area);
    try {
        area.select();
        area.setSelectionRange(0, text.length);
        return document.execCommand('copy');
    } catch {
        return false;
    } finally {
        area.remove();
        if (selection) {
            selection.removeAllRanges();
            previousRanges.forEach(range => selection.addRange(range));
        }
        if (previousFocus && previousFocus !== document.body && previousFocus.isConnected) {
            previousFocus.focus({ preventScroll: true });
        }
    }
}

/**
 * Tamanho do código no cupom. O código nunca quebra no meio ("AFILIADA1" numa
 * linha e "0" na outra, como saía em 360–393 px): cada faixa de comprimento
 * tem a fonte que cabe inteira numa linha na largura útil mínima. Só código
 * acima de 21 caracteres (o limite é 32) pode quebrar.
 */
export type CouponCodeSize = 'xl' | 'lg' | 'md' | 'sm';

/** Largura útil mínima do código (px): celular de 320 px, descontadas margens e respiros. */
export const COUPON_CODE_MIN_WIDTH_PX = 200;

/** Fonte do código em cada faixa, no celular (px). A partir de 640 px o espaço cresce e a fonte também. */
export const COUPON_CODE_FONT_PX: Record<CouponCodeSize, number> = { xl: 26, lg: 21, md: 16, sm: 13 };

/** Avanço de um caractere monoespaçado (≈0,6em, com folga) mais o tracking de 0,08em. */
const MONO_ADVANCE_EM = 0.62 + 0.08;

/** Maior código que ainda cabe numa linha em `COUPON_CODE_MIN_WIDTH_PX`. */
export const COUPON_CODE_NOWRAP_MAX = 21;

export function couponCodeSize(code: string): CouponCodeSize {
    const length = code.trim().length;
    if (length <= 10) return 'xl';
    if (length <= 13) return 'lg';
    if (length <= 17) return 'md';
    return 'sm';
}

/** Largura estimada do código numa linha (px), com a fonte da faixa dele. */
export function couponCodeWidthPx(code: string, size: CouponCodeSize = couponCodeSize(code)): number {
    return code.trim().length * MONO_ADVANCE_EM * COUPON_CODE_FONT_PX[size];
}
