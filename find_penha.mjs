import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://dvalxbtngopxopzcbfdm.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR2YWx4YnRuZ29weG9wemNiZmRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY5ODkwMTksImV4cCI6MjA4MjU2NTAxOX0.rrq_vbAub4GGIcZc9cpS-QxGFYQ3B0aeka2p4xiYKiE';
const supabase = createClient(supabaseUrl, supabaseKey);

async function findRecentProfiles() {
    const today = new Date();
    today.setHours(today.getHours() - 4); // last 4 hours
    
    console.log("Checking profiles created in the last 4 hours:");
    const { data: profiles, error } = await supabase.from('profiles')
        .select('*')
        .gte('created_at', today.toISOString())
        .order('created_at', { ascending: false });
        
    if (error) console.error(error);
    else console.log(profiles.map(p => ({id: p.id, name: p.full_name, email: p.email, created: p.created_at})));
}
findRecentProfiles().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
