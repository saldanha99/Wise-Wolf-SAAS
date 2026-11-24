/** Aviso pendente vindo de `my_pending_platform_notices` (lista fechada de chaves). */
export interface PlatformNoticeItem {
  id: string;
  title: string;
  body: string;
}

/** Aceita só o formato esperado; qualquer outra coisa vira lista vazia (nenhum pop-up). */
export function parsePlatformNotices(value: unknown): PlatformNoticeItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const { id, title, body } = item as Record<string, unknown>;
    if (typeof id !== 'string' || typeof title !== 'string' || typeof body !== 'string') return [];
    if (!id.trim() || !title.trim() || !body.trim()) return [];
    return [{ id, title, body }];
  });
}
