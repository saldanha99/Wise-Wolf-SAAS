import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import * as dotenv from 'https://deno.land/std@0.224.0/dotenv/mod.ts'

const env = await dotenv.load({ envPath: './.env' });
const supabaseUrl = env['VITE_SUPABASE_URL'] || Deno.env.get('VITE_SUPABASE_URL')
const supabaseKey = env['VITE_SUPABASE_ANON_KEY'] || Deno.env.get('VITE_SUPABASE_ANON_KEY')

const supabase = createClient(supabaseUrl, supabaseKey)

async function run() {
  const { data: profiles, error: pErr } = await supabase.from('profiles').select('id, full_name, fixed_schedule').ilike('full_name', '%Bianca%Crepaldi%');
  console.log("Profiles:", profiles, pErr);
  
  if (profiles && profiles.length > 0) {
      const { data: bookings, error: bErr } = await supabase.from('bookings').select('id, day_of_week, time_slot, start_date').eq('student_id', profiles[0].id);
      console.log("Bookings:", bookings, bErr);
      
      // Fix the booking if it says "Wednesday"
      for (const booking of bookings || []) {
          if (booking.day_of_week === 'Wednesday') {
              const { error: updErr } = await supabase.from('bookings').update({ day_of_week: 'Quarta' }).eq('id', booking.id);
              console.log("Updated booking to Quarta:", updErr);
          }
      }
  }
}
run();
