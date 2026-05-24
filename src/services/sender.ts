import axios from 'axios';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { query } from '../db/client.js';
import { sendTelegramNotification } from './telegram.js';
import { sendSmtpEmail } from './smtp.js';

dotenv.config();

const MAILBLUSTER_API_KEY = process.env.MAILBLUSTER_API_KEY;
const MAILBLUSTER_API_BASE = 'https://api.mailbluster.com/api';
const SENDER_EMAIL = process.env.SENDER_EMAIL || 'contact@vishnuvardhanburri.in';
const SENDER_NAME = process.env.SENDER_NAME || 'Vishnu Vardhan Burri';

/**
 * Generates MD5 hash of an email (used by MailBluster to identify leads)
 */
function getLeadHash(email: string): string {
  return crypto.createHash('md5').update(email.toLowerCase().trim()).digest('hex');
}

/**
 * Creates or updates a lead in MailBluster with custom fields and tags.
 * MailBluster automation workflows (configured in dashboard) will trigger
 * the actual email send when the lead is tagged with the sequence step tag.
 *
 * Flow:
 *   1. Our system pushes lead → MailBluster via API (with custom fields + tag)
 *   2. MailBluster automation fires on "Lead is attached to a tag"
 *   3. MailBluster sends the email template using the custom field merge tags
 */
export async function pushLeadToMailBluster(
  toEmail: string,
  companyName: string,
  jobTitle: string,
  sequenceStep: number
): Promise<string> {
  if (!MAILBLUSTER_API_KEY) {
    throw new Error('Missing MAILBLUSTER_API_KEY in environment variables.');
  }

  const leadHash = getLeadHash(toEmail);
  const stepTag = `outreach-step-${sequenceStep}`;

  // Strip down custom fields payload to respect MailBluster's strict 50-character limit
  const leadPayload: any = {
    email: toEmail,
    firstName: companyName.substring(0, 50),  // Using firstName to store company for display
    subscribed: true,
    overrideExisting: true,
    fields: {
      company_name: companyName.substring(0, 50),
      job_title: jobTitle.substring(0, 50),
      sequence_step: String(sequenceStep),
      sender_name: SENDER_NAME.substring(0, 50),
    },
    tags: [stepTag, 'outreach-active'],
  };

  try {
    // Try to create new lead first
    const createResponse = await axios.post(
      `${MAILBLUSTER_API_BASE}/leads`,
      leadPayload,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': MAILBLUSTER_API_KEY,
        },
        timeout: 15000,
      }
    );

    if (createResponse.data && (createResponse.data.lead || createResponse.data.message === 'Lead already exists')) {
      // If lead already exists, update it with PUT
      if (createResponse.data.message === 'Lead already exists') {
        const updateResponse = await axios.put(
          `${MAILBLUSTER_API_BASE}/leads/${leadHash}`,
          leadPayload,
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': MAILBLUSTER_API_KEY,
            },
            timeout: 15000,
          }
        );
        return `updated:${leadHash}`;
      }
      return `created:${leadHash}`;
    }

    return `pushed:${leadHash}`;
  } catch (error: any) {
    // Handle 422 "Lead already exists" — update instead
    if (error?.response?.status === 422 || error?.response?.data?.message?.includes('already exists')) {
      try {
        await axios.put(
          `${MAILBLUSTER_API_BASE}/leads/${leadHash}`,
          leadPayload,
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': MAILBLUSTER_API_KEY,
            },
            timeout: 15000,
          }
        );
        return `updated:${leadHash}`;
      } catch (updateErr: any) {
        throw new Error(`MailBluster update failed: ${updateErr?.response?.data?.message || updateErr.message}`);
      }
    }
    throw new Error(`MailBluster API error: ${error?.response?.data?.message || error.message}`);
  }
}

/**
 * Removes a tag from a lead in MailBluster (e.g. when marking as replied)
 */
export async function removeMailBlusterTag(email: string, tag: string): Promise<void> {
  if (!MAILBLUSTER_API_KEY) return;

  const leadHash = getLeadHash(email);

  try {
    // Get current lead data
    const getResponse = await axios.get(
      `${MAILBLUSTER_API_BASE}/leads/${leadHash}`,
      {
        headers: {
          'Authorization': MAILBLUSTER_API_KEY,
        },
        timeout: 10000,
      }
    );

    if (getResponse.data?.lead) {
      const currentTags: string[] = getResponse.data.lead.tags || [];
      const updatedTags = currentTags.filter((t: string) => t !== tag && t !== 'outreach-active');
      updatedTags.push('replied');

      await axios.put(
        `${MAILBLUSTER_API_BASE}/leads/${leadHash}`,
        {
          tags: updatedTags,
          subscribed: false,  // Unsubscribe replied leads from future campaigns
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': MAILBLUSTER_API_KEY,
          },
          timeout: 10000,
        }
      );
    }
  } catch (err) {
    console.warn(`Failed to update MailBluster lead tag for ${email}:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Processes the queue of validated & approved emails and pushes them to MailBluster
 */
export async function processOutboundEmails(limitCount: number = 10) {
  console.log('Checking for approved emails ready to push to MailBluster...');
  
  // Calculate emails sent today
  const sentTodayRes = await query(
    `SELECT COUNT(*) as count 
     FROM emails 
     WHERE status = 'sent' AND sent_at >= NOW() - INTERVAL '1 day'`
  );
  const sentToday = parseInt(sentTodayRes.rows[0].count || '0');
  const maxDailyLimit = parseInt(process.env.DAILY_EMAIL_LIMIT || '250');

  if (sentToday >= maxDailyLimit) {
    console.warn(`Daily outreach limit reached (${sentToday}/${maxDailyLimit} sent). Skipping dispatch.`);
    return 0;
  }

  const remainingToday = maxDailyLimit - sentToday;
  const currentRunLimit = Math.min(limitCount, remainingToday);
  
  console.log(`Outreach stats: ${sentToday}/${maxDailyLimit} sent. Available slot count for this batch: ${currentRunLimit}`);
  if (currentRunLimit <= 0) return 0;

  // Retrieve validated, approved and pending emails
  const res = await query(
    `SELECT e.id, e.recipient_email, e.subject, e.body, e.lead_id, e.sequence_step, l.company_name, l.job_title
     FROM emails e
     JOIN leads l ON e.lead_id = l.id
     WHERE e.status = 'pending' AND l.status = 'validated' AND l.is_approved = TRUE
     ORDER BY e.id ASC LIMIT $1`,
    [currentRunLimit]
  );

  console.log(`Pushing ${res.rows.length} leads to MailBluster in this batch.`);
  let sentCount = 0;

  for (const row of res.rows) {
    const { id, recipient_email, subject, body, lead_id, sequence_step, company_name, job_title } = row;
    try {
      console.log(`Sending Step ${sequence_step} email to ${recipient_email} via Hostinger SMTP...`);
      
      // Update state to 'sending' to avoid double pushes
      await query(`UPDATE emails SET status = 'sending' WHERE id = $1`, [id]);
      
      // 1. Dispatch cold email directly via SMTP
      const smtpSuccess = await sendSmtpEmail(recipient_email, subject, body.replace(/\n/g, '<br>'));
      if (!smtpSuccess) {
        throw new Error('SMTP delivery failed. Ensure IMAP_USER and IMAP_PASSWORD are set in environment variables.');
      }
      
      // 2. Sync lead metadata to MailBluster (avoiding long subject/body custom fields to bypass 50-character limit)
      let mailBlusterResult = 'MailBluster sync skipped (no key)';
      if (MAILBLUSTER_API_KEY && MAILBLUSTER_API_KEY !== 'your_mailbluster_api_key_here') {
        try {
          mailBlusterResult = await pushLeadToMailBluster(
            recipient_email,
            company_name,
            job_title || '',
            sequence_step
          );
        } catch (mbErr) {
          console.warn(`[MailBluster Sync Warning] Failed to sync ${recipient_email}:`, mbErr instanceof Error ? mbErr.message : mbErr);
          mailBlusterResult = `Sync failed: ${mbErr instanceof Error ? mbErr.message : String(mbErr)}`;
        }
      }
      
      await query('BEGIN');
      // Mark email as sent
      await query(
        `UPDATE emails SET status = 'sent', sent_at = NOW(), error_message = $1 WHERE id = $2`,
        [`SMTP: Success | MailBluster: ${mailBlusterResult}`, id]
      );

      // Determine follow-up schedule
      let nextStatus = 'sent';
      let nextFollowupAt = null;

      if (sequence_step === 1) {
        nextFollowupAt = new Date();
        nextFollowupAt.setDate(nextFollowupAt.getDate() + 3); // 3 days for step 2
      } else if (sequence_step === 2) {
        nextFollowupAt = new Date();
        nextFollowupAt.setDate(nextFollowupAt.getDate() + 4); // 4 days for step 3
      } else {
        nextStatus = 'outreach_completed';
      }

      // Update lead
      await query(
        `UPDATE leads 
         SET status = $1, is_approved = FALSE, next_followup_at = $2, updated_at = NOW() 
         WHERE id = $3`,
        [nextStatus, nextFollowupAt, lead_id]
      );
      
      await query('COMMIT');
      console.log(`✔ Lead email successfully sent & synced to MailBluster: ${recipient_email} [${mailBlusterResult}]`);
      
      // Telegram Notification
      let emoji = sequence_step === 1 ? '🚀' : sequence_step === 2 ? '✉️' : '🏁';
      await sendTelegramNotification(
        `${emoji} <b>Outreach Dispatch Success</b>\n` +
        `Company: <b>${company_name}</b>\n` +
        `Recipient: <code>${recipient_email}</code>\n` +
        `Step: <b>${sequence_step}/3</b>\n` +
        (nextFollowupAt ? `Next Follow-up scheduled for: <i>${nextFollowupAt.toLocaleDateString()}</i>` : `Outreach sequence complete.`)
      );

      sentCount++;
      
      // Respect MailBluster rate limit: 10 req/sec, 100 req/min
      // Sleep 1.5s between pushes to stay safe
      await new Promise(resolve => setTimeout(resolve, 1500));
    } catch (err) {
      await query('ROLLBACK');
      console.error(`❌ Failed to dispatch email for lead ${id} (${recipient_email}):`, err);
      
      const errMsg = err instanceof Error ? err.message : String(err);
      await query('BEGIN');
      await query(
        `UPDATE emails SET status = 'failed', error_message = $1 WHERE id = $2`,
        [errMsg, id]
      );
      await query(
        `UPDATE leads SET status = 'failed', updated_at = NOW() WHERE id = $1`,
        [lead_id]
      );
      await query('COMMIT');

      await sendTelegramNotification(
        `⚠️ <b>Outreach Dispatch Failure</b>\n` +
        `Company: <b>${company_name}</b>\n` +
        `Recipient: <code>${recipient_email}</code>\n` +
        `Error: <code>${errMsg}</code>`
      );
    }
  }

  console.log(`MailBluster batch push finished. Pushed: ${sentCount}`);
  return sentCount;
}
