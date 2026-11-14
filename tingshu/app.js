/* TXT 听书 — 本地解析 + 小米 MiMo TTS 合成 */

const DEFAULT_BASE = 'https://api.xiaomimimo.com/v1';
const AI_DEFAULT_BASE = 'https://api.deepseek.com/v1';
const AI_DEFAULT_MODEL = 'deepseek-chat';
const APP_VER = 'v12';
const VOICES = [
  { id: '冰糖', label: '冰糖 · 中文女声' },
  { id: '茉莉', label: '茉莉 · 中文女声' },
  { id: '苏打', label: '苏打 · 中文男声' },
  { id: '白桦', label: '白桦 · 中文男声' },
  { id: 'Mia', label: 'Mia · 英文女声' },
  { id: 'Chloe', label: 'Chloe · 英文女声' },
  { id: 'Milo', label: 'Milo · 英文男声' },
  { id: 'Dean', label: 'Dean · 英文男声' },
];
const NARRATOR_STYLE = '平稳自然，像讲故事一样，语速适中。';
const $ = (id) => document.getElementById(id);

/* ---------------- 设置 ---------------- */
function loadSettings() {
  try {
    return Object.assign(
      { apiKey: '', baseUrl: DEFAULT_BASE, singleVoice: false, keepAwake: true },
      JSON.parse(localStorage.getItem('tts.settings') || '{}')
    );
  } catch {
    return { apiKey: '', baseUrl: DEFAULT_BASE, singleVoice: false, keepAwake: true };
  }
}
function saveSettings(patch) {
  const s = Object.assign(loadSettings(), patch);
  localStorage.setItem('tts.settings', JSON.stringify(s));
  return s;
}

function loadAi() {
  const cfg = { baseUrl: AI_DEFAULT_BASE, key: '', model: AI_DEFAULT_MODEL };
  try {
    const saved = JSON.parse(localStorage.getItem('tts.ai') || '{}') || {};
    for (const k of Object.keys(cfg)) if (saved[k]) cfg[k] = saved[k];
  } catch {}
  return cfg;
}
function saveAi(patch) {
  const s = Object.assign(loadAi(), patch);
  localStorage.setItem('tts.ai', JSON.stringify(s));
  return s;
}

/* ---------------- IndexedDB ---------------- */
let db = null;
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('tingshu', 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('books')) d.createObjectStore('books', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('audio')) {
        const s = d.createObjectStore('audio', { keyPath: 'key' });
        s.createIndex('bookId', 'bookId');
      }
      if (!d.objectStoreNames.contains('voices')) {
        const v = d.createObjectStore('voices', { keyPath: 'key' });
        v.createIndex('bookId', 'bookId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function store(name, mode = 'readonly') {
  return db.transaction(name, mode).objectStore(name);
}
const idb = {
  get: (s, k) => new Promise((res, rej) => {
    const r = store(s).get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }),
  put: (s, v) => new Promise((res, rej) => {
    const r = store(s, 'readwrite').put(v); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }),
  del: (s, k) => new Promise((res, rej) => {
    const r = store(s, 'readwrite').delete(k); r.onsuccess = () => res(); r.onerror = () => rej(r.error);
  }),
  all: (s) => new Promise((res, rej) => {
    const r = store(s).getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error);
  }),
  clear: (s) => new Promise((res, rej) => {
    const r = store(s, 'readwrite').clear(); r.onsuccess = () => res(); r.onerror = () => rej(r.error);
  }),
};
function deleteAudioOfBook(bookId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('audio', 'readwrite');
    const idx = tx.objectStore('audio').index('bookId');
    const req = idx.openCursor(IDBKeyRange.only(bookId));
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) { cur.delete(); cur.continue(); }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
function deleteVoicesOfBook(bookId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('voices', 'readwrite');
    const idx = tx.objectStore('voices').index('bookId');
    const req = idx.openCursor(IDBKeyRange.only(bookId));
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) { cur.delete(); cur.continue(); }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
const voiceSampleMem = new Map();
function voiceKey(bookId, name, ref) {
  return bookId + ':' + name + (ref ? '#' + ref : '');
}
async function getVoiceSample(bookId, name, ref) {
  const k = voiceKey(bookId, name, ref);
  if (voiceSampleMem.has(k)) return voiceSampleMem.get(k);
  let v = '';
  try { v = (await idb.get('voices', k))?.dataUri || ''; } catch {}
  voiceSampleMem.set(k, v);
  return v;
}
async function putVoiceSample(bookId, name, dataUri, desc, ref) {
  const k = voiceKey(bookId, name, ref);
  await idb.put('voices', { key: k, bookId, name, dataUri, desc, createdAt: Date.now() });
  voiceSampleMem.set(k, dataUri);
}
async function descRef(desc) {
  return 'd' + (await hashKey(String(desc).trim())).slice(0, 16);
}
async function getEntrySample(bookId, name, entry) {
  if (!entry) return '';
  const refs = [];
  if (entry.sampleRef) refs.push(entry.sampleRef);
  if (entry.voiceDesc) refs.push(await descRef(entry.voiceDesc));
  refs.push('');
  for (const ref of [...new Set(refs)]) {
    const uri = await getVoiceSample(bookId, name, ref);
    if (uri) return uri;
  }
  return '';
}

/* ---------------- 小工具 ---------------- */
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'b' + Date.now() + Math.random().toString(16).slice(2));

async function hashKey(str) {
  if (crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
  }
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
  }
  return 'f' + h1.toString(16) + h2.toString(16);
}

function b64ToBlob(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

let toastTimer = 0;
function toast(msg, ms = 2400) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* ---------------- 文本解析 ---------------- */
function decodeText(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try { return new TextDecoder('gbk').decode(buf); }
    catch { return new TextDecoder('utf-8').decode(buf); }
  }
}

const CHAPTER_RE = /^\s*(?:(?:第\s*[0-9零一二三四五六七八九十百千万两]+\s*[章回节卷部篇集][^\n]{0,30})|(?:序章|楔子|引子|前言|后记|尾声|终章|番外)[^\n]{0,30})\s*$/;

function sanitizeText(text) {
  const lines = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const isJson = (line) =>
    /^\s*[\[\]{}],?\s*$/.test(line) ||
    /^\s*"(?:storyboards|id|duration|scene_ids|role_ids|prop_ids|prompt|scene|role|prop)"\s*:/.test(line) ||
    /@(?:scene|role|prop)_/.test(line) ||
    /^\s*<\/?[a-z][^>]*>\s*$/i.test(line);
  let seenChapter = false;
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (!seenChapter && t.length <= 40 && CHAPTER_RE.test(t)) seenChapter = true;
    if (isJson(line)) continue;
    if (!seenChapter && /^(?:书名|作者|内容简介|简介|文案|来源)\s*[:：]/.test(t)) continue;
    out.push(line);
  }
  return out.join('\n');
}

function parseChapters(text) {
  const lines = text.split(/\r?\n/);
  const chapters = [];
  let cur = { title: '开篇', lines: [] };
  let found = 0;
  for (const line of lines) {
    const t = line.trim();
    if (t && t.length <= 40 && CHAPTER_RE.test(t)) {
      const body = cur.lines.join('\n').trim();
      if (body) chapters.push({ title: cur.title, content: body });
      cur = { title: t, lines: [] };
      found++;
    } else {
      cur.lines.push(line);
    }
  }
  const body = cur.lines.join('\n').trim();
  if (body) chapters.push({ title: cur.title, content: body });
  if (found < 2) return chunkByLength(text, 3500);
  return chapters;
}

function chunkByLength(text, size) {
  const paras = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const out = [];
  let buf = '', no = 1;
  for (const p of paras) {
    if (buf.length && buf.length + p.length > size) {
      out.push({ title: `第 ${no++} 节`, content: buf });
      buf = '';
    }
    buf += (buf ? '\n' : '') + p;
  }
  if (buf) out.push({ title: `第 ${no} 节`, content: buf });
  return out;
}

function findQuotes(p) {
  const out = [];
  let i = 0;
  while (i < p.length) {
    const c = p[i];
    let close = null;
    if (c === '“') close = '”';
    else if (c === '「') close = '」';
    else if (c === '『') close = '』';
    else if (c === '"') close = '"';
    if (!close) { i++; continue; }
    let j = p.indexOf(close, i + 1);
    if (j === -1 && c === '「') j = p.indexOf('』', i + 1);
    if (j === -1) break;
    out.push({ start: i, end: j + 1, text: p.slice(i + 1, j) });
    i = j + 1;
  }
  return out;
}

const SPEECH_VERBS = ['冷笑道', '苦笑道', '淡淡道', '轻声道', '沉声道', '反问道', '解释道', '补充道', '说道', '问道', '答道', '笑道', '怒道', '叹道', '喊道', '叫道', '嚷道', '哼道', '嗔道', '接口', '接道', '续道', '应道', '插嘴', '插口', '开口', '回答', '低语', '嘟囔', '嘀咕', '说', '道', '问', '答', '喊', '叫'];
const SPEECH_SRC = SPEECH_VERBS.slice().sort((a, b) => b.length - a.length).join('|');
const VERB_SRC = SPEECH_SRC;
const ACTION_SRC = ['叹了口气', '摇了摇头', '点了点头', '咬着牙', '沉着脸', '板着脸', '眯着眼', '站起身', '坐下', '走过来', '走过去', '转过身', '望着', '看着', '看向', '望了', '看了', '转头', '抬头', '低头', '皱眉', '笑了', '冷笑', '微笑', '娇笑', '大喝'].sort((a, b) => b.length - a.length).join('|');
const LEAD_TIME = /^(?:这时|此时|那时|随后|接着|于是|只见|却见|就听|只听|忽然|突然|随即|然后|终于|忍不住|不由得|不禁)/;
const NAME_STOP = new Set(['他们', '她们', '它们', '我们', '你们', '咱们', '大家', '众人', '两人', '三人', '那人', '此人', '有人', '没人', '对方', '自己', '所有', '声音', '目光', '眼中', '心里', '嘴角', '脸上', '一边', '一声', '一句', '一眼', '一脸', '沉默', '不知', '只是', '现在', '刚才', '果然', '似乎', '仿佛', '好像', '一时', '半天', '突然', '忽然', '接着', '然后', '于是', '男人', '女人', '老者', '少年', '少女', '青年', '孩子', '姑娘', '公子', '小姐', '先生', '夫人', '道士', '和尚', '黑衣', '白衣', '中年', '老人', '小孩', '老大', '丫头', '老师', '眼睛', '而且', '为什么', '既然', '当然', '看来', '原来', '只要', '准确', '只有', '无论', '比如', '第一', '俗话', '废话', '心中', '明明', '红衣', '白发']);
const NAME_BAD_START = /^[我你他她它们这那如但虽因所其就还又也都才却便则很最更不没要会能可应必于然立马终竟从把被给让对向和与在是有个啥谁哪几两一二三四五六七八九十百千万第只真知难味站坐走跑躺看听说问答笑叹哭怒喊叫望盯转抬低摇点握拿放推拉抓咬皱冷轻沉缓慢淡怎什人已当身想为的以求按而]/;
const NAME_BAD_END = /[着了的地得说问答喊叫笑道]/;
const NAME_BAD_NEXT = /[一又便才却也都则就忙连急忽突随终忍不禁正还在把被拿给让叫想听望看盯转抬握皱点摇走站坐低轻沉缓慢冷淡怒叹哼微少知暗惊愣瞪瞥抿怔顿疑奇喜悲哭来去出到开起下上着了的，。！？；：、\s“”「」『』‘’]/;
const ROLE_PREFIX = /^(?:男人|女人|老者|少年|少女|青年|孩子|姑娘|公子|小姐|先生|夫人|道士|和尚|众人|两人|三人|那人|此人|有人|对方|自己|黑衣|白衣|中年|老人|小孩)/;
const VERB_START = /[说问答道笑看转抬握皱点摇走站坐低轻沉缓慢又便才却也则就忙连急忽突随终忍不禁正还在把被拿给让叫想听望盯叹哼怒微淡]/;
const FEMALE_CHAR = /[妍琳茵莹玲蝶岚云菲丽婉婷娜薇蓉芸欣怡瑶琪雪月梅兰菊莲荷蕊琴燕霞霜媚娇媛妮芬芳莉晴雯静淑慧敏佳嘉]/;
const MALE_CHAR = /[德光北阳刚强虎龙雷豺狼牙断撼藏天杀魔帝皇伯叔爷峰山石军武豪杰雄锋猛彪鹏振宇浩翔辉]/;
const TONE_RULES = [
  [/(?:冷笑|冷冷|冷漠|冷然|阴冷|森然|淡淡)/, '语气冷淡'],
  [/(?:笑|嬉|嘻|乐)/, '带笑意'],
  [/(?:怒|厉声|大喝|咆哮|吼)/, '语气严厉'],
  [/(?:叹|唉)/, '带着叹息'],
  [/(?:低声|小声|低语|嘀咕|喃喃)/, '压低声音'],
  [/(?:柔声|温柔|娇|轻声细语)/, '声音柔和'],
  [/(?:沉声|沉着脸|低沉|低吼)/, '声音低沉'],
  [/(?:急|慌|忙|连忙|赶紧)/, '语气急促'],
  [/(?:颤|哆嗦|发抖)/, '声音发颤'],
  [/(?:咬牙|恶狠狠|恨恨)/, '咬牙切齿'],
  [/(?:缓缓|慢慢|悠悠)/, '语速偏慢'],
  [/(?:小心|谨慎|翼翼)/, '语气谨慎'],
  [/(?:没好气|不耐烦|烦躁)/, '略带不耐烦'],
  [/(?:大声|高声|嚷嚷?)/, '声音响亮'],
  [/(?:沙哑|嘶哑)/, '声音沙哑'],
  [/(?:得意|骄傲|傲然)/, '语气带几分得意'],
  [/(?:无奈|苦笑)/, '略带无奈'],
  [/(?:娇嗔|嗔)/, '带点娇嗔'],
  [/(?:哼)/, '语气带几分不屑'],
];

function isPlausibleName(n) {
  if (!n || n.length < 2 || n.length > 4) return false;
  if (NAME_STOP.has(n)) return false;
  if (/(?:美男|美女|帅哥)$/.test(n)) return false;
  if (NAME_BAD_END.test(n[n.length - 1])) return false;
  if (/[0-9a-zA-Z，。！？；：、\s]/.test(n)) return false;
  return true;
}

function escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mineNames(text, cap = 60) {
  const c2 = new Map(), c3 = new Map(), c4 = new Map();
  const bump = (map, k) => {
    if (k.length < 2) return;
    map.set(k, (map.get(k) || 0) + 1);
  };
  const feed = (src) => {
    const re = new RegExp(src, 'g');
    let m, guard = 0;
    while ((m = re.exec(text)) && guard++ < 200000) {
      const before = text.slice(Math.max(0, m.index - 40), m.index);
      const tail = before.split(/[。！？；\n”」』]/).pop() || '';
      let piece = (tail.split(/[，、：:]/).pop() || '').trim().replace(/^[“”「」『』\s]+/, '');
      piece = piece.replace(LEAD_TIME, '');
      if (piece.length < 2) continue;
      bump(c2, piece.slice(0, 2));
      bump(c3, piece.slice(0, 3));
      bump(c4, piece.slice(0, 4));
    }
  };
  feed(SPEECH_SRC);
  feed(ACTION_SRC);

  const ext3 = new Map(), ext4 = new Map();
  for (const [k, v] of c3) {
    if (v < 3) continue;
    const p = k.slice(0, 2);
    const arr = ext3.get(p) || [];
    arr.push({ name: k, count: v });
    ext3.set(p, arr);
  }
  for (const [k, v] of c4) {
    if (v < 3) continue;
    const p = k.slice(0, 3);
    const arr = ext4.get(p) || [];
    arr.push({ name: k, count: v });
    ext4.set(p, arr);
  }
  const pick = (arr, base) => {
    let best = null;
    for (const e of arr || []) {
      if (e.count < Math.max(4, base * 0.5)) continue;
      if (NAME_BAD_NEXT.test(e.name[e.name.length - 1])) continue;
      if (!best || e.count > best.count) best = e;
    }
    return best;
  };

  const out = new Map();
  for (const [n, c] of c2) {
    if (c < 3) continue;
    if (NAME_BAD_START.test(n) || NAME_BAD_END.test(n[1]) || NAME_STOP.has(n)) continue;
    let chosen = { name: n, count: c };
    const e3 = pick(ext3.get(n), c);
    if (e3) {
      chosen = e3;
      const e4 = pick(ext4.get(e3.name), e3.count);
      if (e4) chosen = e4;
    }
    out.set(chosen.name, Math.max(out.get(chosen.name) || 0, chosen.count));
  }
  return [...out.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, cap)
    .map(([name, count]) => ({ name, count }));
}

const G_AP_F = /^(?:姑娘|小姐|丫头|师姐|师妹|美女|女子|少女|女人|夫人|公主|姐姐|妹妹|女侠|圣女|女王|女帝|妇人|寡妇|婆娘|姐)/;
const G_AP_M = /^(?:公子|少爷|师兄|师弟|先生|男子|少年|男人|老者|老头|大汉|汉子|王子|陛下|大叔|大伯|老伯|爷爷|兄(?![弟妹])|哥|弟)/;
const G_BEFORE_F = /(?:少女|女子|美女|姑娘|小姐|丫头|夫人|养女|女儿|姐姐|妹妹|师姐|师妹)$/;
const G_BEFORE_M = /(?:少年|男子|公子|少爷|先生|老者|老头|大汉|汉子|师兄|师弟|大哥|老兄|小弟|父亲|养子|儿子)$/;

function countKnownNames(sent, nameSet) {
  const list = [...nameSet].filter(n => n.length >= 2).sort((a, b) => b.length - a.length);
  const used = new Array(sent.length).fill(false);
  let c = 0;
  for (const n of list) {
    let p = -1;
    while ((p = sent.indexOf(n, p + 1)) >= 0) {
      let free = true;
      for (let j = p; j < p + n.length; j++) if (used[j]) { free = false; break; }
      if (!free) continue;
      for (let j = p; j < p + n.length; j++) used[j] = true;
      c++;
    }
  }
  return c;
}

function inferGender(text, name, nameSet) {
  let f = 0, m = 0, sf = 0, sm = 0;
  const re = new RegExp(escRe(name), 'g');
  let mm, guard = 0;
  const seen = new Set();
  while ((mm = re.exec(text)) && guard++ < 800) {
    const i = mm.index, L = name.length;
    const before = text.slice(Math.max(0, i - 14), i);
    const after = text.slice(i + L, Math.min(text.length, i + L + 20));
    let ss = 0, se = text.length;
    for (const ch of ['。', '！', '？', '\n']) {
      const p1 = text.lastIndexOf(ch, i - 1);
      if (p1 + 1 > ss) ss = p1 + 1;
      const p2 = text.indexOf(ch, i + L);
      if (p2 >= 0 && p2 + 1 < se) se = p2 + 1;
    }
    const sent = text.slice(ss, se);

    if (G_AP_F.test(after)) { f += 4; sf += 4; }
    if (G_AP_M.test(after)) { m += 4; sm += 4; }
    if (G_BEFORE_F.test(before)) { f += 4; sf += 4; }
    if (G_BEFORE_M.test(before)) { m += 4; sm += 4; }
    if (/^的(?:女|男)/.test(after)) {
      if (/^的女子|^的女人|^的女孩/.test(after)) { f += 4; sf += 4; }
      else { m += 4; sm += 4; }
    }
    if (/(?:女的|女子|少女)叫$/.test(before)) { f += 4; sf += 4; }
    if (/(?:男的|男子|少年)叫$/.test(before)) { m += 4; sm += 4; }
    const dm = sent.slice(Math.max(0, i - ss), i - ss + L + 14).match(/[是乃](?:个|一个)?([女男])/);
    if (dm) { if (dm[1] === '女') { f += 4; sf += 4; } else { m += 4; sm += 4; } }
    if (/^[，,][\s]*她是我(?:妹妹|姐姐|女儿)/.test(after)) { m += 4; sm += 4; }
    if (/^[，,][\s]*他是我(?:哥哥|弟弟|儿子)/.test(after)) { f += 4; sf += 4; }

    const tail = sent.slice(i - ss + L);
    const dz = tail.match(/(?:这|那)(?:死|臭|小|笨|野|个)?(丫头|女人|姑娘|美女|婆娘|小子|家伙|男人|少年|汉子)/);
    if (dz) {
      if (/丫头|女人|姑娘|美女|婆娘/.test(dz[1])) f += 2;
      else m += 2;
    }

    if (!seen.has(ss)) {
      seen.add(ss);
      const narr = sent.replace(/[“「][^”」]*[”」]/g, '');
      if (countKnownNames(narr, nameSet) <= 1) {
        const nr = narr.indexOf(name);
        if (nr >= 0) {
          const pr = narr.slice(nr + L).match(/[他她]/g) || [];
          const she = pr.filter(x => x === '她').length, he = pr.length - she;
          if (she > he) f += 1;
          else if (he > she) m += 1;
        }
      }
    }

    const sv = after.match(/^(?:[^，。！？；\n]{0,6}?(?:说道|问道|答道|笑道|怒道|叹道|喊道|叫道|说|问|答|喊|叫|道))/);
    if (sv) {
      const rest = text.slice(i + L + sv[0].length, i + L + sv[0].length + 30);
      const nx = rest.match(/^[。！？；，、\s”」』]{0,3}([他她])/);
      if (nx) {
        const q = rest.indexOf('。');
        const nSent = rest.slice(0, q >= 0 ? q + 1 : 20).replace(/[“「][^”」]*[”」]/g, '');
        if (countKnownNames(nSent, nameSet) === 0) {
          if (nx[1] === '她') f += 1;
          else m += 1;
        }
      }
    }
  }
  if (/公主|女王|女帝|夫人|小姐|姑娘|姐姐|妹妹|婆娘|寡妇|圣女|巫女/.test(name)) { f += 6; sf += 6; }
  if (/公子|少爷|王子|陛下|先生|老伯|大叔|皇帝/.test(name)) { m += 6; sm += 6; }
  if (FEMALE_CHAR.test(name)) f += 1;
  if (MALE_CHAR.test(name)) m += 1;
  if (sf && !sm) return 'F';
  if (sm && !sf) return 'M';
  if (sf && sm) {
    if (sf - sm >= 6) return 'F';
    if (sm - sf >= 6) return 'M';
    if (f - m >= 5) return 'F';
    if (m - f >= 5) return 'M';
    return '?';
  }
  if (f + m >= 4 && f - m >= 4) return 'F';
  if (f + m >= 4 && m - f >= 4) return 'M';
  return '?';
}

function inferTone(text, name) {
  const counts = TONE_RULES.map(() => 0);
  const re = new RegExp(escRe(name), 'g');
  const svRe = new RegExp('^([^，。！？；\\n”]{0,14}?)(?:' + SPEECH_SRC + ')');
  let mm, guard = 0;
  while ((mm = re.exec(text)) && guard++ < 800) {
    const after = text.slice(mm.index + name.length, Math.min(text.length, mm.index + name.length + 22));
    const cut = after.search(/[。！？；\n”]/);
    const seg = cut >= 0 ? after.slice(0, cut) : after;
    const sm = seg.match(svRe);
    if (!sm) continue;
    const mod = sm[1];
    TONE_RULES.forEach(([r], i) => { if (r.test(mod)) counts[i]++; });
  }
  const top = counts.map((c, i) => ({ c, i })).filter(x => x.c >= 2).sort((a, b) => b.c - a.c).slice(0, 2);
  const picked = top.map(x => TONE_RULES[x.i][1]);
  if (picked.length === 2) {
    const opposite = [['冷淡', '笑意'], ['冷淡', '柔和'], ['冷淡', '娇嗔'], ['严厉', '柔和'], ['严厉', '娇嗔'], ['响亮', '压低'], ['低沉', '响亮']];
    if (opposite.some(([a, b]) => (picked[0].includes(a) && picked[1].includes(b)) || (picked[0].includes(b) && picked[1].includes(a)))) picked.pop();
  }
  return picked.join('、');
}

function findProtagonist(text, names) {
  const chap = text.slice(0, 8000).search(/第[一二三四五六七八九十百零\d]+[章回节]/);
  const introEnd = chap >= 0 ? Math.min(4000, chap) : 2500;
  const intro = text.slice(0, introEnd);
  const bodyCount = (n) => text.split(n).length - 1;
  const embedded = (c) => {
    const re = new RegExp('([\\u4e00-\\u9fa5])' + escRe(c), 'g');
    let m, n = 0;
    while ((m = re.exec(text))) n++;
    return n >= bodyCount(c);
  };
  const scores = new Map();
  const add = (raw, w) => {
    let c = raw.replace(/^[的地得和与在从把被将是了上下里中去来对给让并且而但却就也才的都这那一个我你他她它们]+/, '');
    if (c.length < 2 || c.length > 3) return;
    if (NAME_STOP.has(c) || NAME_BAD_START.test(c) || NAME_BAD_END.test(c[c.length - 1])) return;
    if (bodyCount(c) < 3 || embedded(c)) return;
    scores.set(c, (scores.get(c) || 0) + w);
  };
  const re = /([\u4e00-\u9fa5]{2,3})(?=带着|是一名|是一个|是个|的[“「]|的魔|的传|的故|与|和|将|把|从|在)/g;
  let m;
  while ((m = re.exec(intro))) add(m[1], 10);
  for (const n of names) if (intro.includes(n.name)) add(n.name, 3);
  let best = null;
  for (const [n, s] of scores) {
    const score = s * 10 + Math.min(bodyCount(n), 80);
    if (!best || score > best.score) best = { name: n, score };
  }
  return best ? best.name : null;
}

function defaultTone(gender) {
  return gender === 'F' ? '声音柔和' : gender === 'M' ? '声音沉稳' : '平稳自然';
}

const TAG_RULES = [
  [/(磁性)/, '磁性'],
  [/(醇厚|浑厚)/, '醇厚'],
  [/(清亮|清脆|清朗|明亮)/, '清亮'],
  [/(空灵)/, '空灵'],
  [/(稚嫩|童声|奶声|孩子气)/, '稚嫩'],
  [/(苍老|沧桑|年迈|老人|老年|暮年)/, '苍老'],
  [/(甜美|甜腻|软糯)/, '甜美'],
  [/(沙哑|嘶哑|烟嗓)/, '沙哑'],
  [/(醇雅|优雅)/, '醇雅'],
  [/(御姐)/, '御姐音'],
  [/(正太)/, '正太音'],
  [/(大叔)/, '大叔音'],
  [/(夹子音)/, '夹子音'],
  [/(台湾腔|台湾国语)/, '台湾腔'],
  [/(东北话|东北腔)/, '东北话'],
  [/(四川话|川渝)/, '四川话'],
  [/(河南话)/, '河南话'],
  [/(粤语|广东话)/, '粤语'],
  [/(温柔|温和|柔和)/, '温柔'],
  [/(高冷|冰冷|冷硬|冷淡)/, '高冷'],
  [/(活泼|开朗|欢快)/, '活泼'],
  [/(严肃|严厉|威严)/, '严肃'],
  [/(慵懒|懒散)/, '慵懒'],
  [/(俏皮|调皮)/, '俏皮'],
  [/(深沉|低沉|沉厚|沉稳)/, '低沉'],
  [/(干练|利落)/, '干练'],
  [/(凌厉|锋利|咄咄逼人)/, '凌厉'],
  [/(语速(?:较|偏)?快|语速加快|急促|连珠炮)/, '语速较快'],
  [/(语速(?:较|偏)?慢|语速缓慢|缓慢|慢条斯理)/, '语速缓慢'],
  [/(语速适中|语速平稳)/, '语速适中'],
  [/(愤怒|暴怒|发怒)/, '愤怒'],
  [/(悲伤|悲痛|哀伤)/, '悲伤'],
  [/(冷漠|淡漠)/, '冷漠'],
  [/(惊恐|恐惧|害怕)/, '恐惧'],
  [/(得意|嚣张)/, '得意'],
  [/(平稳自然|平稳)/, '平稳'],
];

const KNOWN_TAGS = new Set(TAG_RULES.map(r => r[1]));

function cleanTagList(v) {
  if (Array.isArray(v)) v = v.join(' ');
  const raw = String(v || '').replace(/[()（）\[\]【】,，、;；]/g, ' ').trim();
  if (!raw) return '';
  const tokens = raw.split(/\s+/);
  const out = [];
  for (const token of tokens) {
    if (!token) continue;
    if (KNOWN_TAGS.has(token)) {
      if (!out.includes(token)) out.push(token);
    } else {
      const derived = deriveTags(token);
      if (derived.length) {
        for (const t of derived) if (!out.includes(t)) out.push(t);
      } else if (token.length <= 6) {
        if (!out.includes(token)) out.push(token);
      }
    }
    if (out.length >= 6) break;
  }
  return out.slice(0, 6).join(' ');
}

function deriveTags(...parts) {
  const text = parts.filter(Boolean).join(' ');
  const out = [];
  for (const [re, tag] of TAG_RULES) {
    if (re.test(text) && !out.includes(tag)) out.push(tag);
    if (out.length >= 6) break;
  }
  return out;
}

function entryTags(entry) {
  if (!entry) return '';
  return cleanTagList(entry.tags) || deriveTags(entry.voiceDesc, entry.style).join(' ');
}

function stageTags(stage, entry) {
  if (!stage) return entryTags(entry);
  return cleanTagList(stage.tags) || deriveTags(stage.desc, stage.style || entry?.style, stage.label).join(' ');
}

function speechCard(entry, stage) {
  if (!entry && !stage) return '';
  const desc = String(stage?.desc || entry?.voiceDesc || '').trim();
  const style = String(stage?.style || entry?.style || '').trim();
  if (!desc) return style.slice(0, 160);
  if (!style || desc.includes(style)) return desc.slice(0, 160);
  return (desc + '。' + style).slice(0, 160);
}

function analyzeBook(text) {
  const names = mineNames(text);
  const nameSet = new Set(names.map(n => n.name));
  for (const n of names) {
    n.gender = inferGender(text, n.name, nameSet);
    n.tone = inferTone(text, n.name);
  }
  const narration = text.replace(/[“「][^”」\n]{0,400}[”」]/g, '');
  const per1000 = (narration.match(/我/g) || []).length / Math.max(1, narration.length / 1000);
  const firstPerson = per1000 >= 8;
  let protagonist = null;
  if (firstPerson) {
    protagonist = findProtagonist(text, names) || '我';
    let e = protagonist === '我' ? null : names.find(n => n.name === protagonist);
    if (!e && protagonist !== '我') {
      const cnt = text.split(protagonist).length - 1;
      nameSet.add(protagonist);
      e = { name: protagonist, count: Math.max(2, Math.min(9999, cnt)), gender: inferGender(text, protagonist, nameSet), tone: '' };
      names.unshift(e);
    }
    if (e) {
      if (protagonist !== '我') {
        const selfTone = inferTone(text, '我');
        if (selfTone) e.tone = selfTone;
      }
      if (!e.tone) e.tone = defaultTone(e.gender);
    }
  }
  for (const n of names) if (!n.tone) n.tone = defaultTone(n.gender);
  return { names, firstPerson, protagonist, per1000 };
}

function subjectFromClause(clause, known) {
  let s = clause.trim().replace(/^[\s，。；：、！？“”「」『』]+/, '');
  if (!s) return null;
  s = s.replace(LEAD_TIME, '');
  if (!s) return null;

  if (known) {
    for (let len = Math.min(5, s.length); len >= 2; len--) {
      const c = s.slice(0, len);
      if (known.has(c)) return c;
    }
  }
  if (/^[他她它我你您]/u.test(s)) return null;
  if (VERB_START.test(s[0])) return null;

  const f4 = s.slice(0, 4);
  const f3 = s.slice(0, 3);
  const f2 = s.slice(0, 2);
  let cand = f3;
  if (f3.length === 3 && VERB_START.test(f3[2])) cand = f2;
  if (!isPlausibleName(cand)) cand = f2;
  if (!isPlausibleName(cand)) return null;
  if (ROLE_PREFIX.test(cand)) return null;
  return cand;
}

function nameAtStart(s, known) {
  if (!s) return null;
  if (/^[我咱]/.test(s)) return null;
  for (let len = Math.min(4, s.length); len >= 2; len--) {
    const c = s.slice(0, len);
    if (known.has(c)) return c;
  }
  return null;
}

function detectSpeaker(p, q, last, known) {
  const before = p.slice(Math.max(0, q.start - 90), q.start);
  const afterRaw = p.slice(q.end, Math.min(p.length, q.end + 48));
  const after = afterRaw.replace(/^[\s，。；：、！？…—·”」』）)】]+/, '');

  const named = nameAtStart(after, known);
  if (named) return named;
  if (/^[我咱]/.test(after) && /^[^，。！？；\n]{0,10}?(?:说道|问道|答道|笑道|怒道|叹道|喊道|叫道|接口|接道|应道|说|问|答|喊|叫|道)[，。！？\s]/.test(after)) return '我';
  if (/^[我咱]/.test(after) && !/^[我咱][^。！？\n]{0,8}(?:看|望|听|想|心|愣|怔|皱|叹|摇头|点头|转身|站|坐|走|退|吃|喝|拿|放|低|抬|转)/.test(after)) return '我';

  const b = speakerFromContext(before, known, true);
  if (b) return b;
  const a = speakerFromContext(afterRaw, known, false);
  if (a) return a;
  return last || null;
}

function speakerFromContext(ctx, known, isBefore) {
  if (isBefore) {
    const colon = ctx.match(/([^。！？；\n，、]{1,14})[：:]\s*$/);
    if (colon) {
      const n = subjectFromClause(colon[1], known);
      if (n) return n;
    }
  } else {
    const t = ctx.trim();
    if (ROLE_PREFIX.test(t) || /^(?:一|那)[^，。！？]{0,6}(?:声音|女声|男声|童声|嗓音)/.test(t)) return '未知角色';
  }
  const re = new RegExp(VERB_SRC, 'g');
  let m, hit = null;
  while ((m = re.exec(ctx))) {
    hit = m;
    if (!isBefore) break;
  }
  if (!hit) return null;

  const prefix = ctx.slice(0, hit.index);
  const parts = prefix.split(/[。！？；\n”」』，、：:]/).map(x => x.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^[我咱]/.test(parts[i])) return '我';
    const n = subjectFromClause(parts[i], known);
    if (n) return n;
  }
  return null;
}

function sanitize(t) {
  return t
    .replace(/[\u200b\ufeff]/g, '')
    .replace(/[“”"「」『』]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s、，。；：！？…—\-·]+/, '')
    .trim();
}

function trimSpeechTail(s) {
  const V = '(?:冷笑道|苦笑道|淡淡道|轻声道|沉声道|反问道|解释道|补充道|说道|问道|答道|笑道|怒道|叹道|喊道|叫道|嚷道|哼道|嗔道|接口|接道|续道|应道|回答|开口|嘟囔|嘀咕|低语|[的地]道)';
  let t = s.replace(new RegExp(`^[^，。！？；\\n]{0,10}${V}[，,]\\s*`), '');
  t = t.replace(new RegExp(`[，,]\\s*[^，。！？；]{0,8}${V}\\s*[：:]\\s*$`), '');
  if (new RegExp(`^[^，。！？；]{0,12}${V}\\s*[：:]\\s*$`).test(t)) t = '';
  return t;
}

function splitLong(text, max) {
  if (text.length <= max) return [text];
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = -1;
    for (let i = Math.min(max, rest.length - 1); i >= max * 0.5; i--) {
      if (/[。！？；…]/.test(rest[i])) { cut = i + 1; break; }
    }
    if (cut < 0) {
      for (let i = Math.min(max, rest.length - 1); i >= max * 0.5; i--) {
        if (/[，、：]/.test(rest[i])) { cut = i + 1; break; }
      }
    }
    if (cut < 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/* ---------------- 全局状态 ---------------- */
let book = null;
let chapterIdx = 0;
let chapterSegments = [];
let currentSeg = -1;
let chapterToken = 0;
let playing = false;
let currentView = 'shelf';
const audioEl = new Audio();
audioEl.preload = 'auto';
const urlCache = new Map();
const inflight = new Map();
const PREFETCH_AHEAD = 4;
let aheadGen = 0;
let previewAudio = null;
let wakeLock = null;
let exporting = false;
let exportAbort = false;

function canonical(name) {
  let n = name;
  if (!book || !book.aliases) return n;
  for (let i = 0; i < 5; i++) {
    const next = book.aliases[n];
    if (!next || next === n) break;
    n = next;
  }
  return n;
}

function buildSegments(text) {
  const known = new Set(book.detected ? book.detected.map(d => d.name) : []);
  for (const k of Object.keys(book.cast || {})) known.add(k);
  if (book.firstPerson && book.protagonist) known.add(book.protagonist);
  known.delete('旁白'); known.delete('未知角色');
  const paras = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const segs = [];
  let last = null, lastPara = -9;
  const push = (speaker, raw) => {
    const t = sanitize(raw);
    if (!t) return;
    for (const piece of splitLong(t, 240)) segs.push({ speaker: canonical(speaker), text: piece });
  };
  for (let pi = 0; pi < paras.length; pi++) {
    const p = paras[pi];
    const quotes = findQuotes(p);
    if (!quotes.length) { push('旁白', p); continue; }
    let cursor = 0;
    for (const q of quotes) {
      if (q.start > cursor) {
        const nar = p.slice(cursor, q.start);
        if (nar.trim()) push('旁白', trimSpeechTail(nar));
      }
      const sp = detectSpeaker(p, q, (pi - lastPara <= 1 ? last : null), known);
      if (sp) { last = sp; lastPara = pi; }
      push(sp || '未知角色', q.text);
      cursor = q.end;
    }
    if (cursor < p.length) {
      const tail = trimSpeechTail(p.slice(cursor));
      if (tail.trim()) push('旁白', tail);
    }
  }
  return segs;
}

function defaultCast(b) {
  const cast = { '旁白': { voice: '冰糖', style: NARRATOR_STYLE, gender: '?' } };
  let fi = 0, mi = 0, ui = 0;
  for (const d of b.detected || []) {
    if (d.count < 2) continue;
    const g = d.gender || '?';
    let voice;
    if (g === 'F') voice = ['茉莉', '冰糖'][fi++ % 2];
    else if (g === 'M') voice = ['苏打', '白桦'][mi++ % 2];
    else voice = ['冰糖', '苏打'][ui++ % 2];
    cast[d.name] = { voice, style: d.tone || '', gender: g };
  }
  if (b.firstPerson && b.protagonist) {
    const p = cast[b.protagonist] || (b.protagonist === '我' ? cast['旁白'] : null);
    if (p && p !== cast['旁白']) cast['旁白'].voice = p.voice;
    else cast['旁白'].voice = '苏打';
  }
  return cast;
}


function castEntryFor(name) {
  book.cast = book.cast || {};
  let e = book.cast[name];
  if (e) return e;
  if (name === '旁白') {
    e = { voice: '冰糖', style: NARRATOR_STYLE, gender: '?' };
    book.cast[name] = e;
    return e;
  }
  const list = book.detected || [];
  const d = list.find((x) => x.name === name) || list.find((x) => canonical(x.name) === name);
  const g = d?.gender || '?';
  e = { voice: g === 'F' ? '茉莉' : g === 'M' ? '苏打' : '冰糖', style: d?.tone || '', gender: g };
  book.cast[name] = e;
  return e;
}
function ensureCastEntries() {
  if (!book) return 0;
  let n = 0;
  for (const [name] of castList()) {
    if (!book.cast[name]) { castEntryFor(name); n++; }
  }
  return n;
}
function castStageFor(name, chapter) {
  const e = (book && book.cast || {})[name];
  if (!e) return { entry: null, stage: null };
  if (!e.stages || e.stages.length < 2) return { entry: e, stage: null };
  let st = null;
  for (const s of e.stages) {
    if (chapter >= s.from) st = s;
  }
  if (!st) st = e.stages[0];
  return { entry: Object.assign({}, e, st), stage: st };
}
function castEntryAt(name, chapter) {
  return castStageFor(name, chapter).entry;
}

function saveProgress() {
  if (!book) return;
  try {
    localStorage.setItem('tts.progress.' + book.id, JSON.stringify({ chapter: chapterIdx, segment: Math.max(0, currentSeg) }));
  } catch {}
}
function loadProgress(id) {
  try { return JSON.parse(localStorage.getItem('tts.progress.' + id) || 'null'); }
  catch { return null; }
}

let bookSaveTimer = 0;
function saveBookSoon() {
  clearTimeout(bookSaveTimer);
  bookSaveTimer = setTimeout(() => { idb.put('books', book).catch(() => {}); }, 500);
}

/* ---------------- 合成 ---------------- */
const TTS_CACHE_VER = 5;
const VOICE_DESIGN_TEXT = '你来了。夜里的风有些凉，先进屋坐坐吧，我给你倒杯热茶。';

async function requestTTS(text, voice, tags, card, signal) {
  const s = loadSettings();
  const apiKey = (s.apiKey || '').trim();
  if (!apiKey) throw new Error('请先在设置里填写 API Key');
  const base = (s.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  const tagStr = cleanTagList(tags);
  const cardText = String(card || '').trim().slice(0, 200);
  const messages = [];
  if (cardText) messages.push({ role: 'user', content: cardText });
  messages.push({ role: 'assistant', content: (tagStr ? `（${tagStr.replace(/\s+/g, '，')}）` : '') + text });

  const body = JSON.stringify({
    model: 'mimo-v2.5-tts',
    messages,
    audio: { format: 'mp3', voice: voice || '冰糖' },
  });
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
        body,
        signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastErr = e; continue;
    }
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); msg = j?.error?.message || msg; } catch {}
      if (res.status === 429 || res.status >= 500) { lastErr = new Error(msg); await new Promise(r => setTimeout(r, 1200)); continue; }
      throw new Error(msg);
    }
    const j = await res.json();
    const b64 = j?.choices?.[0]?.message?.audio?.data;
    if (!b64) throw new Error('接口没有返回音频');
    return b64ToBlob(b64, 'audio/mpeg');
  }
  throw lastErr || new Error('合成失败');
}

async function designVoice(desc, signal) {
  const s = loadSettings();
  const apiKey = (s.apiKey || '').trim();
  if (!apiKey) throw new Error('请先在设置里填写 API Key');
  const base = (s.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  const body = JSON.stringify({
    model: 'mimo-v2.5-tts-voicedesign',
    messages: [
      { role: 'user', content: String(desc || '').trim() },
      { role: 'assistant', content: VOICE_DESIGN_TEXT },
    ],
    audio: { format: 'mp3' },
  });
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
        body,
        signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastErr = e; continue;
    }
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); msg = j?.error?.message || msg; } catch {}
      if (res.status === 429 || res.status >= 500) { lastErr = new Error(msg); await new Promise(r => setTimeout(r, 1200)); continue; }
      throw new Error(msg);
    }
    const j = await res.json();
    const b64 = j?.choices?.[0]?.message?.audio?.data;
    if (!b64) throw new Error('接口没有返回音频');
    return 'data:audio/mpeg;base64,' + b64;
  }
  throw lastErr || new Error('音色生成失败');
}

const voiceDesignInflight = new Map();
const voiceDesignFailed = new Set();
let voiceDesignToastAt = 0;

async function ensureDesignSample(bookId, owner, label, holder, desc) {
  const d = String(desc || '').trim();
  if (!d) return '';
  const dref = await descRef(d);
  const refs = [];
  if (holder?.sampleRef) refs.push(holder.sampleRef);
  refs.push(dref);
  for (const ref of [...new Set(refs)]) {
    const uri = await getVoiceSample(bookId, owner, ref);
    if (uri) {
      if (holder && !holder.sampleRef) {
        holder.sampleRef = ref;
        holder.sampleDesc = d;
        saveBookSoon();
      }
      return uri;
    }
  }
  const k = voiceKey(bookId, owner, 'design') + '|' + dref;
  if (voiceDesignFailed.has(k)) return '';
  if (voiceDesignInflight.has(k)) return voiceDesignInflight.get(k);
  const p = (async () => {
    if (Date.now() - voiceDesignToastAt > 4000) {
      voiceDesignToastAt = Date.now();
      toast(`正在为「${label}」生成专属音色…`, 15000);
    }
    const uri = await designVoice(d);
    await putVoiceSample(bookId, owner, uri, d, dref);
    if (holder) {
      holder.sampleRef = dref;
      holder.sampleDesc = d;
      holder.sampleId = Date.now();
      if (holder.stages) {
        holder.voiceMode = 'design';
        holder.voiceDesc = holder.voiceDesc || d;
      }
      saveBookSoon();
    }
    return uri;
  })();
  voiceDesignInflight.set(k, p);
  try {
    return await p;
  } catch {
    voiceDesignFailed.add(k);
    toast(`「${label}」专属音色生成失败，暂时用预设音色`, 6000);
    return '';
  } finally {
    voiceDesignInflight.delete(k);
  }
}

async function getSegmentAudio(seg) {
  const b = book;
  const s = loadSettings();
  let voice = '冰糖', tags = '', card = '';
  const own = castStageFor(seg.speaker, chapterIdx);
  let entry = own.entry, stage = own.stage;
  if (seg.speaker === '旁白' && b.firstPerson && b.protagonist && b.protagonist !== '我') {
    const pr = castStageFor(b.protagonist, chapterIdx);
    if (pr.entry) {
      entry = Object.assign({}, entry, pr.entry);
      stage = pr.stage;
    }
  }
  if (!s.singleVoice) {
    voice = entry?.voice || (seg.speaker === '旁白' ? '冰糖' : '苏打');
    tags = stageTags(stage, entry);
    card = speechCard(entry, stage);
  }
  const stamp = `t:${voice}:${tags}`;
  const key = await hashKey([b.id, card, seg.text, stamp, 'v' + TTS_CACHE_VER].join('\u0000'));
  const rec = await idb.get('audio', key);
  if (rec?.blob) return rec.blob;
  const blob = await requestTTS(seg.text, voice, tags, card);
  await idb.put('audio', { key, bookId: b.id, blob, size: blob.size, createdAt: Date.now() });
  return blob;
}

function clearUrlCache() {
  aheadGen++;
  for (const v of urlCache.values()) URL.revokeObjectURL(v.url);
  urlCache.clear();
  inflight.clear();
}

async function prefetch(i) {
  if (!book || i < 0 || i >= chapterSegments.length) return;
  if (urlCache.has(i) || inflight.has(i)) return;
  const seg = chapterSegments[i];
  const token = chapterToken;
  const p = getSegmentAudio(seg).then(blob => {
    if (token !== chapterToken) return null;
    const url = URL.createObjectURL(blob);
    urlCache.set(i, { url, blob });
    return url;
  }).catch(() => null).finally(() => inflight.delete(i));
  inflight.set(i, p);
  return p;
}

function prefetchAhead(i) {
  const gen = ++aheadGen;
  (async () => {
    for (let k = 1; k <= PREFETCH_AHEAD; k += 2) {
      if (gen !== aheadGen || !book) return;
      await Promise.all([prefetch(i + k), prefetch(i + k + 1)]);
    }
  })();
}

/* ---------------- 播放 ---------------- */
let playToken = 0;

function setCurrent(i) {
  currentSeg = i;
  renderSegHighlight();
  updatePlayerBar();
  saveProgress();
  updateMediaSession();
}

async function playIndex(i) {
  if (!book) return;
  if (i < 0) i = 0;
  if (i >= chapterSegments.length) { toast('本章已播完'); stopPlayback(); return; }
  const token = ++playToken;
  setCurrent(i);
  $('btnPlay').innerHTML = '<span class="spin"></span>';
  try {
    if (!urlCache.has(i) && !inflight.has(i)) prefetch(i);
    const url = await (inflight.has(i) ? inflight.get(i) : Promise.resolve(null));
    if (token !== playToken) return;
    let finalUrl = url || urlCache.get(i)?.url;
    if (!finalUrl) {
      const blob = await getSegmentAudio(chapterSegments[i]);
      if (token !== playToken) return;
      finalUrl = URL.createObjectURL(blob);
      urlCache.set(i, { url: finalUrl, blob });
    }
    audioEl.src = finalUrl;
    await audioEl.play();
    playing = true;
    prefetchAhead(i);
    requestWakeLock();
  } catch (e) {
    if (e.name === 'AbortError') return;
    if (token !== playToken) return;
    toast('合成失败：' + (e.message || e));
    playing = false;
  } finally {
    if (token === playToken) updatePlayBtn();
  }
}

function updatePlayBtn() {
  $('btnPlay').textContent = playing ? '⏸' : '▶';
}

function stopPlayback() {
  playing = false;
  try { audioEl.pause(); } catch {}
  updatePlayBtn();
  releaseWakeLock();
}

function togglePlay() {
  if (!book) { toast('先选一本书'); return; }
  if (playing) {
    audioEl.pause();
    playing = false;
    updatePlayBtn();
    releaseWakeLock();
    return;
  }
  if (audioEl.src && audioEl.currentTime > 0 && audioEl.currentTime < audioEl.duration - 0.05) {
    audioEl.play().then(() => { playing = true; updatePlayBtn(); requestWakeLock(); }).catch(() => {});
  } else {
    playIndex(currentSeg < 0 ? 0 : currentSeg);
  }
}

audioEl.addEventListener('ended', () => {
  if (currentSeg + 1 < chapterSegments.length) {
    prefetch(currentSeg + 1);
    playIndex(currentSeg + 1);
  } else if (chapterIdx + 1 < book.chapters.length) {
    toast('下一章');
    openChapter(chapterIdx + 1, false);
    playIndex(0);
  } else {
    playing = false;
    updatePlayBtn();
    releaseWakeLock();
    toast('全书已播完');
  }
});
audioEl.addEventListener('play', () => { playing = true; updatePlayBtn(); });
audioEl.addEventListener('pause', () => { playing = false; updatePlayBtn(); });
audioEl.addEventListener('error', () => { if (audioEl.src) { toast('音频播放出错'); playing = false; updatePlayBtn(); } });

function updateMediaSession() {
  if (!('mediaSession' in navigator) || !book) return;
  const seg = chapterSegments[currentSeg];
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: seg ? seg.speaker : book.title,
      artist: book.title,
      album: book.chapters[chapterIdx]?.title || '',
    });
    navigator.mediaSession.setActionHandler('play', () => togglePlay());
    navigator.mediaSession.setActionHandler('pause', () => togglePlay());
    navigator.mediaSession.setActionHandler('previoustrack', () => playIndex(currentSeg - 1));
    navigator.mediaSession.setActionHandler('nexttrack', () => playIndex(currentSeg + 1));
    navigator.mediaSession.setActionHandler('seekbackward', () => playIndex(currentSeg - 1));
    navigator.mediaSession.setActionHandler('seekforward', () => playIndex(currentSeg + 1));
  } catch {}
}

async function requestWakeLock() {
  if (!loadSettings().keepAwake || !('wakeLock' in navigator)) return;
  try {
    if (!wakeLock || wakeLock.released) wakeLock = await navigator.wakeLock.request('screen');
  } catch {}
}
function releaseWakeLock() {
  if (wakeLock) { try { wakeLock.release(); } catch {} wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && playing) requestWakeLock();
});

/* ---------------- 视图 ---------------- */
function showView(name) {
  currentView = name;
  for (const [k, el] of Object.entries({ shelf: $('view-shelf'), book: $('view-book'), player: $('view-player'), settings: $('view-settings') })) {
    el.hidden = k !== name;
  }
  document.querySelectorAll('#tabbar .tab').forEach(b => b.classList.toggle('active', b.dataset.nav === name));
  $('topTitle').textContent = name === 'settings' ? '设置' : (book && name !== 'shelf' ? book.title : 'TXT 听书');
  window.scrollTo(0, 0);
}

/* ---------------- 书架 ---------------- */
async function renderShelf() {
  const books = await idb.all('books');
  books.sort((a, b) => b.createdAt - a.createdAt);
  const list = $('bookList');
  list.innerHTML = '';
  $('shelfEmpty').hidden = books.length > 0;
  for (const b of books) {
    const p = loadProgress(b.id) || { chapter: 0, segment: 0 };
    const pct = Math.min(99, Math.round((p.chapter + (p.segment ? 0.5 : 0)) / b.chapters.length * 100));
    const item = document.createElement('div');
    item.className = 'book-item';
    item.innerHTML = `
      <div class="book-cover">书</div>
      <div class="book-info">
        <div class="book-name"></div>
        <div class="book-desc">${b.chapters.length} 章 · ${b.chapters.reduce((n, c) => n + c.content.length, 0).toLocaleString()} 字 · 已听 ${pct}%</div>
        <div class="book-progress"><i style="width:${pct}%"></i></div>
      </div>
      <button class="book-del" title="删除">✕</button>`;
    item.querySelector('.book-name').textContent = b.title;
    item.addEventListener('click', (e) => {
      if (e.target.closest('.book-del')) return;
      openBook(b.id);
    });
    item.querySelector('.book-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`删除《${b.title}》和它的全部音频缓存？`)) return;
      await deleteAudioOfBook(b.id);
      await deleteVoicesOfBook(b.id);
      await idb.del('books', b.id);
      localStorage.removeItem('tts.progress.' + b.id);
      renderShelf();
      toast('已删除');
    });
    list.appendChild(item);
  }
}

/* ---------------- 本书 ---------------- */
async function openBook(id) {
  const b = await idb.get('books', id);
  if (!b) { toast('书不见了'); return; }
  if (!b.cast) b.cast = defaultCast(b);
  if (!b.aliases) b.aliases = {};
  book = b;
  let fixed = false;
  for (const d of b.detected || []) {
    const e = b.cast[d.name];
    if (!e) continue;
    if ((!e.gender || e.gender === '?') && d.gender) { e.gender = d.gender; fixed = true; }
    if (syncVoiceToGender(e)) fixed = true;
  }
  if (ensureCastEntries()) fixed = true;
  for (const e of Object.values(b.cast || {})) {
    if (normalizeEntryStages(e)) fixed = true;
  }
  if (b.firstPerson && b.protagonist && b.cast[b.protagonist] && b.cast['旁白']) {
    const nv = b.cast[b.protagonist].voice;
    if (b.cast['旁白'].voice !== nv) { b.cast['旁白'].voice = nv; fixed = true; }
  }
  if (fixed) idb.put('books', b).catch(() => {});
  const p = loadProgress(b.id) || { chapter: 0, segment: 0 };
  chapterIdx = Math.min(p.chapter || 0, b.chapters.length - 1);
  chapterSegments = buildSegments(b.chapters[chapterIdx].content);
  currentSeg = -1;
  playing = false;
  audioEl.pause();
  audioEl.removeAttribute('src');
  clearUrlCache();
  renderBookHeader();
  renderChapters();
  renderCast();
  renderPlayer();
  updatePlayerBar();
  showView('book');
  aiNudgeCheck();
  $('playerBar').hidden = false;
  document.body.classList.add('has-player');
}

function renderBookHeader() {
  const meta = $('bookMeta');
  meta.innerHTML = '<h1></h1><p></p>';
  meta.querySelector('h1').textContent = book.title;
  meta.querySelector('p').textContent = `${book.chapters.length} 章 · 共 ${book.chapters.reduce((n, c) => n + c.content.length, 0).toLocaleString()} 字`;
}

function renderChapters() {
  const panel = $('chaptersPanel');
  panel.innerHTML = '';
  book.chapters.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'chapter-item' + (i === chapterIdx ? ' playing' : '');
    row.innerHTML = `<span class="chapter-no">${i + 1}</span><span class="chapter-name"></span><span class="chapter-len">${c.content.length}字</span>`;
    row.querySelector('.chapter-name').textContent = c.title;
    row.addEventListener('click', () => openChapter(i, true));
    panel.appendChild(row);
  });
}

function openChapter(i, goPlayer) {
  chapterIdx = i;
  chapterToken++;
  clearUrlCache();
  stopPlayback();
  audioEl.removeAttribute('src');
  chapterSegments = buildSegments(book.chapters[i].content);
  currentSeg = -1;
  saveProgress();
  renderChapters();
  renderPlayer();
  updatePlayerBar();
  aiNudgeCheck();
  if (goPlayer && chapterSegments.length) prefetch(0);
  if (goPlayer) showView('player');
}

function castList() {
  const aiUsed = (book.ai?.analyzedTo ?? -1) >= 0;
  const visible = (e) => !!e && (e.ai === true || e.manual === true || !!e.voiceDesc || !!(e.stages && e.stages.length));
  const map = new Map();
  for (const d of book.detected || []) {
    const name = canonical(d.name);
    if (aiUsed && !visible(book.cast?.[name])) continue;
    if (!map.has(name)) map.set(name, { count: 0, raw: new Set() });
    const v = map.get(name);
    v.count += d.count;
    v.raw.add(d.name);
  }
  for (const name of Object.keys(book.cast || {})) {
    if (aiUsed && !visible(book.cast[name])) continue;
    if (!map.has(name)) map.set(name, { count: 0, raw: new Set([name]) });
  }
  map.delete('旁白');
  return [...map.entries()].sort((a, b) => b[1].count - a[1].count);
}

function voiceOptions(selected) {
  return VOICES.map(v => `<option value="${v.id}"${v.id === selected ? ' selected' : ''}>${v.label}</option>`).join('');
}
function normalizeEntryStages(e) {
  if (!e || !Array.isArray(e.stages) || e.stages.length < 2) return false;
  const out = [];
  let changed = false;
  for (const raw of e.stages) {
    if (!raw) continue;
    const st = Object.assign({}, raw);
    const prev = out[out.length - 1];
    if (prev && sameStagePeriod(prev.label, st.label)) {
      prev.to = Math.max(prev.to, st.to);
      if (!prev.desc && st.desc) prev.desc = st.desc;
      if (!prev.style && st.style) prev.style = st.style;
      if (!prev.voice && st.voice) prev.voice = st.voice;
      if (!prev.tags && st.tags) prev.tags = st.tags;
      if (!prev.sampleRef && st.sampleRef && (!st.sampleDesc || st.sampleDesc === st.desc)) {
        prev.sampleRef = st.sampleRef;
        prev.sampleDesc = st.sampleDesc;
        prev.sampleId = st.sampleId;
        if (st.desc) prev.desc = st.desc;
      }
      changed = true;
      continue;
    }
    if (out.length && st.from <= out[out.length - 1].to) changed = true;
    out.push(st);
  }
  if (out.length >= 2) {
    if (changed) e.stages = out;
    return changed;
  }
  delete e.stages;
  const st = out[0];
  if (st) {
    if (st.desc) e.voiceDesc = st.desc;
    if (st.style) e.style = st.style;
    if (st.voice) e.voice = st.voice;
    if (st.tags) e.tags = st.tags;
    else e.tags = deriveTags(st.desc, st.style, st.label).join(' ');
    if (st.sampleRef) {
      e.sampleRef = st.sampleRef;
      e.sampleDesc = st.sampleDesc;
      e.sampleId = e.sampleId || st.sampleId || Date.now();
    }
  }
  return true;
}
function retagAll() {
  let n = 0;
  const names = new Set(castList().map(([name]) => name));
  names.add('旁白');
  for (const name of names) {
    const e = book?.cast?.[name];
    if (!e) continue;
    if (e.stages && e.stages.length > 1) {
      for (const st of e.stages) {
        const t = deriveTags(st.desc, st.style || e.style, st.label).join(' ');
        if (t) { st.tags = t; n++; }
      }
    } else {
      const t = deriveTags(e.voiceDesc || (name === '旁白' ? e.style : ''), e.style).join(' ');
      if (t) { e.tags = t; n++; }
    }
  }
  saveBookSoon();
  clearUrlCache();
  renderCast();
  toast(`已重贴 ${n} 个风格标签`);
}
function syncVoiceToGender(entry) {
  if (!entry) return false;
  const g = entry.gender;
  if (g !== 'F' && g !== 'M') return false;
  const wrong = g === 'F' ? ['苏打', '白桦'] : ['茉莉', '冰糖'];
  const good = g === 'F' ? '茉莉' : '苏打';
  let fixed = false;
  if (wrong.includes(entry.voice)) { entry.voice = good; fixed = true; }
  if (Array.isArray(entry.stages)) {
    for (const st of entry.stages) {
      if (wrong.includes(st.voice)) { st.voice = good; fixed = true; }
    }
  }
  return fixed;
}

function genderLabel(g) {
  return g === 'F' ? '女' : g === 'M' ? '男' : '?';
}

function reanalyzeBook() {
  if (!book) return;
  const all = book.chapters.map(c => c.content).join('\n');
  const a = analyzeBook(all);
  if (book.protagonist && book.protagonist !== '我' && all.includes(book.protagonist)) a.protagonist = book.protagonist;
  if (a.protagonist && a.protagonist !== '我' && !a.names.some(n => n.name === a.protagonist)) {
    const nameSet = new Set(a.names.map(n => n.name));
    nameSet.add(a.protagonist);
    const gender = inferGender(all, a.protagonist, nameSet);
    a.names.unshift({
      name: a.protagonist,
      count: all.split(a.protagonist).length - 1,
      gender,
      tone: inferTone(all, '我') || defaultTone(gender),
    });
  }
  book.detected = a.names;
  book.firstPerson = a.firstPerson;
  book.protagonist = a.protagonist;
  if (a.firstPerson && a.protagonist && a.protagonist !== '我') book.aliases['我'] = a.protagonist;
  const dc = defaultCast(book);
  book.cast = book.cast || {};
  for (const [k, v] of Object.entries(dc)) {
    if (!book.cast[k]) book.cast[k] = v;
    else if (!book.cast[k].gender || book.cast[k].gender === '?') book.cast[k].gender = v.gender;
  }
  for (const d of a.names) {
    const c = book.cast[d.name];
    if (!c) continue;
    if ((d.gender === 'F' || d.gender === 'M') && (!c.gender || c.gender === '?')) c.gender = d.gender;
    syncVoiceToGender(c);
  }
  ensureCastEntries();
  if (book.firstPerson && book.cast[book.protagonist]) {
    book.cast['旁白'].voice = book.cast[book.protagonist].voice;
  }
  chapterToken++;
  stopPlayback();
  clearUrlCache();
  chapterSegments = buildSegments(book.chapters[chapterIdx].content);
  currentSeg = -1;
  saveBookSoon();
  renderCast();
  renderChapters();
  renderPlayer();
  updatePlayerBar();
  toast(`已重新分析：${a.names.length} 个角色${a.firstPerson ? ' · 第一人称' : ''}`);
}

function renderCast() {
  const panel = $('castPanel');
  const rows = castList();
  const narrator = (book.cast || {})['旁白'] || { voice: '冰糖', style: NARRATOR_STYLE };
  const fp = book.firstPerson && book.protagonist && book.protagonist !== '我';
  const aiTo = book.ai?.analyzedTo ?? -1;
  const win = aiWindow(book);
  const aiBtn = win.start > 0 && win.start <= win.end ? '继续解析' : 'AI 解析';
  panel.innerHTML = `
    <div class="cast-head">
      <span>共识别 ${rows.length} 个角色${aiTo >= 0 ? ` · 已解析第 1–${aiTo + 1} 章` : ''}</span>
      <span class="cast-actions">
        <button class="mini-btn" id="btnReanalyze" title="重新分析全书人名、性别和语气">重新分析</button>
        <button class="mini-btn" id="btnAiCast" title="${win.start <= win.end ? `AI 解析第 ${win.start + 1}–${win.end + 1} 章` : '全书已解析'}">${aiBtn}</button>
        <button class="mini-btn" id="btnMakeVoices" title="按音色描述和语气重新生成所有角色的风格标签">重贴标签</button>
        <button class="mini-btn" id="btnAddCast">＋ 角色</button>
      </span>
    </div>
    <div class="cast-row" data-name="旁白">
      <div class="cast-top">
        <input class="cast-name" value="旁白" readonly>
        <span class="cast-count">${fp ? `叙述 · 用${book.protagonist}的声音` : '叙述'}</span>
      </div>
      <div class="cast-grid">
        <select class="cast-voice">${voiceOptions(narrator.voice)}</select>
        <input class="cast-style" placeholder="语气指令（可留空）" value="${escapeAttr(narrator.style || '')}">
        <button class="mini-btn cast-preview">试听</button>
      </div>
      ${fp ? '' : `<input class="cast-desc cast-desc-main" placeholder="音色描述（含年龄），如：三十岁女性，声音清亮，语速适中" value="${escapeAttr(narrator.voiceDesc || '')}">`}
      <input class="cast-tags cast-tags-main" placeholder="风格标签，如：平稳 语速适中" value="${escapeAttr(entryTags(narrator))}">
    </div>
    ${rows.map(([name, info]) => {
      const e = castEntryFor(name);
      const g = e.gender || '?';
      const staged = !!(e.stages && e.stages.length > 1);
      const stageHtml = staged ? `<div class="cast-stages">
        <div class="stage-caption">声音分期 · 播放时按章自动切换</div>
        ${e.stages.map((st, si) => `<div class="stage-row" data-si="${si}">
            <div class="stage-meta">
              <span class="stage-range">${aiRangeLabel(st)}</span>
              ${st.label ? `<span class="ai-badge">${escapeAttr(st.label)}</span>` : ''}
            </div>
            <input class="cast-desc stage-desc" placeholder="该阶段音色描述（含年龄），如：六十岁男性，声音苍老沙哑" value="${escapeAttr(st.desc || '')}">
            <input class="cast-tags stage-tags" placeholder="风格标签，如：苍老 沙哑 语速缓慢" title="${escapeAttr(st.desc || '')}" value="${escapeAttr(stageTags(st, e))}">
            <div class="row">
              <button class="mini-btn stage-preview">试听该阶段</button>
            </div>
          </div>`).join('')}
      </div>` : '';
      return `<div class="cast-row" data-name="${escapeAttr(name)}">
        <div class="cast-top">
          <input class="cast-name" value="${escapeAttr(name)}">
          <button class="gchip g-${g}" title="点击切换性别">${genderLabel(g)}</button>
          <span class="cast-count">${info.count || 0} 句${staged ? ` · ${e.stages.length} 个阶段` : ''}</span>
        </div>
        <div class="cast-grid">
          <select class="cast-voice">${voiceOptions(e.voice)}</select>
          <input class="cast-style" placeholder="语气指令（可留空）" value="${escapeAttr(e.style || '')}">
          <button class="mini-btn cast-preview">试听</button>
        </div>
        ${staged ? '' : `<input class="cast-desc cast-desc-main" placeholder="音色描述（含年龄），如：四十岁男性，声音低沉沙哑，语速缓慢" value="${escapeAttr(e.voiceDesc || '')}">`}
        ${staged ? '' : `<input class="cast-tags cast-tags-main" placeholder="风格标签，如：磁性 低沉 语速缓慢" title="${escapeAttr(e.voiceDesc || '')}" value="${escapeAttr(entryTags(e))}">`}
        ${stageHtml}
      </div>`;
    }).join('')}
        <p class="cast-note">${fp ? `第一人称：旁白和对白里的“我”都按主角「${escapeAttr(book.protagonist)}」处理。` : ''}性别和语气由全书统计推断，可点 ? 修改；改名字会把同名的话合并。AI 解析按批推进（每批约 ${(AI_WINDOW_CHARS / 10000).toFixed(0)} 万字），会按章记录角色的年龄阶段；同一时期只保留一套标签，不会因为描述措辞不同反复换声。听到离本批结尾约 ${(AI_NUDGE_CHARS / 10000).toFixed(0)} 万字时会提醒继续解析。开始 AI 解析后，这里只显示已解析章节里确认出场的角色；后面还没出场的角色，会在继续解析时自动加入。<br>「音色描述」会原样作为角色卡片发给模型，年龄写在这里最稳；改动后该角色的音频会重新合成。播放时用基础模型实时合成，标签直接控制音色和语气，不再生成或复刻样本：标签留空会按音色描述自动推导；短词如「沙哑」「苍老」「语速缓慢」比长句更稳定，最多 6 个，用空格分隔。</p>`;

  panel.querySelectorAll('.cast-row').forEach(row => {
    const name = row.dataset.name;
    row.querySelector('.cast-voice').addEventListener('change', (e) => {
      const entry = castEntryFor(name);
      entry.manual = true;
      const v = e.target.value;
      entry.voice = v;
      if (entry.stages) for (const st of entry.stages) st.voice = v;
      saveBookSoon();
      clearUrlCache();
    });
    row.querySelector('.cast-style').addEventListener('input', (e) => {
      const entry = castEntryFor(name);
      entry.manual = true;
      entry.style = e.target.value.trim();
      if (entry.stages) for (const st of entry.stages) st.style = entry.style;
      saveBookSoon();
    });
    const descInput = row.querySelector('.cast-desc-main');
    if (descInput) {
      descInput.addEventListener('input', (e) => {
        const entry = castEntryFor(name);
        entry.manual = true;
        entry.voiceDesc = e.target.value.trim();
        saveBookSoon();
      });
      descInput.addEventListener('change', () => clearUrlCache());
    }
    const tagsInput = row.querySelector('.cast-tags-main');
    if (tagsInput) {
      tagsInput.addEventListener('input', (e) => {
        const entry = castEntryFor(name);
        entry.manual = true;
        entry.tags = e.target.value.trim();
        saveBookSoon();
      });
      tagsInput.addEventListener('change', () => clearUrlCache());
    }
    row.querySelector('.cast-preview').addEventListener('click', async () => {
      const who = name === '旁白' ? '旁白' : name;
      const entry = book.cast[name] || {};
      const owner = name === '旁白' && book.firstPerson && book.protagonist && book.protagonist !== '我'
        ? book.protagonist
        : name;
      const pe = (book.cast || {})[owner] || entry;
      const selVoice = row.querySelector('.cast-voice').value;
      let voice = pe?.voice || selVoice;
      let tags = '', card = '';
      if (pe?.stages && pe.stages.length > 1) {
        const st = pe.stages.find((s) => chapterIdx >= s.from) || pe.stages[0];
        voice = st.voice || voice;
        tags = stageTags(st, pe);
        card = speechCard(pe, st);
      } else {
        tags = entryTags(pe);
        card = speechCard(pe, null);
      }
      previewVoice(`你好，我是${who}。`, voice, tags, card);
    });
    row.querySelectorAll('.stage-row').forEach((sr) => {
      const si = +sr.dataset.si;
      const st = book.cast[name]?.stages?.[si];
      if (!st) return;
      const stDesc = sr.querySelector('.stage-desc');
      stDesc.addEventListener('input', (ev) => {
        st.desc = ev.target.value.trim();
        if (si === 0) book.cast[name].voiceDesc = st.desc;
        book.cast[name].manual = true;
        saveBookSoon();
      });
      stDesc.addEventListener('change', () => clearUrlCache());
      const stTags = sr.querySelector('.stage-tags');
      stTags.addEventListener('input', (ev) => {
        st.tags = ev.target.value.trim();
        book.cast[name].manual = true;
        saveBookSoon();
      });
      stTags.addEventListener('change', () => clearUrlCache());
      sr.querySelector('.stage-preview').addEventListener('click', () => {
        const voice = st.voice || book.cast[name]?.voice || '苏打';
        previewVoice(`你好，我是${name}。`, voice, stageTags(st, book.cast[name]), speechCard(book.cast[name], st));
      });
    });
    row.querySelector('.cast-name').addEventListener('change', (e) => {
      if (name === '旁白') return;
      const newName = e.target.value.trim();
      if (!newName || newName === name) { e.target.value = name; return; }
      renameSpeaker(name, newName);
    });
    const gc = row.querySelector('.gchip');
    if (gc) {
      gc.addEventListener('click', () => {
        const cur = book.cast[name]?.gender || '?';
        const next = cur === '?' ? 'F' : cur === 'F' ? 'M' : '?';
        book.cast[name] = book.cast[name] || { voice: '苏打', style: '' };
        book.cast[name].gender = next;
        book.cast[name].manual = true;
        const pool = next === 'F' ? ['茉莉', '冰糖'] : next === 'M' ? ['苏打', '白桦'] : ['冰糖', '苏打'];
        book.cast[name].voice = pool[0];
        if (book.cast[name].stages) for (const st of book.cast[name].stages) st.voice = pool[0];
        saveBookSoon();
        renderCast();
        toast(next === '?' ? '已标记为未知' : `已标记为${genderLabel(next)}，音色已按性别调整`);
      });
    }
  });
  $('btnReanalyze').addEventListener('click', reanalyzeBook);
  $('btnAiCast').addEventListener('click', aiAnalyzeBook);
  $('btnMakeVoices').addEventListener('click', () => {
    if (!confirm('按当前音色描述和语气重新生成所有风格标签？手动改过的标签会被覆盖。')) return;
    retagAll();
  });
  $('btnAddCast').addEventListener('click', () => {
    const name = prompt('角色名（和对白里的名字一致）');
    if (!name || !name.trim()) return;
    const n = name.trim();
    book.cast[n] = { voice: '苏打', style: '', gender: '?', manual: true };
    saveBookSoon();
    renderCast();
  });
}

function renameSpeaker(oldName, newName) {
  book.aliases[oldName] = newName;
  if (book.cast[oldName]) { book.cast[newName] = book.cast[oldName]; delete book.cast[oldName]; }
  if (!book.cast[newName]) book.cast[newName] = { voice: '苏打', style: '', manual: true };
  book.cast[newName].manual = true;
  saveBookSoon();
  chapterToken++;
  stopPlayback();
  clearUrlCache();
  chapterSegments = buildSegments(book.chapters[chapterIdx].content);
  currentSeg = -1;
  renderCast();
  renderPlayer();
  updatePlayerBar();
  toast('已改名');
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/* ---------------- 播放页 ---------------- */
function renderPlayer() {
  if (!book) return;
  $('nowChapter').innerHTML = `<span id="nowChapterTitle"></span><button class="mini-btn" id="btnExport">导出本章 MP3</button>`;
  $('nowChapterTitle').textContent = book.chapters[chapterIdx].title;
  $('btnExport').addEventListener('click', exportChapter);

  const list = $('segList');
  list.innerHTML = '';
  if (!chapterSegments.length) {
    list.innerHTML = '<div class="empty">这一章没有可读的文字</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  chapterSegments.forEach((seg, i) => {
    const el = document.createElement('div');
    el.className = 'seg-item';
    el.dataset.i = i;
    const cls = seg.speaker === '旁白' ? 'narrator' : (seg.speaker === '未知角色' ? 'unknown' : '');
    el.innerHTML = `<div class="seg-meta"><span class="chip ${cls}"></span><span class="seg-idx">${i + 1}</span></div><div class="seg-text"></div>`;
    el.querySelector('.chip').textContent = seg.speaker;
    el.querySelector('.seg-text').textContent = seg.text;
    el.addEventListener('click', () => { showView('player'); playIndex(i); });
    frag.appendChild(el);
  });
  list.appendChild(frag);
  renderSegHighlight();
}

function renderSegHighlight() {
  const list = $('segList');
  list.querySelectorAll('.seg-item').forEach(el => el.classList.toggle('current', Number(el.dataset.i) === currentSeg));
  const cur = list.querySelector('.seg-item.current');
  if (cur) cur.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function updatePlayerBar() {
  if (!book) return;
  $('pbTitle').textContent = book.title;
  const seg = chapterSegments[currentSeg];
  const ch = book.chapters[chapterIdx];
  $('pbSub').textContent = seg
    ? `${ch.title} · ${seg.speaker} ${currentSeg + 1}/${chapterSegments.length}`
    : `${ch.title} · ${chapterSegments.length} 段`;
  $('btnPrev').disabled = currentSeg <= 0;
  $('btnNext').disabled = currentSeg >= chapterSegments.length - 1;
}

/* ---------------- 导出 ---------------- */
async function exportChapter() {
  if (!book) return;
  if (exporting) { exportAbort = true; return; }
  if (!chapterSegments.length) return;
  const btn = $('btnExport');
  const segs = chapterSegments.slice();
  const bookTitle = book.title;
  const chTitle = book.chapters[chapterIdx].title;
  exporting = true;
  exportAbort = false;
  const blobs = [];
  try {
    for (let i = 0; i < segs.length; i++) {
      if (exportAbort) { toast('已取消导出'); return; }
      btn.textContent = `导出中 ${i + 1}/${segs.length}`;
      const blob = await getSegmentAudio(segs[i]);
      blobs.push(blob);
    }
    btn.textContent = '合并中…';
    const out = new Blob(blobs, { type: 'audio/mpeg' });
    const a = document.createElement('a');
    const name = `${bookTitle}-${chTitle}`.replace(/[\\/:*?"<>|]/g, '_');
    a.href = URL.createObjectURL(out);
    a.download = name + '.mp3';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    toast('已导出，去通知栏/下载里找');
  } catch (e) {
    toast('导出失败：' + (e.message || e));
  } finally {
    exporting = false;
    btn.textContent = '导出本章 MP3';
  }
}

/* ---------------- 设置 ---------------- */
function renderSettings() {
  const s = loadSettings();
  $('apiKey').value = s.apiKey || '';
  $('baseUrl').value = s.baseUrl || DEFAULT_BASE;
  $('singleVoice').checked = !!s.singleVoice;
  $('keepAwake').checked = !!s.keepAwake;
  const ai = loadAi();
  $('aiBaseUrl').value = ai.baseUrl || '';
  $('aiKey').value = ai.key || '';
  $('aiModel').value = ai.model || '';
  if ($('appVer')) $('appVer').textContent = `页面版本 ${APP_VER}`;
  updateCacheInfo();
}

async function updateCacheInfo() {
  try {
    const est = await navigator.storage?.estimate?.();
    if (est) {
      $('cacheInfo').textContent = `本机已用 ${(est.usage / 1048576).toFixed(1)} MB`;
    } else {
      $('cacheInfo').textContent = '';
    }
  } catch {}
}

async function previewVoice(text, voice, tags, card) {
  toast('合成中…', 6000);
  try {
    const blob = await requestTTS(text, voice, tags, card);
    if (previewAudio) { previewAudio.pause(); }
    previewAudio = new Audio(URL.createObjectURL(blob));
    previewAudio.play();
    $('toast').hidden = true;
  } catch (e) {
    toast('试听失败：' + (e.message || e));
  }
}

/* ---------------- AI 角色解析 ---------------- */
const AI_CHUNK_CHARS = 30000;
const AI_WINDOW_CHARS = 50000;
const AI_NUDGE_CHARS = 10000;
const AI_VOICES = ['冰糖', '茉莉', '苏打', '白桦'];
const AI_F_VOICES = ['冰糖', '茉莉'];
const AI_M_VOICES = ['苏打', '白桦'];
const AI_SYS = `你是中文小说角色分析助手。阅读给出的原文片段，找出其中有名字或固定外号、并且真正出场的角色（忽略路人和一次性称谓）。
对每个角色输出：
- name：最常用的正式称呼（2-6个字，不要带“姑娘/师兄”等称谓）
- aliases：本段中出现的其他叫法、简称、外号（数组，最多3个，没有则为空数组）
- gender：F（女）、M（男）或 ?（无法判断），依据“她/他”、身份称谓、亲属关系判断
- voice：从 冰糖(清亮女声)、茉莉(温柔女声)、苏打(清朗男声)、白桦(低沉男声) 中选一个最贴合的
- stage：这个角色在本段所处的阶段，只能填 童年/少年/青年/中年/老年/不变 之一（同一角色处于同一时期必须用同一个词；没有明显变化就填“不变”）
- voiceDesc：20-40字的音色描述，只写本段这个阶段的年龄、性别、音质、语速，例如“八岁男孩，声音清脆，语速偏快”；不要写台词
- tags：2-5个空格分隔的风格标签，只从这些词里选：磁性/醇厚/清亮/空灵/稚嫩/苍老/甜美/沙哑/醇雅/温柔/高冷/活泼/严肃/慵懒/俏皮/深沉/低沉/干练/凌厉/御姐音/正太音/大叔音/夹子音/台湾腔/东北话/四川话/河南话/粤语/语速较快/语速缓慢/语速适中；不要用“温柔/平稳”凑数，没有明显依据就少给
- tagBasis：给 tags 里的每个标签写依据，JSON 对象，键是标签，值是简短依据，例如 {"沙哑":"原文：他嗓子像破锣","低沉":"推断：三十岁男性将军"}；原文没有直接描写时必须以“推断：”开头
- tone：不超过12个字的语气指令，概括这个角色本段说话的风格
贴标签规则：先找原文依据（年龄阶段、身份职业、方言口音、说话方式、旁人评价），再选对应标签；同一角色在同一阶段保持同一套标签，不要逐段换；进入新阶段时按该阶段重贴。原文只写了“青年男子”这类信息时，最多给 1 个标注“推断”的标签。不要贴愤怒/悲伤等情绪标签，情绪由台词决定。
这是长篇小说的一个片段，人物可能随剧情长大或变老。同一人物在不同片段处于不同年龄/身份阶段时，stage、voiceDesc 和 tags 要如实反映该阶段；处于同一阶段时请保持相同的阶段标签、描述和标签组合，避免重复刷新。
这里只提供全书的一批章节，请按这一批内容判断角色当时所处的阶段，不要推断更后面的剧情。
同时判断：firstPerson（本段是否第一人称叙述）、protagonist（第一人称主角的名字；不是第一人称则填本段最主要角色的名字）。
只输出 JSON，不要解释，格式：
{"characters":[{"name":"","aliases":[],"gender":"F","voice":"茉莉","stage":"青年","voiceDesc":"","tags":"","tagBasis":{},"tone":""}],"firstPerson":true,"protagonist":""}`;
let aiAbort = null;
let aiPreview = null;
let aiCancelled = false;

const AI_TAG_FILLERS = new Set(['温柔', '平稳']);

function aiParseTagBasis(raw) {
  const map = new Map();
  const put = (k, v) => {
    const tag = String(k == null ? '' : k).replace(/[()（）[\]【】"'“”]/g, '').trim();
    const note = String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 80);
    if (KNOWN_TAGS.has(tag) && note) map.set(tag, note);
  };
  const parseText = (s) => {
    for (const part of String(s || '').split(/[;；\n]+/)) {
      const m = part.match(/^([^=＝:：]{1,10})[=＝:：](.+)$/);
      if (m) put(m[1], m[2]);
    }
  };
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item && typeof item === 'object') put(item.tag || item.name, item.basis || item.reason || item.evidence);
      else parseText(item);
    }
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) put(k, v);
  } else if (typeof raw === 'string') {
    parseText(raw);
  }
  return map;
}

function aiValidateTags(rawTags, rawBasis, desc, tone, text) {
  const tags = cleanTagList(rawTags).split(/\s+/).filter((t) => KNOWN_TAGS.has(t));
  const basis = aiParseTagBasis(rawBasis);
  const derived = new Set(deriveTags(desc, tone));
  const out = [];
  const notes = [];
  let inferred = 0;
  for (const tag of tags) {
    const b = basis.get(tag) || '';
    let kind = '';
    if (b) {
      if (/(推断|推测|默认|未明写|合理|可能)/.test(b)) {
        kind = '推断';
      } else {
        const quote = b.replace(/^原文\s*[:：]?\s*/, '').replace(/[“”"「」『』]/g, '').trim();
        if (quote && text && text.includes(quote)) kind = '原文';
        else if (desc && (desc.includes(b) || b.includes(desc))) kind = '描述';
        else kind = '依据';
      }
    } else if (derived.has(tag)) {
      kind = '描述';
    }
    if (!kind) continue;
    if (AI_TAG_FILLERS.has(tag) && kind !== '原文') continue;
    if (kind !== '原文' && kind !== '描述') {
      if (inferred >= 1) continue;
      inferred++;
    }
    if (out.includes(tag)) continue;
    out.push(tag);
    notes.push({ tag, basis: b || '音色描述', kind });
    if (out.length >= 5) break;
  }
  if (!out.length) {
    for (const tag of derived) {
      out.push(tag);
      notes.push({ tag, basis: '由音色描述推导', kind: '描述' });
      if (out.length >= 3) break;
    }
  }
  return { tags: out.slice(0, 5).join(' '), notes };
}

async function aiChat(messages, { json = false, signal } = {}) {
  const cfg = loadAi();
  const key = (cfg.key || '').trim();
  const model = (cfg.model || '').trim();
  const base = (cfg.baseUrl || '').trim().replace(/\/+$/, '');
  if (!base || !key || !model) throw new Error('请先在设置里填写 AI API Key');
  const body = { model, messages, temperature: 0.2 };
  if (json) body.response_format = { type: 'json_object' };
  const send = () => fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, 'api-key': key },
    body: JSON.stringify(body),
    signal,
  });
  let res;
  try {
    res = await send();
    if (!res.ok && json && (res.status === 400 || res.status === 422)) {
      delete body.response_format;
      res = await send();
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('连接失败：可能是网络问题，或服务商不允许浏览器直连（CORS）');
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j?.error?.message || j?.message || msg; } catch {}
    throw new Error(String(msg).slice(0, 180));
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('模型没有返回内容');
  return content;
}

function aiChapterStart(b, ci) {
  let n = 0;
  for (let i = 0; i < ci; i++) n += b.chapters[i].content.length;
  return n;
}

function aiWindow(b = book) {
  const total = b ? b.chapters.length : 0;
  const start = Math.max(0, (b?.ai?.analyzedTo ?? -1) + 1);
  let chars = 0, end = start - 1;
  for (let i = start; i < total; i++) {
    const len = b.chapters[i].content.length;
    if (i > start && chars + len > AI_WINDOW_CHARS) break;
    chars += len;
    end = i;
    if (chars >= AI_WINDOW_CHARS) break;
  }
  return { start, end, total, chars };
}

function aiChunks(b, from = 0, to = b.chapters.length - 1) {
  const out = [];
  let buf = '', bufFrom = 0, bufTo = 0;
  const flush = () => {
    if (buf) { out.push({ text: buf, from: bufFrom, to: bufTo }); buf = ''; }
  };
  for (let ci = from; ci <= to; ci++) {
    const c = b.chapters[ci];
    let piece = `【${c.title}】\n${c.content}`;
    if (buf && buf.length + piece.length + 2 > AI_CHUNK_CHARS) flush();
    if (piece.length > AI_CHUNK_CHARS * 1.5) {
      while (piece.length > AI_CHUNK_CHARS) {
        let cut = piece.lastIndexOf('\n', AI_CHUNK_CHARS);
        if (cut < AI_CHUNK_CHARS * 0.5) cut = AI_CHUNK_CHARS;
        out.push({ text: piece.slice(0, cut), from: ci, to: ci });
        piece = piece.slice(cut);
      }
      if (piece.trim()) out.push({ text: piece, from: ci, to: ci });
      continue;
    }
    if (!buf) bufFrom = ci;
    bufTo = ci;
    buf += (buf ? '\n\n' : '') + piece;
  }
  flush();
  return out;
}

function aiCleanName(v) {
  return String(v || '').trim().replace(/[“”"「」『』\s·:：]/g, '').slice(0, 6);
}
function aiValidName(n) {
  return n.length >= 2 && !/^[我你他她它咱]/.test(n) && !NAME_STOP.has(n);
}
function aiMentionCount(text, names) {
  let n = 0;
  for (const line of text.split('\n')) {
    if (!line.includes('“') && !line.includes('「')) continue;
    if (names.some((x) => line.includes(x))) n++;
  }
  return Math.max(1, n);
}
function aiTop(map) {
  let best = '', bn = 0;
  for (const [k, n] of map) {
    if (n > bn || (n === bn && k.length > best.length)) { best = k; bn = n; }
  }
  return best;
}
function aiRangeLabel(s) {
  return s.from === s.to ? `第${s.from + 1}章` : `第${s.from + 1}–${s.to + 1}章`;
}
function parseAiJson(text) {
  const s = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(s); } catch {}
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
  return null;
}

function aiMergeChunk(acc, j) {
  const list = Array.isArray(j?.characters) ? j.characters : [];
  for (const c of list) {
    const name = aiCleanName(c?.name);
    if (!aiValidName(name)) continue;
    let e = acc.get(name);
    if (!e) {
      e = { name, aliases: new Set(), f: 0, m: 0, unknown: 0, tones: new Map(), voices: new Map(), descs: new Map(), hits: 0 };
      acc.set(name, e);
    }
    e.hits++;
    const g = String(c.gender || '').toUpperCase();
    if (g === 'F') e.f++;
    else if (g === 'M') e.m++;
    else e.unknown++;
    for (const a of (Array.isArray(c.aliases) ? c.aliases : [])) {
      const t = aiCleanName(a);
      if (aiValidName(t) && t !== name) e.aliases.add(t);
    }
    const tone = String(c.tone || '').trim().slice(0, 16);
    if (tone) e.tones.set(tone, (e.tones.get(tone) || 0) + 1);
    const v = String(c.voice || '').trim();
    if (AI_VOICES.includes(v)) e.voices.set(v, (e.voices.get(v) || 0) + 1);
    const desc = String(c.voiceDesc || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (desc) e.descs.set(desc, (e.descs.get(desc) || 0) + 1);
  }
  return list.length;
}

function aiResolve(acc) {
  const parent = new Map();
  for (const k of acc.keys()) parent.set(k, k);
  const find = (x) => {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  for (const e of acc.values()) {
    for (const a of e.aliases) {
      if (!acc.has(a)) continue;
      const ra = find(a), rb = find(e.name);
      if (ra !== rb) parent.set(ra, rb);
    }
  }
  const groups = new Map();
  for (const e of acc.values()) {
    const r = find(e.name);
    let g = groups.get(r);
    if (!g) {
      g = { aliases: new Set(), f: 0, m: 0, unknown: 0, tones: new Map(), voices: new Map(), descs: new Map(), hits: 0, members: [] };
      groups.set(r, g);
    }
    g.members.push({ name: e.name, hits: e.hits });
    g.f += e.f; g.m += e.m; g.unknown += e.unknown; g.hits += e.hits;
    for (const a of e.aliases) g.aliases.add(a);
    for (const [t, n] of e.tones) g.tones.set(t, (g.tones.get(t) || 0) + n);
    for (const [v, n] of e.voices) g.voices.set(v, (g.voices.get(v) || 0) + n);
    for (const [d, n] of e.descs) g.descs.set(d, (g.descs.get(d) || 0) + n);
  }
  const out = [];
  for (const g of groups.values()) {
    let canon = g.members[0];
    for (const m of g.members) if (m.hits > canon.hits || (m.hits === canon.hits && m.name.length > canon.name.length)) canon = m;
    const aliases = new Set(g.aliases);
    for (const m of g.members) if (m.name !== canon.name) aliases.add(m.name);
    aliases.delete(canon.name);
    const gender = g.f === g.m ? '?' : (g.f > g.m ? 'F' : 'M');
    out.push({
      name: canon.name,
      aliases: [...aliases].slice(0, 8),
      gender,
      tone: aiTop(g.tones),
      voice: aiTop(g.voices),
      voiceDesc: aiTop(g.descs),
      hits: g.hits,
    });
  }
  return out.sort((a, b) => b.hits - a.hits);
}

const STAGE_WORDS = [
  [/(?:童年|幼年|幼时|孩童|孩子|小孩|小时候|幼)/, '童年'],
  [/(?:少年|少女|少时|青少年)/, '少年'],
  [/(?:青年|成年|青年期|长大后)/, '青年'],
  [/(?:中年|壮年)/, '中年'],
  [/(?:老年|晚年|暮年|年老)/, '老年'],
];
function stagePeriod(label) {
  const s = String(label || '').trim();
  if (!s || s === '不变' || s === '未变' || s === '无') return '';
  for (const [re, word] of STAGE_WORDS) if (re.test(s)) return word;
  return s;
}
const STAGE_RANK = { 童年: 1, 少年: 2, 青年: 3, 中年: 4, 老年: 5 };
function sameStagePeriod(prevLabel, nextLabel) {
  const x = stagePeriod(nextLabel), y = stagePeriod(prevLabel);
  if (!x) return true;
  if (!y) return false;
  const rx = STAGE_RANK[x], ry = STAGE_RANK[y];
  if (rx && ry) return rx <= ry;
  return x === y;
}

function aiBuildStages(chunkResults, canonOf) {
  const byChar = new Map();
  for (const cr of chunkResults) {
    const seen = new Set();
    for (const c of cr.list) {
      const raw = aiCleanName(c?.name);
      if (!aiValidName(raw)) continue;
      const name = canonOf.get(raw) || raw;
      if (seen.has(name)) continue;
      seen.add(name);
      let arr = byChar.get(name);
      if (!arr) byChar.set(name, arr = []);
      const v = String(c.voice || '').trim();
      arr.push({
        from: cr.from,
        to: cr.to,
        label: String(c.stage || '').trim().slice(0, 8),
        desc: String(c.voiceDesc || '').replace(/\s+/g, ' ').trim().slice(0, 60),
        tags: cleanTagList(c.tags),
        tagNotes: Array.isArray(c.tagNotes) ? c.tagNotes : [],
        tone: String(c.tone || '').trim().slice(0, 16),
        voice: AI_VOICES.includes(v) ? v : '',
      });
    }
  }
  const out = new Map();
  for (const [name, arr] of byChar) {
    arr.sort((a, b) => a.from - b.from);
    const stages = [];
    for (const r of arr) {
      const prev = stages[stages.length - 1];
      if (!prev) {
        stages.push({ from: r.from, to: r.to, label: r.label, desc: r.desc, tags: r.tags, tagNotes: r.tagNotes, tone: r.tone, voice: r.voice });
        continue;
      }
      const sameLabel = sameStagePeriod(prev.label, r.label);
      const sameDesc = !!(r.desc && prev.desc && r.desc === prev.desc);
      if (r.desc && prev.desc && !sameDesc && !sameLabel) {
        stages.push({ from: r.from, to: r.to, label: r.label, desc: r.desc, tags: r.tags, tagNotes: r.tagNotes, tone: r.tone, voice: r.voice });
        continue;
      }
      prev.to = Math.max(prev.to, r.to);
      if (!prev.desc && r.desc) prev.desc = r.desc;
      if (!prev.tags && r.tags) {
        prev.tags = r.tags;
        prev.tagNotes = r.tagNotes;
      }
      if (!prev.label && r.label) prev.label = r.label;
      if (!prev.tone && r.tone) prev.tone = r.tone;
      if (!prev.voice && r.voice) prev.voice = r.voice;
    }
    const cleaned = [];
    for (const s of stages) {
      if (!s.desc) continue;
      const prev = cleaned[cleaned.length - 1];
      if (prev && prev.desc === s.desc) {
        prev.to = Math.max(prev.to, s.to);
        if (!prev.tags && s.tags) {
          prev.tags = s.tags;
          prev.tagNotes = s.tagNotes;
        }
        continue;
      }
      cleaned.push(s);
    }
    if (cleaned.length) out.set(name, cleaned);
  }
  return out;
}

function aiPickVoice(gender, voice, current) {
  let v = AI_VOICES.includes(voice) ? voice : '';
  if (gender === 'F' && AI_M_VOICES.includes(v)) v = '';
  if (gender === 'M' && AI_F_VOICES.includes(v)) v = '';
  if (!v && current && AI_VOICES.includes(current) && !(gender === 'F' && AI_M_VOICES.includes(current)) && !(gender === 'M' && AI_F_VOICES.includes(current))) v = current;
  if (!v) v = gender === 'F' ? '茉莉' : gender === 'M' ? '苏打' : '冰糖';
  return v;
}

function openAi(title, bodyHtml, applyLabel) {
  $('aiTitle').textContent = title;
  $('aiBody').innerHTML = bodyHtml;
  $('aiOverlay').hidden = false;
  $('aiApply').hidden = !applyLabel;
  if (applyLabel) $('aiApply').textContent = applyLabel;
  $('aiCancel').textContent = applyLabel ? '取消' : '停止';
}
function closeAi() {
  if (aiAbort) { aiCancelled = true; aiAbort.abort(); aiAbort = null; }
  $('aiOverlay').hidden = true;
  $('aiBody').innerHTML = '';
  $('aiApply').hidden = true;
  aiPreview = null;
}

function aiTagLine(tags, notes) {
  const map = new Map((Array.isArray(notes) ? notes : []).map((n) => [n.tag, n]));
  return String(tags || '').split(/\s+/).filter(Boolean).map((t) => {
    const n = map.get(t);
    const mark = !n ? '' : n.kind === '原文' ? '（原文）' : n.kind === '描述' ? '（描述）' : '（推断）';
    return `<span class="ai-tag" title="${escapeAttr(n ? `依据：${n.basis}` : '')}">${escapeAttr(t)}${mark}</span>`;
  }).join(' ');
}

function aiShowPreview(rawResults, meta, errors, totalChunks) {
  const known = new Set((book.detected || []).map((d) => d.name));
  const aliasMap = book.aliases || {};
  for (const r of rawResults) {
    if (known.has(r.name) || (book.cast || {})[r.name]) continue;
    const hit = r.aliases.find((a) => known.has(a) || aliasMap[a] || (book.cast || {})[a]);
    const target = hit ? (aliasMap[hit] || hit) : '';
    if (target && target !== r.name) {
      r.aliases = r.aliases.filter((a) => a !== target);
      r.aliases.push(r.name);
      r.name = target;
    }
  }
  const byName = new Map();
  for (const r of rawResults) {
    const p = byName.get(r.name);
    if (!p) { byName.set(r.name, r); continue; }
    p.aliases = [...new Set([...p.aliases, ...r.aliases])];
    p.hits += r.hits;
    if (p.gender === '?' && r.gender !== '?') p.gender = r.gender;
    if (!p.tone) p.tone = r.tone;
    if (!p.voice) p.voice = r.voice;
    if (!p.voiceDesc) p.voiceDesc = r.voiceDesc;
    if (!p.tags) p.tags = r.tags;
    if ((r.stages || []).length > (p.stages || []).length) p.stages = r.stages;
  }
  const results = [...byName.values()];
  for (const r of results) {
    r.tone = (r.tone || defaultTone(r.gender)).slice(0, 16);
    r.voice = aiPickVoice(r.gender, r.voice, ((book.cast || {})[r.name] || {}).voice);
    r.stages = (r.stages || []).filter((s) => s.desc);
    if (r.stages.length === 1) {
      const s0 = r.stages[0];
      if (!r.voiceDesc) r.voiceDesc = s0.desc;
      if (!r.tags && s0.tags) {
        r.tags = s0.tags;
        r.tagNotes = s0.tagNotes;
      }
    }
    if (r.stages.length > 1) r.voiceDesc = r.stages[0].desc;
    r.voiceDesc = (r.voiceDesc || ((book.cast || {})[r.name] || {}).voiceDesc || '').slice(0, 60);
    r.tags = cleanTagList(r.tags) || deriveTags(r.voiceDesc, r.tone).join(' ');
    if (!Array.isArray(r.tagNotes) || !r.tagNotes.length) {
      const derived = new Set(deriveTags(r.voiceDesc, r.tone));
      r.tagNotes = r.tags.split(/\s+/).filter((t) => derived.has(t)).map((t) => ({ tag: t, basis: '由音色描述推导', kind: '描述' }));
    }
    r.isNew = !known.has(r.name) && !(book.cast || {})[r.name];
  }
  results.sort((a, b) => (a.isNew ? 1 : 0) - (b.isNew ? 1 : 0) || b.hits - a.hits);
  aiPreview = { results, meta };
  const rows = results.map((r, i) => {
    const cur = (book.cast || {})[r.name] || {};
    const g = r.gender || '?';
    const stHtml = r.stages.length > 1
      ? `<div class="ai-stages">${r.stages.map((s) => `<div class="ai-stage"><span class="ai-stage-range">${aiRangeLabel(s)}</span>${s.label ? `<span class="ai-badge">${escapeAttr(s.label)}</span>` : ''}<span class="ai-stage-desc">${escapeAttr(s.desc)}</span></div>${s.tags ? `<div class="ai-stage-tags">标签 ${aiTagLine(s.tags, s.tagNotes)}</div>` : ''}`).join('')}</div>`
      : (r.voiceDesc ? `<div class="ai-desc">音色描述：${escapeAttr(r.voiceDesc)}</div>` : '');
    return `<label class="ai-row">
      <input type="checkbox" data-i="${i}" checked>
      <div class="ai-main">
        <div class="ai-name">${escapeAttr(r.name)}<span class="ai-badge${r.isNew ? ' new' : ''}">${r.isNew ? '新增' : '已有'}</span><span class="gchip g-${g}">${genderLabel(g)}</span></div>
        ${r.aliases.length ? `<div class="ai-alias">别名：${escapeAttr(r.aliases.join('、'))}</div>` : ''}
        ${stHtml}
        <div class="ai-meta">音色 ${escapeAttr(r.voice)} · 语气 ${escapeAttr(r.tone)}${r.tags ? ` · 标签 ${aiTagLine(r.tags, r.tagNotes)}` : ''}${cur.style && cur.style !== r.tone ? ` · 当前语气 ${escapeAttr(cur.style)}` : ''}</div>
      </div>
    </label>`;
  }).join('');
  const failed = errors.filter((e) => /^第 \d+ 段/.test(e)).length;
  const staged = results.filter((r) => r.stages.length > 1).length;
  const range = meta.to >= meta.from ? `第 ${meta.from + 1}–${meta.to + 1} 章 · ` : '';
  const more = meta.total && meta.to < meta.total - 1 ? ' · 还有后续章节' : '';
  const metaLine = `${range}${results.length} 个角色 · ${results.filter((r) => r.isNew).length} 个新增 · ${staged} 个有分期变化 · ${totalChunks - failed}/${totalChunks} 段成功${more}` +
    (meta.firstPerson ? ` · 第一人称${meta.protagonist ? `（主角 ${escapeAttr(meta.protagonist)}）` : ''}` : '');
  const errLine = errors.length ? `<div class="ai-err">${errors.slice(0, 4).map((e) => escapeAttr(e)).join('<br>')}</div>` : '';
  openAi('AI 解析结果', `<div class="ai-sum">${metaLine}</div>${rows}${errLine}`, '应用所选');
}

async function aiApplySelection() {
  if (!aiPreview) return;
  const picked = [...document.querySelectorAll('#aiBody input[type=checkbox]')]
    .filter((x) => x.checked)
    .map((x) => aiPreview.results[+x.dataset.i])
    .filter(Boolean);
  const { meta } = aiPreview;
  const allText = book.chapters.map((c) => c.content).join('\n');
  book.cast = book.cast || {};
  book.aliases = book.aliases || {};
  book.detected = book.detected || [];
  for (const r of picked) {
    for (const a of r.aliases) if (aiValidName(a) && a !== r.name) book.aliases[a] = r.name;
    let d = book.detected.find((x) => x.name === r.name) || book.detected.find((x) => book.aliases[x.name] === r.name);
    if (!d) {
      d = { name: r.name, count: aiMentionCount(allText, [r.name, ...r.aliases]), gender: r.gender, tone: r.tone };
      book.detected.push(d);
    } else {
      if (r.gender !== '?') d.gender = r.gender;
      if (r.tone) d.tone = r.tone;
    }
    const prevTo = book.ai?.analyzedTo ?? -1;
    const winFrom = meta.from ?? 0;
    const winTo = meta.to ?? winFrom;
    const incoming = (r.stages && r.stages.length > 1)
      ? r.stages.map((s) => ({ from: s.from, to: s.to, label: s.label || '', desc: s.desc, tags: s.tags || '', style: s.tone || '', voice: s.voice || '' }))
      : (r.voiceDesc ? [{ from: winFrom, to: winTo, label: '', desc: r.voiceDesc, tags: r.tags || '', style: r.tone || '', voice: r.voice || '' }] : []);
    const entry = Object.assign({}, book.cast[r.name] || {});
    if (r.gender !== '?') entry.gender = r.gender;
    else entry.gender = entry.gender || '?';
    const prevDesc = entry.voiceDesc || '';
    let merged = Array.isArray(entry.stages) ? entry.stages.map((s) => Object.assign({}, s)) : [];
    if (!merged.length && prevDesc && prevTo >= 0 && winFrom > 0) {
      const prevStage = {
        from: 0,
        to: prevTo,
        label: '',
        desc: prevDesc,
        tags: entry.tags || deriveTags(prevDesc, entry.style).join(' '),
        style: entry.style || '',
        voice: entry.voice || '',
      };
      merged.push(prevStage);
    }
    for (const s of incoming) {
      if (!s.desc) continue;
      const last = merged[merged.length - 1];
      if (last) {
        const sameLabel = sameStagePeriod(last.label, s.label);
        if (last.desc === s.desc || sameLabel) {
          last.to = Math.max(last.to, s.to);
          if (!last.label && s.label) last.label = s.label;
          if (!last.style && s.style) last.style = s.style;
          if (!last.tags && s.tags) last.tags = s.tags;
          if (!last.voice && s.voice) last.voice = s.voice;
          continue;
        }
      }
      merged.push(s);
    }
    merged.sort((a, b) => a.from - b.from);
    const dedup = [];
    for (const s of merged) {
      if (!s.desc) continue;
      const prev = dedup[dedup.length - 1];
      if (prev && prev.desc === s.desc) {
        prev.to = Math.max(prev.to, s.to);
        if (!prev.tags && s.tags) prev.tags = s.tags;
        continue;
      }
      if (prev && prev.to >= s.from) s.from = prev.to + 1;
      if (s.from <= s.to) dedup.push(s);
    }
    if (dedup.length > 1) {
      entry.stages = dedup;
      entry.voice = dedup[0].voice || entry.voice || r.voice;
      entry.style = dedup[0].style || entry.style || r.tone;
      entry.voiceDesc = dedup[0].desc;
      entry.tags = dedup[0].tags || deriveTags(dedup[0].desc, dedup[0].style || entry.style, dedup[0].label).join(' ');
      delete entry.sampleId;
      delete entry.sampleRef;
      delete entry.sampleDesc;
    } else {
      delete entry.stages;
      if (r.voiceDesc) entry.voiceDesc = r.voiceDesc;
      entry.voice = r.voice || entry.voice;
      entry.style = r.tone || entry.style;
      entry.tags = cleanTagList(r.tags) || deriveTags(entry.voiceDesc, entry.style).join(' ');
    }
    entry.voiceMode = 'tag';
    entry.ai = true;
    book.cast[r.name] = entry;
    for (const a of r.aliases) if (book.cast[a]) book.aliases[a] = r.name;
  }
  const prevAnalyzed = book.ai?.analyzedTo ?? -1;
  if (meta && meta.to >= (meta.from ?? 0)) {
    const adv = meta.advanceTo ?? meta.to;
    book.ai = { analyzedTo: Math.max(prevAnalyzed, adv), nudgeDismissedTo: -1 };
  }
  if (meta && meta.firstPerson && meta.protagonist && meta.protagonist !== '我') {
    book.firstPerson = true;
    book.protagonist = meta.protagonist;
    book.aliases['我'] = meta.protagonist;
    const pr = picked.find((x) => x.name === meta.protagonist);
    let d = book.detected.find((x) => x.name === meta.protagonist);
    if (!d) {
      d = {
        name: meta.protagonist,
        count: aiMentionCount(allText, [meta.protagonist]),
        gender: pr ? pr.gender : '?',
        tone: pr ? pr.tone : defaultTone('?'),
      };
      book.detected.push(d);
    }
    if (!book.cast[meta.protagonist]) {
      book.cast[meta.protagonist] = { voice: aiPickVoice(d.gender, '', ''), style: d.tone || defaultTone(d.gender), gender: d.gender };
    }
    book.cast['旁白'] = book.cast['旁白'] || { voice: '冰糖', style: NARRATOR_STYLE, gender: '?' };
    book.cast['旁白'].voice = book.cast[meta.protagonist].voice;
  }
  closeAi();
  chapterToken++;
  stopPlayback();
  clearUrlCache();
  if (book.chapters[chapterIdx]) chapterSegments = buildSegments(book.chapters[chapterIdx].content);
  currentSeg = -1;
  saveBookSoon();
  renderCast();
  renderChapters();
  renderPlayer();
  updatePlayerBar();
  aiNudgeCheck();
  toast(`已应用 ${picked.length} 个角色`);
}

function aiNudgeCheck() {
  const el = $('aiNudge');
  if (!el) return;
  const at = book?.ai?.analyzedTo ?? -1;
  if (!book || at < 0 || at >= book.chapters.length - 1 || book.ai.nudgeDismissedTo === at) { el.hidden = true; return; }
  const endPos = aiChapterStart(book, at) + book.chapters[at].content.length;
  if (endPos - aiChapterStart(book, chapterIdx) > AI_NUDGE_CHARS) { el.hidden = true; return; }
  const win = aiWindow(book);
  if (win.start > win.end) { el.hidden = true; return; }
  $('aiNudgeText').textContent = `已解析到第 ${at + 1} 章，可继续解析第 ${win.start + 1}–${win.end + 1} 章`;
  el.hidden = false;
}

async function aiAnalyzeBook() {
  if (!book) return;
  const cfg = loadAi();
  if (!cfg.baseUrl || !cfg.key || !cfg.model) {
    toast('先在设置里填写 DeepSeek API Key');
    showView('settings');
    return;
  }
  aiCancelled = false;
  const win = aiWindow(book);
  if (win.start > win.end) { toast('这本书已经全部解析过了'); return; }
  const chunks = aiChunks(book, win.start, win.end);
  if (!chunks.length) { toast('没有可分析的正文'); return; }
  const total = chunks.reduce((n, c) => n + c.text.length, 0);
  const est = Math.round(total / 1.6);
  const tail = win.end < book.chapters.length - 1 ? `\n本次只解析这一批；听到离本批结尾约 ${(AI_NUDGE_CHARS / 10000).toFixed(0)} 万字时会提醒继续解析后面 ${win.total - win.end - 1} 章。` : '';
  if (!confirm(`AI 解析第 ${win.start + 1}–${win.end + 1} 章（全书 ${win.total} 章）：约 ${(total / 10000).toFixed(1)} 万字，输入约 ${(est / 10000).toFixed(1)} 万 tokens。${tail}\n\n会按你的模型价格产生费用，确认继续？`)) return;

  const acc = new Map();
  const chunkResults = [];
  const errors = [];
  const pVotes = new Map();
  let fpSeen = 0, fpYes = 0;
  aiAbort = new AbortController();
  openAi(`AI 解析中 · 第 ${win.start + 1}–${win.end + 1} 章`, `<div class="ai-sum" id="aiProgText">准备中…</div><div class="ai-progress"><i id="aiProgBar"></i></div><div class="ai-sum">可点“停止”中断；已发出的请求仍会计费。</div>`);
  const t0 = Date.now();
  for (let i = 0; i < chunks.length; i++) {
    if (aiAbort && aiAbort.signal.aborted) break;
    const txt = $('aiProgText');
    if (txt) txt.textContent = `第 ${i + 1}/${chunks.length} 段 · 第 ${chunks[i].from + 1}–${chunks[i].to + 1} 章`;
    const bar = $('aiProgBar');
    if (bar) bar.style.width = `${Math.round((i / chunks.length) * 100)}%`;
    try {
      const raw = await aiChat([
        { role: 'system', content: AI_SYS },
        { role: 'user', content: chunks[i].text },
      ], { json: true, signal: aiAbort ? aiAbort.signal : undefined });
      const j = parseAiJson(raw);
      if (!j) { errors.push(`第 ${i + 1} 段：返回不是 JSON`); continue; }
      const list = Array.isArray(j.characters) ? j.characters : [];
      for (const c of list) {
        if (!c || typeof c !== 'object') continue;
        const v = aiValidateTags(c.tags, c.tagBasis, c.voiceDesc, c.tone, chunks[i].text);
        c.tags = v.tags;
        c.tagNotes = v.notes;
      }
      aiMergeChunk(acc, j);
      chunkResults.push({ from: chunks[i].from, to: chunks[i].to, list });
      if (typeof j.firstPerson === 'boolean') fpSeen++;
      if (j.firstPerson === true) {
        fpYes++;
        const p = aiCleanName(j.protagonist);
        if (aiValidName(p)) pVotes.set(p, (pVotes.get(p) || 0) + 1);
      }
    } catch (e) {
      if (e.name === 'AbortError') break;
      errors.push(`第 ${i + 1} 段：${e.message || e}`);
      if (errors.filter((x) => /^第 \d+ 段/.test(x)).length > chunks.length * 0.6) break;
    }
  }
  aiAbort = null;
  if (aiCancelled) return;
  if (!acc.size) {
    openAi('AI 解析失败', `<div class="ai-sum">没有拿到可用的角色。</div>${errors.length ? `<div class="ai-err">${errors.slice(0, 5).map((e) => escapeAttr(e)).join('<br>')}</div>` : ''}`);
    return;
  }
  const results = aiResolve(acc);
  const canonOf = new Map();
  for (const r of results) {
    canonOf.set(r.name, r.name);
    for (const a of r.aliases) canonOf.set(a, r.name);
  }
  const stagesBy = aiBuildStages(chunkResults, canonOf);
  for (const r of results) r.stages = stagesBy.get(r.name) || [];
  const analyzedTo = chunkResults.reduce((m, c) => Math.max(m, c.to), win.start - 1);
  const allOk = !errors.some((e) => /^第 \d+ 段/.test(e));
  const meta = {
    firstPerson: fpSeen ? fpYes * 2 >= fpSeen : !!book.firstPerson,
    protagonist: aiTop(pVotes) || book.protagonist || '',
    from: win.start,
    to: analyzedTo,
    advanceTo: allOk ? analyzedTo : (book.ai?.analyzedTo ?? -1),
    total: win.total,
  };
  if (meta.protagonist === '我') meta.protagonist = '';
  aiShowPreview(results, meta, errors, chunks.length);
  toast(`AI 解析完成 · ${Math.round((Date.now() - t0) / 1000)} 秒`);
}

/* ---------------- 事件绑定 ---------------- */
function bind() {
  $('fileInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    toast('正在解析…', 60000);
    try {
      const buf = await file.arrayBuffer();
      const raw = decodeText(buf);
      const chapters = parseChapters(sanitizeText(raw));
      if (!chapters.length) throw new Error('没读出正文');
      const title = file.name.replace(/\.txt$/i, '');
      const analysis = analyzeBook(raw);
      const b = {
        id: uid(),
        title,
        chapters,
        detected: analysis.names,
        firstPerson: analysis.firstPerson,
        protagonist: analysis.protagonist,
        cast: null,
        aliases: {},
        createdAt: Date.now(),
      };
      if (analysis.firstPerson && analysis.protagonist && analysis.protagonist !== '我') {
        b.aliases['我'] = analysis.protagonist;
      }
      b.cast = defaultCast(b);
      await idb.put('books', b);
      await renderShelf();
      await openBook(b.id);
      $('toast').hidden = true;
      toast(`解析完成：${chapters.length} 章`);
    } catch (err) {
      $('toast').hidden = true;
      toast('导入失败：' + (err.message || err), 4000);
    }
  });

  $('tabbar').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    const nav = btn.dataset.nav;
    if (nav === 'shelf') { showView('shelf'); renderShelf(); }
    else if (nav === 'book') { if (!book) { toast('先选一本书'); return; } showView('book'); }
    else if (nav === 'player') { if (!book) { toast('先选一本书'); return; } showView('player'); renderPlayer(); }
    else { showView('settings'); renderSettings(); }
  });

  $('pbMain').addEventListener('click', () => { if (book) { showView('player'); renderSegHighlight(); } });
  $('btnPlay').addEventListener('click', togglePlay);
  $('btnPrev').addEventListener('click', () => playIndex(currentSeg - 1));
  $('btnNext').addEventListener('click', () => playIndex(currentSeg + 1));

  $('btnSaveSettings').addEventListener('click', () => {
    saveSettings({
      apiKey: $('apiKey').value.trim(),
      baseUrl: $('baseUrl').value.trim() || DEFAULT_BASE,
      singleVoice: $('singleVoice').checked,
      keepAwake: $('keepAwake').checked,
    });
    toast('已保存');
  });

  $('btnTest').addEventListener('click', async () => {
    saveSettings({ apiKey: $('apiKey').value.trim(), baseUrl: $('baseUrl').value.trim() || DEFAULT_BASE });
    $('btnTest').textContent = '合成中…';
    try {
      const blob = await requestTTS('你好，这是语音合成测试。', '冰糖', '', '');
      if (previewAudio) previewAudio.pause();
      previewAudio = new Audio(URL.createObjectURL(blob));
      await previewAudio.play();
      toast('合成成功');
    } catch (e) {
      toast('失败：' + (e.message || e), 4000);
    } finally {
      $('btnTest').textContent = '测试合成';
    }
  });

  $('btnSaveAi').addEventListener('click', () => {
    saveAi({
      baseUrl: $('aiBaseUrl').value.trim().replace(/\/+$/, ''),
      key: $('aiKey').value.trim(),
      model: $('aiModel').value.trim(),
    });
    toast('AI 配置已保存');
  });

  $('btnAiTest').addEventListener('click', async () => {
    saveAi({
      baseUrl: $('aiBaseUrl').value.trim().replace(/\/+$/, ''),
      key: $('aiKey').value.trim(),
      model: $('aiModel').value.trim(),
    });
    const btn = $('btnAiTest');
    btn.textContent = '测试中…';
    btn.disabled = true;
    try {
      const out = await aiChat([{ role: 'user', content: '只回复两个字母：OK' }], {});
      toast('连接成功：' + String(out).trim().slice(0, 20), 4000);
    } catch (e) {
      toast('连接失败：' + (e.message || e), 6000);
    } finally {
      btn.textContent = '连接测试';
      btn.disabled = false;
    }
  });

  $('aiClose').addEventListener('click', closeAi);
  $('aiCancel').addEventListener('click', closeAi);
  $('aiApply').addEventListener('click', aiApplySelection);

  $('btnAiNudge').addEventListener('click', aiAnalyzeBook);
  $('btnAiNudgeLater').addEventListener('click', () => {
    if (book?.ai) { book.ai.nudgeDismissedTo = book.ai.analyzedTo; saveBookSoon(); }
    $('aiNudge').hidden = true;
  });

  $('btnClearCache').addEventListener('click', async () => {
    if (!confirm('清空所有已合成的音频缓存？（书籍和进度保留）')) return;
    await idb.clear('audio');
    clearUrlCache();
    updateCacheInfo();
    toast('缓存已清空');
  });

  $('singleVoice').addEventListener('change', () => {
    saveSettings({ singleVoice: $('singleVoice').checked });
    clearUrlCache();
    toast($('singleVoice').checked ? '已切换为单音色' : '已按角色分音色');
  });

  $('keepAwake').addEventListener('change', () => {
    saveSettings({ keepAwake: $('keepAwake').checked });
    if (!$('keepAwake').checked) releaseWakeLock();
  });

  document.querySelectorAll('.seg-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.seg-tab').forEach(t => t.classList.toggle('active', t === tab));
      $('chaptersPanel').hidden = tab.dataset.tab !== 'chapters';
      $('castPanel').hidden = tab.dataset.tab !== 'cast';
      if (tab.dataset.tab === 'cast') renderCast();
    });
  });
}

/* ---------------- 启动 ---------------- */
(async function init() {
  try {
    db = await openDB();
  } catch (e) {
    toast('浏览器不支持本地存储', 6000);
    return;
  }
  bind();
  await renderShelf();
  showView('shelf');
  $('topTitle').textContent = 'TXT 听书';

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      reloading = true;
      location.reload();
    });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
