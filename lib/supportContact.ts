import type { SchoolInfo } from '../components/ContractDocument';

export interface SupportContact {
    href: string;
    label: string;
}

export function buildSchoolSupportContact(
    school: SchoolInfo | null | undefined,
    message = 'Olá! Preciso de ajuda com meu acesso à escola.',
): SupportContact | null {
    const rawPhone = school?.phone?.replace(/\D/g, '') || '';
    const phone = rawPhone.length === 10 || rawPhone.length === 11
        ? `55${rawPhone}`
        : rawPhone.startsWith('55') && (rawPhone.length === 12 || rawPhone.length === 13)
            ? rawPhone
            : '';

    if (phone) {
        return {
            href: `https://wa.me/${phone}?text=${encodeURIComponent(message)}`,
            label: 'Falar no WhatsApp',
        };
    }

    const email = school?.email?.trim() || '';
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return {
            href: `mailto:${email}?subject=${encodeURIComponent('Suporte ao aluno')}`,
            label: 'Enviar e-mail',
        };
    }

    return null;
}
