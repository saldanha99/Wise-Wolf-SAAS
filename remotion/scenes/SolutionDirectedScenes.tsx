import React from 'react';
import {
  ArrowRight,
  CalendarDays,
  Check,
  ChevronRight,
  CircleCheck,
  GraduationCap,
  LockKeyhole,
  Mic2,
  Route,
  Search,
  ShieldCheck,
  Users,
} from 'lucide-react';
import {
  AbsoluteFill,
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
import { LogoLockup } from '../components/LogoLockup';
import { ProductTour } from '../components/ProductTours';
import type { HubVideoContent, HubVideoSceneId, HubVideoSlug } from '../types';

type DirectedSceneProps = {
  content: HubVideoContent;
  scene: HubVideoSceneId;
  sceneDurationInFrames: number;
};

const GENERATED_IMAGES: Record<HubVideoSlug, string> = {
  'hub-overview': 'hub-corridor.png',
  library: 'library-curation.png',
  'educator-ai': 'educator-structure.png',
  wolfie: 'wolfie-real-world.png',
  'school-os': 'school-living-system.png',
};

const enter = (frame: number, start = 0, duration = 18) => interpolate(
  frame,
  [start, start + duration],
  [0, 1],
  {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  },
);

const exit = (frame: number, duration: number, length = 12) => interpolate(
  frame,
  [Math.max(0, duration - length), duration],
  [1, 0],
  {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.in(Easing.cubic),
  },
);

const Header: React.FC<{ content: HubVideoContent; label?: string; dark?: boolean }> = ({ content, label, dark = true }) => {
  const frame = useCurrentFrame();
  const reveal = enter(frame, 0, 14);
  return (
    <div style={{ position: 'absolute', zIndex: 30, left: 74, right: 74, top: 54, display: 'flex', alignItems: 'center', justifyContent: 'space-between', opacity: reveal, translate: `0 ${(1 - reveal) * -18}px` }}>
      <LogoLockup compact />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, border: `1px solid ${dark ? 'rgba(255,255,255,0.16)' : `${content.accent}42`}`, borderRadius: 999, background: dark ? 'rgba(4,5,8,0.64)' : `${content.accent}12`, boxShadow: `0 12px 38px rgba(0,0,0,0.2), 0 0 30px ${content.accent}16`, color: '#fff', padding: '10px 15px', fontFamily: bodyFontFamily, fontSize: 12, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', backdropFilter: 'blur(18px)' }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: content.accent, boxShadow: `0 0 16px ${content.accent}` }} />
        {label ?? content.productName}
      </div>
    </div>
  );
};

const Eyebrow: React.FC<{ content: HubVideoContent; children: React.ReactNode }> = ({ content, children }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: '#fff', fontFamily: bodyFontFamily, fontSize: 13, fontWeight: 850, letterSpacing: '0.14em', textTransform: 'uppercase' }}>
    <span style={{ width: 38, height: 3, borderRadius: 999, background: content.accent, boxShadow: `0 0 18px ${content.accent}` }} />
    {children}
  </div>
);

const GeneratedImage: React.FC<{
  content: HubVideoContent;
  shade?: string;
  objectPosition?: string;
  scaleFrom?: number;
  scaleTo?: number;
}> = ({ content, shade = 'linear-gradient(90deg, rgba(5,6,9,0.92), rgba(5,6,9,0.24) 55%, rgba(5,6,9,0.7))', objectPosition = 'center', scaleFrom = 1.035, scaleTo = 1.095 }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  return (
    <AbsoluteFill style={{ overflow: 'hidden', background: brand.background }}>
      <Img
        src={staticFile(`assets/hub/videos/generated-v2/${GENERATED_IMAGES[content.slug]}`)}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          objectPosition,
          scale: interpolate(frame, [0, durationInFrames], [scaleFrom, scaleTo], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
          translate: `${Math.sin(frame / 44) * 8}px ${Math.cos(frame / 53) * 5}px`,
          filter: 'saturate(0.9) contrast(1.08)',
        }}
      />
      <AbsoluteFill style={{ background: shade }} />
      <AbsoluteFill style={{ opacity: 0.22, background: `radial-gradient(circle at ${32 + Math.sin(frame / 35) * 8}% 48%, ${content.accent}85, transparent 34%)`, mixBlendMode: 'screen' }} />
      <AbsoluteFill style={{ opacity: 0.09, backgroundImage: 'radial-gradient(rgba(255,255,255,0.8) 0.7px, transparent 0.8px)', backgroundSize: '5px 5px', backgroundPosition: `${frame % 5}px ${(frame * 0.7) % 5}px`, mixBlendMode: 'soft-light' }} />
    </AbsoluteFill>
  );
};

const HeroTitle: React.FC<{
  content: HubVideoContent;
  align?: 'left' | 'right' | 'center';
  top?: number;
  width?: number;
  compact?: boolean;
}> = ({ content, align = 'left', top = 230, width = 1080, compact = false }) => {
  const frame = useCurrentFrame();
  const titleReveal = spring({ frame: frame - 3, fps: 30, config: { damping: 18, stiffness: 96, mass: 0.9 } });
  const emphasisReveal = spring({ frame: frame - 12, fps: 30, config: { damping: 17, stiffness: 108 } });
  const left = align === 'left' ? 112 : align === 'center' ? '50%' : undefined;
  const right = align === 'right' ? 112 : undefined;
  return (
    <div style={{ position: 'absolute', zIndex: 10, left, right, top, width, textAlign: align, translate: align === 'center' ? '-50% 0' : undefined }}>
      <div style={{ display: 'flex', justifyContent: align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start', opacity: titleReveal }}><Eyebrow content={content}>{content.eyebrow}</Eyebrow></div>
      <h1 style={{ margin: '24px 0 0', color: '#fff', fontFamily: displayFontFamily, fontSize: compact ? 84 : 106, fontWeight: 650, lineHeight: 0.91, letterSpacing: '-0.068em', opacity: titleReveal, translate: `${(1 - titleReveal) * (align === 'right' ? 58 : -58)}px ${(1 - titleReveal) * 28}px` }}>
        {content.title}
        <span style={{ display: 'block', marginTop: 12, color: content.accent, textShadow: `0 0 42px ${content.accent}38`, opacity: emphasisReveal, translate: `0 ${(1 - emphasisReveal) * 34}px` }}>{content.emphasis}</span>
      </h1>
    </div>
  );
};

const TourStage: React.FC<{
  content: HubVideoContent;
  mode: 'product' | 'proof';
  top?: number;
  scale?: number;
  rotate?: number;
  mask?: string;
  glow?: string;
}> = ({ content, mode, top = 144, scale: baseScale = 0.96, rotate: baseRotate = 0, mask, glow }) => {
  const frame = useCurrentFrame();
  const reveal = spring({ frame: frame - 4, fps: 30, config: { damping: 19, stiffness: 98, mass: 0.9 } });
  const scale = baseScale * (0.94 + reveal * 0.06) * interpolate(frame, [0, 220], [0.985, 1.035], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <div style={{ position: 'absolute', zIndex: 10, left: '50%', top, width: 1600, height: 720, overflow: 'hidden', borderRadius: 34, boxShadow: glow ?? `0 54px 150px rgba(0,0,0,0.68), 0 0 90px ${content.accent}28`, opacity: reveal, translate: `-50% ${(1 - reveal) * 52 + Math.sin(frame / 38) * 5}px`, scale, rotate: `${baseRotate + Math.sin(frame / 84) * 0.15}deg`, clipPath: mask, transformOrigin: '50% 20%' }}>
      <ProductTour content={content} mode={mode} />
    </div>
  );
};

const CtaButton: React.FC<{ content: HubVideoContent; label: string; secondary?: boolean }> = ({ content, label, secondary = false }) => {
  const frame = useCurrentFrame();
  const pulse = 1 + Math.sin(frame / 12) * 0.012;
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 14, minWidth: 280, border: `1px solid ${secondary ? 'rgba(255,255,255,0.22)' : `${content.accent}99`}`, borderRadius: 999, background: secondary ? 'rgba(255,255,255,0.065)' : `linear-gradient(135deg, ${content.accent}, ${content.secondaryAccent})`, boxShadow: secondary ? 'none' : `0 26px 70px ${content.accent}42`, color: '#fff', padding: '18px 26px', fontFamily: bodyFontFamily, fontSize: 18, fontWeight: 850, scale: pulse }}>
      {label}<ArrowRight size={22} />
    </div>
  );
};

const SceneTitle: React.FC<{ content: HubVideoContent; eyebrow: string; title: string; x?: number; y?: number; width?: number }> = ({ content, eyebrow, title, x = 104, y = 148, width = 720 }) => {
  const frame = useCurrentFrame();
  const reveal = spring({ frame, fps: 30, config: { damping: 19, stiffness: 100 } });
  return (
    <div style={{ position: 'absolute', zIndex: 22, left: x, top: y, width, opacity: reveal, translate: `${(1 - reveal) * -42}px 0` }}>
      <Eyebrow content={content}>{eyebrow}</Eyebrow>
      <h2 style={{ margin: '20px 0 0', color: '#fff', fontFamily: displayFontFamily, fontSize: 72, fontWeight: 640, lineHeight: 0.96, letterSpacing: '-0.058em' }}>{title}</h2>
    </div>
  );
};

const OverviewDirector: React.FC<DirectedSceneProps> = ({ content, scene, sceneDurationInFrames }) => {
  const frame = useCurrentFrame();
  const sceneExit = exit(frame, sceneDurationInFrames);
  const colors = ['#ff785f', '#7652ed', '#20a9cc', '#258e79'];

  if (scene === 'hook') {
    return (
      <AbsoluteFill style={{ opacity: sceneExit }}>
        <GeneratedImage content={content} shade="linear-gradient(90deg, rgba(4,5,8,0.9), rgba(4,5,8,0.2) 62%, rgba(4,5,8,0.54))" scaleFrom={1.02} scaleTo={1.09} />
        <Header content={content} label="Ecossistema conectado" />
        <HeroTitle content={content} top={210} width={1020} />
        <div style={{ position: 'absolute', zIndex: 8, left: 92, right: 92, bottom: 270, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          {['Ensinar', 'Planejar', 'Engajar', 'Operar'].map((label, index) => {
            const reveal = enter(frame, 22 + index * 5, 14);
            return <div key={label} style={{ height: 8, borderRadius: 999, background: colors[index], boxShadow: `0 0 24px ${colors[index]}`, opacity: reveal * 0.8, scale: `${reveal} 1`, transformOrigin: '0 50%' }} />;
          })}
        </div>
      </AbsoluteFill>
    );
  }

  if (scene === 'problem') {
    return (
      <AbsoluteFill style={{ overflow: 'hidden', opacity: sceneExit }}>
        <GeneratedImage content={content} shade="linear-gradient(90deg, rgba(5,6,9,0.96), rgba(5,6,9,0.56), rgba(5,6,9,0.88))" scaleFrom={1.09} scaleTo={1.035} />
        <Header content={content} label="Antes: ferramentas soltas" />
        <SceneTitle content={content} eyebrow="O problema não é falta de ferramenta" title={content.problemHeadline} width={770} y={176} />
        <div style={{ position: 'absolute', zIndex: 12, right: 90, top: 180, width: 780, height: 470 }}>
          {content.problemItems.map((item, index) => {
            const reveal = spring({ frame: frame - 8 - index * 7, fps: 30, config: { damping: 16, stiffness: 115 } });
            const angle = [-5, 2, -1][index];
            return (
              <div key={item} style={{ position: 'absolute', left: 90 + index * 58, top: 52 + index * 126, width: 620, display: 'grid', gridTemplateColumns: '64px 1fr auto', alignItems: 'center', gap: 18, border: '1px solid rgba(255,255,255,0.16)', borderRadius: 24, background: 'rgba(8,9,13,0.82)', boxShadow: `0 24px 70px rgba(0,0,0,0.46), 0 0 36px ${colors[index]}18`, padding: '20px 22px', opacity: reveal, translate: `${(1 - reveal) * 190}px ${(1 - reveal) * -26}px`, rotate: `${angle * (1 - reveal)}deg`, backdropFilter: 'blur(20px)' }}>
                <span style={{ display: 'grid', width: 54, height: 54, placeItems: 'center', borderRadius: 18, background: `${colors[index]}1c`, color: colors[index], fontFamily: displayFontFamily, fontSize: 16, fontWeight: 850 }}>0{index + 1}</span>
                <strong style={{ color: '#fff', fontFamily: displayFontFamily, fontSize: 27, fontWeight: 620, letterSpacing: '-0.035em' }}>{item}</strong>
                <Route size={24} color={colors[index]} />
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
    );
  }

  if (scene === 'product') {
    const active = Math.min(3, Math.floor(frame / 62));
    return (
      <AbsoluteFill style={{ overflow: 'hidden', opacity: sceneExit }}>
        <GeneratedImage content={content} shade="linear-gradient(rgba(5,6,9,0.78), rgba(5,6,9,0.96))" scaleFrom={1.04} scaleTo={1.11} />
        <Header content={content} label="Uma câmera. Quatro frentes." />
        <div style={{ position: 'absolute', zIndex: 20, left: 54, top: 174, display: 'grid', gap: 10 }}>
          {['Biblioteca', 'Educador IA', 'Wolfie', 'School OS'].map((label, index) => <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 10, width: 188, border: `1px solid ${active === index ? `${colors[index]}88` : 'rgba(255,255,255,0.11)'}`, borderRadius: 16, background: active === index ? `${colors[index]}22` : 'rgba(5,6,9,0.72)', color: active === index ? '#fff' : 'rgba(255,255,255,0.55)', padding: '13px 14px', fontFamily: bodyFontFamily, fontSize: 12, fontWeight: 800, scale: active === index ? 1.05 : 1 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: colors[index], boxShadow: active === index ? `0 0 18px ${colors[index]}` : undefined }} />{label}</div>)}
        </div>
        <TourStage content={content} mode="product" top={148} scale={0.89} />
        <div style={{ position: 'absolute', zIndex: 5, left: 260, right: 110, top: 510, height: 2, background: `linear-gradient(90deg, ${colors[0]}, ${colors[1]}, ${colors[2]}, ${colors[3]})`, boxShadow: `0 0 24px ${content.accent}` }} />
      </AbsoluteFill>
    );
  }

  if (scene === 'proof') {
    return (
      <AbsoluteFill style={{ overflow: 'hidden', opacity: sceneExit }}>
        <Header content={content} label="Isolamento por ambiente" />
        <SceneTitle content={content} eyebrow="Clareza na frente. Segurança por trás." title={content.proofHeadline} width={760} y={142} />
        <TourStage content={content} mode="proof" top={164} scale={0.87} glow={`0 46px 130px rgba(0,0,0,0.72), 0 0 90px ${content.secondaryAccent}25`} />
        <div style={{ position: 'absolute', zIndex: 18, right: 70, top: 170, display: 'grid', gap: 10 }}>
          {['Escola Aurora', 'Professor independente', 'Escola Horizonte'].map((label, index) => {
            const reveal = enter(frame, 18 + index * 8, 14);
            return <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 10, width: 260, border: `1px solid ${colors[index]}55`, borderRadius: 18, background: 'rgba(4,5,8,0.88)', color: '#fff', padding: '13px 15px', fontFamily: bodyFontFamily, fontSize: 11, fontWeight: 800, opacity: reveal, translate: `${(1 - reveal) * 50}px 0` }}><LockKeyhole size={16} color={colors[index]} />{label}</div>;
          })}
        </div>
      </AbsoluteFill>
    );
  }

  const reveal = spring({ frame: frame - 3, fps: 30, config: { damping: 18, stiffness: 100 } });
  return (
    <AbsoluteFill style={{ overflow: 'hidden', background: brand.background, opacity: sceneExit }}>
      <GeneratedImage content={content} shade="linear-gradient(90deg, rgba(4,5,8,0.9), rgba(4,5,8,0.42), rgba(4,5,8,0.9))" scaleFrom={1.07} scaleTo={1.02} />
      <Header content={content} label="Escolha seu ponto de entrada" />
      <div style={{ position: 'absolute', left: 165, right: 165, top: 212, textAlign: 'center', opacity: reveal, translate: `0 ${(1 - reveal) * 30}px` }}>
        <Eyebrow content={content}>Wise Wolf Hub</Eyebrow>
        <h2 style={{ margin: '20px 0 0', color: '#fff', fontFamily: displayFontFamily, fontSize: 88, fontWeight: 650, letterSpacing: '-0.065em' }}>{content.cta}</h2>
        <p style={{ margin: '15px 0 0', color: brand.inkSoft, fontFamily: bodyFontFamily, fontSize: 22 }}>{content.ctaSupport}</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 22, marginTop: 40 }}>
          {content.ctaButtons.map((label, index) => <div key={label} style={{ position: 'relative', overflow: 'hidden', border: `1px solid ${colors[index * 3]}66`, borderRadius: 30, background: `linear-gradient(135deg, ${colors[index * 3]}2b, rgba(6,7,10,0.86))`, padding: '34px 36px', textAlign: 'left', boxShadow: `0 30px 90px rgba(0,0,0,0.38), 0 0 48px ${colors[index * 3]}18` }}><div style={{ color: '#fff', fontFamily: displayFontFamily, fontSize: 34, fontWeight: 680 }}>{label}</div><div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 15, color: colors[index * 3], fontFamily: bodyFontFamily, fontSize: 13, fontWeight: 850 }}>Abrir esta jornada <ArrowRight size={16} /></div></div>)}
        </div>
      </div>
    </AbsoluteFill>
  );
};

const LibraryDirector: React.FC<DirectedSceneProps> = ({ content, scene, sceneDurationInFrames }) => {
  const frame = useCurrentFrame();
  const sceneExit = exit(frame, sceneDurationInFrames);
  const paperTone = '#f0dfc7';

  if (scene === 'hook') return (
    <AbsoluteFill style={{ opacity: sceneExit }}>
      <GeneratedImage content={content} shade="linear-gradient(90deg, rgba(6,5,5,0.8), rgba(6,5,5,0.2) 54%, rgba(6,5,5,0.78))" objectPosition="center" scaleFrom={1.02} scaleTo={1.08} />
      <Header content={content} label="Curadoria em movimento" />
      <HeroTitle content={content} align="right" top={194} width={1050} compact />
      {[0, 1, 2, 3].map((index) => {
        const reveal = enter(frame, 8 + index * 4, 15);
        return <div key={index} style={{ position: 'absolute', zIndex: 8, left: 90 + index * 78, bottom: 250 + index * 18, width: 230, height: 150, border: '1px solid rgba(255,255,255,0.18)', borderRadius: 8, background: index === 3 ? `${content.accent}32` : 'rgba(239,223,200,0.12)', boxShadow: '0 22px 60px rgba(0,0,0,0.42)', opacity: reveal * 0.8, translate: `${(1 - reveal) * -180}px ${(1 - reveal) * 70}px`, rotate: `${-11 + index * 5}deg` }} />;
      })}
    </AbsoluteFill>
  );

  if (scene === 'problem') return (
    <AbsoluteFill style={{ overflow: 'hidden', background: '#0b0908', opacity: sceneExit }}>
      <GeneratedImage content={content} shade="linear-gradient(90deg, rgba(9,7,6,0.72), rgba(9,7,6,0.32), rgba(9,7,6,0.9))" scaleFrom={1.08} scaleTo={1.035} />
      <Header content={content} label="Do ruído à seleção" />
      <SceneTitle content={content} eyebrow="A preparação começa antes da aula" title={content.problemHeadline} width={780} y={156} />
      <div style={{ position: 'absolute', right: 90, top: 184, width: 720, height: 480 }}>
        {content.problemItems.map((item, index) => {
          const reveal = spring({ frame: frame - 7 - index * 8, fps: 30, config: { damping: 14, stiffness: 110 } });
          return <div key={item} style={{ position: 'absolute', right: 34 + index * 32, top: 42 + index * 122, width: 590, height: 100, display: 'flex', alignItems: 'center', gap: 22, border: '1px solid rgba(255,255,255,0.16)', borderRadius: 10, background: index === 2 ? `linear-gradient(90deg, ${content.accent}22, rgba(20,16,14,0.9))` : 'rgba(22,18,16,0.87)', color: '#fff', boxShadow: '0 20px 48px rgba(0,0,0,0.4)', padding: '0 28px', opacity: reveal, translate: `${(1 - reveal) * 120}px ${(1 - reveal) * -40}px`, rotate: `${(2 - index * 2) * (1 - reveal)}deg` }}><span style={{ color: content.accent, fontFamily: displayFontFamily, fontSize: 18, fontWeight: 850 }}>0{index + 1}</span><strong style={{ fontFamily: displayFontFamily, fontSize: 26, fontWeight: 620 }}>{item}</strong></div>;
        })}
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 244, height: 2, background: `linear-gradient(90deg, transparent, ${content.accent}, transparent)`, scale: `${enter(frame, 24, 28)} 1` }} />
    </AbsoluteFill>
  );

  if (scene === 'product') return (
    <AbsoluteFill style={{ overflow: 'hidden', background: '#0b0908', opacity: sceneExit }}>
      <Header content={content} label="Buscar → filtrar → abrir" />
      <div style={{ position: 'absolute', inset: 0, opacity: 0.36, background: 'linear-gradient(115deg, rgba(214,106,69,0.2), transparent 40%), repeating-linear-gradient(90deg, rgba(255,255,255,0.025) 0 1px, transparent 1px 96px)' }} />
      {[0, 1, 2].map((index) => <div key={index} style={{ position: 'absolute', left: 92 + index * 34, top: 176 + index * 20, width: 1520, height: 668, border: `1px solid rgba(240,223,199,${0.08 + index * 0.035})`, borderRadius: 28, background: index === 2 ? 'transparent' : 'rgba(240,223,199,0.035)', rotate: `${-3 + index * 1.5}deg`, boxShadow: index === 0 ? '0 40px 100px rgba(0,0,0,0.48)' : undefined }} />)}
      <TourStage content={content} mode="product" top={148} scale={0.91} rotate={-0.35} glow={`0 52px 150px rgba(0,0,0,0.72), 0 0 80px ${content.accent}24`} />
      <div style={{ position: 'absolute', zIndex: 18, right: 82, top: 142, display: 'flex', alignItems: 'center', gap: 10, border: `1px solid ${content.accent}66`, borderRadius: 999, background: 'rgba(12,9,8,0.9)', color: paperTone, padding: '11px 16px', fontFamily: bodyFontFamily, fontSize: 11, fontWeight: 850 }}><Search size={16} color={content.accent} /> contexto encontrado</div>
    </AbsoluteFill>
  );

  if (scene === 'proof') return (
    <AbsoluteFill style={{ overflow: 'hidden', background: '#0b0908', opacity: sceneExit }}>
      <Header content={content} label="Prévia antes do arquivo" />
      <TourStage content={content} mode="proof" top={146} scale={0.91} rotate={0.28} />
      <div style={{ position: 'absolute', zIndex: 20, left: 90, top: 174, display: 'grid', gap: 10 }}>
        {content.proofItems.map((item, index) => {
          const reveal = enter(frame, 12 + index * 6, 12);
          return <div key={item} style={{ display: 'flex', alignItems: 'center', gap: 9, border: `1px solid ${content.accent}44`, borderRadius: 999, background: 'rgba(11,8,7,0.88)', color: '#fff', padding: '10px 14px', fontFamily: bodyFontFamily, fontSize: 10, fontWeight: 800, opacity: reveal, translate: `${(1 - reveal) * -40}px 0` }}><CircleCheck size={14} color={content.accent} />{item}</div>;
        })}
      </div>
      <div style={{ position: 'absolute', zIndex: 22, right: 86, top: 176, display: 'grid', width: 134, height: 134, placeItems: 'center', border: `2px solid ${content.accent}88`, borderRadius: '50%', background: 'rgba(15,10,8,0.78)', boxShadow: `0 0 44px ${content.accent}32`, color: content.accent, fontFamily: bodyFontFamily, fontSize: 11, fontWeight: 900, letterSpacing: '0.08em', textAlign: 'center', textTransform: 'uppercase', rotate: `${-8 + Math.sin(frame / 25) * 2}deg` }}>acesso<br />protegido</div>
    </AbsoluteFill>
  );

  const reveal = spring({ frame: frame - 2, fps: 30, config: { damping: 18, stiffness: 105 } });
  return (
    <AbsoluteFill style={{ overflow: 'hidden', background: '#0b0908', opacity: sceneExit }}>
      <GeneratedImage content={content} shade="linear-gradient(90deg, rgba(8,6,5,0.86), rgba(8,6,5,0.44), rgba(8,6,5,0.9))" scaleFrom={1.04} scaleTo={1.02} />
      <Header content={content} label="Sua próxima aula" />
      <div style={{ position: 'absolute', left: 250, right: 250, top: 204, textAlign: 'center', opacity: reveal }}>
        <Eyebrow content={content}>Wise Wolf Library</Eyebrow>
        <h2 style={{ margin: '18px 0 0', color: '#fff', fontFamily: displayFontFamily, fontSize: 86, fontWeight: 650, letterSpacing: '-0.065em' }}>{content.cta}</h2>
        <p style={{ margin: '16px 0 0', color: paperTone, fontFamily: bodyFontFamily, fontSize: 21 }}>{content.ctaSupport}</p>
        <div style={{ position: 'relative', width: 500, height: 180, margin: '34px auto 0' }}>
          {[0, 1, 2].map((index) => <div key={index} style={{ position: 'absolute', left: 60 + index * 25, right: 60 - index * 25, top: 18 + index * 14, height: 116, border: `1px solid ${content.accent}${index === 2 ? '88' : '2f'}`, borderRadius: 14, background: index === 2 ? `linear-gradient(135deg, ${content.accent}28, rgba(18,13,11,0.96))` : 'rgba(240,223,199,0.06)', boxShadow: index === 2 ? `0 28px 70px rgba(0,0,0,0.52), 0 0 40px ${content.accent}22` : undefined, rotate: `${index - 1}deg` }} />)}
          <div style={{ position: 'absolute', left: 102, right: 102, top: 55 }}><CtaButton content={content} label={content.ctaButtons[0]} /></div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

const EducatorDirector: React.FC<DirectedSceneProps> = ({ content, scene, sceneDurationInFrames }) => {
  const frame = useCurrentFrame();
  const sceneExit = exit(frame, sceneDurationInFrames);
  const steps = ['Resultado', 'Aquecimento', 'Prática', 'Continuidade'];

  if (scene === 'hook') return (
    <AbsoluteFill style={{ opacity: sceneExit }}>
      <GeneratedImage content={content} shade="linear-gradient(90deg, rgba(5,5,10,0.9), rgba(5,5,10,0.2) 60%, rgba(5,5,10,0.68))" objectPosition="center" scaleFrom={1.02} scaleTo={1.075} />
      <Header content={content} label="Resultado primeiro" />
      <HeroTitle content={content} top={188} width={1060} compact />
      <div style={{ position: 'absolute', zIndex: 8, left: 102, right: 102, bottom: 254, display: 'flex', alignItems: 'center', gap: 8 }}>
        {steps.map((label, index) => {
          const reveal = enter(frame, 14 + index * 5, 14);
          return <React.Fragment key={label}><div style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${content.accent}55`, borderRadius: 14, background: 'rgba(7,6,13,0.74)', color: '#fff', padding: '12px 16px', fontFamily: bodyFontFamily, fontSize: 12, fontWeight: 800, opacity: reveal, translate: `0 ${(1 - reveal) * 22}px` }}><span style={{ width: 8, height: 8, borderRadius: 3, background: index === 0 ? '#fff' : content.accent, boxShadow: `0 0 14px ${content.accent}` }} />{label}</div>{index < steps.length - 1 && <div style={{ flex: 1, height: 2, background: `linear-gradient(90deg, ${content.accent}, ${content.secondaryAccent})`, scale: `${reveal} 1`, transformOrigin: '0 50%' }} />}</React.Fragment>;
        })}
      </div>
    </AbsoluteFill>
  );

  if (scene === 'problem') return (
    <AbsoluteFill style={{ overflow: 'hidden', background: '#080711', opacity: sceneExit }}>
      <Header content={content} label="Prompt genérico entra" />
      <SceneTitle content={content} eyebrow="Sem contexto, qualquer resposta parece servir" title={content.problemHeadline} width={790} y={162} />
      <div style={{ position: 'absolute', right: 96, top: 158, width: 760, height: 510 }}>
        {['crie uma aula', 'atividade divertida', 'use inteligência artificial', ...content.problemItems].map((item, index) => {
          const reveal = enter(frame, 2 + index * 4, 12);
          const scatterX = [80, 330, 190, 410, 40, 280][index];
          const scatterY = [20, 85, 180, 250, 355, 420][index];
          return <div key={`${item}-${index}`} style={{ position: 'absolute', left: scatterX, top: scatterY, border: `1px solid ${index >= 3 ? `${content.accent}55` : 'rgba(255,255,255,0.13)'}`, borderRadius: index >= 3 ? 14 : 999, background: index >= 3 ? `${content.accent}18` : 'rgba(255,255,255,0.045)', color: index >= 3 ? '#fff' : 'rgba(255,255,255,0.48)', padding: index >= 3 ? '16px 20px' : '11px 17px', fontFamily: bodyFontFamily, fontSize: index >= 3 ? 16 : 12, fontWeight: 800, opacity: reveal * (index >= 3 ? 1 : 0.7), translate: `${Math.sin(frame / 18 + index) * 12 + (1 - reveal) * 80}px ${Math.cos(frame / 21 + index) * 8}px`, rotate: `${Math.sin(frame / 36 + index) * 3}deg`, boxShadow: index >= 3 ? `0 16px 44px rgba(0,0,0,0.34), 0 0 28px ${content.accent}14` : undefined }}>{item}</div>;
        })}
        <div style={{ position: 'absolute', left: 320, top: 170, width: 310, height: 310, border: `1px solid ${content.accent}36`, borderRadius: '50%', boxShadow: `0 0 90px ${content.accent}22`, scale: 0.9 + Math.sin(frame / 16) * 0.035 }} />
      </div>
    </AbsoluteFill>
  );

  if (scene === 'product') return (
    <AbsoluteFill style={{ overflow: 'hidden', background: '#080711', opacity: sceneExit }}>
      <Header content={content} label="Contexto vira sequência" />
      <div style={{ position: 'absolute', left: 42, top: 126, bottom: 216, width: 350, overflow: 'hidden', border: `1px solid ${content.accent}36`, borderRadius: 30, background: '#100d1c', boxShadow: `0 34px 100px rgba(0,0,0,0.5), 0 0 52px ${content.accent}20` }}>
        <Img src={staticFile(`assets/hub/videos/generated-v2/${GENERATED_IMAGES[content.slug]}`)} style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: '18% center', scale: 1.15, filter: 'saturate(0.78) contrast(1.08)' }} />
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, transparent, rgba(8,7,17,0.92))' }} />
        <div style={{ position: 'absolute', left: 22, right: 22, bottom: 25, display: 'grid', gap: 8 }}>
          {steps.map((label, index) => <div key={label} style={{ display: 'grid', gridTemplateColumns: '30px 1fr', alignItems: 'center', gap: 9, border: '1px solid rgba(255,255,255,0.12)', borderRadius: 12, background: 'rgba(8,7,17,0.74)', color: '#fff', padding: '9px 10px', fontFamily: bodyFontFamily, fontSize: 10, fontWeight: 800, opacity: enter(frame, 14 + index * 7, 12), translate: `${(1 - enter(frame, 14 + index * 7, 12)) * -30}px 0` }}><span style={{ display: 'grid', width: 28, height: 28, placeItems: 'center', borderRadius: 9, background: `${content.accent}22`, color: content.accent }}>0{index + 1}</span>{label}</div>)}
        </div>
      </div>
      <div style={{ position: 'absolute', left: 330, right: -8, top: 0, bottom: 0 }}><TourStage content={content} mode="product" top={146} scale={0.86} /></div>
      <div style={{ position: 'absolute', zIndex: 20, left: 360, top: 170, width: 76, height: 2, background: `linear-gradient(90deg, ${content.accent}, transparent)`, boxShadow: `0 0 18px ${content.accent}`, scale: `${enter(frame, 26, 22)} 1`, transformOrigin: '0 50%' }} />
    </AbsoluteFill>
  );

  if (scene === 'proof') return (
    <AbsoluteFill style={{ overflow: 'hidden', background: '#080711', opacity: sceneExit }}>
      <Header content={content} label="A inteligência estrutura. Você decide." />
      <TourStage content={content} mode="proof" top={144} scale={0.91} />
      <div style={{ position: 'absolute', zIndex: 22, right: 88, top: 168, width: 280, display: 'grid', gap: 10 }}>
        {['Revisar', 'Adaptar', 'Aprovar'].map((label, index) => {
          const reveal = spring({ frame: frame - 14 - index * 10, fps: 30, config: { damping: 16, stiffness: 120 } });
          return <div key={label} style={{ display: 'grid', gridTemplateColumns: '42px 1fr auto', alignItems: 'center', gap: 10, border: `1px solid ${index === 2 ? `${content.accent}78` : 'rgba(255,255,255,0.13)'}`, borderRadius: 16, background: 'rgba(8,7,17,0.9)', color: '#fff', padding: '12px', opacity: reveal, translate: `${(1 - reveal) * 55}px 0` }}><span style={{ display: 'grid', width: 40, height: 40, placeItems: 'center', borderRadius: 13, background: `${content.accent}22`, color: content.accent, fontFamily: displayFontFamily, fontSize: 13, fontWeight: 850 }}>0{index + 1}</span><b style={{ fontFamily: bodyFontFamily, fontSize: 12 }}>{label}</b><Check size={15} color={index === 2 ? '#fff' : content.accent} /></div>;
        })}
      </div>
    </AbsoluteFill>
  );

  const reveal = spring({ frame: frame - 2, fps: 30, config: { damping: 17, stiffness: 110 } });
  return (
    <AbsoluteFill style={{ overflow: 'hidden', background: '#080711', opacity: sceneExit }}>
      <GeneratedImage content={content} shade="linear-gradient(90deg, rgba(8,7,17,0.86), rgba(8,7,17,0.38), rgba(8,7,17,0.9))" scaleFrom={1.04} scaleTo={1.02} />
      <Header content={content} label="Plano pronto para adaptar" />
      <div style={{ position: 'absolute', left: 238, right: 238, top: 190, textAlign: 'center', opacity: reveal }}>
        <Eyebrow content={content}>Educador IA</Eyebrow>
        <h2 style={{ margin: '18px 0 0', color: '#fff', fontFamily: displayFontFamily, fontSize: 86, fontWeight: 650, letterSpacing: '-0.065em' }}>{content.cta}</h2>
        <p style={{ margin: '15px 0 0', color: brand.inkSoft, fontFamily: bodyFontFamily, fontSize: 21 }}>{content.ctaSupport}</p>
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: 34 }}>
          {steps.map((label, index) => <React.Fragment key={label}><div style={{ display: 'grid', minWidth: 124, height: 76, placeItems: 'center', border: `1px solid ${content.accent}55`, borderRadius: 17, background: `${content.accent}${index === 3 ? '2b' : '12'}`, color: '#fff', fontFamily: bodyFontFamily, fontSize: 11, fontWeight: 800, opacity: enter(frame, 14 + index * 5, 13), translate: `0 ${(1 - enter(frame, 14 + index * 5, 13)) * 25}px` }}>{label}</div>{index < steps.length - 1 && <ChevronRight size={18} color={content.accent} />}</React.Fragment>)}
        </div>
        <div style={{ marginTop: 28 }}><CtaButton content={content} label={content.ctaButtons[0]} /></div>
      </div>
    </AbsoluteFill>
  );
};

const WaveRibbon: React.FC<{ color: string; top: number; phase?: number; opacity?: number }> = ({ color, top, phase = 0, opacity = 0.7 }) => {
  const frame = useCurrentFrame();
  return (
    <div style={{ position: 'absolute', zIndex: 14, left: -80, right: -80, top, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity }}>
      {Array.from({ length: 86 }, (_, index) => {
        const height = 3 + Math.abs(Math.sin(frame / 5 + index * 0.45 + phase) * Math.cos(frame / 11 + index * 0.16)) * 34;
        return <span key={index} style={{ width: 4, height, borderRadius: 999, background: color, boxShadow: height > 24 ? `0 0 12px ${color}` : undefined }} />;
      })}
    </div>
  );
};

const WolfieDirector: React.FC<DirectedSceneProps> = ({ content, scene, sceneDurationInFrames }) => {
  const frame = useCurrentFrame();
  const sceneExit = exit(frame, sceneDurationInFrames);

  if (scene === 'hook') return (
    <AbsoluteFill style={{ opacity: sceneExit }}>
      <GeneratedImage content={content} shade="linear-gradient(90deg, rgba(3,8,13,0.8), rgba(3,8,13,0.22) 55%, rgba(3,8,13,0.62))" objectPosition="center" scaleFrom={1.02} scaleTo={1.09} />
      <Header content={content} label="Antes da situação real" />
      <HeroTitle content={content} top={184} width={1060} compact />
      <WaveRibbon color={content.accent} top={710} opacity={0.58} />
      <div style={{ position: 'absolute', zIndex: 15, right: 130, bottom: 258, display: 'grid', width: 104, height: 104, placeItems: 'center', border: `1px solid ${content.accent}77`, borderRadius: '50%', background: 'rgba(3,8,13,0.72)', boxShadow: `0 0 ${44 + Math.sin(frame / 9) * 12}px ${content.accent}44`, scale: 1 + Math.sin(frame / 8) * 0.04 }}><Mic2 size={34} color="#fff" /></div>
    </AbsoluteFill>
  );

  if (scene === 'problem') return (
    <AbsoluteFill style={{ overflow: 'hidden', background: '#050b10', opacity: sceneExit }}>
      <Header content={content} label="O silêncio entre as aulas" />
      <SceneTitle content={content} eyebrow="Confiança se constrói antes" title={content.problemHeadline} width={760} y={154} />
      <div style={{ position: 'absolute', right: 82, top: 150, width: 780, height: 520 }}>
        {[0, 1, 2, 3].map((index) => <div key={index} style={{ position: 'absolute', left: 90 + index * 58, top: 45 + index * 22, width: 480 - index * 48, height: 480 - index * 48, border: `1px solid ${index === 0 ? `${content.accent}64` : `${content.accent}25`}`, borderRadius: '50%', boxShadow: index === 0 ? `0 0 100px ${content.accent}20` : undefined, scale: 0.95 + Math.sin(frame / (15 + index * 4)) * 0.04 }} />)}
        <div style={{ position: 'absolute', left: 226, top: 186, width: 210, textAlign: 'center' }}><strong style={{ display: 'block', color: '#fff', fontFamily: displayFontFamily, fontSize: 42, lineHeight: 0.95 }}>prática<br />ativa</strong><small style={{ display: 'block', marginTop: 12, color: content.accent, fontFamily: bodyFontFamily, fontSize: 11, fontWeight: 850, letterSpacing: '0.1em', textTransform: 'uppercase' }}>não pode sumir</small></div>
        {content.problemItems.map((item, index) => {
          const angle = [-35, 15, 74][index] * Math.PI / 180;
          const radius = 270;
          const reveal = enter(frame, 10 + index * 8, 12);
          return <div key={item} style={{ position: 'absolute', left: 290 + Math.cos(angle) * radius, top: 220 + Math.sin(angle) * radius, width: 190, border: `1px solid ${content.accent}48`, borderRadius: 15, background: 'rgba(4,11,16,0.9)', color: '#fff', padding: '13px 14px', fontFamily: bodyFontFamily, fontSize: 10, fontWeight: 800, opacity: reveal, scale: 0.9 + reveal * 0.1, boxShadow: `0 14px 38px rgba(0,0,0,0.42), 0 0 24px ${content.accent}18` }}>{item}</div>;
        })}
      </div>
      <WaveRibbon color={content.accent} top={744} phase={2.4} opacity={0.42} />
    </AbsoluteFill>
  );

  if (scene === 'product') return (
    <AbsoluteFill style={{ overflow: 'hidden', background: '#050b10', opacity: sceneExit }}>
      <Header content={content} label="Escolher → falar → receber feedback" />
      <div style={{ position: 'absolute', left: '50%', top: 98, width: 1660, height: 790, border: `1px solid ${content.accent}38`, borderRadius: '46% 46% 36px 36px', background: `radial-gradient(circle at 50% 100%, ${content.accent}22, transparent 48%)`, boxShadow: `inset 0 0 100px ${content.accent}10`, translate: '-50% 0' }} />
      <TourStage content={content} mode="product" top={144} scale={0.92} mask="inset(0 round 52px)" glow={`0 54px 150px rgba(0,0,0,0.72), 0 0 110px ${content.accent}32`} />
      <WaveRibbon color={content.accent} top={138} opacity={0.46} />
      <div style={{ position: 'absolute', zIndex: 21, left: 84, top: 176, display: 'flex', alignItems: 'center', gap: 9, border: `1px solid ${content.accent}55`, borderRadius: 999, background: 'rgba(3,9,14,0.86)', color: '#fff', padding: '10px 14px', fontFamily: bodyFontFamily, fontSize: 10, fontWeight: 850 }}><Mic2 size={15} color={content.accent} /> voz em prática</div>
    </AbsoluteFill>
  );

  if (scene === 'proof') return (
    <AbsoluteFill style={{ overflow: 'hidden', background: '#050b10', opacity: sceneExit }}>
      <Header content={content} label="Tentar. Ajustar. Repetir." />
      <TourStage content={content} mode="proof" top={144} scale={0.91} mask="inset(0 round 52px)" />
      <div style={{ position: 'absolute', zIndex: 23, right: 84, top: 178, width: 270, display: 'grid', gap: 9 }}>
        {['Clareza', 'Vocabulário', 'Confiança'].map((label, index) => {
          const progress = enter(frame, 18 + index * 8, 18);
          return <div key={label} style={{ border: '1px solid rgba(255,255,255,0.13)', borderRadius: 16, background: 'rgba(4,11,16,0.9)', padding: '12px 14px' }}><div style={{ display: 'flex', justifyContent: 'space-between', color: '#fff', fontFamily: bodyFontFamily, fontSize: 10, fontWeight: 800 }}><span>{label}</span><span style={{ color: content.accent }}>{72 + index * 8}%</span></div><div style={{ height: 5, marginTop: 9, overflow: 'hidden', borderRadius: 999, background: 'rgba(255,255,255,0.08)' }}><div style={{ width: `${progress * (72 + index * 8)}%`, height: '100%', borderRadius: 999, background: `linear-gradient(90deg, ${content.accent}, ${content.secondaryAccent})`, boxShadow: `0 0 12px ${content.accent}` }} /></div></div>;
        })}
      </div>
      <WaveRibbon color={content.secondaryAccent} top={754} phase={1.2} opacity={0.36} />
    </AbsoluteFill>
  );

  const reveal = spring({ frame: frame - 1, fps: 30, config: { damping: 17, stiffness: 110 } });
  return (
    <AbsoluteFill style={{ overflow: 'hidden', background: '#050b10', opacity: sceneExit }}>
      <GeneratedImage content={content} shade="linear-gradient(90deg, rgba(3,8,13,0.84), rgba(3,8,13,0.38), rgba(3,8,13,0.86))" scaleFrom={1.04} scaleTo={1.02} />
      <Header content={content} label="Pratique antes" />
      <div style={{ position: 'absolute', left: 300, right: 300, top: 184, textAlign: 'center', opacity: reveal }}>
        <div style={{ display: 'grid', width: 116, height: 116, margin: '0 auto', placeItems: 'center', border: `1px solid ${content.accent}82`, borderRadius: '50%', background: `${content.accent}22`, boxShadow: `0 0 ${54 + Math.sin(frame / 8) * 16}px ${content.accent}44`, scale: 1 + Math.sin(frame / 8) * 0.04 }}><Mic2 size={42} color="#fff" /></div>
        <h2 style={{ margin: '24px 0 0', color: '#fff', fontFamily: displayFontFamily, fontSize: 90, fontWeight: 650, letterSpacing: '-0.065em' }}>{content.cta}</h2>
        <p style={{ margin: '14px 0 0', color: brand.inkSoft, fontFamily: bodyFontFamily, fontSize: 21 }}>{content.ctaSupport}</p>
        <div style={{ marginTop: 28 }}><CtaButton content={content} label={content.ctaButtons[0]} /></div>
      </div>
      <WaveRibbon color={content.accent} top={736} opacity={0.52} />
    </AbsoluteFill>
  );
};

const SchoolDirector: React.FC<DirectedSceneProps> = ({ content, scene, sceneDurationInFrames }) => {
  const frame = useCurrentFrame();
  const sceneExit = exit(frame, sceneDurationInFrames);
  const modules = [
    { label: 'Comercial', icon: Users },
    { label: 'Agenda', icon: CalendarDays },
    { label: 'Pedagógico', icon: GraduationCap },
    { label: 'Acessos', icon: ShieldCheck },
  ];

  if (scene === 'hook') return (
    <AbsoluteFill style={{ opacity: sceneExit }}>
      <GeneratedImage content={content} shade="linear-gradient(90deg, rgba(4,9,8,0.84), rgba(4,9,8,0.18) 58%, rgba(4,9,8,0.58))" objectPosition="center" scaleFrom={1.02} scaleTo={1.08} />
      <Header content={content} label="Uma escola. Uma leitura." />
      <HeroTitle content={content} top={184} width={1090} compact />
      <div style={{ position: 'absolute', zIndex: 10, left: 112, right: 112, bottom: 254, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
        {modules.map(({ label, icon: Icon }, index) => {
          const reveal = enter(frame, 12 + index * 5, 14);
          return <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 10, border: `1px solid ${content.accent}42`, borderRadius: 15, background: 'rgba(4,10,8,0.68)', color: '#fff', padding: '13px 15px', fontFamily: bodyFontFamily, fontSize: 12, fontWeight: 800, opacity: reveal, translate: `0 ${(1 - reveal) * 28}px`, backdropFilter: 'blur(18px)' }}><Icon size={17} color={content.accent} />{label}</div>;
        })}
      </div>
    </AbsoluteFill>
  );

  if (scene === 'problem') return (
    <AbsoluteFill style={{ overflow: 'hidden', background: '#050c0a', opacity: sceneExit }}>
      <Header content={content} label="Versões diferentes da operação" />
      <SceneTitle content={content} eyebrow="Pontos cegos aparecem entre áreas" title={content.problemHeadline} width={760} y={154} />
      <div style={{ position: 'absolute', right: 84, top: 160, width: 790, height: 500 }}>
        {content.problemItems.map((item, index) => {
          const reveal = spring({ frame: frame - 7 - index * 8, fps: 30, config: { damping: 17, stiffness: 110 } });
          const positions = [[30, 40], [420, 56], [228, 286]];
          return <div key={item} style={{ position: 'absolute', left: positions[index][0], top: positions[index][1], width: 330, minHeight: 118, border: `1px solid ${content.accent}${index === 2 ? '66' : '36'}`, borderRadius: 22, background: 'rgba(5,13,10,0.88)', boxShadow: `0 24px 70px rgba(0,0,0,0.42), 0 0 40px ${content.accent}12`, color: '#fff', padding: '22px', opacity: reveal, translate: `${(1 - reveal) * (index === 1 ? 80 : -80)}px ${(1 - reveal) * 26}px` }}><span style={{ display: 'block', color: content.accent, fontFamily: bodyFontFamily, fontSize: 10, fontWeight: 900, letterSpacing: '0.1em' }}>ÁREA 0{index + 1}</span><strong style={{ display: 'block', marginTop: 12, fontFamily: displayFontFamily, fontSize: 25, fontWeight: 620 }}>{item}</strong></div>;
        })}
        <svg viewBox="0 0 790 500" style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
          <path d="M360 105 C 420 100, 448 118, 500 112" fill="none" stroke={content.accent} strokeWidth="2" strokeDasharray="8 10" opacity={0.48} />
          <path d="M520 170 C 510 260, 420 290, 390 334" fill="none" stroke={content.accent} strokeWidth="2" strokeDasharray="8 10" opacity={0.38} />
          <path d="M230 334 C 178 290, 152 220, 172 160" fill="none" stroke={content.accent} strokeWidth="2" strokeDasharray="8 10" opacity={0.32} />
        </svg>
      </div>
    </AbsoluteFill>
  );

  if (scene === 'product') return (
    <AbsoluteFill style={{ overflow: 'hidden', background: '#050c0a', opacity: sceneExit }}>
      <Header content={content} label="Do contato à renovação" />
      <TourStage content={content} mode="product" top={143} scale={0.91} glow={`0 52px 150px rgba(0,0,0,0.72), 0 0 90px ${content.accent}28`} />
      <div style={{ position: 'absolute', zIndex: 22, left: 116, right: 116, top: 148, display: 'flex', alignItems: 'center', justifyContent: 'space-between', pointerEvents: 'none' }}>
        {['Contato', 'Matrícula', 'Agenda', 'Renovação'].map((label, index) => {
          const reveal = enter(frame, 10 + index * 8, 14);
          return <React.Fragment key={label}><div style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${content.accent}55`, borderRadius: 999, background: 'rgba(4,12,9,0.9)', color: '#fff', padding: '10px 14px', fontFamily: bodyFontFamily, fontSize: 10, fontWeight: 850, opacity: reveal }}><span style={{ display: 'grid', width: 21, height: 21, placeItems: 'center', borderRadius: '50%', background: `${content.accent}24`, color: content.accent }}>0{index + 1}</span>{label}</div>{index < 3 && <div style={{ flex: 1, height: 2, background: `linear-gradient(90deg, ${content.accent}, ${content.secondaryAccent})`, scale: `${reveal} 1`, transformOrigin: '0 50%' }} />}</React.Fragment>;
        })}
      </div>
    </AbsoluteFill>
  );

  if (scene === 'proof') return (
    <AbsoluteFill style={{ overflow: 'hidden', background: '#050c0a', opacity: sceneExit }}>
      <Header content={content} label="Ambientes realmente separados" />
      <TourStage content={content} mode="proof" top={144} scale={0.89} />
      <div style={{ position: 'absolute', zIndex: 24, right: 82, top: 164, display: 'grid', gap: 10 }}>
        {['Aurora', 'Horizonte', 'Núcleo'].map((label, index) => {
          const reveal = enter(frame, 18 + index * 8, 14);
          return <div key={label} style={{ display: 'grid', gridTemplateColumns: '38px 1fr auto', alignItems: 'center', gap: 10, width: 300, border: `1px solid ${index === 0 ? `${content.accent}72` : 'rgba(255,255,255,0.13)'}`, borderRadius: 17, background: 'rgba(4,12,9,0.92)', color: '#fff', padding: '11px 13px', opacity: reveal, translate: `${(1 - reveal) * 56}px 0` }}><span style={{ display: 'grid', width: 36, height: 36, placeItems: 'center', borderRadius: 12, background: `${content.accent}22`, color: content.accent, fontFamily: displayFontFamily, fontSize: 14, fontWeight: 850 }}>{label[0]}</span><div><b style={{ display: 'block', fontFamily: bodyFontFamily, fontSize: 11 }}>{label}</b><small style={{ color: brand.muted, fontFamily: bodyFontFamily, fontSize: 8 }}>tenant isolado</small></div><LockKeyhole size={15} color={content.accent} /></div>;
        })}
      </div>
      <div style={{ position: 'absolute', zIndex: 23, left: 84, top: 176, display: 'flex', alignItems: 'center', gap: 9, border: `1px solid ${content.accent}55`, borderRadius: 999, background: 'rgba(4,12,9,0.9)', color: '#fff', padding: '10px 14px', fontFamily: bodyFontFamily, fontSize: 10, fontWeight: 850 }}><ShieldCheck size={15} color={content.accent} /> marca própria · papéis por função</div>
    </AbsoluteFill>
  );

  const reveal = spring({ frame: frame - 1, fps: 30, config: { damping: 18, stiffness: 108 } });
  return (
    <AbsoluteFill style={{ overflow: 'hidden', background: '#050c0a', opacity: sceneExit }}>
      <GeneratedImage content={content} shade="linear-gradient(90deg, rgba(4,9,8,0.85), rgba(4,9,8,0.35), rgba(4,9,8,0.84))" scaleFrom={1.04} scaleTo={1.02} />
      <Header content={content} label="Veja a operação inteira" />
      <div style={{ position: 'absolute', left: 250, right: 250, top: 180, textAlign: 'center', opacity: reveal }}>
        <Eyebrow content={content}>Wise Wolf School OS</Eyebrow>
        <h2 style={{ margin: '18px 0 0', color: '#fff', fontFamily: displayFontFamily, fontSize: 88, fontWeight: 650, letterSpacing: '-0.065em' }}>{content.cta}</h2>
        <p style={{ margin: '14px 0 0', color: brand.inkSoft, fontFamily: bodyFontFamily, fontSize: 21 }}>{content.ctaSupport}</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, margin: '32px auto 0', maxWidth: 760 }}>
          {['09:00', '10:30', '14:00', '15:30', '17:00'].map((time, index) => <div key={time} style={{ border: `1px solid ${index === 2 ? `${content.accent}88` : 'rgba(255,255,255,0.13)'}`, borderRadius: 13, background: index === 2 ? `${content.accent}28` : 'rgba(5,12,10,0.78)', color: index === 2 ? '#fff' : brand.inkSoft, padding: '13px 8px', fontFamily: bodyFontFamily, fontSize: 11, fontWeight: 850, opacity: enter(frame, 10 + index * 4, 12), translate: `0 ${(1 - enter(frame, 10 + index * 4, 12)) * 20}px` }}>{time}</div>)}
        </div>
        <div style={{ marginTop: 25 }}><CtaButton content={content} label={content.ctaButtons[0]} /></div>
      </div>
    </AbsoluteFill>
  );
};

export const SolutionDirectedScene: React.FC<DirectedSceneProps> = (props) => {
  if (props.content.slug === 'hub-overview') return <OverviewDirector {...props} />;
  if (props.content.slug === 'library') return <LibraryDirector {...props} />;
  if (props.content.slug === 'educator-ai') return <EducatorDirector {...props} />;
  if (props.content.slug === 'wolfie') return <WolfieDirector {...props} />;
  return <SchoolDirector {...props} />;
};

export const SOLUTION_TRANSITION_DURATION = 18;

export const SolutionTransition: React.FC<{
  content: HubVideoContent;
  transitionIndex: number;
}> = ({ content, transitionIndex }) => {
  const frame = useCurrentFrame();
  const duration = SOLUTION_TRANSITION_DURATION;
  const direction = transitionIndex % 2 === 0 ? 1 : -1;
  const intensity = 1 + transitionIndex * 0.08;
  const opacity = interpolate(frame, [0, 4, duration - 5, duration - 1], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: [Easing.out(Easing.cubic), Easing.linear, Easing.in(Easing.cubic)],
  });
  const progress = interpolate(frame, [0, duration - 1], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.cubic) });

  if (content.slug === 'library') return (
    <AbsoluteFill style={{ zIndex: 60, overflow: 'hidden', background: '#0b0908', opacity }}>
      {Array.from({ length: 7 }, (_, index) => <div key={index} style={{ position: 'absolute', left: `${index * 16 - 7}%`, top: -130, width: '23%', height: 1360, border: '1px solid rgba(240,223,199,0.14)', background: index % 2 ? 'rgba(214,106,69,0.28)' : 'rgba(240,223,199,0.08)', boxShadow: '0 20px 70px rgba(0,0,0,0.42)', translate: `${direction * (1 - progress) * (index % 2 ? 300 : -300) * intensity}px ${Math.sin(index + transitionIndex) * 40}px`, rotate: `${direction * (-12 + index * 4 + progress * 8)}deg` }} />)}
      <div style={{ position: 'absolute', left: 0, right: 0, top: '50%', height: 3, background: `linear-gradient(90deg, transparent, ${content.accent}, #fff, transparent)`, boxShadow: `0 0 36px ${content.accent}`, scale: `${Math.sin(progress * Math.PI)} 1` }} />
    </AbsoluteFill>
  );

  if (content.slug === 'educator-ai') return (
    <AbsoluteFill style={{ zIndex: 60, overflow: 'hidden', background: '#080711', opacity }}>
      {Array.from({ length: 12 }, (_, index) => {
        const column = index % 4;
        const row = Math.floor(index / 4);
        const cardDirection = index % 2 ? direction : -direction;
        return <div key={index} style={{ position: 'absolute', left: 350 + column * 310, top: 180 + row * 220, width: 250, height: 150, border: `1px solid ${content.accent}66`, borderRadius: 24, background: `linear-gradient(135deg, ${content.accent}28, rgba(7,6,13,0.92))`, boxShadow: `0 0 38px ${content.accent}18`, opacity: Math.sin(progress * Math.PI), translate: `${cardDirection * (1 - progress) * 420 * intensity}px ${direction * (1 - progress) * (row - 1) * 210}px`, scale: 0.84 + Math.sin(progress * Math.PI) * 0.16 }} />;
      })}
      <div style={{ position: 'absolute', left: '50%', top: '50%', width: 620, height: 4, borderRadius: 999, background: `linear-gradient(90deg, transparent, ${content.accent}, #fff, ${content.secondaryAccent}, transparent)`, boxShadow: `0 0 50px ${content.accent}`, translate: '-50% -50%', scale: `${Math.sin(progress * Math.PI)} 1` }} />
    </AbsoluteFill>
  );

  if (content.slug === 'wolfie') return (
    <AbsoluteFill style={{ zIndex: 60, overflow: 'hidden', background: '#050b10', opacity }}>
      <div style={{ position: 'absolute', left: `${50 + direction * transitionIndex * 2}%`, top: `${50 - direction * transitionIndex}%`, width: 420 + progress * 1700 * intensity, height: 420 + progress * 1700 * intensity, border: `3px solid ${content.accent}`, borderRadius: '50%', boxShadow: `0 0 100px ${content.accent}55, inset 0 0 100px ${content.accent}28`, translate: '-50% -50%' }} />
      {Array.from({ length: 52 }, (_, index) => {
        const angle = direction * index / 52 * Math.PI * 2 + transitionIndex * 0.28;
        const radius = 160 + progress * 760;
        const height = 22 + Math.abs(Math.sin(frame / 3 + index * 0.7)) * 105;
        return <span key={index} style={{ position: 'absolute', left: 960 + Math.cos(angle) * radius, top: 540 + Math.sin(angle) * radius, width: 5, height, borderRadius: 999, background: index % 2 ? content.accent : content.secondaryAccent, boxShadow: `0 0 15px ${content.accent}`, opacity: Math.sin(progress * Math.PI), rotate: `${angle * 180 / Math.PI + 90}deg` }} />;
      })}
    </AbsoluteFill>
  );

  if (content.slug === 'school-os') return (
    <AbsoluteFill style={{ zIndex: 60, overflow: 'hidden', background: '#050c0a', opacity }}>
      {Array.from({ length: 40 }, (_, index) => {
        const column = index % 8;
        const row = Math.floor(index / 8);
        const tileProgress = enter(frame, Math.floor(index / 4), 7);
        return <div key={index} style={{ position: 'absolute', left: column * 240, top: row * 216, width: 241, height: 217, border: `1px solid ${content.accent}2f`, background: index % 5 === 0 ? `${content.accent}24` : 'rgba(5,12,10,0.94)', opacity: tileProgress * opacity, scale: 0.86 + tileProgress * 0.14, rotate: `${(1 - tileProgress) * (index % 2 ? 4 : -4)}deg` }} />;
      })}
      <div style={{ position: 'absolute', left: `${direction > 0 ? progress * 108 : 108 - progress * 108}%`, top: -120, width: 180, height: 1320, background: `linear-gradient(90deg, transparent, ${content.accent}50, #fff, transparent)`, filter: 'blur(14px)', rotate: `${direction * (8 + transitionIndex * 2)}deg` }} />
    </AbsoluteFill>
  );

  const colors = ['#ff785f', '#7652ed', '#20a9cc', '#258e79'];
  return (
    <AbsoluteFill style={{ zIndex: 60, overflow: 'hidden', background: '#07080b', opacity }}>
      {colors.map((color, index) => <div key={color} style={{ position: 'absolute', left: `${index * 25}%`, top: 0, width: '26%', height: '100%', background: `linear-gradient(135deg, ${color}44, rgba(5,6,9,0.98) 62%)`, clipPath: `polygon(${progress * 8}% 0, 100% 0, ${100 - progress * 8}% 100%, 0 100%)`, translate: `0 ${direction * (1 - progress) * (index % 2 ? 1080 : -1080) * intensity}px`, boxShadow: `0 0 80px ${color}22` }} />)}
      <div style={{ position: 'absolute', left: `${direction > 0 ? interpolate(progress, [0, 1], [-15, 115]) : interpolate(progress, [0, 1], [115, -15])}%`, top: -120, width: 180, height: 1320, background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.72), transparent)', filter: 'blur(12px)', rotate: `${direction * (9 + transitionIndex * 2)}deg` }} />
    </AbsoluteFill>
  );
};
