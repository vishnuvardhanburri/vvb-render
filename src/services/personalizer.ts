import axios from 'axios';
import dotenv from 'dotenv';
import { query } from '../db/client.js';
import { sendTelegramNotification } from './telegram.js';

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
1. System Signal Audit: A 2-3 day deep dive to identify what is breaking, why it is slow, and map boundaries/risks. Returns a 7-14 day action plan.
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
 * human-level outreach email depending on the sequence step.
 */
export async function generatePersonalizedEmail(
  companyName: string,
  domain: string,
  jobTitle: string,
  jobDescription: string,
  scrapedText: string,
  scrapedEmails: string[],
  sequenceStep: number
): Promise<GeminiOutput> {
  if (!GEMINI_API_KEY) {
    throw new Error('Missing GEMINI_API_KEY in environment variables.');
  }

  let prompt = '';

  if (sequenceStep === 1) {
    prompt = `
You are an advanced B2B outreach researcher. You are writing a short, highly-personalized initial cold email from the perspective of Vishnu Vardhan Burri, a Toptal-verified Senior Backend & Platform Engineer.

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
1. DO NOT use generic sales fluff, corporate speak, or boilerplate introductions. (Avoid: "Hope this email finds you well", "I was checking your site", "I'm writing to you because", "We are a top agency").
2. Start directly with a hook related to their job posting and engineering requirements (e.g. "Saw you're bringing on a backend engineer to handle your Go service concurrency..." or "Looks like you're scaling out your PostgreSQL database and Stripe billing pipeline...").
3. Connect their immediate engineering challenge directly to one of Vishnu's specific case studies (e.g. Microsoft MTTR, Stripe double-charge prevention, or banking migrations).
4. Propose a friction-free value offer: a quick 10-15 minute "System Signal Audit" where Vishnu reviews their architecture/bottlenecks for free and gives them a 3-step action plan they can use immediately (with no sales pitch). Mention a call booking link: https://cal.com/vishnuvardhanburri/30min
5. The tone must be a peer-to-peer developer/technical founder communication: professional, humble, highly knowledgeable, and brief (under 120-150 words).
6. Subject line must be extremely short, casual, and lower-case to get opened (e.g. "concurrency query", "postgresql latency", "stripe integration", "on-call issues"). No capital letters, no sales words.
7. If the list of scraped emails is empty or lacks a direct engineering/contact email, suggest the most logical email address to send this to (e.g. hello@, contact@, engineering@, info@, jobs@).
`;
  } else if (sequenceStep === 2) {
    prompt = `
You are writing a short follow-up email (Sequence Step 2 - BUMP) from the perspective of Vishnu Vardhan Burri, a Toptal-verified Senior Backend & Platform Engineer, to the client at ${companyName}.
This email is sent 3 days after the initial outreach.

Your goal is to send a very short, friendly, conversational check-in (bump) that gets a response.

CRITICAL GUIDELINES:
1. Keep it extremely brief (under 50-70 words).
2. Do not repeat the whole pitch. Just ask if they had a chance to read the previous email or check out Vishnu's Microsoft case study (MTTR reduced by 40%).
3. Reference their company name (${companyName}) and their backend engineering needs.
4. Close with a friendly offer to chat: "Let me know if a 15-minute audit makes sense this week: https://cal.com/vishnuvardhanburri/30min"
5. Keep the subject line the same or draft a short one like "quick follow up" or "concurrency / scaling".
`;
  } else {
    prompt = `
You are writing a final follow-up email (Sequence Step 3 - BREAKUP) from the perspective of Vishnu Vardhan Burri, a Toptal-verified Senior Backend & Platform Engineer, to the client at ${companyName}.
This email is sent 4 days after Step 2.

Your goal is to send a polite "breakup" email to close the loop cleanly.

CRITICAL GUIDELINES:
1. Keep it extremely brief (under 60 words).
2. State clearly that this is the last email you will send so you don't clutter their inbox.
3. Ask if backend scaling/stability is a focus for ${companyName} this quarter. If not, no worries at all.
4. Keep the tone warm, professional, and respectful of their time.
5. Subject line should be the same as previous or "closing the loop".
`;
  }

  prompt += `
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
    console.error(`Gemini API Error for ${companyName} (Step ${sequenceStep}):`, error instanceof Error ? error.message : error);
    throw error;
  }
}

/**
 * Researches new leads and schedules follow-up emails for existing leads
 */
export async function researchAndPersonalizeLeads() {
  console.log('Running company research and email personalization...');
  
  // -- PART A: Process newly discovered leads (Step 1) --
  const newLeads = await query(
    "SELECT * FROM leads WHERE status = 'discovered' ORDER BY id ASC LIMIT 10"
  );
  
  console.log(`Found ${newLeads.rows.length} newly discovered leads.`);

  for (const lead of newLeads.rows) {
    try {
      console.log(`Researching discovered lead ${lead.id}: ${lead.company_name} (${lead.domain})`);
      
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

      const geminiResult = await generatePersonalizedEmail(
        lead.company_name,
        lead.domain,
        lead.job_title,
        lead.job_description || '',
        scrapedText,
        scrapedEmails,
        1 // Sequence Step 1
      );

      let finalEmail = lead.contact_email || scrapedEmails[0] || geminiResult.suggestedEmail || `hello@${lead.domain}`;

      await query('BEGIN');
      
      // Update lead
      await query(
        `UPDATE leads 
         SET contact_email = $1, research_notes = $2, status = 'researched', is_approved = FALSE, sequence_step = 1, updated_at = NOW()
         WHERE id = $3`,
        [finalEmail, scrapedText, lead.id]
      );

      // Insert pending draft email
      await query(
        `INSERT INTO emails (lead_id, recipient_email, subject, body, status, sequence_step)
         VALUES ($1, $2, $3, $4, 'pending', 1)`,
        [lead.id, finalEmail, geminiResult.subject, geminiResult.emailBody]
      );

      await query('COMMIT');
      console.log(`✔ Researched ${lead.company_name} and saved Step 1 draft for ${finalEmail}`);
      
      // Telegram Notification
      await sendTelegramNotification(
        `📝 <b>New Outreach Draft Generated</b>\n` +
        `Company: <b>${lead.company_name}</b>\n` +
        `Subject: <i>${geminiResult.subject}</i>\n` +
        `Email: <code>${finalEmail}</code>\n\n` +
        `Review and approve this draft on your HUD dashboard.`
      );
    } catch (err) {
      await query('ROLLBACK');
      console.error(`Failed to process new lead ${lead.id}:`, err);
      await query(
        `UPDATE leads SET status = 'scraping_failed', updated_at = NOW() WHERE id = $1`,
        [lead.id]
      );
    }
  }

  // -- PART B: Process pending follow-ups (Step 2 and Step 3) --
  const followups = await query(
    `SELECT * FROM leads 
     WHERE status = 'sent' 
       AND next_followup_at <= NOW() 
       AND sequence_step < 3 
     ORDER BY id ASC LIMIT 10`
  );

  console.log(`Found ${followups.rows.length} leads due for follow-ups.`);

  for (const lead of followups.rows) {
    const nextStep = lead.sequence_step + 1;
    try {
      console.log(`Generating Step ${nextStep} follow-up for ${lead.company_name}...`);
      
      const geminiResult = await generatePersonalizedEmail(
        lead.company_name,
        lead.domain,
        lead.job_title,
        lead.job_description || '',
        lead.research_notes || '',
        [],
        nextStep
      );

      await query('BEGIN');
      
      // Update lead sequence step and status
      await query(
        `UPDATE leads 
         SET status = 'researched', is_approved = FALSE, sequence_step = $1, updated_at = NOW()
         WHERE id = $2`,
        [nextStep, lead.id]
      );

      // Insert pending draft follow-up email
      await query(
        `INSERT INTO emails (lead_id, recipient_email, subject, body, status, sequence_step)
         VALUES ($1, $2, $3, $4, 'pending', $5)`,
        [lead.id, lead.contact_email, geminiResult.subject, geminiResult.emailBody, nextStep]
      );

      await query('COMMIT');
      console.log(`✔ Generated Step ${nextStep} follow-up draft for ${lead.company_name}`);

      await sendTelegramNotification(
        `📬 <b>Step ${nextStep} Follow-up Draft Ready</b>\n` +
        `Company: <b>${lead.company_name}</b>\n` +
        `Email: <code>${lead.contact_email}</code>\n\n` +
        `Please approve on your HUD dashboard.`
      );
    } catch (err) {
      await query('ROLLBACK');
      console.error(`Failed to generate follow-up ${nextStep} for lead ${lead.id}:`, err);
    }
  }
}
