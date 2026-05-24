import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    console.log('Fetching lead count by status...');
    const stats = await pool.query('SELECT status, COUNT(*) FROM leads GROUP BY status');
    console.table(stats.rows);

    console.log('Fetching recent leads...');
    const recentLeads = await pool.query('SELECT id, company_name, contact_email, status, error_message FROM leads ORDER BY updated_at DESC LIMIT 10');
    console.table(recentLeads.rows);

    console.log('Fetching pending/recent emails...');
    const recentEmails = await pool.query('SELECT id, recipient_email, status, subject, error_message FROM emails ORDER BY created_at DESC LIMIT 10');
    console.table(recentEmails.rows);
  } catch (error) {
    console.error('Error during DB inspection:', error);
  } finally {
    await pool.end();
  }
}

run();
