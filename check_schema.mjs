async function test() {
  const anonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR2YWx4YnRuZ29weG9wemNiZmRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY5ODkwMTksImV4cCI6MjA4MjU2NTAxOX0.rrq_vbAub4GGIcZc9cpS-QxGFYQ3B0aeka2p4xiYKiE';
  
  const res = await fetch('https://dvalxbtngopxopzcbfdm.supabase.co/rest/v1/job_applications?select=*&order=created_at.desc&limit=1', { headers: { 'apikey': anonKey, 'Authorization': 'Bearer ' + anonKey } });
  const data = await res.json();

  if (data && data.length > 0) {
      console.log('Available columns in job_applications:', Object.keys(data[0]));
      console.log('Sample Data:', JSON.stringify(data[0], null, 2));
  } else {
      console.log('No data found, cannot infer schema this way. Will need to ask the user.');
  }
}

test();
