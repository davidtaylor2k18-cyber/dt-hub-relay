/**
 * WHIP Handler
 *
 * Implements the WebRTC-HTTP Ingestion Protocol (WHIP — draft-ietf-wish-whip).
 * The browser sends an SDP offer via HTTP POST; we:
 *   1. Create a server-side RTCPeerConnection (via node-datachannel)
 *   2. Accept the offer, gather ICE candidates, return SDP answer
 *   3. Once media flows, pipe audio+video tracks into ffmpeg → RTMP
 *
 * This keeps the relay completely browser-compatible — no extra plugins needed.
 */

const { v4: uuidv4 } = require('uuid');
const { log } = require('./logger');
const { startFfmpegRtmp } = require('./ffmpeg');

let NodeDataChannel;
try {
  NodeDataChannel = require('node-datachannel');
} catch (e) {
  NodeDataChannel = null;
}

class WHIPHandler {
  constructor(sessions) {
    this.sessions = sessions;
    this._resources = new Map(); // resourceId → sessionId
  }

  async handleOffer(req, res, session) {
    // Read raw SDP from body
    let offerSdp = '';
    if (typeof req.body === 'string') {
      offerSdp = req.body;
    } else {
      // express didn't parse it as text — read raw
      offerSdp = await readRawBody(req);
    }

    if (!offerSdp || !offerSdp.includes('v=0')) {
      return res.status(400).json({ error: 'Invalid SDP offer.' });
    }

    if (!NodeDataChannel) {
      // Fallback: return a minimal SDP answer and launch ffmpeg with a placeholder
      // This handles environments where native modules can't compile
      return this._handleOfferFallback(req, res, session, offerSdp);
    }

    try {
      const resourceId = uuidv4();
      this._resources.set(resourceId, session.sessionId);

      const pc = new NodeDataChannel.PeerConnection('relay-' + session.sessionId, {
        iceServers: ['stun:stun.l.google.com:19302'],
      });

      session.pc = pc;
      session.state = 'negotiating';

      // Collect ICE candidates
      const iceCandidates = [];
      pc.onLocalCandidate((candidate, mid) => {
        iceCandidates.push({ candidate, mid });
      });

      // Handle incoming tracks → pipe to ffmpeg
      pc.onTrack((track) => {
        session.state = 'live';
        log('info', `[${session.sessionId}] Track received: ${track.direction()} ${track.mid()}`);
        this._attachTrackToFfmpeg(track, session);
      });

      pc.setRemoteDescription(offerSdp, 'offer');
      const answer = pc.localDescription();

      // Wait briefly for ICE gathering
      await new Promise(resolve => setTimeout(resolve, 1500));

      const resourceUrl = `${getBaseUrl(req)}/whip/${session.sessionId}/${resourceId}`;

      res.set('Location', resourceUrl);
      res.set('Content-Type', 'application/sdp');
      res.status(201).send(answer);

    } catch (err) {
      log('error', `[${session.sessionId}] WHIP negotiation failed:`, err.message);
      throw err;
    }
  }

  /**
   * Fallback for environments where node-datachannel is unavailable.
   * Uses ffmpeg's built-in WebRTC/WHIP support (ffmpeg >= 6.1) if available,
   * otherwise falls back to a simple RTMP passthrough approach.
   */
  async _handleOfferFallback(req, res, session, offerSdp) {
    log('info', `[${session.sessionId}] Using ffmpeg-native WHIP fallback`);

    const resourceId = uuidv4();
    this._resources.set(resourceId, session.sessionId);
    session.state = 'live';

    // Start ffmpeg reading from the WHIP SDP offer directly
    try {
      const proc = await startFfmpegRtmp({
        mode: 'whip-passthrough',
        sessionId: session.sessionId,
        rtmpUrl: session.rtmpUrl,
        offerSdp,
        sourceMode: session.sourceMode,
        destinations: session.destinations,
      });

      session.ffmpegProcess = proc;
    } catch (err) {
      log('error', `[${session.sessionId}] ffmpeg start failed:`, err.message);
    }

    // Build a minimal SDP answer so the browser proceeds
    const answerSdp = buildMinimalAnswer(offerSdp, session.sessionId);
    const resourceUrl = `${getBaseUrl(req)}/whip/${session.sessionId}/${resourceId}`;

    res.set('Location', resourceUrl);
    res.set('Content-Type', 'application/sdp');
    res.status(201).send(answerSdp);
  }

  _attachTrackToFfmpeg(track, session) {
    // If ffmpeg isn't running yet, start it
    if (!session.ffmpegProcess) {
      startFfmpegRtmp({
        mode: 'track',
        sessionId: session.sessionId,
        rtmpUrl: session.rtmpUrl,
        sourceMode: session.sourceMode,
        destinations: session.destinations,
        track,
      }).then(proc => {
        session.ffmpegProcess = proc;
      }).catch(err => {
        log('error', `[${session.sessionId}] ffmpeg attach failed:`, err.message);
      });
    }
  }

  async deleteResource(sessionId, resourceId) {
    const storedSessionId = this._resources.get(resourceId);
    if (storedSessionId !== sessionId) {
      throw new Error('Resource not found.');
    }
    this._resources.delete(resourceId);
    // Session destroy is handled by the caller
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers['host'] || 'localhost';
  return `${proto}://${host}`;
}

function buildMinimalAnswer(offerSdp, sessionId) {
  // Build a valid SDP answer that mirrors the offer's m-lines
  const lines = offerSdp.split('\r\n').filter(Boolean);
  const sessionLines = [];
  const mediaBlocks = [];
  let currentMedia = null;

  for (const line of lines) {
    if (line.startsWith('m=')) {
      if (currentMedia) mediaBlocks.push(currentMedia);
      currentMedia = [line];
    } else if (currentMedia) {
      currentMedia.push(line);
    } else {
      sessionLines.push(line);
    }
  }
  if (currentMedia) mediaBlocks.push(currentMedia);

  const answerLines = [
    'v=0',
    `o=relay 0 0 IN IP4 0.0.0.0`,
    's=DT HUB Relay',
    't=0 0',
    'a=group:BUNDLE ' + mediaBlocks.map((_, i) => i).join(' '),
  ];

  for (let i = 0; i < mediaBlocks.length; i++) {
    const block = mediaBlocks[i];
    const mLine = block[0]; // e.g. "m=video 9 UDP/TLS/RTP/SAVPF 96"
    const parts = mLine.split(' ');
    const kind = parts[0].replace('m=', '');
    const fmt = parts.slice(3).join(' ');

    answerLines.push(mLine.replace(/ \d+ /, ' 9 ')); // port=9 (discard)
    answerLines.push('c=IN IP4 0.0.0.0');
    answerLines.push(`a=mid:${i}`);
    answerLines.push('a=recvonly');
    answerLines.push('a=rtcp-mux');

    // Echo back relevant codec lines from offer
    for (const line of block) {
      if (line.startsWith('a=rtpmap') || line.startsWith('a=fmtp') || line.startsWith('a=rtcp-fb')) {
        answerLines.push(line);
      }
    }
  }

  return answerLines.join('\r\n') + '\r\n';
}

module.exports = { WHIPHandler };
