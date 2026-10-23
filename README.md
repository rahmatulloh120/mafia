# Mafia (real-time multiplayer)
Run: `npm install && npm start` → http://localhost:3000 (PORT env var supported).
Deploy: any Node host with WebSockets (Render, Railway, Fly). Serve over HTTPS — browsers block the microphone on plain HTTP (localhost is exempt).
Voice: WebRTC mesh, STUN only. For reliability behind strict NATs add a TURN server: define `window.TURN=[{urls:'turn:host',username:'u',credential:'p'}]` before the main script in public/index.html.
Rules: 4–10 players, 1 Mafia (≤6 players) or 2 (7–10), 1 Doctor, 1 Detective. All state and secrets live on the server.
