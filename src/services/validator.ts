import dns from 'dns';
import net from 'net';
import { query } from '../db/client.js';

/**
 * Validates email syntax using standard regex
 */
export function validateEmailSyntax(email: string): boolean {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(email);
}

/**
 * Resolves MX records for an email domain
 */
export async function getMxRecords(domain: string): Promise<dns.MxRecord[]> {
  return new Promise((resolve, reject) => {
    dns.resolveMx(domain, (err, addresses) => {
      if (err) {
        reject(err);
      } else {
        // Sort by priority (lowest number = highest priority)
        resolve(addresses.sort((a, b) => a.priority - b.priority));
      }
    });
  });
}

/**
 * Performs a mock SMTP handshake check to determine if the email address exists
 */
export async function checkSmtpInbox(email: string, mxHost: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(25, mxHost);
    socket.setTimeout(8000); // 8 second timeout
    
    let step = 0;
    let resolved = false;

    const senderEmail = process.env.SENDER_EMAIL || 'contact@vishnuvardhanburri.in';
    const domain = senderEmail.split('@')[1] || 'vishnuvardhanburri.in';

    const end = (result: boolean) => {
      if (resolved) return;
      resolved = true;
      try {
        socket.write('QUIT\r\n');
        socket.end();
      } catch {
        // Ignore write errors during teardown
      }
      resolve(result);
    };

    socket.on('connect', () => {
      // Step 0: Connected, waiting for server greeting (code 220)
    });

    socket.on('data', (data) => {
      const response = data.toString();
      const code = parseInt(response.slice(0, 3));
      
      if (step === 0) {
        if (code === 220) {
          socket.write(`EHLO ${domain}\r\n`);
          step = 1;
        } else {
          end(false);
        }
      } else if (step === 1) {
        if (code === 250) {
          socket.write(`MAIL FROM:<${senderEmail}>\r\n`);
          step = 2;
        } else {
          end(false);
        }
      } else if (step === 2) {
        if (code === 250) {
          socket.write(`RCPT TO:<${email}>\r\n`);
          step = 3;
        } else {
          end(false);
        }
      } else if (step === 3) {
        // 250: Recipient OK
        // 251: User not local; will forward
        if (code === 250 || code === 251) {
          end(true);
        } else if (code === 550 || code === 551 || code === 553) {
          // 550: Mailbox unavailable / User unknown
          end(false);
        } else {
          // Greylisting / temporary issues (450, 451, etc.) -> assume valid to avoid false exclusions
          end(true);
        }
      }
    });

    socket.on('error', (err) => {
      // Socket error (e.g. port 25 blocked by provider / network)
      // We log and return true as fallback if MX query was successful, to prevent false negatives
      console.warn(`SMTP check connection error on ${mxHost} for ${email}:`, err.message);
      resolve(true); // Fallback to true
    });

    socket.on('timeout', () => {
      console.warn(`SMTP check timeout on ${mxHost} for ${email}`);
      resolve(true); // Fallback to true
    });
  });
}

/**
 * Validates a single email fully: syntax, MX records, and SMTP handshake
 */
export async function validateEmail(email: string): Promise<{ isValid: boolean; reason: string }> {
  if (!validateEmailSyntax(email)) {
    return { isValid: false, reason: 'Invalid syntax' };
  }

  const domain = email.split('@')[1];
  let mxRecords: dns.MxRecord[] = [];
  
  try {
    mxRecords = await getMxRecords(domain);
    if (mxRecords.length === 0) {
      return { isValid: false, reason: 'No MX records found' };
    }
  } catch (err) {
    return { isValid: false, reason: `MX record resolution failed: ${err instanceof Error ? err.message : err}` };
  }

  // Attempt SMTP check using primary MX record
  const primaryMx = mxRecords[0].exchange;
  const isInboxActive = await checkSmtpInbox(email, primaryMx);
  
  if (!isInboxActive) {
    return { isValid: false, reason: 'SMTP server rejected recipient (mailbox does not exist)' };
  }

  return { isValid: true, reason: 'Passed all verification checks' };
}

/**
 * Verifies all queued emails in the database and updates status accordingly
 */
export async function validatePendingEmails() {
  console.log('Running email validation pipeline...');
  const res = await query(
    `SELECT e.id, e.recipient_email, e.lead_id 
     FROM emails e 
     JOIN leads l ON e.lead_id = l.id 
     WHERE e.status = 'pending' AND l.status = 'researched'
     ORDER BY e.id ASC LIMIT 50`
  );

  console.log(`Found ${res.rows.length} pending emails to validate.`);
  let validatedCount = 0;

  for (const row of res.rows) {
    const { id, recipient_email, lead_id } = row;
    try {
      console.log(`Validating email ${id}: ${recipient_email}`);
      const check = await validateEmail(recipient_email);

      if (check.isValid) {
        await query('BEGIN');
        // Update email status
        await query(`UPDATE emails SET status = 'pending' WHERE id = $1`, [id]);
        // Update lead status to validated
        await query(`UPDATE leads SET status = 'validated' WHERE id = $1`, [lead_id]);
        await query('COMMIT');
        
        console.log(`✔ Email ${recipient_email} validated successfully.`);
        validatedCount++;
      } else {
        await query('BEGIN');
        // Fail email
        await query(
          `UPDATE emails SET status = 'failed', error_message = $1 WHERE id = $2`,
          [check.reason, id]
        );
        // Fail lead
        await query(
          `UPDATE leads SET status = 'validation_failed', updated_at = NOW() WHERE id = $1`,
          [lead_id]
        );
        await query('COMMIT');
        
        console.warn(`❌ Email validation failed for ${recipient_email}: ${check.reason}`);
      }
    } catch (err) {
      await query('ROLLBACK');
      console.error(`Error during email validation of ${recipient_email}:`, err);
    }
  }

  console.log(`Validation pipeline complete. Approved ${validatedCount} emails.`);
  return validatedCount;
}
