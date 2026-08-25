import React from 'react';
import {
  ArrowRight,
  Bot,
  CalendarDays,
  Check,
  CircleDollarSign,
  FileText,
  Headphones,
  LayoutDashboard,
  Library,
  LockKeyhole,
  Mic2,
  Search,
  ShieldCheck,
  Sparkles,
  Users,
  Workflow,
} from 'lucide-react';
import { Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { bodyFontFamily, displayFontFamily } from '../brand/fonts';
import { brand } from '../brand/tokens';
import type { HubVideoContent } from '../types';

const chromeDot = (color: string): React.CSSProperties => ({
  width: 12,
  height: 12,
  borderRadius: '50%',
  background: color,
});

const revealStyle = (progress: number, distance = 28): React.CSSProperties => ({
  opacity: progress,
  transform: `translateY(${(1 - progress) * distance}px) scale(${0.97 + progress * 0.03})`,
});

const MockWindow: React.FC<{
  title: string;
  status: string;
  accent: string;
  children: React.ReactNode;
}> = ({ title, status, accent, children }) => (
  <div
    style={{
      width: 1480,
      height: 720,
      overflow: 'hidden',
      border: `1px solid ${brand.line}`,
      borderRadius: 32,
      background: 'rgba(14, 16, 21, 0.95)',
      boxShadow: `0 48px 140px rgba(0,0,0,0.48), 0 0 90px ${accent}18`,
    }}
  >
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto 1fr',
        alignItems: 'center',
        height: 64,
        borderBottom: `1px solid ${brand.line}`,
        background: 'rgba(255,255,255,0.025)',
        padding: '0 24px',
      }}
    >
      <div style={{ display: 'flex', gap: 8 }}>
        <span style={chromeDot('#ff6f61')} />
        <span style={chromeDot('#ffbe55')} />
        <span style={chromeDot('#55ca7b')} />
      </div>
      <span style={{ color: brand.inkSoft, fontFamily: bodyFontFamily, fontSize: 16, fontWeight: 650 }}>{title}</span>
      <span
        style={{
          justifySelf: 'end',
          border: `1px solid ${accent}55`,
          borderRadius: 999,
          background: `${accent}18`,
          color: brand.ink,
          padding: '8px 13px',
          fontFamily: bodyFontFamily,
          fontSize: 12,
          fontWeight: 750,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
        }}
      >
        {status}
      </span>
    </div>
    <div style={{ height: 656 }}>{children}</div>
  </div>
);

const EcosystemMockup: React.FC<{ accent: string }> = ({ accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const phoneReveal = spring({ frame: frame - 4, fps, config: { damping: 18, stiffness: 110, mass: 0.8 } });
  const orbit = interpolate(frame, [0, 300], [-6, 8], { extrapolateRight: 'extend' });
  const nodes = [
    { icon: Library, title: 'Ensinar', detail: 'Biblioteca + Educador IA', color: '#d66a45', x: 40, y: 72 },
    { icon: Bot, title: 'Engajar', detail: 'Prática contextual', color: '#20a9cc', x: 980, y: 72 },
    { icon: Workflow, title: 'Crescer', detail: 'Comercial conectado', color: '#7652ed', x: 64, y: 450 },
    { icon: LayoutDashboard, title: 'Operar', detail: 'School OS', color: '#258e79', x: 990, y: 450 },
  ];

  return (
    <div style={{ position: 'relative', width: 1480, height: 720 }}>
      <div
        style={{
          position: 'absolute',
          inset: 70,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${accent}24 0%, transparent 66%)`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 557,
          top: 28,
          width: 366,
          height: 650,
          overflow: 'hidden',
          border: `1px solid ${brand.line}`,
          borderRadius: 44,
          background: '#f8f7f4',
          boxShadow: '0 35px 65px rgba(0,0,0,0.55)',
          transform: `translateY(${(1 - phoneReveal) * 80}px) rotate(${(1 - phoneReveal) * 3}deg) scale(${0.9 + phoneReveal * 0.1})`,
          opacity: phoneReveal,
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 8,
            borderRadius: 60,
            background: `radial-gradient(circle at 50% 55%, ${accent}35, transparent 68%)`,
            filter: 'blur(30px)',
          }}
        />
        <Img
          src={staticFile('assets/wolfie/standalone/hero-light-phone-v2.webp')}
          style={{ position: 'relative', width: '100%', height: '100%', objectFit: 'cover' }}
        />
      </div>
      {nodes.map(({ icon: Icon, title, detail, color, x, y }, index) => {
        const reveal = spring({ frame: frame - 16 - index * 7, fps, config: { damping: 20, stiffness: 120 } });
        const direction = index % 2 === 0 ? 1 : -1;
        return (
          <div
            key={title}
            style={{
              position: 'absolute',
              left: x,
              top: y + Math.sin((frame + index * 30) / 34) * orbit,
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              width: 360,
              border: `1px solid ${color}55`,
              borderRadius: 24,
              background: 'rgba(17,19,25,0.9)',
              boxShadow: `0 24px 70px rgba(0,0,0,0.35), inset 0 0 36px ${color}12`,
              padding: '18px 20px',
              opacity: reveal,
              transform: `translateX(${direction * (1 - reveal) * 80}px)`,
            }}
          >
            <span style={{ display: 'grid', width: 54, height: 54, placeItems: 'center', borderRadius: 17, background: `${color}22`, color }}><Icon size={25} /></span>
            <div><b style={{ display: 'block', color: brand.ink, fontFamily: displayFontFamily, fontSize: 24 }}>{title}</b><small style={{ color: brand.muted, fontFamily: bodyFontFamily, fontSize: 14 }}>{detail}</small></div>
          </div>
        );
      })}
      <div
        style={{
          position: 'absolute',
          left: 514,
          bottom: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          border: `1px solid ${brand.line}`,
          borderRadius: 999,
          background: 'rgba(7,8,11,0.86)',
          color: brand.ink,
          padding: '13px 22px',
          fontFamily: bodyFontFamily,
          fontSize: 14,
          fontWeight: 700,
        }}
      >
        <ShieldCheck size={19} color={accent} /> Conta, papel e ambiente separados
      </div>
    </div>
  );
};

const LibraryMockup: React.FC<{ accent: string }> = ({ accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const query = 'apresentação de resultados';
  const visibleCharacters = Math.max(0, Math.min(query.length, Math.floor((frame - 12) / 1.5)));
  const cards = [
    { level: 'B1', title: 'Presenting monthly results', type: 'Plano de aula · 60 min', color: '#d66a45' },
    { level: 'A2', title: 'Handling a reservation', type: 'Atividade · 45 min', color: '#ffad70' },
    { level: 'B2', title: 'Negotiating deadlines', type: 'Plano de aula · 60 min', color: '#7652ed' },
  ];

  return (
    <MockWindow title="Wise Wolf Library" status="Catálogo protegido" accent={accent}>
      <div style={{ display: 'grid', gridTemplateColumns: '245px 1fr', height: '100%' }}>
        <aside style={{ borderRight: `1px solid ${brand.line}`, padding: '30px 24px', background: 'rgba(255,255,255,0.018)' }}>
          <p style={{ margin: 0, color: brand.muted, fontFamily: bodyFontFamily, fontSize: 11, fontWeight: 800, letterSpacing: '0.16em' }}>COLEÇÕES</p>
          {['Business English', 'Conversation', 'Travel', 'Grammar in context'].map((item, index) => {
            const reveal = spring({ frame: frame - 10 - index * 5, fps, config: { damping: 22 } });
            return <div key={item} style={{ marginTop: 14, borderRadius: 13, background: index === 0 ? `${accent}22` : 'transparent', color: index === 0 ? brand.ink : brand.muted, padding: '13px 14px', fontFamily: bodyFontFamily, fontSize: 14, fontWeight: index === 0 ? 700 : 550, ...revealStyle(reveal, 12) }}>{item}</div>;
          })}
        </aside>
        <section style={{ padding: '26px 32px 24px' }}>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, height: 54, border: `1px solid ${brand.line}`, borderRadius: 16, background: 'rgba(255,255,255,0.025)', color: brand.inkSoft, padding: '0 18px', fontFamily: bodyFontFamily, fontSize: 15 }}>
              <Search size={18} color={accent} /> {query.slice(0, visibleCharacters)}<span style={{ width: 2, height: 21, background: accent, opacity: frame % 18 < 10 ? 1 : 0 }} />
            </div>
            {['B1', 'Business'].map((filter) => <span key={filter} style={{ display: 'grid', height: 54, placeItems: 'center', border: `1px solid ${accent}50`, borderRadius: 16, background: `${accent}18`, color: brand.ink, padding: '0 18px', fontFamily: bodyFontFamily, fontSize: 13, fontWeight: 750 }}>{filter}</span>)}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1.25fr 1fr 1fr', gap: 18, marginTop: 26 }}>
            {cards.map((card, index) => {
              const reveal = spring({ frame: frame - 32 - index * 8, fps, config: { damping: 18, stiffness: 115 } });
              return (
                <article key={card.title} style={{ minHeight: 404, border: `1px solid ${index === 0 ? card.color + '66' : brand.line}`, borderRadius: 24, background: index === 0 ? `linear-gradient(155deg, ${card.color}1f, rgba(255,255,255,0.025) 52%)` : 'rgba(255,255,255,0.026)', padding: 18, ...revealStyle(reveal) }}>
                  <div style={{ display: 'grid', height: 210, placeItems: 'center', borderRadius: 18, background: `linear-gradient(145deg, ${card.color}2f, ${card.color}0c)`, color: card.color }}>
                    <div style={{ textAlign: 'center' }}><span style={{ display: 'inline-grid', minWidth: 50, height: 34, placeItems: 'center', borderRadius: 999, background: `${card.color}28`, color: brand.ink, fontFamily: bodyFontFamily, fontSize: 13, fontWeight: 800 }}>{card.level}</span><FileText size={46} style={{ display: 'block', margin: '24px auto 0' }} /></div>
                  </div>
                  <h3 style={{ margin: '20px 0 0', color: brand.ink, fontFamily: displayFontFamily, fontSize: index === 0 ? 24 : 21, lineHeight: 1.06 }}>{card.title}</h3>
                  <p style={{ margin: '10px 0 0', color: brand.muted, fontFamily: bodyFontFamily, fontSize: 13 }}>{card.type}</p>
                  {index === 0 && <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 22, color: card.color, fontFamily: bodyFontFamily, fontSize: 13, fontWeight: 750 }}>Ver prévia <ArrowRight size={16} /></span>}
                </article>
              );
            })}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 18, color: brand.muted, fontFamily: bodyFontFamily, fontSize: 13 }}><ShieldCheck size={16} color={accent} /> Prévia pública. Arquivo completo somente com plano e permissão.</div>
        </section>
      </div>
    </MockWindow>
  );
};

const EducatorMockup: React.FC<{ accent: string }> = ({ accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const resultReveal = spring({ frame: frame - 34, fps, config: { damping: 19, stiffness: 105 } });
  const fields = [
    ['NÍVEL', 'B1'],
    ['DURAÇÃO', '60 minutos'],
    ['RESULTADO ESPERADO', 'Apresentar resultados e explicar um atraso com clareza.'],
  ];
  const steps = [
    ['01', 'Aquecimento', '10 min', 'Ative vocabulário e contexto.'],
    ['02', 'Experiência central', '25 min', 'Organize contexto, impacto e proposta.'],
    ['03', 'Prática guiada', '20 min', 'Simule a conversa com variações.'],
  ];

  return (
    <MockWindow title="Educador IA · novo plano" status="Base para adaptar" accent={accent}>
      <div style={{ display: 'grid', gridTemplateColumns: '0.76fr 1.24fr', height: '100%' }}>
        <section style={{ borderRight: `1px solid ${brand.line}`, padding: '34px 32px' }}>
          <p style={{ margin: 0, color: accent, fontFamily: bodyFontFamily, fontSize: 12, fontWeight: 800, letterSpacing: '0.14em' }}>CONTEXTO PEDAGÓGICO</p>
          {fields.map(([label, value], index) => {
            const reveal = spring({ frame: frame - 8 - index * 7, fps, config: { damping: 21 } });
            return (
              <div key={label} style={{ marginTop: 18, border: `1px solid ${brand.line}`, borderRadius: 17, background: 'rgba(255,255,255,0.025)', padding: '15px 17px', ...revealStyle(reveal, 18) }}>
                <small style={{ display: 'block', color: brand.muted, fontFamily: bodyFontFamily, fontSize: 10, fontWeight: 800, letterSpacing: '0.12em' }}>{label}</small>
                <span style={{ display: 'block', marginTop: 7, color: brand.ink, fontFamily: bodyFontFamily, fontSize: index === 2 ? 17 : 19, fontWeight: 650, lineHeight: 1.25 }}>{value}</span>
              </div>
            );
          })}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, height: 56, marginTop: 22, borderRadius: 17, background: `linear-gradient(135deg, ${accent}, #a17fff)`, color: '#fff', boxShadow: `0 20px 50px ${accent}33`, fontFamily: bodyFontFamily, fontSize: 15, fontWeight: 800 }}><Sparkles size={18} /> Estruturar aula</div>
        </section>
        <section style={{ padding: '34px 34px 28px', opacity: resultReveal, transform: `translateX(${(1 - resultReveal) * 68}px)` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
            <div><p style={{ margin: 0, color: accent, fontFamily: bodyFontFamily, fontSize: 11, fontWeight: 800, letterSpacing: '0.14em' }}>PLANO ESTRUTURADO</p><h3 style={{ margin: '9px 0 0', color: brand.ink, fontFamily: displayFontFamily, fontSize: 31, letterSpacing: '-0.045em' }}>From update to next step</h3></div>
            <span style={{ borderRadius: 999, background: `${accent}1f`, color: brand.ink, padding: '10px 14px', fontFamily: bodyFontFamily, fontSize: 12, fontWeight: 750 }}>60 min</span>
          </div>
          <div style={{ marginTop: 25 }}>
            {steps.map(([number, title, time, detail], index) => {
              const reveal = spring({ frame: frame - 44 - index * 8, fps, config: { damping: 20 } });
              return (
                <article key={number} style={{ display: 'grid', gridTemplateColumns: '54px 1fr auto', alignItems: 'center', gap: 15, minHeight: 98, marginTop: index === 0 ? 0 : 13, border: `1px solid ${brand.line}`, borderRadius: 19, background: 'rgba(255,255,255,0.024)', padding: '14px 18px', ...revealStyle(reveal, 18) }}>
                  <span style={{ display: 'grid', width: 48, height: 48, placeItems: 'center', borderRadius: 15, background: `${accent}1d`, color: accent, fontFamily: displayFontFamily, fontSize: 17, fontWeight: 800 }}>{number}</span>
                  <div><b style={{ display: 'block', color: brand.ink, fontFamily: displayFontFamily, fontSize: 20 }}>{title}</b><small style={{ display: 'block', marginTop: 5, color: brand.muted, fontFamily: bodyFontFamily, fontSize: 13 }}>{detail}</small></div>
                  <em style={{ color: brand.inkSoft, fontFamily: bodyFontFamily, fontSize: 12, fontStyle: 'normal', fontWeight: 700 }}>{time}</em>
                </article>
              );
            })}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 18, borderRadius: 15, background: `${accent}18`, color: brand.ink, padding: '13px 16px', fontFamily: bodyFontFamily, fontSize: 13, fontWeight: 700 }}><Check size={16} color={accent} /> Continuidade fora da aula incluída</div>
        </section>
      </div>
    </MockWindow>
  );
};

const WolfieMockup: React.FC<{ accent: string }> = ({ accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const characterReveal = spring({ frame: frame - 6, fps, config: { damping: 18, stiffness: 105 } });
  const listening = frame % 150 < 76;
  const waveHeights = [18, 32, 45, 24, 52, 38, 62, 30, 44, 22, 56, 35, 48, 27, 40, 22];

  return (
    <div style={{ position: 'relative', width: 1480, height: 720, overflow: 'hidden', border: `1px solid ${brand.line}`, borderRadius: 32, background: '#0d1420', boxShadow: `0 48px 140px rgba(0,0,0,0.5), 0 0 100px ${accent}20` }}>
      <Img src={staticFile('assets/wolfie/scenes/career/job-interviews/desktop.dc0f18a9a9dc.webp')} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${1.05 + frame / 11000})` }} />
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(90deg, rgba(4,9,17,0.92) 0%, rgba(4,9,17,0.42) 52%, rgba(4,9,17,0.82) 100%)' }} />
      <div style={{ position: 'absolute', left: 30, right: 30, top: 26, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10, border: `1px solid ${brand.line}`, borderRadius: 999, background: 'rgba(4,9,17,0.7)', color: brand.ink, padding: '11px 17px', fontFamily: bodyFontFamily, fontSize: 13, fontWeight: 750 }}><Bot size={18} color={accent} /> Wolfie AI Tutor</span>
        <span style={{ border: `1px solid ${accent}55`, borderRadius: 999, background: `${accent}20`, color: brand.ink, padding: '10px 16px', fontFamily: bodyFontFamily, fontSize: 12, fontWeight: 750 }}>SESSÃO ATIVA</span>
      </div>
      <div style={{ position: 'absolute', left: 610, bottom: -35, width: 520, height: 620, opacity: characterReveal, transform: `translateY(${(1 - characterReveal) * 90 + Math.sin(frame / 18) * 5}px) scale(${0.92 + characterReveal * 0.08})` }}>
        <Img src={staticFile('assets/wolfie/characters/wolfie-coach/wolfie-v2-listening.07cf0629cc2d.webp')} style={{ width: '100%', height: '100%', objectFit: 'contain', filter: `drop-shadow(0 38px 60px rgba(0,0,0,0.48)) drop-shadow(0 0 45px ${accent}32)` }} />
      </div>
      <div style={{ position: 'absolute', left: 62, top: 170, width: 520 }}>
        <p style={{ margin: 0, color: accent, fontFamily: bodyFontFamily, fontSize: 12, fontWeight: 850, letterSpacing: '0.16em' }}>ENTREVISTA · B1</p>
        <h3 style={{ margin: '18px 0 0', color: brand.ink, fontFamily: displayFontFamily, fontSize: 48, lineHeight: 0.98, letterSpacing: '-0.055em' }}>{listening ? 'Conte sua experiência no seu ritmo.' : 'Vamos deixar sua resposta mais natural.'}</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 84, marginTop: 30 }}>
          {waveHeights.map((height, index) => {
            const movement = Math.sin((frame + index * 7) / 6) * 12;
            return <span key={`${height}-${index}`} style={{ width: 7, height: Math.max(12, height + movement), borderRadius: 999, background: index % 3 === 0 ? '#fff' : accent, opacity: 0.65 + (index % 4) * 0.08 }} />;
          })}
        </div>
      </div>
      <div style={{ position: 'absolute', right: 48, top: 166, display: 'grid', gap: 14, width: 330 }}>
        {[
          { icon: Headphones, label: 'Escutar contexto', active: listening },
          { icon: Mic2, label: 'Responder no seu nível', active: !listening },
          { icon: Check, label: 'Tentar novamente', active: false },
        ].map(({ icon: Icon, label, active }, index) => {
          const reveal = spring({ frame: frame - 22 - index * 8, fps, config: { damping: 19 } });
          return <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 14, border: `1px solid ${active ? accent + '70' : brand.line}`, borderRadius: 19, background: active ? `${accent}25` : 'rgba(4,9,17,0.72)', color: brand.ink, padding: '16px 18px', fontFamily: bodyFontFamily, fontSize: 14, fontWeight: 700, ...revealStyle(reveal, 16) }}><span style={{ display: 'grid', width: 42, height: 42, placeItems: 'center', borderRadius: 13, background: `${accent}22`, color: accent }}><Icon size={20} /></span>{label}</div>;
        })}
      </div>
      <div style={{ position: 'absolute', left: 62, right: 62, bottom: 32, display: 'flex', alignItems: 'center', justifyContent: 'space-between', border: `1px solid ${brand.line}`, borderRadius: 18, background: 'rgba(4,9,17,0.76)', color: brand.inkSoft, padding: '15px 20px', fontFamily: bodyFontFamily, fontSize: 13 }}><span>Prática privada · contexto protegido por usuário</span><span style={{ color: accent, fontWeight: 750 }}>Objetivo: entrevista internacional</span></div>
    </div>
  );
};

const SchoolMockup: React.FC<{ accent: string }> = ({ accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const stats = [
    { icon: CalendarDays, label: 'COMERCIAL', value: 'Jornada visível' },
    { icon: Users, label: 'EQUIPE', value: 'Papéis definidos' },
    { icon: CircleDollarSign, label: 'FINANCEIRO', value: 'Cobranças visíveis' },
  ];
  const flows = [
    ['Aula experimental · novo contato', 'Comercial', 'Confirmar'],
    ['Contrato e primeira cobrança', 'Financeiro', 'Preparado'],
    ['Acesso do professor', 'Direção', 'Restrito'],
  ];

  return (
    <MockWindow title="Wise Wolf School OS" status="Ambiente da escola" accent={accent}>
      <div style={{ display: 'grid', gridTemplateColumns: '92px 1fr', height: '100%' }}>
        <aside style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, borderRight: `1px solid ${brand.line}`, background: 'rgba(255,255,255,0.018)', paddingTop: 24 }}>
          <span style={{ display: 'grid', width: 48, height: 48, placeItems: 'center', borderRadius: 15, background: accent, color: '#fff', fontFamily: displayFontFamily, fontSize: 23, fontWeight: 850 }}>W</span>
          {[LayoutDashboard, CalendarDays, Users, CircleDollarSign, ShieldCheck].map((Icon, index) => <span key={index} style={{ display: 'grid', width: 48, height: 48, placeItems: 'center', borderRadius: 14, background: index === 0 ? `${accent}25` : 'transparent', color: index === 0 ? accent : brand.muted }}><Icon size={21} /></span>)}
        </aside>
        <section style={{ padding: '28px 34px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
            <div><p style={{ margin: 0, color: accent, fontFamily: bodyFontFamily, fontSize: 11, fontWeight: 850, letterSpacing: '0.15em' }}>OPERAÇÃO DA ESCOLA</p><h3 style={{ margin: '8px 0 0', color: brand.ink, fontFamily: displayFontFamily, fontSize: 32, letterSpacing: '-0.045em' }}>Hoje, sem pontos cegos.</h3></div>
            <span style={{ display: 'flex', alignItems: 'center', gap: 9, border: `1px solid ${accent}52`, borderRadius: 999, background: `${accent}18`, color: brand.ink, padding: '10px 15px', fontFamily: bodyFontFamily, fontSize: 12, fontWeight: 750 }}><LockKeyhole size={15} color={accent} /> Direção</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginTop: 24 }}>
            {stats.map(({ icon: Icon, label, value }, index) => {
              const reveal = spring({ frame: frame - 10 - index * 7, fps, config: { damping: 20 } });
              return <article key={label} style={{ border: `1px solid ${brand.line}`, borderRadius: 19, background: 'rgba(255,255,255,0.026)', padding: '18px 19px', ...revealStyle(reveal, 18) }}><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><Icon size={20} color={accent} /><small style={{ color: brand.muted, fontFamily: bodyFontFamily, fontSize: 10, fontWeight: 800, letterSpacing: '0.12em' }}>{label}</small></div><b style={{ display: 'block', marginTop: 19, color: brand.ink, fontFamily: displayFontFamily, fontSize: 21 }}>{value}</b><span style={{ display: 'block', marginTop: 8, color: accent, fontFamily: bodyFontFamily, fontSize: 11, fontWeight: 700 }}>ver fluxo</span></article>;
            })}
          </div>
          <div style={{ marginTop: 24, overflow: 'hidden', border: `1px solid ${brand.line}`, borderRadius: 22, background: 'rgba(255,255,255,0.022)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1.8fr 0.72fr 0.62fr', borderBottom: `1px solid ${brand.line}`, color: brand.muted, padding: '13px 20px', fontFamily: bodyFontFamily, fontSize: 10, fontWeight: 800, letterSpacing: '0.12em' }}><span>PRÓXIMOS FLUXOS</span><span>RESPONSÁVEL</span><span>STATUS</span></div>
            {flows.map(([flow, owner, status], index) => {
              const reveal = spring({ frame: frame - 38 - index * 8, fps, config: { damping: 21 } });
              return <div key={flow} style={{ display: 'grid', gridTemplateColumns: '1.8fr 0.72fr 0.62fr', alignItems: 'center', minHeight: 72, borderBottom: index === flows.length - 1 ? 0 : `1px solid ${brand.line}`, color: brand.ink, padding: '0 20px', fontFamily: bodyFontFamily, fontSize: 13, ...revealStyle(reveal, 16) }}><b style={{ fontWeight: 650 }}>{flow}</b><span style={{ color: brand.muted }}>{owner}</span><em style={{ width: 'fit-content', borderRadius: 999, background: `${accent}1d`, color: accent, padding: '7px 10px', fontSize: 10, fontStyle: 'normal', fontWeight: 800 }}>{status}</em></div>;
            })}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 18, color: brand.muted, fontFamily: bodyFontFamily, fontSize: 12 }}><span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><ShieldCheck size={15} color={accent} /> Dados isolados por escola</span><span>Marca · credenciais · permissões</span></div>
        </section>
      </div>
    </MockWindow>
  );
};

export const ProductMockup: React.FC<{
  content: HubVideoContent;
}> = ({ content }) => {
  if (content.mockup === 'library') return <LibraryMockup accent={content.accent} />;
  if (content.mockup === 'educator') return <EducatorMockup accent={content.accent} />;
  if (content.mockup === 'wolfie') return <WolfieMockup accent={content.accent} />;
  if (content.mockup === 'school') return <SchoolMockup accent={content.accent} />;
  return <EcosystemMockup accent={content.accent} />;
};
