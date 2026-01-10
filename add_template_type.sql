ALTER TABLE landing_page_configs ADD COLUMN IF NOT EXISTS template_type TEXT DEFAULT 'sales'; -- 'sales' or 'free_lesson'
