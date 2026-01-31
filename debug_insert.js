
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://dvalxbtngopxopzcbfdm.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR2YWx4YnRuZ29weG9wemNiZmRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY5ODkwMTksImV4cCI6MjA4MjU2NTAxOX0.rrq_vbAub4GGIcZc9cpS-QxGFYQ3B0aeka2p4xiYKiE';

const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
    // Mateus ID from previous debug
    const teacherId = '6596a2f5-770b-4a56-99e2-ecc73dd10ee8';
    // We need a tenant_id. Let's fetch it from his profile.
    const { data: profile } = await supabase.from('profiles').select('tenant_id').eq('id', teacherId).single();
    if (!profile) {
        console.error("Profile not found");
        return;
    }

    console.log("Teacher Tenant:", profile.tenant_id);

    const slot = {
        teacher_id: teacherId,
        tenant_id: profile.tenant_id,
        day_of_week: 1, // Start of week
        start_time: '12:00'
    };

    console.log("Attempting to insert slot:", slot);

    const { data, error } = await supabase.from('teacher_availability').insert([slot]).select();

    if (error) {
        console.error("❌ Insert Failed:", error);
    } else {
        console.log("✅ Insert Success:", data);
    }
}

run();
