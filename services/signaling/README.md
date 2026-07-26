# DOMD collaboration signaling

Tiny Cloudflare Worker + Durable Object that lets DOMD collaboration peers
find each other and exchange **password-encrypted** SDP/ICE blobs. All
document traffic then flows peer-to-peer over WebRTC data channels — this
service never sees content, cursors, or the room password.

- One Durable Object per room (`idFromName(roomId)`), WebSocket Hibernation:
  idle rooms cost nothing.
- Expiry: the first join records the room `exp`; joins past expiry are
  rejected (close code 4001) and an alarm wipes the room record.
- No auth, no database: the security boundary is the AES-GCM key clients
  derive from the room password — wrong password means undecryptable
  signaling and therefore no connection.

## Develop

```bash
npm install --include=dev
npm run dev          # ws://localhost:8787 (the app's dev default)
```

## Deploy

```bash
npm run deploy       # wrangler deploy -> wss://domd-signaling.<account>.workers.dev
```

Then set `NEXT_PUBLIC_SIGNALING_URL=wss://...` for the web app build.
