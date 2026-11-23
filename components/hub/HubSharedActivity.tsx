import React, { useEffect, useState } from 'react';
import { AlertCircle, Loader2, Printer } from 'lucide-react';
import { HubMaterialView, type HubMaterialRecord } from './HubMaterialGenerator';
import { viewHubSharedMaterial, type HubAccountBranding } from './hubService';

const MESSAGES: Record<string, string> = {
  LINK_EXPIRED: 'Este link de atividade venceu. Peça um link novo ao seu professor.',
  LINK_INVALID: 'Este link de atividade não existe mais. Peça um link novo ao seu professor.',
};

/** Atividade aberta por link/QR, sem login: versão do aluno (sem gabarito), com o logo do professor. */
const HubSharedActivity: React.FC<{ token: string }> = ({ token }) => {
  const [record, setRecord] = useState<HubMaterialRecord | null>(null);
  const [branding, setBranding] = useState<HubAccountBranding | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    viewHubSharedMaterial(token)
      .then((data) => {
        if (!alive) return;
        setRecord(data.material as HubMaterialRecord);
        setBranding(data.branding);
      })
      .catch((err: Error) => {
        if (alive) setError(MESSAGES[err.message] ?? 'Não consegui abrir a atividade agora. Tente de novo em instantes.');
      });
    return () => { alive = false; };
  }, [token]);

  return (
    <main className="min-h-screen bg-brand-bg px-4 py-6 text-brand-text sm:px-8">
      <div className="mx-auto max-w-3xl space-y-4">
        {!record && !error && (
          <p className="flex items-center gap-2 text-sm text-brand-muted" role="status"><Loader2 className="animate-spin" size={16} />Abrindo a atividade...</p>
        )}
        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-700"><AlertCircle className="mt-0.5 shrink-0" size={16} />{error}</div>
        )}
        {record && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
              <p className="text-xs text-brand-muted">Atividade enviada pelo seu professor. Não precisa criar conta.</p>
              <button type="button" onClick={() => window.print()} className="inline-flex min-h-11 items-center gap-2 rounded-2xl border border-brand-border bg-brand-surface px-4 py-2.5 text-xs font-black"><Printer size={15} />Imprimir / salvar PDF</button>
            </div>
            <HubMaterialView record={record} teacher={false} branding={branding} />
          </>
        )}
      </div>
    </main>
  );
};

export default HubSharedActivity;
