// Standalone WA pairing — phone number OTP method
// run: node wa-qr-local.js
// Reconnects automatically after 515 (normal post-pairing restart).
// Saves auth to MongoDB on connect so Render can use it.

const fs   = require('fs');
const path = require('path');
const readline = require('readline');

const AUTH_DIR = path.join(__dirname, 'wa_local_auth');
if (fs.existsSync(AUTH_DIR)) fs.readdirSync(AUTH_DIR).forEach(f => fs.unlinkSync(path.join(AUTH_DIR, f)));
else fs.mkdirSync(AUTH_DIR);

const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://sicos2725:Harshit4321@cluster27.i8cmlu4.mongodb.net/jarvis?appName=Cluster27";

async function main() {
  const { MongoClient } = require('mongodb');
  const { useMultiFileAuthState, makeWASocket, Browsers } = require('@whiskeysockets/baileys');

  const mongoClient = await MongoClient.connect(MONGO_URI, { tls: true });
  const mdb = mongoClient.db('jarvis');

  let phoneAsked = false;

  async function connect() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const sock = makeWASocket({
      auth: state,
      browser: Browsers.ubuntu('Chrome'),
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {

      if (!phoneAsked && !sock.authState.creds.registered) {
        phoneAsked = true;
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question('\n📱 Enter phone number with country code (e.g. 919876543210): ', async (num) => {
          rl.close();
          num = num.trim().replace(/\D/g, '');
          console.log(`\nRequesting pairing code for +${num}…`);
          try {
            const code = await sock.requestPairingCode(num);
            console.log(`\n🔑 PAIRING CODE: ${code}\n`);
            console.log('Enter this in WhatsApp → 3-dot menu → Linked Devices → Link a Device → Link with phone number\n');
          } catch (e) {
            console.error('Failed to get pairing code:', e.message);
          }
        });
      }

      if (connection === 'open') {
        console.log('\n✅ Connected! Saving auth to MongoDB for Render…');
        const col = mdb.collection('wa2_auth');
        await col.deleteMany({});
        const files = fs.readdirSync(AUTH_DIR);
        for (const f of files) {
          const content = fs.readFileSync(path.join(AUTH_DIR, f), 'utf8');
          await col.insertOne({ _id: f.replace('.json', ''), v: content });
        }
        console.log(`✅ Saved ${files.length} auth keys to MongoDB.`);
        console.log('\nNow resume your Render service — bot will connect with this fresh auth.\n');
        await mongoClient.close();
        process.exit(0);
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        console.log(`Connection closed (code ${code}).`);
        if (code === 515) {
          console.log('Normal post-pairing restart — reconnecting…\n');
          setTimeout(connect, 1000);
          return;
        }
        if (code === 405) console.log('405 — another session still active. Wait 5 min and retry.');
        await mongoClient.close();
        process.exit(0);
      }
    });
  }

  await connect();
}

main().catch(e => { console.error(e); process.exit(1); });
