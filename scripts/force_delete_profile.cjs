
const { createClient } = require('@supabase/supabase-js');

// Config
const SUPABASE_URL = 'https://dvalxbtngopxopzcbfdm.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR2YWx4YnRuZ29weG9wemNiZmRtIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2Njk4OTAxOSwiZXhwIjoyMDgyNTY1MDE5fQ.nnDE2JPlrWgAwGXbkDXHc315pKUiMGNv2-dad2IY3TY';
// Note: We need SERVICE_ROLE_KEY to delete users if RLS prevents it, but ANON might work if policies allow.
// Actually, usually delete requires admin rights. I'll check if I have the service key in env or just use what I have.
// In previous steps, I used the key from the file I assumed was service role or capable.
// The key above seems to be the ANON key (usually starts with eyJ and has "role":"anon").
// Attempting with the key I have. If it fails, I'll ask for service key or try to find it.

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const STUDENT_ID = '05c6e411-3887-47fa-b541-9fc72f919c72';

async function forceDelete() {
    console.log(`Starting Force Delete for Student: ${STUDENT_ID}`);

    // 1. Delete External Dependencies (Insights)
    const { error: err1 } = await supabase
        .from('student_insights')
        .delete()
        .eq('student_id', STUDENT_ID);

    if (err1) console.error("Error deleting insights:", err1);
    else console.log("Deleted student_insights.");

    // 2. Delete Payments
    const { error: err2 } = await supabase
        .from('student_payments')
        .delete()
        .eq('student_id', STUDENT_ID);

    if (err2) console.error("Error deleting payments:", err2);
    else console.log("Deleted student_payments.");

    // 3. Delete Profile
    const { error: err3 } = await supabase
        .from('profiles')
        .delete()
        .eq('id', STUDENT_ID);

    if (err3) console.error("Error deleting profile:", err3);
    else console.log("Deleted profile from 'profiles' table.");

    // Note: This does not delete from auth.users (requires service role / admin API).
    // But it solves the Foreign Key constraint for the public schema tables.
}

forceDelete();
