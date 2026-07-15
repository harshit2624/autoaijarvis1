/**
 * CrosCrow WhatsApp Local Test Bot
 *
 * Uses LOCAL FILE auth — completely separate from the live Render bot's
 * MongoDB auth. Scan the QR with any secondary phone number; it will NOT
 * disturb the live connection.
 *
 * Run:  node wa-test-local.js
 * Stop: Ctrl+C
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  Browsers,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const AUTH_DIR = path.join(__dirname, '.wa_test_auth');
const LOG_FILE = path.join(__dirname, '.wa_test_messages.log');

// ── Colour helpers ──────────────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
  red: '\x1b[31m', blue: '\x1b[34m', magenta: '\x1b[35m',
};
const ts = () => new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
const log  = (...a) => console.log(`${c.dim}[${ts()}]${c.reset}`, ...a);
const info = (...a) => console.log(`${c.cyan}[${ts()}]${c.reset}`, ...a);
const ok   = (...a) => console.log(`${c.green}[${ts()}]${c.reset}`, ...a);
const warn = (...a) => console.log(`${c.yellow}[${ts()}]${c.reset}`, ...a);
const err  = (...a) => console.log(`${c.red}[${ts()}]${c.reset}`, ...a);

// ── In-memory message log ───────────────────────────────────────────────────
const messageLog = [];
function appendLog(entry) {
  messageLog.push(entry);
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
}

// ── Pending set (mirrors live bot) ─────────────────────────────────────────
const waPending = new Set();

// ── Bot logic — mirrors the live bot's routing ──────────────────────────────
// Set this to the admin number you want to test from:
const ADMIN_NO = process.env.TEST_ADMIN_NO || '8209544626';
const ADMIN_CODE = process.env.TEST_ADMIN_CODE || '4626';

async function handleMessage(sock, msg) {
  if (msg.key.fromMe) return;
  if (msg.key.remoteJid?.endsWith('@g.us')) return;

  const sender = msg.key.remoteJid;
  const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();
  if (!text) return;
  if (waPending.has(sender)) { warn(`⏳ still pending for ${sender}, skipping`); return; }

  waPending.add(sender);

  try {
    await sock.readMessages([msg.key]);

    // Extract phone
    let phone = 'unknown';
    if (sender.includes('@s.whatsapp.net')) {
      const raw = sender.replace('@s.whatsapp.net', '').replace(/^91/, '');
      if (/^[6-9]\d{9}$/.test(raw)) phone = raw;
    }

    info(`📨  FROM: ${sender}`);
    info(`    phone : ${phone}`);
    info(`    text  : "${text}"`);

    appendLog({ ts: new Date().toISOString(), sender, phone, text, direction: 'in' });

    // ── Admin code unlock ────────────────────────────────────────────────
    if (text.trim() === ADMIN_CODE) {
      const reply = `✅ Admin mode active (TEST BOT)\nYour JID: ${sender}\nPhone resolved: ${phone}`;
      await sock.sendMessage(sender, { text: reply });
      ok(`✅ Admin code accepted — JID captured: ${sender}`);
      appendLog({ ts: new Date().toISOString(), sender, direction: 'out', text: reply });
      return;
    }

    // ── Simulate routing decision ────────────────────────────────────────
    const isAdmin = phone === ADMIN_NO;
    const isLID   = sender.includes('@lid') || (phone === 'unknown' && !sender.includes('@s.whatsapp.net'));

    let routeLabel;
    if (isAdmin) routeLabel = 'ADMIN PATH';
    else if (isLID) routeLabel = 'CUSTOMER PATH (LID — phone unresolvable)';
    else routeLabel = 'CUSTOMER PATH';

    // Echo back diagnostic info
    const reply =
`🔍 *TEST BOT ECHO*

Route: ${routeLabel}
Sender JID: \`${sender}\`
Phone: ${phone}
Text: "${text}"

To test admin mode, send: *${ADMIN_CODE}*
To test vendor nudge send: *vendor*
To test greeting: *hi*`;

    await sock.sendMessage(sender, { text: reply });
    ok(`✅ Echo sent to ${sender}`);
    appendLog({ ts: new Date().toISOString(), sender, direction: 'out', text: reply });

    // ── Special test commands ─────────────────────────────────────────
    if (text.toLowerCase() === 'vendor') {
      const vendorMsg =
`⏰ *24hr Warning — Order #TEST-001*

Hi TestVendor,

This order has been confirmed but not yet shipped.

You have *24 hours left* before a penalty is applied.

Reply with:
*1️⃣* — Order is delayed (share reason + ETA)
*2️⃣* — Already shipped (share AWB + courier)

_Ship now to avoid penalty — CrosCrow Ops_`;
      await sock.sendMessage(sender, { text: vendorMsg });
      ok(`📲 Vendor warning simulation sent`);
    }

    if (text.toLowerCase() === 'penalty') {
      const penMsg =
`🚨 *Penalty Triggered — Order #TEST-001*

Hi TestVendor,

A penalty has been applied to your account.

*Reason:* Order not shipped within 48 hours of confirmation

This will be deducted from your next settlement.

_CrosCrow Operations_`;
      await sock.sendMessage(sender, { text: penMsg });
      ok(`📲 Penalty simulation sent`);
    }

    if (/^(hi|hello|hey)$/i.test(text)) {
      await sock.sendMessage(sender, { text: `👋 Welcome to CrosCrow!\n\n1️⃣ Track my order\n2️⃣ Return/Exchange\n3️⃣ Talk to a human\n\n_[TEST BOT]_` });
    }

  } catch (e) {
    err(`❌ handleMessage error:`, e.message);
    await sock.sendMessage(sender, { text: `[TEST BOT ERROR] ${e.message}` }).catch(() => {});
  } finally {
    waPending.delete(sender);
  }
}

// ── Interactive CLI (send messages from terminal) ───────────────────────────
function startCLI(sock) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(`\n${c.bold}${c.magenta}─── Interactive Console ───────────────────────────────${c.reset}`);
  console.log(`${c.dim}Commands:`);
  console.log(`  send <jid> <message>   — send a message to a JID`);
  console.log(`  log                    — print recent message log`);
  console.log(`  status                 — show connection status`);
  console.log(`  quit                   — exit${c.reset}\n`);

  rl.on('line', async (line) => {
    const [cmd, ...rest] = line.trim().split(' ');
    if (!cmd) return;

    if (cmd === 'send') {
      const jid = rest[0];
      const msg = rest.slice(1).join(' ');
      if (!jid || !msg) { warn('Usage: send <jid> <message>'); return; }
      try {
        await sock.sendMessage(jid, { text: msg });
        ok(`✅ Sent to ${jid}: "${msg}"`);
        appendLog({ ts: new Date().toISOString(), sender: jid, direction: 'out_manual', text: msg });
      } catch (e) { err(`Send failed: ${e.message}`); }

    } else if (cmd === 'log') {
      console.log(`\n${c.bold}Recent messages (last 20):${c.reset}`);
      messageLog.slice(-20).forEach(m => {
        const arrow = m.direction === 'in' ? `${c.green}←${c.reset}` : `${c.blue}→${c.reset}`;
        console.log(`  ${arrow} [${m.ts.slice(11,19)}] ${m.sender.slice(0,25).padEnd(25)} "${(m.text||'').slice(0,60)}"`);
      });

    } else if (cmd === 'status') {
      info(`Socket state: ${sock.ws?.readyState ?? 'unknown'}`);
      info(`Auth dir: ${AUTH_DIR}`);
      info(`Log file: ${LOG_FILE}`);
      info(`Pending set size: ${waPending.size}`);

    } else if (cmd === 'quit' || cmd === 'exit') {
      console.log('Bye!');
      process.exit(0);

    } else {
      warn(`Unknown command: ${cmd}`);
    }
  });
}

// ── Main ────────────────────────────────────────────────────────────────────
async function start() {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  console.log(`\n${c.bold}${c.green}CrosCrow WA Test Bot${c.reset}`);
  console.log(`${c.dim}Auth dir : ${AUTH_DIR}`);
  console.log(`Message log: ${LOG_FILE}${c.reset}`);
  console.log(`${c.yellow}⚠️  This is ISOLATED from the live bot — uses local file auth only${c.reset}\n`);

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  info(`Baileys version: ${version.join('.')}`);

  const sock = makeWASocket({
    version,
    auth: state,
    browser: Browsers.macOS('Desktop'),
    printQRInTerminal: true,
    logger: { level: 'silent', info() {}, warn: (o) => warn('[baileys]', o?.msg || ''), error: (o) => err('[baileys]', o?.msg || o) },
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log(`\n${c.bold}${c.yellow}📱 Scan this QR with ANY phone (NOT the live bot's number)${c.reset}`);
      console.log(`${c.dim}   The live CrosCrow bot won't be affected.${c.reset}\n`);
    }
    if (connection === 'open') {
      ok(`✅ Test bot connected!`);
      ok(`   From your admin phone, message this bot to test routing.`);
      ok(`   Send "${ADMIN_CODE}" to test admin code path.`);
      startCLI(sock);
    }
    if (connection === 'close') {
      const code = (lastDisconnect?.error as any)?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      warn(`Connection closed (code ${code}) — ${shouldReconnect ? 'reconnecting...' : 'logged out'}`);
      if (shouldReconnect) setTimeout(start, 3000);
      else {
        warn('Session logged out. Delete .wa_test_auth/ and re-run to get a new QR.');
        process.exit(0);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      await handleMessage(sock, msg);
    }
  });
}

start().catch(e => { err('Fatal:', e.message); process.exit(1); });
