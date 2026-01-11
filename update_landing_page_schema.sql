-- Add new columns for Authentic Landing Pags
-- Using JSONB arrays for flexible lists

ALTER TABLE landing_page_configs ADD COLUMN IF NOT EXISTS video_url TEXT;
ALTER TABLE landing_page_configs ADD COLUMN IF NOT EXISTS show_video BOOLEAN DEFAULT false;

ALTER TABLE landing_page_configs ADD COLUMN IF NOT EXISTS stats JSONB DEFAULT '[]'::jsonb; -- [{"label": "Alunos", "value": "5000+"}]

ALTER TABLE landing_page_configs ADD COLUMN IF NOT EXISTS benefits JSONB DEFAULT '[]'::jsonb; -- [{"title": "", "description": "", "icon": "Check"}]
ALTER TABLE landing_page_configs ADD COLUMN IF NOT EXISTS show_benefits BOOLEAN DEFAULT true;

ALTER TABLE landing_page_configs ADD COLUMN IF NOT EXISTS target_audience JSONB DEFAULT '[]'::jsonb; -- [{"title": "", "description": "", "icon": ""}]
ALTER TABLE landing_page_configs ADD COLUMN IF NOT EXISTS show_target_audience BOOLEAN DEFAULT true;

ALTER TABLE landing_page_configs ADD COLUMN IF NOT EXISTS testimonials JSONB DEFAULT '[]'::jsonb; -- [{"name": "", "text": "", "role": "", "photo": ""}]
ALTER TABLE landing_page_configs ADD COLUMN IF NOT EXISTS show_testimonials BOOLEAN DEFAULT true;

ALTER TABLE landing_page_configs ADD COLUMN IF NOT EXISTS faq JSONB DEFAULT '[]'::jsonb; -- [{"question": "", "answer": ""}]
ALTER TABLE landing_page_configs ADD COLUMN IF NOT EXISTS show_faq BOOLEAN DEFAULT true;

-- New features (Step 704)
ALTER TABLE landing_page_configs ADD COLUMN IF NOT EXISTS focus TEXT DEFAULT 'general'; -- 'general', 'travel', 'tech', 'kids'
ALTER TABLE landing_page_configs ADD COLUMN IF NOT EXISTS teachers JSONB DEFAULT '[]'::jsonb; -- [{"name": "", "bio": "", "photo": "", "media_url": ""}]
ALTER TABLE landing_page_configs ADD COLUMN IF NOT EXISTS show_teachers BOOLEAN DEFAULT true;
ALTER TABLE landing_page_configs ADD COLUMN IF NOT EXISTS company_logos JSONB DEFAULT '[]'::jsonb; -- ["url1", "url2"]
ALTER TABLE landing_page_configs ADD COLUMN IF NOT EXISTS show_company_logos BOOLEAN DEFAULT true;
