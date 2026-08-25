import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { brand } from '../brand/tokens';

const PARTICLES = Array.from({ length: 34 }, (_, index) => ({
  left: (index * 37 + 11) % 100,
  top: (index * 53 + 7) % 100,
  size: 2 + (index % 4),
  speed: 0.28 + (index % 7) * 0.055,
  phase: index * 0.73,
  depth: 0.42 + (index % 5) * 0.12,
}));

export const BrandBackground: React.FC<{
  accent: string;
  secondaryAccent: string;
  intensity?: number;
}> = ({ accent, secondaryAccent, intensity = 1 }) => {
  const frame = useCurrentFrame();
  const driftX = Math.sin(frame / 73) * 86 + Math.sin(frame / 181) * 34;
  const driftY = Math.cos(frame / 91) * 68 + Math.sin(frame / 149) * 31;
  const gridX = interpolate(frame, [0, 420], [0, 88], { extrapolateRight: 'extend' });
  const gridY = interpolate(frame, [0, 420], [0, 44], { extrapolateRight: 'extend' });
  const sweepX = interpolate(frame % 280, [0, 280], [-28, 128]);
  const pulse = 0.72 + Math.sin(frame / 19) * 0.16 + Math.sin(frame / 47) * 0.1;

  return (
    <AbsoluteFill style={{ overflow: 'hidden', background: brand.background }}>
      <AbsoluteFill
        style={{
          opacity: 0.24 + intensity * 0.2,
          backgroundImage: `linear-gradient(${brand.line} 1px, transparent 1px), linear-gradient(90deg, ${brand.line} 1px, transparent 1px)`,
          backgroundSize: '88px 88px',
          backgroundPosition: `${gridX}px ${gridY}px`,
          maskImage: 'linear-gradient(to bottom, rgba(0,0,0,0.72), transparent 78%)',
        }}
      />
      <AbsoluteFill
        style={{
          opacity: 0.14 + intensity * 0.08,
          backgroundImage: `repeating-linear-gradient(112deg, transparent 0 112px, ${accent}42 113px 114px, transparent 115px 226px)`,
          backgroundPosition: `${-gridX * 0.7}px ${gridY * 0.3}px`,
          maskImage: 'radial-gradient(ellipse at center, black 0%, transparent 76%)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: 1080,
          height: 720,
          right: -350,
          top: -380,
          borderRadius: '48%',
          background: `radial-gradient(ellipse, ${accent}9c 0%, ${accent}30 34%, transparent 70%)`,
          filter: 'blur(34px)',
          opacity: (0.56 + pulse * 0.22) * intensity,
          translate: `${driftX}px ${driftY}px`,
          rotate: `${frame / 34}deg`,
          scale: 0.94 + Math.sin(frame / 52) * 0.06,
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: 980,
          height: 700,
          left: -410,
          bottom: -390,
          borderRadius: '46%',
          background: `radial-gradient(ellipse, ${secondaryAccent}82 0%, ${secondaryAccent}28 38%, transparent 72%)`,
          filter: 'blur(42px)',
          opacity: (0.48 + (1 - pulse) * 0.24) * intensity,
          translate: `${-driftX * 0.52}px ${-driftY * 0.34}px`,
          rotate: `${-frame / 42}deg`,
          scale: 0.96 + Math.cos(frame / 61) * 0.07,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: `${sweepX}%`,
          top: -260,
          width: 260,
          height: 1600,
          background: `linear-gradient(90deg, transparent, ${accent}12, rgba(255,255,255,0.12), ${secondaryAccent}12, transparent)`,
          filter: 'blur(22px)',
          rotate: '11deg',
          opacity: 0.5 * intensity,
        }}
      />
      {PARTICLES.map((particle, index) => {
        const x = Math.sin(frame * particle.speed / 18 + particle.phase) * 28 * particle.depth;
        const y = Math.cos(frame * particle.speed / 24 + particle.phase) * 22 * particle.depth;
        const particlePulse = 0.32 + (Math.sin(frame / 9 + particle.phase) + 1) * 0.25;
        return (
          <span
            key={index}
            style={{
              position: 'absolute',
              left: `${particle.left}%`,
              top: `${particle.top}%`,
              width: particle.size,
              height: particle.size,
              borderRadius: '50%',
              background: index % 3 === 0 ? secondaryAccent : index % 2 === 0 ? accent : '#fff',
              boxShadow: `0 0 ${8 + particle.size * 3}px ${index % 3 === 0 ? secondaryAccent : accent}`,
              opacity: particlePulse * intensity,
              translate: `${x}px ${y}px`,
              scale: 0.7 + particlePulse * 0.55,
            }}
          />
        );
      })}
      <AbsoluteFill
        style={{
          background: 'linear-gradient(115deg, rgba(7,8,11,0.96) 0%, rgba(7,8,11,0.42) 52%, rgba(7,8,11,0.82) 100%)',
        }}
      />
      <AbsoluteFill
        style={{
          opacity: 0.06,
          backgroundImage: 'radial-gradient(rgba(255,255,255,0.75) 0.7px, transparent 0.8px)',
          backgroundSize: '5px 5px',
          backgroundPosition: `${frame % 5}px ${(frame * 0.61) % 5}px`,
          mixBlendMode: 'soft-light',
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 24,
          border: `1px solid ${brand.line}`,
          borderRadius: 34,
          boxShadow: `inset 0 0 120px rgba(255,255,255,0.018), inset 0 0 70px ${accent}08`,
        }}
      />
    </AbsoluteFill>
  );
};
