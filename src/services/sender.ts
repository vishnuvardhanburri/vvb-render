import axios from 'axios';
import dotenv from 'dotenv';
import { query } from '../db/client.js';
import { sendTelegramNotification } from './telegram.js';

dotenv.config();

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const SENDER_EMAIL = process.env.SENDER_EMAIL || 'contact@vishnuvardhanburri.in';
const SENDER_NAME = process.env.SENDER_NAME || 'Vishnu Vardhan Burri';
const REPLY_TO_EMAIL = process.env.REPLY_TO_EMAIL || 'contact@vishnuvardhanburri.in';

/**
 * Sends a single email via Brevo API
 */
export async function sendEmailViaBrevo(
  toEmail: string,
  subject: string,
  body: string
): Promise<string> {
  if (!BREVO_API_KEY) {
    throw new Error('Missing BREVO_API_KEY in environment variables.');
  }

  const endpoint = 'https://api.brevo.com/v3/smtp/email';
  const payload = {
    sender: {
      name: SENDER_NAME,
      email: SENDER_EMAIL
    },
    to: [
      {
        email: toEmail
      }
    ],
    replyTo: {
      email: REPLY_TO_EMAIL
    },
    subject: subject,
    textContent: body
  };

  const response = await axios.post(endpoint, payload, {
    headers: {
      'accept': 'application/json',
      'api-key': BREVO_API_KEY,
      'content-type': 'application/json'
    },
    timeout: 10000
  });

  if (response.data && response.data.messageId) {
    return response.data.messageId;
  }

  throw new Error(`Unexpected response from Brevo: ${JSON.stringify(response.data)}`);
}

/**
 * Processes the queue of validated & approved emails and sends them, respecting daily limits
 */
export async function processOutboundEmails(limitCount: number = 10) {
  console.log('Checking for approved emails ready to send...');
  
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
    `SELECT e.id, e.recipient_email, e.subject, e.body, e.lead_id, e.sequence_step, l.company_name
     FROM emails e
     JOIN leads l ON e.lead_id = l.id
     WHERE e.status = 'pending' AND l.status = 'validated' AND l.is_approved = TRUE
     ORDER BY e.id ASC LIMIT $1`,
    [currentRunLimit]
  );

  console.log(`Dispatching ${res.rows.length} emails in this batch.`);
  let sentCount = 0;

  for (const row of res.rows) {
    const { id, recipient_email, subject, body, lead_id, sequence_step, company_name } = row;
    try {
      console.log(`Sending Step ${sequence_step} email ${id} to ${recipient_email}...`);
      
      // Update state to 'sending' to avoid double sends
      await query(`UPDATE emails SET status = 'sending' WHERE id = $1`, [id]);
      
      const messageId = await sendEmailViaBrevo(recipient_email, subject, body);
      
      await query('BEGIN');
      // Mark email as sent
      await query(
        `UPDATE emails SET status = 'sent', sent_at = NOW(), error_message = $1 WHERE id = $2`,
        [`MessageId: ${messageId}`, id]
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
      console.log(`✔ Email successfully sent to ${recipient_email}. MsgId: ${messageId}`);
      
      // Telegram Notification
      let emoji = sequence_step === 1 ? '🚀' : sequence_step === 2 ? '✉️' : '🏁';
      await sendTelegramNotification(
        `${emoji} <b>Outreach Sent Successfully</b>\n` +
        `Company: <b>${company_name}</b>\n` +
        `Recipient: <code>${recipient_email}</code>\n` +
        `Step: <b>${sequence_step}/3</b>\n` +
        (nextFollowupAt ? `Next Follow-up scheduled for: <i>${nextFollowupAt.toLocaleDateString()}</i>` : `Outreach sequence complete.`)
      );

      sentCount++;
      
      // Sleep briefly between sends to look human
      await new Promise(resolve => setTimeout(resolve, 5000));
    } catch (err) {
      await query('ROLLBACK');
      console.error(`❌ Failed to send email ${id} to ${recipient_email}:`, err);
      
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
        `⚠️ <b>Email Dispatch Failure</b>\n` +
        `Company: <b>${company_name}</b>\n` +
        `Recipient: <code>${recipient_email}</code>\n` +
        `Error: <code>${errMsg}</code>`
      );
    }
  }

  console.log(`Email batch run finished. Sent: ${sentCount}`);
  return sentCount;
}
