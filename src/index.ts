import http from 'http';
import dotenv from 'dotenv';
import { query } from './db/client.js';
import { scrapeJobBoards } from './services/scraper.js';
import { researchAndPersonalizeLeads } from './services/personalizer.js';
import { validatePendingEmails } from './services/validator.js';
import { processOutboundEmails } from './services/sender.js';

dotenv.config();

const PORT = process.env.PORT || 3000;
let isProcessing = false;
let lastProcessedTime = 'Never';

/**
 * Runs the entire queue workflow sequentially:
 * Scrape -> Research -> Validate -> Send
 */
async function runOutreachCycle() {
  if (isProcessing) {
    console.log('Outreach cycle is already running. Skipping.');
    return;
  }

  isProcessing = true;
  console.log('--- STARTING OUTREACH CYCLE ---');
  
  try {
    // 1. Scrape new job openings
    await scrapeJobBoards();

    // 2. Scrape website text and personalize emails with Gemini
    await researchAndPersonalizeLeads();

    // 3. Perform MX lookup & SMTP handshake to validate emails
    await validatePendingEmails();

    // 4. Send a batch of validated emails (e.g., up to 10 per hour/run)
    await processOutboundEmails(10);
    
    lastProcessedTime = new Date().toLocaleString();
    console.log('--- OUTREACH CYCLE COMPLETED SUCCESSFULY ---');
  } catch (err) {
    console.error('Error during outreach cycle:', err);
  } finally {
    isProcessing = false;
  }
}

// Background scheduler
// Run cycle once on startup, then every 30 minutes
function startScheduler() {
  console.log('Starting background queue scheduler (intervals: 30 minutes)...');
  
  // Run immediately on boot
  setTimeout(() => {
    runOutreachCycle();
  }, 5000);

  // Repeat interval
  setInterval(() => {
    runOutreachCycle();
  }, 30 * 60 * 1000);
}

/**
 * Renders a dark, glassmorphic HUD dashboard showing DB queue stats
 */
async function handleStatusDashboard(res: http.ServerResponse) {
  try {
    const statsRes = await query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'discovered') as discovered,
        COUNT(*) FILTER (WHERE status = 'researched') as researched,
        COUNT(*) FILTER (WHERE status = 'validated') as validated,
        COUNT(*) FILTER (WHERE status = 'sent') as sent,
        COUNT(*) FILTER (WHERE status = 'failed' OR status = 'validation_failed' OR status = 'scraping_failed') as failed
      FROM leads
    `);
    
    const sentTodayRes = await query(
      `SELECT COUNT(*) as count FROM emails WHERE status = 'sent' AND sent_at >= NOW() - INTERVAL '1 day'`
    );

    const recentLogsRes = await query(
      `SELECT company_name, domain, status, updated_at FROM leads ORDER BY updated_at DESC LIMIT 5`
    );

    const stats = statsRes.rows[0];
    const sentToday = sentTodayRes.rows[0].count || 0;
    const dailyLimit = process.env.DAILY_EMAIL_LIMIT || 250;

    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>VVB Outreach Machine HUD</title>
        <style>
          body {
            background-color: #050505;
            color: #d1d5db;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            padding: 2rem;
            margin: 0;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
          }
          .container {
            width: 100%;
            max-width: 800px;
            background: rgba(18, 18, 18, 0.8);
            border: 1px solid rgba(255, 255, 255, 0.05);
            border-radius: 8px;
            padding: 2rem;
            box-shadow: 0 16px 40px rgba(0,0,0,0.5);
            backdrop-filter: blur(10px);
          }
          h1 {
            font-size: 1.2rem;
            color: #fff;
            margin-top: 0;
            margin-bottom: 1.5rem;
            text-transform: uppercase;
            letter-spacing: 0.15em;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            padding-bottom: 0.75rem;
          }
          .pulse {
            width: 8px;
            height: 8px;
            background-color: #10b981;
            border-radius: 50%;
            display: inline-block;
            box-shadow: 0 0 10px #10b981;
            animation: pulse-animation 2s infinite;
          }
          @keyframes pulse-animation {
            0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
            70% { transform: scale(1); box-shadow: 0 0 0 8px rgba(16, 185, 129, 0); }
            100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
          }
          .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
            gap: 1rem;
            margin-bottom: 2rem;
          }
          .card {
            background: rgba(255, 255, 255, 0.02);
            border: 1px solid rgba(255, 255, 255, 0.05);
            border-radius: 4px;
            padding: 1rem;
            text-align: center;
          }
          .card-value {
            font-size: 1.5rem;
            font-weight: bold;
            color: #fff;
            margin-bottom: 0.25rem;
          }
          .card-label {
            font-size: 0.7rem;
            text-transform: uppercase;
            color: #6b7280;
            letter-spacing: 0.1em;
          }
          .blue { color: #3b82f6; }
          .green { color: #10b981; }
          .purple { color: #a78bfa; }
          .red { color: #f43f5e; }
          .yellow { color: #f59e0b; }
          
          .logs {
            background: #000;
            border: 1px solid rgba(255, 255, 255, 0.05);
            padding: 1rem;
            border-radius: 4px;
            margin-bottom: 1.5rem;
            font-size: 0.8rem;
          }
          .log-item {
            margin-bottom: 0.5rem;
            display: flex;
            justify-content: space-between;
          }
          .log-item:last-child { margin-bottom: 0; }
          .btn-container {
            display: flex;
            justify-content: space-between;
            align-items: center;
          }
          .btn {
            background: #fff;
            color: #000;
            border: none;
            padding: 0.6rem 1.2rem;
            font-family: inherit;
            font-weight: bold;
            text-transform: uppercase;
            font-size: 0.75rem;
            cursor: pointer;
            border-radius: 2px;
            transition: all 0.2s;
            letter-spacing: 0.05em;
          }
          .btn:hover {
            background: #d1d5db;
          }
          .btn:disabled {
            background: #374151;
            color: #9ca3af;
            cursor: not-allowed;
          }
          .footer {
            font-size: 0.75rem;
            color: #4b5563;
            margin-top: 1.5rem;
            text-align: center;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>
            <span>VVB Outreach Machine HUD</span>
            <span class="pulse" title="System running"></span>
          </h1>
          
          <div class="grid">
            <div class="card">
              <div class="card-value blue">${stats.discovered}</div>
              <div class="card-label">Discovered</div>
            </div>
            <div class="card">
              <div class="card-value purple">${stats.researched}</div>
              <div class="card-label">Researched</div>
            </div>
            <div class="card">
              <div class="card-value green">${stats.validated}</div>
              <div class="card-label">Validated</div>
            </div>
            <div class="card">
              <div class="card-value yellow">${sentToday} / ${dailyLimit}</div>
              <div class="card-label">Sent Today</div>
            </div>
            <div class="card">
              <div class="card-value red">${stats.failed}</div>
              <div class="card-label">Fails / Bounces</div>
            </div>
          </div>
          
          <h3>Recent Queue Logs</h3>
          <div class="logs">
            ${
              recentLogsRes.rows.length === 0 
                ? '<div style="color: #6b7280; text-align: center;">No leads discovered yet.</div>'
                : recentLogsRes.rows.map(row => `
                    <div class="log-item">
                      <span>[${new Date(row.updated_at).toLocaleTimeString()}] ${row.company_name} (${row.domain})</span>
                      <span class="${row.status === 'sent' ? 'green' : row.status.includes('fail') ? 'red' : 'blue'}">${row.status.toUpperCase()}</span>
                    </div>
                  `).join('')
            }
          </div>
          
          <div class="btn-container">
            <span style="font-size: 0.75rem; color: #6b7280;">Last Cycle run: ${lastProcessedTime}</span>
            <form method="POST" action="/trigger">
              <button type="submit" class="btn" ${isProcessing ? 'disabled' : ''}>
                ${isProcessing ? 'Processing...' : 'Trigger Cycle Now'}
              </button>
            </form>
          </div>
          
          <div class="footer">
            Build v1.0.0 // Powered by Brevo, Gemini & Supabase Postgres
          </div>
        </div>
      </body>
      </html>
    `;
    
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`Internal Server Error: ${err instanceof Error ? err.message : err}`);
  }
}

// Start HTTP web server
function startHttpServer() {
  const server = http.createServer(async (req, res) => {
    const url = req.url || '/';
    
    if (url === '/' && req.method === 'GET') {
      await handleStatusDashboard(res);
    } else if (url === '/trigger' && req.method === 'POST') {
      // Direct cycle trigger via POST request
      if (!isProcessing) {
        // Trigger cycle in background
        runOutreachCycle();
      }
      // Redirect back to main dashboard
      res.writeHead(302, { 'Location': '/' });
      res.end();
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });

  server.listen(PORT, () => {
    console.log(`Outreach HUD running on port http://localhost:${PORT}`);
  });
}

// System entry point
function main() {
  console.log('Outreach Machine Engine starting...');
  startHttpServer();
  startScheduler();
}

main();
