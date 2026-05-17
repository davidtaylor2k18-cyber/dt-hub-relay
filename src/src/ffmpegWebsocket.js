/**
 * DT Hub WebSocket -> FFmpeg -> RTMP pusher
 *
 * Browser MediaRecorder WebM VP8/Opus
 * -> WebSocket /upload/:sessionId
 * -> ffmpeg stdin
 * -> RTMP Twitch/Kick/YouTube
 */

const { spawn } = require('child_process');
const { log } = require('./logger');

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';

function getVideoEncodeArgs(sourceMode) {
  const isScreen = sourceMode === 'screen' || sourceMode === 'both';

  return [
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-profile:v', 'high',
    '-level', '4.1',
    '-b:v', isScreen ? '3500k' : '2500k',
    '-maxrate', isScreen ? '4000k' : '2800k',
    '-bufsize', isScreen ? '8000k' : '5000k',
    '-g', '60',
    '-keyint_min', '60',
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

function startFfmpegWebmRtmp({ sessionId, rtmpUrl, sourceMode, destinations = [] }) {
  return new Promise((resolve, reject) => {
    const allDestinations = buildAllDestinations(rtmpUrl, destinations);
    const args = buildWebmArgs({ sourceMode, allDestinations });

    log('info', `[${sessionId}] Starting ffmpeg WebSocket ingest → ${redactStreamKey(rtmpUrl)}`);

    const proc = spawn(FFMPEG_PATH, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    proc.stdout.on('data', (data) => {
      log('debug', `[${sessionId}] ffmpeg stdout: ${data.toString().trim()}`);
    });

    proc.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (!msg) return;

      if (
        msg.includes('error') ||
        msg.includes('Error') ||
        msg.includes('frame=') ||
        msg.includes('speed=') ||
        msg.includes('Opening')
      ) {
        log('debug', `[${sessionId}] ffmpeg: ${msg.slice(0, 500)}`);
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

    proc.on('close', (code, signal) => {
      log('info', `[${sessionId}] ffmpeg exited with code ${code} signal ${signal || 'none'}`);
    });

    setTimeout(() => resolve(proc), 2500);
  });
}

function buildWebmArgs({ sourceMode, allDestinations }) {
  const args = [
    '-hide_banner',
    '-loglevel', process.env.FFMPEG_LOG_LEVEL || 'warning',
    '-fflags', '+genpts',
    '-flags', '+global_header',
    '-thread_queue_size', '2048',
    '-f', 'webm',
    '-i', 'pipe:0',
    '-map', '0:v:0?',
    '-map', '0:a:0?',
  ];

  args.push(...getVideoEncodeArgs(sourceMode));
  args.push(...getAudioEncodeArgs());

  if (allDestinations.length === 1) {
    args.push('-f', 'flv', allDestinations[0]);
  } else {
    const teeTargets = allDestinations
      .map(url => `[f=flv:onfail=ignore]${url}`)
      .join('|');

    args.push('-f', 'tee', teeTargets);
  }

  return args;
}

function buildAllDestinations(primaryRtmpUrl, additionalDestinations = []) {
  const all = [primaryRtmpUrl];

  for (const dest of additionalDestinations || []) {
    if (dest?.rtmpUrl && dest?.streamKey) {
      const full = dest.rtmpUrl.replace(/\/$/, '') + '/' + dest.streamKey;
      all.push(full);
    }
  }

  return all.filter(Boolean);
}

function redactStreamKey(url = '') {
  return String(url).replace(/(\/app\/).+$/i, '$1••••••');
}

async function checkFfmpeg() {
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG_PATH, ['-version'], { stdio: 'pipe' });

    let output = '';

    proc.stdout.on('data', d => {
      output += d.toString();
    });

    proc.stderr.on('data', d => {
      output += d.toString();
    });

    proc.on('close', (code) => {
      if (code === 0 && output.includes('ffmpeg version')) {
        const match = output.match(/ffmpeg version (\S+)/);
        resolve({
          ok: true,
          version: match?.[1] || 'unknown',
        });
      } else {
        resolve({
          ok: false,
          version: null,
        });
      }
    });

    proc.on('error', () => {
      resolve({
        ok: false,
        version: null,
      });
    });
  });
}

module.exports = {
  startFfmpegWebmRtmp,
  checkFfmpeg,
};
