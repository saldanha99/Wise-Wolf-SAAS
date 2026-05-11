
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://dvalxbtngopxopzcbfdm.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR2YWx4YnRuZ29weG9wemNiZmRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY5ODkwMTksImV4cCI6MjA4MjU2NTAxOX0.rrq_vbAub4GGIcZc9cpS-QxGFYQ3B0aeka2p4xiYKiE';

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkClassLogs() {
    const { data, error } = await supabase.from('class_logs').select('*').limit(1);
    if (error) {
        console.error("Error fetching from class_logs:", error);
    } else {
        console.log("Class Logs columns:", data.length > 0 ? Object.keys(data[0]) : "Table empty, cannot see columns easily this way");
    }
}

checkClassLogs();
