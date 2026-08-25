import React from 'react';
import { FileCheck2, ShieldCheck } from 'lucide-react';
import { HUB_CORE_LEGAL_DOCUMENTS } from '../../supabase/functions/create-hub-checkout/legal-documents';
import HubMarketingShell from './HubMarketingShell';
import {
  hubMarketingPath,
  resolveSystemAppUrl,
  type HubLegalMarketingPage,
} from './hubRoutes';

const HubLegalPage: React.FC<{ page: HubLegalMarketingPage }> = ({ page }) => {
  const document = HUB_CORE_LEGAL_DOCUMENTS[page];
  const DocumentIcon = page === 'terms' ? FileCheck2 : ShieldCheck;

  return (
    <HubMarketingShell
      navItems={[
        { label: 'Visão geral', href: hubMarketingPath('overview') },
        { label: 'Termos de Uso', href: hubMarketingPath('terms') },
        { label: 'Privacidade', href: hubMarketingPath('privacy') },
      ]}
      onLogin={() => { window.location.href = resolveSystemAppUrl('/login'); }}
      onPrimary={() => { window.location.href = `${hubMarketingPath('overview')}#solucoes`; }}
      primaryLabel="Conhecer soluções"
      pageLabel={page === 'terms' ? 'Termos' : 'Privacidade'}
    >
      <section className="hub-legal-hero">
        <div className="hub-container hub-legal-hero__inner">
          <div className="hub-legal-hero__icon"><DocumentIcon size={28} aria-hidden="true" /></div>
          <p className="hub-eyebrow"><span aria-hidden="true" />{document.eyebrow}</p>
          <h1>{document.title}</h1>
          <p>{document.summary}</p>
          <div className="hub-legal-version">
            <strong>Versão {document.version}</strong>
            <span>Vigente desde {document.effectiveDateLabel}</span>
          </div>
        </div>
      </section>

      <div className="hub-container hub-legal-layout">
        <aside className="hub-legal-index" aria-label="Sumário do documento">
          <p>Neste documento</p>
          <nav>
            {document.sections.map((section) => <a key={section.id} href={`#${section.id}`}>{section.title}</a>)}
          </nav>
        </aside>

        <article className="hub-legal-document">
          {document.sections.map((section) => (
            <section key={section.id} id={section.id}>
              <h2>{section.title}</h2>
              {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
              {section.items && <ul>{section.items.map((item) => <li key={item}>{item}</li>)}</ul>}
            </section>
          ))}
          <div className="hub-legal-related">
            <DocumentIcon size={20} aria-hidden="true" />
            <div>
              <strong>Leia também</strong>
              <a href={hubMarketingPath(page === 'terms' ? 'privacy' : 'terms')}>
                {page === 'terms' ? 'Política de Privacidade' : 'Termos de Uso'}
              </a>
            </div>
          </div>
        </article>
      </div>
    </HubMarketingShell>
  );
};

export default HubLegalPage;
