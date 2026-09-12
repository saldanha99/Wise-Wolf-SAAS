export interface LessonRoom {
    session_id: string;
    class_date: string;
    meeting_uri: string | null;
    source_references: { source_type: string; source_id: string }[];
}

/** An institutional session without a ready room must not silently open a personal room. */
export function lessonMeetingLink(rooms: LessonRoom[], sourceType: string, sourceId: string, date: string, legacyLink?: string | null): string | null {
    const room = rooms.find(item => item.class_date === date && item.source_references.some(reference =>
        reference.source_type.toLowerCase() === sourceType.toLowerCase() && reference.source_id === sourceId));
    return room ? room.meeting_uri : legacyLink || null;
}
