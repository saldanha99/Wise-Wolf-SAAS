import React from 'react';
import { Loader2 } from 'lucide-react';
import { useInvoiceDocumentUrl } from '../hooks/useInvoiceDocumentUrl';

interface InvoiceDocumentLinkProps extends Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  reference?: string | null;
  loadingLabel?: string;
}

const InvoiceDocumentLink: React.FC<InvoiceDocumentLinkProps> = ({
  reference,
  loadingLabel = 'Autorizando arquivo…',
  children,
  className,
  ...anchorProps
}) => {
  const { url, loading, error } = useInvoiceDocumentUrl(reference);

  if (loading) {
    return (
      <span className={className} aria-live="polite">
        <Loader2 size={14} className="animate-spin" /> {loadingLabel}
      </span>
    );
  }

  if (!url) {
    return (
      <span className={className} role="status" title={error || 'Arquivo não autorizado'}>
        Arquivo indisponível
      </span>
    );
  }

  return (
    <a
      {...anchorProps}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      {children}
    </a>
  );
};

export default InvoiceDocumentLink;
