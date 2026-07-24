
const { createClient } = require('@supabase/supabase-js');

function requireEnv(name) {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

// Administrative scripts must fail closed. Never add key or URL fallbacks here.
const SUPABASE_URL = requireEnv('SUPABASE_URL');
const SUPABASE_KEY = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

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
