
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const supabaseUrl = 'https://dvalxbtngopxopzcbfdm.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR2YWx4YnRuZ29weG9wemNiZmRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY5ODkwMTksImV4cCI6MjA4MjU2NTAxOX0.rrq_vbAub4GGIcZc9cpS-QxGFYQ3B0aeka2p4xiYKiE';

if (!supabaseUrl || !supabaseKey) {
    console.error("❌ Missing Supabase Credentials in .env.local");
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
    console.log("🔍 Starting Database Diagnosis...");
    console.log(`URL: ${supabaseUrl}`);

    // 1. Fetch Teachers
    const { data: teachers, error: tError } = await supabase
        .from('profiles')
        .select('id, full_name, role')
        .eq('role', 'TEACHER');

    if (tError) {
        console.error("❌ Error fetching teachers:", tError);
        return;
    }
    console.log(`\n👨‍🏫 Teachers Found: ${teachers.length}`);
    teachers.forEach(t => console.log(` - [${t.id}] ${t.full_name}`));

    // 2. Fetch ALL Availability
    const { data: avail, error: aError } = await supabase
        .from('teacher_availability')
        .select('*');

    if (aError) {
        console.error("❌ Error fetching availability:", aError);
        return;
    }
    console.log(`\n📅 Availability Entries Found: ${avail.length}`);

    // 3. Analyze Mismatches
    const teacherIds = new Set(teachers.map(t => t.id));
    const orphaned = avail.filter(a => !teacherIds.has(a.teacher_id));

    if (orphaned.length > 0) {
        console.error(`\n⚠️ ORPHANED ENTRIES FOUND: ${orphaned.length}`);
        console.error("These entries point to teacher_ids that do NOT exist in the fetched profiles.");
        orphaned.forEach(o => console.log(`   - Invalid Teacher ID: ${o.teacher_id} (Day: ${o.day_of_week})`));
    } else {
        console.log("\n✅ No orphaned availability entries found (All point to valid teachers).");
    }

    // 4. Check Specific Teacher (if known from context, e.g. Mateus)
    const targetName = "Mateus";
    const mateus = teachers.find(t => t.full_name.includes(targetName));
    if (mateus) {
        console.log(`\n🔎 Inspecting ${mateus.full_name} (${mateus.id})`);
        const mateusSlots = avail.filter(a => a.teacher_id === mateus.id);
        console.log(`   - Slots found in DB: ${mateusSlots.length}`);
        if (mateusSlots.length === 0) {
            console.warn("   ⚠️ WARNING: This teacher has NO slots in the database.");
            console.log("   Checking if he has slots under a different ID...");
            // Fuzzy search?
        } else {
            console.log("   - Sample Slot:", mateusSlots[0]);
        }
    }
}

run();
