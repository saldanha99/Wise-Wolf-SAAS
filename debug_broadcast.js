
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://dvalxbtngopxopzcbfdm.supabase.co';
const supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR2YWx4YnRuZ29weG9wemNiZmRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY5ODkwMTksImV4cCI6MjA4MjU2NTAxOX0.rrq_vbAub4GGIcZc9cpS-QxGFYQ3B0aeka2p4xiYKiE';
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
