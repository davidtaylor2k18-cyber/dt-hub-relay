require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const WebSocket = require('ws');
const { WHIPHandler } = require('./whip');
const { SessionStore } = require('./sessions');
const { log } = require('./logger');
const { startFfmpegWebmRtmp, checkFfmpeg } = require('./ffmpegWebsocket');

const PORT = parseInt(process.env.PORT || '3000', 10);
const RELAY_AUTH_TOKEN = process.env.RELAY_AUTH_TOKEN || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const app = express();
const server = http.createServer(app);
const sessions = new SessionStore();
const whip = new WHIPHandler(sessions);

// WebSocket server for /upload/:sessionId
const wss = new WebSocket.Server({ noServer: true });

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

// ── Health check (public) ──────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const active = sessions.count();
  res.json({
    ok: true,
    relay: 'DT HUB Relay',
    version: '2.0.0',
    active_streams: active,
    max_streams: parseInt(process.env.MAX_STREAMS || '10', 10),
    uptime_seconds: Math.floor(process.uptime()),
  });
});

// ── Start stream ──────────────────────────────────────────────────────────────
// POST /start
// Body: { broadcasterLogin, targetRtmpUrl, targetStreamKey, title, category, destinations[] }
// Returns: { sessionId, publishToken, uploadMode, transport, uploadUrl, publishUrl }
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

    // WebSocket upload endpoint for this session
    const baseUrl = getBaseUrl(req);
    const uploadUrl = `${baseUrl.replace(/^http/, 'ws')}/upload/${sessionId}?token=${publishToken}`;

    log('info', `[${sessionId}] Session created for ${broadcasterLogin || 'unknown'} → WebSocket ingest`);

    res.json({
      sessionId,
      publishToken,
      uploadMode: 'websocket',
      transport: 'mediarecorder-websocket',
      uploadUrl,
      publishUrl: uploadUrl,
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

// ── WHIP endpoint — deprecated, return clear error ─────────────────────────────
// POST /whip/:sessionId
app.post('/whip/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found or already ended.' });
  }

  // Return clear error: WHIP is no longer supported, use WebSocket instead
  log('warn', `[${sessionId}] WHIP endpoint called but not supported. Use WebSocket /upload instead.`);
  res.status(400).json({
    error: 'WHIP is no longer supported. Use WebSocket /upload/:sessionId instead.',
    uploadUrl: `${getBaseUrl(req).replace(/^http/, 'ws')}/upload/${sessionId}?token=${session.publishToken}`,
  });
});

// ── WHIP resource DELETE — deprecated ──────────────────────────────────────────
app.delete('/whip/:sessionId/:resourceId', async (req, res) => {
  const { sessionId } = req.params;
  log('warn', `[${sessionId}] WHIP DELETE called but not supported.`);
  res.status(400).json({ error: 'WHIP is no longer supported.' });
});

// ── Sessions list (admin) ─────────────────────────────────────────────────────
app.get('/sessions', requireAuth, (req, res) => {
  res.json({ sessions: sessions.list() });
});

// ── Catch-all 404 ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// ── WebSocket upgrade handler ─────────────────────────────────────────────────
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // Only handle /upload/:sessionId
  const match = pathname.match(/^\/upload\/([a-f0-9-]+)$/);
  if (!match) {
    socket.destroy();
    return;
  }

  const sessionId = match[1];
  const token = url.searchParams.get('token');
  const session = sessions.get(sessionId);

  if (!session) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  // Validate token
  if (token && session.publishToken && token !== session.publishToken) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  // Upgrade to WebSocket
  wss.handleUpgrade(req, socket, head, (ws) => {
    handleWebSocketUpload(ws, session);
  });
});

// ── WebSocket upload handler ──────────────────────────────────────────────────
async function handleWebSocketUpload(ws, session) {
  const { sessionId, rtmpUrl, sourceMode, destinations } = session;

  log('info', `[${sessionId}] WebSocket client connected`);

  // Start ffmpeg process
  let ffmpegProc = null;
  try {
    ffmpegProc = await startFfmpegWebmRtmp({
      sessionId,
      rtmpUrl,
      sourceMode,
      destinations,
    });
    session.ffmpegProcess = ffmpegProc;
    session.state = 'live';
  } catch (err) {
    log('error', `[${sessionId}] Failed to start ffmpeg:`, err.message);
    ws.close(1011, 'FFmpeg startup failed');
    return;
  }

  // Pipe WebSocket chunks to ffmpeg stdin
  ws.on('message', (data) => {
    if (ffmpegProc && ffmpegProc.stdin && !ffmpegProc.stdin.destroyed) {
      try {
        ffmpegProc.stdin.write(data);
      } catch (err) {
        log('error', `[${sessionId}] Failed to write to ffmpeg stdin:`, err.message);
      }
    }
  });

  ws.on('close', async () => {
    log('info', `[${sessionId}] WebSocket client disconnected`);
    if (ffmpegProc && !ffmpegProc.killed) {
      try {
        ffmpegProc.stdin.end();
        ffmpegProc.kill('SIGTERM');
      } catch {}
    }
    await sessions.destroy(sessionId);
  });

  ws.on('error', (err) => {
    log('error', `[${sessionId}] WebSocket error:`, err.message);
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', async () => {
  log('info', `DT HUB Relay listening on port ${PORT}`);
  if (!RELAY_AUTH_TOKEN) {
    log('warn', 'WARNING: No RELAY_AUTH_TOKEN set — relay is open to anyone!');
  }

  // Check ffmpeg availability
  const ffmpegStatus = await checkFfmpeg();
  if (ffmpegStatus.ok) {
    log('info', `FFmpeg available: ${ffmpegStatus.version}`);
  } else {
    log('error', 'WARNING: FFmpeg not found or not working. Streaming will fail.');
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
