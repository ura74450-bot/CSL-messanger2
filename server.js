const express = require('express'), http = require('http'), { Server } = require('socket.io');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const app = express(), server = http.createServer(app), io = new Server(server);
const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UP = path.join(DIR, 'uploads'), DBF = path.join(DIR, 'db.json');
fs.mkdirSync(UP, { recursive: true });

let db = { users: [], messages: [], tokens: {} };
try { db = JSON.parse(fs.readFileSync(DBF, 'utf8')); } catch {}
let timer;
const save = () => { clearTimeout(timer); timer = setTimeout(() => fs.writeFile(DBF, JSON.stringify(db), () => {}), 300); };
const id = () => crypto.randomBytes(8).toString('hex');
const hash = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
const pub = u => ({ id: u.id, nick: u.nick, name: u.name, avatar: u.avatar || null });
const byToken = t => db.users.find(u => u.id === db.tokens[t]);
const newToken = u => { const t = id() + id(); db.tokens[t] = u.id; save(); return t; };

app.use(express.json());
app.use('/uploads', express.static(UP, { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public')));

const auth = (req, res, next) => {
  const u = byToken((req.headers.authorization || '').replace('Bearer ', ''));
  if (!u) return res.status(401).json({ error: 'auth' });
  req.user = u; next();
};

app.post('/api/register', (req, res) => {
  const { nick = '', password = '', name = '' } = req.body || {};
  const n = nick.trim().toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(n)) return res.status(400).json({ error: 'Ник: 3–20 символов, латиница, цифры, _' });
  if (password.length < 4) return res.status(400).json({ error: 'Пароль минимум 4 символа' });
  if (db.users.some(u => u.nick === n)) return res.status(400).json({ error: 'Этот ник уже занят' });
  const salt = id();
  const u = { id: id(), nick: n, name: name.trim().slice(0, 30) || n, salt, pass: hash(password, salt), avatar: null };
  db.users.push(u); save();
  res.json({ token: newToken(u), user: pub(u) });
});

app.post('/api/login', (req, res) => {
  const { nick = '', password = '' } = req.body || {};
  const u = db.users.find(x => x.nick === nick.trim().toLowerCase());
  if (!u || hash(password, u.salt) !== u.pass) return res.status(400).json({ error: 'Неверный ник или пароль' });
  res.json({ token: newToken(u), user: pub(u) });
});

app.get('/api/me', auth, (req, res) => res.json(pub(req.user)));

app.put('/api/profile', auth, (req, res) => {
  const { name, avatar } = req.body || {};
  if (typeof name === 'string' && name.trim()) req.user.name = name.trim().slice(0, 30);
  if (typeof avatar === 'string' && avatar.startsWith('/uploads/')) req.user.avatar = avatar;
  save(); res.json(pub(req.user));
});

app.get('/api/search', auth, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase().replace(/^@/, '');
  if (!q) return res.json([]);
  const r = db.users.filter(u => u.id !== req.user.id && (u.nick.includes(q) || u.name.toLowerCase().includes(q)));
  r.sort((a, b) => (b.nick.startsWith(q) - a.nick.startsWith(q)) || a.nick.localeCompare(b.nick));
  res.json(r.slice(0, 20).map(pub));
});

app.get('/api/chats', auth, (req, res) => {
  const me = req.user.id, last = new Map();
  for (const m of db.messages) if (m.from === me || m.to === me) last.set(m.from === me ? m.to : m.from, m);
  res.json([...last].map(([pid, m]) => ({ peer: pub(db.users.find(x => x.id === pid)), last: m })).sort((a, b) => b.last.ts - a.last.ts));
});

app.get('/api/messages/:peer', auth, (req, res) => {
  const me = req.user.id, p = req.params.peer;
  res.json(db.messages.filter(m => (m.from === me && m.to === p) || (m.from === p && m.to === me)).slice(-300));
});

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/aac': 'aac' };
app.post('/api/upload', auth, express.raw({ type: () => true, limit: '15mb' }), (req, res) => {
  const ext = EXT[String(req.headers['content-type'] || '').split(';')[0].trim()];
  if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Неподдерживаемый файл' });
  const name = id() + '.' + ext;
  fs.writeFile(path.join(UP, name), req.body, err => err ? res.status(500).json({ error: 'Ошибка сохранения' }) : res.json({ url: '/uploads/' + name }));
});

io.use((s, next) => { const u = byToken(s.handshake.auth.token); if (!u) return next(new Error('auth')); s.user = u; next(); });
io.on('connection', s => {
  const u = s.user;
  s.join('u:' + u.id);
  s.on('msg', d => {
    d = d || {};
    const to = db.users.find(x => x.id === d.to);
    if (!to || to.id === u.id || !['text', 'image', 'voice'].includes(d.type)) return;
    const m = { id: id(), from: u.id, to: to.id, type: d.type, ts: Date.now() };
    if (d.type === 'text') { m.text = String(d.text || '').trim().slice(0, 4000); if (!m.text) return; }
    else {
      if (typeof d.url !== 'string' || !d.url.startsWith('/uploads/')) return;
      m.url = d.url;
      if (d.type === 'voice') m.dur = Math.min(Math.max(+d.dur || 0, 0), 3600);
    }
    db.messages.push(m); save();
    io.to('u:' + to.id).to('u:' + u.id).emit('msg', { ...m, fromU: pub(u), toU: pub(to) });
  });
  for (const ev of ['offer', 'answer', 'ice', 'end'])
    s.on('call:' + ev, d => {
      if (!d || !d.to) return;
      io.to('u:' + d.to).emit('call:' + ev, { sdp: d.sdp, c: d.c, from: u.id, fromU: pub(u) });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Messenger on :' + PORT));
