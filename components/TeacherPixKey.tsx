import React, { useEffect, useRef, useState } from 'react';
import { loadAuthorizedProfilePrivate } from '../lib/profilePrivacy';

// A chave Pix é PII e nunca vem junto da listagem: só é buscada quando alguém
// autorizado clica para ver. Quem pode ler é decidido pelo banco, na RPC
// get_authorized_profile_private — a UI não presume permissão.

interface Props { teacherId: string; }

const TeacherPixKey: React.FC<Props> = ({ teacherId }) => {
  // Contador de versão: descarta resposta de uma consulta que já foi trocada
  // por outra (troca de professor no meio da requisição).
  const request = useRef(0);
  const [key, setKey] = useState<string | null>(null);
  const [type, setType] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    request.current++;
    setKey(null);
    setType('');
    setError('');
    setCopied(false);
    setLoading(false);
    return () => { request.current++; };
  }, [teacherId]);

  const reveal = async () => {
    const version = ++request.current;
    setLoading(true);
    setError('');
    try {
      const data = await loadAuthorizedProfilePrivate(teacherId);
      if (version !== request.current) return;
      setKey(typeof data.pix_key === 'string' ? data.pix_key.trim() : '');
      setType(typeof data.pix_key_type === 'string' ? data.pix_key_type : '');
    } catch {
      if (version === request.current) setError('Não foi possível consultar o Pix. Tente novamente.');
    } finally {
      if (version === request.current) setLoading(false);
    }
  };

  const copy = async () => {
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
      setError('');
    } catch {
      setError('Não foi possível copiar. Selecione a chave exibida.');
    }
  };

  return (
    <div className="mt-2 min-w-0 text-xs" onClick={(e) => e.stopPropagation()}>
      {key === null ? (
        <button
          type="button"
          disabled={loading}
          onClick={reveal}
          className="rounded-lg border border-brand-border px-3 py-2 font-bold text-tenant-primary disabled:opacity-50"
        >
          {loading ? 'Consultando Pix…' : 'Ver chave Pix'}
        </button>
      ) : key ? (
        <div className="rounded-lg border border-brand-border p-2">
          <p className="text-brand-muted">Pix cadastrado{type ? ` · ${type}` : ''}</p>
          <p className="select-text break-all font-semibold text-brand-text">{key}</p>
          <button type="button" onClick={copy} className="mt-1 px-2 py-1 font-bold text-tenant-primary">
            {copied ? 'Pix copiado' : 'Copiar Pix'}
          </button>
        </div>
      ) : (
        <p className="text-amber-700">Professor sem chave Pix cadastrada.</p>
      )}
      {error && <p role="alert" className="mt-1 text-red-600">{error}</p>}
    </div>
  );
};

export default TeacherPixKey;
