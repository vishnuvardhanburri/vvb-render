import { query, pool } from './client.js';

async function initDatabase() {
  console.log('Initializing database schema...');

  const createLeadsTable = `
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      company_name VARCHAR(255) NOT NULL,
      domain VARCHAR(255) UNIQUE,
      contact_email VARCHAR(255),
      job_title VARCHAR(255),
      job_description TEXT,
      source_url VARCHAR(512),
      status VARCHAR(50) DEFAULT 'discovered', -- 'discovered', 'scraping_failed', 'researched', 'validation_failed', 'validated', 'sent', 'failed'
      research_notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  const createEmailsTable = `
    CREATE TABLE IF NOT EXISTS emails (
      id SERIAL PRIMARY KEY,
      lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
      recipient_email VARCHAR(255) NOT NULL,
      subject VARCHAR(255) NOT NULL,
      body TEXT NOT NULL,
      status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'sending', 'sent', 'failed'
      sent_at TIMESTAMP,
      error_message TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  const createIndices = `
    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
    CREATE INDEX IF NOT EXISTS idx_leads_domain ON leads(domain);
    CREATE INDEX IF NOT EXISTS idx_emails_status ON emails(status);
  `;

  try {
    await query(createLeadsTable);
    console.log('✔ Leads table created or already exists.');

    await query(createEmailsTable);
    console.log('✔ Emails table created or already exists.');

    await query(createIndices);
    console.log('✔ Database indices created.');

    console.log('Database initialization completed successfully.');
  } catch (err) {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

initDatabase();
