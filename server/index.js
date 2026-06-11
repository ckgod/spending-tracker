// 소비패턴 수집 + 관리 웹 UI 서버.
// - POST /sms        : iOS 단축어 webhook (토큰 인증). 결제/이체 SMS 파싱·저장.
// - GET  /           : 웹 UI (비밀번호 Basic Auth)
// - GET  /api/transactions , PATCH /api/transactions/:id (memo/category) : (Basic Auth)
// Tailscale IP 전용 바인딩. 금융데이터라 외부 노출 안 함.
import express from 'express';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSms } from './parse.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKEN = readFileSync(join(__dirname, '.webhook_token'), 'utf8').trim();
const WEBPASS = readFileSync(join(__dirname, '.web_password'), 'utf8').trim();
const BIND = process.env.BIND_ADDR || '127.0.0.1'; // 실바인딩 주소는 launchd plist의 BIND_ADDR로 주입 (사설망 IP만 사용할 것)
const PORT = process.env.PORT || 8080;

const db = new Database(join(__dirname, 'spending.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT, type TEXT, amount INTEGER, merchant TEXT, balance INTEGER,
  occurred_at TEXT, received_at TEXT, parsed_ok INTEGER, raw TEXT, sender TEXT,
  memo TEXT, category TEXT, settled INTEGER DEFAULT 0, my_amount INTEGER,
  excluded INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tx_occurred ON transactions(occurred_at);
`);
// 구버전 DB 호환: excluded 컬럼 없으면 추가 (통계 제외 토글용)
{
  const cols = db.prepare(`PRAGMA table_info(transactions)`).all().map(c => c.name);
  if (!cols.includes('excluded')) db.exec(`ALTER TABLE transactions ADD COLUMN excluded INTEGER DEFAULT 0`);
}

// 카테고리: 사용자가 추가/삭제 가능. 비어있으면 기본값 시드.
// grp = 지출 성격 그룹: fixed(고정) / irregular(비정기) / variable(변동). 절약타깃 구분용.
db.exec(`CREATE TABLE IF NOT EXISTS categories (name TEXT PRIMARY KEY, sort INTEGER DEFAULT 0, grp TEXT DEFAULT 'variable')`);
// 구버전 DB 호환: grp 컬럼 없으면 추가
{
  const cols = db.prepare(`PRAGMA table_info(categories)`).all().map(c => c.name);
  if (!cols.includes('grp')) db.exec(`ALTER TABLE categories ADD COLUMN grp TEXT DEFAULT 'variable'`);
}
// 기본 그룹 매핑(신규 시드 + 기존 DB 기본값 보정에 공통 사용)
const DEFAULT_GROUP = { 식비:'variable', 술:'variable', 여행:'irregular', 담배:'variable',
  쇼핑:'variable', 생필품:'variable', 교통비:'fixed', 커피:'variable', 구독:'fixed', 기타:'variable' };
const VALID_GROUPS = ['fixed','irregular','variable'];
{
  const n = db.prepare(`SELECT COUNT(*) c FROM categories`).get().c;
  if (n === 0) {
    const seed = db.prepare(`INSERT INTO categories (name, sort, grp) VALUES (?, ?, ?)`);
    Object.keys(DEFAULT_GROUP).forEach((name, i) => seed.run(name, i, DEFAULT_GROUP[name]));
  } else {
    // 기존 DB: grp가 비었거나 기본 카테고리인데 미지정이면 매핑값으로 1회 보정
    const fix = db.prepare(`UPDATE categories SET grp=? WHERE name=? AND (grp IS NULL OR grp='' OR grp='variable')`);
    Object.entries(DEFAULT_GROUP).forEach(([name, g]) => { if (g !== 'variable') fix.run(g, name); });
    db.prepare(`UPDATE categories SET grp='variable' WHERE grp IS NULL OR grp=''`).run();
  }
}

const insert = db.prepare(`INSERT INTO transactions
  (source,type,amount,merchant,balance,occurred_at,received_at,parsed_ok,raw,sender)
  VALUES (@source,@type,@amount,@merchant,@balance,@occurred_at,@received_at,@parsed_ok,@raw,@sender)`);

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: true, limit: '64kb' }));
app.use(express.text({ type: ['text/*'], limit: '64kb' }));

// webhook 토큰 인증 (단축어용)
function tokenAuth(req, res, next) {
  const tok = req.query.token || req.get('X-Token') || (req.body && req.body.token);
  if (tok !== TOKEN) return res.status(401).json({ ok: false, error: 'bad token' });
  next();
}
// 웹 UI/API 인증: Tailscale 사설망 전용 바인딩이라 추가 비번 없음(사용자 결정 2026-06-08).
// 되돌리려면 아래 no-op을 지우고 주석 처리된 Basic Auth 로직을 복원하면 됨.
function webAuth(req, res, next) { return next(); }
function webAuthBasic(req, res, next) {
  const h = req.get('Authorization') || '';
  const b64 = h.startsWith('Basic ') ? h.slice(6) : '';
  const pass = Buffer.from(b64, 'base64').toString('utf8').split(':')[1];
  if (pass === WEBPASS) return next();
  res.set('WWW-Authenticate', 'Basic realm="spending"').status(401).send('인증 필요');
}

app.get('/health', (_req, res) => {
  const n = db.prepare('SELECT COUNT(*) c FROM transactions').get().c;
  res.json({ ok: true, count: n, ts: new Date().toISOString() });
});

// --- 단축어 webhook ---
app.post('/sms', tokenAuth, (req, res) => {
  let text = '', sender = '';
  if (typeof req.body === 'string') { text = req.body; }
  else if (req.body && typeof req.body === 'object') {
    text = req.body.text || req.body.message || req.body.body || '';
    sender = req.body.sender || req.body.from || '';
  }
  if (!text) return res.status(400).json({ ok: false, error: 'no text' });
  const p = parseSms(text);
  const isTransaction = !!(p.amount && p.type && p.source);
  if (!isTransaction) {
    console.log(`[skip] 비거래 무시: ${text.slice(0, 50).replace(/\n/g,' ')}`);
    return res.json({ ok: true, ignored: true, reason: 'not a transaction sms' });
  }
  const info = insert.run({
    source: p.source, type: p.type, amount: p.amount, merchant: p.merchant,
    balance: p.balance, occurred_at: p.occurredAt, received_at: new Date().toISOString(),
    parsed_ok: p.parsedOk ? 1 : 0, raw: text, sender,
  });
  console.log(`[sms] #${info.lastInsertRowid} ${p.source} ${p.type} ${p.amount}원 ${p.merchant||''}`);
  res.json({ ok: true, id: info.lastInsertRowid, parsed: p });
});

// --- 웹 UI + 관리 API ---
app.get('/api/transactions', webAuth, (req, res) => {
  const lim = Math.min(parseInt(req.query.limit) || 500, 2000);
  const rows = db.prepare('SELECT * FROM transactions ORDER BY COALESCE(occurred_at, received_at) DESC, id DESC LIMIT ?').all(lim);
  res.json({ ok: true, rows });
});

const upd = db.prepare(`UPDATE transactions SET
  memo=COALESCE(@memo,memo),
  category=COALESCE(@category,category),
  settled=COALESCE(@settled,settled),
  excluded=COALESCE(@excluded,excluded),
  my_amount=CASE WHEN @my_amount_set=1 THEN @my_amount ELSE my_amount END
  WHERE id=@id`);
app.patch('/api/transactions/:id', webAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const b = req.body || {};
  if (b.memo === undefined && b.category === undefined && b.settled === undefined && b.my_amount === undefined && b.excluded === undefined)
    return res.status(400).json({ ok: false });
  upd.run({
    id,
    memo: b.memo ?? null,
    category: b.category ?? null,
    settled: b.settled === undefined ? null : (b.settled ? 1 : 0),
    excluded: b.excluded === undefined ? null : (b.excluded ? 1 : 0),
    my_amount_set: b.my_amount === undefined ? 0 : 1,
    my_amount: (b.my_amount === undefined || b.my_amount === '' || b.my_amount === null) ? null : parseInt(b.my_amount),
  });
  res.json({ ok: true });
});

// --- 카테고리 관리 API ---
app.get('/api/categories', webAuth, (_req, res) => {
  const rows = db.prepare('SELECT name, grp FROM categories ORDER BY sort, name').all();
  // categories(이름 배열)는 하위호환 유지, groups(name→grp)는 신규
  res.json({ ok: true, categories: rows.map(r => r.name),
    groups: Object.fromEntries(rows.map(r => [r.name, r.grp || 'variable'])) });
});
app.post('/api/categories', webAuth, (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: 'empty name' });
  if (name.length > 20) return res.status(400).json({ ok: false, error: 'too long' });
  const grp = VALID_GROUPS.includes(req.body && req.body.grp) ? req.body.grp : 'variable';
  const max = db.prepare('SELECT COALESCE(MAX(sort),-1) m FROM categories').get().m;
  db.prepare('INSERT OR IGNORE INTO categories (name, sort, grp) VALUES (?, ?, ?)').run(name, max + 1, grp);
  res.json({ ok: true });
});
// 그룹(고정/비정기/변동) 변경
app.patch('/api/categories/:name', webAuth, (req, res) => {
  const name = String(req.params.name || '').trim();
  const grp = req.body && req.body.grp;
  if (!VALID_GROUPS.includes(grp)) return res.status(400).json({ ok: false, error: 'bad grp' });
  db.prepare('UPDATE categories SET grp=? WHERE name=?').run(grp, name);
  res.json({ ok: true });
});
app.delete('/api/categories/:name', webAuth, (req, res) => {
  const name = String(req.params.name || '').trim();
  db.prepare('DELETE FROM categories WHERE name=?').run(name);
  res.json({ ok: true });
});

// 정적 UI (Basic Auth 보호)
app.use('/', webAuth, express.static(join(__dirname, 'public')));

app.listen(PORT, BIND, () => {
  console.log(`spending-tracker (UI+webhook) on http://${BIND}:${PORT}`);
});
