import { useEffect, useState } from 'react';
import { createInvoiceDocumentUrl } from '../lib/invoiceStorage';

export const useInvoiceDocumentUrl = (reference?: string | null) => {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(reference));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setError(null);
    setLoading(Boolean(reference));

    if (!reference) {
      setLoading(false);
      return () => { cancelled = true; };
    }

    createInvoiceDocumentUrl(reference)
      .then((signedUrl) => {
        if (!cancelled) setUrl(signedUrl);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : 'Não foi possível abrir a nota fiscal.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [reference]);

  return { url, loading, error };
};
