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
    // Fetch settings
    const settingsRes = await query(`SELECT key, value FROM system_settings`);
    const settings: Record<string, string> = {};
    settingsRes.rows.forEach(r => {
      settings[r.key] = r.value;
    });
    const autoReplyEnabled = settings['auto_reply_enabled'] !== 'false';
    const autoFollowupEnabled = settings['auto_followup_enabled'] !== 'false';
    const draftApprovalRequired = settings['draft_approval_required'] === 'true';

    // Fetch stats
    const statsRes = await query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'discovered') as discovered,
        COUNT(*) FILTER (WHERE status = 'researched') as researched,
        COUNT(*) FILTER (WHERE status = 'validated') as validated,
        COUNT(*) FILTER (WHERE status = 'sent') as sent,
        COUNT(*) FILTER (WHERE status = 'replied') as replied,
        COUNT(*) FILTER (WHERE status = 'outreach_completed') as completed,
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

    // Fetch active campaigns (leads sent, waiting replies, or completed) with their email and reply content
    const leadsRes = await query(`
      SELECT l.id, l.company_name, l.domain, l.contact_email, l.job_title, l.status, l.sequence_step, l.next_followup_at, l.reply_subject, l.reply_content, l.error_message,
             (SELECT subject FROM emails WHERE lead_id = l.id AND sequence_step = l.sequence_step ORDER BY id DESC LIMIT 1) as email_subject,
             (SELECT body FROM emails WHERE lead_id = l.id AND sequence_step = l.sequence_step ORDER BY id DESC LIMIT 1) as email_body
      FROM leads l
      WHERE l.status IN ('sent', 'replied', 'outreach_completed', 'validation_failed', 'scraping_failed', 'failed')
      ORDER BY l.updated_at DESC LIMIT 30
    `);

    const stats = statsRes.rows[0];
    const sentToday = sentTodayRes.rows[0].count || 0;
    const dailyLimit = process.env.DAILY_EMAIL_LIMIT || 250;

    const totalContacted = Number(stats.sent) + Number(stats.replied) + Number(stats.completed);
    const replyRate = totalContacted > 0 ? ((Number(stats.replied) / totalContacted) * 100).toFixed(1) : '0.0';

    const isMailBlusterConfigured = process.env.MAILBLUSTER_API_KEY && process.env.MAILBLUSTER_API_KEY !== 'your_mailbluster_api_key_here';
    const isGeminiConfigured = process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your_gemini_api_key_here';

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
            document.getElementById('modal-title').innerText = 'Outreach Email Content';
            document.getElementById('modal-subject').innerText = subject;
            document.getElementById('modal-body').innerText = body;
            document.getElementById('email-modal').style.display = 'flex';
          }

          function showReplyModal(id) {
            const subject = document.getElementById('reply-subj-' + id).innerText;
            const body = document.getElementById('reply-body-' + id).innerText;
            document.getElementById('modal-title').innerText = 'Client Reply Content';
            document.getElementById('modal-subject').innerText = subject;
            document.getElementById('modal-body').innerText = body;
            document.getElementById('email-modal').style.display = 'flex';
          }

          function showDraftModal(id) {
            const subject = document.getElementById('reply-subj-' + id).innerText;
            const clientReply = document.getElementById('reply-body-' + id).innerText;
            const aiDraft = document.getElementById('ai-draft-' + id).innerText;
            
            document.getElementById('draft-modal-lead-id').value = id;
            document.getElementById('draft-modal-subject').innerText = 'Re: ' + subject;
            document.getElementById('draft-modal-client-reply').innerText = clientReply;
            document.getElementById('draft-modal-textarea').value = aiDraft;
            document.getElementById('draft-modal').style.display = 'flex';
          }

          function hideDraftModal() {
            document.getElementById('draft-modal').style.display = 'none';
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

          ${!isMailBlusterConfigured ? `
            <div class="alert alert-error" style="background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.2); color: var(--danger); margin-bottom: 1.5rem;">
              <span>⚠️</span>
              <span><b>MailBluster API Key is not set!</b> Please configure <code>MAILBLUSTER_API_KEY</code> in your environment or <code>.env</code> file. Without this key, email dispatching will fail.</span>
            </div>
          ` : ''}

          ${!isGeminiConfigured ? `
            <div class="alert alert-error" style="background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.2); color: var(--danger); margin-bottom: 1.5rem;">
              <span>⚠️</span>
              <span><b>Gemini API Key is not set!</b> Please configure <code>GEMINI_API_KEY</code> in your environment or <code>.env</code> file. Without this key, AI lead research and reply generation will fail.</span>
            </div>
          ` : ''}

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
            <div class="stat-card" style="border: 1px solid var(--border-glow);">
              <div class="stat-value green" style="color:var(--primary);">${replyRate}%</div>
              <div class="stat-label">Reply Rate</div>
            </div>
            <div class="stat-card">
              <div class="stat-value red">${stats.failed}</div>
              <div class="stat-label">Bounces/Fails</div>
            </div>
          </div>

          <!-- AUTOMATION CONTROLS PANEL -->
          <div style="display: flex; gap: 1rem; align-items: center; background: rgba(255, 255, 255, 0.02); border: 1px solid var(--border); padding: 0.75rem 1.2rem; border-radius: 8px; margin-bottom: 2rem;">
            <span style="font-size: 0.7rem; text-transform: uppercase; color: #6b7280; font-weight: bold; letter-spacing: 0.05em;">Automation Settings:</span>
            
            <form method="POST" action="/settings/toggle-reply" style="margin: 0; display: flex; align-items: center; gap: 0.5rem;">
              <span style="font-size: 0.7rem; color: var(--text);">Auto-Reply:</span>
              <button type="submit" class="btn" style="padding: 0.35rem 0.7rem; font-size: 0.65rem; background: ${autoReplyEnabled ? 'rgba(16, 185, 129, 0.15)' : 'transparent'}; border: 1px solid ${autoReplyEnabled ? 'var(--success)' : 'var(--border)'}; color: ${autoReplyEnabled ? 'var(--success)' : 'var(--text)'};">
                ${autoReplyEnabled ? '● ENABLED' : '○ DISABLED'}
              </button>
            </form>

            <form method="POST" action="/settings/toggle-followup" style="margin: 0; display: flex; align-items: center; gap: 0.5rem;">
              <span style="font-size: 0.7rem; color: var(--text);">Auto-Followup:</span>
              <button type="submit" class="btn" style="padding: 0.35rem 0.7rem; font-size: 0.65rem; background: ${autoFollowupEnabled ? 'rgba(16, 185, 129, 0.15)' : 'transparent'}; border: 1px solid ${autoFollowupEnabled ? 'var(--success)' : 'var(--border)'}; color: ${autoFollowupEnabled ? 'var(--success)' : 'var(--text)'};">
                ${autoFollowupEnabled ? '● ENABLED' : '○ DISABLED'}
              </button>
            </form>

            <form method="POST" action="/settings/toggle-approval" style="margin: 0; display: flex; align-items: center; gap: 0.5rem;">
              <span style="font-size: 0.7rem; color: var(--text);">Draft Mode:</span>
              <button type="submit" class="btn" style="padding: 0.35rem 0.7rem; font-size: 0.65rem; background: ${draftApprovalRequired ? 'rgba(245, 158, 11, 0.15)' : 'rgba(16, 185, 129, 0.15)'}; border: 1px solid ${draftApprovalRequired ? 'var(--warning)' : 'var(--success)'}; color: ${draftApprovalRequired ? 'var(--warning)' : 'var(--success)'};" title="${draftApprovalRequired ? 'Drafts are held for review' : 'Drafts are sent automatically'}">
                ${draftApprovalRequired ? '● MANUAL APPROVAL' : '⚡ FULLY AUTO'}
              </button>
            </form>
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
                              ${lead.error_message ? `<div style="color:var(--danger); font-size:0.65rem; margin-top:0.25rem; max-width:180px; word-break:break-word;">${lead.error_message}</div>` : ''}
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
                                ${lead.status === 'replied' && lead.reply_content ? `
                                  <div id="reply-subj-${lead.id}" style="display:none;">${lead.reply_subject || 'Reply'}</div>
                                  <div id="reply-body-${lead.id}" style="display:none;">${lead.reply_content}</div>
                                  <button class="btn btn-secondary" style="padding: 0.3rem 0.6rem; font-size:0.65rem; background:var(--success); border-color:var(--success); color:#fff;" onclick="showReplyModal(${lead.id})">View Reply</button>
                                ` : ''}
                                ${lead.status === 'replied' && lead.ai_reply_draft ? `
                                  <div id="ai-draft-${lead.id}" style="display:none;">${lead.ai_reply_draft}</div>
                                  ${lead.ai_reply_sent ? `
                                    <span class="badge badge-green" style="font-size:0.65rem;">AI Replied</span>
                                  ` : `
                                    <button class="btn btn-primary" style="padding: 0.3rem 0.6rem; font-size:0.65rem;" onclick="showDraftModal(${lead.id})">Draft AI Reply</button>
                                  `}
                                ` : ''}
                                ${lead.status !== 'replied' && lead.status !== 'outreach_completed' && lead.status !== 'validation_failed' ? `
                                  <form method="POST" action="/leads/replied" style="margin:0; display:inline;">
                                    <input type="hidden" name="leadId" value="${lead.id}" />
                                    <button type="submit" class="btn btn-secondary" style="padding: 0.3rem 0.6rem; font-size:0.65rem;">Mark Replied</button>
                                  </form>
                                ` : ''}
                                ${!lead.email_subject && !lead.reply_content && (lead.status === 'replied' || lead.status === 'outreach_completed') ? '—' : ''}
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
                <h3 style="margin:0; color:var(--text-white); font-size:1rem; text-transform:uppercase; letter-spacing:0.1em;" id="modal-title">Outreach Email Content</h3>
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

          <!-- Send AI Reply Draft Modal -->
          <div id="draft-modal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.85); z-index:1000; justify-content:center; align-items:center; backdrop-filter:blur(4px);">
            <div style="background:var(--surface); border:1px solid var(--border); padding:2rem; border-radius:12px; width:90%; max-width:650px; box-shadow:0 20px 50px rgba(0,0,0,0.9); font-family:inherit;">
              <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--border); padding-bottom:1rem; margin-bottom:1rem;">
                <h3 style="margin:0; color:var(--text-white); font-size:1rem; text-transform:uppercase; letter-spacing:0.1em;">Review AI Reply Draft</h3>
                <button onclick="hideDraftModal()" style="background:transparent; border:none; color:#6b7280; font-size:1.5rem; cursor:pointer; font-weight:bold; padding:0;">&times;</button>
              </div>
              
              <div style="font-size:0.75rem; color:#6b7280; margin-bottom:0.5rem; max-height:100px; overflow-y:auto; padding:0.5rem; background:#000; border:1px solid var(--border); border-radius:4px;">
                <b style="color:var(--text-white);">Client's Last Message:</b>
                <div id="draft-modal-client-reply" style="white-space:pre-wrap; margin-top:0.25rem;"></div>
              </div>

              <form method="POST" action="/leads/send-ai-reply">
                <input type="hidden" name="leadId" id="draft-modal-lead-id" value="" />
                
                <div style="font-size:0.8rem; margin-bottom:0.75rem;">
                  <b style="color:var(--text-white);">Subject:</b> <span id="draft-modal-subject" style="color:var(--primary);"></span>
                </div>

                <label style="font-size:0.75rem; color:#6b7280; display:block; margin-bottom:0.25rem;">AI Generated Response (Edit as needed)</label>
                <textarea name="replyBody" id="draft-modal-textarea" class="input-field" style="min-height:220px; line-height:1.5;" required></textarea>
                
                <div style="display:flex; justify-content:space-between; align-items:center;">
                  <span style="font-size:0.65rem; color:#6b7280;">Sent directly from your Hostinger inbox</span>
                  <div class="btn-group">
                    <button type="button" class="btn btn-secondary" onclick="hideDraftModal()">Cancel</button>
                    <button type="submit" class="btn btn-primary" style="background:var(--success); border-color:var(--success); color:#fff;">Send AI Reply</button>
                  </div>
                </div>
              </form>
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
    const reqUrl = req.url || '/';
    const [pathname, search] = reqUrl.split('?');
    const searchParams = new URLSearchParams(search || '');
    const isCron = req.headers['user-agent']?.toLowerCase().includes('cron-job') || 
                   searchParams.get('json') === 'true' || 
                   pathname === '/api/trigger';

    if (pathname === '/' && req.method === 'GET') {
      await renderDashboard(res);
    } else if ((pathname === '/trigger' || pathname === '/api/trigger') && (req.method === 'POST' || req.method === 'GET')) {
      if (!isProcessing) {
        runOutreachCycle();
      }
      if (isCron || req.method === 'GET' || req.headers['accept']?.includes('application/json')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Outreach cycle triggered in background.' }));
      } else {
        await renderDashboard(res, { type: 'success', message: 'Outreach cycle triggered in background.' });
      }
    } else if (pathname === '/test-telegram' && req.method === 'POST') {
      const result = await sendTelegramNotification(
        `🔔 <b>Outreach Machine Connection Test</b>\n` +
        `If you are reading this, your Telegram Bot notifications are configured correctly! 🎉`
      );
      if (result.success) {
        await renderDashboard(res, { type: 'success', message: 'Test Telegram message sent successfully!' });
      } else {
        await renderDashboard(res, { type: 'error', message: `Failed to send Telegram message. Error: ${result.error || 'Unknown error'}` });
      }
    } else if (pathname === '/leads/reset-failed' && req.method === 'POST') {
      await query(
        `UPDATE leads SET status = 'discovered', updated_at = NOW() WHERE status IN ('scraping_failed', 'failed', 'validation_failed')`
      );
      await renderDashboard(res, { type: 'success', message: 'All failed/bounced leads reset to Discovered status successfully.' });
    } else if (pathname === '/leads/replied' && req.method === 'POST') {
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
    } else if (pathname === '/leads/send-ai-reply' && req.method === 'POST') {
      const params = await parseFormBody(req);
      const leadId = params.get('leadId');
      const replyBody = params.get('replyBody');

      if (leadId && replyBody) {
        // Fetch lead details
        const leadRes = await query(`SELECT company_name, contact_email, reply_subject FROM leads WHERE id = $1`, [leadId]);
        if (leadRes.rows.length > 0) {
          const lead = leadRes.rows[0];
          const subject = lead.reply_subject ? (lead.reply_subject.toLowerCase().startsWith('re:') ? lead.reply_subject : `Re: ${lead.reply_subject}`) : `Re: Outreach Vishnu Vardhan Burri`;
          const htmlBody = replyBody.replace(/\n/g, '<br>');
          
          const { sendSmtpEmail } = await import('./services/smtp.js');
          const success = await sendSmtpEmail(lead.contact_email, subject, htmlBody);
          
          if (success) {
            await query(
              `UPDATE leads SET ai_reply_draft = $1, ai_reply_sent = TRUE, updated_at = NOW() WHERE id = $2`,
              [replyBody, leadId]
            );
            
            // Notify Telegram
            await sendTelegramNotification(
              `✉️ <b>AI Reply Sent manually</b>\n` +
              `Company: <b>${lead.company_name}</b>\n` +
              `To: <code>${lead.contact_email}</code>\n\n` +
              `Sent directly via Hostinger SMTP.`
            );

            await renderDashboard(res, { type: 'success', message: `AI Reply successfully sent to ${lead.company_name}!` });
          } else {
            await renderDashboard(res, { type: 'error', message: 'Failed to send email. Check your SMTP configuration.' });
          }
        } else {
          await renderDashboard(res, { type: 'error', message: 'Lead not found.' });
        }
      } else {
        await renderDashboard(res, { type: 'error', message: 'Missing fields.' });
      }
    } else if (pathname === '/drafts/save' && req.method === 'POST') {
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
    } else if (pathname === '/drafts/approve' && req.method === 'POST') {
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
    } else if (pathname === '/drafts/delete' && req.method === 'POST') {
      const params = await parseFormBody(req);
      const leadId = params.get('leadId');
      if (leadId) {
        await query(`DELETE FROM leads WHERE id = $1`, [leadId]);
        await renderDashboard(res, { type: 'success', message: 'Lead deleted from outreach database.' });
      } else {
        await renderDashboard(res, { type: 'error', message: 'Missing lead ID.' });
      }
    } else if (pathname === '/settings/toggle-reply' && req.method === 'POST') {
      const settingsRes = await query(`SELECT value FROM system_settings WHERE key = 'auto_reply_enabled'`);
      const currentVal = settingsRes.rows[0]?.value || 'true';
      const newVal = currentVal === 'true' ? 'false' : 'true';
      await query(
        `INSERT INTO system_settings (key, value) VALUES ('auto_reply_enabled', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [newVal]
      );
      await renderDashboard(res, { type: 'success', message: `Auto-Reply successfully ${newVal === 'true' ? 'enabled' : 'disabled'}.` });
    } else if (pathname === '/settings/toggle-followup' && req.method === 'POST') {
      const settingsRes = await query(`SELECT value FROM system_settings WHERE key = 'auto_followup_enabled'`);
      const currentVal = settingsRes.rows[0]?.value || 'true';
      const newVal = currentVal === 'true' ? 'false' : 'true';
      await query(
        `INSERT INTO system_settings (key, value) VALUES ('auto_followup_enabled', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [newVal]
      );
      await renderDashboard(res, { type: 'success', message: `Auto-Followup successfully ${newVal === 'true' ? 'enabled' : 'disabled'}.` });
    } else if (pathname === '/settings/toggle-approval' && req.method === 'POST') {
      const settingsRes = await query(`SELECT value FROM system_settings WHERE key = 'draft_approval_required'`);
      const currentVal = settingsRes.rows[0]?.value || 'false';
      const newVal = currentVal === 'true' ? 'false' : 'true';
      await query(
        `INSERT INTO system_settings (key, value) VALUES ('draft_approval_required', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [newVal]
      );
      await renderDashboard(res, { type: 'success', message: `Draft Approval Mode set to ${newVal === 'true' ? 'Manual Approval' : 'Fully Automated Outreach'}.` });
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
async function main() {
  console.log('Outreach Machine Engine starting...');
  
  // Auto-run schema updates
  try {
    await query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS reply_content TEXT DEFAULT NULL;`);
    await query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS reply_subject VARCHAR(255) DEFAULT NULL;`);
    await query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS ai_reply_draft TEXT DEFAULT NULL;`);
    await query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS ai_reply_sent BOOLEAN DEFAULT FALSE;`);
    await query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS error_message TEXT DEFAULT NULL;`);
    
    // settings table
    await query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        key VARCHAR(255) PRIMARY KEY,
        value VARCHAR(255) NOT NULL
      );
    `);
    const defaults = [
      { key: 'auto_reply_enabled', value: 'true' },
      { key: 'auto_followup_enabled', value: 'true' },
      { key: 'draft_approval_required', value: 'false' }
    ];
    for (const d of defaults) {
      await query(`
        INSERT INTO system_settings (key, value)
        VALUES ($1, $2)
        ON CONFLICT (key) DO NOTHING
      `, [d.key, d.value]);
    }
    console.log('✔ Database schema & system_settings initialized successfully.');
  } catch (err) {
    console.error('Failed to run database schema updates on startup:', err);
  }
  
  startHttpServer();
  startScheduler();
}

main();
