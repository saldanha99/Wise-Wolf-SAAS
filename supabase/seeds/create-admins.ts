
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://api.wisewolflanguage.com.br';
if (new URL(supabaseUrl).hostname.endsWith('.supabase.co')) {
    throw new Error('Hosted Supabase is not an allowed seed target.');
}
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseServiceKey) {
    console.error('Error: SUPABASE_SERVICE_ROLE_KEY environment variable is required.');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
        autoRefreshToken: false,
        persistSession: false
    }
});

const admins = [
    {
        email: 'wisewolflanguague@gmail.com',
        password: '123123',
        role: 'SCHOOL_ADMIN',
        fullName: 'Diretor Wise Wolf',
        tenantId: 'school-wise-wolf'
    },
    {
        email: 'saldanha372@gmail.com',
        password: '123123',
        role: 'SUPER_ADMIN',
        fullName: 'Super Admin',
        tenantId: 'school-wise-wolf'
    }
];

async function seedAdmins() {
    console.log('Starting Admin Seeding...');

    // CLEANUP: Try to delete known hardcoded IDs from previous migrations (Zombies)
    const zombieIds = [
        'd0d0d0d0-d0d0-d0d0-d0d0-d0d0d0d0d0d0',
        'e0e0e0e0-e0e0-e0e0-e0e0-e0e0e0e0e0e0'
    ];

    for (const id of zombieIds) {
        console.log(`Checking for zombie user ${id}...`);
        const { error } = await supabase.auth.admin.deleteUser(id);
        if (error) {
            // Expected if already gone
            // consol.log(`Zombie delete result: ${error.message}`); 
        } else {
            console.log(`Deleted zombie ${id} successfully.`);
        }
    }

    for (const admin of admins) {
        console.log(`Processing admin: ${admin.email}`);

        let userId;

        // 1. Check if user exists
        const { data: existingUsers, error: listError } = await supabase.auth.admin.listUsers();

        if (listError) {
            console.error('List Users Error:', listError);
            continue;
        }

        const existingUser = existingUsers.users.find(u => u.email === admin.email);

        if (existingUser) {
            console.log(`User ${admin.email} already exists (ID: ${existingUser.id}). Updating password...`);
            userId = existingUser.id;
            const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
                password: admin.password,
                email_confirm: true,
                user_metadata: { full_name: admin.fullName }
            });

            if (updateError) {
                console.error(`Error updating user ${admin.email}:`, updateError);
                // Continue to profile upsert anyway? Maybe.
            }
        } else {
            console.log(`Creating user ${admin.email}...`);
            const { data: newUser, error: createError } = await supabase.auth.admin.createUser({
                email: admin.email,
                password: admin.password,
                email_confirm: true,
                user_metadata: { full_name: admin.fullName }
            });

            if (createError) {
                console.error(`Error creating user ${admin.email}:`, createError);
                continue;
            }
            userId = newUser.user.id;
            console.log(`User created with ID: ${userId}`);
        }

        // 2. Upsert Profile
        if (userId) {
            console.log(`Upserting profile for ${userId}...`);

            const { error: profileError } = await supabase
                .from('profiles')
                .upsert({
                    id: userId,
                    email: admin.email,
                    full_name: admin.fullName,
                    role: admin.role,
                    tenant_id: admin.tenantId,
                    status_financial: 'ACTIVE',
                    updated_at: new Date().toISOString()
                }, { onConflict: 'id' });

            if (profileError) {
                console.error(`Error upserting profile for ${admin.email}:`, profileError);
            } else {
                console.log(`Profile updated for ${admin.email}.`);
            }
        }
    }

    console.log('Admin Seeding Completed.');
}

seedAdmins().catch(err => console.error('Seeding Script Failed:', err));
