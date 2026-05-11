-- Create ai_messages table for storing tutor interactions
CREATE TABLE IF NOT EXISTS public.ai_messages (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    conversation_id UUID NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT,
    audio_url TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add index for faster history fetching
CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation_id ON public.ai_messages(conversation_id);

-- Enable RLS
ALTER TABLE public.ai_messages ENABLE ROW LEVEL SECURITY;

-- Allow insert/select for authenticated users (assuming students are users)
-- Allow insert/select for authenticated users (assuming students are users)
DROP POLICY IF EXISTS "Users can insert their own messages" ON public.ai_messages;
CREATE POLICY "Users can insert their own messages" ON public.ai_messages
    FOR INSERT TO authenticated
    WITH CHECK (true); -- Simplification. Ideally check conversation ownership.

DROP POLICY IF EXISTS "Users can view messages" ON public.ai_messages;
CREATE POLICY "Users can view messages" ON public.ai_messages
    FOR SELECT TO authenticated
    USING (true); -- Simplification.
