import { describe, expect, it, vi } from 'vitest';
import { roomSearchDateLabel } from '../src/chrome/room-search-elements';

describe('search result date labels', () => {
  const now = new Date(2026, 8, 28, 0, 5);

  it.each([
    ['2026-09-28T00:01:00', 'Today'],
    ['2026-09-27T23:59:00', 'Yesterday'],
    ['2026-09-26T23:59:00', '2 days ago'],
    ['2026-09-21T01:00:00', '7 days ago'],
    ['2026-09-20T23:59:00', 'Sep 20'],
    ['2025-12-02T18:21:00', 'Dec 2, 2025'],
    ['2026-09-29T00:00:00', 'Sep 29'],
    ['invalid timestamp', 'invalid timestamp'],
  ])('%s becomes %s by local calendar day', (timestamp, label) => {
    expect(roomSearchDateLabel(timestamp, now)).toBe(label);
  });

  it('keeps Yesterday across a year boundary before using an absolute year', () => {
    const newYear = new Date(2027, 0, 1, 0, 5);
    expect(roomSearchDateLabel('2026-12-31T23:59:00', newYear)).toBe('Yesterday');
    expect(roomSearchDateLabel('2026-12-23T23:59:00', newYear)).toBe('Dec 23, 2026');
  });

  it('counts calendar days across both daylight-saving transitions', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    try {
      expect(roomSearchDateLabel('2026-03-08T23:55:00', new Date(2026, 2, 9, 0, 5))).toBe('Yesterday');
      expect(roomSearchDateLabel('2026-11-01T23:55:00', new Date(2026, 10, 2, 0, 5))).toBe('Yesterday');
      expect(roomSearchDateLabel('2026-03-02T12:00:00', new Date(2026, 2, 9, 12))).toBe('7 days ago');
      expect(roomSearchDateLabel('2026-10-26T12:00:00', new Date(2026, 10, 2, 12))).toBe('7 days ago');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
