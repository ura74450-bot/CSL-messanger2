const express = require('express'), http = require('http'), { Server } = require('socket.io');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const app = express(), server = http.createServer(app), io = new Server(server);
const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UP = path.join(DIR, 'uploads'), DBF = path.join(DIR, 'db.json');
fs.mkdirSync(UP, { recursive: true });

let db = { users: [], messages: [], tokens: {}, groups: [] };
try { db = JSON.parse(fs.readFileSync(DBF, 'utf8')); } catch {}
db.groups = db.groups || [];
db.messages.forEach(m => { if (m.type === 'share') m.live = false; });
let timer;
const flush = () => { try { fs.writeFileSync(DBF + '.tmp', JSON.stringify(db)); fs.renameSync(DBF + '.tmp', DBF); } catch {} };
const save = () => { clearTimeout(timer); timer = setTimeout(flush, 300); };
process.on('SIGTERM', () => { flush(); process.exit(0); });
process.on('SIGINT', () => { flush(); process.exit(0); });
const id = () => crypto.randomBytes(8).toString('hex');
const hash = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
const U = i => db.users.find(x => x.id === i), G = i => db.groups.find(x => x.id === i);
const pub = u => ({ id: u.id, nick: u.nick, name: u.name, avatar: u.avatar || null, admin: !!u.admin });
const pubG = g => ({ id: g.id, type: g.type, title: g.title, name: g.title, nick: g.id, avatar: g.avatar || null,
  owner: g.owner, public: !!g.public, created: g.created, members: g.members.map(U).filter(Boolean).map(pub) });
const ser = m => { const { hidden, ...r } = m; return { ...r, fn: (U(m.from) || { name: 'Удалённый аккаунт' }).name }; };
const members = m => m.chat ? (G(m.chat) || { members: [] }).members : [m.from, m.to];
const vis = (m, uid) => !(m.hidden || []).includes(uid) && members(m).includes(uid);
const okAv = a => typeof a === 'string' && a.startsWith('/uploads/') ? a : null;
const byToken = t => U(db.tokens[t]);
const newToken = u => { const t = id() + id(); db.tokens[t] = u.id; save(); return t; };
const prevOf = o => o.type === 'text' ? o.text.slice(0, 100) : o.type === 'image' ? '📷 Фото' : o.type === 'voice' ? '🎤 Голосовое' : o.type === 'share' ? '📺 Трансляция' : '📎 ' + (o.name || 'Файл');

// особый аккаунт администратора (пароль можно переопределить переменной ADMIN_PASS на Render)
const ADMIN_NICK = (process.env.ADMIN_NICK || 'lcg').toLowerCase(), ADMIN_PASS = process.env.ADMIN_PASS || 'asdfghjkl', ADMIN_NAME = process.env.ADMIN_NAME || 'LCG';
(function seedAdmin() {
  let a = db.users.find(u => u.nick === ADMIN_NICK);
  if (!a) { a = { id: id(), nick: ADMIN_NICK, name: ADMIN_NAME, avatar: null }; db.users.push(a); }
  a.salt = id(); a.pass = hash(ADMIN_PASS, a.salt); a.admin = true; a.banned = false; save();
})();
app.get('/health', (q, r) => r.send('ok'));
app.get('/api/status', (q, r) => { r.set('Cache-Control', 'no-store'); r.json({ maint: !!db.maint }); });
app.use(express.json());
app.use('/uploads', express.static(UP, { maxAge: '7d', setHeaders: (res, p) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!/\.(jpe?g|png|webp|gif|webm|ogg|m4a|mp3|aac)$/i.test(p)) res.setHeader('Content-Disposition', 'attachment');
} }));
app.use(express.static(path.join(__dirname, 'public')));

const auth = (req, res, next) => {
  const u = byToken((req.headers.authorization || '').replace('Bearer ', ''));
  if (!u) return res.status(401).json({ error: 'auth' });
  if (u.banned) return res.status(403).json({ error: 'banned' });
  if (db.maint && !u.admin) return res.status(503).json({ error: 'maint' });
  req.user = u; next();
};

app.post('/api/register', (req, res) => {
  if (db.maint) return res.status(503).json({ error: 'Технические работы' });
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
  if (u.banned) return res.status(403).json({ error: 'Аккаунт заблокирован' });
  if (db.maint && !u.admin) return res.status(503).json({ error: 'Технические работы' });
  res.json({ token: newToken(u), user: pub(u) });
});
app.get('/api/me', auth, (req, res) => res.json(pub(req.user)));
app.put('/api/profile', auth, (req, res) => {
  const { name, avatar } = req.body || {};
  if (typeof name === 'string' && name.trim()) req.user.name = name.trim().slice(0, 30);
  if (okAv(avatar)) req.user.avatar = avatar;
  save(); res.json(pub(req.user));
});
app.get('/api/search', auth, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase().replace(/^@/, '');
  if (!q) return res.json([]);
  const r = db.users.filter(u => u.id !== req.user.id && (req.user.admin || !u.banned) && (u.nick.includes(q) || u.name.toLowerCase().includes(q)));
  r.sort((a, b) => (b.nick.startsWith(q) - a.nick.startsWith(q)) || a.nick.localeCompare(b.nick));
  res.json(r.slice(0, 20).map(pub));
});

// Сообщения видят только участники беседы; «удалить у меня» скрывает сообщение только для этого аккаунта
app.get('/api/chats', auth, (req, res) => {
  const me = req.user.id, last = new Map();
  for (const m of db.messages) if (vis(m, me)) last.set(m.chat ? 'g:' + m.chat : 'u:' + (m.from === me ? m.to : m.from), m);
  const out = [], pins = req.user.pins || [];
  for (const [k, m] of last) if (k[0] === 'u') out.push({ peer: pub(U(k.slice(2))), last: ser(m), pinned: pins.includes(k) });
  for (const g of db.groups) if (g.members.includes(me)) { const m = last.get('g:' + g.id); out.push({ group: pubG(g), last: m ? ser(m) : null, pinned: pins.includes('g:' + g.id) }); }
  res.json(out);
});
app.get('/api/messages/:key', auth, (req, res) => {
  const me = req.user.id, [t, p] = req.params.key.split(':');
  res.json(db.messages.filter(m => vis(m, me) && (t === 'g' ? m.chat === p : !m.chat && (m.from === p || m.to === p))).slice(-300).map(ser));
});

// группы и каналы
const cast = g => g.members.forEach(i => io.to('u:' + i).emit('group', pubG(g)));
const own = (req, res) => {
  const g = G(req.params.id);
  if (!g || !g.members.includes(req.user.id)) { res.status(404).json({ error: 'Чат не найден' }); return null; }
  if (g.owner !== req.user.id) { res.status(403).json({ error: 'Только владелец может это делать' }); return null; }
  return g;
};
app.post('/api/groups', auth, (req, res) => {
  const { type, title = '', members = [], avatar, public: isPublic } = req.body || {};
  if (!['group', 'channel'].includes(type) || !title.trim()) return res.status(400).json({ error: 'Укажи название' });
  const g = { id: id(), type, title: title.trim().slice(0, 40), avatar: okAv(avatar), owner: req.user.id, public: type === 'channel' && !!isPublic,
    members: [...new Set([req.user.id, ...(Array.isArray(members) ? members : []).filter(U)])], created: Date.now() };
  db.groups.push(g); save(); cast(g); res.json(pubG(g));
});
app.put('/api/groups/:id', auth, (req, res) => {
  const g = own(req, res); if (!g) return;
  const { title, avatar } = req.body || {};
  if (typeof title === 'string' && title.trim()) g.title = title.trim().slice(0, 40);
  if (okAv(avatar)) g.avatar = avatar;
  save(); cast(g); res.json(pubG(g));
});
app.post('/api/groups/:id/members', auth, (req, res) => {
  const g = own(req, res); if (!g) return;
  for (const i of (Array.isArray(req.body.ids) ? req.body.ids : [])) if (U(i) && !g.members.includes(i)) g.members.push(i);
  save(); cast(g); res.json(pubG(g));
});
app.delete('/api/groups/:id/members/:uid', auth, (req, res) => {
  const g = G(req.params.id);
  if (!g || !g.members.includes(req.user.id)) return res.status(404).json({ error: 'Чат не найден' });
  const uid = req.params.uid, self = uid === req.user.id;
  if (!self && g.owner !== req.user.id) return res.status(403).json({ error: 'Нет прав' });
  if (uid === g.owner) return res.status(400).json({ error: 'Владелец не может выйти — удалите чат' });
  g.members = g.members.filter(i => i !== uid); save();
  io.to('u:' + uid).emit('group:gone', { id: g.id }); cast(g); res.json({ ok: true });
});
app.delete('/api/groups/:id', auth, (req, res) => {
  const g = own(req, res); if (!g) return;
  db.groups = db.groups.filter(x => x !== g); db.messages = db.messages.filter(m => m.chat !== g.id); save();
  g.members.forEach(i => io.to('u:' + i).emit('group:gone', { id: g.id })); res.json({ ok: true });
});

// админ-функции: баны и технические работы
const adm = (req, res, next) => req.user.admin ? next() : res.status(403).json({ error: 'Нет прав' });
app.get('/api/admin/users', auth, adm, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase().replace(/^@/, '');
  res.json(db.users.filter(u => !q || u.nick.includes(q) || u.name.toLowerCase().includes(q)).slice(0, 100).map(u => ({ ...pub(u), banned: !!u.banned, root: u.nick === ADMIN_NICK })));
});
app.post('/api/admin/ban', auth, adm, (req, res) => {
  const t = U(req.body && req.body.id);
  if (!t || t.admin) return res.status(400).json({ error: 'Нельзя заблокировать этого пользователя' });
  t.banned = !!req.body.banned; save();
  if (t.banned) { endLive(t.id); io.to('u:' + t.id).emit('banned'); io.in('u:' + t.id).disconnectSockets(true); }
  res.json({ ok: true, banned: t.banned });
});
app.post('/api/admin/maint', auth, adm, (req, res) => {
  db.maint = !!(req.body && req.body.on); save(); io.emit('maint', { on: db.maint }); res.json({ on: db.maint });
});

app.post('/api/admin/role', auth, adm, (req, res) => {
  const t = U(req.body && req.body.id);
  if (!t || t.id === req.user.id || t.nick === ADMIN_NICK) return res.status(400).json({ error: 'Нельзя изменить права этого пользователя' });
  if (t.banned) return res.status(400).json({ error: 'Сначала разбаньте пользователя' });
  const on = !!req.body.admin;
  if (!!t.admin !== on) {
    t.admin = on;
    const n = { admin: on };
    if (io.sockets.adapter.rooms.get('u:' + t.id)) io.to('u:' + t.id).emit('role', n); else t.notice = n;
    save();
  }
  res.json({ ok: true, admin: !!t.admin });
});

// удаление аккаунта (по нику и паролю)
function removeUser(u) {
  endLive(u.id);
  const peers = new Set();
  db.messages = db.messages.filter(m => {
    if (m.chat) return true;
    if (m.from === u.id || m.to === u.id) { peers.add(m.from === u.id ? m.to : m.from); return false; }
    return true;
  });
  for (const g of [...db.groups]) {
    if (g.owner === u.id) {
      db.groups = db.groups.filter(x => x !== g); db.messages = db.messages.filter(m => m.chat !== g.id);
      g.members.forEach(i => { if (i !== u.id) io.to('u:' + i).emit('group:gone', { id: g.id }); });
    } else if (g.members.includes(u.id)) { g.members = g.members.filter(i => i !== u.id); cast(g); }
  }
  for (const t of Object.keys(db.tokens)) if (db.tokens[t] === u.id) delete db.tokens[t];
  db.users = db.users.filter(x => x !== u);
  peers.forEach(i => io.to('u:' + i).emit('user:gone', { id: u.id }));
  io.to('u:' + u.id).emit('deleted'); io.in('u:' + u.id).disconnectSockets(true);
  save();
}
app.post('/api/account/delete', (req, res) => {
  const { nick = '', password = '' } = req.body || {};
  const u = db.users.find(x => x.nick === String(nick).trim().toLowerCase());
  if (!u || hash(String(password), u.salt) !== u.pass) return res.status(400).json({ error: 'Неверный пароль' });
  if (u.nick === ADMIN_NICK) return res.status(400).json({ error: 'Главный аккаунт нельзя удалить' });
  if (db.maint && !u.admin) return res.status(503).json({ error: 'Технические работы' });
  removeUser(u); res.json({ ok: true });
});

// публичные каналы, закрепы, удаление чата
app.get('/api/channels', auth, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  res.json(db.groups.filter(g => g.type === 'channel' && g.public && g.title.toLowerCase().includes(q))
    .sort((a, b) => b.members.length - a.members.length).slice(0, 30)
    .map(g => ({ id: g.id, type: 'channel', title: g.title, name: g.title, nick: g.id, avatar: g.avatar || null, count: g.members.length, joined: g.members.includes(req.user.id) })));
});
app.post('/api/groups/:id/join', auth, (req, res) => {
  const g = G(req.params.id);
  if (!g || g.type !== 'channel' || !g.public) return res.status(403).json({ error: 'Канал приватный' });
  if (!g.members.includes(req.user.id)) { g.members.push(req.user.id); save(); cast(g); }
  res.json(pubG(g));
});
app.put('/api/pin', auth, (req, res) => {
  const { key, pinned } = req.body || {};
  if (typeof key !== 'string') return res.status(400).json({ error: 'Ошибка' });
  const p = (req.user.pins || []).filter(k => k !== key);
  if (pinned) p.unshift(key);
  req.user.pins = p.slice(0, 20); save(); res.json({ ok: true });
});
app.delete('/api/chat/:key', auth, (req, res) => {
  const me = req.user.id, [t, p] = req.params.key.split(':');
  if (t !== 'u') return res.status(400).json({ error: 'Неверный чат' });
  db.messages.forEach(m => { if (!m.chat && vis(m, me) && (m.from === p || m.to === p)) (m.hidden = m.hidden || []).push(me); });
  req.user.pins = (req.user.pins || []).filter(k => k !== req.params.key); save(); res.json({ ok: true });
});

// загрузки: фото/аудио по белому списку, остальное — как файл (всегда скачивается)
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/aac': 'aac' };
app.post('/api/upload', auth, (req, res) => {
  const max = req.user.admin ? Infinity : 25 * 1024 * 1024;
  const ext = EXT[String(req.headers['content-type'] || '').split(';')[0].trim()];
  let name;
  if (ext && req.headers['x-kind'] !== 'file') name = id() + '.' + ext;
  else {
    let o = 'file'; try { o = decodeURIComponent(String(req.headers['x-filename'] || 'file')); } catch {}
    name = id() + '_' + (o.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(-80) || 'file');
  }
  const file = path.join(UP, name), ws = fs.createWriteStream(file);
  let n = 0, dead = false;
  const fail = (code, msg) => {
    if (dead) return; dead = true; req.unpipe(); ws.destroy(); fs.unlink(file, () => {}); req.resume();
    if (!res.headersSent) res.status(code).json({ error: msg });
  };
  req.on('data', c => { n += c.length; if (n > max) fail(413, 'Файл больше 25 МБ'); });
  req.on('aborted', () => fail(499, 'aborted'));
  ws.on('error', () => fail(500, 'Ошибка сохранения'));
  ws.on('finish', () => {
    if (dead) return;
    if (!n) { fs.unlink(file, () => {}); return res.status(400).json({ error: 'Пустой файл' }); }
    res.json({ url: '/uploads/' + encodeURIComponent(name), size: n });
  });
  req.pipe(ws);
});

// трансляции экрана: сервер только хранит сообщение и пересылает сигналы WebRTC
const lives = new Map();
function endLive(uid) {
  const mid = lives.get(uid); if (!mid) return;
  lives.delete(uid);
  const m = db.messages.find(x => x.id === mid); if (!m) return;
  m.live = false; save();
  [m.from, m.to].forEach(i => io.to('u:' + i).emit('share:end', { id: mid, from: uid }));
}
io.use((s, next) => { const u = byToken(s.handshake.auth.token); if (!u) return next(new Error('auth')); if (u.banned) return next(new Error('banned')); s.user = u; next(); });
io.on('connection', s => {
  const u = s.user;
  s.join('u:' + u.id);
  s.use((pk, next) => (u.banned || (db.maint && !u.admin)) ? next(new Error('blocked')) : next());
  if (u.notice) { s.emit('role', u.notice); delete u.notice; save(); }
  s.on('msg', d => {
    d = d || {};
    if (!['text', 'image', 'voice', 'file'].includes(d.type)) return;
    const m = { id: id(), from: u.id, type: d.type, ts: Date.now() };
    let to;
    if (d.chat) {
      const g = G(d.chat);
      if (!g || !g.members.includes(u.id) || (g.type === 'channel' && g.owner !== u.id)) return;
      m.chat = g.id;
    } else { to = U(d.to); if (!to || to.id === u.id) return; m.to = to.id; }
    if (d.type === 'text') { m.text = String(d.text || '').trim().slice(0, 4000); if (!m.text) return; }
    else {
      if (typeof d.url !== 'string' || !d.url.startsWith('/uploads/')) return;
      m.url = d.url;
      if (d.type === 'voice') m.dur = Math.min(Math.max(+d.dur || 0, 0), 3600);
      if (d.type === 'file') { m.name = String(d.name || 'file').slice(0, 120); m.size = Math.max(+d.size || 0, 0); }
    }
    if (typeof d.fwd === 'string' && d.fwd) m.fwd = d.fwd.slice(0, 40);
    if (d.reply) {
      const o = db.messages.find(x => x.id === d.reply && vis(x, u.id) &&
        (m.chat ? x.chat === m.chat : !x.chat && ((x.from === m.from && x.to === m.to) || (x.from === m.to && x.to === m.from))));
      if (o) m.reply = { id: o.id, name: (U(o.from) || {}).name, prev: prevOf(o) };
    }
    db.messages.push(m); save();
    const payload = m.chat ? ser(m) : { ...ser(m), fromU: pub(u), toU: pub(to) };
    members(m).forEach(i => io.to('u:' + i).emit('msg', payload));
  });
  s.on('del', d => {
    const ids = Array.isArray(d && d.ids) ? d.ids.slice(0, 100) : [], all = !!(d && d.all);
    for (const mid of ids) {
      const i = db.messages.findIndex(x => x.id === mid);
      if (i < 0) continue;
      const m = db.messages[i];
      if (!vis(m, u.id)) continue;
      if (all) {
        const g = m.chat && G(m.chat);
        if (m.from !== u.id && !(g && g.owner === u.id)) continue;
        db.messages.splice(i, 1);
        members(m).forEach(x => io.to('u:' + x).emit('del', { ids: [mid] }));
      } else { (m.hidden = m.hidden || []).push(u.id); io.to('u:' + u.id).emit('del', { ids: [mid] }); }
    }
    save();
  });
  s.on('share:start', d => {
    const to = U(d && d.to); if (!to || to.id === u.id) return;
    endLive(u.id);
    const m = { id: id(), from: u.id, to: to.id, type: 'share', live: true, ts: Date.now() };
    db.messages.push(m); save(); lives.set(u.id, m.id);
    const payload = { ...ser(m), fromU: pub(u), toU: pub(to) };
    [u.id, to.id].forEach(i => io.to('u:' + i).emit('msg', payload));
  });
  s.on('share:end', () => endLive(u.id));
  s.on('disconnect', () => { if (!io.sockets.adapter.rooms.get('u:' + u.id)) endLive(u.id); });
  for (const ev of ['join', 'offer', 'answer', 'ice', 'leave'])
    s.on('share:' + ev, d => {
      if (!d || !d.to) return;
      io.to('u:' + d.to).emit('share:' + ev, { sdp: d.sdp, c: d.c, from: u.id, fromU: pub(u) });
    });
  for (const ev of ['offer', 'answer', 'ice', 'end'])
    s.on('call:' + ev, d => {
      if (!d || !d.to) return;
      io.to('u:' + d.to).emit('call:' + ev, { sdp: d.sdp, c: d.c, from: u.id, fromU: pub(u) });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Messenger on :' + PORT));
