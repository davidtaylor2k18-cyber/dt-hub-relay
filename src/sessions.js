const { log } = require('./logger');

const STREAM_TIMEOUT_MS = parseInt(process.env.STREAM_TIMEOUT_SECONDS || '14400', 10) * 1000;

class SessionStore {
  constructor() {
    this._sessions = new Map(); // sessionId → session object
    this._timers = new Map();   // sessionId → timeout handle
  }

  create(data) {
    const session = {
      ...data,
      state: 'pending',    // pending | live | ended
      pc: null,            // RTCPeerConnection (set by WHIPHandler)
      ffmpegProcess: null, // ffmpeg child process
      resources: new Map(),
    };
    this._sessions.set(data.sessionId, session);

    // Auto-kill after max duration
    const timer = setTimeout(() => {
      log('warn', `[${data.sessionId}] Session timed out after ${STREAM_TIMEOUT_MS / 1000}s`);
      this.destroy(data.sessionId);
    }, STREAM_TIMEOUT_MS);

    this._timers.set(data.sessionId, timer);
    return session;
  }

  get(sessionId) {
    return this._sessions.get(sessionId) || null;
  }

  list() {
    return Array.from(this._sessions.values()).map(s => ({
      sessionId: s.sessionId,
      broadcasterLogin: s.broadcasterLogin,
      state: s.state,
      createdAt: s.createdAt,
      title: s.title,
    }));
  }

  count() {
    return this._sessions.size;
  }

  async destroy(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return;

    // Clear auto-kill timer
    const timer = this._timers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this._timers.delete(sessionId);
    }

    // Kill ffmpeg
    if (session.ffmpegProcess) {
      try {
        session.ffmpegProcess.kill('SIGKILL');
      } catch {}
      session.ffmpegProcess = null;
    }

    // Close WebRTC peer connection
    if (session.pc) {
      try {
        session.pc.close();
      } catch {}
      session.pc = null;
    }

    session.state = 'ended';
    this._sessions.delete(sessionId);
    log('info', `[${sessionId}] Session destroyed`);
  }

  async destroyAll() {
    const ids = Array.from(this._sessions.keys());
    await Promise.all(ids.map(id => this.destroy(id)));
  }
}

module.exports = { SessionStore };
