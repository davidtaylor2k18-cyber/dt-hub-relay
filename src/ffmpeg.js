/**
 * FFmpeg RTMP pusher
 *
 * Takes incoming WebRTC media and encodes it to RTMP for Twitch / Kick / YouTube.
 * Supports multistream: push to primary + additional destinations simultaneously.
 */

const { spawn } = require('child_process');
const path = require('path');
const { log } = require('./logger');

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';

// ── Codec profiles ────────────────────────────────────────────────────────────
function getVideoEncodeArgs(sourceMode) {
  // Use libx264 with settings tuned for streaming
  return [
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-profile:v', 'high',
    '-level', '4.1',
    '-b:v', '2500k',
    '-maxrate', '2800k',
    '-bufsize', '5000k',
    '-g', '60',          // keyframe every 2 seconds at 30fps
    '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p',
    '-r', '30',
  ];
}

function getAudioEncodeArgs() {
  return [
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
  ];
}

// ── Main entry ────────────────────────────────────────────────────────────────
async function startFfmpegRtmp({ mode, sessionId, rtmpUrl, offerSdp, sourceMode, destinations = [], track }) {
  log('info', `[${sessionId}] Starting ffmpeg → ${rtmpUrl}`);

  const allDestinations = buildAllDestinations(rtmpUrl, destinations);

  if (mode === 'whip-passthrough') {
    return startFfmpegFromSdp({ sessionId, offerSdp, sourceMode, allDestinations });
  }

  // 'track' mode — used when node-datachannel delivers actual track objects
  // In practice this falls back to sdp mode since we need the full pipe
  return startFfmpegFromSdp({ sessionId, offerSdp: null, sourceMode, allDestinations });
}

// ── FFmpeg from SDP ───────────────────────────────────────────────────────────
function startFfmpegFromSdp({ sessionId, offerSdp, sourceMode, allDestinations }) {
  return new Promise((resolve, reject) => {
    const args = buildFfmpegArgs({ offerSdp, sourceMode, allDestinations });

    log('debug', `[${sessionId}] ffmpeg args: ${args.join(' ')}`);

    const proc = spawn(FFMPEG_PATH, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    proc.stdout.on('data', (data) => {
      log('debug', `[${sessionId}] ffmpeg stdout: ${data.toString().trim()}`);
    });

    proc.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      // Only log errors and progress, not every frame
      if (msg.includes('error') || msg.includes('Error') || msg.includes('frame=')) {
        log('debug', `[${sessionId}] ffmpeg: ${msg.slice(0, 200)}`);
      }
    });

    proc.on('spawn', () => {
      log('info', `[${sessionId}] ffmpeg process started (PID ${proc.pid})`);
      resolve(proc);
    });

    proc.on('error', (err) => {
      log('error', `[${sessionId}] ffmpeg error: ${err.message}`);
      reject(err);
    });

    proc.on('close', (code) => {
      log('info', `[${sessionId}] ffmpeg exited with code ${code}`);
    });

    // If no spawn event fires within 3s, resolve anyway (some versions don't emit it)
    setTimeout(() => resolve(proc), 3000);
  });
}

// ── Build ffmpeg argument list ────────────────────────────────────────────────
function buildFfmpegArgs({ offerSdp, sourceMode, allDestinations }) {
  const args = ['-hide_banner', '-loglevel', 'warning'];

  // Input: either WebRTC/WHIP or a test source for fallback
  if (offerSdp) {
    // Use ffmpeg's built-in RTP/SRTP input from the SDP
    args.push(
      '-protocol_whitelist', 'file,crypto,data,udp,rtp,pipe',
      '-f', 'sdp',
      '-i', 'pipe:0',  // We'll write SDP to stdin
    );
  } else {
    // Fallback: lavfi test card — useful for debugging
    args.push(
      '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    );
  }

  // Video encoding
  args.push(...getVideoEncodeArgs(sourceMode));

  // Audio encoding
  args.push(...getAudioEncodeArgs());

  // Outputs — one per destination using tee muxer if multiple, otherwise direct
  if (allDestinations.length === 1) {
    args.push(
      '-f', 'flv',
      allDestinations[0],
    );
  } else {
    // Tee muxer: encode once, push to multiple RTMP endpoints
    const teeTargets = allDestinations.map(url => `[f=flv]${url}`).join('|');
    args.push(
      '-f', 'tee',
      '-map', '0:v',
      '-map', '0:a',
      teeTargets,
    );
  }

  return args;
}

// ── Destination builder ───────────────────────────────────────────────────────
function buildAllDestinations(primaryRtmpUrl, additionalDestinations = []) {
  const all = [primaryRtmpUrl];

  for (const dest of additionalDestinations) {
    if (dest.rtmpUrl && dest.streamKey) {
      const full = dest.rtmpUrl.replace(/\/$/, '') + '/' + dest.streamKey;
      all.push(full);
    }
  }

  return all.filter(Boolean);
}

// ── Check ffmpeg is available ─────────────────────────────────────────────────
async function checkFfmpeg() {
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG_PATH, ['-version'], { stdio: 'pipe' });
    let output = '';
    proc.stdout.on('data', d => { output += d.toString(); });
    proc.stderr.on('data', d => { output += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0 && output.includes('ffmpeg version')) {
        const match = output.match(/ffmpeg version (\S+)/);
        resolve({ ok: true, version: match?.[1] || 'unknown' });
      } else {
        resolve({ ok: false, version: null });
      }
    });
    proc.on('error', () => resolve({ ok: false, version: null }));
  });
}

module.exports = { startFfmpegRtmp, checkFfmpeg };
