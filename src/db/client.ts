import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.warn('Warning: DATABASE_URL is not set in environment variables.');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // SSL connection is usually required for Neon/Supabase
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : {
    rejectUnauthorized: false
  }
});

export async function query(text: string, params?: any[]) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    // Log query details in dev
    if (process.env.NODE_ENV !== 'production') {
      console.log(`Executed query: ${text.slice(0, 100)}... in ${duration}ms`);
    }
    return res;
  } catch (err) {
    console.error('Database query error:', err);
    throw err;
  }
}
