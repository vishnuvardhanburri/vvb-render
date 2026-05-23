import axios from 'axios';
import dotenv from 'dotenv';
import { query } from '../db/client.js';

dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Vishnu's background data taken from portfolio constants.ts
const VISHNU_PORTFOLIO_CONTEXT = `
Name: Vishnu Vardhan Burri
Role: Senior Backend & Platform Engineer
Principles: "Correctness over cleverness", "Deep observability before failure", "Boring systems that keep running", "Security and validation by default"
Credentials:
- Toptal Verified Expert in Engineering
- B.Tech in CSE Cybersecurity (security-first engineering grounding)
- Founder of Xavira Tech Labs (stabilization, cloud-native systems, automation, AI guardrails)

Key Case Studies (Real outcomes achieved):
1. Microsoft (Enterprise SaaS): Hardened production incident response. Added structured logging, latency/error dashboards, actionable alert rules. Reduced Mean Time to Recovery (MTTR) by 40% and troubleshooting time by 50%.
2. Mattijs-IT (Fintech/Banking BaaS): Managed high-risk database migration safely with zero downtime. Rebuilt schema boundaries, dual-writes pattern, and staged cutovers. Reduced rollback incidents by 45%.
3. Secure Voice & Real-Time Booking: Engineered low-latency voice synchronization. Resolved concurrency bugs, state drifts, and encryption issues. Reduced voice session failures by 35% and sync delays by 30%.
4. Business Web Platform (SaaS / Payments): Designed default-deny RBAC auth boundaries, and transaction-safe Stripe/PayPal workflows with idempotency keys. Rebuilt postgres indexes, reducing backend latency by 40% and eliminating duplicate charges.

Service Offerings:
1. System Signal Audit: A 2-3 day deep dive to identify what is breaking, why it is slow, and map boundaries/risks. Returns a 7-14 day execution plan.
2. Stabilization Sprint: 1-2 weeks of fixing flaky hotspots, setting up observability logs/metrics, and securing release cutovers.
3. Build Under Pressure: 2-4 weeks of delivery-focused backend development, building new modules with strict validation and deployment guardrails.
4. Founder Retainer: Monthly partnership acting as senior backend counsel.
`;

interface GeminiOutput {
  subject: string;
  emailBody: string;
  suggestedEmail?: string;
}

/**
 * Invokes Gemini API to research the lead details and draft a highly-personalized,
 * human-level cold outreach email that does not sound like spam.
 */
export async function generatePersonalizedEmail(
  companyName: string,
  domain: string,
  jobTitle: string,
  jobDescription: string,
  scrapedText: string,
  scrapedEmails: string[]
): Promise<GeminiOutput> {
  if (!GEMINI_API_KEY) {
    throw new Error('Missing GEMINI_API_KEY in environment variables.');
  }

  const prompt = `
You are an advanced B2B outreach researcher. You are writing a short, highly-personalized cold email from the perspective of Vishnu Vardhan Burri, a Toptal-verified Senior Backend & Platform Engineer.

Here is Vishnu's professional background and proof of work:
---
${VISHNU_PORTFOLIO_CONTEXT}
---

Here is the target client information:
- Company Name: ${companyName}
- Domain: ${domain}
- Job Opening they are hiring for: "${jobTitle}"
- Job Details: "${jobDescription}"
- Scraped Homepage / About page text from their website:
"${scrapedText.slice(0, 1200)}"
- Scraped contact emails: [${scrapedEmails.join(', ')}]

Your goal is to write a highly-focused, conversational cold email that solves their problems. 

CRITICAL GUIDELINES FOR HIGH RESPONSE RATE:
1. DO NOT use generic sales fluff, corporate speak, or boilerplate introductions. (Avoid: "Hope this email finds you well", "I was checking your site", "I'm writing to you because", "We are a top agency", "As a Toptal engineer...").
2. Start directly with a hook related to their job posting and engineering requirements (e.g. "Saw you're bringing on a backend engineer to handle your Go service concurrency..." or "Looks like you're scaling out your PostgreSQL database and Stripe billing pipeline...").
3. Connect their immediate engineering challenge directly to one of Vishnu's specific case studies (e.g. Microsoft MTTR, Stripe double-charge prevention, or banking migrations).
4. Propose a friction-free value offer: a quick 10-15 minute "System Signal Audit" where Vishnu reviews their architecture/bottlenecks for free and gives them a 3-step action plan they can use immediately (with no sales pitch).
5. The tone must be a peer-to-peer developer/technical founder communication: professional, humble, highly knowledgeable, and brief (under 120-150 words).
6. Subject line must be extremely short, casual, and lower-case to get opened (e.g. "concurrency query", "postgresql latency", "stripe integration", "on-call issues"). No capital letters, no sales words.
7. If the list of scraped emails is empty or lacks a direct engineering/contact email, suggest the most logical email address to send this to (e.g. hello@, contact@, engineering@, info@, jobs@).

Return your response ONLY as a JSON object matching this structure:
{
  "subject": "your subject line",
  "emailBody": "the body text of the email",
  "suggestedEmail": "suggested recipient email if none scraped, or the best one to use"
}
`;

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [
          {
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          responseMimeType: 'application/json'
        }
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000
      }
    );

    const jsonText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!jsonText) {
      throw new Error('Empty response from Gemini API');
    }

    const output: GeminiOutput = JSON.parse(jsonText.trim());
    return output;
  } catch (error) {
    console.error(`Gemini API Error for ${companyName}:`, error instanceof Error ? error.message : error);
    throw error;
  }
}

/**
 * Researches and generates emails for all leads with 'discovered' status in the database.
 */
export async function researchAndPersonalizeLeads() {
  console.log('Running company research and email personalization...');
  const res = await query(
    "SELECT * FROM leads WHERE status = 'discovered' ORDER BY id ASC LIMIT 50"
  );
  
  console.log(`Found ${res.rows.length} discovered leads to process.`);
  let processed = 0;

  for (const lead of res.rows) {
    try {
      console.log(`Processing lead ${lead.id}: ${lead.company_name} (${lead.domain})`);
      
      // Import website scraper dynamically to parse website
      const { scrapeCompanyWebsite } = await import('./websiteScraper.js');
      let scrapedText = '';
      let scrapedEmails: string[] = [];

      try {
        const scrapeResult = await scrapeCompanyWebsite(lead.domain);
        scrapedText = scrapeResult.extractedText;
        scrapedEmails = scrapeResult.foundEmails;
      } catch (scrapeErr) {
        console.warn(`Web scrape failed for ${lead.domain}:`, scrapeErr instanceof Error ? scrapeErr.message : scrapeErr);
        scrapedText = 'Scrape failed. Relying on job description only.';
      }

      // Generate email content with Gemini
      const geminiResult = await generatePersonalizedEmail(
        lead.company_name,
        lead.domain,
        lead.job_title,
        lead.job_description || '',
        scrapedText,
        scrapedEmails
      );

      // Determine the final contact email
      let finalEmail = lead.contact_email || scrapedEmails[0] || geminiResult.suggestedEmail;
      
      if (!finalEmail) {
        // If still nothing, default to common contact address
        finalEmail = `hello@${lead.domain}`;
      }

      // Start database transaction
      await query('BEGIN');

      // Update lead table
      await query(
        `UPDATE leads 
         SET contact_email = $1, research_notes = $2, status = 'researched', updated_at = NOW()
         WHERE id = $3`,
        [finalEmail, scrapedText, lead.id]
      );

      // Insert pending email
      await query(
        `INSERT INTO emails (lead_id, recipient_email, subject, body, status)
         VALUES ($1, $2, $3, $4, 'pending')`,
        [lead.id, finalEmail, geminiResult.subject, geminiResult.emailBody]
      );

      await query('COMMIT');
      console.log(`✔ Researched ${lead.company_name} and queued personalized email for ${finalEmail}`);
      processed++;
    } catch (err) {
      await query('ROLLBACK');
      console.error(`Failed to process lead ${lead.id} (${lead.company_name}):`, err);
      
      // Mark lead as scraping/research failed to prevent infinite loops
      await query(
        `UPDATE leads SET status = 'scraping_failed', updated_at = NOW() WHERE id = $1`,
        [lead.id]
      );
    }
  }

  console.log(`Personalization complete. Generated ${processed} emails.`);
  return processed;
}
