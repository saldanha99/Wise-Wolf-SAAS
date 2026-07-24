
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://api.wisewolflanguage.com.br');
const supabaseKey = (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '');

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
