import React from 'react';
import { bodyFontFamily } from '../../brand/fonts';
import { LogoLockup } from '../../components/LogoLockup';
import type { HubVideoContent, HubVideoFormat } from '../../types';

export const FilmChrome: React.FC<{
  content: HubVideoContent;
  format: HubVideoFormat;
  label: string;
}> = ({ content, format, label }) => {
  const story = format === 'story';

  return (
    <>
      <div style={{
        position: 'absolute',
        zIndex: 70,
        left: story ? 54 : 72,
        right: story ? 54 : 72,
        top: story ? 72 : 46,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <LogoLockup compact />
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          maxWidth: story ? 470 : 520,
          border: `1px solid ${content.accent}4f`,
          borderRadius: 999,
          background: 'rgba(5, 6, 9, 0.72)',
          boxShadow: `0 14px 46px rgba(0,0,0,0.34), 0 0 34px ${content.accent}18`,
          color: 'rgba(255,255,255,0.86)',
          padding: story ? '11px 15px' : '9px 14px',
          fontFamily: bodyFontFamily,
          fontSize: story ? 14 : 11,
          fontWeight: 850,
          letterSpacing: '0.11em',
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
        }}>
          <span style={{ width: 7, height: 7, flex: '0 0 auto', borderRadius: '50%', background: content.accent, boxShadow: `0 0 18px ${content.accent}` }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        </div>
      </div>

    </>
  );
};
