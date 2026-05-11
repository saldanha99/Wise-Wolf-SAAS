-- Wolfie 2.0 Analytics Tables

-- 1. Wolfie Sessions: Represents a single learning session
CREATE TABLE IF NOT EXISTS public.wolfie_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    
    tenant_id UUID NOT NULL, -- Logical separation
    student_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    
    topic TEXT NOT NULL,
    subtopic TEXT, -- e.g. "Past Tense" inside "Grammar"
    mode TEXT NOT NULL, -- 'fluency', 'exam_prep', etc.
    student_level TEXT NOT NULL, -- 'A1', 'B2', etc.
    
    -- Metrics (Can be updated at end of session)
    turn_count INTEGER DEFAULT 0,
    student_word_count INTEGER DEFAULT 0,
    wolfie_word_count INTEGER DEFAULT 0,
    duration_seconds INTEGER DEFAULT 0,
    
    -- Configuration Snapshot (What settings were used?)
    config_snapshot JSONB DEFAULT '{}'::jsonb,
    
    -- AI Evaluation (Filled by WolfieEval later)
    overall_score INTEGER, -- 1-5 or 1-100
    summary TEXT
);

-- RLS
ALTER TABLE public.wolfie_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Students can view their own sessions" ON public.wolfie_sessions;
CREATE POLICY "Students can view their own sessions" 
    ON public.wolfie_sessions FOR SELECT 
    USING (auth.uid() = student_id);

DROP POLICY IF EXISTS "Admins can view all sessions" ON public.wolfie_sessions;
CREATE POLICY "Admins can view all sessions" 
    ON public.wolfie_sessions FOR ALL 
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = auth.uid() 
            AND profiles.role IN ('admin', 'manager', 'teacher')
        )
    );

DROP POLICY IF EXISTS "Service Role can insert sessions" ON public.wolfie_sessions;
CREATE POLICY "Service Role can insert sessions" 
    ON public.wolfie_sessions FOR INSERT 
    WITH CHECK (true); -- Usually service_role bypasses RLS, but for explicit allow

-- 2. Wolfie Turns: Complete transcript of the conversation
CREATE TABLE IF NOT EXISTS public.wolfie_turns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    
    session_id UUID NOT NULL REFERENCES public.wolfie_sessions(id) ON DELETE CASCADE,
    
    speaker TEXT NOT NULL CHECK (speaker IN ('student', 'wolfie')),
    content TEXT NOT NULL,
    audio_url TEXT, -- If we ever save audio (optional)
    
    -- Metadata
    turn_index INTEGER NOT NULL, -- 0, 1, 2...
    tokens_used INTEGER
);

-- RLS
ALTER TABLE public.wolfie_turns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Students can view their own turns" ON public.wolfie_turns;
CREATE POLICY "Students can view their own turns" 
    ON public.wolfie_turns FOR SELECT 
    USING (
        EXISTS (
            SELECT 1 FROM public.wolfie_sessions 
            WHERE wolfie_sessions.id = wolfie_turns.session_id 
            AND wolfie_sessions.student_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Service Role can insert turns" ON public.wolfie_turns;
CREATE POLICY "Service Role can insert turns"
    ON public.wolfie_turns FOR INSERT 
    WITH CHECK (true);

-- 3. Wolfie Corrections: Structural data on errors
CREATE TABLE IF NOT EXISTS public.wolfie_corrections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    
    session_id UUID NOT NULL REFERENCES public.wolfie_sessions(id) ON DELETE CASCADE,
    turn_id UUID REFERENCES public.wolfie_turns(id) ON DELETE SET NULL, -- Link to specific turn if possible
    
    wrong_sentence TEXT NOT NULL,
    correct_sentence TEXT NOT NULL,
    explanation_pt TEXT,
    
    error_type TEXT -- 'grammar', 'vocabulary', 'pronunciation', 'style' (Optional for future)
);

-- RLS
ALTER TABLE public.wolfie_corrections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Students can view their own corrections" ON public.wolfie_corrections;
CREATE POLICY "Students can view their own corrections" 
    ON public.wolfie_corrections FOR SELECT 
    USING (
        EXISTS (
            SELECT 1 FROM public.wolfie_sessions 
            WHERE wolfie_sessions.id = wolfie_corrections.session_id 
            AND wolfie_sessions.student_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Service Role can insert corrections" ON public.wolfie_corrections;
CREATE POLICY "Service Role can insert corrections"
    ON public.wolfie_corrections FOR INSERT 
    WITH CHECK (true);

-- 4. Initial Indexes for Performance
CREATE INDEX IF NOT EXISTS idx_wolfie_sessions_student ON public.wolfie_sessions(student_id);
CREATE INDEX IF NOT EXISTS idx_wolfie_turns_session ON public.wolfie_turns(session_id);
CREATE INDEX IF NOT EXISTS idx_wolfie_corrections_session ON public.wolfie_corrections(session_id);

-- 5. Presets Table (Phase 4 requirement, adding now to be ready)
CREATE TABLE IF NOT EXISTS public.wolfie_presets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT,
    config JSONB NOT NULL, -- The WolfieConfig object
    is_active BOOLEAN DEFAULT true,
    is_default_for_level TEXT -- 'A1', 'B2', etc.
);

ALTER TABLE public.wolfie_presets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Everyone can read presets" ON public.wolfie_presets;
CREATE POLICY "Everyone can read presets" ON public.wolfie_presets FOR SELECT USING (true);

-- 6. Wolfie Evaluations: Automating Quality Control
CREATE TABLE IF NOT EXISTS public.wolfie_evaluations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    
    session_id UUID NOT NULL REFERENCES public.wolfie_sessions(id) ON DELETE CASCADE,
    
    -- Rubric Scores (1-5)
    adequacy_to_level INTEGER,
    clarity_of_corrections INTEGER,
    encouragement_and_tone INTEGER,
    question_quality INTEGER,
    target_language_use INTEGER,
    focus_on_student_production INTEGER,
    
    overall_score INTEGER, -- 1-5
    
    textual_feedback_pt TEXT, -- Feedback for the teacher/devs
    
    evaluator_model TEXT -- 'gemini-2.0-flash', etc.
);

ALTER TABLE public.wolfie_evaluations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can view evaluations" ON public.wolfie_evaluations;
CREATE POLICY "Admins can view evaluations" 
    ON public.wolfie_evaluations FOR SELECT 
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles 
            WHERE profiles.id = auth.uid() 
            AND profiles.role IN ('admin', 'manager', 'teacher')
        )
    );

DROP POLICY IF EXISTS "Service Role can insert evaluations" ON public.wolfie_evaluations;
CREATE POLICY "Service Role can insert evaluations"
    ON public.wolfie_evaluations FOR INSERT 
    WITH CHECK (true);
