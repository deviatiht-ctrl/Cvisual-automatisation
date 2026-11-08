import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

async function migrate() {
  const sql = fs.readFileSync('supabase_schema.sql', 'utf8');
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const projectRef = process.env.SUPABASE_PROJECT_REF || 'oykuhhogcdbmoybskexd';

  if (!token) {
    console.log('[Migrate] Notice: Set SUPABASE_ACCESS_TOKEN environment variable to run migrations via Management API.');
    return;
  }

  console.log(`[Migrate] Sending supabase_schema.sql to project ${projectRef}...`);

  const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query: sql })
  });

  const data = await response.json();
  if (response.ok) {
    console.log('[Migrate] SUCCESS! Schema migration applied to Supabase database.');
  } else {
    console.error('[Migrate] ERROR from Supabase API:', data);
  }
}

migrate().catch(console.error);
