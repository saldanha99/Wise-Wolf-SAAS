-- Pedagogical Quizzes & Assignments Migration

-- 1. Student Material Assignments (Direct assignments from teacher)
CREATE TABLE IF NOT EXISTS student_assignments (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    student_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    material_id UUID REFERENCES pedagogical_materials(id) ON DELETE CASCADE,
    assigned_by UUID REFERENCES auth.users(id),
    assigned_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    status TEXT DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'VIEWED', 'COMPLETED')),
    notes TEXT -- Message from teacher "Read pages 10-20"
);

ALTER TABLE student_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Student read assignments" ON student_assignments;
CREATE POLICY "Student read assignments" ON student_assignments
    FOR SELECT USING (student_id = auth.uid());
    
DROP POLICY IF EXISTS "Teacher manage assignments" ON student_assignments;
CREATE POLICY "Teacher manage assignments" ON student_assignments
    FOR ALL USING (
        auth.uid() IN (SELECT id FROM profiles WHERE role IN ('TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN'))
    );

-- 2. Module Quizzes (The Evaluation)
CREATE TABLE IF NOT EXISTS module_quizzes (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    module_id UUID REFERENCES course_modules(id) ON DELETE CASCADE,
    title TEXT NOT NULL, -- "Final Exam B1"
    description TEXT,
    passing_score INTEGER DEFAULT 70, -- Percentage
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE module_quizzes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Read quizzes: Authenticated" ON module_quizzes;
CREATE POLICY "Read quizzes: Authenticated" ON module_quizzes FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Manage quizzes: Admins" ON module_quizzes;
CREATE POLICY "Manage quizzes: Admins" ON module_quizzes FOR ALL USING (
    auth.uid() IN (SELECT id FROM profiles WHERE role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN'))
);

-- 3. Quiz Questions (10 per quiz usually)
CREATE TABLE IF NOT EXISTS quiz_questions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    quiz_id UUID REFERENCES module_quizzes(id) ON DELETE CASCADE,
    question_text TEXT NOT NULL,
    options JSONB NOT NULL, -- Array of strings ["Option A", "Option B", ...]
    correct_option_index INTEGER NOT NULL, -- 0, 1, 2, 3
    explanation TEXT, -- Shown after answer
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE quiz_questions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Read questions: Authenticated" ON quiz_questions;
CREATE POLICY "Read questions: Authenticated" ON quiz_questions FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Manage questions: Admins" ON quiz_questions;
CREATE POLICY "Manage questions: Admins" ON quiz_questions FOR ALL USING (
     auth.uid() IN (SELECT id FROM profiles WHERE role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN'))
);

-- 4. Student Quiz Attempts
CREATE TABLE IF NOT EXISTS student_quiz_attempts (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    student_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    quiz_id UUID REFERENCES module_quizzes(id) ON DELETE CASCADE,
    score INTEGER NOT NULL, -- 0-100
    answers JSONB, -- Store student answers for review
    passed BOOLEAN GENERATED ALWAYS AS (score >= 70) STORED,
    completed_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE student_quiz_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Student read own attempts" ON student_quiz_attempts;
CREATE POLICY "Student read own attempts" ON student_quiz_attempts FOR SELECT USING (student_id = auth.uid());

DROP POLICY IF EXISTS "Student create attempt" ON student_quiz_attempts;
CREATE POLICY "Student create attempt" ON student_quiz_attempts FOR INSERT WITH CHECK (student_id = auth.uid());

DROP POLICY IF EXISTS "Teacher read attempts" ON student_quiz_attempts;
CREATE POLICY "Teacher read attempts" ON student_quiz_attempts FOR SELECT USING (
    auth.uid() IN (SELECT id FROM profiles WHERE role IN ('TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN'))
);
