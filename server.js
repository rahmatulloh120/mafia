const express = require('express'), http = require('http'), crypto = require('crypto');
const { Server } = require('socket.io');
const app = express(), srv = http.createServer(app), io = new Server(srv);
app.use(express.static('public'));
const rooms = new Map();
const rid = () => crypto.randomBytes(8).toString('hex');
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const clamp = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : d);

function newRoom() {
  let code; do { code = crypto.randomBytes(3).toString('hex').slice(0, 5).toUpperCase(); } while (rooms.has(code));
  const r = { code, host: { token: rid(), sock: null }, players: new Map(), kicked: new Set(),
    phase: 'lobby', endsAt: 0, timer: null, event: null, winner: null, acts: null, votes: {},
    s: { night: 45, day: 90, vote: 30, reveal: true, selfVote: false } };
  rooms.set(code, r); return r;
}
const list = r => [...r.players.values()];
const alive = r => list(r).filter(p => p.alive);
const byPid = (r, pid) => list(r).find(p => p.pid === pid);
const group = (r, p) => {
  if (!p || p.muted || !p.sock) return null;
  if (r.phase === 'lobby' || r.phase === 'ended') return 'all';
  if (!p.alive) return 'ghost';
  if (r.phase === 'night') return p.role === 'mafia' ? 'mafia' : null;
  return 'public';
};
function tally(map) { const c = {}; Object.values(map).forEach(t => { if (t) c[t] = (c[t] || 0) + 1; }); return c; }
function top(c) { const e = Object.entries(c); if (!e.length) return null; const m = Math.max(...e.map(x => x[1])); const w = e.filter(x => x[1] === m); return { pid: w[0][0], tie: w.length > 1, n: m }; }

function view(r, tok) {
  const me = r.players.get(tok), host = tok === r.host.token, ended = r.phase === 'ended';
  const g = group(r, me), mafia = me && me.alive && me.role === 'mafia';
  const v = {
    code: r.code, phase: r.phase, endsAt: r.endsAt, s: r.s, host, event: r.event, winner: r.winner,
    me: me && { pid: me.pid, name: me.name, role: me.role, alive: me.alive, muted: me.muted },
    players: list(r).map(q => ({ pid: q.pid, name: q.name, alive: q.alive, connected: !!q.sock, muted: q.muted,
      role: (ended || (!q.alive && r.s.reveal) || q === me || (me && me.role === 'mafia' && q.role === 'mafia')) ? q.role : undefined })),
    group: g, peers: g ? list(r).filter(q => q !== me && group(r, q) === g).map(q => q.pid) : [],
  };
  if (r.phase === 'vote') { v.counts = tally(r.votes); v.myVote = me ? r.votes[me.pid] : null; }
  if (r.phase === 'night' && me && me.alive) {
    if (mafia) { v.counts = tally(r.acts.mafia); v.myPick = r.acts.mafia[me.pid]; }
    if (me.role === 'doctor') v.myPick = r.acts.doc;
    if (me.role === 'detective') { v.myPick = r.acts.det; }
  }
  if (me && me.role === 'detective') v.det = me.det;
  return v;
}
function push(r) {
  if (r.host.sock) io.to(r.host.sock).emit('state', view(r, r.host.token));
  r.players.forEach((p, tok) => p.sock && io.to(p.sock).emit('state', view(r, tok)));
}
function setTimer(r, secs, fn) { clearTimeout(r.timer); r.endsAt = Date.now() + secs * 1000; r.timer = setTimeout(fn, secs * 1000); }

function winCheck(r) {
  const a = alive(r), m = a.filter(p => p.role === 'mafia').length, c = a.length - m;
  const w = m === 0 ? 'civilians' : m >= c ? 'mafia' : null;
  if (w) { clearTimeout(r.timer); r.phase = 'ended'; r.winner = w; r.endsAt = 0; }
  return !!w;
}
function kill(r, p) { p.alive = false; }
function startNight(r) {
  r.phase = 'night'; r.acts = { mafia: {}, doc: null, det: null };
  setTimer(r, r.s.night, () => endNight(r)); push(r);
}
function endNight(r) {
  if (r.phase !== 'night') return;
  r.phase = 'resolving';
  const pick = top(tally(r.acts.mafia)); let died = null;
  if (pick) {
    const cands = Object.entries(tally(r.acts.mafia)).filter(x => x[1] === pick.n).map(x => x[0]);
    const t = byPid(r, shuffle(cands)[0]);
    if (t && t.alive && r.acts.doc !== t.pid) { kill(r, t); died = t; }
  }
  const det = list(r).find(p => p.role === 'detective' && p.alive), tg = r.acts.det && byPid(r, r.acts.det);
  if (det && tg) (det.det = det.det || []).push({ name: tg.name, mafia: tg.role === 'mafia' });
  r.event = died ? { type: 'death', name: died.name, role: r.s.reveal ? died.role : null, by: 'night' } : { type: 'safe' };
  if (!winCheck(r)) startDay(r); else push(r);
}
function startDay(r) { r.phase = 'day'; setTimer(r, r.s.day, () => startVote(r)); push(r); }
function startVote(r) { if (r.phase !== 'day') return; r.phase = 'vote'; r.votes = {}; setTimer(r, r.s.vote, () => endVote(r)); push(r); }
function endVote(r) {
  if (r.phase !== 'vote') return;
  r.phase = 'resolving';
  const t = top(tally(r.votes)); let out = null;
  if (t && !t.tie) { out = byPid(r, t.pid); if (out && out.alive) kill(r, out); else out = null; }
  r.event = out ? { type: 'death', name: out.name, role: r.s.reveal ? out.role : null, by: 'vote' } : { type: 'tie' };
  if (!winCheck(r)) startNight(r); else push(r);
}
function startGame(r) {
  const ps = shuffle(list(r)), n = ps.length, m = n <= 6 ? 1 : 2;
  const roles = shuffle([...Array(m).fill('mafia'), 'doctor', 'detective', ...Array(n - m - 2).fill('civilian')]);
  ps.forEach((p, i) => { p.role = roles[i]; p.alive = true; p.det = []; p.muted = false; });
  r.event = null; r.winner = null; startNight(r);
}

function ctx(sock) {
  const { code, token } = sock.data; const r = rooms.get(code);
  if (!r) return {};
  return { r, host: token === r.host.token, p: r.players.get(token) };
}
io.on('connection', sock => {
  const bind = (r, token) => { sock.data = { code: r.code, token }; sock.join(r.code); };
  sock.on('create', (_, cb) => { const r = newRoom(); r.host.sock = sock.id; bind(r, r.host.token); cb({ token: r.host.token, code: r.code }); push(r); });
  sock.on('join', ({ code, name, token }, cb) => {
    cb = cb || (() => {}); const r = rooms.get(String(code || '').toUpperCase());
    if (!r) return cb({ error: 'no room' });
    if (token === r.host.token) { r.host.sock = sock.id; bind(r, token); cb({ token, code: r.code, host: true }); return push(r); }
    if (token && r.players.has(token)) { const p = r.players.get(token); p.sock = sock.id; bind(r, token); cb({ token, code: r.code, name: p.name }); return push(r); }
    name = String(name || '').trim().slice(0, 16);
    if (!name) return cb({ error: 'Enter a nickname' });
    if (r.phase !== 'lobby') return cb({ error: 'Game already started' });
    if (r.players.size >= 10) return cb({ error: 'Room is full (10 players)' });
    if (list(r).some(p => p.name.toLowerCase() === name.toLowerCase())) return cb({ error: 'Nickname already taken' });
    const nt = rid(); if (r.kicked.has(name.toLowerCase())) return cb({ error: 'You are banned from this room' });
    r.players.set(nt, { pid: rid().slice(0, 6), name, sock: sock.id, role: null, alive: true, muted: false });
    bind(r, nt); cb({ token: nt, code: r.code, name }); push(r);
  });
  sock.on('disconnect', () => {
    const { r, host, p } = ctx(sock); if (!r) return;
    if (host && r.host.sock === sock.id) r.host.sock = null;
    if (p && p.sock === sock.id) p.sock = null;
    push(r);
    if (!r.host.sock && !list(r).some(q => q.sock)) setTimeout(() => { if (!r.host.sock && !list(r).some(q => q.sock)) { clearTimeout(r.timer); rooms.delete(r.code); } }, 10 * 60 * 1000);
  });
  // host controls
  sock.on('start', () => { const { r, host } = ctx(sock); if (host && ['lobby', 'ended'].includes(r.phase) && r.players.size >= 4) startGame(r); });
  sock.on('settings', s => { const { r, host } = ctx(sock); if (!host || !s) return;
    r.s = { night: clamp(s.night, 10, 300, r.s.night), day: clamp(s.day, 10, 600, r.s.day), vote: clamp(s.vote, 10, 120, r.s.vote), reveal: !!s.reveal, selfVote: !!s.selfVote }; push(r); });
  sock.on('skip', () => { const { r, host } = ctx(sock); if (!host) return;
    if (r.phase === 'night') endNight(r); else if (r.phase === 'day') startVote(r); else if (r.phase === 'vote') endVote(r); });
  sock.on('end', () => { const { r, host } = ctx(sock); if (host && !['lobby', 'ended'].includes(r.phase)) { clearTimeout(r.timer); r.phase = 'ended'; r.winner = 'none'; r.endsAt = 0; push(r); } });
  sock.on('mute', pid => { const { r, host } = ctx(sock); const p = host && byPid(r, pid); if (p) { p.muted = !p.muted; push(r); } });
  sock.on('remove', ({ pid, ban }) => { const { r, host } = ctx(sock); if (!host) return;
    const e = [...r.players.entries()].find(([, p]) => p.pid === pid); if (!e) return;
    const [tok, p] = e; r.kicked.add(p.name.toLowerCase()); r.players.delete(tok);
    if (p.sock) { io.to(p.sock).emit('kicked'); io.sockets.sockets.get(p.sock)?.leave(r.code); }
    if (!['lobby', 'ended'].includes(r.phase) && !winCheck(r)) { /* dead-weight removal never double-resolves a phase */ }
    push(r); });
  sock.on('allow', name => { const { r, host } = ctx(sock); if (host) { r.kicked.delete(String(name).toLowerCase()); } });
  // player actions
  sock.on('night', pid => { const { r, p } = ctx(sock); if (!p || !p.alive || r.phase !== 'night') return;
    const t = byPid(r, pid); if (!t || !t.alive) return;
    if (p.role === 'mafia' && t.role !== 'mafia') r.acts.mafia[p.pid] = t.pid;
    else if (p.role === 'doctor') r.acts.doc = t.pid;
    else if (p.role === 'detective' && t !== p) r.acts.det = t.pid;
    else return; push(r); });
  sock.on('vote', pid => { const { r, p } = ctx(sock); if (!p || !p.alive || p.muted && false || r.phase !== 'vote') return;
    if (pid === null) delete r.votes[p.pid]; else { const t = byPid(r, pid); if (!t || !t.alive || (t === p && !r.s.selfVote)) return; r.votes[p.pid] = t.pid; }
    push(r); });
  sock.on('chat', text => { const { r, p } = ctx(sock); if (!p || p.muted || typeof text !== 'string') return;
    text = text.trim().slice(0, 300); if (!text) return;
    let ch, to;
    if (!p.alive && r.phase !== 'lobby') { ch = 'ghost'; to = q => !q.alive; }
    else if (r.phase === 'night' && p.role === 'mafia') { ch = 'mafia'; to = q => q.role === 'mafia' && q.alive; }
    else if (['day', 'vote', 'lobby', 'ended'].includes(r.phase)) { ch = 'public'; to = () => true; }
    else return;
    const msg = { ch, from: p.name, text };
    r.players.forEach(q => q.sock && to(q) && io.to(q.sock).emit('chat', msg));
    if (ch === 'public' && r.host.sock) io.to(r.host.sock).emit('chat', msg); });
  sock.on('rtc', ({ to, data }) => { const { r, p } = ctx(sock); const q = p && byPid(r, to);
    if (q && group(r, p) && group(r, p) === group(r, q)) io.to(q.sock).emit('rtc', { from: p.pid, data }); });
});
srv.listen(process.env.PORT || 3000, () => console.log('Mafia server on', process.env.PORT || 3000));
