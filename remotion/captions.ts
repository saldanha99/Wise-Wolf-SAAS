import type { HubVideoCaption } from './types';

const fixed = (value: number) => Number(value.toFixed(3));

const formatTimestamp = (seconds: number): string => {
  const totalMilliseconds = Math.max(0, Math.round(seconds * 1000));
  const milliseconds = totalMilliseconds % 1000;
  const totalSeconds = Math.floor(totalMilliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
};

export const balanceHubCaptions = (captions: HubVideoCaption[]): HubVideoCaption[] => {
  const balanced: HubVideoCaption[] = [];

  for (const caption of captions) {
    const previous = balanced.at(-1);
    const wordCount = caption.text.trim().split(/\s+/u).length;
    const gapSeconds = previous ? caption.startSeconds - previous.endSeconds : Number.POSITIVE_INFINITY;
    const shouldMerge = previous
      && wordCount <= 2
      && caption.text.length <= 18
      && gapSeconds <= 0.65
      && `${previous.text} ${caption.text}`.length <= 64;

    if (shouldMerge) {
      previous.text = `${previous.text} ${caption.text}`;
      previous.endSeconds = fixed(caption.endSeconds);
      previous.endMs = Number.isFinite(caption.endMs) ? caption.endMs : Math.round(caption.endSeconds * 1000);
      if (previous.tokens && caption.tokens) {
        previous.tokens = [...previous.tokens, ...caption.tokens];
      } else if (previous.tokens || caption.tokens) {
        previous.tokens = undefined;
      }
    } else {
      balanced.push({
        ...caption,
        tokens: caption.tokens ? [...caption.tokens] : undefined,
        startMs: Number.isFinite(caption.startMs) ? caption.startMs : Math.round(caption.startSeconds * 1000),
        endMs: Number.isFinite(caption.endMs) ? caption.endMs : Math.round(caption.endSeconds * 1000),
        timestampMs: caption.timestampMs ?? null,
        confidence: caption.confidence ?? null,
      });
    }
  }

  return balanced;
};

export const makeHubVtt = (captions: HubVideoCaption[]): string => [
  'WEBVTT',
  '',
  ...balanceHubCaptions(captions).flatMap((caption, index) => [
    String(index + 1),
    `${formatTimestamp(caption.startMs / 1000)} --> ${formatTimestamp(caption.endMs / 1000)}`,
    caption.text,
    '',
  ]),
].join('\n');
