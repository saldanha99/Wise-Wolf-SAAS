import { describe, expect, it, vi } from 'vitest';

const createSignedUrl = vi.hoisted(() => vi.fn());

vi.mock('./supabase', () => ({
  supabase: {
    storage: {
      from: () => ({ createSignedUrl }),
    },
  },
}));

import {
  buildTeacherInvoiceObjectPath,
  createInvoiceDocumentUrl,
  normalizeInvoiceObjectPath,
} from './invoiceStorage';

describe('invoiceStorage', () => {
  it('normaliza somente referências do bucket privado de notas', () => {
    const path = 'closings/9f8ce693-79a0-4ab2-90af-5db482e629f2/7dc5ad61-bf98-492a-a16d-9d58716506e3.pdf';
    expect(normalizeInvoiceObjectPath(path)).toBe(path);
    expect(normalizeInvoiceObjectPath(`https://api.example.com/storage/v1/object/sign/invoices/${path}?token=secret`)).toBe(path);
    expect(normalizeInvoiceObjectPath('https://attacker.example/arquivo.pdf')).toBeNull();
    expect(normalizeInvoiceObjectPath('../arquivo.pdf')).toBeNull();
  });

  it('gera caminho sem nome original ou dado pessoal', () => {
    vi.stubGlobal('crypto', { randomUUID: () => '7dc5ad61-bf98-492a-a16d-9d58716506e3' });
    expect(buildTeacherInvoiceObjectPath('9f8ce693-79a0-4ab2-90af-5db482e629f2')).toBe(
      'closings/9f8ce693-79a0-4ab2-90af-5db482e629f2/7dc5ad61-bf98-492a-a16d-9d58716506e3.pdf',
    );
    vi.unstubAllGlobals();
  });

  it('emite somente URL temporária de cinco minutos', async () => {
    const path = 'closings/9f8ce693-79a0-4ab2-90af-5db482e629f2/7dc5ad61-bf98-492a-a16d-9d58716506e3.pdf';
    createSignedUrl.mockResolvedValueOnce({
      data: { signedUrl: 'https://storage.example.invalid/temporary' },
      error: null,
    });

    await expect(createInvoiceDocumentUrl(path)).resolves.toBe('https://storage.example.invalid/temporary');
    expect(createSignedUrl).toHaveBeenCalledWith(path, 300);
  });
});
