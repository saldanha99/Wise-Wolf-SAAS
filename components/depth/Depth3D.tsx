import React, { useCallback, useRef } from 'react';

// Peças da linguagem 3D (CSS em index.css, seção "Profundidade 3D"). Ficam
// separadas das telas para Mapa de Aulas, Dinheiro, Relatórios e Professores
// falarem a mesma língua visual.

export type Tone = 'brand' | 'emerald' | 'sky' | 'violet' | 'amber' | 'rose' | 'orange' | 'teal' | 'slate';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

interface TiltProps extends React.HTMLAttributes<HTMLDivElement> {
  // Ângulo máximo, em graus. Placas grandes inclinam menos.
  max?: number;
  as?: 'div' | 'article' | 'section';
}

/** Placa que inclina seguindo o ponteiro, com reflexo de luz. */
export const Tilt3D: React.FC<TiltProps> = ({ max = 6, as = 'div', className = '', children, onPointerMove, onPointerLeave, ...rest }) => {
  const ref = useRef<HTMLElement | null>(null);

  const move = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    onPointerMove?.(event);
    const el = ref.current;
    if (!el || event.pointerType === 'touch' || prefersReducedMotion()) return;
    const box = el.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width;
    const y = (event.clientY - box.top) / box.height;
    el.style.setProperty('--ry', `${((x - 0.5) * max * 2).toFixed(2)}deg`);
    el.style.setProperty('--rx', `${((0.5 - y) * max * 2).toFixed(2)}deg`);
    el.style.setProperty('--gx', `${(x * 100).toFixed(1)}%`);
    el.style.setProperty('--gy', `${(y * 100).toFixed(1)}%`);
    el.style.setProperty('--glare', '1');
  }, [max, onPointerMove]);

  const leave = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    onPointerLeave?.(event);
    const el = ref.current;
    if (!el) return;
    el.style.setProperty('--rx', '0deg');
    el.style.setProperty('--ry', '0deg');
    el.style.setProperty('--glare', '0');
  }, [onPointerLeave]);

  const Tag = as as 'div';
  return (
    <Tag
      ref={ref as React.Ref<HTMLDivElement>}
      className={`ww-tilt ${className}`}
      onPointerMove={move}
      onPointerLeave={leave}
      {...rest}
    >
      {children}
      <span aria-hidden="true" className="ww-glare" />
    </Tag>
  );
};

interface KpiProps {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: Tone;
  // 0–100: desenha um anel ao lado do número.
  ring?: number | null;
  valueClassName?: string;
  className?: string;
}

/** Cartão de número com orbe, inclinação e anel opcional. */
export const Kpi3D: React.FC<KpiProps> = ({ icon, label, value, hint, tone = 'brand', ring, valueClassName = '', className = '' }) => (
  <Tilt3D className={`ww-slab tone-${tone} p-4 sm:p-5 min-w-0 ${className}`}>
    <div className="flex items-start gap-3 min-w-0">
      <div className="ww-orb h-11 w-11 shrink-0">{icon}</div>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-black uppercase tracking-[0.14em] text-brand-muted truncate">{label}</p>
        <p className={`mt-0.5 text-xl sm:text-2xl font-black tracking-tight text-brand-text leading-tight ${valueClassName}`}>{value}</p>
        {hint ? <p className="mt-1 text-[11px] font-semibold text-brand-muted leading-snug">{hint}</p> : null}
      </div>
      {typeof ring === 'number' ? <Ring3D value={ring} tone={tone} size={48} /> : null}
    </div>
  </Tilt3D>
);

/** Anel de progresso com bisel; o número fica no centro. */
// `unit` = '' para notas de 0 a 100 que não são porcentagem (TPI).
export const Ring3D: React.FC<{ value: number; tone?: Tone; size?: number; label?: string; unit?: string }> = ({ value, tone = 'brand', size = 56, label, unit = '%' }) => {
  const p = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div
      role="img"
      aria-label={label || `${p}${unit}`}
      className={`ww-ring tone-${tone} grid place-items-center shrink-0`}
      style={{ width: size, height: size, ['--p' as string]: p } as React.CSSProperties}
    >
      <span className="text-[11px] font-black text-brand-text">{p}{unit}</span>
    </div>
  );
};

export interface TowerDatum {
  key: string;
  label: string;
  sublabel?: string;
  value: number;
  tone?: Tone;
  caption?: string;
  highlight?: boolean;
}

/** Gráfico de torres 3D. Altura proporcional ao maior valor da série. */
export const Towers3D: React.FC<{ data: TowerDatum[]; height?: number; format?: (v: number) => string; ariaLabel: string }> = ({ data, height = 120, format = v => String(v), ariaLabel }) => {
  const max = Math.max(1, ...data.map(d => Math.abs(d.value)));
  return (
    <div role="img" aria-label={ariaLabel} className="flex items-end gap-3 sm:gap-4 pt-6 pr-3">
      {data.map((d, i) => {
        const h = Math.max(4, Math.round((Math.abs(d.value) / max) * height));
        return (
          <div key={d.key} className="flex-1 min-w-0 flex flex-col items-center gap-2">
            <span className={`text-[10px] font-black whitespace-nowrap ${d.highlight ? 'text-brand-text' : 'text-brand-muted'}`}>{format(d.value)}</span>
            <div className="w-full flex justify-center" style={{ height }}>
              <div className="flex items-end h-full w-[70%] max-w-12">
                <div
                  className={`ww-tower tone-${d.tone || 'brand'} w-full`}
                  style={{ height: h, animationDelay: `${i * 70}ms` }}
                  title={d.caption}
                />
              </div>
            </div>
            <div className="text-center min-w-0 w-full">
              <p className={`text-[10px] font-black uppercase tracking-wider truncate ${d.highlight ? 'text-tenant-primary dark:text-brand-accent' : 'text-brand-text'}`}>{d.label}</p>
              {d.sublabel ? <p className="text-[9px] font-bold text-brand-muted truncate">{d.sublabel}</p> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
};

/** Cabeçalho de página com título grande e área de ações. */
export const PageHero3D: React.FC<{ icon: React.ReactNode; eyebrow: string; title: string; subtitle?: React.ReactNode; tone?: Tone; actions?: React.ReactNode }> = ({ icon, eyebrow, title, subtitle, tone = 'brand', actions }) => (
  <header className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
    <div className="flex items-center gap-4 min-w-0">
      <div className={`ww-orb tone-${tone} h-14 w-14 shrink-0`}>{icon}</div>
      <div className="min-w-0">
        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-brand-muted">{eyebrow}</p>
        <h2 className="text-2xl md:text-3xl font-black tracking-tight text-brand-text leading-tight">{title}</h2>
        {subtitle ? <p className="text-sm text-brand-muted mt-0.5">{subtitle}</p> : null}
      </div>
    </div>
    {actions ? <div className="flex flex-col sm:flex-row gap-2 sm:items-center w-full lg:w-auto">{actions}</div> : null}
  </header>
);
