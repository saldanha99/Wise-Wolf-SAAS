
-- Tabela para Sessões de Conversa com Wolfie
CREATE TABLE IF NOT EXISTS wolfie_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID NOT NULL REFERENCES auth.users(id),
    started_at TIMESTAMPTZ DEFAULT NOW(),
    topic TEXT, -- e.g., "Food", "Business", "Free Talk"
    student_level VARCHAR(10), -- 'A1', 'B2', etc.
    status TEXT DEFAULT 'active', -- 'active', 'completed'
    summary TEXT, -- Resumo gerado pela IA ao fim
    tenant_id VARCHAR(50) -- Para multi-tenancy
);

-- Tabela para Correções Específicas (Pedagogical Data)
CREATE TABLE IF NOT EXISTS wolfie_corrections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES wolfie_conversations(id) ON DELETE CASCADE,
    student_id UUID REFERENCES auth.users(id),
    original_text TEXT,
    corrected_text TEXT,
    explanation TEXT,
    error_type TEXT, -- 'grammar', 'pronunciation', 'vocabulary'
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index para performance
CREATE INDEX IF NOT EXISTS idx_wolfie_conversations_student ON wolfie_conversations(student_id);
CREATE INDEX IF NOT EXISTS idx_wolfie_corrections_conversation ON wolfie_corrections(conversation_id);

-- RLS (Row Level Security)
ALTER TABLE wolfie_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE wolfie_corrections ENABLE ROW LEVEL SECURITY;

-- Policies: Students can view their own data
CREATE POLICY "Students can view their own conversations" 
ON wolfie_conversations FOR SELECT 
USING (auth.uid() = student_id);

CREATE POLICY "Students can insert their own conversations" 
ON wolfie_conversations FOR INSERT 
WITH CHECK (auth.uid() = student_id);

CREATE POLICY "Students can update their own conversations" 
ON wolfie_conversations FOR UPDATE 
USING (auth.uid() = student_id);

CREATE POLICY "Students can view their own corrections" 
ON wolfie_corrections FOR SELECT 
USING (auth.uid() = student_id);

-- Service Role (Edge Function) needs bypass, or explicit grant?
-- Usually Service Role bypasses RLS automatically.
