-- Add meeting_link to profiles for fixed Google Meet links
ALTER TABLE profiles 
ADD COLUMN IF NOT EXISTS meeting_link TEXT;

-- Update existing students with a placeholder link if desired
-- UPDATE profiles SET meeting_link = 'https://meet.google.com/abc-defg-hij' WHERE role = 'STUDENT' AND meeting_link IS NULL;
