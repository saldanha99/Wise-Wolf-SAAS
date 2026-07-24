const DEFAULT_PRIMARY_COLOR = '#002366';
const DEFAULT_SECONDARY_COLOR = '#D32F2F';

const HEX_COLOR_PATTERN = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

export const normalizeHexColor = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string' || !HEX_COLOR_PATTERN.test(value.trim())) {
    return fallback;
  }

  const raw = value.trim().replace(/^#/, '');
  const expanded = raw.length === 3
    ? raw.split('').map((character) => character.repeat(2)).join('')
    : raw;

  return `#${expanded.toUpperCase()}`;
};

const hexToRgbChannels = (hex: string): string => {
  const normalized = normalizeHexColor(hex, DEFAULT_PRIMARY_COLOR).slice(1);
  const channels = [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];

  return channels.join(' ');
};

export const applyTenantBranding = (
  primaryColor?: unknown,
  secondaryColor?: unknown,
) => {
  const primary = normalizeHexColor(primaryColor, DEFAULT_PRIMARY_COLOR);
  const secondary = normalizeHexColor(secondaryColor, DEFAULT_SECONDARY_COLOR);
  const root = document.documentElement;

  root.style.setProperty('--primary-color', primary);
  root.style.setProperty('--secondary-color', secondary);
  root.style.setProperty('--tenant-primary-rgb', hexToRgbChannels(primary));

  return { primaryColor: primary, secondaryColor: secondary };
};

export const resetTenantBranding = () =>
  applyTenantBranding(DEFAULT_PRIMARY_COLOR, DEFAULT_SECONDARY_COLOR);
