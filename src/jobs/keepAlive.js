// F-01: keep Supabase project awake (Free tier freezes after 7 days of inactivity).
// Self-ping the health endpoint every 12 hours. Safe to disable via KEEP_ALIVE=false.
const INTERVAL_MS = 12 * 60 * 60 * 1000;
let timer = null;
function start() {
  if (process.env.KEEP_ALIVE === 'false') return;
  if (timer) return;
  const url = process.env.KEEP_ALIVE_URL || `http://localhost:${process.env.PORT || 5000}/health`;
  const ping = async () => {
    try {
      const http = url.startsWith('https') ? require('https') : require('http');
      http.get(url, (res) => { /* drain */ res.resume(); }).on('error', (e) => console.warn('[keepalive] ping failed:', e.message));
    } catch (e) { console.warn('[keepalive] error:', e.message); }
  };
  timer = setInterval(ping, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  setTimeout(ping, 30_000).unref?.();
  console.log(`[keepalive] started (every 12h) -> ${url}`);
}
function stop() { if (timer) clearInterval(timer); timer = null; }
module.exports = { start, stop };
