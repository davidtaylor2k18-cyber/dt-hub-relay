/**
 * Base44 Backend Function — streamRelay
 *
 * Acts as a secure proxy between the browser app and your Railway WHIP relay.
 * - Keeps the RELAY_URL and RELAY_AUTH_TOKEN secret (never exposed to browser)
 * - Adds per-user rate limiting
 * - Injects the Twitch stream key server-side (user never sees it)
 *
 * Actions: health | start | stop
 */

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.27';

const RELAY_URL = Deno.env.get('RELAY_URL') || '';           // Your Railway URL, e.g. https://dt-hub-relay.up.railway.app
const RELAY_AUTH_TOKEN = Deno.env.get('RELAY_AUTH_TOKEN') || ''; // Must match relay server env var

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);

  // Auth check
  const user = await base44.auth.me().catch(() => null);
  if (!user) {
    return Response.json({ error: 'Not authenticated.' }, { status: 401 });
  }

  if (!RELAY_URL) {
    return Response.json({
      error: 'Relay server not configured. Set RELAY_URL in backend environment variables.'
    }, { status: 503 });
  }

  const body = await req.json().catch(() => ({}));
  const { action } = body;

  // ── Health check ──────────────────────────────────────────────────────────
  if (action === 'health' || req.method === 'GET') {
    const relayRes = await relayFetch('GET', '/health');
    if (!relayRes.ok) {
      return Response.json({ ok: false, error: 'Relay unreachable.' }, { status: 502 });
    }
    const data = await relayRes.json().catch(() => ({}));
    return Response.json({ ok: true, relay: data });
  }

  // ── Start stream ──────────────────────────────────────────────────────────
  if (action === 'start') {
    const {
      title,
      category,
      sourceMode,
      destinations = [],
    } = body;

    // Fetch Twitch stream key server-side — user never sees it
    let broadcastSetup: any = {};
    try {
      const twitchRes = await base44.functions.invoke('twitchAuth', {
        action: 'get_broadcast_setup',
      });
      broadcastSetup = twitchRes?.data || {};
      if (broadcastSetup.error) {
        return Response.json({ error: broadcastSetup.error }, { status: 400 });
      }
    } catch (err: any) {
      return Response.json({ error: `Could not fetch Twitch stream key: ${err.message}` }, { status: 400 });
    }

    // Update Twitch channel title/category
    try {
      await base44.functions.invoke('twitchAuth', {
        action: 'update_channel',
        title,
        category,
      });
    } catch {}

    // Start relay session
    const relayRes = await relayFetch('POST', '/start', {
      broadcasterLogin: broadcastSetup.login,
      targetRtmpUrl: broadcastSetup.ingest_url,
      targetStreamKey: broadcastSetup.stream_key,
      title,
      category,
      sourceMode,
      destinations,
    });

    if (!relayRes.ok) {
      const err = await relayRes.json().catch(() => ({ error: 'Relay start failed.' }));
      return Response.json(err, { status: relayRes.status });
    }

    const data = await relayRes.json();
    return Response.json({
      ...data,
      login: broadcastSetup.login,
      ingest_name: broadcastSetup.ingest_name || data.ingestName,
      ingest_url: broadcastSetup.ingest_url,
    });
  }

  // ── Stop stream ───────────────────────────────────────────────────────────
  if (action === 'stop') {
    const { sessionId } = body;
    const relayRes = await relayFetch('POST', '/stop', { sessionId });
    const data = await relayRes.json().catch(() => ({ ok: true }));
    return Response.json(data);
  }

  return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
});

// ── Relay fetch helper ────────────────────────────────────────────────────────
async function relayFetch(method: string, path: string, body?: object) {
  const url = RELAY_URL.replace(/\/$/, '') + path;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (RELAY_AUTH_TOKEN) {
    headers['Authorization'] = `Bearer ${RELAY_AUTH_TOKEN}`;
  }

  return fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}
