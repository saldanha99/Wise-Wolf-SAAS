
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://api.wisewolflanguage.com.br');
const supabaseKey = (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '');

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkSchema() {
    const { data, error } = await supabase.from('reschedules').select('*').limit(1);
    if (error) {
        console.error("Error fetching from reschedules:", error);
    } else {
        console.log("Reschedules data sample:", data);
    }
}

checkSchema();
