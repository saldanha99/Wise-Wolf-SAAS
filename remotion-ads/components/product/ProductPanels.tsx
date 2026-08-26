import React from 'react';
import { spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { bodyFontFamily, displayFontFamily } from '../../brand/fonts';
import type { AdPanelId } from '../../types';
import { fs, type AdLayout } from '../layout';

/**
 * Painéis do produto desenhados no vídeo, com os NÚMEROS REAIS da operação.
 *
 * Por que não uma captura de tela:
 *
 * 1. As capturas que existem no repositório vêm de ambiente de QA vazio — R$ 0,00 de
 *    faturamento, "BASEADO EM 1 ALUNOS ATIVOS", e a tarja "Diretor QA Responsivo" no
 *    topo. Uma delas é uma tela de erro. Mostrar isso num anúncio pago depõe contra o
 *    produto (ver docs/qa/2026-07-24-role-responsive-audit/).
 * 2. Mesmo com captura boa, um PNG de 1440x900 encolhido para caber num quadro 1080x1920
 *    fica ilegível no celular. Em Reels, o que funciona é UM número grande, não a tela
 *    inteira.
 *
 * O que estes painéis mostram é a mesma estrutura, os mesmos rótulos e os mesmos números
 * que o diretor vê no sistema. Os valores foram lidos do banco de produção em 25/08/2026
 * e estão anotados em cada componente. Quando um número mudar de ordem de grandeza,
 * atualize aqui — ou volte a puxar do banco.
 */

const INK = '#0f172a';
const INK_SOFT = '#64748b';
const SURFACE = '#ffffff';
const SURFACE_SOFT = '#f1f5f9';
const NAVY = '#002366';

/** Progresso 0-1 de uma animação linear, sem depender da sobrecarga de `interpolate`. */
const ramp = (frame: number, delay: number, frames: number): number => {
  const t = (frame - delay) / frames;
  return t < 0 ? 0 : t > 1 ? 1 : t;
};

const brl = (value: number) =>
  value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2 });

const Panel: React.FC<{ layout: AdLayout; children: React.ReactNode; title: string; badge?: string }> = ({
  layout,
  children,
  title,
  badge,
}) => (
  <div
    style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: SURFACE,
      borderRadius: fs(layout, 22, 10),
      overflow: 'hidden',
    }}
  >
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: `${fs(layout, 18, 8)}px ${fs(layout, 24, 10)}px`,
        borderBottom: `1px solid ${SURFACE_SOFT}`,
      }}
    >
      <span
        style={{
          color: INK,
          fontFamily: displayFontFamily,
          fontSize: fs(layout, 28, 13),
          fontWeight: 750,
          letterSpacing: '-0.02em',
        }}
      >
        {title}
      </span>
      {badge && (
        <span
          style={{
            padding: `${fs(layout, 6, 3)}px ${fs(layout, 12, 6)}px`,
            borderRadius: 999,
            background: '#dcfce7',
            color: '#15803d',
            fontFamily: bodyFontFamily,
            fontSize: fs(layout, 18, 9),
            fontWeight: 800,
          }}
        >
          {badge}
        </span>
      )}
    </div>
    <div style={{ flex: 1, padding: fs(layout, 24, 10), display: 'flex', flexDirection: 'column', gap: fs(layout, 16, 7) }}>
      {children}
    </div>
  </div>
);

/** Um número grande que sobe do zero. É o que se lê num Reels. */
const CountUp: React.FC<{
  layout: AdLayout;
  label: string;
  value: number;
  currency?: boolean;
  accent?: string;
  delay?: number;
  size?: number;
}> = ({ layout, label, value, currency = false, accent = NAVY, delay = 0, size }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = spring({ frame: frame - delay, fps, config: { damping: 26, stiffness: 70, mass: 1.1 } });
  const shown = value * progress;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: fs(layout, 4, 2) }}>
      <span
        style={{
          color: INK_SOFT,
          fontFamily: bodyFontFamily,
          fontSize: fs(layout, 19, 9),
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </span>
      <span
        style={{
          color: accent,
          fontFamily: displayFontFamily,
          fontSize: fs(layout, size ?? 52, 22),
          fontWeight: 800,
          letterSpacing: '-0.04em',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {currency ? brl(shown) : Math.round(shown).toLocaleString('pt-BR')}
      </span>
    </div>
  );
};

/**
 * Resumo financeiro do diretor.
 * Produção em 25/08/2026: recebido no mês R$ 8.327,04 · 56 alunos ativos · 343 aulas no mês.
 */
export const FinancePanel: React.FC<{ layout: AdLayout }> = ({ layout }) => (
  <Panel layout={layout} title="Resumo do mês" badge="Superávit">
    <CountUp layout={layout} label="Recebido no mês" value={8327.04} currency accent="#15803d" delay={6} size={58} />
    <div style={{ display: 'flex', gap: fs(layout, 22, 10) }}>
      <CountUp layout={layout} label="Alunos ativos" value={56} delay={16} size={40} />
      <CountUp layout={layout} label="Aulas no mês" value={343} delay={22} size={40} />
    </div>
    <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: fs(layout, 7, 3) }}>
      {[
        { label: 'Mensalidades', share: 1 },
        { label: 'Folha de professores', share: 0.42 },
      ].map((row, index) => (
        <div key={row.label} style={{ display: 'flex', flexDirection: 'column', gap: fs(layout, 4, 2) }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: INK_SOFT, fontFamily: bodyFontFamily, fontSize: fs(layout, 18, 9), fontWeight: 650 }}>
              {row.label}
            </span>
          </div>
          <Bar layout={layout} share={row.share} delay={28 + index * 6} color={index === 0 ? '#15803d' : '#f97316'} />
        </div>
      ))}
    </div>
  </Panel>
);

const Bar: React.FC<{ layout: AdLayout; share: number; delay: number; color: string }> = ({
  layout,
  share,
  delay,
  color,
}) => {
  const frame = useCurrentFrame();
  const grow = ramp(frame, delay, 22) * share;
  return (
    <div style={{ height: fs(layout, 10, 5), borderRadius: 999, background: SURFACE_SOFT, overflow: 'hidden' }}>
      <div style={{ width: `${grow * 100}%`, height: '100%', borderRadius: 999, background: color }} />
    </div>
  );
};

/**
 * Verificação de presença — a segunda fonte independente.
 * Produção em 25/08/2026: 1.028 confirmações enviadas, 278 confirmadas pelos alunos.
 */
export const AttendancePanel: React.FC<{ layout: AdLayout }> = ({ layout }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const rows = [
    { who: 'Professor lançou a aula', when: 'ter, 19:00', ok: true },
    { who: 'Aluno confirmou pelo WhatsApp', when: 'ter, 19:41', ok: true },
  ];

  return (
    <Panel layout={layout} title="Verificar presença" badge="Conferido">
      {rows.map((row, index) => {
        const enter = spring({ frame: frame - 8 - index * 12, fps, config: { damping: 22, stiffness: 90 } });
        return (
          <div
            key={row.who}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: fs(layout, 14, 6),
              padding: fs(layout, 16, 7),
              borderRadius: fs(layout, 14, 6),
              background: SURFACE_SOFT,
              opacity: enter,
              translate: `${(1 - enter) * -18}px 0`,
            }}
          >
            <span
              style={{
                flex: '0 0 auto',
                width: fs(layout, 34, 15),
                height: fs(layout, 34, 15),
                borderRadius: 999,
                background: '#15803d',
                color: '#fff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: bodyFontFamily,
                fontSize: fs(layout, 22, 10),
                fontWeight: 900,
              }}
            >
              ✓
            </span>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ color: INK, fontFamily: bodyFontFamily, fontSize: fs(layout, 23, 11), fontWeight: 700 }}>
                {row.who}
              </span>
              <span style={{ color: INK_SOFT, fontFamily: bodyFontFamily, fontSize: fs(layout, 19, 9) }}>{row.when}</span>
            </div>
          </div>
        );
      })}
      <div style={{ marginTop: 'auto' }}>
        <CountUp layout={layout} label="Aulas confirmadas pelos alunos" value={278} delay={30} accent="#15803d" size={50} />
      </div>
    </Panel>
  );
};

/** Funil comercial. Produção em 25/08/2026: 126 leads no CRM. */
export const CrmPanel: React.FC<{ layout: AdLayout }> = ({ layout }) => {
  const frame = useCurrentFrame();
  const stages = [
    { label: 'Novo contato', share: 1, color: '#3b82f6' },
    { label: 'Aula experimental', share: 0.62, color: '#8b5cf6' },
    { label: 'Matriculado', share: 0.34, color: '#15803d' },
  ];

  return (
    <Panel layout={layout} title="Funil comercial">
      <CountUp layout={layout} label="Contatos no funil" value={126} delay={6} size={54} />
      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: fs(layout, 12, 5) }}>
        {stages.map((stage, index) => {
          const grow = ramp(frame, 14 + index * 7, 22) * stage.share;
          return (
            <div key={stage.label} style={{ display: 'flex', flexDirection: 'column', gap: fs(layout, 5, 2) }}>
              <span style={{ color: INK_SOFT, fontFamily: bodyFontFamily, fontSize: fs(layout, 19, 9), fontWeight: 650 }}>
                {stage.label}
              </span>
              <div style={{ height: fs(layout, 18, 8), borderRadius: 999, background: SURFACE_SOFT, overflow: 'hidden' }}>
                <div style={{ width: `${grow * 100}%`, height: '100%', borderRadius: 999, background: stage.color }} />
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
};

/**
 * Conversa do aluno com o Wolfie.
 * A troca abaixo é ILUSTRATIVA da mecânica (fala → correção → devolutiva), não a
 * transcrição de uma sessão real de aluno: sessão de aluno é dado pessoal e não vai
 * para anúncio.
 */
export const WolfiePanel: React.FC<{ layout: AdLayout }> = ({ layout }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const turns = [
    { from: 'wolfie', text: 'So, tell me about your last project.' },
    { from: 'aluno', text: 'I work in a project about... water treatment.' },
    { from: 'correcao', text: '“I worked on a project” — passado + “on”.' },
  ];

  return (
    <Panel layout={layout} title="Praticar com o Wolfie" badge="Entrevista">
      {turns.map((turn, index) => {
        const enter = spring({ frame: frame - 8 - index * 14, fps, config: { damping: 22, stiffness: 92 } });
        const isCorrection = turn.from === 'correcao';
        const isStudent = turn.from === 'aluno';
        return (
          <div
            key={turn.text}
            style={{
              alignSelf: isStudent ? 'flex-end' : 'flex-start',
              maxWidth: '86%',
              padding: `${fs(layout, 13, 6)}px ${fs(layout, 17, 8)}px`,
              borderRadius: fs(layout, 16, 7),
              background: isCorrection ? '#fef3c7' : isStudent ? NAVY : SURFACE_SOFT,
              color: isCorrection ? '#92400e' : isStudent ? '#fff' : INK,
              border: isCorrection ? '1px solid #fcd34d' : 'none',
              fontFamily: bodyFontFamily,
              fontSize: fs(layout, 23, 11),
              fontWeight: isCorrection ? 700 : 600,
              lineHeight: 1.35,
              opacity: enter,
              translate: `0 ${(1 - enter) * 16}px`,
            }}
          >
            {turn.text}
          </div>
        );
      })}
    </Panel>
  );
};

export const PRODUCT_PANELS: Record<AdPanelId, React.FC<{ layout: AdLayout }>> = {
  finance: FinancePanel,
  attendance: AttendancePanel,
  crm: CrmPanel,
  wolfie: WolfiePanel,
};
