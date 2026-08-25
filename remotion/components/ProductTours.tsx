import React from 'react';
import {
  ArrowRight,
  BarChart3,
  BookOpen,
  Bot,
  BriefcaseBusiness,
  Check,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  FileCheck2,
  FileText,
  Folder,
  Globe2,
  GraduationCap,
  Headphones,
  KeyRound,
  LayoutDashboard,
  Library,
  LockKeyhole,
  MessageCircle,
  Mic2,
  MousePointer2,
  Palette,
  Play,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Target,
  UserRound,
  Users,
  Vault,
  WandSparkles,
  Workflow,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import {
  Easing,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { bodyFontFamily, displayFontFamily } from '../brand/fonts';
import { brand } from '../brand/tokens';
import type { HubVideoContent } from '../types';

export type ProductTourMode = 'product' | 'proof';

export type ProductTourProps = {
  content: HubVideoContent;
  mode: ProductTourMode;
};

type CursorStep = {
  at: number;
  x: number;
  y: number;
  click?: boolean;
};

type SidebarItem = {
  label: string;
  icon: LucideIcon;
  active?: boolean;
};

const TOUR_WIDTH = 1600;
const TOUR_HEIGHT = 720;
const UI_BACKGROUND = '#0b0d12';
const UI_SURFACE = 'rgba(18, 21, 29, 0.94)';
const UI_SURFACE_SOFT = 'rgba(255, 255, 255, 0.045)';
const UI_LINE = 'rgba(255, 255, 255, 0.11)';

const clampProgress = (frame: number, start: number, end: number) => interpolate(
  frame,
  [start, end],
  [0, 1],
  {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.cubic),
  },
);

const crossfade = (frame: number, enterAt: number, leaveAt: number, duration = 12) => {
  const enter = clampProgress(frame, enterAt, enterAt + duration);
  const leave = 1 - clampProgress(frame, leaveAt, leaveAt + duration);
  return Math.min(enter, leave);
};

const revealStyle = (progress: number, distance = 24): React.CSSProperties => ({
  opacity: progress,
  transform: `translateY(${(1 - progress) * distance}px) scale(${0.97 + progress * 0.03})`,
});

const panelStyle = (accent?: string): React.CSSProperties => ({
  border: `1px solid ${accent ? `${accent}45` : UI_LINE}`,
  borderRadius: 20,
  background: UI_SURFACE_SOFT,
  boxShadow: accent ? `inset 0 0 34px ${accent}0c` : undefined,
});

const ChromeDots: React.FC = () => (
  <div style={{ display: 'flex', gap: 7 }}>
    {['#ff6f61', '#ffbe55', '#55ca7b'].map((color) => (
      <span key={color} style={{ width: 10, height: 10, borderRadius: '50%', background: color }} />
    ))}
  </div>
);

const TourShell: React.FC<{
  accent: string;
  title: string;
  status: string;
  backdrop: string;
  children: React.ReactNode;
}> = ({ accent, title, status, backdrop, children }) => {
  const frame = useCurrentFrame();
  const glowX = interpolate(frame, [0, 260], [-120, 1320], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'extend',
  });

  return (
    <div
      style={{
        position: 'relative',
        width: TOUR_WIDTH,
        height: TOUR_HEIGHT,
        overflow: 'hidden',
        border: `1px solid ${UI_LINE}`,
        borderRadius: 34,
        background: UI_BACKGROUND,
        boxShadow: `0 48px 150px rgba(0,0,0,0.54), 0 0 110px ${accent}1c`,
        color: brand.ink,
        fontFamily: bodyFontFamily,
      }}
    >
      <Img
        src={staticFile(backdrop)}
        style={{
          position: 'absolute',
          inset: -24,
          width: TOUR_WIDTH + 48,
          height: TOUR_HEIGHT + 48,
          objectFit: 'cover',
          opacity: 0.19,
          filter: 'saturate(0.78) contrast(1.08)',
          transform: `scale(${1.035 + frame / 24000}) translateX(${Math.sin(frame / 58) * 4}px)`,
        }}
      />
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(120deg, rgba(7,8,11,0.97), rgba(7,8,11,0.76) 48%, rgba(7,8,11,0.92))' }} />
      <div
        style={{
          position: 'absolute',
          left: glowX,
          top: -240,
          width: 330,
          height: 1180,
          background: `linear-gradient(90deg, transparent, ${accent}13, transparent)`,
          filter: 'blur(26px)',
          transform: 'rotate(18deg)',
        }}
      />
      <div
        style={{
          position: 'relative',
          display: 'grid',
          gridTemplateRows: '54px 1fr',
          width: '100%',
          height: '100%',
          background: 'rgba(7,8,11,0.45)',
        }}
      >
        <header
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr auto 1fr',
            alignItems: 'center',
            borderBottom: `1px solid ${UI_LINE}`,
            background: 'rgba(255,255,255,0.025)',
            padding: '0 20px',
          }}
        >
          <ChromeDots />
          <span style={{ color: brand.inkSoft, fontSize: 13, fontWeight: 750 }}>{title}</span>
          <span
            style={{
              justifySelf: 'end',
              border: `1px solid ${accent}55`,
              borderRadius: 999,
              background: `${accent}17`,
              color: brand.ink,
              padding: '6px 11px',
              fontSize: 10,
              fontWeight: 850,
              letterSpacing: '0.09em',
              textTransform: 'uppercase',
            }}
          >
            {status}
          </span>
        </header>
        <div style={{ position: 'relative', minHeight: 0 }}>{children}</div>
      </div>
    </div>
  );
};

const TourSidebar: React.FC<{
  accent: string;
  title: string;
  items: SidebarItem[];
  footer?: string;
  width?: number;
}> = ({ accent, title, items, footer = 'Ambiente de demonstração', width = 210 }) => (
  <aside
    style={{
      width,
      height: '100%',
      borderRight: `1px solid ${UI_LINE}`,
      background: 'rgba(7,9,13,0.72)',
      padding: '22px 16px',
      boxSizing: 'border-box',
    }}
  >
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 7px 20px' }}>
      <span style={{ display: 'grid', width: 34, height: 34, placeItems: 'center', borderRadius: 11, background: `${accent}20`, color: accent }}><GraduationCap size={18} /></span>
      <div>
        <b style={{ display: 'block', fontFamily: displayFontFamily, fontSize: 14 }}>{title}</b>
        <small style={{ color: brand.muted, fontSize: 9 }}>dados fictícios</small>
      </div>
    </div>
    <div style={{ display: 'grid', gap: 7 }}>
      {items.map(({ label, icon: Icon, active }) => (
        <div
          key={label}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            minHeight: 40,
            border: `1px solid ${active ? `${accent}42` : 'transparent'}`,
            borderRadius: 12,
            background: active ? `${accent}18` : 'transparent',
            color: active ? brand.ink : brand.muted,
            padding: '0 11px',
            fontSize: 11,
            fontWeight: active ? 800 : 650,
          }}
        >
          <Icon size={15} color={active ? accent : undefined} /> {label}
        </div>
      ))}
    </div>
    <div style={{ position: 'absolute', left: 18, bottom: 16, display: 'flex', alignItems: 'center', gap: 7, color: brand.muted, fontSize: 8, fontWeight: 700 }}>
      <ShieldCheck size={12} color={accent} /> {footer}
    </div>
  </aside>
);

const TourCursor: React.FC<{
  steps: CursorStep[];
  accent: string;
  frameOffset?: number;
  label?: string;
}> = ({ steps, accent, frameOffset = 0, label }) => {
  const frame = useCurrentFrame() - frameOffset;
  const inputRange = steps.map((step) => step.at);
  const x = interpolate(frame, inputRange, steps.map((step) => step.x), {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.cubic),
  });
  const y = interpolate(frame, inputRange, steps.map((step) => step.y), {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.cubic),
  });
  let nearestClick: number | null = null;
  for (const step of steps) {
    if (!step.click) continue;
    if (nearestClick === null || Math.abs(frame - step.at) < Math.abs(frame - nearestClick)) nearestClick = step.at;
  }
  const clickDistance = nearestClick === null ? 100 : Math.abs(frame - nearestClick);
  const click = 1 - clampProgress(clickDistance, 0, 10);
  const cursorReveal = clampProgress(frame, inputRange[0] - 6, inputRange[0] + 3);

  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        zIndex: 80,
        opacity: cursorReveal,
        transform: `translate(-7px, -4px) scale(${1 - click * 0.14})`,
        filter: 'drop-shadow(0 5px 10px rgba(0,0,0,0.6))',
        pointerEvents: 'none',
      }}
    >
      <span
        style={{
          position: 'absolute',
          left: -13,
          top: -13,
          width: 34 + click * 24,
          height: 34 + click * 24,
          border: `2px solid ${accent}`,
          borderRadius: '50%',
          opacity: click,
          transform: 'translate(-50%, -50%)',
          boxShadow: `0 0 24px ${accent}`,
        }}
      />
      <MousePointer2 size={31} fill="#fff" color="#11151d" strokeWidth={2.5} />
      {label && (
        <span style={{ position: 'absolute', left: 25, top: 24, width: 'max-content', borderRadius: 999, background: '#fff', color: '#11151d', padding: '5px 9px', fontSize: 8, fontWeight: 900 }}>{label}</span>
      )}
    </div>
  );
};

const MiniMetric: React.FC<{
  label: string;
  value: string;
  icon: LucideIcon;
  color: string;
  progress?: number;
}> = ({ label, value, icon: Icon, color, progress = 1 }) => (
  <div style={{ ...panelStyle(), padding: '14px 15px', ...revealStyle(progress, 15) }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <small style={{ color: brand.muted, fontSize: 8, fontWeight: 850, letterSpacing: '0.1em', textTransform: 'uppercase' }}>{label}</small>
      <span style={{ display: 'grid', width: 29, height: 29, placeItems: 'center', borderRadius: 9, background: `${color}1d`, color }}><Icon size={14} /></span>
    </div>
    <b style={{ display: 'block', marginTop: 8, fontFamily: displayFontFamily, fontSize: 23, letterSpacing: '-0.04em' }}>{value}</b>
  </div>
);

const MaterialThumbnail: React.FC<{ accent: string; index?: number }> = ({ accent, index = 0 }) => (
  <div
    style={{
      position: 'relative',
      height: '100%',
      overflow: 'hidden',
      borderRadius: 13,
      background: `linear-gradient(145deg, ${accent}25, rgba(255,255,255,0.03))`,
      padding: 13,
      boxSizing: 'border-box',
    }}
  >
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <span style={{ width: 48, height: 6, borderRadius: 999, background: accent }} />
      <span style={{ color: brand.muted, fontSize: 7 }}>0{index + 1}</span>
    </div>
    <div style={{ width: index % 2 === 0 ? '78%' : '62%', height: 9, marginTop: 18, borderRadius: 999, background: 'rgba(255,255,255,0.8)' }} />
    <div style={{ width: '92%', height: 5, marginTop: 10, borderRadius: 999, background: 'rgba(255,255,255,0.2)' }} />
    <div style={{ width: '74%', height: 5, marginTop: 6, borderRadius: 999, background: 'rgba(255,255,255,0.14)' }} />
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7, marginTop: 17 }}>
      {[0, 1, 2, 3].map((cell) => <span key={cell} style={{ height: 19 + ((cell + index) % 2) * 11, borderRadius: 5, background: cell === 0 ? `${accent}3d` : 'rgba(255,255,255,0.07)' }} />)}
    </div>
  </div>
);

const LibraryTour: React.FC<ProductTourProps> = ({ content, mode }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const query = 'apresentação de resultados';
  const typedCharacters = Math.floor(interpolate(frame, [18, 67], [0, query.length], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  }));
  const filtered = spring({ frame: frame - 76, fps, config: { damping: 18, stiffness: 120 } });
  const preview = spring({ frame: frame - 118, fps, config: { damping: 18, stiffness: 105, mass: 0.9 } });
  const materialOpen = spring({ frame: frame - 196, fps, config: { damping: 18, stiffness: 110 } });
  const documentOpen = spring({ frame: frame - 219, fps, config: { damping: 18, stiffness: 108, mass: 0.9 } });
  const scroll = interpolate(frame, [158, 226], [0, -108], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.cubic) });
  const cursorSteps: CursorStep[] = [
    { at: 0, x: 370, y: 126 },
    { at: 13, x: 520, y: 113, click: true },
    { at: 72, x: 1060, y: 112, click: true },
    { at: 112, x: 480, y: 335, click: true },
    { at: 164, x: 1212, y: 518 },
    { at: 194, x: 1332, y: 624, click: true },
    { at: 246, x: 1370, y: 92 },
  ];
  const cards = [
    { level: 'B1', title: 'Presenting monthly results', kind: 'Plano de aula · 60 min', accent: content.accent },
    { level: 'B1', title: 'Handling pushback', kind: 'Role-play · 20 min', accent: '#7652ed' },
    { level: 'B2', title: 'Quarterly review toolkit', kind: 'Slides · 45 min', accent: '#20a9cc' },
  ];

  return (
    <TourShell accent={content.accent} title="Wise Wolf Library" status={mode === 'proof' ? 'acesso por permissão' : 'catálogo protegido'} backdrop="assets/hub/videos/backdrops/educator-studio-v1.png">
      <div style={{ display: 'flex', height: '100%' }}>
        <TourSidebar
          accent={content.accent}
          title="Biblioteca"
          items={[
            { label: 'Materiais', icon: Library, active: true },
            { label: 'Coleções', icon: Folder },
            { label: 'Favoritos', icon: FileCheck2 },
            { label: 'Histórico', icon: Clock3 },
          ]}
        />
        <main style={{ position: 'relative', flex: 1, padding: '22px 26px 20px', minWidth: 0, boxSizing: 'border-box' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 45, border: `1px solid ${frame > 12 && frame < 72 ? `${content.accent}88` : UI_LINE}`, borderRadius: 13, background: 'rgba(255,255,255,0.035)', padding: '0 14px', boxShadow: frame > 12 && frame < 72 ? `0 0 26px ${content.accent}20` : undefined }}>
              <Search size={16} color={content.accent} />
              <span style={{ minWidth: 240, color: typedCharacters ? brand.ink : brand.muted, fontSize: 12, fontWeight: 650 }}>{query.slice(0, typedCharacters) || 'Buscar material pelo título...'}</span>
              {frame > 12 && frame < 74 && <span style={{ width: 2, height: 18, marginLeft: -6, background: content.accent, opacity: frame % 16 < 9 ? 1 : 0 }} />}
            </div>
            {['B1', 'Business'].map((filter, index) => (
              <div key={filter} style={{ display: 'flex', alignItems: 'center', gap: 7, height: 45, border: `1px solid ${frame >= 75 && index === 1 ? `${content.accent}77` : UI_LINE}`, borderRadius: 13, background: frame >= 75 && index === 1 ? `${content.accent}1a` : 'rgba(255,255,255,0.03)', padding: '0 14px', color: brand.inkSoft, fontSize: 10, fontWeight: 800 }}>
                {filter} <ChevronDown size={12} />
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 7, marginTop: 13 }}>
            {['Todos os tipos', 'Plano de aula', 'Role-play', 'Slides'].map((type, index) => (
              <span key={type} style={{ border: `1px solid ${index === 1 ? `${content.accent}55` : UI_LINE}`, borderRadius: 9, background: index === 1 ? `${content.accent}18` : 'rgba(255,255,255,0.025)', color: index === 1 ? brand.ink : brand.muted, padding: '6px 10px', fontSize: 8, fontWeight: 850, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{type}</span>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 18 }}>
            <div><b style={{ display: 'block', fontFamily: displayFontFamily, fontSize: 19 }}>Business English</b><small style={{ color: brand.muted, fontSize: 9 }}>3 materiais encontrados · conteúdo demonstrativo</small></div>
            <div style={{ display: 'flex', gap: 6 }}>
              {['Pastas', 'Nível', 'Nicho'].map((group, index) => <span key={group} style={{ borderRadius: 8, background: index === 1 ? `${content.accent}22` : 'rgba(255,255,255,0.025)', color: index === 1 ? brand.ink : brand.muted, padding: '6px 9px', fontSize: 8, fontWeight: 800 }}>{group}</span>)}
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginTop: 15, opacity: 0.35 + filtered * 0.65, transform: `translateY(${(1 - filtered) * 16}px)` }}>
            {cards.map((card, index) => {
              const selected = index === 0 && frame >= 110;
              const cardReveal = spring({ frame: frame - 68 - index * 7, fps, config: { damping: 19, stiffness: 110 } });
              return (
                <article key={card.title} style={{ ...panelStyle(selected ? card.accent : undefined), height: 331, overflow: 'hidden', padding: 13, boxSizing: 'border-box', boxShadow: selected ? `0 22px 58px rgba(0,0,0,0.42), 0 0 32px ${card.accent}1d` : undefined, ...revealStyle(cardReveal, 18) }}>
                  <div style={{ height: 174 }}><MaterialThumbnail accent={card.accent} index={index} /></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 13 }}>
                    <span style={{ borderRadius: 999, background: `${card.accent}1e`, color: card.accent, padding: '5px 8px', fontSize: 8, fontWeight: 900 }}>{card.level}</span>
                    <FileText size={14} color={brand.muted} />
                  </div>
                  <h3 style={{ margin: '10px 0 0', minHeight: 37, color: brand.ink, fontFamily: displayFontFamily, fontSize: 16, lineHeight: 1.08 }}>{card.title}</h3>
                  <p style={{ margin: '7px 0 0', color: brand.muted, fontSize: 8 }}>{card.kind}</p>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, color: card.accent, fontSize: 9, fontWeight: 850 }}>Ver prévia <ArrowRight size={12} /></div>
                </article>
              );
            })}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 13, color: brand.muted, fontSize: 9, fontWeight: 650 }}><ShieldCheck size={14} color={content.accent} /> A prévia respeita conta, plano e permissão antes de liberar o material completo.</div>
          {frame >= 102 && <>
            <div
              style={{
                position: 'absolute',
                inset: 0,
                zIndex: 20,
                background: `rgba(4,5,8,${preview * 0.54})`,
                opacity: preview,
                pointerEvents: 'none',
              }}
            />
            <section
              style={{
                position: 'absolute',
                zIndex: 30,
                right: 0,
                top: 0,
                bottom: 0,
                width: 606,
                borderLeft: `1px solid ${content.accent}50`,
                background: 'rgba(13,15,21,0.985)',
                boxShadow: '-34px 0 90px rgba(0,0,0,0.48)',
                opacity: preview,
                transform: `translateX(${(1 - preview) * 640}px)`,
              }}
            >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 66, borderBottom: `1px solid ${UI_LINE}`, padding: '0 20px' }}>
              <div><small style={{ display: 'block', color: content.accent, fontSize: 8, fontWeight: 900, letterSpacing: '0.12em' }}>PRÉVIA SEGURA</small><b style={{ display: 'block', marginTop: 5, fontFamily: displayFontFamily, fontSize: 17 }}>Presenting monthly results</b></div>
              <span style={{ display: 'grid', width: 29, height: 29, placeItems: 'center', borderRadius: 9, background: 'rgba(255,255,255,0.05)', color: brand.muted }}><X size={15} /></span>
            </div>
            <div style={{ position: 'relative', height: 545, overflow: 'hidden', padding: '18px 18px 78px', boxSizing: 'border-box' }}>
              <div style={{ transform: `translateY(${scroll}px)` }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 11 }}>
                  {[0, 1, 2, 3].map((index) => (
                    <div key={index} style={{ height: 196, border: `1px solid ${index === 0 ? `${content.accent}66` : UI_LINE}`, borderRadius: 15, background: '#151821', padding: 8 }}><MaterialThumbnail accent={index === 0 ? content.accent : '#7652ed'} index={index} /></div>
                  ))}
                </div>
                <div style={{ ...panelStyle(content.accent), marginTop: 14, padding: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}><Target size={15} color={content.accent} /><b style={{ fontSize: 11 }}>Objetivo da aula</b></div>
                  <p style={{ margin: '8px 0 0', color: brand.inkSoft, fontSize: 9, lineHeight: 1.5 }}>Apresentar resultados mensais, explicar variações e propor próximos passos em inglês.</p>
                </div>
                {mode === 'proof' && (
                  <div style={{ ...panelStyle('#4fd1a5'), marginTop: 12, padding: 14 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#80e6c0', fontSize: 10, fontWeight: 850 }}><LockKeyhole size={14} /> Regra de acesso verificada</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
                      {['Conta ativa', 'Plano autorizado', 'Papel: professor', 'URL temporária'].map((item) => <span key={item} style={{ borderRadius: 9, background: 'rgba(79,209,165,0.08)', color: brand.inkSoft, padding: '8px 9px', fontSize: 8, fontWeight: 750 }}><Check size={10} color="#4fd1a5" /> {item}</span>)}
                    </div>
                  </div>
                )}
              </div>
              <div style={{ position: 'absolute', left: 18, right: 18, bottom: 15, display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, opacity: materialOpen, transform: `translateY(${(1 - materialOpen) * 22}px)` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, border: `1px solid ${UI_LINE}`, borderRadius: 13, background: 'rgba(7,9,13,0.96)', color: brand.inkSoft, padding: '0 13px', fontSize: 9 }}><ShieldCheck size={14} color={content.accent} /> Acesso confirmado para esta conta</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderRadius: 13, background: `linear-gradient(135deg, ${content.accent}, ${content.secondaryAccent})`, color: '#fff', padding: '13px 17px', fontSize: 10, fontWeight: 900, boxShadow: `0 16px 36px ${content.accent}32` }}><BookOpen size={14} /> Abrir material</div>
              </div>
            </div>
            </section>
          </>}
          {frame >= 205 && <section
            style={{
              position: 'absolute',
              zIndex: 42,
              inset: 0,
              display: 'grid',
              gridTemplateRows: '58px 1fr',
              overflow: 'hidden',
              borderLeft: `1px solid ${content.accent}52`,
              background: 'rgba(11,13,18,0.992)',
              opacity: documentOpen,
              transform: `translateY(${(1 - documentOpen) * 42}px) scale(${0.975 + documentOpen * 0.025})`,
              transformOrigin: '76% 88%',
            }}
          >
            <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: `1px solid ${UI_LINE}`, padding: '0 18px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><span style={{ display: 'grid', width: 32, height: 32, placeItems: 'center', borderRadius: 10, background: `${content.accent}1d`, color: content.accent }}><BookOpen size={16} /></span><div><b style={{ display: 'block', fontFamily: displayFontFamily, fontSize: 13 }}>Presenting monthly results</b><small style={{ color: brand.muted, fontSize: 8 }}>material demonstrativo · página 1 de 4</small></div></div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}><span style={{ display: 'flex', alignItems: 'center', gap: 6, border: `1px solid #4fd1a54f`, borderRadius: 999, background: 'rgba(79,209,165,0.08)', color: '#80e6c0', padding: '7px 10px', fontSize: 8, fontWeight: 850 }}><ShieldCheck size={11} /> acesso temporário</span><span style={{ display: 'grid', width: 29, height: 29, placeItems: 'center', borderRadius: 9, background: 'rgba(255,255,255,0.05)', color: brand.muted }}><X size={15} /></span></div>
            </header>
            <div style={{ display: 'grid', gridTemplateColumns: '154px 1fr', minHeight: 0 }}>
              <aside style={{ borderRight: `1px solid ${UI_LINE}`, background: 'rgba(7,9,13,0.72)', padding: 14 }}>
                <small style={{ color: brand.muted, fontSize: 7, fontWeight: 900, letterSpacing: '0.12em' }}>PÁGINAS</small>
                {[0, 1, 2, 3].map((index) => <div key={index} style={{ height: 101, marginTop: 10, border: `1px solid ${index === 0 ? `${content.accent}77` : UI_LINE}`, borderRadius: 11, background: '#151821', padding: 6, boxShadow: index === 0 ? `0 0 20px ${content.accent}18` : undefined }}><MaterialThumbnail accent={index === 0 ? content.accent : '#7652ed'} index={index} /></div>)}
              </aside>
              <div style={{ display: 'grid', placeItems: 'center', minWidth: 0, background: 'radial-gradient(circle at 50% 40%, rgba(255,255,255,0.055), transparent 58%)', padding: '20px 34px' }}>
                <article style={{ width: 690, height: 500, overflow: 'hidden', border: `1px solid ${content.accent}55`, borderRadius: 20, background: `linear-gradient(145deg, ${content.accent}1e, #171922 48%, #101219)`, boxShadow: '0 30px 90px rgba(0,0,0,0.48)', padding: '32px 36px', boxSizing: 'border-box', transform: `translateY(${Math.sin(frame / 24) * 2}px)` }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}><span style={{ color: content.accent, fontSize: 9, fontWeight: 900, letterSpacing: '0.14em' }}>BUSINESS ENGLISH · B1</span><span style={{ color: brand.muted, fontSize: 8 }}>01</span></div>
                  <h3 style={{ maxWidth: 510, margin: '28px 0 0', fontFamily: displayFontFamily, fontSize: 36, lineHeight: 1.02, letterSpacing: '-0.045em' }}>Presenting monthly results with clarity</h3>
                  <p style={{ maxWidth: 520, margin: '15px 0 0', color: brand.inkSoft, fontSize: 12, lineHeight: 1.55 }}>Organize contexto, variação e próximo passo antes de apresentar números em inglês.</p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1.18fr 0.82fr', gap: 14, marginTop: 28 }}>
                    <div style={{ ...panelStyle(content.accent), padding: 17 }}><small style={{ color: content.accent, fontSize: 8, fontWeight: 900 }}>ESTRUTURA DA FALA</small>{['Contexto', 'Variação', 'Impacto', 'Próximo passo'].map((label, index) => <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 12, color: brand.inkSoft, fontSize: 10 }}><span style={{ display: 'grid', width: 22, height: 22, placeItems: 'center', borderRadius: 7, background: `${content.accent}1e`, color: content.accent, fontSize: 8, fontWeight: 900 }}>{index + 1}</span>{label}</div>)}</div>
                    <div style={{ ...panelStyle(), padding: 17 }}><small style={{ color: brand.muted, fontSize: 8, fontWeight: 900 }}>FRASE-CHAVE</small><p style={{ margin: '15px 0 0', color: brand.ink, fontFamily: displayFontFamily, fontSize: 18, lineHeight: 1.35 }}>“The main change this month was…”</p><span style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 26, color: '#80e6c0', fontSize: 9, fontWeight: 850 }}><Check size={12} /> pronta para praticar</span></div>
                  </div>
                </article>
              </div>
            </div>
          </section>}
        </main>
      </div>
      <TourCursor steps={cursorSteps} accent={content.accent} label={mode === 'proof' ? 'visão do professor' : undefined} />
    </TourShell>
  );
};

const PlannerField: React.FC<{
  label: string;
  value: string;
  accent: string;
  active?: boolean;
  wide?: boolean;
}> = ({ label, value, accent, active = false, wide = false }) => (
  <div
    style={{
      minHeight: wide ? 92 : 57,
      border: `1px solid ${active ? `${accent}8a` : UI_LINE}`,
      borderRadius: 14,
      background: active ? `${accent}0f` : 'rgba(255,255,255,0.025)',
      boxShadow: active ? `0 0 28px ${accent}18` : undefined,
      padding: '11px 13px',
      boxSizing: 'border-box',
    }}
  >
    <small style={{ display: 'block', color: active ? accent : brand.muted, fontSize: 7, fontWeight: 900, letterSpacing: '0.12em', textTransform: 'uppercase' }}>{label}</small>
    <span style={{ display: 'block', marginTop: 7, color: value ? brand.ink : brand.muted, fontSize: wide ? 11 : 12, fontWeight: 700, lineHeight: 1.35 }}>{value}</span>
  </div>
);

const PlanStep: React.FC<{
  number: string;
  title: string;
  time: string;
  teacher: string;
  student: string;
  accent: string;
  progress: number;
}> = ({ number, title, time, teacher, student, accent, progress }) => (
  <article style={{ ...panelStyle(), padding: '13px 14px', ...revealStyle(progress, 22) }}>
    <div style={{ display: 'grid', gridTemplateColumns: '38px 1fr auto', alignItems: 'center', gap: 10 }}>
      <span style={{ display: 'grid', width: 36, height: 36, placeItems: 'center', borderRadius: 11, background: `${accent}1d`, color: accent, fontFamily: displayFontFamily, fontSize: 12, fontWeight: 900 }}>{number}</span>
      <b style={{ fontFamily: displayFontFamily, fontSize: 14 }}>{title}</b>
      <span style={{ borderRadius: 999, background: `${accent}18`, color: brand.inkSoft, padding: '5px 8px', fontSize: 8, fontWeight: 850 }}>{time}</span>
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 11, paddingLeft: 48 }}>
      <div><small style={{ color: brand.muted, fontSize: 7, fontWeight: 900, letterSpacing: '0.1em' }}>PROFESSOR</small><p style={{ margin: '4px 0 0', color: brand.inkSoft, fontSize: 8, lineHeight: 1.4 }}>{teacher}</p></div>
      <div><small style={{ color: brand.muted, fontSize: 7, fontWeight: 900, letterSpacing: '0.1em' }}>ALUNO</small><p style={{ margin: '4px 0 0', color: brand.inkSoft, fontSize: 8, lineHeight: 1.4 }}>{student}</p></div>
    </div>
  </article>
);

const EducatorTour: React.FC<ProductTourProps> = ({ content, mode }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const timelineFrame = frame + (mode === 'proof' ? 72 : 0);
  const outcome = 'Apresentar resultados e explicar um atraso com clareza.';
  const typedCharacters = Math.floor(interpolate(timelineFrame, [18, 76], [0, outcome.length], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  }));
  const generating = clampProgress(timelineFrame, 98, 112) * (1 - clampProgress(timelineFrame, 128, 142));
  const result = spring({ frame: timelineFrame - 132, fps, config: { damping: 18, stiffness: 105, mass: 0.92 } });
  const saved = spring({ frame: timelineFrame - 250, fps, config: { damping: 16, stiffness: 130 } });
  const resultScroll = mode === 'proof'
    ? interpolate(frame, [78, 190], [0, -520], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.cubic) })
    : interpolate(timelineFrame, [190, 264], [0, -132], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.cubic) });
  const proofReview = spring({ frame: frame - 126, fps, config: { damping: 17, stiffness: 116, mass: 0.9 } });
  const cursorSteps: CursorStep[] = mode === 'proof'
    ? [
      { at: 0, x: 412, y: 520 },
      { at: 22, x: 443, y: 588, click: true },
      { at: 70, x: 1064, y: 330 },
      { at: 126, x: 1210, y: 542 },
      { at: 178, x: 1440, y: 114, click: true },
      { at: 206, x: 1420, y: 618 },
    ]
    : [
      { at: 0, x: 390, y: 206 },
      { at: 13, x: 420, y: 222, click: true },
      { at: 67, x: 378, y: 364, click: true },
      { at: 87, x: 412, y: 520 },
      { at: 98, x: 443, y: 588, click: true },
      { at: 160, x: 1064, y: 330 },
      { at: 226, x: 1220, y: 565 },
      { at: 248, x: 1440, y: 114, click: true },
      { at: 278, x: 1420, y: 618 },
    ];
  const steps = [
    { number: '01', title: 'Aquecimento contextual', time: '10 min', teacher: 'Ative contexto e vocabulário útil.', student: 'Conecte a situação à própria rotina.' },
    { number: '02', title: 'Experiência central', time: '25 min', teacher: 'Modele contexto, impacto e proposta.', student: 'Apresente dados e explique a variação.' },
    { number: '03', title: 'Prática guiada', time: '20 min', teacher: 'Observe clareza e faça microcorreções.', student: 'Simule a atualização em pares.' },
    { number: '04', title: 'Continuidade', time: '5 min', teacher: 'Registre o próximo foco.', student: 'Grave uma nova versão no Wolfie.' },
  ];

  return (
    <TourShell accent={content.accent} title="Educador IA · novo planejamento" status={mode === 'proof' ? 'professor decide' : 'contexto pedagógico'} backdrop="assets/hub/videos/backdrops/educator-studio-v1.png">
      <div style={{ display: 'flex', height: '100%' }}>
        <TourSidebar
          accent={content.accent}
          title="Educador IA"
          width={190}
          items={[
            { label: 'Planejar aula', icon: WandSparkles, active: true },
            { label: 'Histórico', icon: Clock3 },
            { label: 'Memória do aluno', icon: Bot },
            { label: 'Materiais', icon: BookOpen },
          ]}
        />
        <main style={{ display: 'grid', gridTemplateColumns: '430px 1fr', flex: 1, minWidth: 0 }}>
          <section style={{ borderRight: `1px solid ${UI_LINE}`, padding: '22px 24px', boxSizing: 'border-box' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div><small style={{ color: content.accent, fontSize: 8, fontWeight: 900, letterSpacing: '0.12em' }}>CONTEXTO PEDAGÓGICO</small><h3 style={{ margin: '6px 0 0', fontFamily: displayFontFamily, fontSize: 21 }}>O resultado vem primeiro</h3></div>
              <span style={{ display: 'grid', width: 34, height: 34, placeItems: 'center', borderRadius: 11, background: `${content.accent}1c`, color: content.accent }}><Sparkles size={17} /></span>
            </div>
            <div style={{ display: 'grid', gap: 10, marginTop: 17 }}>
              <PlannerField label="Aluno" value="Aluno Demo 01" accent={content.accent} />
              <div style={{ position: 'relative' }}>
                <PlannerField label="Resultado esperado" value={outcome.slice(0, typedCharacters)} accent={content.accent} active={timelineFrame >= 12 && timelineFrame < 78} wide />
                {timelineFrame >= 12 && timelineFrame < 78 && <span style={{ position: 'absolute', left: 15 + Math.min(typedCharacters, 38) * 5.35, bottom: 17, width: 2, height: 14, background: content.accent, opacity: timelineFrame % 16 < 9 ? 1 : 0 }} />}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <PlannerField label="Nível" value={timelineFrame >= 64 ? 'B1 · Intermediário' : 'Selecionar'} accent={content.accent} active={timelineFrame >= 62 && timelineFrame < 82} />
                <PlannerField label="Duração" value={timelineFrame >= 78 ? '60 minutos' : 'Selecionar'} accent={content.accent} active={timelineFrame >= 78 && timelineFrame < 94} />
              </div>
              <PlannerField label="Modo" value="Planejamento de aula" accent={content.accent} />
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 9,
                height: 50,
                marginTop: 15,
                borderRadius: 14,
                background: `linear-gradient(135deg, ${content.accent}, ${content.secondaryAccent})`,
                boxShadow: `0 18px 46px ${content.accent}32`,
                color: '#fff',
                fontSize: 10,
                fontWeight: 900,
                letterSpacing: '0.04em',
                transform: `scale(${timelineFrame >= 96 && timelineFrame < 108 ? 0.97 : 1})`,
              }}
            >
              {generating > 0 ? <RefreshCw size={15} style={{ transform: `rotate(${timelineFrame * 11}deg)` }} /> : <WandSparkles size={15} />}
              {generating > 0 ? 'ESTRUTURANDO CONTEXTO...' : 'GERAR PLANEJAMENTO'}
            </div>
          </section>
          <section style={{ position: 'relative', minWidth: 0, overflow: 'hidden', padding: '21px 24px 18px', boxSizing: 'border-box' }}>
            <div style={{ position: 'absolute', inset: 24, display: 'grid', gap: 12, opacity: 1 - result }}>
              {[110, 86, 132, 108].map((width, index) => (
                <div key={width} style={{ height: index === 0 ? 58 : 118, borderRadius: 18, background: 'linear-gradient(100deg, rgba(255,255,255,0.025), rgba(255,255,255,0.075), rgba(255,255,255,0.025))', backgroundSize: '220% 100%', backgroundPositionX: `${-120 + timelineFrame * 8}px`, opacity: index === 0 ? 0.7 : 0.45, width: `${width}%`, maxWidth: '100%' }} />
              ))}
              <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', opacity: generating }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, border: `1px solid ${content.accent}44`, borderRadius: 999, background: `${content.accent}10`, color: brand.inkSoft, padding: '11px 16px', fontSize: 9, fontWeight: 800 }}><Sparkles size={14} color={content.accent} /> Cruzando objetivo, nível e duração</div>
              </div>
            </div>
            <div style={{ height: '100%', opacity: result, transform: `translateX(${(1 - result) * 78}px)` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                <div><small style={{ color: content.accent, fontSize: 8, fontWeight: 900, letterSpacing: '0.12em' }}>PLANO ESTRUTURADO</small><h3 style={{ margin: '6px 0 0', fontFamily: displayFontFamily, fontSize: 23, letterSpacing: '-0.035em' }}>From update to next step</h3><p style={{ margin: '5px 0 0', color: brand.muted, fontSize: 9 }}>B1 · 60 min · versão inicial para revisão</p></div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, border: `1px solid ${UI_LINE}`, borderRadius: 11, color: saved ? '#80e6c0' : brand.inkSoft, padding: '9px 11px', fontSize: 8, fontWeight: 850 }}><Check size={12} /> {saved ? 'Plano salvo' : 'Salvar plano'}</span>
                </div>
              </div>
              <div style={{ height: 531, marginTop: 15, overflow: 'hidden' }}>
                <div style={{ display: 'grid', gap: 10, transform: `translateY(${resultScroll}px)` }}>
                  <div style={{ ...panelStyle(content.accent), padding: '14px 16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}><Target size={15} color={content.accent} /><b style={{ fontSize: 11 }}>Objetivo</b></div>
                    <p style={{ margin: '7px 0 0', color: brand.inkSoft, fontSize: 9, lineHeight: 1.45 }}>Ao final, a aluna apresenta resultados, explica uma variação e propõe o próximo passo com clareza.</p>
                  </div>
                  {steps.map((step, index) => (
                    <PlanStep key={step.number} {...step} accent={content.accent} progress={spring({ frame: timelineFrame - 143 - index * 8, fps, config: { damping: 19, stiffness: 112 } })} />
                  ))}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <div style={{ ...panelStyle('#20a9cc'), padding: 13 }}><small style={{ color: '#67d6ef', fontSize: 7, fontWeight: 900 }}>VOCABULÁRIO E CHUNKS</small><p style={{ margin: '8px 0 0', color: brand.inkSoft, fontSize: 9 }}>on track · due to · moving forward</p></div>
                    <div style={{ ...panelStyle('#258e79'), padding: 13 }}><small style={{ color: '#70d8bc', fontSize: 7, fontWeight: 900 }}>CONTINUIDADE</small><p style={{ margin: '8px 0 0', color: brand.inkSoft, fontSize: 9 }}>Prática contextual sugerida no Wolfie.</p></div>
                  </div>
                  {mode === 'proof' && (
                    <div style={{ ...panelStyle('#ffad70'), padding: 14, boxShadow: `0 0 ${24 + Math.sin(frame / 7) * 5}px rgba(255,173,112,0.2)`, ...revealStyle(proofReview, 28) }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 9 }}><span style={{ display: 'flex', alignItems: 'center', gap: 9, color: '#ffbd85', fontSize: 10, fontWeight: 900 }}><ShieldCheck size={14} /> Revisão humana antes da memória</span><small style={{ borderRadius: 999, background: 'rgba(255,173,112,0.14)', color: '#ffbd85', padding: '5px 7px', fontSize: 6, fontWeight: 900 }}>DECISÃO DO PROFESSOR</small></div>
                      <p style={{ margin: '7px 0 0', color: brand.inkSoft, fontSize: 9, lineHeight: 1.45 }}>A IA estrutura a primeira versão. O professor adapta e somente o plano salvo atualiza a continuidade do aluno.</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </section>
        </main>
      </div>
      <TourCursor steps={cursorSteps} accent={content.accent} label={mode === 'proof' ? 'revisão humana' : undefined} />
    </TourShell>
  );
};

const Waveform: React.FC<{ accent: string; frame: number; active?: boolean; bars?: number }> = ({ accent, frame, active = true, bars = 26 }) => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, height: 54 }}>
    {Array.from({ length: bars }).map((_, index) => {
      const signal = active
        ? 13 + Math.abs(Math.sin(frame / 4.2 + index * 0.78) * Math.cos(frame / 8.6 + index * 0.31)) * 34
        : 8 + (index % 4) * 2;
      return <span key={index} style={{ width: 3, height: signal, borderRadius: 999, background: index % 5 === 0 ? '#fff' : accent, opacity: 0.45 + (index % 3) * 0.2, boxShadow: active ? `0 0 10px ${accent}55` : undefined }} />;
    })}
  </div>
);

const ScenarioCard: React.FC<{
  title: string;
  subtitle: string;
  icon: LucideIcon;
  accent: string;
  selected: boolean;
  progress: number;
  imageSrc: string;
  imagePosition: string;
}> = ({ title, subtitle, icon: Icon, accent, selected, progress, imageSrc, imagePosition }) => (
  <article
    style={{
      position: 'relative',
      height: 208,
      overflow: 'hidden',
      border: `1px solid ${selected ? `${accent}88` : UI_LINE}`,
      borderRadius: 20,
      background: '#10141b',
      boxShadow: selected ? `0 22px 58px rgba(0,0,0,0.44), 0 0 36px ${accent}27` : '0 18px 42px rgba(0,0,0,0.28)',
      ...revealStyle(progress, 30),
    }}
  >
    <Img src={staticFile(imageSrc)} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: imagePosition, filter: selected ? 'saturate(1.08)' : 'saturate(0.56)', transform: selected ? 'scale(1.06)' : 'scale(1.02)' }} />
    <div style={{ position: 'absolute', inset: 0, background: `linear-gradient(180deg, ${accent}09, rgba(4,8,15,0.18) 35%, rgba(4,8,15,0.95))` }} />
    <span style={{ position: 'absolute', left: 15, top: 14, display: 'grid', width: 34, height: 34, placeItems: 'center', borderRadius: 11, background: 'rgba(4,8,15,0.74)', color: selected ? accent : brand.inkSoft }}><Icon size={17} /></span>
    {selected && <span style={{ position: 'absolute', right: 13, top: 13, display: 'flex', alignItems: 'center', gap: 5, borderRadius: 999, background: `${accent}d9`, color: '#fff', padding: '6px 8px', fontSize: 7, fontWeight: 900 }}><Check size={9} /> ESCOLHIDO</span>}
    <div style={{ position: 'absolute', left: 16, right: 16, bottom: 14 }}><b style={{ display: 'block', fontFamily: displayFontFamily, fontSize: 16 }}>{title}</b><small style={{ display: 'block', marginTop: 4, color: brand.inkSoft, fontSize: 8 }}>{subtitle}</small></div>
  </article>
);

const WolfieTour: React.FC<ProductTourProps> = ({ content, mode }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const selectionOut = 1 - clampProgress(frame, 72, 92);
  const practiceIn = clampProgress(frame, 76, 96);
  const feedback = spring({ frame: frame - 176, fps, config: { damping: 18, stiffness: 105, mass: 0.92 } });
  const listening = frame < 154 || frame > 236;
  const phrase = 'I would highlight the project that reduced our response time.';
  const visiblePhrase = Math.floor(interpolate(frame, [112, 166], [0, phrase.length], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));
  const characterFloat = Math.sin(frame / 18) * 4;
  const cursorSteps: CursorStep[] = [
    { at: 0, x: 250, y: 160 },
    { at: 52, x: 390, y: 290, click: true },
    { at: 98, x: 790, y: 576 },
    { at: 109, x: 807, y: 586, click: true },
    { at: 166, x: 1180, y: 452 },
    { at: 204, x: 1338, y: 584, click: true },
    { at: 236, x: 850, y: 590 },
  ];
  const scenarios = [
    { title: 'Entrevista de emprego', subtitle: 'Conte sua experiência com confiança', icon: BriefcaseBusiness, imageSrc: 'assets/wolfie/scenes/career/job-interviews/desktop.dc0f18a9a9dc.webp', position: '30% center' },
    { title: 'Reunião global', subtitle: 'Atualize o time e proponha decisões', icon: Users, imageSrc: 'assets/wolfie/scenes/global-meetings/meetings-business/desktop.a5fc36b14418.webp', position: '50% center' },
    { title: 'Viagem internacional', subtitle: 'Resolva situações do dia a dia', icon: Globe2, imageSrc: 'assets/wolfie/scenes/global-meetings/meetings-tourism/desktop.8ff421493764.webp', position: '65% center' },
    { title: 'Pronunciation lab', subtitle: 'Treine ritmo, clareza e intenção', icon: Mic2, imageSrc: 'assets/wolfie/scenes/skill-labs/pronunciation-lab/desktop.e8e29b402c75.webp', position: '72% center' },
  ];

  return (
    <TourShell accent={content.accent} title="Wolfie AI Tutor · prática contextual" status={mode === 'proof' ? 'espaço privado' : 'sessão guiada'} backdrop="assets/hub/videos/backdrops/digital-studio-v1.png">
      <div style={{ position: 'absolute', inset: 0, opacity: selectionOut, transform: `scale(${1 - (1 - selectionOut) * 0.035})` }}>
        <div style={{ padding: '24px 38px 0' }}>
          <div style={{ display: 'flex', alignItems: 'end', justifyContent: 'space-between' }}>
            <div><small style={{ color: content.accent, fontSize: 8, fontWeight: 900, letterSpacing: '0.13em' }}>ESCOLHA O CONTEXTO</small><h2 style={{ margin: '7px 0 0', fontFamily: displayFontFamily, fontSize: 30, letterSpacing: '-0.045em' }}>O inglês começa na situação que importa</h2></div>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: brand.muted, fontSize: 9, fontWeight: 700 }}><ShieldCheck size={14} color={content.accent} /> Nível B1 · objetivo profissional</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 15, marginTop: 23 }}>
            {scenarios.map((scenario, index) => <ScenarioCard key={scenario.title} title={scenario.title} subtitle={scenario.subtitle} icon={scenario.icon} accent={index === 0 ? content.accent : ['#7652ed', '#258e79', '#ffad70'][index - 1]} selected={index === 0 && frame >= 50} progress={spring({ frame: frame - 5 - index * 7, fps, config: { damping: 19, stiffness: 108 } })} imageSrc={scenario.imageSrc} imagePosition={scenario.position} />)}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr 1fr', gap: 12, marginTop: 17 }}>
            <div style={{ ...panelStyle(content.accent), display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px' }}><Target size={17} color={content.accent} /><div><b style={{ display: 'block', fontSize: 11 }}>Meta da sessão</b><small style={{ color: brand.muted, fontSize: 8 }}>Responder com exemplos claros e naturais</small></div></div>
            <div style={{ ...panelStyle(), display: 'flex', alignItems: 'center', gap: 10, padding: '14px' }}><Clock3 size={16} color="#7652ed" /><div><b style={{ display: 'block', fontSize: 10 }}>8 minutos</b><small style={{ color: brand.muted, fontSize: 8 }}>prática rápida</small></div></div>
            <div style={{ ...panelStyle(), display: 'flex', alignItems: 'center', gap: 10, padding: '14px' }}><Headphones size={16} color="#258e79" /><div><b style={{ display: 'block', fontSize: 10 }}>Voz natural</b><small style={{ color: brand.muted, fontSize: 8 }}>ritmo adaptativo</small></div></div>
          </div>
        </div>
      </div>
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', opacity: practiceIn, transform: `translateY(${(1 - practiceIn) * 34}px)` }}>
        <Img src={staticFile('assets/wolfie/scenes/career/job-interviews/desktop.dc0f18a9a9dc.webp')} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${1.045 + frame / 15000})`, filter: 'saturate(0.84) contrast(1.06)' }} />
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(90deg, rgba(4,8,15,0.96) 0%, rgba(4,8,15,0.56) 50%, rgba(4,8,15,0.91) 100%)' }} />
        <div style={{ position: 'absolute', left: 28, right: 28, top: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${UI_LINE}`, borderRadius: 999, background: 'rgba(4,8,15,0.72)', padding: '8px 12px', fontSize: 9, fontWeight: 850 }}><Bot size={14} color={content.accent} /> Entrevista de emprego</span>
          <div style={{ display: 'flex', gap: 8 }}>
            {mode === 'proof' && <span style={{ display: 'flex', alignItems: 'center', gap: 6, border: `1px solid ${content.accent}4f`, borderRadius: 999, background: `${content.accent}15`, padding: '8px 11px', color: brand.inkSoft, fontSize: 8, fontWeight: 850 }}><LockKeyhole size={12} color={content.accent} /> Sessão privada</span>}
            <span style={{ borderRadius: 999, background: 'rgba(4,8,15,0.72)', padding: '8px 11px', color: brand.inkSoft, fontSize: 8, fontWeight: 800 }}>05:42</span>
          </div>
        </div>
        <div style={{ position: 'absolute', left: 46, top: 110, width: 515 }}>
          <small style={{ color: content.accent, fontSize: 8, fontWeight: 900, letterSpacing: '0.13em' }}>WOLFIE PERGUNTA</small>
          <h3 style={{ margin: '10px 0 0', fontFamily: displayFontFamily, fontSize: 31, lineHeight: 1.02, letterSpacing: '-0.045em' }}>Which project best shows the impact of your work?</h3>
          <div style={{ ...panelStyle(content.accent), marginTop: 20, padding: '16px 17px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}><span style={{ color: brand.muted, fontSize: 8, fontWeight: 850 }}>SUA RESPOSTA</span><span style={{ display: 'flex', alignItems: 'center', gap: 5, color: listening ? '#7ee2cc' : '#ffbd85', fontSize: 8, fontWeight: 850 }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: listening ? '#5de1cf' : '#ffad70', boxShadow: `0 0 12px ${listening ? '#5de1cf' : '#ffad70'}` }} /> {listening ? 'ouvindo' : 'analisando'}</span></div>
            <p style={{ minHeight: 56, margin: '12px 0 0', color: brand.ink, fontFamily: displayFontFamily, fontSize: 17, lineHeight: 1.35 }}>{phrase.slice(0, visiblePhrase)}{visiblePhrase > 0 && visiblePhrase < phrase.length && <span style={{ color: content.accent }}>|</span>}</p>
            <Waveform accent={content.accent} frame={frame} active={listening} />
          </div>
        </div>
        <div style={{ position: 'absolute', left: 585, bottom: -54, width: 480, height: 588, transform: `translateY(${characterFloat}px) scale(${1 + Math.sin(frame / 43) * 0.006})` }}>
          <Img src={staticFile('assets/wolfie/characters/wolfie-coach/wolfie-v2-listening.07cf0629cc2d.webp')} style={{ width: '100%', height: '100%', objectFit: 'contain', filter: `drop-shadow(0 36px 58px rgba(0,0,0,0.54)) drop-shadow(0 0 44px ${content.accent}38)` }} />
        </div>
        <section
          style={{
            position: 'absolute',
            right: 24,
            top: 80,
            width: 460,
            height: 540,
            border: `1px solid ${content.accent}4f`,
            borderRadius: 24,
            background: 'rgba(9,13,20,0.96)',
            boxShadow: '-28px 30px 80px rgba(0,0,0,0.48)',
            padding: '20px',
            boxSizing: 'border-box',
            opacity: feedback,
            transform: `translateX(${(1 - feedback) * 490}px)`,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}><div><small style={{ color: content.accent, fontSize: 8, fontWeight: 900, letterSpacing: '0.12em' }}>FEEDBACK DA TENTATIVA</small><h4 style={{ margin: '7px 0 0', fontFamily: displayFontFamily, fontSize: 23 }}>Clareza antes da perfeição</h4></div><span style={{ display: 'grid', width: 42, height: 42, placeItems: 'center', borderRadius: 14, background: `${content.accent}1e`, color: content.accent, fontFamily: displayFontFamily, fontSize: 16, fontWeight: 900 }}>84</span></div>
          <div style={{ display: 'grid', gap: 10, marginTop: 18 }}>
            {[
              ['Pronúncia', 88, '#5de1cf'],
              ['Fluência', 79, content.accent],
              ['Vocabulário', 86, '#b89cff'],
            ].map(([label, score, color], index) => {
              const bar = spring({ frame: frame - 187 - index * 7, fps, config: { damping: 20, stiffness: 105 } });
              return (
                <div key={String(label)} style={{ ...panelStyle(), padding: '11px 13px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: brand.inkSoft, fontSize: 9, fontWeight: 800 }}><span>{label}</span><span>{score}</span></div>
                  <div style={{ height: 5, marginTop: 8, overflow: 'hidden', borderRadius: 999, background: 'rgba(255,255,255,0.07)' }}><div style={{ width: `${Number(score) * bar}%`, height: '100%', borderRadius: 999, background: String(color), boxShadow: `0 0 15px ${String(color)}66` }} /></div>
                </div>
              );
            })}
          </div>
          <div style={{ ...panelStyle('#258e79'), marginTop: 13, padding: '13px 14px' }}><div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#7ee2cc', fontSize: 9, fontWeight: 900 }}><Check size={13} /> Ponto forte</div><p style={{ margin: '6px 0 0', color: brand.inkSoft, fontSize: 9, lineHeight: 1.4 }}>Você conectou ação e impacto com um exemplo concreto.</p></div>
          <div style={{ ...panelStyle('#ffad70'), marginTop: 9, padding: '13px 14px' }}><div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#ffbd85', fontSize: 9, fontWeight: 900 }}><Zap size={13} /> Próxima tentativa</div><p style={{ margin: '6px 0 0', color: brand.inkSoft, fontSize: 9, lineHeight: 1.4 }}>Use “The result was…” para fechar a resposta com mais força.</p></div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, height: 44, marginTop: 14, borderRadius: 13, background: `linear-gradient(135deg, ${content.accent}, ${content.secondaryAccent})`, color: '#fff', fontSize: 9, fontWeight: 900, transform: `scale(${frame >= 201 && frame < 214 ? 0.97 : 1})` }}><RefreshCw size={13} /> Tentar novamente</div>
        </section>
        <div style={{ position: 'absolute', left: 600, bottom: 22, display: 'flex', gap: 9, opacity: 1 - feedback * 0.35 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 7, borderRadius: 999, background: content.accent, color: '#fff', padding: '10px 14px', fontSize: 8, fontWeight: 900 }}><Mic2 size={13} /> Manter pressionado para falar</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 7, border: `1px solid ${UI_LINE}`, borderRadius: 999, background: 'rgba(4,8,15,0.72)', color: brand.inkSoft, padding: '10px 13px', fontSize: 8, fontWeight: 800 }}><Play size={11} /> Ouvir pergunta</span>
        </div>
      </div>
      <TourCursor steps={cursorSteps} accent={content.accent} label={mode === 'proof' ? 'tentativa privada' : undefined} />
    </TourShell>
  );
};

const DemoChart: React.FC<{ accent: string; frame: number }> = ({ accent, frame }) => {
  const values = [42, 61, 54, 76, 68, 88, 80, 96, 86, 110, 103, 124];
  return (
    <div style={{ position: 'relative', height: 148, marginTop: 12, overflow: 'hidden' }}>
      {[0, 1, 2, 3].map((line) => <span key={line} style={{ position: 'absolute', left: 0, right: 0, top: 22 + line * 34, height: 1, background: 'rgba(255,255,255,0.06)' }} />)}
      <svg viewBox="0 0 600 148" width="100%" height="100%" style={{ overflow: 'visible' }}>
        <defs>
          <linearGradient id="school-chart-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={accent} stopOpacity="0.34" />
            <stop offset="100%" stopColor={accent} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`M 0 138 ${values.map((value, index) => `L ${index * 54.5} ${145 - value}`).join(' ')} L 600 148 Z`} fill="url(#school-chart-fill)" />
        <path d={`M 0 ${145 - values[0]} ${values.slice(1).map((value, index) => `L ${(index + 1) * 54.5} ${145 - value}`).join(' ')}`} fill="none" stroke={accent} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="760" strokeDashoffset={760 * (1 - clampProgress(frame, 18, 78))} />
        {values.map((value, index) => <circle key={index} cx={index * 54.5} cy={145 - value} r={index === values.length - 1 ? 5 : 2.5} fill={index === values.length - 1 ? '#fff' : accent} opacity={clampProgress(frame, 22 + index * 3, 34 + index * 3)} />)}
      </svg>
    </div>
  );
};

const SchoolDashboardView: React.FC<{ accent: string; frame: number }> = ({ accent, frame }) => {
  const metrics = [
    { label: 'Faturamento total', value: 'R$ 18.400', icon: CircleDollarSign, color: '#4fd1a5' },
    { label: 'Pendente', value: 'R$ 2.180', icon: Clock3, color: '#ffad70' },
    { label: 'Meta de MRR', value: 'R$ 21.600', icon: Target, color: '#67b7ff' },
    { label: 'Oportunidades', value: '12', icon: Users, color: '#b89cff' },
  ];

  return (
    <div style={{ padding: '20px 23px', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div><small style={{ color: accent, fontSize: 8, fontWeight: 900, letterSpacing: '0.12em' }}>VISÃO DO DIRETOR</small><h2 style={{ margin: '6px 0 0', fontFamily: displayFontFamily, fontSize: 24 }}>Operação em uma só leitura</h2></div>
        <div style={{ display: 'flex', gap: 8 }}><span style={{ border: `1px solid ${UI_LINE}`, borderRadius: 10, color: brand.inkSoft, padding: '8px 10px', fontSize: 8, fontWeight: 800 }}>Este mês</span><span style={{ borderRadius: 10, background: `${accent}1d`, color: accent, padding: '8px 10px', fontSize: 8, fontWeight: 850 }}>Atualizado agora</span></div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 11, marginTop: 16 }}>
        {metrics.map((metric, index) => <MiniMetric key={metric.label} {...metric} progress={spring({ frame: frame - 5 - index * 5, fps: 30, config: { damping: 19, stiffness: 110 } })} />)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1.55fr 0.8fr', gap: 12, marginTop: 12 }}>
        <section style={{ ...panelStyle(), height: 242, padding: '15px 17px', boxSizing: 'border-box' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}><div><b style={{ display: 'block', fontSize: 11 }}>Fluxo financeiro</b><small style={{ color: brand.muted, fontSize: 8 }}>Recebido e previsão contratada</small></div><BarChart3 size={16} color={accent} /></div>
          <DemoChart accent={accent} frame={frame} />
        </section>
        <section style={{ ...panelStyle(), height: 242, padding: '15px', boxSizing: 'border-box' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Zap size={14} color="#ffad70" /><b style={{ fontSize: 11 }}>Pendências do diretor</b></div>
          <div style={{ display: 'grid', gap: 8, marginTop: 13 }}>
            {[
              ['2 aulas para confirmar', '#ffad70'],
              ['1 contrato em revisão', '#b89cff'],
              ['3 leads sem retorno', accent],
            ].map(([label, color], index) => (
              <div key={label} style={{ display: 'grid', gridTemplateColumns: '7px 1fr auto', alignItems: 'center', gap: 8, borderRadius: 10, background: 'rgba(255,255,255,0.035)', padding: '10px 9px', opacity: clampProgress(frame, 25 + index * 7, 40 + index * 7), transform: `translateX(${(1 - clampProgress(frame, 25 + index * 7, 40 + index * 7)) * 18}px)` }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: color }} /><span style={{ color: brand.inkSoft, fontSize: 8, fontWeight: 750 }}>{label}</span><ArrowRight size={10} color={color} /></div>
            ))}
          </div>
        </section>
      </div>
      <section style={{ ...panelStyle(), marginTop: 12, padding: '13px 16px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.7fr 0.7fr auto', gap: 15, color: brand.muted, fontSize: 7, fontWeight: 900, letterSpacing: '0.08em' }}><span>ALUNO DEMO</span><span>VALOR</span><span>STATUS</span><span>DATA</span></div>
        {[
          ['Aluno Demo 01', 'R$ 420,00', 'PAGO', '22 ago'],
          ['Aluno Demo 02', 'R$ 390,00', 'PENDENTE', '21 ago'],
        ].map(([name, value, status, date], index) => <div key={name} style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.7fr 0.7fr auto', gap: 15, alignItems: 'center', borderTop: `1px solid ${UI_LINE}`, marginTop: 9, paddingTop: 9, color: brand.inkSoft, fontSize: 8, opacity: clampProgress(frame, 45 + index * 6, 58 + index * 6) }}><span style={{ fontWeight: 800 }}>{name}</span><span>{value}</span><span style={{ color: status === 'PAGO' ? '#70d8bc' : '#ffbd85', fontWeight: 900 }}>{status}</span><span style={{ color: brand.muted }}>{date}</span></div>)}
      </section>
    </div>
  );
};

const LeadCard: React.FC<{
  name: string;
  note: string;
  value: string;
  accent: string;
  highlighted?: boolean;
}> = ({ name, note, value, accent, highlighted = false }) => (
  <article style={{ border: `1px solid ${highlighted ? `${accent}6f` : UI_LINE}`, borderRadius: 13, background: highlighted ? `${accent}12` : 'rgba(255,255,255,0.035)', boxShadow: highlighted ? `0 16px 34px rgba(0,0,0,0.4), 0 0 26px ${accent}1e` : undefined, padding: '11px' }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}><b style={{ fontSize: 9 }}>{name}</b><span style={{ width: 6, height: 6, borderRadius: '50%', background: accent }} /></div>
    <p style={{ margin: '6px 0 0', color: brand.muted, fontSize: 7, lineHeight: 1.35 }}>{note}</p>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 9 }}><span style={{ color: brand.inkSoft, fontSize: 8, fontWeight: 800 }}>{value}</span><span style={{ borderRadius: 999, background: `${accent}18`, color: accent, padding: '4px 6px', fontSize: 6, fontWeight: 900 }}>DEMO</span></div>
  </article>
);

const SchoolCrmView: React.FC<{ accent: string; frame: number }> = ({ accent, frame }) => {
  const localFrame = Math.max(0, frame - 92);
  const columns = [
    { title: 'Novos contatos', color: '#67b7ff', leads: [['Aluno Demo 03', 'Interesse em inglês para carreira', 'R$ 420'], ['Aluno Demo 04', 'Curso intensivo online', 'R$ 390']] },
    { title: 'Qualificação', color: '#b89cff', leads: [['Aluno Demo 05', 'Busca conversação B1', 'R$ 450']] },
    { title: 'Aula experimental', color: '#ffad70', leads: [['Aluno Demo 06', 'Terça-feira · 19h', 'R$ 420']] },
    { title: 'Matrícula', color: '#4fd1a5', leads: [['Aluno Demo 07', 'Contrato em preparação', 'R$ 480']] },
  ];
  const dragProgress = clampProgress(frame, 178, 216);
  const cardX = interpolate(dragProgress, [0, 1], [28, 333], { easing: Easing.inOut(Easing.cubic) });
  const cardY = interpolate(dragProgress, [0, 0.55, 1], [185, 132, 211], { easing: Easing.inOut(Easing.cubic) });
  const notification = spring({ frame: frame - 216, fps: 30, config: { damping: 16, stiffness: 130 } });

  return (
    <div style={{ position: 'relative', padding: '20px 22px', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}><div><small style={{ color: accent, fontSize: 8, fontWeight: 900, letterSpacing: '0.12em' }}>PIPELINE COMERCIAL</small><h2 style={{ margin: '6px 0 0', fontFamily: displayFontFamily, fontSize: 24 }}>Do contato à matrícula</h2></div><div style={{ display: 'flex', gap: 8 }}><span style={{ border: `1px solid ${UI_LINE}`, borderRadius: 10, color: brand.inkSoft, padding: '8px 10px', fontSize: 8, fontWeight: 800 }}>12 oportunidades</span><span style={{ borderRadius: 10, background: `${accent}1d`, color: accent, padding: '8px 10px', fontSize: 8, fontWeight: 850 }}>+ Nova oportunidade</span></div></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 11, marginTop: 17 }}>
        {columns.map((column, columnIndex) => {
          const columnReveal = spring({ frame: localFrame - columnIndex * 6, fps: 30, config: { damping: 19, stiffness: 108 } });
          return (
            <section key={column.title} style={{ ...panelStyle(), minHeight: 474, padding: '12px', boxSizing: 'border-box', ...revealStyle(columnReveal, 22) }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: `1px solid ${UI_LINE}`, paddingBottom: 10 }}><div style={{ display: 'flex', alignItems: 'center', gap: 7 }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: column.color }} /><b style={{ fontSize: 9 }}>{column.title}</b></div><span style={{ borderRadius: 999, background: 'rgba(255,255,255,0.055)', color: brand.muted, padding: '4px 7px', fontSize: 7, fontWeight: 900 }}>{column.leads.length + (columnIndex === 1 && dragProgress > 0.8 ? 1 : 0)}</span></div>
              <div style={{ display: 'grid', gap: 9, marginTop: 11 }}>
                {column.leads.map(([name, note, value], leadIndex) => <LeadCard key={name} name={name} note={note} value={value} accent={column.color} highlighted={columnIndex === 2 && leadIndex === 0} />)}
                {columnIndex === 1 && dragProgress > 0.9 && <LeadCard name="Aluno Demo 03" note="Retorno agendado com consultor" value="R$ 420" accent={column.color} highlighted />}
              </div>
            </section>
          );
        })}
      </div>
      {frame >= 168 && frame <= 219 && (
        <div style={{ position: 'absolute', left: cardX, top: cardY, width: 286, zIndex: 30, opacity: 1 - clampProgress(frame, 211, 219), transform: `rotate(${interpolate(dragProgress, [0, 0.5, 1], [0, -2.5, 1])}deg) scale(${1.02 + Math.sin(dragProgress * Math.PI) * 0.04})` }}><LeadCard name="Aluno Demo 03" note="Interesse em inglês para carreira" value="R$ 420" accent={accent} highlighted /></div>
      )}
      <div style={{ position: 'absolute', right: 27, bottom: 22, display: 'flex', alignItems: 'center', gap: 8, border: '1px solid rgba(79,209,165,0.38)', borderRadius: 12, background: 'rgba(11,27,23,0.94)', boxShadow: '0 18px 46px rgba(0,0,0,0.42)', color: '#80e6c0', padding: '11px 14px', fontSize: 8, fontWeight: 850, opacity: notification, transform: `translateY(${(1 - notification) * 20}px)` }}><Check size={13} /> Etapa atualizada e histórico preservado</div>
    </div>
  );
};

const BrandingSettingsView: React.FC<{ accent: string; frame: number }> = ({ accent, frame }) => (
  <div style={{ padding: '22px 25px' }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}><div><small style={{ color: accent, fontSize: 8, fontWeight: 900, letterSpacing: '0.12em' }}>IDENTIDADE DA ESCOLA</small><h2 style={{ margin: '6px 0 0', fontFamily: displayFontFamily, fontSize: 25 }}>Sua marca em toda a jornada</h2></div><span style={{ display: 'flex', alignItems: 'center', gap: 7, borderRadius: 11, background: `${accent}1c`, color: accent, padding: '9px 11px', fontSize: 8, fontWeight: 850 }}><Palette size={13} /> Publicar alterações</span></div>
    <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 0.85fr', gap: 13, marginTop: 17 }}>
      <section style={{ ...panelStyle(), padding: '17px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 11 }}>
          <PlannerField label="Nome da escola" value="Instituto Aurora" accent={accent} active={frame >= 18 && frame < 42} />
          <PlannerField label="Endereço Wise Wolf" value="aurora.wisewolflanguage.com.br" accent={accent} />
        </div>
        <div style={{ marginTop: 13 }}><small style={{ color: brand.muted, fontSize: 7, fontWeight: 900, letterSpacing: '0.1em' }}>PALETA DA MARCA</small><div style={{ display: 'flex', gap: 10, marginTop: 9 }}>{['#1d4ed8', '#7c3aed', '#f97316', '#0f766e'].map((color, index) => <span key={color} style={{ display: 'grid', width: 66, height: 52, placeItems: 'center', border: `2px solid ${index === 0 ? '#fff' : 'transparent'}`, borderRadius: 13, background: color, boxShadow: index === 0 ? `0 0 24px ${color}66` : undefined }}><Check size={15} color="#fff" opacity={index === 0 ? 1 : 0} /></span>)}</div></div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 11, marginTop: 14 }}>
          {['Logo principal', 'Favicon'].map((label, index) => <div key={label} style={{ ...panelStyle(), display: 'grid', height: 112, placeItems: 'center', textAlign: 'center' }}><div><span style={{ display: 'grid', width: index === 0 ? 96 : 42, height: 42, margin: '0 auto', placeItems: 'center', borderRadius: index === 0 ? 12 : 9, background: index === 0 ? 'linear-gradient(135deg, #1d4ed8, #7c3aed)' : '#1d4ed8', color: '#fff' }}>{index === 0 ? <><GraduationCap size={18} /><small style={{ marginLeft: 4, fontSize: 7, fontWeight: 900 }}>AURORA</small></> : <GraduationCap size={18} />}</span><b style={{ display: 'block', marginTop: 9, fontSize: 8 }}>{label}</b><small style={{ color: brand.muted, fontSize: 7 }}>arquivo demonstrativo</small></div></div>)}
        </div>
      </section>
      <section style={{ ...panelStyle('#1d4ed8'), overflow: 'hidden', padding: 13 }}>
        <small style={{ color: '#73a1ff', fontSize: 7, fontWeight: 900, letterSpacing: '0.1em' }}>PRÉVIA DO PORTAL</small>
        <div style={{ position: 'relative', height: 402, marginTop: 11, overflow: 'hidden', borderRadius: 15, background: '#f6f8fd', color: '#14213b' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 47, borderBottom: '1px solid #dce3f1', padding: '0 14px' }}><span style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#1d4ed8', fontSize: 8, fontWeight: 900 }}><GraduationCap size={15} /> INSTITUTO AURORA</span><span style={{ width: 24, height: 24, borderRadius: '50%', background: '#dce7ff' }} /></div>
          <div style={{ padding: 18 }}><small style={{ color: '#64748b', fontSize: 7, fontWeight: 800 }}>BEM-VINDA, ALUNA DEMO 01</small><h3 style={{ margin: '8px 0 0', fontFamily: displayFontFamily, fontSize: 23, lineHeight: 1.02 }}>Seu inglês continua aqui.</h3><div style={{ height: 104, marginTop: 18, borderRadius: 15, background: 'linear-gradient(135deg, #1d4ed8, #7c3aed)', padding: 16, color: '#fff' }}><small style={{ fontSize: 7, fontWeight: 900 }}>PRÓXIMA AULA</small><b style={{ display: 'block', marginTop: 8, fontSize: 13 }}>Business conversation</b><span style={{ display: 'block', marginTop: 5, fontSize: 8, opacity: 0.8 }}>Terça · 19h · Professor Demo 01</span></div><div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9, marginTop: 12 }}>{['Materiais', 'Praticar com Wolfie'].map((label, index) => <div key={label} style={{ height: 86, borderRadius: 13, background: index === 0 ? '#e9effd' : '#f0eafd', padding: 12 }}><span style={{ display: 'grid', width: 25, height: 25, placeItems: 'center', borderRadius: 8, background: index === 0 ? '#1d4ed8' : '#7c3aed', color: '#fff' }}>{index === 0 ? <BookOpen size={12} /> : <Bot size={12} />}</span><b style={{ display: 'block', marginTop: 8, fontSize: 8 }}>{label}</b></div>)}</div></div>
        </div>
      </section>
    </div>
  </div>
);

const CredentialsSettingsView: React.FC<{ accent: string; frame: number }> = ({ accent, frame }) => {
  const integrations = [
    { name: 'Asaas', detail: 'Cobranças da escola', environment: 'Sandbox', color: '#67b7ff', suffix: '4821' },
    { name: 'Evolution WhatsApp', detail: 'Mensagens operacionais', environment: 'Produção', color: '#4fd1a5', suffix: '9307' },
    { name: 'OpenAI', detail: 'Recursos de inteligência', environment: 'Produção', color: '#b89cff', suffix: '1164' },
  ];
  return (
    <div style={{ padding: '22px 25px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}><div><small style={{ color: accent, fontSize: 8, fontWeight: 900, letterSpacing: '0.12em' }}>COFRE DE CREDENCIAIS</small><h2 style={{ margin: '6px 0 0', fontFamily: displayFontFamily, fontSize: 25 }}>Chaves validadas, nunca devolvidas</h2></div><span style={{ display: 'flex', alignItems: 'center', gap: 7, border: '1px solid rgba(79,209,165,0.38)', borderRadius: 11, background: 'rgba(79,209,165,0.08)', color: '#80e6c0', padding: '9px 11px', fontSize: 8, fontWeight: 850 }}><Vault size={13} /> Cofre ativo</span></div>
      <div style={{ ...panelStyle('#ffad70'), marginTop: 16, padding: '12px 14px', color: brand.inkSoft, fontSize: 9, lineHeight: 1.45 }}><b style={{ color: '#ffbd85' }}>Preparação controlada:</b> a chave é write-only, validada no servidor e só entra no runtime após ativação explícita.</div>
      <div style={{ display: 'grid', gap: 11, marginTop: 14 }}>
        {integrations.map((integration, index) => {
          const reveal = spring({ frame: frame - 82 - index * 7, fps: 30, config: { damping: 18, stiffness: 112 } });
          return (
            <section key={integration.name} style={{ ...panelStyle(), display: 'grid', gridTemplateColumns: '1fr 280px auto', alignItems: 'center', gap: 16, minHeight: 112, padding: '14px 15px', boxSizing: 'border-box', ...revealStyle(reveal, 20) }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}><span style={{ display: 'grid', width: 38, height: 38, placeItems: 'center', borderRadius: 12, background: `${integration.color}1c`, color: integration.color }}><KeyRound size={17} /></span><div><div style={{ display: 'flex', alignItems: 'center', gap: 7 }}><b style={{ fontSize: 11 }}>{integration.name}</b><span style={{ borderRadius: 999, background: 'rgba(255,173,112,0.1)', color: '#ffbd85', padding: '4px 7px', fontSize: 6, fontWeight: 900 }}>PREPARADA</span></div><small style={{ display: 'block', marginTop: 4, color: brand.muted, fontSize: 8 }}>{integration.detail}</small><small style={{ display: 'block', marginTop: 5, color: brand.muted, fontSize: 7 }}>Final •••• {integration.suffix} · {integration.environment}</small></div></div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 42, border: `1px solid ${UI_LINE}`, borderRadius: 11, background: 'rgba(255,255,255,0.025)', color: brand.muted, padding: '0 12px', fontSize: 9 }}><span>••••••••••••••••••••••••</span><LockKeyhole size={13} color={integration.color} /></div>
              <span style={{ borderRadius: 11, background: `${integration.color}1a`, color: integration.color, padding: '12px 13px', fontSize: 8, fontWeight: 900 }}>VALIDAR E SUBSTITUIR</span>
            </section>
          );
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 13, color: brand.muted, fontSize: 8, fontWeight: 700 }}><ShieldCheck size={13} color={accent} /> Segredos não retornam ao navegador nem entram no histórico administrativo.</div>
    </div>
  );
};

const SecuritySettingsView: React.FC<{ accent: string; frame: number; startFrame?: number }> = ({ accent, frame, startFrame = 162 }) => {
  const controls = [
    { title: 'Autoridade do tenant', detail: 'Associação ativa e plano resolvidos no servidor', icon: ShieldCheck, color: accent },
    { title: 'Cofre de segredos', detail: 'Credenciais write-only, sem leitura pelo cliente', icon: Vault, color: '#b89cff' },
    { title: 'Namespace privado', detail: 'Arquivos separados por escola e finalidade', icon: Folder, color: '#67b7ff' },
    { title: 'Papéis por função', detail: 'Diretor, professor, financeiro e aluno', icon: Users, color: '#4fd1a5' },
  ];
  return (
    <div style={{ padding: '22px 25px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}><div><small style={{ color: accent, fontSize: 8, fontWeight: 900, letterSpacing: '0.12em' }}>ISOLAMENTO E PROTEÇÃO</small><h2 style={{ margin: '6px 0 0', fontFamily: displayFontFamily, fontSize: 25 }}>Cada escola vê somente o que é dela</h2></div><span style={{ display: 'flex', alignItems: 'center', gap: 7, border: '1px solid rgba(79,209,165,0.38)', borderRadius: 11, background: 'rgba(79,209,165,0.08)', color: '#80e6c0', padding: '9px 11px', fontSize: 8, fontWeight: 850 }}><Check size={13} /> Ambiente isolado</span></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 11, marginTop: 17 }}>
        {controls.map((control, index) => {
          const reveal = spring({ frame: frame - startFrame - index * 7, fps: 30, config: { damping: 18, stiffness: 112 } });
          const Icon = control.icon;
          return <section key={control.title} style={{ ...panelStyle(control.color), display: 'flex', alignItems: 'center', gap: 13, minHeight: 106, padding: '15px 16px', boxSizing: 'border-box', ...revealStyle(reveal, 22) }}><span style={{ display: 'grid', width: 43, height: 43, flex: '0 0 auto', placeItems: 'center', borderRadius: 13, background: `${control.color}1c`, color: control.color }}><Icon size={19} /></span><div><b style={{ display: 'block', fontFamily: displayFontFamily, fontSize: 14 }}>{control.title}</b><small style={{ display: 'block', marginTop: 6, color: brand.muted, fontSize: 8, lineHeight: 1.45 }}>{control.detail}</small></div></section>;
        })}
      </div>
      <section style={{ ...panelStyle(), marginTop: 13, padding: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}><div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Clock3 size={14} color={accent} /><b style={{ fontSize: 11 }}>Histórico de configurações</b></div><small style={{ color: brand.muted, fontSize: 7 }}>sem segredos ou respostas cruas</small></div>
        <div style={{ marginTop: 11 }}>
          {[
            ['Configurações registradas', 'diretor · marca', 'agora'],
            ['Credencial preparada', 'diretor · integrações', 'há 2 min'],
            ['Permissões revisadas', 'sistema · segurança', 'há 5 min'],
          ].map(([title, meta, time], index) => <div key={title} style={{ display: 'grid', gridTemplateColumns: '10px 1fr auto', alignItems: 'center', gap: 9, borderTop: index ? `1px solid ${UI_LINE}` : undefined, padding: '10px 2px', opacity: clampProgress(frame, startFrame + 33 + index * 6, startFrame + 46 + index * 6) }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: accent }} /><div><b style={{ display: 'block', fontSize: 8 }}>{title}</b><small style={{ color: brand.muted, fontSize: 7 }}>{meta}</small></div><small style={{ color: brand.muted, fontSize: 7 }}>{time}</small></div>)}
        </div>
      </section>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, marginTop: 13, borderRadius: 13, background: `${accent}14`, color: brand.inkSoft, padding: '12px', fontSize: 9, fontWeight: 800 }}><LockKeyhole size={14} color={accent} /> tenant_id + papel + política de acesso em cada fluxo protegido</div>
    </div>
  );
};

const SchoolTour: React.FC<ProductTourProps> = ({ content, mode }) => {
  const frame = useCurrentFrame();
  const pageChange = spring({ frame: frame - 88, fps: 30, config: { damping: 19, stiffness: 105 } });
  const credentialsIn = clampProgress(frame, 69, 83);
  const securityIn = clampProgress(frame, 151, 166);
  const cursorSteps: CursorStep[] = mode === 'product'
    ? [
      { at: 0, x: 1130, y: 92 },
      { at: 78, x: 105, y: 195, click: true },
      { at: 142, x: 330, y: 290 },
      { at: 174, x: 320, y: 303, click: true },
      { at: 215, x: 622, y: 331 },
      { at: 232, x: 1400, y: 106 },
    ]
    : [
      { at: 0, x: 102, y: 253 },
      { at: 14, x: 102, y: 253, click: true },
      { at: 70, x: 104, y: 370, click: true },
      { at: 126, x: 1260, y: 356 },
      { at: 152, x: 106, y: 426, click: true },
      { at: 204, x: 1210, y: 554 },
      { at: 236, x: 1380, y: 616 },
    ];

  if (mode === 'proof') {
    return (
      <TourShell accent={content.accent} title="School OS · configurações da escola" status="isolamento multi-tenant" backdrop="assets/hub/videos/backdrops/school-operations-v1.png">
        <div style={{ display: 'flex', height: '100%' }}>
          <TourSidebar
            accent={content.accent}
            title="Instituto Aurora"
            width={202}
            footer="dados fictícios · acesso isolado"
            items={[
              { label: 'Visão geral', icon: LayoutDashboard },
              { label: 'Escola e legal', icon: GraduationCap },
              { label: 'Marca', icon: Palette, active: credentialsIn < 0.5 },
              { label: 'Portal e domínio', icon: Globe2 },
              { label: 'Operação', icon: Settings2 },
              { label: 'Credenciais', icon: KeyRound, active: credentialsIn >= 0.5 && securityIn < 0.5 },
              { label: 'Segurança', icon: ShieldCheck, active: securityIn >= 0.5 },
            ]}
          />
          <main style={{ position: 'relative', flex: 1, minWidth: 0, overflow: 'hidden' }}>
            <div style={{ position: 'absolute', inset: 0, opacity: 1 - credentialsIn, transform: `translateX(${-credentialsIn * 45}px) scale(${1 - credentialsIn * 0.018})` }}><BrandingSettingsView accent={content.accent} frame={frame} /></div>
            <div style={{ position: 'absolute', inset: 0, opacity: credentialsIn * (1 - securityIn), transform: `translateX(${(1 - credentialsIn) * 45 - securityIn * 45}px)` }}><CredentialsSettingsView accent={content.accent} frame={frame} /></div>
            <div style={{ position: 'absolute', inset: 0, opacity: securityIn, transform: `translateX(${(1 - securityIn) * 45}px)` }}><SecuritySettingsView accent={content.accent} frame={frame} /></div>
          </main>
        </div>
        <TourCursor steps={cursorSteps} accent={content.accent} label="acesso do diretor" />
      </TourShell>
    );
  }

  return (
    <TourShell accent={content.accent} title="Wise Wolf School OS" status="operação conectada" backdrop="assets/hub/videos/backdrops/school-operations-v1.png">
      <div style={{ display: 'flex', height: '100%' }}>
        <TourSidebar
          accent={content.accent}
          title="Instituto Aurora"
          width={190}
          footer="dados fictícios · acesso isolado"
          items={[
            { label: 'Dashboard', icon: LayoutDashboard, active: pageChange < 0.5 },
            { label: 'CRM', icon: Workflow, active: pageChange >= 0.5 },
            { label: 'Agenda', icon: Clock3 },
            { label: 'Alunos', icon: Users },
            { label: 'Financeiro', icon: CircleDollarSign },
            { label: 'Configurações', icon: Settings2 },
          ]}
        />
        <main style={{ position: 'relative', flex: 1, minWidth: 0, overflow: 'hidden' }}>
          <div style={{ position: 'absolute', inset: 0, opacity: 1 - pageChange, transform: `translateX(${-pageChange * 90}px) scale(${1 - pageChange * 0.025})` }}><SchoolDashboardView accent={content.accent} frame={frame} /></div>
          <div style={{ position: 'absolute', inset: 0, opacity: pageChange, transform: `translateX(${(1 - pageChange) * 110}px)` }}><SchoolCrmView accent={content.accent} frame={frame} /></div>
        </main>
      </div>
      <TourCursor steps={cursorSteps} accent={content.accent} label="acesso do diretor" />
    </TourShell>
  );
};

const BookCover: React.FC<{
  title: string;
  level: string;
  niche: string;
  part: string;
  accent: string;
  frame: number;
  index: number;
}> = ({ title, level, niche, part, accent, frame, index }) => {
  const reveal = clampProgress(frame, 6 + index * 6, 22 + index * 6);
  const float = Math.sin((frame + index * 11) / 21) * 1.6;
  return (
    <div
      style={{
        position: 'relative',
        height: 196,
        opacity: reveal,
        transform: `translateY(${(1 - reveal) * 20 + float}px) rotateZ(${(1 - reveal) * -2}deg)`,
      }}
    >
      <div
        style={{
          position: 'relative',
          height: '100%',
          overflow: 'hidden',
          borderRadius: '5px 12px 12px 5px',
          background: `linear-gradient(128deg, ${accent}42, #171a24 52%, #101219)`,
          border: `1px solid ${accent}4a`,
          boxShadow: `0 16px 34px rgba(0,0,0,0.46), 0 0 26px ${accent}18`,
          padding: '12px 12px 12px 20px',
          boxSizing: 'border-box',
        }}
      >
        <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 9, background: `linear-gradient(180deg, ${accent}, ${accent}72)`, boxShadow: `2px 0 12px ${accent}44` }} />
        <span style={{ position: 'absolute', left: 9, top: 0, bottom: 0, width: 2, background: 'rgba(255,255,255,0.09)' }} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ color: accent, fontSize: 6.5, fontWeight: 900, letterSpacing: '0.13em' }}>{niche}</span>
          <span style={{ borderRadius: 999, background: `${accent}22`, color: accent, padding: '2px 6px', fontSize: 6.5, fontWeight: 900 }}>{level}</span>
        </div>
        <b style={{ display: 'block', marginTop: 14, fontFamily: displayFontFamily, fontSize: 13, lineHeight: 1.12, letterSpacing: '-0.03em' }}>{title}</b>
        <div style={{ display: 'flex', gap: 3, marginTop: 12 }}>
          {[0, 1, 2, 3].map((line) => <span key={line} style={{ height: 3, flex: line === 3 ? 0.5 : 1, borderRadius: 999, background: 'rgba(255,255,255,0.13)' }} />)}
        </div>
        <div style={{ position: 'absolute', left: 20, right: 12, bottom: 11, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: brand.muted, fontSize: 6.5, fontWeight: 800 }}><FileText size={9} color={accent} />{part}</span>
          <span style={{ display: 'grid', width: 19, height: 19, placeItems: 'center', borderRadius: 6, background: `${accent}1e`, color: accent }}><BookOpen size={10} /></span>
        </div>
      </div>
    </div>
  );
};

const EcosystemLibraryPanel: React.FC<{ accent: string; frame: number }> = ({ accent, frame }) => (
  <div style={{ display: 'grid', gridTemplateRows: '52px 1fr', height: '100%', background: '#0d1016' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, borderBottom: `1px solid ${UI_LINE}`, padding: '0 16px' }}><span style={{ display: 'grid', width: 28, height: 28, placeItems: 'center', borderRadius: 9, background: `${accent}1c`, color: accent }}><Library size={14} /></span><b style={{ fontSize: 10 }}>Wise Wolf Library</b><span style={{ marginLeft: 'auto', color: brand.muted, fontSize: 7 }}>catálogo protegido</span></div>
    <div style={{ display: 'grid', gridTemplateColumns: '145px 1fr', minHeight: 0 }}>
      <div style={{ borderRight: `1px solid ${UI_LINE}`, padding: 14 }}>
        <small style={{ color: brand.muted, fontSize: 7, fontWeight: 900 }}>NICHOS</small>
        {['Business', 'Conversation', 'Travel', 'Grammar'].map((label, index) => <div key={label} style={{ borderRadius: 8, background: index === 0 ? `${accent}1b` : 'transparent', color: index === 0 ? brand.ink : brand.muted, marginTop: 9, padding: '8px 9px', fontSize: 8, fontWeight: 750 }}>{label}</div>)}
        <small style={{ display: 'block', marginTop: 17, color: brand.muted, fontSize: 7, fontWeight: 900 }}>NÍVEL</small>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 9 }}>
          {['A1', 'A2', 'B1', 'B2'].map((tag, index) => <span key={tag} style={{ borderRadius: 6, border: `1px solid ${index === 2 ? `${accent}66` : UI_LINE}`, background: index === 2 ? `${accent}18` : 'transparent', color: index === 2 ? accent : brand.muted, padding: '4px 7px', fontSize: 7, fontWeight: 850 }}>{tag}</span>)}
        </div>
      </div>
      <div style={{ padding: '13px 15px', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 33, border: `1px solid ${accent}50`, borderRadius: 10, background: `${accent}0b`, padding: '0 11px', color: brand.inkSoft, fontSize: 8 }}><Search size={12} color={accent} /> apresentação de resultados</div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
          <small style={{ color: accent, fontSize: 7, fontWeight: 900, letterSpacing: '0.12em' }}>LIVROS E EBOOKS</small>
          <span style={{ color: brand.muted, fontSize: 6.5 }}>livro grande entra fracionado em partes</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 9, marginTop: 8 }}>
          <BookCover title="Business English in Use" niche="BUSINESS" level="B1" part="Parte 2 de 5" accent={accent} frame={frame} index={0} />
          <BookCover title="Everyday Conversation" niche="CONVERSATION" level="A2" part="Parte 1 de 3" accent="#7652ed" frame={frame} index={1} />
          <BookCover title="Travel & Airport Guide" niche="TRAVEL" level="A1" part="Parte 1 de 2" accent="#20a9cc" frame={frame} index={2} />
          <BookCover title="Grammar Foundations" niche="GRAMMAR" level="B2" part="Parte 4 de 6" accent="#4fd1a5" frame={frame} index={3} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 13 }}>
          <small style={{ color: brand.muted, fontSize: 7, fontWeight: 900, letterSpacing: '0.12em' }}>MATERIAIS AVULSOS</small>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: brand.muted, fontSize: 6.5 }}><ShieldCheck size={10} color={accent} /> o arquivo completo só abre após a política de acesso</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 9, marginTop: 8 }}>
          {['Presenting results', 'Handling pushback', 'Quarterly review'].map((title, index) => (
            <div key={title} style={{ ...panelStyle(index === 0 ? accent : undefined), display: 'grid', gridTemplateColumns: '36px 1fr', alignItems: 'center', gap: 10, padding: '12px 11px', ...revealStyle(clampProgress(frame, 30 + index * 5, 44 + index * 5), 14) }}>
              <span style={{ display: 'grid', width: 36, height: 36, placeItems: 'center', borderRadius: 10, background: `${index === 0 ? accent : ['#7652ed', '#20a9cc'][index - 1]}1e`, color: index === 0 ? accent : ['#7652ed', '#20a9cc'][index - 1] }}><FileText size={15} /></span>
              <div style={{ minWidth: 0 }}>
                <b style={{ display: 'block', fontFamily: displayFontFamily, fontSize: 10, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</b>
                <small style={{ display: 'block', marginTop: 3, color: brand.muted, fontSize: 6.5 }}>B{index + 1} · prévia disponível</small>
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 9, marginTop: 12, opacity: clampProgress(frame, 46, 58) }}>
          {[
            { label: 'Nichos', value: '4', icon: Folder },
            { label: 'Livros e ebooks', value: '12', icon: BookOpen },
            { label: 'Materiais', value: '38', icon: FileText },
            { label: 'Níveis', value: 'A1–B2', icon: GraduationCap },
          ].map(({ label, value, icon: Icon }) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, borderRadius: 10, border: `1px solid ${UI_LINE}`, background: 'rgba(255,255,255,0.022)', padding: '9px 10px' }}>
              <span style={{ display: 'grid', width: 24, height: 24, placeItems: 'center', borderRadius: 7, background: `${accent}17`, color: accent }}><Icon size={11} /></span>
              <div><b style={{ display: 'block', fontFamily: displayFontFamily, fontSize: 13, letterSpacing: '-0.03em' }}>{value}</b><small style={{ display: 'block', color: brand.muted, fontSize: 6.5, fontWeight: 800 }}>{label}</small></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  </div>
);

const EcosystemEducatorPanel: React.FC<{ accent: string; frame: number }> = ({ accent, frame }) => (
  <div style={{ display: 'grid', gridTemplateColumns: '0.78fr 1.22fr', height: '100%', background: '#0d1016' }}>
    <div style={{ borderRight: `1px solid ${UI_LINE}`, padding: 17 }}><small style={{ color: accent, fontSize: 7, fontWeight: 900 }}>CONTEXTO PEDAGÓGICO</small><h3 style={{ margin: '7px 0 13px', fontFamily: displayFontFamily, fontSize: 18 }}>Resultado primeiro</h3><div style={{ display: 'grid', gap: 9 }}><PlannerField label="Resultado esperado" value="Apresentar resultados com clareza" accent={accent} active /><div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}><PlannerField label="Nível" value="B1" accent={accent} /><PlannerField label="Duração" value="60 min" accent={accent} /></div></div><div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, height: 40, marginTop: 12, borderRadius: 11, background: `linear-gradient(135deg, ${accent}, #a17fff)`, fontSize: 8, fontWeight: 900 }}><Sparkles size={12} /> Estruturar aula</div></div>
    <div style={{ padding: 17 }}><div style={{ display: 'flex', justifyContent: 'space-between' }}><div><small style={{ color: accent, fontSize: 7, fontWeight: 900 }}>PLANO ESTRUTURADO</small><h3 style={{ margin: '6px 0 0', fontFamily: displayFontFamily, fontSize: 18 }}>From update to next step</h3></div><span style={{ color: brand.muted, fontSize: 7 }}>versão para adaptar</span></div><div style={{ display: 'grid', gap: 8, marginTop: 13 }}>{[['01', 'Aquecimento', '10 min'], ['02', 'Experiência central', '25 min'], ['03', 'Prática guiada', '20 min'], ['04', 'Continuidade', '5 min']].map(([number, title, time], index) => <div key={number} style={{ ...panelStyle(), display: 'grid', gridTemplateColumns: '32px 1fr auto', alignItems: 'center', gap: 9, minHeight: 61, padding: '9px 11px', ...revealStyle(clampProgress(frame, 64 + index * 5, 78 + index * 5), 16) }}><span style={{ display: 'grid', width: 30, height: 30, placeItems: 'center', borderRadius: 9, background: `${accent}1d`, color: accent, fontSize: 8, fontWeight: 900 }}>{number}</span><div><b style={{ display: 'block', fontSize: 9 }}>{title}</b><small style={{ color: brand.muted, fontSize: 7 }}>Professor orienta · aluno pratica</small></div><span style={{ color: brand.inkSoft, fontSize: 7, fontWeight: 800 }}>{time}</span></div>)}</div></div>
  </div>
);

const EcosystemWolfiePanel: React.FC<{ accent: string; frame: number }> = ({ accent, frame }) => (
  <div style={{ position: 'relative', height: '100%', overflow: 'hidden', background: '#07101b' }}>
    <Img src={staticFile('assets/wolfie/scenes/career/job-interviews/desktop.dc0f18a9a9dc.webp')} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${1.05 + frame / 16000})`, filter: 'saturate(0.82)' }} />
    <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(90deg, rgba(3,8,16,0.94), rgba(3,8,16,0.4), rgba(3,8,16,0.82))' }} />
    <div style={{ position: 'absolute', left: 24, top: 22, width: 390 }}><small style={{ color: accent, fontSize: 7, fontWeight: 900 }}>ENTREVISTA DE EMPREGO</small><h3 style={{ margin: '9px 0 0', fontFamily: displayFontFamily, fontSize: 27, lineHeight: 1.04 }}>Which project best shows your impact?</h3><div style={{ ...panelStyle(accent), marginTop: 18, padding: 14 }}><small style={{ color: brand.muted, fontSize: 7, fontWeight: 850 }}>SUA RESPOSTA</small><p style={{ margin: '8px 0 2px', fontFamily: displayFontFamily, fontSize: 13 }}>I would highlight the project that reduced our response time.</p><Waveform accent={accent} frame={frame} bars={20} /></div></div>
    <div style={{ position: 'absolute', left: 440, bottom: -45, width: 390, height: 485, transform: `translateY(${Math.sin(frame / 18) * 4}px)` }}><Img src={staticFile('assets/wolfie/characters/wolfie-coach/wolfie-v2-listening.07cf0629cc2d.webp')} style={{ width: '100%', height: '100%', objectFit: 'contain', filter: `drop-shadow(0 30px 44px rgba(0,0,0,0.5)) drop-shadow(0 0 35px ${accent}34)` }} /></div>
    <div style={{ position: 'absolute', right: 20, top: 74, width: 260, ...panelStyle(), padding: 14 }}><div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}><b style={{ fontSize: 10 }}>Feedback</b><span style={{ color: accent, fontSize: 13, fontWeight: 900 }}>84</span></div>{[['Pronúncia', 88], ['Fluência', 79], ['Vocabulário', 86]].map(([label, value], index) => <div key={String(label)} style={{ marginTop: 12 }}><div style={{ display: 'flex', justifyContent: 'space-between', color: brand.muted, fontSize: 7 }}><span>{label}</span><span>{value}</span></div><div style={{ height: 4, marginTop: 5, borderRadius: 999, background: 'rgba(255,255,255,0.06)' }}><div style={{ width: `${Number(value)}%`, height: '100%', borderRadius: 999, background: index === 0 ? '#5de1cf' : accent }} /></div></div>)}</div>
  </div>
);

// A escola que trabalha sozinha. Todas as rotinas listadas aqui existem de fato
// como cron no produto — lembrete de aula, confirmação de presença, aniversário,
// agenda do professor e aviso de vencimento. Nada aqui é promessa de roadmap.
const AutomationRow: React.FC<{
  label: string;
  detail: string;
  icon: LucideIcon;
  color: string;
  frame: number;
  index: number;
}> = ({ label, detail, icon: Icon, color, frame, index }) => {
  const reveal = clampProgress(frame, 200 + index * 7, 214 + index * 7);
  const done = clampProgress(frame, 224 + index * 7, 236 + index * 7);
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '28px 1fr 18px',
        alignItems: 'center',
        gap: 9,
        borderRadius: 10,
        border: `1px solid ${done > 0.5 ? `${color}3d` : UI_LINE}`,
        background: done > 0.5 ? `${color}0e` : 'rgba(255,255,255,0.024)',
        padding: '8px 9px',
        opacity: reveal,
        transform: `translateX(${(1 - reveal) * 18}px)`,
      }}
    >
      <span style={{ display: 'grid', width: 26, height: 26, placeItems: 'center', borderRadius: 8, background: `${color}1e`, color }}><Icon size={12} /></span>
      <div style={{ minWidth: 0 }}>
        <b style={{ display: 'block', fontSize: 8.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</b>
        <small style={{ display: 'block', marginTop: 2, color: brand.muted, fontSize: 6.5 }}>{detail}</small>
      </div>
      <span
        style={{
          display: 'grid',
          width: 17,
          height: 17,
          placeItems: 'center',
          borderRadius: '50%',
          background: `${color}${done > 0.5 ? '2c' : '10'}`,
          color,
          opacity: 0.35 + done * 0.65,
          transform: `scale(${0.7 + done * 0.3})`,
        }}
      >
        <Check size={10} />
      </span>
    </div>
  );
};

const EcosystemSchoolPanel: React.FC<{ accent: string; frame: number }> = ({ accent, frame }) => (
  <div style={{ height: '100%', background: '#0d1016', padding: 17, boxSizing: 'border-box' }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}><div><small style={{ color: accent, fontSize: 7, fontWeight: 900 }}>SCHOOL OS · TENANT DEMO</small><h3 style={{ margin: '6px 0 0', fontFamily: displayFontFamily, fontSize: 18 }}>A escola opera sozinha</h3></div><span style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#80e6c0', fontSize: 7, fontWeight: 850 }}><ShieldCheck size={11} /> ambiente isolado</span></div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginTop: 12 }}>{[{ label: 'Receita', value: 'R$ 18,4k', icon: CircleDollarSign, color: '#4fd1a5' }, { label: 'Leads', value: '12', icon: Users, color: '#b89cff' }, { label: 'Aulas', value: '36', icon: Clock3, color: '#67b7ff' }, { label: 'Renovações', value: '8', icon: RefreshCw, color: '#ffad70' }].map((metric, index) => <MiniMetric key={metric.label} {...metric} progress={clampProgress(frame, 194 + index * 4, 207 + index * 4)} />)}</div>
    <div style={{ display: 'grid', gridTemplateColumns: '0.86fr 1.05fr 0.86fr', gap: 9, marginTop: 10 }}>
      <div style={{ ...panelStyle(), padding: 12 }}><div style={{ display: 'flex', justifyContent: 'space-between' }}><b style={{ fontSize: 9 }}>Fluxo financeiro</b><BarChart3 size={13} color={accent} /></div><DemoChart accent={accent} frame={Math.max(0, frame - 186)} /></div>

      <div style={{ ...panelStyle('#4fd1a5'), padding: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <b style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 9 }}><Zap size={12} color="#4fd1a5" /> Automações no WhatsApp</b>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#80e6c0', fontSize: 6.5, fontWeight: 850 }}><span style={{ width: 5, height: 5, borderRadius: '50%', background: '#4fd1a5', boxShadow: '0 0 9px #4fd1a5' }} />rodando</span>
        </div>
        <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
          <AutomationRow label="Lembrete de aula" detail="30 min antes · por professor" icon={Clock3} color="#67b7ff" frame={frame} index={0} />
          <AutomationRow label="Confirmação de presença" detail="o aluno confirma que a aula houve" icon={FileCheck2} color="#4fd1a5" frame={frame} index={1} />
          <AutomationRow label="Agenda do dia" detail="enviada ao professor pela manhã" icon={LayoutDashboard} color="#b89cff" frame={frame} index={2} />
          <AutomationRow label="Follow-up de experimental" detail="dois dias depois, sem matrícula" icon={MessageCircle} color="#ffad70" frame={frame} index={3} />
          <AutomationRow label="Aviso de vencimento" detail="três dias antes da mensalidade" icon={CircleDollarSign} color={accent} frame={frame} index={4} />
        </div>
      </div>

      <div style={{ ...panelStyle(), padding: 12 }}><b style={{ fontSize: 9 }}>Pipeline comercial</b><div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginTop: 11 }}>{[['Novos', '#67b7ff'], ['Experim.', '#ffad70'], ['Matríc.', '#4fd1a5']].map(([label, color], columnIndex) => <div key={label} style={{ minHeight: 172, borderRadius: 10, background: 'rgba(255,255,255,0.028)', padding: 7 }}><span style={{ color, fontSize: 6.5, fontWeight: 900 }}>{label}</span>{[0, 1].slice(0, columnIndex === 2 ? 1 : 2).map((card) => <span key={card} style={{ display: 'block', height: 40, marginTop: 7, border: `1px solid ${UI_LINE}`, borderRadius: 8, background: `${color}0c` }} />)}</div>)}</div></div>
    </div>
  </div>
);

const EcosystemTour: React.FC<ProductTourProps> = ({ content, mode }) => {
  const frame = useCurrentFrame();
  const milestones = [0, 62, 124, 186];
  const items = [
    { title: 'Ensinar', detail: 'Biblioteca, livros e ebooks', icon: Library, color: '#d66a45' },
    { title: 'Planejar', detail: 'Educador IA com contexto', icon: WandSparkles, color: '#7652ed' },
    { title: 'Engajar', detail: 'Prática real com Wolfie', icon: Bot, color: '#20a9cc' },
    { title: 'Operar', detail: 'School OS automatizado', icon: LayoutDashboard, color: '#258e79' },
  ];
  const isProof = mode === 'proof';
  const activeIndex = frame < 62 ? 0 : frame < 124 ? 1 : frame < 186 ? 2 : 3;
  const cursorSteps: CursorStep[] = [
    { at: 0, x: 120, y: 164 },
    { at: 12, x: 124, y: 164, click: true },
    { at: 62, x: 124, y: 270, click: true },
    { at: 124, x: 124, y: 376, click: true },
    { at: 186, x: 124, y: 482, click: true },
    { at: 244, x: 1180, y: 586 },
    { at: 282, x: 1430, y: 106 },
  ];
  const panelOpacity = (index: number) => {
    const start = milestones[index];
    const end = index === items.length - 1 ? 1000 : milestones[index + 1];
    if (index === 0) return 1 - clampProgress(frame, end - 10, end + 4);
    return crossfade(frame, start - 10, end - 10, 14);
  };
  const panelOpacities = items.map((_, index) => panelOpacity(index));

  return (
    <TourShell accent={content.accent} title="Wise Wolf Hub · ecossistema" status={mode === 'proof' ? 'conta, papel e ambiente' : 'quatro soluções conectadas'} backdrop="assets/hub/videos/backdrops/digital-studio-v1.png">
      <div style={{ display: 'grid', gridTemplateColumns: '255px 1fr', height: '100%' }}>
        <aside style={{ borderRight: `1px solid ${UI_LINE}`, background: 'rgba(7,9,13,0.76)', padding: '22px 15px', boxSizing: 'border-box' }}>
          <div style={{ padding: '0 10px 14px' }}><small style={{ color: content.accent, fontSize: 7, fontWeight: 900, letterSpacing: '0.13em' }}>SUA JORNADA</small><h2 style={{ margin: '6px 0 0', fontFamily: displayFontFamily, fontSize: 19 }}>Um próximo passo claro</h2></div>
          <div style={{ display: 'grid', gap: 9 }}>
            {items.map(({ title, detail, icon: Icon, color }, index) => {
              const active = activeIndex === index;
              return (
                <div key={title} style={{ position: 'relative', display: 'grid', gridTemplateColumns: '42px 1fr', alignItems: 'center', gap: 10, minHeight: 87, overflow: 'hidden', border: `1px solid ${active ? `${color}66` : UI_LINE}`, borderRadius: 16, background: active ? `${color}16` : 'rgba(255,255,255,0.025)', padding: '10px 11px', boxSizing: 'border-box', boxShadow: active ? `0 18px 42px rgba(0,0,0,0.3), inset 0 0 30px ${color}0f` : undefined, transform: `translateX(${active ? 5 : 0}px) scale(${active ? 1.015 : 1})` }}>
                  <span style={{ display: 'grid', width: 39, height: 39, placeItems: 'center', borderRadius: 12, background: `${color}1e`, color }}><Icon size={18} /></span><div><b style={{ display: 'block', fontFamily: displayFontFamily, fontSize: 13 }}>{title}</b><small style={{ display: 'block', marginTop: 4, color: brand.muted, fontSize: 7, lineHeight: 1.35 }}>{detail}</small></div>{active && <span style={{ position: 'absolute', left: 0, top: 18, bottom: 18, width: 3, borderRadius: 999, background: color, boxShadow: `0 0 14px ${color}` }} />}
                </div>
              );
            })}
          </div>
        </aside>
        <main style={{ position: 'relative', minWidth: 0, padding: '21px 24px 18px', boxSizing: 'border-box' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}><div><small style={{ color: isProof ? '#4fd1a5' : items[activeIndex].color, fontSize: 8, fontWeight: 900, letterSpacing: '0.12em' }}>{isProof ? 'CONTA, PAPEL E AMBIENTE' : `${items[activeIndex].title.toUpperCase()} EM MOVIMENTO`}</small><h2 style={{ margin: '6px 0 0', fontFamily: displayFontFamily, fontSize: 23 }}>{isProof ? 'Cada acesso passa pela mesma verificação' : items[activeIndex].detail}</h2></div><div style={{ display: 'flex', gap: 6 }}>{items.map((item, index) => <span key={item.title} style={{ width: !isProof && activeIndex === index ? 32 : 8, height: 8, borderRadius: 999, background: isProof ? '#4fd1a566' : activeIndex === index ? item.color : 'rgba(255,255,255,0.12)', boxShadow: !isProof && activeIndex === index ? `0 0 16px ${item.color}` : undefined }} />)}</div></div>
          <div style={{ position: 'relative', height: 491, marginTop: 14, overflow: 'hidden', border: `1px solid ${isProof ? '#4fd1a5' : items[activeIndex].color}44`, borderRadius: 23, background: '#0d1016', boxShadow: `0 28px 70px rgba(0,0,0,0.42), 0 0 44px ${isProof ? '#4fd1a5' : items[activeIndex].color}14` }}>
            {isProof && <div style={{ position: 'absolute', inset: 0, background: '#0d1016' }}><SecuritySettingsView accent="#4fd1a5" frame={frame} startFrame={4} /></div>}
            {!isProof && panelOpacities[0] > 0.001 && <div style={{ position: 'absolute', inset: 0, opacity: panelOpacities[0], transform: `translateX(${(1 - panelOpacities[0]) * -32}px) scale(${0.985 + panelOpacities[0] * 0.015})` }}><EcosystemLibraryPanel accent={items[0].color} frame={frame} /></div>}
            {!isProof && panelOpacities[1] > 0.001 && <div style={{ position: 'absolute', inset: 0, opacity: panelOpacities[1], transform: `translateX(${(1 - panelOpacities[1]) * 38}px) scale(${0.985 + panelOpacities[1] * 0.015})` }}><EcosystemEducatorPanel accent={items[1].color} frame={frame} /></div>}
            {!isProof && panelOpacities[2] > 0.001 && <div style={{ position: 'absolute', inset: 0, opacity: panelOpacities[2], transform: `translateX(${(1 - panelOpacities[2]) * 38}px) scale(${0.985 + panelOpacities[2] * 0.015})` }}><EcosystemWolfiePanel accent={items[2].color} frame={frame} /></div>}
            {!isProof && panelOpacities[3] > 0.001 && <div style={{ position: 'absolute', inset: 0, opacity: panelOpacities[3], transform: `translateX(${(1 - panelOpacities[3]) * 38}px) scale(${0.985 + panelOpacities[3] * 0.015})` }}><EcosystemSchoolPanel accent={items[3].color} frame={frame} /></div>}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr auto 1fr', alignItems: 'center', gap: 9, marginTop: 13, color: brand.muted, fontSize: 8, fontWeight: 750 }}><span style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Target size={11} color={items[1].color} /> Contexto pedagógico</span><ArrowRight size={11} color={brand.muted} /><span style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Bot size={11} color={items[2].color} /> Prática entre aulas</span><ArrowRight size={11} color={brand.muted} /><span style={{ display: 'flex', alignItems: 'center', gap: 7 }}><Workflow size={11} color={items[3].color} /> Continuidade operacional</span></div>
          {mode === 'proof' && <div style={{ position: 'absolute', left: 188, right: 188, bottom: 16, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 14, border: `1px solid ${content.accent}4c`, borderRadius: 999, background: 'rgba(7,9,13,0.96)', boxShadow: '0 18px 42px rgba(0,0,0,0.45)', color: brand.inkSoft, padding: '10px 15px', fontSize: 8, fontWeight: 800, opacity: clampProgress(frame, 205, 224), transform: `translateY(${(1 - clampProgress(frame, 205, 224)) * 18}px)` }}><ShieldCheck size={13} color={content.accent} /> Uma identidade <span style={{ width: 3, height: 3, borderRadius: '50%', background: brand.muted }} /> papéis por função <span style={{ width: 3, height: 3, borderRadius: '50%', background: brand.muted }} /> dados isolados por ambiente</div>}
        </main>
      </div>
      <TourCursor steps={cursorSteps} accent={content.accent} label={mode === 'proof' ? 'fluxo integrado' : undefined} />
    </TourShell>
  );
};

export const ProductTour: React.FC<ProductTourProps> = ({ content, mode }) => {
  if (content.mockup === 'library') return <LibraryTour content={content} mode={mode} />;
  if (content.mockup === 'educator') return <EducatorTour content={content} mode={mode} />;
  if (content.mockup === 'wolfie') return <WolfieTour content={content} mode={mode} />;
  if (content.mockup === 'school') return <SchoolTour content={content} mode={mode} />;
  return <EcosystemTour content={content} mode={mode} />;
};

export const ProductTours = ProductTour;

export default ProductTour;
