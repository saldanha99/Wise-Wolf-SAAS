
const { createClient } = require('@supabase/supabase-js');
const SUPABASE_URL = 'https://dvalxbtngopxopzcbfdm.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR2YWx4YnRuZ29weG9wemNiZmRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY5ODkwMTksImV4cCI6MjA4MjU2NTAxOX0.rrq_vbAub4GGIcZc9cpS-QxGFYQ3B0aeka2p4xiYKiE';
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
