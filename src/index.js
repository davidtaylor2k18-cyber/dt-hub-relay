require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const { WHIPHandler } = require('./whip');
const { SessionStore } = require('./sessions');
const { log } = require('./logger');

const PORT = parseInt(process.env.PORT || '3000', 10);
const RELAY_AUTH_TOKEN = process.env.RELAY_AUTH_TOKEN || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const app = express();
const server = http.createServer(app);
const sessions = new SessionStore();
const whip = new WHIPHandler(sessions);

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin / server calls
    if (!ALLOWED_ORIGINS.length) return cb(null, true); // open
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  allowedHeaders: ['Content-Type', 'Authorization', 'Link'],
  exposedHeaders: ['Location', 'Link'],
  methods: ['GET', 'POST', 'DELETE', 'PATCH', 'OPTIONS'],
}));

app.options('*', cors());
app.use(express.json());

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!RELAY_AUTH_TOKEN) return next(); // no token set = open (dev mode)
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  if (token !== RELAY_AUTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized — invalid relay token.' });
  }
  next();
}

// ── Health check (public) ─────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const active = sessions.count();
  res.json({
    ok: true,
    relay: 'DT HUB WHIP Relay',
    version: '1.0.0',
    active_streams: active,
    max_streams: parseInt(process.env.MAX_STREAMS || '10', 10),
    uptime_seconds: Math.floor(process.uptime()),
  });
});

// ── Start stream ──────────────────────────────────────────────────────────────
// POST /start
// Body: { broadcasterLogin, targetRtmpUrl, targetStreamKey, title, category, destinations[] }
// Returns: { publishUrl, publishToken, sessionId }
app.post('/start', requireAuth, async (req, res) => {
  try {
    const {
      broadcasterLogin,
      targetRtmpUrl,
      targetStreamKey,
      title,
      category,
      sourceMode,
      destinations = [],
    } = req.body || {};

    if (!targetRtmpUrl || !targetStreamKey) {
      return res.status(400).json({ error: 'targetRtmpUrl and targetStreamKey are required.' });
    }

    const maxStreams = parseInt(process.env.MAX_STREAMS || '10', 10);
    if (sessions.count() >= maxStreams) {
      return res.status(503).json({ error: 'Relay is at capacity. Try again in a moment.' });
    }

    const sessionId = uuidv4();
    const publishToken = uuidv4();

    // Build full RTMP URL
    const rtmpFull = targetRtmpUrl.replace(/\/$/, '') + '/' + targetStreamKey;

    const session = sessions.create({
      sessionId,
      publishToken,
      broadcasterLogin: broadcasterLogin || 'unknown',
      rtmpUrl: rtmpFull,
      title: title || '',
      category: category || '',
      sourceMode: sourceMode || 'camera',
      destinations,
      createdAt: Date.now(),
    });

    // The WHIP publish endpoint for this session
    const publishUrl = `${getBaseUrl(req)}/whip/${sessionId}`;

    log('info', `[${sessionId}] Session created for ${broadcasterLogin || 'unknown'} → ${targetRtmpUrl}`);

    res.json({
      sessionId,
      publishUrl,
      publishToken,
      ingestName: 'DT HUB Relay',
    });
  } catch (err) {
    log('error', 'Start error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to start relay session.' });
  }
});

// ── Stop stream ───────────────────────────────────────────────────────────────
app.post('/stop', requireAuth, async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (sessionId) {
      await sessions.destroy(sessionId);
      log('info', `[${sessionId}] Session stopped via /stop`);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── WHIP endpoint — browser POSTs SDP offer here ─────────────────────────────
// POST /whip/:sessionId
app.post('/whip/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found or already ended.' });
  }

  // Validate publishToken from Authorization header
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  if (token && session.publishToken && token !== session.publishToken) {
    return res.status(401).json({ error: 'Invalid publish token.' });
  }

  try {
    await whip.handleOffer(req, res, session);
  } catch (err) {
    log('error', `[${sessionId}] WHIP offer error:`, err.message);
    res.status(500).json({ error: err.message || 'WHIP negotiation failed.' });
  }
});

// ── WHIP resource DELETE — stop a specific WHIP resource ─────────────────────
app.delete('/whip/:sessionId/:resourceId', async (req, res) => {
  const { sessionId, resourceId } = req.params;
  try {
    await whip.deleteResource(sessionId, resourceId);
    await sessions.destroy(sessionId);
    log('info', `[${sessionId}] WHIP resource deleted`);
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// ── Sessions list (admin) ─────────────────────────────────────────────────────
app.get('/sessions', requireAuth, (req, res) => {
  res.json({ sessions: sessions.list() });
});

// ── Catch-all 404 ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  log('info', `DT HUB WHIP Relay listening on port ${PORT}`);
  if (!RELAY_AUTH_TOKEN) {
    log('warn', 'WARNING: No RELAY_AUTH_TOKEN set — relay is open to anyone!');
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  log('info', 'SIGTERM received — shutting down gracefully...');
  await sessions.destroyAll();
  server.close(() => process.exit(0));
});

function getBaseUrl(req) {
  // Railway/Render provide the real host via X-Forwarded headers
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers['host'] || 'localhost';
  return `${proto}://${host}`;
}
