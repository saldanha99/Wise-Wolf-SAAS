-- ============================================================================
-- PR1 Part B: Gamification Schema (Bloco 2 Foundation)
-- Idempotent, reversible. Safe to re-run.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. TENANT XP CONFIG (per-school XP values)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tenant_xp_config (
    tenant_id               TEXT PRIMARY KEY,
    xp_attendance           INTEGER NOT NULL DEFAULT 50,
    xp_homework             INTEGER NOT NULL DEFAULT 30,
    xp_srs_correct          INTEGER NOT NULL DEFAULT 5,
    xp_srs_streak_5         INTEGER NOT NULL DEFAULT 10,
    xp_warmup               INTEGER NOT NULL DEFAULT 5,
    xp_trial_converted      INTEGER NOT NULL DEFAULT 100,
    xp_referral_converted   INTEGER NOT NULL DEFAULT 200,
    streak_freeze_per_week  INTEGER NOT NULL DEFAULT 1,
    gamification_enabled    BOOLEAN NOT NULL DEFAULT false,
    leagues_enabled         BOOLEAN NOT NULL DEFAULT false,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.tenant_xp_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins manage xp config" ON public.tenant_xp_config;
CREATE POLICY "Admins manage xp config" ON public.tenant_xp_config
    FOR ALL TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid()
              AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
              AND tenant_id = tenant_xp_config.tenant_id
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid()
              AND role IN ('SCHOOL_ADMIN', 'SUPER_ADMIN')
              AND tenant_id = tenant_xp_config.tenant_id
        )
    );

DROP POLICY IF EXISTS "Authenticated read xp config" ON public.tenant_xp_config;
CREATE POLICY "Authenticated read xp config" ON public.tenant_xp_config
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid()
              AND tenant_id = tenant_xp_config.tenant_id
        )
    );

DROP POLICY IF EXISTS "Service role full access" ON public.tenant_xp_config;
CREATE POLICY "Service role full access" ON public.tenant_xp_config
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ────────────────────────────────────────────────────────────────────────────
-- 2. STUDENT STREAKS (daily streak tracking)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.student_streaks (
    student_id          UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
    tenant_id           TEXT NOT NULL,
    current_streak      INTEGER NOT NULL DEFAULT 0,
    longest_streak      INTEGER NOT NULL DEFAULT 0,
    last_activity_date  DATE,                        -- Date of last XP qualifying activity
    freezes_available   INTEGER NOT NULL DEFAULT 1,
    freezes_used_this_week INTEGER NOT NULL DEFAULT 0,
    timezone            TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_streaks_tenant
    ON public.student_streaks (tenant_id);

ALTER TABLE public.student_streaks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Students read own streak" ON public.student_streaks;
CREATE POLICY "Students read own streak" ON public.student_streaks
    FOR SELECT TO authenticated
    USING (student_id = auth.uid());

DROP POLICY IF EXISTS "Teachers read tenant streaks" ON public.student_streaks;
CREATE POLICY "Teachers read tenant streaks" ON public.student_streaks
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid()
              AND role IN ('TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN')
              AND tenant_id = student_streaks.tenant_id
        )
    );

DROP POLICY IF EXISTS "Service role full access" ON public.student_streaks;
CREATE POLICY "Service role full access" ON public.student_streaks
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ────────────────────────────────────────────────────────────────────────────
-- 3. XP EVENTS (append-only event log)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.xp_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id      UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    tenant_id       TEXT NOT NULL,
    source          TEXT NOT NULL,                   -- 'ATTENDANCE', 'HOMEWORK', 'SRS_CORRECT', 'SRS_STREAK', 'WARMUP', 'TRIAL_CONVERTED', 'REFERRAL'
    amount          INTEGER NOT NULL,
    ref_id          TEXT,                            -- booking_id, vocab_item_id, etc.
    dedupe_key      TEXT NOT NULL UNIQUE,            -- 'attendance:<booking_id>', 'srs:<card_id>:<date>', etc.
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_xp_events_student
    ON public.xp_events (student_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_xp_events_tenant_daily
    ON public.xp_events (tenant_id, created_at DESC);

-- Revoke UPDATE/DELETE for append-only semantics
REVOKE UPDATE, DELETE ON public.xp_events FROM anon, authenticated;

ALTER TABLE public.xp_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Students read own xp" ON public.xp_events;
CREATE POLICY "Students read own xp" ON public.xp_events
    FOR SELECT TO authenticated
    USING (student_id = auth.uid());

DROP POLICY IF EXISTS "Teachers read tenant xp" ON public.xp_events;
CREATE POLICY "Teachers read tenant xp" ON public.xp_events
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid()
              AND role IN ('TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN')
              AND tenant_id = xp_events.tenant_id
        )
    );

DROP POLICY IF EXISTS "Service role full access" ON public.xp_events;
CREATE POLICY "Service role full access" ON public.xp_events
    FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.xp_events IS
    'Append-only XP event log. Deduplicated via UNIQUE dedupe_key. UPDATE/DELETE revoked for non-service roles.';

-- ────────────────────────────────────────────────────────────────────────────
-- 4. STUDENT XP TOTALS (materialized view for fast reads)
-- ────────────────────────────────────────────────────────────────────────────
CREATE MATERIALIZED VIEW IF NOT EXISTS public.student_xp_totals AS
SELECT
    student_id,
    tenant_id,
    SUM(amount) AS total_xp,
    SUM(amount) FILTER (
        WHERE created_at >= date_trunc('week', now())
    ) AS weekly_xp,
    SUM(amount) FILTER (
        WHERE created_at >= date_trunc('day', now())
    ) AS daily_xp
FROM public.xp_events
GROUP BY student_id, tenant_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_xp_totals_student
    ON public.student_xp_totals (student_id);

CREATE INDEX IF NOT EXISTS idx_xp_totals_tenant_weekly
    ON public.student_xp_totals (tenant_id, weekly_xp DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- 5. STUDENT DAILY GOALS
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.student_daily_goals (
    student_id      UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
    tenant_id       TEXT NOT NULL,
    target_xp       INTEGER NOT NULL DEFAULT 20,     -- Casual=10, Regular=20, Sério=30, Insano=50
    goal_label      TEXT NOT NULL DEFAULT 'Regular'
                    CHECK (goal_label IN ('Casual', 'Regular', 'Sério', 'Insano')),
    set_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.student_daily_goals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Students manage own goal" ON public.student_daily_goals;
CREATE POLICY "Students manage own goal" ON public.student_daily_goals
    FOR ALL TO authenticated
    USING (student_id = auth.uid())
    WITH CHECK (student_id = auth.uid());

DROP POLICY IF EXISTS "Teachers read tenant goals" ON public.student_daily_goals;
CREATE POLICY "Teachers read tenant goals" ON public.student_daily_goals
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid()
              AND role IN ('TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN')
              AND tenant_id = student_daily_goals.tenant_id
        )
    );

DROP POLICY IF EXISTS "Service role full access" ON public.student_daily_goals;
CREATE POLICY "Service role full access" ON public.student_daily_goals
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ────────────────────────────────────────────────────────────────────────────
-- 6. VOCABULARY ITEMS (teacher-created word bank)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.vocabulary_items (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           TEXT NOT NULL,
    language            TEXT NOT NULL DEFAULT 'en',
    term                TEXT NOT NULL,
    translation         TEXT NOT NULL,
    example             TEXT,
    audio_url           TEXT,
    cefr_level          TEXT CHECK (cefr_level IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')),
    created_by_teacher_id UUID REFERENCES public.profiles(id),
    target_student_id   UUID REFERENCES public.profiles(id),  -- NULL = available to all tenant students
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vocab_tenant
    ON public.vocabulary_items (tenant_id, cefr_level);

CREATE INDEX IF NOT EXISTS idx_vocab_teacher
    ON public.vocabulary_items (created_by_teacher_id);

CREATE INDEX IF NOT EXISTS idx_vocab_student
    ON public.vocabulary_items (target_student_id)
    WHERE target_student_id IS NOT NULL;

ALTER TABLE public.vocabulary_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Tenant users read vocab" ON public.vocabulary_items;
CREATE POLICY "Tenant users read vocab" ON public.vocabulary_items
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid()
              AND tenant_id = vocabulary_items.tenant_id
        )
        AND (
            target_student_id IS NULL
            OR target_student_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Teachers manage vocab" ON public.vocabulary_items;
CREATE POLICY "Teachers manage vocab" ON public.vocabulary_items
    FOR ALL TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid()
              AND role IN ('TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN')
              AND tenant_id = vocabulary_items.tenant_id
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid()
              AND role IN ('TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN')
              AND tenant_id = vocabulary_items.tenant_id
        )
    );

DROP POLICY IF EXISTS "Service role full access" ON public.vocabulary_items;
CREATE POLICY "Service role full access" ON public.vocabulary_items
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ────────────────────────────────────────────────────────────────────────────
-- 7. STUDENT SRS CARDS (SM-2 spaced repetition)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.student_srs_cards (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id      UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    vocab_item_id   UUID NOT NULL REFERENCES public.vocabulary_items(id) ON DELETE CASCADE,
    ease_factor     NUMERIC(4,2) NOT NULL DEFAULT 2.50,
    interval_days   INTEGER NOT NULL DEFAULT 0,
    next_review_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    repetitions     INTEGER NOT NULL DEFAULT 0,
    lapses          INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'LEARNING'
                    CHECK (status IN ('LEARNING', 'REVIEWING', 'MASTERED', 'SUSPENDED')),
    last_reviewed_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (student_id, vocab_item_id)
);

CREATE INDEX IF NOT EXISTS idx_srs_due
    ON public.student_srs_cards (student_id, next_review_at ASC)
    WHERE status IN ('LEARNING', 'REVIEWING');

ALTER TABLE public.student_srs_cards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Students manage own cards" ON public.student_srs_cards;
CREATE POLICY "Students manage own cards" ON public.student_srs_cards
    FOR ALL TO authenticated
    USING (student_id = auth.uid())
    WITH CHECK (student_id = auth.uid());

DROP POLICY IF EXISTS "Teachers read student cards" ON public.student_srs_cards;
CREATE POLICY "Teachers read student cards" ON public.student_srs_cards
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles p
            JOIN public.vocabulary_items v ON v.tenant_id = p.tenant_id
            WHERE p.id = auth.uid()
              AND p.role IN ('TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN')
              AND v.id = student_srs_cards.vocab_item_id
        )
    );

DROP POLICY IF EXISTS "Service role full access" ON public.student_srs_cards;
CREATE POLICY "Service role full access" ON public.student_srs_cards
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ────────────────────────────────────────────────────────────────────────────
-- 8. ACHIEVEMENTS (badge definitions)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.achievements (
    code            TEXT PRIMARY KEY,                -- 'FIRST_WEEK', 'FULL_MONTH', etc.
    name            TEXT NOT NULL,
    description     TEXT NOT NULL,
    icon            TEXT NOT NULL DEFAULT '🏆',
    category        TEXT NOT NULL DEFAULT 'GENERAL'
                    CHECK (category IN ('STREAK', 'XP', 'SRS', 'REFERRAL', 'ATTENDANCE', 'LEAGUE', 'GENERAL')),
    tenant_id       TEXT,                            -- NULL = global achievement
    threshold       INTEGER,                         -- Numeric threshold for auto-unlock
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.achievements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Everyone reads achievements" ON public.achievements;
CREATE POLICY "Everyone reads achievements" ON public.achievements
    FOR SELECT TO authenticated
    USING (
        tenant_id IS NULL
        OR EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid()
              AND tenant_id = achievements.tenant_id
        )
    );

DROP POLICY IF EXISTS "Service role full access" ON public.achievements;
CREATE POLICY "Service role full access" ON public.achievements
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Seed initial achievements
INSERT INTO public.achievements (code, name, description, icon, category, threshold)
VALUES
    ('FIRST_WEEK',      'Primeira Semana',   '7 dias seguidos de ofensiva',           '🔥', 'STREAK',     7),
    ('FULL_MONTH',      'Mês Inteiro',       '30 dias seguidos de ofensiva',          '🌟', 'STREAK',     30),
    ('CENTURY',         'Centena',           '100 palavras dominadas no SRS',          '📚', 'SRS',        100),
    ('FIRST_REFERRAL',  'Indicador',         'Primeira indicação convertida',          '🤝', 'REFERRAL',   1),
    ('AMBASSADOR',      'Embaixador',        '5 indicações convertidas',               '👑', 'REFERRAL',   5),
    ('LEAGUE_MASTER',   'Mestre da Liga',    'Top 3 em qualquer liga semanal',         '🏆', 'LEAGUE',     NULL),
    ('PUNCTUAL',        'Pontual',           '10 aulas seguidas sem falta',            '⏰', 'ATTENDANCE', 10)
ON CONFLICT (code) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────────
-- 9. STUDENT ACHIEVEMENTS (unlocked badges)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.student_achievements (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id          UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    achievement_code    TEXT NOT NULL REFERENCES public.achievements(code),
    unlocked_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (student_id, achievement_code)
);

CREATE INDEX IF NOT EXISTS idx_student_achievements_student
    ON public.student_achievements (student_id);

ALTER TABLE public.student_achievements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Students read own achievements" ON public.student_achievements;
CREATE POLICY "Students read own achievements" ON public.student_achievements
    FOR SELECT TO authenticated
    USING (student_id = auth.uid());

DROP POLICY IF EXISTS "Teachers read tenant achievements" ON public.student_achievements;
CREATE POLICY "Teachers read tenant achievements" ON public.student_achievements
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles p1
            JOIN public.profiles p2 ON p2.tenant_id = p1.tenant_id
            WHERE p1.id = auth.uid()
              AND p1.role IN ('TEACHER', 'SCHOOL_ADMIN', 'SUPER_ADMIN')
              AND p2.id = student_achievements.student_id
        )
    );

DROP POLICY IF EXISTS "Service role full access" ON public.student_achievements;
CREATE POLICY "Service role full access" ON public.student_achievements
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ────────────────────────────────────────────────────────────────────────────
-- 10. LEAGUE SEASONS (weekly league tracking)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.league_seasons (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       TEXT NOT NULL,
    student_id      UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    tier            TEXT NOT NULL DEFAULT 'BRONZE'
                    CHECK (tier IN ('BRONZE', 'PRATA', 'OURO', 'SAFIRA', 'RUBI', 'ESMERALDA', 'DIAMANTE')),
    week_start      DATE NOT NULL,                   -- Monday of the league week
    weekly_xp       INTEGER NOT NULL DEFAULT 0,
    rank_position   INTEGER,
    opted_in        BOOLEAN NOT NULL DEFAULT false,
    display_name    TEXT,                             -- Nickname for minors (never real name)
    promoted        BOOLEAN DEFAULT false,            -- true = promoted, false = demoted, null = stayed
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, student_id, week_start)
);

CREATE INDEX IF NOT EXISTS idx_leagues_tenant_week
    ON public.league_seasons (tenant_id, week_start DESC, tier, weekly_xp DESC);

ALTER TABLE public.league_seasons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Students read own league" ON public.league_seasons;
CREATE POLICY "Students read own league" ON public.league_seasons
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid()
              AND tenant_id = league_seasons.tenant_id
        )
    );

DROP POLICY IF EXISTS "Service role full access" ON public.league_seasons;
CREATE POLICY "Service role full access" ON public.league_seasons
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ────────────────────────────────────────────────────────────────────────────
-- 11. ADD gamification_consent_by_guardian TO profiles
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'profiles' AND column_name = 'gamification_consent_by_guardian'
    ) THEN
        ALTER TABLE public.profiles
            ADD COLUMN gamification_consent_by_guardian BOOLEAN DEFAULT false;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'profiles' AND column_name = 'guardian_id'
    ) THEN
        ALTER TABLE public.profiles
            ADD COLUMN guardian_id UUID REFERENCES public.profiles(id);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'profiles' AND column_name = 'league_opt_in'
    ) THEN
        ALTER TABLE public.profiles
            ADD COLUMN league_opt_in BOOLEAN DEFAULT false;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'profiles' AND column_name = 'league_display_name'
    ) THEN
        ALTER TABLE public.profiles
            ADD COLUMN league_display_name TEXT;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'profiles' AND column_name = 'notification_preference'
    ) THEN
        ALTER TABLE public.profiles
            ADD COLUMN notification_preference TEXT DEFAULT 'OFF'
                CHECK (notification_preference IN ('OFF', 'WHATSAPP', 'PUSH_WEB'));
    END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 12. GRANTS
-- ────────────────────────────────────────────────────────────────────────────
GRANT ALL ON public.tenant_xp_config TO service_role;
GRANT ALL ON public.student_streaks TO service_role;
GRANT ALL ON public.xp_events TO service_role;
GRANT ALL ON public.student_daily_goals TO service_role;
GRANT ALL ON public.vocabulary_items TO service_role;
GRANT ALL ON public.student_srs_cards TO service_role;
GRANT ALL ON public.achievements TO service_role;
GRANT ALL ON public.student_achievements TO service_role;
GRANT ALL ON public.league_seasons TO service_role;
GRANT SELECT ON public.student_xp_totals TO authenticated, service_role;

COMMIT;

-- ============================================================================
-- DOWN MIGRATION (Rollback)
-- ============================================================================
-- DROP MATERIALIZED VIEW IF EXISTS public.student_xp_totals CASCADE;
-- DROP TABLE IF EXISTS public.league_seasons CASCADE;
-- DROP TABLE IF EXISTS public.student_achievements CASCADE;
-- DROP TABLE IF EXISTS public.achievements CASCADE;
-- DROP TABLE IF EXISTS public.student_srs_cards CASCADE;
-- DROP TABLE IF EXISTS public.vocabulary_items CASCADE;
-- DROP TABLE IF EXISTS public.student_daily_goals CASCADE;
-- DROP TABLE IF EXISTS public.xp_events CASCADE;
-- DROP TABLE IF EXISTS public.student_streaks CASCADE;
-- DROP TABLE IF EXISTS public.tenant_xp_config CASCADE;
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS gamification_consent_by_guardian;
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS guardian_id;
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS league_opt_in;
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS league_display_name;
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS notification_preference;
