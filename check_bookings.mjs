import fetch from 'node-fetch';

async function checkBookings() {
  const anonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR2YWx4YnRuZ29weG9wemNiZmRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY5ODkwMTksImV4cCI6MjA4MjU2NTAxOX0.rrq_vbAub4GGIcZc9cpS-QxGFYQ3B0aeka2p4xiYKiE';
  
  const res = await fetch('https://dvalxbtngopxopzcbfdm.supabase.co/rest/v1/bookings?select=day_of_week&limit=10', { 
    headers: { 
      'apikey': anonKey, 
      'Authorization': 'Bearer ' + anonKey 
    } 
  });
  const data = await res.json();

  console.log('Bookings day_of_week values:', data);
}

checkBookings();
