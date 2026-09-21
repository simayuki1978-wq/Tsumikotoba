'use strict';
/* ===== つみことば — app logic ===== */

const DAY_MS = 86400000;
const INTERVAL_DAYS = [1, 3, 7, 14, 30, 90]; // 忘却曲線ベースの復習間隔
const DAILY_NEW_WORDS = 10;
const DAILY_NEW_KANJI = 3;
const XP_PER_LEVEL = 150;
const DARUMA_MILESTONES = [3, 7, 14, 30, 60, 100, 200, 365];
const STORAGE_KEY = 'tsumikotoba_v1';

const POS_COLOR = { '動詞': 'var(--teal)', '形容詞': 'var(--gold)', '名詞': 'var(--grape)', '漢字': 'var(--sky)' };
const POS_COLOR_DEEP = { '動詞': 'var(--teal-deep)', '形容詞': 'var(--gold-deep)', '名詞': 'var(--grape-deep)', '漢字': 'var(--sky-deep)' };

/* ---------------- unify data ---------------- */
const UNI = [];
WORDS.forEach(w => {
  const u = {
    id: w.id, type: 'word', pos: w.pos, front: w.word, reading: w.reading,
    meaning: w.meaning, example: w.example, level: w.level
  };
  if (w.pos === '動詞') { u.vtype = w.type; u.conj = w.conj; }
  UNI.push(u);
});
KANJI.forEach(k => {
  UNI.push({
    id: k.id, type: 'kanji', pos: '漢字', front: k.char, reading: k.on,
    onyomi: k.on, kunyomi: k.kun, meaning: k.meaning, example: k.compound,
    strokes: k.strokes, level: k.level
  });
});
const UNI_BY_ID = {};
UNI.forEach(u => UNI_BY_ID[u.id] = u);

const WORD_POOL = {
  '動詞': UNI.filter(u => u.pos === '動詞'),
  '形容詞': UNI.filter(u => u.pos === '形容詞'),
  '名詞': UNI.filter(u => u.pos === '名詞')
};
const KANJI_POOL = UNI.filter(u => u.pos === '漢字');
const WORD_CATS = ['動詞', '形容詞', '名詞'];
const TOTAL_WORDS = WORDS.length;
const TOTAL_KANJI = KANJI.length;

function getByFilter(filter) {
  if (filter === '漢字') return KANJI_POOL;
  if (filter === 'all') return UNI.filter(u => u.pos !== '漢字');
  return WORD_POOL[filter] || [];
}

/* ---------------- state ---------------- */
function defaultState() {
  return {
    srs: {},
    xp: 0,
    streak: { current: 0, longest: 0, lastActiveDate: null, daruma: [] },
    daily: { date: null, newWords: 0, newKanji: 0, bonusClaimed: false, reviewGoal: 0, reviewDone: 0 },
    courseAcc: { '動詞': 0, '形容詞': 0, '名詞': 0 },
    introducedCount: { '動詞': 0, '形容詞': 0, '名詞': 0, '漢字': 0 }
  };
}
let STATE = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    const base = defaultState();
    return Object.assign(base, parsed, {
      srs: Object.assign({}, parsed.srs || {}),
      streak: Object.assign(base.streak, parsed.streak || {}),
      daily: Object.assign(base.daily, parsed.daily || {}),
      courseAcc: Object.assign(base.courseAcc, parsed.courseAcc || {}),
      introducedCount: Object.assign(base.introducedCount, parsed.introducedCount || {})
    });
  } catch (e) {
    console.error('load failed', e);
    return defaultState();
  }
}
function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(STATE)); }
  catch (e) { console.error('save failed', e); }
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function todayStr(d) { d = d || new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function isDue(id) { const s = STATE.srs[id]; return !!(s && s.seen && s.due <= Date.now()); }
function dueCountAll() { return UNI.filter(u => isDue(u.id)).length; }
function levelOf(xp) { return Math.floor(xp / XP_PER_LEVEL) + 1; }

function ensureDaily() {
  const t = todayStr();
  if (STATE.daily.date !== t) {
    STATE.daily = { date: t, newWords: 0, newKanji: 0, bonusClaimed: false, reviewGoal: dueCountAll(), reviewDone: 0 };
    saveState();
  }
}
function touchStreak() {
  const t = todayStr();
  if (STATE.streak.lastActiveDate === t) return;
  const yest = todayStr(new Date(Date.now() - DAY_MS));
  if (STATE.streak.lastActiveDate === yest) STATE.streak.current += 1;
  else STATE.streak.current = 1;
  STATE.streak.longest = Math.max(STATE.streak.longest, STATE.streak.current);
  STATE.streak.lastActiveDate = t;
  STATE.justEarnedDaruma = null;
  DARUMA_MILESTONES.forEach(m => {
    if (STATE.streak.current >= m && !STATE.streak.daruma.find(d => d.days === m)) {
      STATE.streak.daruma.push({ days: m, date: t });
      STATE.justEarnedDaruma = m;
    }
  });
  saveState();
}

/* ---------------- new-item pacing (course design) ---------------- */
function pickNextCategory() {
  const avail = WORD_CATS.filter(c => STATE.introducedCount[c] < WORD_POOL[c].length);
  if (avail.length === 0) return null;
  const totalW = avail.reduce((s, c) => s + WORD_POOL[c].length, 0);
  avail.forEach(c => { STATE.courseAcc[c] = (STATE.courseAcc[c] || 0) + WORD_POOL[c].length; });
  let chosen = avail[0];
  avail.forEach(c => { if (STATE.courseAcc[c] > STATE.courseAcc[chosen]) chosen = c; });
  STATE.courseAcc[chosen] -= totalW;
  return chosen;
}
function introduceItem(item, catKey) {
  STATE.introducedCount[catKey]++;
  STATE.srs[item.id] = { box: 0, due: 0, seen: true, correct: 0, wrong: 0 };
  saveState();
}
function getNextNewWordAuto() {
  if (STATE.daily.newWords >= DAILY_NEW_WORDS) return null;
  const cat = pickNextCategory();
  if (!cat) return null;
  const idx = STATE.introducedCount[cat];
  const item = WORD_POOL[cat][idx];
  introduceItem(item, cat);
  STATE.daily.newWords++;
  saveState();
  return item;
}
function getNextNewWordForCat(cat) {
  if (STATE.daily.newWords >= DAILY_NEW_WORDS) return null;
  const idx = STATE.introducedCount[cat];
  if (idx >= WORD_POOL[cat].length) return null;
  const item = WORD_POOL[cat][idx];
  introduceItem(item, cat);
  STATE.daily.newWords++;
  saveState();
  return item;
}
function getNextNewKanji() {
  if (STATE.daily.newKanji >= DAILY_NEW_KANJI) return null;
  const idx = STATE.introducedCount['漢字'];
  if (idx >= KANJI_POOL.length) return null;
  const item = KANJI_POOL[idx];
  introduceItem(item, '漢字');
  STATE.daily.newKanji++;
  saveState();
  return item;
}
function getNextNew(filter) {
  if (filter === '漢字') return getNextNewKanji();
  if (filter === 'all') return getNextNewWordAuto();
  return getNextNewWordForCat(filter);
}
function previewNewRemaining(filter) {
  if (filter === '漢字') return Math.max(0, Math.min(DAILY_NEW_KANJI - STATE.daily.newKanji, TOTAL_KANJI - STATE.introducedCount['漢字']));
  if (filter === 'all') {
    const poolLeft = WORD_CATS.reduce((s, c) => s + Math.max(0, WORD_POOL[c].length - STATE.introducedCount[c]), 0);
    return Math.max(0, Math.min(DAILY_NEW_WORDS - STATE.daily.newWords, poolLeft));
  }
  return Math.max(0, Math.min(DAILY_NEW_WORDS - STATE.daily.newWords, WORD_POOL[filter].length - STATE.introducedCount[filter]));
}
function previewDue(filter) { return getByFilter(filter).filter(u => isDue(u.id)).length; }
function totalIntroducedWords() { return WORD_CATS.reduce((s, c) => s + STATE.introducedCount[c], 0); }

/* ---------------- SRS rating ---------------- */
function applyResult(id, outcome, wasReview) {
  let s = STATE.srs[id];
  if (!s) { s = { box: 0, due: 0, seen: true, correct: 0, wrong: 0 }; STATE.srs[id] = s; }
  const now = Date.now();
  if (outcome === 'again') { s.box = 0; s.due = now; s.wrong++; }
  else if (outcome === 'soft') { s.due = now + INTERVAL_DAYS[Math.max(s.box, 0)] * DAY_MS; s.correct++; }
  else { s.box = Math.min(s.box + 1, INTERVAL_DAYS.length - 1); s.due = now + INTERVAL_DAYS[s.box] * DAY_MS; s.correct++; }
  s.seen = true;
  if (wasReview) STATE.daily.reviewDone++;
  saveState();
}
function addXP(n) { STATE.xp += n; saveState(); }

/* ---------------- helpers ---------------- */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function sampleDistractors(correctItem, field, count) {
  let cand = UNI.filter(x => x.id !== correctItem.id && x.pos === correctItem.pos && x[field] && x[field] !== correctItem[field]);
  cand = shuffle(cand);
  let picks = cand.slice(0, count);
  if (picks.length < count) {
    let more = UNI.filter(x => x.id !== correctItem.id && x[field] && x[field] !== correctItem[field] && picks.indexOf(x) === -1);
    more = shuffle(more);
    picks = picks.concat(more.slice(0, count - picks.length));
  }
  return picks.map(x => x[field]);
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ---------------- build session queue ---------------- */
function buildQueue(filter, size) {
  size = size || 12;
  const pool = getByFilter(filter);
  const due = pool.filter(u => isDue(u.id));
  due.sort((a, b) => STATE.srs[a.id].due - STATE.srs[b.id].due);
  const entries = due.slice(0, size).map(it => ({ item: it, isReview: true }));
  while (entries.length < size) {
    const item = getNextNew(filter);
    if (!item) break;
    entries.push({ item: item, isReview: false });
  }
  if (entries.length < size) {
    const already = new Set(entries.map(e => e.item.id));
    let rest = pool.filter(u => STATE.srs[u.id] && STATE.srs[u.id].seen && !isDue(u.id) && !already.has(u.id));
    rest.sort((a, b) => STATE.srs[a.id].due - STATE.srs[b.id].due);
    rest.slice(0, size - entries.length).forEach(it => entries.push({ item: it, isReview: false, bonus: true }));
  }
  return entries;
}
function buildReviewOnlyQueue(cap) {
  const due = UNI.filter(u => isDue(u.id));
  due.sort((a, b) => STATE.srs[a.id].due - STATE.srs[b.id].due);
  return due.slice(0, cap || 25).map(it => ({ item: it, isReview: true }));
}

/* ---------------- quiz / drill question builders ---------------- */
function buildQuizQuestion(item) {
  const types = ['meaning', 'front', 'reading'];
  const t = types[Math.floor(Math.random() * types.length)];
  let answerField = t === 'meaning' ? 'meaning' : (t === 'front' ? 'front' : 'reading');
  const promptLabel = t === 'meaning' ? '意味はどれ？' : (t === 'front' ? (item.type === 'kanji' ? '正しい漢字はどれ？' : '正しいことばはどれ？') : '読み方はどれ？');
  const correct = item[answerField];
  const distractors = sampleDistractors(item, answerField, 3);
  const options = shuffle([correct].concat(distractors));
  return { type: t, item: item, promptLabel: promptLabel, options: options, correctIndex: options.indexOf(correct) };
}
const FORM_KEYS = ['nai', 'masu', 'ba', 'you', 'te', 'ta'];
const FORM_LABELS = { nai: 'ない形', masu: 'ます形', ba: 'ば形', you: 'よう形（意向形）', te: 'て形', ta: 'た形' };
function buildDrillQuestion(item) {
  const key = FORM_KEYS[Math.floor(Math.random() * FORM_KEYS.length)];
  const correct = item.conj[key];
  let others = FORM_KEYS.filter(k => k !== key);
  others = shuffle(others).slice(0, 3);
  const distractors = others.map(k => item.conj[k]);
  const options = shuffle([correct].concat(distractors));
  return { key: key, label: FORM_LABELS[key], item: item, options: options, correctIndex: options.indexOf(correct) };
}

/* ---------------- transient UI state ---------------- */
let CURRENT_VIEW = 'home';
let CURRENT_TAB = 'home';
let CONFIG = { mode: null, filter: 'all' };
let SESSION = null;
let SEARCH_STATE = { query: '', filter: 'all', openId: null };

function go(view) { CURRENT_VIEW = view; render(); try { window.scrollTo(0, 0); } catch (e) { } }
window.showTab = function (tab) { CURRENT_TAB = tab; go(tab); };
window.goHome = function () { CURRENT_TAB = 'home'; go('home'); };
window.goBack = function () {
  if (CURRENT_VIEW === 'session' && !confirm('学習をやめてホームに戻りますか？')) return;
  go(CURRENT_TAB);
};

window.startConfig = function (mode) {
  CONFIG = { mode: mode, filter: mode === 'verbdrill' ? '動詞' : 'all' };
  go('config');
};
window.startConfigKanji = function () { CONFIG = { mode: 'flashcard', filter: '漢字' }; go('config'); };
window.setFilter = function (pos) { CONFIG.filter = pos; render(); };

window.beginSession = function () {
  ensureDaily();
  const queue = buildQueue(CONFIG.filter, CONFIG.mode === 'kanjicard' ? 10 : 12);
  if (queue.length === 0) { render(); return; }
  SESSION = {
    mode: CONFIG.mode, filter: CONFIG.filter, queue: queue, idx: 0,
    flipped: false, answered: false, correct: 0, wrong: 0, xp: 0,
    combo: 0, maxCombo: 0, startLevel: levelOf(STATE.xp), startXP: STATE.xp,
    q: null, d: null, earnedDarumaShown: false
  };
  prepCurrent();
  go('session');
};
window.beginReview = function () {
  ensureDaily();
  const queue = buildReviewOnlyQueue(25);
  CONFIG = { mode: 'review', filter: 'all' };
  if (queue.length === 0) { go('home'); return; }
  SESSION = {
    mode: 'review', filter: 'all', queue: queue, idx: 0, flipped: false, answered: false,
    correct: 0, wrong: 0, xp: 0, combo: 0, maxCombo: 0, startLevel: levelOf(STATE.xp), startXP: STATE.xp,
    q: null, d: null
  };
  prepCurrent();
  go('session');
};
function prepCurrent() {
  if (!SESSION) return;
  const entry = SESSION.queue[SESSION.idx];
  if (!entry) return;
  SESSION.flipped = false; SESSION.answered = false;
  if (SESSION.mode === 'quiz') SESSION.q = buildQuizQuestion(entry.item);
  else if (SESSION.mode === 'verbdrill') SESSION.d = buildDrillQuestion(entry.item);
}

window.flipCard = function () { if (!SESSION) return; SESSION.flipped = !SESSION.flipped; render(); };
window.rateCard = function (outcome) {
  if (!SESSION) return;
  const entry = SESSION.queue[SESSION.idx];
  applyResult(entry.item.id, outcome, entry.isReview);
  const gain = outcome === 'again' ? 2 : (outcome === 'soft' ? 5 : 10);
  SESSION.xp += gain; addXP(gain);
  if (outcome === 'again') { SESSION.wrong++; SESSION.combo = 0; } else { SESSION.correct++; SESSION.combo++; SESSION.maxCombo = Math.max(SESSION.maxCombo, SESSION.combo); }
  advance();
};
window.selectQuizOption = function (idx) {
  if (!SESSION || SESSION.answered) return;
  SESSION.answered = true;
  const entry = SESSION.queue[SESSION.idx];
  const ok = idx === SESSION.q.correctIndex;
  applyResult(entry.item.id, ok ? 'good' : 'again', entry.isReview);
  const gain = ok ? 10 : 2;
  SESSION.xp += gain; addXP(gain);
  if (ok) { SESSION.correct++; SESSION.combo++; SESSION.maxCombo = Math.max(SESSION.maxCombo, SESSION.combo); }
  else { SESSION.wrong++; SESSION.combo = 0; }
  SESSION.selectedIdx = idx;
  render();
};
window.selectDrillOption = function (idx) {
  if (!SESSION || SESSION.answered) return;
  SESSION.answered = true;
  const entry = SESSION.queue[SESSION.idx];
  const ok = idx === SESSION.d.correctIndex;
  applyResult(entry.item.id, ok ? 'good' : 'again', entry.isReview);
  const gain = ok ? 12 : 2;
  SESSION.xp += gain; addXP(gain);
  if (ok) { SESSION.correct++; SESSION.combo++; SESSION.maxCombo = Math.max(SESSION.maxCombo, SESSION.combo); }
  else { SESSION.wrong++; SESSION.combo = 0; }
  SESSION.selectedIdx = idx;
  render();
};
window.nextQuestion = function () { advance(); };
function advance() {
  SESSION.idx++;
  if (SESSION.idx >= SESSION.queue.length) {
    SESSION.justDaruma = STATE.justEarnedDaruma || null;
    STATE.justEarnedDaruma = null; saveState();
    const endLevel = levelOf(STATE.xp);
    if (endLevel > SESSION.startLevel && !SESSION.levelupShown) { SESSION.levelupShown = true; go('levelup'); return; }
    go('summary');
    return;
  }
  prepCurrent();
  render();
}
window.finishLevelup = function () { go('summary'); };
window.restartSession = function () { go('config'); };

/* ---------------- search ---------------- */
window.onSearchInput = function (val) { SEARCH_STATE.query = val; render(); };
window.setSearchFilter = function (pos) { SEARCH_STATE.filter = pos; render(); };
window.toggleListItem = function (id) { SEARCH_STATE.openId = SEARCH_STATE.openId === id ? null : id; render(); };

/* ---------------- small visual helpers ---------------- */
function darumaSVG(earned, label) {
  const eyeFill = earned ? '#232019' : 'none';
  const eyeStroke = earned ? 'none' : 'var(--ink-soft)';
  const body = earned ? 'var(--coral)' : 'var(--line)';
  const bodyDeep = earned ? 'var(--coral-deep)' : 'var(--line)';
  const belt = earned ? 'var(--gold)' : 'var(--line)';
  const beltTxt = earned ? '#ffffff' : 'var(--ink-soft)';
  return '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
    '<ellipse cx="50" cy="58" rx="36" ry="32" fill="' + body + '"/>' +
    '<path d="M16 54 Q50 16 84 54 L84 60 Q50 26 16 60 Z" fill="' + bodyDeep + '"/>' +
    '<ellipse cx="50" cy="55" rx="21" ry="19" fill="#fff8ee"/>' +
    '<path d="M32 46 Q38 38 46 44" stroke="#2b2620" stroke-width="3.5" fill="none" stroke-linecap="round"/>' +
    '<path d="M68 46 Q62 38 54 44" stroke="#2b2620" stroke-width="3.5" fill="none" stroke-linecap="round"/>' +
    '<circle cx="41" cy="57" r="4.2" fill="' + eyeFill + '" stroke="' + eyeStroke + '" stroke-width="2"/>' +
    '<circle cx="59" cy="57" r="4.2" fill="' + eyeFill + '" stroke="' + eyeStroke + '" stroke-width="2"/>' +
    '<path d="M37 67 Q50 63 63 67" stroke="#2b2620" stroke-width="2.5" fill="none" stroke-linecap="round" opacity="0.5"/>' +
    '<path d="M20 78 Q50 90 80 78 L80 90 Q50 100 20 90 Z" fill="' + belt + '"/>' +
    '<text x="50" y="89" font-size="15" font-weight="900" text-anchor="middle" fill="' + beltTxt + '" font-family="Zen Maru Gothic, sans-serif">' + esc(label) + '</text>' +
    '</svg>';
}
function progressGridSVG(items, cols, cell, gap) {
  cols = cols || 25; cell = cell || 7; gap = gap == null ? 1.5 : gap;
  const rows = Math.ceil(items.length / cols);
  const w = cols * (cell + gap); const h = rows * (cell + gap);
  let rects = '';
  items.forEach((it, i) => {
    const r = Math.floor(i / cols), c = i % cols;
    const s = STATE.srs[it.id];
    const box = (s && s.seen) ? s.box : -1;
    const op = box < 0 ? 0 : ((box + 1) / 6).toFixed(2);
    const fill = box < 0 ? 'none' : 'var(--coral)';
    rects += '<rect class="cell" x="' + (c * (cell + gap)) + '" y="' + (r * (cell + gap)) + '" width="' + cell + '" height="' + cell + '" rx="1.5" fill="' + fill + '" fill-opacity="' + op + '"/>';
  });
  return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" style="display:block">' + rects + '</svg>';
}
function confettiHTML() {
  const colors = ['var(--coral)', 'var(--teal)', 'var(--gold)', 'var(--grape)', 'var(--sky)'];
  let out = '<div class="confetti-wrap">';
  for (let i = 0; i < 18; i++) {
    const ang = Math.random() * Math.PI * 2;
    const dist = 60 + Math.random() * 90;
    const tx = Math.cos(ang) * dist; const ty = Math.sin(ang) * dist - 40;
    const rot = Math.floor(Math.random() * 360);
    const bg = colors[i % colors.length];
    const delay = (Math.random() * 0.15).toFixed(2);
    out += '<i style="background:' + bg + ';left:' + (45 + Math.random() * 10).toFixed(0) + '%;--tx:' + tx.toFixed(0) + 'px;--ty:' + ty.toFixed(0) + 'px;--rot:' + rot + 'deg;animation-delay:' + delay + 's"></i>';
  }
  out += '</div>';
  return out;
}
function greetingMessage() {
  const h = new Date().getHours();
  const timeGreet = h < 11 ? 'おはよう！' : (h < 18 ? 'こんにちは！' : 'こんばんは！');
  const streak = STATE.streak.current;
  const line = streak >= 2 ? ('<b>' + streak + '日連続</b>で学習中。今日も積み重ねよう。') : '今日から少しずつ、積み重ねよう。';
  return timeGreet + '<br>' + line;
}

/* ---------------- view renderers ---------------- */
function renderTopbar() {
  const sub = (CURRENT_VIEW === 'config' || CURRENT_VIEW === 'session' || CURRENT_VIEW === 'summary' || CURRENT_VIEW === 'levelup');
  if (sub) {
    const title = CONFIG.mode === 'flashcard' ? 'フラッシュカード' : CONFIG.mode === 'quiz' ? '4択クイズ' : CONFIG.mode === 'verbdrill' ? '動詞活用ドリル' : CONFIG.mode === 'review' ? '今日の復習' : '学習';
    return '<div class="topbar"><button class="back-btn" onclick="goBack()">← もどる</button><div class="stats"><span class="stat-chip">' + esc(title) + '</span></div></div>';
  }
  const lvl = levelOf(STATE.xp);
  return '<div class="topbar"><div class="brand pop">つみことば</div><div class="stats">' +
    '<span class="stat-chip">🔥 ' + STATE.streak.current + '</span>' +
    '<span class="stat-chip">⭐ Lv.' + lvl + '</span>' +
    '</div></div>';
}
function renderTabbar() {
  const tabs = [['home', '🏠', 'ホーム'], ['stamps', '🎎', 'だるま'], ['search', '🔍', 'さがす']];
  return '<div class="tabbar">' + tabs.map(function (t) {
    return '<button class="tab-btn ' + (CURRENT_TAB === t[0] ? 'active' : '') + '" onclick="showTab(\'' + t[0] + '\')"><span style="font-size:19px">' + t[1] + '</span>' + t[2] + '</button>';
  }).join('') + '</div>';
}

function renderHome() {
  ensureDaily();
  const lvl = levelOf(STATE.xp);
  const totalWords = totalIntroducedWords();
  const totalKanjiIntro = STATE.introducedCount['漢字'];
  const wordsMastered = UNI.filter(function (u) { return u.pos !== '漢字' && STATE.srs[u.id] && STATE.srs[u.id].box >= 4; }).length;
  const kanjiMastered = KANJI_POOL.filter(function (u) { return STATE.srs[u.id] && STATE.srs[u.id].box >= 4; }).length;
  const wordsLeftDays = Math.max(0, Math.ceil((TOTAL_WORDS - totalWords) / DAILY_NEW_WORDS));
  const kanjiLeftDays = Math.max(0, Math.ceil((TOTAL_KANJI - totalKanjiIntro) / DAILY_NEW_KANJI));

  const q1done = STATE.daily.newWords >= DAILY_NEW_WORDS || totalWords >= TOTAL_WORDS;
  const q2done = STATE.daily.newKanji >= DAILY_NEW_KANJI || totalKanjiIntro >= TOTAL_KANJI;
  const reviewGoal = Math.max(STATE.daily.reviewGoal, 0);
  const q3done = reviewGoal === 0 || STATE.daily.reviewDone >= reviewGoal;

  function ring(frac, color) {
    frac = Math.max(0, Math.min(1, frac));
    const r = 18, c = 2 * Math.PI * r;
    return '<div class="quest-ring"><svg viewBox="0 0 46 46"><circle class="bgc" cx="23" cy="23" r="' + r + '"/><circle class="fgc" cx="23" cy="23" r="' + r + '" stroke="' + color + '" stroke-dasharray="' + (frac * c).toFixed(1) + ' ' + c.toFixed(1) + '"/></svg></div>';
  }
  const q1ring = ring(totalWords >= TOTAL_WORDS ? 1 : STATE.daily.newWords / DAILY_NEW_WORDS, 'var(--coral)');
  const q2ring = ring(totalKanjiIntro >= TOTAL_KANJI ? 1 : STATE.daily.newKanji / DAILY_NEW_KANJI, 'var(--sky)');
  const q3ring = ring(reviewGoal === 0 ? 1 : STATE.daily.reviewDone / reviewGoal, 'var(--grape)');

  return '' +
    '<div class="greet-card"><div style="width:64px;height:64px;flex-shrink:0">' + darumaSVG(true, STATE.streak.current || 0) + '</div><div class="msg">' + greetingMessage() + '</div></div>' +
    '<div class="section-label">🎯 きょうのクエスト</div>' +
    '<div class="quest-row ' + (q1done ? 'done' : '') + '" onclick="startConfig(\'flashcard\')">' + q1ring + '<div class="quest-txt"><b>新しい単語</b><span>今日 ' + Math.min(STATE.daily.newWords, DAILY_NEW_WORDS) + ' / ' + DAILY_NEW_WORDS + '</span></div><div class="quest-check">' + (q1done ? '✅' : '') + '</div></div>' +
    '<div class="quest-row ' + (q2done ? 'done' : '') + '" onclick="startConfigKanji()">' + q2ring + '<div class="quest-txt"><b>新しい漢字</b><span>今日 ' + Math.min(STATE.daily.newKanji, DAILY_NEW_KANJI) + ' / ' + DAILY_NEW_KANJI + '</span></div><div class="quest-check">' + (q2done ? '✅' : '') + '</div></div>' +
    '<div class="quest-row ' + (q3done ? 'done' : '') + '" onclick="beginReview()">' + q3ring + '<div class="quest-txt"><b>きょうの復習</b><span>' + (q3done ? '終わったよ！' : ('残り ' + (reviewGoal - STATE.daily.reviewDone) + ' 件')) + '</span></div><div class="quest-check">' + (q3done ? '✅' : '') + '</div></div>' +
    '<div class="section-label">📚 学習モード</div>' +
    '<div class="mode-grid">' +
    '<button class="mode-btn" style="--c:var(--teal)" onclick="startConfig(\'flashcard\')"><div class="icon-badge">🗂️</div><div class="txt"><b>フラッシュカード</b><span>単語・漢字をめくって覚える</span></div></button>' +
    '<button class="mode-btn" style="--c:var(--grape)" onclick="startConfig(\'quiz\')"><div class="icon-badge">❓</div><div class="txt"><b>4択クイズ</b><span>意味・読み方に挑戦</span></div></button>' +
    '<button class="mode-btn" style="--c:var(--gold)" onclick="startConfig(\'verbdrill\')"><div class="icon-badge">🔄</div><div class="txt"><b>動詞活用ドリル</b><span>て形・ば形などを特訓</span></div></button>' +
    '</div>' +
    '<div class="section-label">📈 のび具合</div>' +
    '<div class="grid-wrap" style="margin-bottom:10px"><div class="cap"><span>単語 ' + totalWords + '/' + TOTAL_WORDS + '（覚えた ' + wordsMastered + '）</span><span class="pct">' + Math.round(totalWords / TOTAL_WORDS * 100) + '%</span></div>' + progressGridSVG(UNI.filter(function (u) { return u.pos !== '漢字'; }), 25, 7, 1.5) + '</div>' +
    '<div class="grid-wrap"><div class="cap"><span>漢字 ' + totalKanjiIntro + '/' + TOTAL_KANJI + '（覚えた ' + kanjiMastered + '）</span><span class="pct">' + Math.round(totalKanjiIntro / TOTAL_KANJI * 100) + '%</span></div>' + progressGridSVG(KANJI_POOL, 25, 7, 1.5) + '</div>' +
    '<p class="lead" style="margin-top:16px">このペースだと、単語は残り約' + wordsLeftDays + '日、漢字は残り約' + kanjiLeftDays + '日で全部おぼえ終わる予定だよ。毎日コツコツがいちばんの近道！</p>';
}

function renderConfig() {
  const mode = CONFIG.mode; const filter = CONFIG.filter;
  const chips = mode === 'verbdrill' ? [] : ['all', '動詞', '形容詞', '名詞', '漢字'];
  const due = previewDue(filter); const neu = previewNewRemaining(filter); const total = due + neu;
  const modeName = mode === 'flashcard' ? 'フラッシュカード' : mode === 'quiz' ? '4択クイズ' : '動詞活用ドリル';
  const modeDesc = mode === 'flashcard' ? 'カードをめくって、わかったら評価しよう。' : mode === 'quiz' ? '4つの選択肢から正しい答えをえらぼう。' : '動詞の活用形を当てるドリルだよ。';
  let chipsHTML = '';
  if (chips.length) {
    chipsHTML = '<div class="chip-row" style="margin-bottom:18px">' + chips.map(function (f) {
      const n = previewDue(f) + previewNewRemaining(f);
      const label = f === 'all' ? '全部(単語)' : f;
      return '<button class="chip ' + (f === filter ? 'active' : '') + '" style="--c:' + (POS_COLOR[f] || 'var(--coral)') + '" onclick="setFilter(\'' + f + '\')">' + label + '<span class="n">' + n + '</span></button>';
    }).join('') + '</div>';
  }
  return '' +
    '<h2 style="font-size:21px;margin-bottom:6px">' + modeName + '</h2>' +
    '<p class="lead">' + modeDesc + '</p>' +
    chipsHTML +
    '<div class="grid-wrap" style="margin-bottom:18px">' +
    '<div class="cap"><span>復習</span><span class="pct">' + due + '件</span></div>' +
    '<div class="cap" style="margin-top:6px"><span>新しく学ぶ（今日あと）</span><span class="pct">' + neu + '件</span></div>' +
    '</div>' +
    (total > 0
      ? '<button class="btn btn-primary" onclick="beginSession()">はじめる（' + Math.min(total, 12) + '問）</button>'
      : '<div class="empty-note"><span class="egg">🌙</span>今日の分はここまで！<br>また明日つづきをやろうね。</div>');
}

function renderSession() {
  if (!SESSION) return '<div class="empty-note">セッションがありません。</div>';
  const total = SESSION.queue.length;
  const pct = Math.round((SESSION.idx) / total * 100);
  const body = SESSION.mode === 'quiz' ? renderQuizBody() : SESSION.mode === 'verbdrill' ? renderDrillBody() : renderFlashBody();
  const comboHTML = SESSION.combo >= 3 ? ('<div class="combo-flare">🔥 ' + SESSION.combo + '連続！</div>') : '<div class="combo-flare"></div>';
  return '<div class="progress-track"><div class="progress-fill" style="width:' + pct + '%"></div></div>' + comboHTML + body;
}

function renderFlashBody() {
  const entry = SESSION.queue[SESSION.idx]; const item = entry.item;
  const c = POS_COLOR[item.pos] || 'var(--teal)';
  const isVerb = item.pos === '動詞'; const isKanji = item.type === 'kanji';
  let backContent;
  if (isKanji) {
    backContent = '<div class="back-meaning" style="color:' + POS_COLOR_DEEP['漢字'] + '">' + esc(item.meaning) + '</div>' +
      '<div class="kanji-meta"><div><span>音読み</span>' + esc(item.onyomi) + '</div><div><span>訓読み</span>' + esc(item.kunyomi) + '</div>' +
      '<div><span>画数</span>' + esc(item.strokes) + '画</div><div><span>熟語例</span>' + esc(item.example) + '</div></div>';
  } else {
    backContent = '<div class="back-meaning" style="color:' + POS_COLOR_DEEP[item.pos] + '">' + esc(item.meaning) + '</div>' +
      '<div class="back-example">' + esc(item.example) + '</div>' +
      (isVerb ? ('<div class="conj-grid"><div><span>ない形</span>' + esc(item.conj.nai) + '</div><div><span>ます形</span>' + esc(item.conj.masu) + '</div>' +
        '<div><span>ば形</span>' + esc(item.conj.ba) + '</div><div><span>よう形</span>' + esc(item.conj.you) + '</div>' +
        '<div><span>て形</span>' + esc(item.conj.te) + '</div><div><span>た形</span>' + esc(item.conj.ta) + '</div></div>') : '');
  }
  const longWord = item.front.length > 5 ? ' long' : '';
  const frontInner = isKanji
    ? ('<div class="kanji-box"><span class="kanji-char">' + esc(item.front) + '</span></div>')
    : ('<span class="reading-ruby">' + esc(item.reading) + '</span><div class="front-word' + longWord + '">' + esc(item.front) + '</div>');
  return '' +
    '<div class="card-stage"><div class="flip-card ' + (SESSION.flipped ? 'flipped' : '') + '" onclick="flipCard()">' +
    '<div class="face front" style="--c:' + c + '"><span class="pos-tag" style="--c:' + c + '">' + esc(item.pos) + '</span>' + frontInner + '<span class="tap-hint">タップしてめくる</span></div>' +
    '<div class="face back" style="--c:' + c + '"><span class="pos-tag" style="--c:' + c + '">' + esc(item.pos) + '</span>' + backContent + '</div>' +
    '</div></div>' +
    (SESSION.flipped ? '<div class="rate-row"><button class="rate-btn again" onclick="rateCard(\'again\')">もう一度<br>😵</button><button class="rate-btn soft" onclick="rateCard(\'soft\')">まあまあ<br>🤔</button><button class="rate-btn good" onclick="rateCard(\'good\')">ばっちり！<br>😄</button></div>' : '');
}

function renderQuizBody() {
  const entry = SESSION.queue[SESSION.idx]; const item = entry.item; const q = SESSION.q;
  const c = POS_COLOR[item.pos] || 'var(--grape)';
  const answered = SESSION.answered;
  const optsHTML = q.options.map(function (opt, i) {
    let cls = 'opt-btn';
    if (answered) { if (i === q.correctIndex) cls += ' correct'; else if (i === SESSION.selectedIdx) cls += ' wrong'; }
    return '<button class="' + cls + '" ' + (answered ? 'disabled' : '') + ' onclick="selectQuizOption(' + i + ')">' + esc(opt) + '</button>';
  }).join('');
  const subLine = q.type === 'meaning' ? ('<div class="sub">' + esc(item.reading) + '</div>') : '';
  const promptText = q.type === 'front' ? item.meaning : item.front;
  const longCls = String(promptText).length > 14 ? ' long' : '';
  return '' +
    '<div class="quiz-prompt-type">' + esc(q.promptLabel) + '</div>' +
    '<div class="quiz-front' + longCls + '" style="border-color:' + c + ';box-shadow:0 4px 0 ' + c + '">' + esc(promptText) + subLine + '</div>' +
    '<div class="opt-list">' + optsHTML + '</div>' +
    (answered ? ('<div class="feedback-box">' + (item.type === 'kanji' ? '熟語例：' : '例文：') + esc(item.example) + '</div><button class="btn btn-primary" style="margin-top:14px" onclick="nextQuestion()">つぎへ →</button>') : '');
}

function renderDrillBody() {
  const entry = SESSION.queue[SESSION.idx]; const item = entry.item; const d = SESSION.d;
  const answered = SESSION.answered;
  const optsHTML = d.options.map(function (opt, i) {
    let cls = 'opt-btn';
    if (answered) { if (i === d.correctIndex) cls += ' correct'; else if (i === SESSION.selectedIdx) cls += ' wrong'; }
    return '<button class="' + cls + '" ' + (answered ? 'disabled' : '') + ' onclick="selectDrillOption(' + i + ')">' + esc(opt) + '</button>';
  }).join('');
  return '' +
    '<div class="drill-verb"><div class="w">' + esc(item.front) + '</div><div class="r">' + esc(item.reading) + '・' + esc(item.meaning) + '</div></div>' +
    '<div class="drill-target"><span class="badge">' + esc(d.label) + 'は？</span></div>' +
    '<div class="opt-list">' + optsHTML + '</div>' +
    (answered ? ('<div class="feedback-box">例文：' + esc(item.example) + '</div><button class="btn btn-primary" style="margin-top:14px" onclick="nextQuestion()">つぎへ →</button>') : '');
}

function renderSummary() {
  const s = SESSION; const total = s.queue.length;
  const acc = total ? Math.round(s.correct / total * 100) : 0;
  const showConfetti = acc >= 70 || s.mode === 'flashcard';
  const justDaruma = s.justDaruma;
  return '' +
    '<div class="summary-hero">' + (showConfetti ? confettiHTML() : '') + '<div class="big pop">おつかれさま！</div></div>' +
    '<div class="summary-stats"><div><b>+' + s.xp + '</b><span>XP</span></div><div><b>' + s.correct + '/' + total + '</b><span>正解</span></div><div><b>' + s.maxCombo + '</b><span>最大コンボ</span></div></div>' +
    (justDaruma ? ('<div class="empty-note" style="padding:14px">🎎 ' + justDaruma + '日連続達成で、新しいだるまをゲット！</div>') : '') +
    '<button class="btn btn-primary" onclick="restartSession()">もう一度この内容で学ぶ</button>' +
    '<button class="btn btn-ghost" onclick="goHome()">ホームへ戻る</button>';
}

function renderLevelup() {
  const lvl = levelOf(STATE.xp);
  return '<div class="levelup-wrap">' + confettiHTML() + '<div class="badge-lv pop">Lv.' + lvl + '</div>' +
    '<h2 style="font-size:22px;margin-bottom:8px">レベルアップ！</h2>' +
    '<p class="lead">たくさん学習してレベルが上がったよ。この調子でつづけよう！</p>' +
    '<button class="btn btn-primary" onclick="finishLevelup()">つづける</button></div>';
}

function renderStamps() {
  const items = DARUMA_MILESTONES.map(function (m) {
    const earned = STATE.streak.daruma.find(function (d) { return d.days === m; });
    return '<div class="stamp-slot ' + (earned ? 'earned' : 'locked') + '">' + darumaSVG(!!earned, m) + '<small>' + m + '日' + (earned ? ' 達成' : '') + '</small></div>';
  }).join('');
  return '' +
    '<h2 style="font-size:20px;margin-bottom:4px">だるま帳</h2>' +
    '<p class="lead">連続学習の記録に応じて、だるまが目を開けていくよ。</p>' +
    '<div class="grid-wrap" style="margin-bottom:18px"><div class="cap"><span>現在の連続記録</span><span class="pct">🔥 ' + STATE.streak.current + '日</span></div>' +
    '<div class="cap" style="margin-top:6px"><span>最長記録</span><span class="pct">' + STATE.streak.longest + '日</span></div></div>' +
    '<div class="stamp-book">' + items + '</div>';
}

function renderSearch() {
  const filters = ['all', '動詞', '形容詞', '名詞', '漢字'];
  const q = SEARCH_STATE.query.trim();
  let pool = SEARCH_STATE.filter === 'all' ? UNI : getByFilter(SEARCH_STATE.filter);
  let results = pool;
  if (q) {
    const ql = q.toLowerCase();
    results = pool.filter(function (it) { return it.front.indexOf(q) !== -1 || (it.reading && it.reading.indexOf(q) !== -1) || (it.meaning && it.meaning.toLowerCase().indexOf(ql) !== -1); });
  }
  results = results.slice(0, 80);
  const chipsHTML = filters.map(function (f) {
    return '<button class="chip ' + (SEARCH_STATE.filter === f ? 'active' : '') + '" style="--c:' + (POS_COLOR[f] || 'var(--coral)') + '" onclick="setSearchFilter(\'' + f + '\')">' + (f === 'all' ? '全部' : f) + '</button>';
  }).join('');
  const listHTML = results.length ? results.map(function (it) {
    const open = SEARCH_STATE.openId === it.id;
    const srs = STATE.srs[it.id];
    const status = srs && srs.seen ? (srs.box >= 4 ? '覚えた◎' : '学習中') : '未学習';
    let detail = '';
    if (open) {
      if (it.type === 'kanji') {
        detail = '<div class="list-detail kanji-meta"><div><span>音読み</span>' + esc(it.onyomi) + '</div><div><span>訓読み</span>' + esc(it.kunyomi) + '</div>' +
          '<div><span>画数</span>' + esc(it.strokes) + '画</div><div><span>熟語例</span>' + esc(it.example) + '</div></div>';
      } else {
        detail = '<div class="list-detail"><div class="back-example" style="margin-bottom:' + (it.conj ? '8px' : '0') + '">' + esc(it.example) + '</div>' +
          (it.conj ? ('<div class="conj-grid"><div><span>ない形</span>' + esc(it.conj.nai) + '</div><div><span>ます形</span>' + esc(it.conj.masu) + '</div>' +
            '<div><span>ば形</span>' + esc(it.conj.ba) + '</div><div><span>よう形</span>' + esc(it.conj.you) + '</div>' +
            '<div><span>て形</span>' + esc(it.conj.te) + '</div><div><span>た形</span>' + esc(it.conj.ta) + '</div></div>') : '') + '</div>';
      }
    }
    return '<div class="list-item" onclick="toggleListItem(\'' + it.id + '\')"><div class="row1"><span class="w">' + esc(it.front) + '</span><span class="r">' + esc(it.reading) + '</span><span class="tag" style="--c:' + (POS_COLOR[it.pos] || 'var(--coral)') + '">' + esc(it.pos) + '</span></div>' +
      '<div class="m">' + esc(it.meaning) + ' ・ ' + status + '</div>' + detail + '</div>';
  }).join('') : '<div class="empty-note"><span class="egg">🔍</span>見つからなかったよ。ことばや意味で検索してみてね。</div>';
  return '' +
    '<h2 style="font-size:20px;margin-bottom:12px">さがす</h2>' +
    '<input class="search-input" type="text" placeholder="ことば・読み方・意味で検索" value="' + esc(SEARCH_STATE.query) + '" oninput="onSearchInput(this.value)">' +
    '<div class="chip-row" style="margin-bottom:14px">' + chipsHTML + '</div>' + listHTML;
}

function render() {
  const app = document.getElementById('app-root');
  if (!app) return;
  const showTabbar = ['home', 'stamps', 'search'].indexOf(CURRENT_VIEW) !== -1;
  let body;
  if (CURRENT_VIEW === 'home') body = renderHome();
  else if (CURRENT_VIEW === 'config') body = renderConfig();
  else if (CURRENT_VIEW === 'session') body = renderSession();
  else if (CURRENT_VIEW === 'summary') body = renderSummary();
  else if (CURRENT_VIEW === 'levelup') body = renderLevelup();
  else if (CURRENT_VIEW === 'stamps') body = renderStamps();
  else if (CURRENT_VIEW === 'search') body = renderSearch();
  else body = '';
  app.innerHTML = renderTopbar() + '<main id="view">' + body + '</main>' + (showTabbar ? renderTabbar() : '');
}

/* ---------------- init ---------------- */
document.addEventListener('DOMContentLoaded', function () {
  ensureDaily();
  touchStreak();
  render();
});
