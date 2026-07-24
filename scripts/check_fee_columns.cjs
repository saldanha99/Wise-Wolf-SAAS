
const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://api.wisewolflanguage.com.br');
const SUPABASE_KEY = (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '');
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function checkProfiles() {
    console.log("--- Checking profiles Data ---");

    const { data: students, error } = await supabase
        .from('profiles')
        .select('id, full_name, monthly_fee, monthly_tuition, due_day')
        .eq('role', 'STUDENT');

    if (error) console.error("Error:", error);
    else {
        console.log(`Found ${students.length} students.`);
        students.forEach(s => {
            console.log(`- ${s.full_name}: monthly_fee=${s.monthly_fee}, monthly_tuition=${s.monthly_tuition}`);
        });
    }
}
checkProfiles();
