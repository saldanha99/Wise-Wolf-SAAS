
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://api.wisewolflanguage.com.br');
const supabaseKey = (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '');

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
