import { query, pool } from './client.js';

async function runMigration() {
  console.log('Running database schema migrations...');

  const migrateLeadsTable = `
    ALTER TABLE leads 
      ADD COLUMN IF NOT EXISTS is_approved BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS sequence_step INTEGER DEFAULT 1,
      ADD COLUMN IF NOT EXISTS next_followup_at TIMESTAMP DEFAULT NULL;
  `;

  const migrateEmailsTable = `
    ALTER TABLE emails 
      ADD COLUMN IF NOT EXISTS sequence_step INTEGER DEFAULT 1;
  `;

  try {
    await query(migrateLeadsTable);
    console.log('✔ Leads table columns updated (is_approved, sequence_step, next_followup_at).');

    await query(migrateEmailsTable);
    console.log('✔ Emails table columns updated (sequence_step).');

    console.log('Migration completed successfully.');
  } catch (err) {
    console.error('Failed to run database migrations:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigration();
