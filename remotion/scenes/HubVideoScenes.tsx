import React from 'react';
import {
  ArrowRight,
  Check,
  CircleCheck,
  Sparkles,
} from 'lucide-react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { bodyFontFamily, displayFontFamily } from '../brand/fonts';
import { brand, videoSafeArea } from '../brand/tokens';
import { LogoLockup } from '../components/LogoLockup';
import { NativeCaptureMontage } from '../components/NativeCaptureMontage';
import { ProductTour } from '../components/ProductTours';
import type { HubVideoContent } from '../types';

const SceneChrome: React.FC<{ content: HubVideoContent }> = ({ content }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const reveal = spring({ frame, fps, config: { damping: 20, stiffness: 112 } });
  return (
    <>
    <div style={{ position: 'absolute', left: videoSafeArea.left, top: videoSafeArea.top, opacity: reveal, translate: `${(1 - reveal) * -30}px 0`, scale: 0.94 + reveal * 0.06 }}><LogoLockup compact /></div>
    <div
      style={{
        position: 'absolute',
        right: videoSafeArea.right,
        top: videoSafeArea.top + 4,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        border: `1px solid ${brand.line}`,
        borderRadius: 999,
        background: 'rgba(255,255,255,0.035)',
        color: brand.inkSoft,
        padding: '10px 16px',
        fontFamily: bodyFontFamily,
        fontSize: 13,
        fontWeight: 700,
        opacity: reveal,
        translate: `${(1 - reveal) * 30}px 0`,
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: content.accent, boxShadow: `0 0 18px ${content.accent}` }} />
      {content.productName}
    </div>
  </>
  );
};

const Eyebrow: React.FC<{ text: string; accent: string }> = ({ text, accent }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: brand.inkSoft, fontFamily: bodyFontFamily, fontSize: 14, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
    <span style={{ width: 34, height: 2, borderRadius: 999, background: accent, boxShadow: `0 0 20px ${accent}` }} />
    {text}
  </div>
);

export const HookScene: React.FC<{ content: HubVideoContent }> = ({ content }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const eyebrowReveal = spring({ frame, fps, config: { damping: 22, stiffness: 105 } });
  const headlineReveal = spring({ frame: frame - 7, fps, config: { damping: 18, stiffness: 95, mass: 0.9 } });
  const emphasisReveal = spring({ frame: frame - 15, fps, config: { damping: 17, stiffness: 110 } });
  const signalWidth = interpolate(frame, [14, 50], [0, 540], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const ambientFloat = Math.sin(frame / 19) * 7 + Math.sin(frame / 43) * 4;
  const ambientScale = 1 + Math.sin(frame / 31) * 0.006;

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <SceneChrome content={content} />
      <div style={{ position: 'absolute', left: 166, right: 166, top: 260, translate: `0 ${ambientFloat}px`, scale: ambientScale }}>
        <div style={{ opacity: eyebrowReveal, transform: `translateY(${(1 - eyebrowReveal) * 18}px)` }}><Eyebrow text={content.eyebrow} accent={content.accent} /></div>
        <h1
          style={{
            maxWidth: 1480,
            margin: '30px 0 0',
            color: brand.ink,
            fontFamily: displayFontFamily,
            fontSize: content.slug === 'educator-ai' ? 112 : 128,
            fontWeight: 620,
            lineHeight: 0.88,
            letterSpacing: '-0.07em',
            opacity: headlineReveal,
            transform: `translateY(${(1 - headlineReveal) * 62}px)`,
          }}
        >
          {content.title}
          <span style={{ display: 'block', marginTop: 18, color: content.accent, opacity: emphasisReveal, transform: `translateX(${(1 - emphasisReveal) * -45}px)` }}>{content.emphasis}</span>
        </h1>
        <div style={{ width: signalWidth, height: 4, marginTop: 46, borderRadius: 999, background: `linear-gradient(90deg, ${content.accent}, ${content.secondaryAccent}, transparent)`, boxShadow: `0 0 30px ${content.accent}66` }} />
      </div>
      <div style={{ position: 'absolute', right: 86, bottom: 132, color: `rgba(255,255,255,${0.055 + Math.sin(frame / 17) * 0.018})`, fontFamily: displayFontFamily, fontSize: 172, fontWeight: 800, letterSpacing: '-0.08em', translate: `${Math.sin(frame / 29) * 12}px ${Math.cos(frame / 37) * 8}px`, rotate: `${Math.sin(frame / 41) * 1.2}deg` }}>01</div>
      <div style={{ position: 'absolute', left: 166, bottom: 148, display: 'flex', gap: 8 }}>
        {[0, 1, 2, 3, 4].map((index) => <span key={index} style={{ width: 5, height: 18 + (Math.sin(frame / 5 + index) + 1) * 15, borderRadius: 999, background: index % 2 ? content.secondaryAccent : content.accent, boxShadow: `0 0 18px ${content.accent}`, opacity: 0.34 + index * 0.1 }} />)}
      </div>
    </div>
  );
};

export const ProblemScene: React.FC<{ content: HubVideoContent }> = ({ content }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const titleReveal = spring({ frame, fps, config: { damping: 20, stiffness: 100 } });
  const titleFloat = Math.sin(frame / 24) * 5;

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <SceneChrome content={content} />
      <div style={{ position: 'absolute', left: 118, right: 118, top: 180, display: 'grid', gridTemplateColumns: '0.9fr 1.1fr', gap: 88, alignItems: 'center' }}>
        <div style={{ opacity: titleReveal, translate: `${(1 - titleReveal) * -56}px ${titleFloat}px` }}>
          <Eyebrow text="O atrito que precisa desaparecer" accent={content.accent} />
          <h2 style={{ maxWidth: 680, margin: '28px 0 0', color: brand.ink, fontFamily: displayFontFamily, fontSize: 78, fontWeight: 620, lineHeight: 0.95, letterSpacing: '-0.06em' }}>{content.problemHeadline}</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 34, color: brand.muted, fontFamily: bodyFontFamily, fontSize: 17 }}><Sparkles size={21} color={content.accent} /> Tecnologia deve retirar atrito, não criar outra tela.</div>
        </div>
        <div style={{ display: 'grid', gap: 18 }}>
          {content.problemItems.map((item, index) => {
            const reveal = spring({ frame: frame - 7 - index * 8, fps, config: { damping: 18, stiffness: 110 } });
            const strikeWidth = interpolate(frame, [25 + index * 9, 55 + index * 9], [0, 100], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
            return (
              <article key={item} style={{ position: 'relative', display: 'grid', gridTemplateColumns: '76px 1fr auto', alignItems: 'center', minHeight: 134, overflow: 'hidden', border: `1px solid ${brand.line}`, borderRadius: 26, background: `linear-gradient(135deg, rgba(255,255,255,0.046), ${content.accent}${index === Math.floor(frame / 34) % content.problemItems.length ? '12' : '05'})`, boxShadow: index === Math.floor(frame / 34) % content.problemItems.length ? `0 22px 54px rgba(0,0,0,0.28), inset 0 0 38px ${content.accent}0b` : undefined, padding: '20px 24px', opacity: reveal, translate: `${(1 - reveal) * 84 + Math.sin(frame / 17 + index) * 4}px ${Math.cos(frame / 23 + index) * 3}px`, scale: index === Math.floor(frame / 34) % content.problemItems.length ? 1.012 : 1 }}>
                <span style={{ display: 'grid', width: 58, height: 58, placeItems: 'center', borderRadius: 19, background: `${content.accent}1a`, color: content.accent, fontFamily: displayFontFamily, fontSize: 18, fontWeight: 800 }}>{String(index + 1).padStart(2, '0')}</span>
                <span style={{ position: 'relative', width: 'fit-content', color: brand.ink, fontFamily: displayFontFamily, fontSize: 29, fontWeight: 600, letterSpacing: '-0.035em' }}>{item}<i style={{ position: 'absolute', left: 0, top: '55%', width: `${strikeWidth}%`, height: 2, borderRadius: 999, background: content.accent, boxShadow: `0 0 14px ${content.accent}`, transform: 'rotate(-1.5deg)' }} /></span>
                <ArrowRight size={24} color={content.accent} />
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export const ProductScene: React.FC<{ content: HubVideoContent }> = ({ content }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const headlineReveal = spring({ frame, fps, config: { damping: 21, stiffness: 105 } });
  const mockupReveal = spring({ frame: frame - 7, fps, config: { damping: 19, stiffness: 92, mass: 0.9 } });
  const cameraScale = interpolate(frame, [0, 62, 126, 192, 258, 340], [0.94, 1.015, 1.07, 1.025, 1.085, 1.045], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const cameraDirection = content.mockup === 'library' || content.mockup === 'school' ? -1 : 1;
  const cameraX = interpolate(frame, [0, 85, 154, 226, 340], [36, -18 * cameraDirection, 30 * cameraDirection, -34 * cameraDirection, 4], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const cameraY = interpolate(frame, [0, 110, 210, 340], [22, -8, 11, -14], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const cameraRotate = interpolate(frame, [0, 150, 340], [-0.38, 0.18, -0.12], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div style={{ position: 'absolute', left: videoSafeArea.left, top: videoSafeArea.top }}><LogoLockup compact /></div>
      <div style={{ position: 'absolute', left: 465, right: 120, top: 82, display: 'flex', alignItems: 'center', opacity: headlineReveal, transform: `translateY(${(1 - headlineReveal) * 20}px)` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}><Eyebrow text="Tour guiado da plataforma" accent={content.accent} /><h2 style={{ margin: 0, color: brand.ink, fontFamily: displayFontFamily, fontSize: 35, fontWeight: 650, letterSpacing: '-0.045em' }}>{content.productHeadline}</h2></div>
      </div>
      <div style={{ position: 'absolute', left: 160, top: 132, width: 1600, height: 720, opacity: mockupReveal, translate: `${cameraX}px ${cameraY + (1 - mockupReveal) * 56}px`, scale: cameraScale * (0.94 + mockupReveal * 0.06), rotate: `${cameraRotate}deg`, transformOrigin: 'center top' }}>
        <ProductTour content={content} mode="product" />
      </div>
      <NativeCaptureMontage content={content} />
    </div>
  );
};

export const ProofScene: React.FC<{ content: HubVideoContent }> = ({ content }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const tourReveal = spring({ frame: frame - 4, fps, config: { damping: 18, stiffness: 100 } });
  const cameraScale = interpolate(frame, [0, 76, 148, 230, 320], [0.95, 1.025, 1.075, 1.035, 1.065], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const cameraY = interpolate(frame, [0, 92, 176, 320], [28, -12, 8, -18], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div style={{ position: 'absolute', left: videoSafeArea.left, top: videoSafeArea.top }}><LogoLockup compact /></div>
      <div style={{ position: 'absolute', left: 465, right: 120, top: 84, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 22, opacity: tourReveal, transform: `translateY(${(1 - tourReveal) * 18}px)` }}>
        <h2 style={{ flex: '1 1 auto', maxWidth: 690, margin: 0, color: brand.ink, fontFamily: displayFontFamily, fontSize: 32, fontWeight: 650, lineHeight: 1, letterSpacing: '-0.045em' }}>{content.proofHeadline}</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          {content.proofItems.slice(0, 4).map((item, index) => {
            const reveal = spring({ frame: frame - 8 - index * 4, fps, config: { damping: 19, stiffness: 115 } });
            return <span key={item} style={{ display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap', border: `1px solid ${brand.line}`, borderRadius: 999, background: 'rgba(255,255,255,0.04)', color: brand.inkSoft, padding: '7px 9px', fontFamily: bodyFontFamily, fontSize: 9, fontWeight: 750, opacity: reveal, transform: `translateX(${(1 - reveal) * 16}px)` }}><Check size={11} color={content.accent} /> {item}</span>;
          })}
        </div>
      </div>
      <div style={{ position: 'absolute', left: 160, top: 132, width: 1600, height: 720, opacity: tourReveal, translate: `${Math.sin(frame / 37) * 9}px ${cameraY + (1 - tourReveal) * 52}px`, scale: cameraScale * (0.95 + tourReveal * 0.05), rotate: `${Math.sin(frame / 81) * 0.2}deg`, transformOrigin: 'center top' }}>
        <ProductTour content={content} mode="proof" />
      </div>
    </div>
  );
};

export const CtaScene: React.FC<{ content: HubVideoContent }> = ({ content }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const logoReveal = spring({ frame, fps, config: { damping: 20, stiffness: 100 } });
  const titleReveal = spring({ frame: frame - 8, fps, config: { damping: 18, stiffness: 100 } });
  const buttonReveal = spring({ frame: frame - 18, fps, config: { damping: 16, stiffness: 120 } });
  const pulse = 1 + Math.sin(frame / 12) * 0.015;

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
      <div style={{ position: 'absolute', width: 920, height: 920, borderRadius: '50%', background: `radial-gradient(circle, ${content.accent}2d 0%, ${content.secondaryAccent}16 38%, transparent 70%)`, filter: 'blur(20px)', transform: `scale(${pulse})` }} />
      {[0, 1, 2].map((index) => <div key={index} style={{ position: 'absolute', width: 540 + index * 190, height: 540 + index * 190, border: `1px solid ${index % 2 ? content.secondaryAccent : content.accent}${index === 0 ? '66' : '30'}`, borderRadius: '50%', opacity: 0.34 - index * 0.07, rotate: `${frame * (index % 2 ? -0.16 : 0.12) + index * 28}deg`, scale: 0.96 + Math.sin(frame / (20 + index * 8)) * 0.035 }}><span style={{ position: 'absolute', left: '50%', top: -5, width: 10, height: 10, borderRadius: '50%', background: index % 2 ? content.secondaryAccent : content.accent, boxShadow: `0 0 24px ${content.accent}` }} /></div>)}
      <div style={{ position: 'relative', width: 1320, textAlign: 'center' }}>
        <div style={{ display: 'flex', justifyContent: 'center', opacity: logoReveal, transform: `translateY(${(1 - logoReveal) * -28}px)` }}><LogoLockup /></div>
        <p style={{ margin: '42px 0 0', color: content.accent, fontFamily: bodyFontFamily, fontSize: 14, fontWeight: 850, letterSpacing: '0.16em', textTransform: 'uppercase' }}>{content.productName}</p>
        <h2 style={{ margin: '18px 0 0', color: brand.ink, fontFamily: displayFontFamily, fontSize: 102, fontWeight: 630, lineHeight: 0.92, letterSpacing: '-0.068em', opacity: titleReveal, transform: `translateY(${(1 - titleReveal) * 46}px)` }}>{content.cta}</h2>
        <p style={{ margin: '25px 0 0', color: brand.inkSoft, fontFamily: bodyFontFamily, fontSize: 25, fontWeight: 500, letterSpacing: '-0.02em' }}>{content.ctaSupport}</p>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 16, marginTop: 40, opacity: buttonReveal, transform: `scale(${0.84 + buttonReveal * 0.16})` }}>
          {content.ctaButtons.map((label, index) => (
            <div key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 16, border: '1px solid rgba(255,255,255,0.2)', borderRadius: 999, background: index === 0 ? `linear-gradient(135deg, ${content.accent}, ${content.secondaryAccent})` : 'rgba(255,255,255,0.075)', boxShadow: index === 0 ? `0 28px 80px ${content.accent}42` : 'none', color: '#fff', padding: '20px 32px 21px', fontFamily: bodyFontFamily, fontSize: 19, fontWeight: 850 }}>{label} <ArrowRight size={24} /></div>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 10, marginTop: 32, color: brand.muted, fontFamily: bodyFontFamily, fontSize: 15, fontWeight: 650 }}><CircleCheck size={18} color={content.accent} /> hub.wisewolflanguage.com.br</div>
      </div>
    </div>
  );
};
