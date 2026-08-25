import { supabase } from './supabase';

const INVOICE_BUCKET = 'invoices';
const INVOICE_SIGNED_URL_TTL_SECONDS = 5 * 60;
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const CLOSING_OBJECT_PATTERN = new RegExp(`^closings/(${UUID_PATTERN})/(${UUID_PATTERN})\\.pdf$`, 'i');
const LEGACY_OBJECT_PATTERN = /^user_[0-9a-f]{32}\/[A-Za-z0-9À-ž._() -]+\.pdf$/i;

const safeDecode = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

export const normalizeInvoiceObjectPath = (reference?: string | null): string | null => {
  const candidate = String(reference ?? '').trim();
  if (!candidate || candidate.length > 2_000 || /[\u0000-\u001f\u007f\\]/.test(candidate)) return null;

  let objectPath = candidate;
  if (/^https?:\/\//i.test(candidate)) {
    try {
      const url = new URL(candidate);
      const marker = `/storage/v1/object/sign/${INVOICE_BUCKET}/`;
      const markerIndex = url.pathname.indexOf(marker);
      if (markerIndex < 0) return null;
      const decoded = safeDecode(url.pathname.slice(markerIndex + marker.length));
      if (!decoded) return null;
      objectPath = decoded;
    } catch {
      return null;
    }
  }

  if (
    objectPath.startsWith('/') ||
    objectPath.includes('?') ||
    objectPath.includes('#') ||
    objectPath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) return null;

  return CLOSING_OBJECT_PATTERN.test(objectPath) || LEGACY_OBJECT_PATTERN.test(objectPath)
    ? objectPath
    : null;
};

export const buildTeacherInvoiceObjectPath = (closingId: string): string => {
  const normalizedClosingId = String(closingId || '').trim().toLowerCase();
  if (!new RegExp(`^${UUID_PATTERN}$`, 'i').test(normalizedClosingId)) {
    throw new Error('Fechamento inválido para o envio da nota fiscal.');
  }
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('Este navegador não oferece geração segura de arquivo. Atualize-o para enviar a nota.');
  }
  return `closings/${normalizedClosingId}/${globalThis.crypto.randomUUID().toLowerCase()}.pdf`;
};

export const createInvoiceDocumentUrl = async (
  reference?: string | null,
): Promise<string> => {
  const objectPath = normalizeInvoiceObjectPath(reference);
  if (!objectPath) throw new Error('Referência de nota fiscal inválida.');

  const { data, error } = await supabase.storage
    .from(INVOICE_BUCKET)
    .createSignedUrl(objectPath, INVOICE_SIGNED_URL_TTL_SECONDS);

  if (error || !data?.signedUrl) {
    throw error || new Error('Não foi possível autorizar a abertura da nota fiscal.');
  }
  return data.signedUrl;
};
