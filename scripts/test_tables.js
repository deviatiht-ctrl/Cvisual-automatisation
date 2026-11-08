import dotenv from 'dotenv';
dotenv.config();

async function check() {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const projectRef = process.env.SUPABASE_PROJECT_REF || 'oykuhhogcdbmoybskexd';

  if (!token) {
    console.log('[Check] Set SUPABASE_ACCESS_TOKEN to query database tables via API.');
    return;
  }

  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query: "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'cvisual_%' ORDER BY table_name;"
    })
  });

  const data = await res.json();
  console.log('CVISUAL Tables in Supabase:', data);
}

check().catch(console.error);
