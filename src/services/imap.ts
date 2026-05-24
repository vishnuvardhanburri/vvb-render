import { ImapFlow } from 'imapflow';
import dotenv from 'dotenv';
import { query } from '../db/client.js';
import { sendTelegramNotification } from './telegram.js';
import { generateAiReply } from './personalizer.js';
import { sendSmtpEmail } from './smtp.js';

dotenv.config();

const IMAP_HOST = process.env.IMAP_HOST || process.env.SMTP_HOST || 'imap.hostinger.com';
const IMAP_PORT = parseInt(process.env.IMAP_PORT || '993');
const IMAP_USER = process.env.IMAP_USER || process.env.SMTP_USER;
const IMAP_PASSWORD = process.env.IMAP_PASSWORD || process.env.SMTP_PASS || process.env.SMTP_PASSWORD;

/**
 * Checks the configured IMAP inbox for replies from active leads
 */
export async function checkInboxReplies(): Promise<number> {
  if (!IMAP_HOST || !IMAP_USER || !IMAP_PASSWORD) {
    console.log('IMAP credentials are not configured in env. Skipping reply check.');
    return 0;
  }

  console.log(`Connecting to IMAP inbox at ${IMAP_HOST}...`);
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: {
      user: IMAP_USER,
      pass: IMAP_PASSWORD
    },
    logger: false
  });

  let repliedCount = 0;

  try {
    await client.connect();
    
    // Open INBOX in read-only mode to prevent modifying read flags
    let lock = await client.getMailboxLock('INBOX');
    try {
      // Find emails received in the last 7 days to check for replies
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - 7);
      
      const searchCriteria = {
        since: sinceDate
      };
      
      console.log(`Searching inbox for messages since ${sinceDate.toDateString()}...`);
      const messages = await client.search(searchCriteria);
      
      if (!messages || !Array.isArray(messages)) {
        console.log('No matching messages found in inbox.');
      } else {
        console.log(`Analyzing ${messages.length} messages for lead responses...`);
        
        for (const uid of messages) {
          const fetchResult = await client.fetchOne(uid, { envelope: true, bodyParts: ['TEXT'] });
          
          if (!fetchResult || !fetchResult.envelope) continue;
          
          const envelope = fetchResult.envelope;
          const fromAddress = envelope.from?.[0]?.address?.toLowerCase();
          
          if (!fromAddress) continue;
          
          // Query database to see if this sender is a lead we are currently pitching
          const leadRes = await query(
            `SELECT id, company_name, contact_email, status 
             FROM leads 
             WHERE LOWER(contact_email) = $1 AND (status != 'replied' OR reply_content IS NULL)`,
            [fromAddress]
          );
          
          if (leadRes.rows.length > 0) {
            const lead = leadRes.rows[0];
            console.log(`🔥 Response detected from lead ${lead.company_name} (${fromAddress})!`);
            
            let replyContent = '';
            if (fetchResult.bodyParts) {
              const textPart = fetchResult.bodyParts.get('TEXT');
              if (textPart) {
                replyContent = textPart.toString();
              }
            }

            // Generate AI reply draft
            let aiReplyDraft = '';
            try {
              aiReplyDraft = await generateAiReply(lead.company_name, replyContent);
              console.log(`✔ Generated AI reply draft for ${lead.company_name}`);
            } catch (geminiErr) {
              console.warn(`Failed to generate AI reply draft for ${lead.company_name}:`, geminiErr);
            }

            // Check database setting for auto-reply
            const settingsRes = await query(`SELECT value FROM system_settings WHERE key = 'auto_reply_enabled'`);
            const autoReplyEnabled = settingsRes.rows[0]?.value !== 'false';

            let replySent = false;
            if (autoReplyEnabled && aiReplyDraft) {
              const replySubject = envelope.subject ? (envelope.subject.toLowerCase().startsWith('re:') ? envelope.subject : `Re: ${envelope.subject}`) : `Re: Outreach Vishnu Vardhan Burri`;
              const htmlBody = aiReplyDraft.replace(/\n/g, '<br>');
              replySent = await sendSmtpEmail(fromAddress, replySubject, htmlBody);
            }

            await query('BEGIN');
            // Update lead status to replied and store reply content + AI draft
            await query(
              `UPDATE leads 
               SET status = 'replied', reply_subject = $1, reply_content = $2, ai_reply_draft = $3, ai_reply_sent = $4, next_followup_at = NULL, updated_at = NOW() 
               WHERE id = $5`,
              [envelope.subject || '(No Subject)', replyContent.slice(0, 10000), aiReplyDraft, replySent, lead.id]
            );
            await query('COMMIT');
            
            // Send Telegram alert
            const message = `<b>🔥 LEAD REPLIED!</b>\n\n` +
                            `Company: <b>${lead.company_name}</b>\n` +
                            `Email: <code>${fromAddress}</code>\n` +
                            `Subject: <i>${envelope.subject || '(No Subject)'}</i>\n\n` +
                            (replyContent ? `Reply:\n<code>${replyContent.slice(0, 400)}${replyContent.length > 400 ? '...' : ''}</code>\n\n` : '') +
                            (replySent 
                              ? `⚡ <b>Auto-reply sent successfully via SMTP!</b>` 
                              : aiReplyDraft ? `📝 <b>AI reply drafted & saved to HUD dashboard.</b>` : '') +
                            `\n\nOutreach sequence has been <b>stopped</b>.`;
            
            await sendTelegramNotification(message);
            repliedCount++;
          }
        }
      }
    } finally {
      lock.release();
    }
    
    await client.logout();
  } catch (error) {
    console.error('IMAP check failed:', error instanceof Error ? error.message : error);
  }

  console.log(`IMAP reply check finished. Found ${repliedCount} new replies.`);
  return repliedCount;
}
