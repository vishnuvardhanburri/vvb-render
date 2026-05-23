import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

const IMAP_USER = process.env.IMAP_USER;
const IMAP_PASSWORD = process.env.IMAP_PASSWORD;
const IMAP_HOST = process.env.IMAP_HOST; // E.g. imap.hostinger.com -> we can guess SMTP host is smtp.hostinger.com
const SENDER_EMAIL = process.env.SENDER_EMAIL || IMAP_USER || '';
const SENDER_NAME = process.env.SENDER_NAME || 'Vishnu Vardhan Burri';

/**
 * Resolves SMTP host from IMAP host (e.g. imap.hostinger.com -> smtp.hostinger.com)
 */
function getSmtpHost(): string {
  if (IMAP_HOST) {
    if (IMAP_HOST.includes('hostinger')) return 'smtp.hostinger.com';
    return IMAP_HOST.replace('imap.', 'smtp.').replace('mail.', 'smtp.');
  }
  return 'smtp.hostinger.com'; // Fallback
}

/**
 * Sends a direct email using SMTP (via Hostinger)
 */
export async function sendSmtpEmail(toEmail: string, subject: string, htmlBody: string): Promise<boolean> {
  if (!IMAP_USER || !IMAP_PASSWORD) {
    console.error('SMTP Error: IMAP_USER or IMAP_PASSWORD is not configured.');
    return false;
  }

  const smtpHost = getSmtpHost();
  console.log(`Connecting to SMTP server ${smtpHost} via port 465...`);

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: 465,
    secure: true, // true for port 465
    auth: {
      user: IMAP_USER,
      pass: IMAP_PASSWORD,
    },
    timeout: 10000
  } as any);

  const mailOptions = {
    from: `"${SENDER_NAME}" <${SENDER_EMAIL}>`,
    to: toEmail,
    subject: subject,
    html: htmlBody,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`✔ SMTP Email sent to ${toEmail}: ${info.messageId}`);
    return true;
  } catch (error) {
    console.error(`SMTP Send Error to ${toEmail}:`, error instanceof Error ? error.message : error);
    return false;
  }
}
