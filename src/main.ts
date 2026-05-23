import http from 'http';
import dotenv from 'dotenv';
import { query } from './db/client.js';
import { scrapeJobBoards } from './services/scraper.js';
import { researchAndPersonalizeLeads } from './services/personalizer.js';
import { validatePendingEmails, validateEmail } from './services/validator.js';
import { processOutboundEmails } from './services/sender.js';
import { checkInboxReplies } from './services/imap.js';
import { sendTelegramNotification } from './services/telegram.js';

dotenv.config();

const PORT = process.env.PORT || 3000;
let isProcessing = false;
let lastProcessedTime = 'Never';

/**
 * Runs the entire queue workflow sequentially:
 * Scrape -> Research -> Check Replies -> Send
 */
async function runOutreachCycle() {
  if (isProcessing) {
    console.log('Outreach cycle is already running. Skipping.');
    return;
  }

  isProcessing = true;
  console.log('--- STARTING OUTREACH CYCLE ---');
  
  try {
    // 1. Scrape new job openings from boards
    await scrapeJobBoards();

    // 2. Scrape website text and personalize emails with Gemini
    await researchAndPersonalizeLeads();

    // 3. Scan IMAP for client replies
    await checkInboxReplies();

    // 4. Send a batch of validated & approved emails (up to 10 per hour)
    await processOutboundEmails(10);
    
    lastProcessedTime = new Date().toLocaleString();
    console.log('--- OUTREACH CYCLE COMPLETED SUCCESSFULY ---');
  } catch (err) {
    console.error('Error during outreach cycle:', err);
  } finally {
    isProcessing = false;
  }
}

// Background scheduler - Runs every 30 minutes
function startScheduler() {
  console.log('Starting background queue scheduler (intervals: 30 minutes)...');
  
  // Run once shortly after startup
  setTimeout(() => {
    runOutreachCycle();
  }, 10000);

  // Interval execution
  setInterval(() => {
    runOutreachCycle();
  }, 30 * 60 * 1000);
}

/**
 * Parses POST form body
 */
function parseFormBody(req: http.IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    let chunks: any[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const data = Buffer.concat(chunks).toString();
      resolve(new URLSearchParams(data));
    });
    req.on('error', (err) => reject(err));
  });
}

/**
 * Renders the HTML Dashboard UI
 */
async function renderDashboard(res: http.ServerResponse, notification?: { type: 'success' | 'error'; message: string }) {
  try {
    // Fetch stats
    const statsRes = await query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'discovered') as discovered,
        COUNT(*) FILTER (WHERE status = 'researched') as researched,
        COUNT(*) FILTER (WHERE status = 'validated') as validated,
        COUNT(*) FILTER (WHERE status = 'sent') as sent,
        COUNT(*) FILTER (WHERE status = 'replied') as replied,
        COUNT(*) FILTER (WHERE status = 'failed' OR status = 'validation_failed' OR status = 'scraping_failed') as failed
      FROM leads
    `);
    
    const sentTodayRes = await query(
      `SELECT COUNT(*) as count FROM emails WHERE status = 'sent' AND sent_at >= NOW() - INTERVAL '1 day'`
    );

    // Fetch active drafts (researched, not approved)
    const draftsRes = await query(`
      SELECT e.id as email_id, e.subject, e.body, e.sequence_step, l.id as lead_id, l.company_name, l.domain, l.contact_email, l.job_title
      FROM emails e
      JOIN leads l ON e.lead_id = l.id
      WHERE e.status = 'pending' AND l.status = 'researched' AND l.is_approved = FALSE
      ORDER BY e.id ASC
    `);

    // Fetch active campaigns (leads sent, waiting replies, or completed) with their email content
    const leadsRes = await query(`
      SELECT l.id, l.company_name, l.domain, l.contact_email, l.job_title, l.status, l.sequence_step, l.next_followup_at,
             (SELECT subject FROM emails WHERE lead_id = l.id AND sequence_step = l.sequence_step ORDER BY id DESC LIMIT 1) as email_subject,
             (SELECT body FROM emails WHERE lead_id = l.id AND sequence_step = l.sequence_step ORDER BY id DESC LIMIT 1) as email_body
      FROM leads l
      WHERE l.status IN ('sent', 'replied', 'outreach_completed', 'validation_failed')
      ORDER BY l.updated_at DESC LIMIT 30
    `);

    const stats = statsRes.rows[0];
    const sentToday = sentTodayRes.rows[0].count || 0;
    const dailyLimit = process.env.DAILY_EMAIL_LIMIT || 250;

    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Outreach Machine HUD</title>
        <style>
          :root {
            --bg: #030303;
            --surface: #0a0a0c;
            --surface-hover: #121216;
            --border: rgba(255, 255, 255, 0.04);
            --border-glow: rgba(59, 130, 246, 0.2);
            --text: #d1d5db;
            --text-white: #ffffff;
            --primary: #3b82f6;
            --success: #10b981;
            --warning: #f59e0b;
            --danger: #ef4444;
          }
          
          body {
            background-color: var(--bg);
            color: var(--text);
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
            margin: 0;
            padding: 2rem;
            min-height: 100vh;
            box-sizing: border-box;
          }

          .container {
            max-width: 1100px;
            margin: 0 auto;
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 2rem;
            box-shadow: 0 20px 50px rgba(0,0,0,0.8);
            backdrop-filter: blur(8px);
          }

          header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid var(--border);
            padding-bottom: 1.5rem;
            margin-bottom: 2rem;
          }

          h1 {
            font-size: 1.25rem;
            color: var(--text-white);
            margin: 0;
            text-transform: uppercase;
            letter-spacing: 0.15em;
            display: flex;
            align-items: center;
            gap: 0.75rem;
          }

          .status-pulse {
            width: 8px;
            height: 8px;
            background-color: var(--success);
            border-radius: 50%;
            display: inline-block;
            box-shadow: 0 0 10px var(--success);
            animation: pulse-animation 2s infinite;
          }

          @keyframes pulse-animation {
            0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
            70% { transform: scale(1); box-shadow: 0 0 0 6px rgba(16, 185, 129, 0); }
            100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
          }

          /* Alert notification */
          .alert {
            padding: 1rem;
            border-radius: 6px;
            margin-bottom: 1.5rem;
            font-size: 0.85rem;
            display: flex;
            align-items: center;
            gap: 0.5rem;
          }
          .alert-success {
            background: rgba(16, 185, 129, 0.1);
            border: 1px solid rgba(16, 185, 129, 0.2);
            color: var(--success);
          }
          .alert-error {
            background: rgba(239, 68, 68, 0.1);
            border: 1px solid rgba(239, 68, 68, 0.2);
            color: var(--danger);
          }

          /* Navigation Tabs */
          .tabs {
            display: flex;
            gap: 0.5rem;
            border-bottom: 1px solid var(--border);
            margin-bottom: 2rem;
            padding-bottom: 0.5rem;
          }
          .tab-btn {
            background: transparent;
            border: 1px solid transparent;
            color: #6b7280;
            padding: 0.6rem 1.2rem;
            font-family: inherit;
            font-size: 0.8rem;
            text-transform: uppercase;
            cursor: pointer;
            border-radius: 4px;
            transition: all 0.2s;
          }
          .tab-btn.active {
            border-color: var(--border);
            background: rgba(255,255,255,0.02);
            color: var(--text-white);
          }
          .tab-btn:hover {
            color: var(--text-white);
          }

          /* Stats Grid */
          .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
            gap: 1rem;
            margin-bottom: 2rem;
          }
          .stat-card {
            background: rgba(255, 255, 255, 0.01);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 1.2rem;
            text-align: center;
          }
          .stat-value {
            font-size: 1.75rem;
            font-weight: bold;
            color: var(--text-white);
            margin-bottom: 0.25rem;
          }
          .stat-label {
            font-size: 0.7rem;
            text-transform: uppercase;
            color: #6b7280;
            letter-spacing: 0.1em;
          }

          .section { display: none; }
          .section.active { display: block; }

          /* Table Styling */
          table {
            width: 100%;
            border-collapse: collapse;
            font-size: 0.8rem;
          }
          th {
            text-align: left;
            padding: 0.75rem 1rem;
            border-bottom: 1px solid var(--border);
            color: #6b7280;
            text-transform: uppercase;
            font-size: 0.7rem;
          }
          td {
            padding: 1rem;
            border-bottom: 1px solid var(--border);
          }
          tr:hover td {
            background: rgba(255,255,255,0.01);
          }

          /* Badges */
          .badge {
            padding: 0.25rem 0.5rem;
            border-radius: 4px;
            font-size: 0.7rem;
            text-transform: uppercase;
            font-weight: bold;
            display: inline-block;
          }
          .badge-blue { background: rgba(59, 130, 246, 0.15); color: var(--primary); }
          .badge-green { background: rgba(16, 185, 129, 0.15); color: var(--success); }
          .badge-yellow { background: rgba(245, 158, 11, 0.15); color: var(--warning); }
          .badge-red { background: rgba(239, 68, 68, 0.15); color: var(--danger); }

          /* Draft queue card details */
          .draft-card {
            background: rgba(255, 255, 255, 0.01);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 1.5rem;
            margin-bottom: 1.5rem;
          }
          .draft-meta {
            display: flex;
            justify-content: space-between;
            margin-bottom: 1rem;
            border-bottom: 1px solid var(--border);
            padding-bottom: 0.5rem;
            font-size: 0.75rem;
          }
          .input-field {
            width: 100%;
            background: #000;
            border: 1px solid var(--border);
            color: var(--text-white);
            font-family: inherit;
            padding: 0.75rem;
            border-radius: 4px;
            margin-bottom: 1rem;
            box-sizing: border-box;
            font-size: 0.8rem;
          }
          textarea.input-field {
            min-height: 200px;
            resize: vertical;
            line-height: 1.5;
          }
          .btn-group {
            display: flex;
            gap: 0.75rem;
          }
          .btn {
            background: var(--text-white);
            color: #000;
            border: none;
            padding: 0.6rem 1.2rem;
            font-family: inherit;
            font-weight: bold;
            text-transform: uppercase;
            font-size: 0.75rem;
            cursor: pointer;
            border-radius: 4px;
            transition: all 0.2s;
          }
          .btn:hover { background: #d1d5db; }
          .btn-primary { background: var(--primary); color: #fff; }
          .btn-primary:hover { background: #2563eb; }
          .btn-danger { background: rgba(239, 68, 68, 0.1); border: 1px solid var(--danger); color: var(--danger); }
          .btn-danger:hover { background: var(--danger); color: #fff; }
          .btn-secondary { background: transparent; border: 1px solid var(--border); color: var(--text); }
          .btn-secondary:hover { background: rgba(255,255,255,0.05); }

          .footer {
            font-size: 0.7rem;
            color: #4b5563;
            text-align: center;
            margin-top: 3rem;
            border-top: 1px solid var(--border);
            padding-top: 1rem;
            letter-spacing: 0.1em;
            text-transform: uppercase;
          }
        </style>
        <script>
          function switchTab(tabId) {
            document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
            document.querySelectorAll('.section').forEach(sec => sec.classList.remove('active'));
            
            document.getElementById(tabId + '-btn').classList.add('active');
            document.getElementById(tabId + '-sec').classList.add('active');
            localStorage.setItem('activeTab', tabId);
          }

          window.onload = () => {
            const activeTab = localStorage.getItem('activeTab') || 'drafts';
            switchTab(activeTab);
          }

          function showEmailModal(id) {
            const subject = document.getElementById('email-subj-' + id).innerText;
            const body = document.getElementById('email-body-' + id).innerText;
            document.getElementById('modal-subject').innerText = subject;
            document.getElementById('modal-body').innerText = body;
            document.getElementById('email-modal').style.display = 'flex';
          }

          function hideEmailModal() {
            document.getElementById('email-modal').style.display = 'none';
          }
        </script>
      </head>
      <body>
        <div class="container">
          <header>
            <h1>
              <span>Outreach Machine HUD</span>
              <span class="status-pulse" title="Systems Active"></span>
            </h1>
            <div style="display: flex; gap: 0.75rem; align-items: center;">
              <span style="font-size: 0.75rem; color: #6b7280;">Last Cycle: ${lastProcessedTime}</span>
              <form method="POST" action="/test-telegram" style="margin: 0;">
                <button type="submit" class="btn btn-secondary">Test Telegram</button>
              </form>
              <form method="POST" action="/trigger" style="margin: 0;">
                <button type="submit" class="btn btn-secondary" ${isProcessing ? 'disabled' : ''}>
                  ${isProcessing ? 'Running...' : 'Trigger Cycle'}
                </button>
              </form>
            </div>
          </header>

          ${notification ? `
            <div class="alert alert-${notification.type}">
              <span>${notification.type === 'success' ? '✔' : '❌'}</span>
              <span>${notification.message}</span>
            </div>
          ` : ''}

          <div class="stats-grid">
            <div class="stat-card">
              <div class="stat-value blue">${stats.discovered}</div>
              <div class="stat-label">Discovered</div>
            </div>
            <div class="stat-card">
              <div class="stat-value purple">${stats.researched}</div>
              <div class="stat-label">Draft Queue</div>
            </div>
            <div class="stat-card">
              <div class="stat-value green">${stats.validated}</div>
              <div class="stat-label">Ready to Send</div>
            </div>
            <div class="stat-card">
              <div class="stat-value yellow">${sentToday} / ${dailyLimit}</div>
              <div class="stat-label">Sent Today</div>
            </div>
            <div class="stat-card">
              <div class="stat-value green" style="color:var(--success);">${stats.replied}</div>
              <div class="stat-label">Replies</div>
            </div>
            <div class="stat-card">
              <div class="stat-value red">${stats.failed}</div>
              <div class="stat-label">Bounces/Fails</div>
            </div>
          </div>

          <div class="tabs" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); margin-bottom: 2rem; padding-bottom: 0.5rem;">
            <div style="display: flex; gap: 0.5rem;">
              <button id="drafts-btn" class="tab-btn active" onclick="switchTab('drafts')">Drafts Queue (${draftsRes.rows.length})</button>
              <button id="campaigns-btn" class="tab-btn" onclick="switchTab('campaigns')">Campaign Tracker (${leadsRes.rows.length})</button>
            </div>
            ${stats.failed > 0 ? `
              <form method="POST" action="/leads/reset-failed" style="margin: 0;">
                <button type="submit" class="btn btn-danger" style="font-size:0.7rem; padding:0.4rem 0.8rem;">Reset Failed Leads</button>
              </form>
            ` : ''}
          </div>

          <!-- DRAFTS QUEUE SECTION -->
          <div id="drafts-sec" class="section active">
            ${
              draftsRes.rows.length === 0 
                ? '<div style="text-align: center; padding: 3rem; color: #6b7280;">No drafts awaiting review. Check back later or trigger a crawl cycle.</div>'
                : draftsRes.rows.map((draft, idx) => `
                    <div class="draft-card">
                      <div class="draft-meta">
                        <div>
                          Company: <b style="color:var(--text-white);">${draft.company_name}</b> (${draft.domain}) | 
                          Job: <i style="color:#9ca3af;">${draft.job_title}</i>
                        </div>
                        <div>
                          Sequence Step: <b class="badge badge-blue">Step ${draft.sequence_step}/3</b>
                        </div>
                      </div>
                      
                      <form method="POST" action="/drafts/approve">
                        <input type="hidden" name="emailId" value="${draft.email_id}" />
                        <input type="hidden" name="leadId" value="${draft.lead_id}" />
                        
                        <label style="font-size:0.75rem; color:#6b7280; display:block; margin-bottom:0.25rem;">Recipient Email Address</label>
                        <input type="text" name="recipient" class="input-field" value="${draft.contact_email || ''}" required />

                        <label style="font-size:0.75rem; color:#6b7280; display:block; margin-bottom:0.25rem;">Email Subject Line</label>
                        <input type="text" name="subject" class="input-field" value="${draft.subject}" required />

                        <label style="font-size:0.75rem; color:#6b7280; display:block; margin-bottom:0.25rem;">Email Body Copy</label>
                        <textarea name="body" class="input-field" required>${draft.body}</textarea>
                        
                        <div class="btn-group">
                          <button type="submit" class="btn btn-primary">Approve & Queue Send</button>
                          <button type="submit" formAction="/drafts/save" class="btn btn-secondary">Save Changes</button>
                          <button type="submit" formAction="/drafts/delete" class="btn btn-danger">Skip / Delete Lead</button>
                        </div>
                      </form>
                    </div>
                  `).join('')
            }
          </div>

          <!-- CAMPAIGNS TRACKER SECTION -->
          <div id="campaigns-sec" class="section">
            ${
              leadsRes.rows.length === 0
                ? '<div style="text-align: center; padding: 3rem; color: #6b7280;">No active outreach campaigns tracked. Approve drafts to get started.</div>'
                : `
                  <div style="overflow-x: auto;">
                    <table>
                      <thead>
                        <tr>
                          <th>Company</th>
                          <th>Recipient</th>
                          <th>Status</th>
                          <th>Current Step</th>
                          <th>Next Event</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${leadsRes.rows.map(lead => `
                          <tr>
                            <td>
                              <b style="color:var(--text-white);">${lead.company_name}</b><br/>
                              <span style="color:#6b7280; font-size:0.7rem;">${lead.domain}</span>
                            </td>
                            <td>${lead.contact_email}</td>
                            <td>
                              <span class="badge ${
                                lead.status === 'replied' ? 'badge-green' :
                                lead.status === 'outreach_completed' ? 'badge-blue' :
                                lead.status === 'sent' ? 'badge-yellow' : 'badge-red'
                              }">${lead.status}</span>
                            </td>
                            <td>Step ${lead.sequence_step}/3</td>
                            <td>
                              ${
                                lead.status === 'replied' ? 'Sequence Halted' :
                                lead.status === 'outreach_completed' ? 'Complete' :
                                lead.next_followup_at ? new Date(lead.next_followup_at).toLocaleDateString() : 'N/A'
                              }
                            </td>
                            <td>
                              <div style="display: flex; gap: 0.5rem; align-items: center;">
                                ${lead.email_subject ? `
                                  <div id="email-subj-${lead.id}" style="display:none;">${lead.email_subject}</div>
                                  <div id="email-body-${lead.id}" style="display:none;">${lead.email_body}</div>
                                  <button class="btn btn-secondary" style="padding: 0.3rem 0.6rem; font-size:0.65rem;" onclick="showEmailModal(${lead.id})">View Email</button>
                                ` : ''}
                                ${lead.status !== 'replied' && lead.status !== 'outreach_completed' && lead.status !== 'validation_failed' ? `
                                  <form method="POST" action="/leads/replied" style="margin:0; display:inline;">
                                    <input type="hidden" name="leadId" value="${lead.id}" />
                                    <button type="submit" class="btn btn-secondary" style="padding: 0.3rem 0.6rem; font-size:0.65rem;">Mark Replied</button>
                                  </form>
                                ` : ''}
                                ${!lead.email_subject && (lead.status === 'replied' || lead.status === 'outreach_completed') ? '—' : ''}
                              </div>
                            </td>
                          </tr>
                        `).join('')}
                      </tbody>
                    </table>
                  </div>
                `
            }
          </div>

          <!-- Email Preview Modal -->
          <div id="email-modal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.85); z-index:1000; justify-content:center; align-items:center; backdrop-filter:blur(4px);">
            <div style="background:var(--surface); border:1px solid var(--border); padding:2rem; border-radius:12px; width:90%; max-width:600px; box-shadow:0 20px 50px rgba(0,0,0,0.9); font-family:inherit;">
              <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--border); padding-bottom:1rem; margin-bottom:1rem;">
                <h3 style="margin:0; color:var(--text-white); font-size:1rem; text-transform:uppercase; letter-spacing:0.1em;">Outreach Email Content</h3>
                <button onclick="hideEmailModal()" style="background:transparent; border:none; color:#6b7280; font-size:1.5rem; cursor:pointer; font-weight:bold; padding:0;">&times;</button>
              </div>
              <div style="font-size:0.8rem; margin-bottom:1rem;">
                <b style="color:var(--text-white);">Subject:</b> <span id="modal-subject" style="color:var(--primary);"></span>
              </div>
              <div style="font-size:0.8rem; background:#000; border:1px solid var(--border); padding:1rem; border-radius:6px; min-height:150px; max-height:300px; overflow-y:auto; line-height:1.6; white-space:pre-wrap; color:var(--text);" id="modal-body"></div>
              <div style="margin-top:1.5rem; text-align:right;">
                <button class="btn btn-secondary" onclick="hideEmailModal()">Close</button>
              </div>
            </div>
          </div>

          <div class="footer">
            Build v2.0.0 // Powered by MailBluster, Gemini & Supabase Postgres
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
      await renderDashboard(res);
    } else if (url === '/trigger' && req.method === 'POST') {
      if (!isProcessing) {
        runOutreachCycle();
      }
      await renderDashboard(res, { type: 'success', message: 'Outreach cycle triggered in background.' });
    } else if (url === '/test-telegram' && req.method === 'POST') {
      const result = await sendTelegramNotification(
        `🔔 <b>Outreach Machine Connection Test</b>\n` +
        `If you are reading this, your Telegram Bot notifications are configured correctly! 🎉`
      );
      if (result.success) {
        await renderDashboard(res, { type: 'success', message: 'Test Telegram message sent successfully!' });
      } else {
        await renderDashboard(res, { type: 'error', message: `Failed to send Telegram message. Error: ${result.error || 'Unknown error'}` });
      }
    } else if (url === '/leads/reset-failed' && req.method === 'POST') {
      await query(
        `UPDATE leads SET status = 'discovered', updated_at = NOW() WHERE status IN ('scraping_failed', 'failed', 'validation_failed')`
      );
      await renderDashboard(res, { type: 'success', message: 'All failed/bounced leads reset to Discovered status successfully.' });
    } else if (url === '/leads/replied' && req.method === 'POST') {
      const params = await parseFormBody(req);
      const leadId = params.get('leadId');
      if (leadId) {
        await query(
          `UPDATE leads SET status = 'replied', next_followup_at = NULL, updated_at = NOW() WHERE id = $1`,
          [leadId]
        );
        
        // Notify Telegram
        const leadRes = await query(`SELECT company_name, contact_email FROM leads WHERE id = $1`, [leadId]);
        if (leadRes.rows.length > 0) {
          const lead = leadRes.rows[0];
          await sendTelegramNotification(
            `👉 <b>Lead marked as Replied manually</b>\n` +
            `Company: <b>${lead.company_name}</b>\n` +
            `Email: <code>${lead.contact_email}</code>\n\n` +
            `Outreach sequence stopped.`
          );
        }
        
        await renderDashboard(res, { type: 'success', message: 'Lead marked as replied. Sequences stopped.' });
      } else {
        await renderDashboard(res, { type: 'error', message: 'Invalid lead ID.' });
      }
    } else if (url === '/drafts/save' && req.method === 'POST') {
      const params = await parseFormBody(req);
      const emailId = params.get('emailId');
      const leadId = params.get('leadId');
      const recipient = params.get('recipient');
      const subject = params.get('subject');
      const body = params.get('body');

      if (emailId && leadId && recipient && subject && body) {
        await query('BEGIN');
        await query(
          `UPDATE emails SET subject = $1, body = $2, recipient_email = $3 WHERE id = $4`,
          [subject, body, recipient, emailId]
        );
        await query(
          `UPDATE leads SET contact_email = $1 WHERE id = $2`,
          [recipient, leadId]
        );
        await query('COMMIT');
        await renderDashboard(res, { type: 'success', message: 'Draft saved successfully.' });
      } else {
        await renderDashboard(res, { type: 'error', message: 'Missing fields.' });
      }
    } else if (url === '/drafts/approve' && req.method === 'POST') {
      const params = await parseFormBody(req);
      const emailId = params.get('emailId');
      const leadId = params.get('leadId');
      const recipient = params.get('recipient');
      const subject = params.get('subject');
      const body = params.get('body');

      if (emailId && leadId && recipient && subject && body) {
        console.log(`Approving and validating draft for ${recipient}...`);
        
        // 1. Save updates first
        await query('BEGIN');
        await query(
          `UPDATE emails SET subject = $1, body = $2, recipient_email = $3 WHERE id = $4`,
          [subject, body, recipient, emailId]
        );
        await query(
          `UPDATE leads SET contact_email = $1 WHERE id = $2`,
          [recipient, leadId]
        );
        await query('COMMIT');

        // 2. Validate email address
        const check = await validateEmail(recipient);

        if (check.isValid) {
          await query('BEGIN');
          // Approve lead and make validated
          await query(
            `UPDATE leads SET status = 'validated', is_approved = TRUE, updated_at = NOW() WHERE id = $1`,
            [leadId]
          );
          // Set email status to pending (ready to send)
          await query(
            `UPDATE emails SET status = 'pending' WHERE id = $1`,
            [emailId]
          );
          await query('COMMIT');
          
          await renderDashboard(res, { type: 'success', message: `Draft approved & queued for sending: ${recipient}` });
        } else {
          await query('BEGIN');
          // Mark validation failed
          await query(
            `UPDATE leads SET status = 'validation_failed', updated_at = NOW() WHERE id = $1`,
            [leadId]
          );
          await query(
            `UPDATE emails SET status = 'failed', error_message = $1 WHERE id = $2`,
            [check.reason, emailId]
          );
          await query('COMMIT');
          
          await renderDashboard(res, { type: 'error', message: `Email validation failed for ${recipient}: ${check.reason}` });
        }
      } else {
        await renderDashboard(res, { type: 'error', message: 'Missing fields.' });
      }
    } else if (url === '/drafts/delete' && req.method === 'POST') {
      const params = await parseFormBody(req);
      const leadId = params.get('leadId');
      if (leadId) {
        await query(`DELETE FROM leads WHERE id = $1`, [leadId]);
        await renderDashboard(res, { type: 'success', message: 'Lead deleted from outreach database.' });
      } else {
        await renderDashboard(res, { type: 'error', message: 'Missing lead ID.' });
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });

  server.listen(PORT, () => {
    console.log(`Outreach HUD running on http://localhost:${PORT}`);
  });
}

// System entry point
function main() {
  console.log('Outreach Machine Engine starting...');
  startHttpServer();
  startScheduler();
}

main();
