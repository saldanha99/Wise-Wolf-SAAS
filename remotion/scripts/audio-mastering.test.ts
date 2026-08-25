import { describe, expect, it } from 'vitest';
import {
  isAudioWithinMasteringSpec,
  parseEbur128Summary,
} from './audio-mastering';

describe('audio mastering', () => {
  it('parses the final EBU R128 summary', () => {
    expect(parseEbur128Summary(`
Summary:

  Integrated loudness:
    I:         -16.1 LUFS

  Loudness range:
    LRA:         3.2 LU

  True peak:
    Peak:       -1.6 dBFS
`)).toEqual({
      integratedLufs: -16.1,
      loudnessRangeLu: 3.2,
      truePeakDbtp: -1.6,
    });
  });

  it('rejects a master without true-peak headroom', () => {
    expect(isAudioWithinMasteringSpec({
      integratedLufs: -16,
      loudnessRangeLu: 4,
      truePeakDbtp: -0.9,
    })).toBe(false);
  });

  it('accepts a balanced web master', () => {
    expect(isAudioWithinMasteringSpec({
      integratedLufs: -16.1,
      loudnessRangeLu: 4,
      truePeakDbtp: -1.5,
    })).toBe(true);
  });
});
