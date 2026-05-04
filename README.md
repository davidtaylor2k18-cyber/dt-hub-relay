# DT HUB — WHIP-to-RTMP Relay Server

Converts WebRTC streams from your browser into RTMP, then pushes them to Twitch (and optionally Kick, YouTube, or any custom RTMP destination).

## How it works

```
Browser (WebRTC/WHIP)
    ↓ SDP offer via HTTP POST
Railway Relay Server
    ↓ ffmpeg encodes & muxes
Twitch RTMP ingest (+ optional multistream targets)
```

## Deploy to Railway (free, ~5 minutes)

### Step 1 — Create a Railway account
Go to https://railway.app and sign up (free tier = 500 hours/month, plenty for a streaming app).

### Step 2 — Deploy from GitHub

**Option A (recommended) — Push to GitHub first:**
1. Create a new GitHub repo (e.g. `dt-hub-relay`)
2. Copy the contents of this `relay-server/` folder into it
3. Push to GitHub
4. On Railway: New Project → Deploy from GitHub → select your repo

**Option B — Railway CLI:**
```bash
npm install -g @railway/cli
cd relay-server
railway login
railway init
railway up
```

### Step 3 — Set environment variables in Railway dashboard

Go to your Railway project → Variables tab → add these:

| Variable | Value | Notes |
|---|---|---|
| `RELAY_AUTH_TOKEN` | `any-strong-random-string` | Pick something random, e.g. `xK9mP2qR8vT5` |
| `PORT` | (leave blank — Railway sets this automatically) | |
| `MAX_STREAMS` | `10` | Max concurrent live streams |
| `LOG_LEVEL` | `info` | Or `debug` for troubleshooting |

### Step 4 — Get your Railway URL

After deploy, Railway gives you a URL like:
`https://dt-hub-relay-production.up.railway.app`

Test it: open `https://your-url.up.railway.app/health` in your browser.
You should see: `{"ok":true,"relay":"DT HUB WHIP Relay",...}`

### Step 5 — Add to your Base44 app

In your Base44 app's **backend function environment variables**, add:

| Variable | Value |
|---|---|
| `RELAY_URL` | `https://your-url.up.railway.app` |
| `RELAY_AUTH_TOKEN` | Same token you set on Railway |

Then deploy the `streamRelay` backend function (see `src/streamRelay.ts`).

### Step 6 — Update CreatorCenter.jsx

Change `getBackendDefaults()` in `src/pages/CreatorCenter.jsx`:

```js
function getBackendDefaults() {
  return {
    provider: 'twitch-relay',
    authMode: 'oauth',
    relayControlUrl: '__managed__',  // ← signals "use streamRelay function"
    relayAuthToken: '',
    manualRtmpUrl: '',
    manualStreamKey: '',
    destinations: getDefaultDestinations(),
  };
}
```

And update `relayReady`:
```js
const relayReady = true; // Always ready — relay is managed by backend
```

And update `startLive` to call `base44.functions.invoke('streamRelay', { action: 'start', ... })` instead of `postRelay(...)`.

---

## Local development

```bash
cd relay-server
cp .env.example .env
# Edit .env — set RELAY_AUTH_TOKEN
npm install
npm run dev
```

Then test:
```bash
curl http://localhost:3000/health
```

---

## Multistream support

When starting a stream, pass `destinations` array:
```json
{
  "action": "start",
  "destinations": [
    { "platform": "kick", "rtmpUrl": "rtmp://fa723fc1b171.global-contribute.live-video.net/app", "streamKey": "your-kick-key" },
    { "platform": "youtube", "rtmpUrl": "rtmp://a.rtmp.youtube.com/live2", "streamKey": "your-yt-key" }
  ]
}
```

FFmpeg will encode once and push to all destinations simultaneously.

---

## Requirements

- **Node.js 18+** (Railway provides this)
- **FFmpeg** (installed automatically via `nixpacks.toml` on Railway)
- No other infrastructure needed

## Troubleshooting

**"Relay unreachable"** — Check your Railway deployment is running and the URL is correct in Base44 env vars.

**"Stream key error"** — Make sure Twitch is linked in the user's Profile and the `twitchAuth` backend function has `TWITCH_CLIENT_ID` + `TWITCH_CLIENT_SECRET` set.

**Black screen / no video** — Check ffmpeg logs in Railway's log viewer. Usually a codec or permissions issue.

**CORS errors** — Set `ALLOWED_ORIGINS` on Railway to your app's domain (e.g. `https://your-app.base44.app`).
