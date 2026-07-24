
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://api.wisewolflanguage.com.br');
const supabaseAnonKey = (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '');
const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function debug() {
    // 1. Get the latest user (assuming the testing user is one of the recent ones or we can list them)
    // Since we don't have the user's ID easily, we'll list profiles modifying the query if needed.
    // However, I'll filter by email if I can guess it or just list the last few.

    console.log("Fetching profiles...");
    const { data: profiles, error } = await supabase
        .from('profiles')
        .select('id, full_name, email, whatsapp_instance, teachers_group_id')
        .order('created_at', { ascending: false })
        .limit(5);

    if (error) {
        console.error("Error fetching profiles:", error);
    } else {
        console.log("Profiles (Top 5 Recent):");
        profiles.forEach(p => {
            console.log(`- ${p.name} (${p.email})`);
            console.log(`  Instance: ${p.whatsapp_instance || 'NULL'}`);
            console.log(`  Group ID: ${p.teachers_group_id || 'NULL'}`);
            console.log('-----------------------------------');
        });
    }

    console.log("\nFetching WhatsApp Instances...");
    const { data: instances } = await supabase
        .from('whatsapp_instances')
        .select('id, instance_name, status, updated_at')
        .order('updated_at', { ascending: false })
        .limit(5);

    console.log("Instances (Top 5 Recent):");
    instances?.forEach(i => console.log(i));
}

debug();
