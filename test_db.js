
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://dvalxbtngopxopzcbfdm.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR2YWx4YnRuZ29weG9wemNiZmRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY5ODkwMTksImV4cCI6MjA4MjU2NTAxOX0.rrq_vbAub4GGIcZc9cpS-QxGFYQ3B0aeka2p4xiYKiE';

const supabase = createClient(supabaseUrl, supabaseKey);

async function testInsert() {
    console.log("Testing insert into class_logs...");
    // Get a valid student and teacher and tenant
    const { data: profiles } = await supabase.from('profiles').select('id, tenant_id, role').limit(10);
    const teacher = profiles.find(p => p.role === 'TEACHER');
    const student = profiles.find(p => p.role === 'STUDENT');

    if (!teacher || !student) {
        console.error("Teacher or student not found");
        return;
    }

    const entry = {
        tenant_id: teacher.tenant_id,
        teacher_id: teacher.id,
        student_id: student.id,
        presence: 'Presença',
        created_at: new Date().toISOString()
    };

    const { error: logError } = await supabase.from('class_logs').insert([entry]);
    if (logError) {
        console.error("class_logs insert error:", logError);
    } else {
        console.log("class_logs insert success!");
    }

    console.log("Testing insert into reschedules...");
    const resch = {
        tenant_id: teacher.tenant_id,
        teacher_id: teacher.id,
        student_id: student.id,
        date: 'Pendente',
        time: 'Pendente',
        created_at: new Date().toISOString()
    };

    const { error: resError } = await supabase.from('reschedules').insert([resch]);
    if (resError) {
        console.error("reschedules insert error:", resError);
    } else {
        console.log("reschedules insert success!");
    }
}

testInsert();
