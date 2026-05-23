import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

console.log('Loaded Telegram Bot Token:', TELEGRAM_BOT_TOKEN ? `${TELEGRAM_BOT_TOKEN.slice(0, 6)}...${TELEGRAM_BOT_TOKEN.slice(-4)}` : 'undefined');
console.log('Loaded Telegram Chat ID:', TELEGRAM_CHAT_ID ? `${TELEGRAM_CHAT_ID.slice(0, 3)}...${TELEGRAM_CHAT_ID.slice(-3)}` : 'undefined');

/**
 * Sends a notification message to the configured Telegram chat/channel
 */
export async function sendTelegramNotification(text: string): Promise<{ success: boolean; error?: string }> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return { success: false, error: 'Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID' };
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  
  try {
    await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text: text,
      parse_mode: 'HTML'
    }, {
      timeout: 8000
    });
    return { success: true };
  } catch (error: any) {
    const errMsg = error?.response?.data?.description || error.message || String(error);
    console.error('Error sending Telegram notification:', errMsg);
    return { success: false, error: errMsg };
  }
}
