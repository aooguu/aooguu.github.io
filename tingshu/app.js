/* TXT 听书 — 本地解析 + 小米 MiMo TTS 合成 */

const DEFAULT_BASE = 'https://api.xiaomimimo.com/v1';
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

/* ---------------- IndexedDB ---------------- */
let db = null;
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('tingshu', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('books')) d.createObjectStore('books', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('audio')) {
        const s = d.createObjectStore('audio', { keyPath: 'key' });
        s.createIndex('bookId', 'bookId');
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

const VERB_SRC = '说道|问道|答道|笑道|冷笑道|苦笑道|淡淡道|轻声道|沉声道|怒道|叹道|解释道|补充道|反问道|嘟囔|嘀咕|低语|大喊|喊道|叫道|嚷道|开口|回答|说|道|问|答|喊|叫';
const LEAD_TIME = /^(?:这时|此时|那时|随后|接着|于是|只见|忽然|突然|随即|然后|终于|忍不住|不由得|不禁)/;
const NAME_STOP = new Set(['他们', '她们', '它们', '我们', '你们', '大家', '众人', '两人', '三人', '那人', '此人', '有人', '没人', '对方', '自己', '所有', '声音', '目光', '眼中', '心里', '嘴角', '脸上', '一边', '一声', '一句', '一眼', '一脸', '沉默', '不知', '只是', '现在', '刚才', '果然', '似乎', '仿佛', '好像', '一时', '半天', '突然', '忽然', '接着', '然后', '于是', '男人', '女人', '老者', '少年', '少女', '青年', '孩子', '姑娘', '公子', '小姐', '先生', '夫人', '道士', '和尚', '黑衣', '白衣', '中年', '老人', '小孩']);
const NAME_BAD_END = /[着了的地得道说问答喊叫笑道]/;
const ROLE_PREFIX = /^(?:男人|女人|老者|少年|少女|青年|孩子|姑娘|公子|小姐|先生|夫人|道士|和尚|众人|两人|三人|那人|此人|有人|对方|自己|黑衣|白衣|中年|老人|小孩)/;
const VERB_START = /[说问答道笑看转抬握皱点摇走站坐低轻沉缓慢又便才却也则就忙连急忽突随终忍不禁正还在把被拿给让叫想听望盯叹哼怒微淡]/;

function isPlausibleName(n) {
  if (!n || n.length < 2 || n.length > 3) return false;
  if (NAME_STOP.has(n)) return false;
  if (NAME_BAD_END.test(n)) return false;
  if (/[0-9a-zA-Z，。！？；：、\s]/.test(n)) return false;
  return true;
}
function subjectFromClause(clause, known) {
  let s = clause.trim().replace(/^[\s，。；：、！？“”「」『』]+/, '');
  if (!s) return null;
  s = s.replace(LEAD_TIME, '');
  if (!s) return null;

  if (known) {
    for (let len = Math.min(4, s.length); len >= 2; len--) {
      const c = s.slice(0, len);
      if (known.has(c)) return c;
    }
  }
  if (/^[他她它我你您]/u.test(s)) return null;
  if (VERB_START.test(s[0])) return null;

  const f3 = s.slice(0, 3);
  const f2 = s.slice(0, 2);
  let cand = f3;
  if (f3.length === 3 && VERB_START.test(f3[2])) cand = f2;
  if (!isPlausibleName(cand)) cand = f2;
  if (!isPlausibleName(cand)) return null;
  if (ROLE_PREFIX.test(cand)) return null;
  return cand;
}

function collectNames(text, cap = 400) {
  const counts = new Map();
  const re = new RegExp(VERB_SRC, 'g');
  let m, guard = 0;
  while ((m = re.exec(text)) && guard++ < 20000) {
    const before = text.slice(Math.max(0, m.index - 45), m.index);
    const tail = before.split(/[。！？；\n”」』]/).pop() || '';
    const parts = tail.split(/[，、：:]/).map(x => x.trim()).filter(Boolean);
    let name = null;
    for (let i = parts.length - 1; i >= 0; i--) {
      name = subjectFromClause(parts[i], null);
      if (name) break;
    }
    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, cap)
    .map(([name, count]) => ({ name, count }));
}

function detectSpeaker(p, q, last, known) {
  const before = p.slice(Math.max(0, q.start - 90), q.start);
  const after = p.slice(q.end, Math.min(p.length, q.end + 40));
  const b = speakerFromContext(before, known, true);
  if (b) return b;
  const a = speakerFromContext(after, known, false);
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
  const V = '(?:说道|问道|答道|笑道|冷笑道|苦笑道|淡淡道|轻声道|沉声道|怒道|叹道|解释道|补充道|反问道|嘟囔|嘀咕|低语|大喊|喊道|叫道|嚷道|开口|回答|说|道|问|答|喊|叫)';
  let t = s.replace(new RegExp(`[，,]\\s*[^，。！？；]{0,8}${V}\\s*[：:]\\s*$`), '');
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
  known.delete('旁白'); known.delete('未知角色');
  const paras = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const segs = [];
  let last = null;
  const push = (speaker, raw) => {
    const t = sanitize(raw);
    if (!t) return;
    for (const piece of splitLong(t, 240)) segs.push({ speaker: canonical(speaker), text: piece });
  };
  for (const p of paras) {
    const quotes = findQuotes(p);
    if (!quotes.length) { push('旁白', p); continue; }
    let cursor = 0;
    for (const q of quotes) {
      if (q.start > cursor) {
        const nar = p.slice(cursor, q.start);
        if (nar.trim()) push('旁白', trimSpeechTail(nar));
      }
      const sp = detectSpeaker(p, q, last, known);
      if (sp) last = sp;
      push(sp || '未知角色', q.text);
      cursor = q.end;
    }
    if (cursor < p.length) {
      const tail = p.slice(cursor);
      if (tail.trim()) push('旁白', tail);
    }
  }
  return segs;
}

function defaultCast(b) {
  const cast = { '旁白': { voice: '冰糖', style: NARRATOR_STYLE } };
  const pool = ['苏打', '茉莉', '白桦', '冰糖'];
  let i = 0;
  for (const d of b.detected || []) {
    if (d.count < 2) continue;
    cast[d.name] = { voice: pool[i++ % pool.length], style: '' };
  }
  return cast;
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
async function requestTTS(text, voice, style, signal) {
  const s = loadSettings();
  const apiKey = (s.apiKey || '').trim();
  if (!apiKey) throw new Error('请先在设置里填写 API Key');
  const base = (s.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  const messages = [];
  if (style && style.trim()) messages.push({ role: 'user', content: style.trim() });
  messages.push({ role: 'assistant', content: text });

  const body = JSON.stringify({ model: 'mimo-v2.5-tts', messages, audio: { format: 'mp3', voice } });
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

async function getSegmentAudio(seg) {
  const b = book;
  const s = loadSettings();
  let voice = '冰糖', style = '';
  if (!s.singleVoice) {
    const entry = (b.cast || {})[seg.speaker];
    voice = entry?.voice || (seg.speaker === '旁白' ? '冰糖' : '苏打');
    style = entry?.style || '';
  }
  const key = await hashKey([b.id, voice, style, seg.text].join('\u0000'));
  const rec = await idb.get('audio', key);
  if (rec?.blob) return rec.blob;
  const blob = await requestTTS(seg.text, voice, style);
  await idb.put('audio', { key, bookId: b.id, blob, size: blob.size, createdAt: Date.now() });
  return blob;
}

function clearUrlCache() {
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
  if (goPlayer) showView('player');
}

function castList() {
  const map = new Map();
  for (const d of book.detected || []) {
    const name = canonical(d.name);
    if (!map.has(name)) map.set(name, { count: 0, raw: new Set() });
    const v = map.get(name);
    v.count += d.count;
    v.raw.add(d.name);
  }
  for (const name of Object.keys(book.cast || {})) {
    if (!map.has(name)) map.set(name, { count: 0, raw: new Set([name]) });
  }
  map.delete('旁白');
  return [...map.entries()].sort((a, b) => b[1].count - a[1].count);
}

function voiceOptions(selected) {
  return VOICES.map(v => `<option value="${v.id}"${v.id === selected ? ' selected' : ''}>${v.label}</option>`).join('');
}

function renderCast() {
  const panel = $('castPanel');
  const rows = castList();
  const narrator = (book.cast || {})['旁白'] || { voice: '冰糖', style: NARRATOR_STYLE };
  panel.innerHTML = `
    <div class="cast-head">
      <span>共识别 ${rows.length} 个角色 · 点音色更换</span>
      <button class="mini-btn" id="btnAddCast">＋ 角色</button>
    </div>
    <div class="cast-row" data-name="旁白">
      <div class="cast-top">
        <input class="cast-name" value="旁白" readonly>
        <span class="cast-count">叙述</span>
      </div>
      <div class="cast-grid">
        <select class="cast-voice">${voiceOptions(narrator.voice)}</select>
        <input class="cast-style" placeholder="语气指令（可留空）" value="${escapeAttr(narrator.style || '')}">
        <button class="mini-btn cast-preview">试听</button>
      </div>
    </div>
    ${rows.map(([name, info]) => {
      const e = (book.cast || {})[name] || { voice: '苏打', style: '' };
      return `<div class="cast-row" data-name="${escapeAttr(name)}">
        <div class="cast-top">
          <input class="cast-name" value="${escapeAttr(name)}">
          <span class="cast-count">${info.count || 0} 句</span>
        </div>
        <div class="cast-grid">
          <select class="cast-voice">${voiceOptions(e.voice)}</select>
          <input class="cast-style" placeholder="语气指令（可留空）" value="${escapeAttr(e.style || '')}">
          <button class="mini-btn cast-preview">试听</button>
        </div>
      </div>`;
    }).join('')}
    <p class="cast-note">对白说话人靠规则识别，可能不准。改名字会把同名的话合并；不确定的角色给旁白音色即可。</p>`;

  panel.querySelectorAll('.cast-row').forEach(row => {
    const name = row.dataset.name;
    row.querySelector('.cast-voice').addEventListener('change', (e) => {
      book.cast[name] = book.cast[name] || { voice: '苏打', style: '' };
      book.cast[name].voice = e.target.value;
      saveBookSoon();
    });
    row.querySelector('.cast-style').addEventListener('change', (e) => {
      book.cast[name] = book.cast[name] || { voice: '苏打', style: '' };
      book.cast[name].style = e.target.value.trim();
      saveBookSoon();
    });
    row.querySelector('.cast-preview').addEventListener('click', () => {
      const voice = row.querySelector('.cast-voice').value;
      const style = row.querySelector('.cast-style').value.trim();
      const who = name === '旁白' ? '旁白' : name;
      previewVoice(`你好，我是${who}。`, voice, style);
    });
    row.querySelector('.cast-name').addEventListener('change', (e) => {
      if (name === '旁白') return;
      const newName = e.target.value.trim();
      if (!newName || newName === name) { e.target.value = name; return; }
      renameSpeaker(name, newName);
    });
  });
  $('btnAddCast').addEventListener('click', () => {
    const name = prompt('角色名（和对白里的名字一致）');
    if (!name || !name.trim()) return;
    const n = name.trim();
    book.cast[n] = { voice: '苏打', style: '' };
    saveBookSoon();
    renderCast();
  });
}

function renameSpeaker(oldName, newName) {
  book.aliases[oldName] = newName;
  if (book.cast[oldName]) { book.cast[newName] = book.cast[oldName]; delete book.cast[oldName]; }
  if (!book.cast[newName]) book.cast[newName] = { voice: '苏打', style: '' };
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

async function previewVoice(text, voice, style) {
  toast('合成中…', 6000);
  try {
    const blob = await requestTTS(text, voice, style);
    if (previewAudio) { previewAudio.pause(); }
    previewAudio = new Audio(URL.createObjectURL(blob));
    previewAudio.play();
    $('toast').hidden = true;
  } catch (e) {
    toast('试听失败：' + (e.message || e));
  }
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
      const text = decodeText(buf);
      const chapters = parseChapters(text);
      if (!chapters.length) throw new Error('没读出正文');
      const title = file.name.replace(/\.txt$/i, '');
      const b = {
        id: uid(),
        title,
        chapters,
        detected: collectNames(text),
        cast: null,
        aliases: {},
        createdAt: Date.now(),
      };
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
      const blob = await requestTTS('你好，这是语音合成测试。', '冰糖', '');
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
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
