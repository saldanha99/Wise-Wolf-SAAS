async function test() {
  const anonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR2YWx4YnRuZ29weG9wemNiZmRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY5ODkwMTksImV4cCI6MjA4MjU2NTAxOX0.rrq_vbAub4GGIcZc9cpS-QxGFYQ3B0aeka2p4xiYKiE';
  
  const res = await fetch('https://dvalxbtngopxopzcbfdm.supabase.co/rest/v1/job_applications?select=*&order=created_at.desc&limit=2', { headers: { 'apikey': anonKey, 'Authorization': 'Bearer ' + anonKey } });
  const data = await res.json();
  console.log('Recent Applications:', JSON.stringify(data, null, 2));

  if (data && data.length > 0) {
      const tenant = data[0].tenant_id;
      const resProfile = await fetch(`https://dvalxbtngopxopzcbfdm.supabase.co/rest/v1/profiles?select=email,whatsapp_instance,hr_group_id,teachers_group_id,tenant_id&tenant_id=eq.${tenant}&limit=1`, { headers: { 'apikey': anonKey, 'Authorization': 'Bearer ' + anonKey } });
      const profileData = await resProfile.json();
      console.log(`\nProfiles for tenant: ${tenant}\n`, JSON.stringify(profileData, null, 2));
      
      const resLogs = await fetch(`https://dvalxbtngopxopzcbfdm.supabase.co/rest/v1/whatsapp_messages_log?select=*&order=created_at.desc&limit=5`, { headers: { 'apikey': anonKey, 'Authorization': 'Bearer ' + anonKey } });
      const logData = await resLogs.json();
      console.log('\nRecent WhatsApp Logs:', JSON.stringify(logData, null, 2));
  }
}

test();
