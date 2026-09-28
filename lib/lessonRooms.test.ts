import { describe, expect, it } from 'vitest';
import { lessonMeetingLink, officialLessonRoom, type LessonRoom } from './lessonRooms';
const room: LessonRoom = { session_id: 'session', class_date: '2026-09-12', meeting_uri: null,
    source_references: [{ source_type: 'booking', source_id: 'booking' }] };
describe('institutional meeting room selection', () => {
    it('never falls back to a personal room for an institutional session waiting for provisioning', () => {
        expect(lessonMeetingLink([room], 'BOOKING', 'booking', '2026-09-12', 'https://meet.google.com/personal')).toBeNull();
    });
    it('selects the exact occurrence and preserves legacy only when no institutional session exists', () => {
        expect(lessonMeetingLink([{ ...room, meeting_uri: 'https://meet.google.com/official' }], 'booking', 'booking', '2026-09-12', 'legacy')).toBe('https://meet.google.com/official');
        expect(lessonMeetingLink([room], 'booking', 'booking', '2026-09-13', 'legacy')).toBe('legacy');
    });
});

describe('official room label', () => {
    it('only labels the room of the same source and day', () => {
        expect(officialLessonRoom([room], 'reschedule', 'booking', room.class_date)).toBeUndefined();
        expect(officialLessonRoom([room], 'booking', 'another-booking', room.class_date)).toBeUndefined();
        expect(officialLessonRoom([room], 'BOOKING', 'booking', room.class_date)).toBe(room);
    });
});
