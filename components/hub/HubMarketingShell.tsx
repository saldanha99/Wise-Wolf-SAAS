import React, { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion, useScroll } from 'framer-motion';
import { ArrowRight, Menu, Moon, ShieldCheck, Sun, X } from 'lucide-react';
import { hubMarketingPath } from './hubRoutes';
import './hub-marketing.css';
import './hub-marketing-wolfie.css';

const BRAND_LOGO = '/assets/wolfie/brand/wise-wolf-logo-horizontal-dark.png';
export const HUB_THEME_STORAGE_KEY = 'wise-wolf-hub-theme';

export type HubMarketingTheme = 'light' | 'dark';

export interface HubMarketingNavItem {
  label: string;
  href: string;
}

interface HubMarketingShellProps {
  children: React.ReactNode;
  navItems?: HubMarketingNavItem[];
  onLogin?: () => void;
  onPrimary?: () => void;
  loginHref?: string;
  primaryHref?: string;
  primaryLabel: string;
  primaryDisabled?: boolean;
  accent?: string;
  pageLabel?: string;
}

interface HubRevealProps {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  direction?: 'up' | 'left' | 'right' | 'scale';
  as?: 'div' | 'li';
}

const readInitialTheme = (): HubMarketingTheme => {
  try {
    const stored = window.localStorage.getItem(HUB_THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {}
  return 'light';
};

export const HubReveal: React.FC<HubRevealProps> = ({ children, className, delay = 0, direction = 'up', as = 'div' }) => {
  const reducedMotion = useReducedMotion();
  const RevealElement = as === 'li' ? motion.li : motion.div;
  const offset = direction === 'left'
    ? { x: -24, y: 0, scale: 1 }
    : direction === 'right'
      ? { x: 24, y: 0, scale: 1 }
      : direction === 'scale'
        ? { x: 0, y: 12, scale: 0.97 }
        : { x: 0, y: 24, scale: 1 };

  return (
    <RevealElement
      className={className}
      initial={reducedMotion ? false : { opacity: 0, ...offset }}
      whileInView={{ opacity: 1, x: 0, y: 0, scale: 1 }}
      viewport={{ once: true, amount: 0.12, margin: '0px 0px -7% 0px' }}
      transition={{ duration: reducedMotion ? 0 : 0.72, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </RevealElement>
  );
};

const HubScrollProgress: React.FC = () => {
  const reducedMotion = useReducedMotion();
  const { scrollYProgress } = useScroll();
  if (reducedMotion) return null;
  return <motion.div className="hub-scroll-progress" aria-hidden="true" style={{ scaleX: scrollYProgress }} />;
};

export const HubBrand: React.FC<{ compact?: boolean }> = ({ compact = false }) => (
  <span className={`hub-brand ${compact ? 'hub-brand--compact' : ''}`}>
    <span className="hub-brand__logo-wrap">
      <img src={BRAND_LOGO} alt="Wise Wolf" className="hub-brand__logo" />
    </span>
    <span className="hub-brand__divider" aria-hidden="true" />
    <span className="hub-brand__hub">Hub</span>
  </span>
);

export const HubSectionIntro: React.FC<{
  eyebrow: string;
  title: React.ReactNode;
  description?: string;
  align?: 'left' | 'center';
}> = ({ eyebrow, title, description, align = 'left' }) => (
  <div className={`hub-section-intro hub-section-intro--${align}`}>
    <p className="hub-eyebrow"><span aria-hidden="true" />{eyebrow}</p>
    <h2>{title}</h2>
    {description && <p className="hub-section-intro__description">{description}</p>}
  </div>
);

export const HubFaq: React.FC<{
  items: Array<{ question: string; answer: string }>;
  eyebrow?: string;
  title?: string;
}> = ({ items, eyebrow = 'Dúvidas antes de começar', title = 'Perguntas frequentes' }) => {
  const [openIndex, setOpenIndex] = useState<number | null>(0);
  return (
    <section className="hub-section hub-faq-section" id="perguntas">
      <div className="hub-container hub-faq-layout">
        <HubReveal>
          <HubSectionIntro eyebrow={eyebrow} title={title} description="Respostas diretas para você decidir com clareza." />
        </HubReveal>
        <HubReveal className="hub-faq" delay={0.08}>
          {items.map((item, index) => {
            const isOpen = openIndex === index;
            return (
              <article key={item.question} className={`hub-faq__item ${isOpen ? 'is-open' : ''}`}>
                <button
                  type="button"
                  className="hub-faq__question"
                  aria-expanded={isOpen}
                  aria-controls={`hub-faq-answer-${index}`}
                  onClick={() => setOpenIndex(isOpen ? null : index)}
                >
                  <span className="hub-faq__number">{String(index + 1).padStart(2, '0')}</span>
                  <span>{item.question}</span>
                  <span className="hub-faq__toggle" aria-hidden="true">{isOpen ? '−' : '+'}</span>
                </button>
                <div id={`hub-faq-answer-${index}`} className="hub-faq__answer" hidden={!isOpen}>
                  <p>{item.answer}</p>
                </div>
              </article>
            );
          })}
        </HubReveal>
      </div>
    </section>
  );
};

const SOLUTION_NAV: HubMarketingNavItem[] = [
  { label: 'Biblioteca', href: hubMarketingPath('library') },
  { label: 'Educador IA', href: hubMarketingPath('educator-ai') },
  { label: 'Wolfie', href: hubMarketingPath('wolfie') },
  { label: 'School OS', href: hubMarketingPath('school-os') },
];

const DEFAULT_NAV: HubMarketingNavItem[] = [
  { label: 'Para professores', href: hubMarketingPath('teachers') },
  { label: 'Para escolas', href: hubMarketingPath('schools') },
  { label: 'Soluções', href: `${hubMarketingPath('overview')}#solucoes` },
  { label: 'Wolfie', href: hubMarketingPath('wolfie') },
  { label: 'Planos', href: `${hubMarketingPath('teachers')}#planos` },
];

const HubMarketingShell: React.FC<HubMarketingShellProps> = ({
  children,
  navItems = DEFAULT_NAV,
  onLogin,
  onPrimary,
  loginHref,
  primaryHref,
  primaryLabel,
  primaryDisabled = false,
  accent = '#e72d3d',
  pageLabel,
}) => {
  const [theme, setTheme] = useState<HubMarketingTheme>(readInitialTheme);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuPanelRef = useRef<HTMLDivElement>(null);
  const mobileMenuTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(HUB_THEME_STORAGE_KEY, theme);
      window.localStorage.setItem('theme', theme);
    } catch {}
    document.documentElement.classList.toggle('dark', theme === 'dark');
    const themeMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const previousColor = themeMeta?.content;
    if (themeMeta) themeMeta.content = theme === 'dark' ? '#08090c' : '#f5f2eb';
    return () => {
      if (themeMeta && previousColor) themeMeta.content = previousColor;
    };
  }, [theme]);

  useEffect(() => {
    if (!mobileMenuOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusableSelector = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusTimer = window.setTimeout(() => {
      mobileMenuPanelRef.current?.querySelector<HTMLElement>(focusableSelector)?.focus();
    }, 0);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMobileMenuOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const controls: HTMLElement[] = mobileMenuPanelRef.current
        ? Array.from(mobileMenuPanelRef.current.querySelectorAll(focusableSelector)) as HTMLElement[]
        : [];
      if (controls.length === 0) return;
      const first = controls.at(0);
      const last = controls.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      window.clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', closeOnEscape);
      mobileMenuTriggerRef.current?.focus();
    };
  }, [mobileMenuOpen]);

  const toggleTheme = () => setTheme((current) => current === 'light' ? 'dark' : 'light');
  const rootStyle = { '--hub-accent': accent } as React.CSSProperties;

  return (
    <div className="hub-marketing" data-hub-theme={theme} style={rootStyle}>
      <a className="hub-skip-link" href="#hub-main">Pular para o conteúdo</a>
      <HubScrollProgress />
      <header className="hub-header">
        <div className="hub-header__inner">
          <a href={hubMarketingPath('overview')} className="hub-header__brand" aria-label="Wise Wolf Hub — página inicial">
            <HubBrand />
            {pageLabel && <span className="hub-header__page-label">{pageLabel}</span>}
          </a>

          <nav className="hub-header__nav" aria-label="Jornadas e soluções do Hub">
            {navItems.map((item) => <a key={`${item.label}-${item.href}`} href={item.href}>{item.label}</a>)}
          </nav>

          <div className="hub-header__actions">
            <button type="button" className="hub-theme-toggle" onClick={toggleTheme} aria-label={`Ativar modo ${theme === 'light' ? 'escuro' : 'claro'}`}>
              {theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}
            </button>
            {loginHref
              ? <a className="hub-header__login" href={loginHref}>Entrar</a>
              : <button type="button" className="hub-header__login" onClick={onLogin}>Entrar</button>}
            {primaryHref && !primaryDisabled
              ? <a className="hub-button hub-button--primary hub-header__cta" href={primaryHref}><span>{primaryLabel}</span><ArrowRight size={16} /></a>
              : <button type="button" disabled={primaryDisabled} className="hub-button hub-button--primary hub-header__cta" onClick={onPrimary}>
                  <span>{primaryLabel}</span><ArrowRight size={16} />
                </button>}
            <button ref={mobileMenuTriggerRef} type="button" className="hub-mobile-toggle" onClick={() => setMobileMenuOpen(true)} aria-label="Abrir menu" aria-expanded={mobileMenuOpen}>
              <Menu size={20} />
            </button>
          </div>
        </div>
      </header>

      {mobileMenuOpen && (
        <div className="hub-mobile-menu" role="dialog" aria-modal="true" aria-label="Menu do Hub">
          <button type="button" className="hub-mobile-menu__backdrop" onClick={() => setMobileMenuOpen(false)} aria-hidden="true" tabIndex={-1} />
          <div ref={mobileMenuPanelRef} className="hub-mobile-menu__panel">
            <div className="hub-mobile-menu__top">
              <HubBrand compact />
              <button type="button" className="hub-theme-toggle" onClick={() => setMobileMenuOpen(false)} aria-label="Fechar menu"><X size={19} /></button>
            </div>
            <nav aria-label="Jornadas e soluções do Hub no celular">
              {navItems.map((item, index) => (
                <a key={`${item.label}-${item.href}`} href={item.href} onClick={() => setMobileMenuOpen(false)}>
                  <span>{String(index + 1).padStart(2, '0')}</span>{item.label}<ArrowRight size={17} />
                </a>
              ))}
            </nav>
            <button type="button" className="hub-mobile-menu__theme" onClick={toggleTheme}>
              {theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}
              Usar modo {theme === 'light' ? 'escuro' : 'claro'}
            </button>
            {primaryHref && !primaryDisabled
              ? <a className="hub-button hub-button--primary" href={primaryHref}>{primaryLabel}<ArrowRight size={17} /></a>
              : <button type="button" disabled={primaryDisabled} className="hub-button hub-button--primary" onClick={() => { setMobileMenuOpen(false); onPrimary?.(); }}>
                  {primaryLabel}<ArrowRight size={17} />
                </button>}
            {loginHref
              ? <a className="hub-mobile-menu__login" href={loginHref}>Já tenho uma conta</a>
              : <button type="button" className="hub-mobile-menu__login" onClick={() => { setMobileMenuOpen(false); onLogin?.(); }}>Já tenho uma conta</button>}
          </div>
        </div>
      )}

      <main id="hub-main">{children}</main>

      <footer className="hub-footer">
        <div className="hub-container hub-footer__top">
          <div>
            <HubBrand />
            <p>A infraestrutura para ensinar, engajar e crescer.</p>
          </div>
          <div className="hub-footer__links">
            <nav aria-label="Jornadas do Hub">
              <p className="hub-footer__links-label">Jornadas</p>
              {DEFAULT_NAV.slice(0, 2).map((item) => <a key={item.label} href={item.href}>{item.label}</a>)}
              <a href={`${hubMarketingPath('teachers')}#planos`}>Planos</a>
            </nav>
            <nav aria-label="Soluções do Hub">
              <p className="hub-footer__links-label">Soluções</p>
              {SOLUTION_NAV.map((item) => <a key={item.label} href={item.href}>{item.label}</a>)}
            </nav>
          </div>
          <div className="hub-footer__trust"><ShieldCheck size={17} />Ambientes e acessos separados por conta.</div>
        </div>
        <div className="hub-container hub-footer__bottom">
          <p>© {new Date().getFullYear()} Wise Wolf.</p>
          <div className="hub-footer__legal-links">
            <a href={hubMarketingPath('terms')}>Termos de Uso</a>
            <a href={hubMarketingPath('privacy')}>Privacidade</a>
            <button type="button" onClick={toggleTheme}>Modo {theme === 'light' ? 'escuro' : 'claro'}</button>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default HubMarketingShell;
