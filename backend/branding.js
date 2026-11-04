/**
 * GLOBAL SMS — Panel Branding.
 *
 * A separate, password-protected branding panel. It is deliberately isolated
 * from the normal user/role system:
 *
 *   - Its own table (branding_users) and its own bcrypt password hash.
 *   - Its own JWT that carries { type: 'branding' }. The branding guard
 *     REQUIRES that claim, so an ordinary Admin / Manager / Agent / Client
 *     token can never reach a branding route even though it is signed with
 *     the same secret.
 *   - No branding route ever reads or returns users, providers, SMPP
 *     credentials, API keys or any other operational secret.
 *
 * Settings live in the local SQLite database (branding_settings), so every
 * VPS installation keeps its own independent branding. There is no external
 * service and no network dependency.
 *
 * Colour settings start EMPTY on purpose: an empty value emits no override,
 * so a fresh install looks exactly as it did before. The appearance only
 * changes for the tokens the owner actually sets.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');

const BCRYPT_ROUNDS = 12;
const SESSION_HOURS = 2;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2 MB

/* Login throttling: 6 attempts per username+IP per 15 minutes, then lock. */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 6;

/* ------------------------------------------------------------------ *
 * Text defaults. These match what the application already shows, so a
 * fresh install is unchanged.
 * ------------------------------------------------------------------ */
const TEXT_DEFAULTS = {
  panelName: 'GLOBAL SMS',
  shortName: 'GLOBAL',
  loginTitle: 'GLOBAL SMS',
  tabTitle: '',                 // blank => derive from panelName
  tagline: 'Intelligent Messaging Infrastructure',
  headerBrand: '',              // blank => panelName
  sidebarBrand: '',             // blank => panelName
  footerText: '',
  supportText: '',
  reportBrand: '',              // blank => panelName
};

/* ------------------------------------------------------------------ *
 * Colour tokens. '' = not set = no override is emitted.
 * `hint` is only shown in the UI as a placeholder; it is never applied
 * unless the owner saves it.
 * ------------------------------------------------------------------ */
/* The colour catalogue (12 categories, per-theme values, CSS mapping) lives in
   its own module: it is data, and branding.js is logic. */
const {
  CATEGORIES, TOKENS, CSS_MAP,
  SHARED_KEYS, LIGHT_KEYS, DARK_KEYS,
  LEGACY_DARK_TO_SHARED, LEGACY_RENAME,
} = require('./branding-tokens');

const COLOR_TOKENS = TOKENS;
const COLOR_KEYS = TOKENS.map(t => t.k);

/* selector roots used by CSS_MAP */
const ROOTS = {
  L: 'html body.ams-light.ams-panel',
  D: 'html body.ams-dark.ams-panel',
  LOGIN: 'html body.ams-light:is(.ams-login,.ams-portal-login)',
};

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const SAFE_TEXT = /^[^<>`\\]{0,120}$/;

function isColor(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s === '') return true;                       // unset
  if (HEX.test(s)) return true;
  // allow rgb()/rgba() but nothing that could break out of the declaration
  return /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/.test(s);
}
function sanitizeText(v, max) {
  if (v == null) return '';
  let s = String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max || 120);
  return SAFE_TEXT.test(s) ? s : s.replace(/[<>`\\]/g, '').slice(0, max || 120);
}
function cssVarName(k) {
  return String(k).replace(/\./g, '-').replace(/[A-Z]/g, m => '-' + m.toLowerCase());
}

function cssEscape(v) {
  // values are validated above; this is defence in depth so a value can
  // never terminate the declaration or the rule
  return String(v).replace(/[;{}<>\\]/g, '');
}

/* Magic-byte sniffing — never trust the client-declared MIME type. */
function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return 'ico';
  if (buf.slice(0, 4).toString('ascii') === '<svg' || buf.slice(0, 5).toString('ascii').includes('<?xml')) return 'svg';
  return null;
}
const ALLOWED_KINDS = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', ico: 'image/x-icon' };

/* ------------------------------------------------------------------ *
 * Module
 * ------------------------------------------------------------------ */
module.exports = function branding(app, ctx) {
  const db = ctx.db;
  const SECRET = ctx.SECRET;
  const _logAction = ctx.logAction || (() => {});
  /* branding has no panel user, so the audit row records no user id */
  const audit = (action, details) => {
    try { _logAction({ user: null, ip: '' }, action, 'branding', details); } catch (e) {}
  };
  const DATA_DIR = path.dirname(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'ams-sms.sqlite'));
  const ASSET_DIR = path.join(DATA_DIR, 'branding');
  try { fs.mkdirSync(ASSET_DIR, { recursive: true }); } catch (e) { /* non-fatal */ }

  const ASSET_FILES = { logo: 'logo', logoDark: 'logo-dark', favicon: 'favicon' };

  /* ---------------- schema (lazy: db.init() runs later in server.js) -------- */
  let schemaReady = false;
  function ensureSchema() {
    if (schemaReady) return;
    schemaReady = true;
  db.run(`CREATE TABLE IF NOT EXISTS branding_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    must_change INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS branding_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
    seedAccount();
  }

  /* ---------------- settings storage ---------------- */
  function getRaw(key) {
    ensureSchema();
    const r = db.get('SELECT value FROM branding_settings WHERE key = ?', [key]);
    return r ? r.value : null;
  }
  function setRaw(key, value) {
    ensureSchema();
    db.run('INSERT INTO branding_settings (key,value,updated_at) VALUES (?,?,?) ' +
           'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
           [key, String(value), new Date().toISOString()]);
  }

  /* ---------------------------------------------------------------- *
   * Colour storage.
   *
   * Settings hold TWO independent colour sets:
   *     colors: { light: { key: value }, dark: { key: value } }
   * A 'shared' token exists in both sets and each set keeps its own value,
   * so saving Light can never overwrite Dark (Req 5D). A scope:'light' or
   * scope:'dark' token only exists in its own set.
   *
   * Installs saved before this change used a single flat map. migrateColors
   * folds that into the light set and folds the old dark.* tokens into the
   * dark values of the matching shared token, so nothing is lost.
   * ---------------------------------------------------------------- */
  function migrateColors(flat) {
    const light = {}, dark = {};
    for (const [k, raw] of Object.entries(flat || {})) {
      const v = isColor(raw) ? String(raw).trim() : '';
      if (!v) continue;
      if (LEGACY_DARK_TO_SHARED[k]) { dark[LEGACY_DARK_TO_SHARED[k]] = v; continue; }
      if (Object.prototype.hasOwnProperty.call(LEGACY_DARK_TO_SHARED, k)) continue;
      const nk = LEGACY_RENAME[k] || k;
      if (LIGHT_KEYS.includes(nk)) light[nk] = v;
    }
    return { light, dark };
  }

  function normalizeColors(c) {
    const out = { light: {}, dark: {} };
    if (c && (c.light || c.dark)) {
      /* already the per-theme shape */
      for (const set of ['light', 'dark']) {
        for (const k of (set === 'light' ? LIGHT_KEYS : DARK_KEYS)) {
          const v = (c[set] || {})[k];
          out[set][k] = isColor(v) ? String(v).trim() : '';
        }
      }
      return out;
    }
    return migrateColors(c);
  }

  /* RAW settings, including the on-disk asset paths. Server-side only. */
  function getSettingsRaw() {
    let s = {};
    const raw = getRaw('config');
    if (raw) { try { s = JSON.parse(raw) || {}; } catch (e) { s = {}; } }
    const out = {
      general: Object.assign({}, TEXT_DEFAULTS, s.general || {}),
      colors: normalizeColors(s.colors),
      theme: Object.assign({ mode: 'light', accent: '', primary: '', secondary: '', animations: '' }, s.theme || {}),
      assets: Object.assign({ logo: '', logoDark: '', favicon: '' }, s.assets || {}),
      updatedAt: s.updatedAt || null,
    };
    return out;
  }

  /**
   * Settings as returned to a browser. Asset slots never leave the server as
   * filesystem paths — only "is one uploaded" plus the URL to fetch it.
   */
  function getSettings() {
    const s = getSettingsRaw();
    const has = v => (v ? '1' : '');
    s.assets = {
      logo: has(s.assets.logo),
      logoDark: has(s.assets.logoDark),
      favicon: has(s.assets.favicon),
    };
    s.assetUrls = {
      logo: s.assets.logo ? '/branding/asset/logo' : '',
      logoDark: s.assets.logoDark ? '/branding/asset/logo-dark' : '',
      favicon: s.assets.favicon ? '/branding/asset/favicon' : '',
    };
    return s;
  }


  /* Public shape: never leaks anything operational. */
  function publicSettings() {
    const s = getSettingsRaw();
    const g = s.general;
    const name = g.panelName || TEXT_DEFAULTS.panelName;
    return {
      panelName: name,
      shortName: g.shortName || name,
      loginTitle: g.loginTitle || name,
      tabTitle: g.tabTitle || name,
      tagline: g.tagline || '',
      headerBrand: g.headerBrand || name,
      sidebarBrand: g.sidebarBrand || name,
      footerText: g.footerText || '',
      supportText: g.supportText || '',
      reportBrand: g.reportBrand || name,
      theme: s.theme,
      colors: s.colors,
      assets: {
        logo: s.assets.logo ? '/branding/asset/logo' : '',
        logoDark: s.assets.logoDark ? '/branding/asset/logo-dark' : '',
        favicon: s.assets.favicon ? '/branding/asset/favicon' : '',
      },
      // the login page's shipped transparent mark stays the fallback
      defaultLogo: '/assets/ams-logo-trim.png',
      defaultFavicon: '/assets/ams-favicon.png',
    };
  }

  /* ---------------- generated runtime CSS ---------------- */
  function buildCss() {
    const s = getSettings();
    const c = s.colors || {};
    const out = [];
    out.push('/* GLOBAL SMS — generated branding runtime. Do not edit by hand. */');

    /* Logo integrity. The shipped stylesheet forces background:#fff behind the
       panel logos (assets/ams.css:337), which paints a visible white box
       behind a transparent logo and can letterbox/stretch it. Branding owns the
       logo now, so it must never be padded or distorted. */
    /* The selector is deliberately more specific than assets/ams.css:337
       (`body.ams-light :is(...){background:#fff!important}` = 0,2,1); this is
       0,2,3, so the transparent background wins the cascade. */
    out.push('html body:is(.ams-light,.ams-dark,.ams-login,.ams-portal-login) :is(img[data-brand-logo],.m-brand img,.logo img,img.ams-sms-logo-img,.login-hero-logo),');
    out.push('html body img[data-brand-logo]');
    /* One centrally managed logo must keep ITS OWN shape. The panels pin the
       <img> to width/height:100% of a square box (admin.html:268), which
       letterboxes a wide mark and reports a 1:1 element. Let the image size
       itself inside the box instead: aspect ratio preserved, never cropped,
       never stretched, and still capped by the container so it stays
       responsive. object-fit:contain remains as the safety net. */
    out.push('{background-color:transparent!important;background-image:none!important;object-fit:contain!important;width:auto!important;height:auto!important;max-width:100%!important;max-height:100%!important;}');

    /* Custom properties per theme, only for the tokens actually set.
       Emitted on the theme root (not :root) so Light and Dark can publish
       different values for the same variable without fighting. */
    for (const set of ['light', 'dark']) {
      const bucket = (c && c[set]) || {};
      const rootSel = set === 'light'
        ? 'html:is(.ams-light,.ams-login,.ams-portal-login)'
        : 'html.ams-dark';
      const vars = [];
      for (const k of Object.keys(bucket)) {
        const v = bucket[k];
        /* same token -> custom-property mapping as the branding panel's
           previews: camelCase folds to kebab-case (`login.cardBg` ->
           `--br-login-card-bg`), so preview and runtime cannot disagree. */
        if (v && v.trim()) vars.push(`  --br-${cssVarName(k)}:${cssEscape(v.trim())};`);
      }
      if (vars.length) out.push(rootSel + '{', vars.join('\n'), '}');
    }

    /* Rules per theme. A shared token emits once from the light value under
       the light root and once from the dark value under the dark root, so
       the two sets are fully independent. */
    for (const set of ['light', 'dark']) {
      const bucket = (c && c[set]) || {};
      for (const k of Object.keys(bucket)) {
        const v = bucket[k];
        if (!v || !v.trim()) continue;
        const rules = CSS_MAP[k];
        if (!rules) continue;
        for (const [root, suffix, prop] of rules) {
          if (root === 'RAW') { out.push(`${suffix}{${prop}:${cssEscape(v.trim())}!important;}`); continue; }
          /* only emit the half that belongs to this set */
          if (root === 'L' && set !== 'light') continue;
          if (root === 'D' && set !== 'dark') continue;
          const sel = ROOTS[root] + (suffix || '');
          out.push(`${sel}{${prop}:${cssEscape(v.trim())}!important;}`);
        }
      }
    }
    if (s.theme.animations === 'off') {
      out.push('html.ams-brand-anim-off *,html.ams-brand-anim-off *::before,html.ams-brand-anim-off *::after{animation:none!important;transition:none!important;}');
    }
    return out.join('\n');
  }

  /* ---------------- generated runtime JS ---------------- */
  function buildJs() {
    const p = publicSettings();
    const cfg = {
      panelName: p.panelName, shortName: p.shortName, loginTitle: p.loginTitle,
      tabTitle: p.tabTitle, tagline: p.tagline, headerBrand: p.headerBrand,
      sidebarBrand: p.sidebarBrand, footerText: p.footerText, supportText: p.supportText,
      reportBrand: p.reportBrand,
      logo: p.assets.logo || p.defaultLogo,
      logoDark: p.assets.logoDark || '',
      favicon: p.assets.favicon || p.defaultFavicon,
      /* the raw slots, so a page can tell "owner uploaded one" from "default" */
      assets: { logo: p.assets.logo || '', logoDark: p.assets.logoDark || '', favicon: p.assets.favicon || '' },
      mode: p.theme.mode === 'dark' ? 'dark' : (p.theme.mode === 'light' ? 'light' : ''),
      animations: p.theme.animations || '',
      // values that were in the markup before, so we only rewrite real brand slots
      defaults: TEXT_DEFAULTS,
    };
    return `(function(){'use strict';
var C=${JSON.stringify(cfg)};
/* expose the resolved branding to page scripts that build documents/headers
   (e.g. the printable Provider Integration Guide window) */
try{ window.AMS_BRAND=C; }catch(e){}
var r=document.documentElement;
if(C.animations==='on'){r.classList.add('ams-brand-anim-on');r.classList.remove('ams-brand-anim-off');}
else if(C.animations==='off'){r.classList.add('ams-brand-anim-off');r.classList.remove('ams-brand-anim-on');}
function applyMode(){
  if(!document.body) return;
  if(!C.mode) return;                 /* owner has not pinned a mode -> leave it alone */
  /* The central branding mode is the DEFAULT, not an override: run() is re-entered
     from the MutationObserver ~120ms after any DOM change, so an unconditional
     force here would silently revert the user's own light/dark toggle every time
     they clicked it. A stored per-user choice (api.js, key ams_theme) wins. */
  var chosen='';
  try{ chosen=localStorage.getItem('ams_theme')||''; }catch(e){}
  var mode=(chosen==='dark'||chosen==='light')?chosen:C.mode;
  var dark=(mode==='dark');
  document.documentElement.classList.toggle('ams-dark',dark);
  document.documentElement.classList.toggle('ams-light',!dark);
  document.body.classList.toggle('ams-dark',dark);
  document.body.classList.toggle('ams-light',!dark);
}
/* browser tab title */
if(C.tabTitle&&document.title!==C.tabTitle){
  var t=document.title,D=C.defaults.panelName;
  document.title = (t===D||t.indexOf(D)===0)? t.replace(D,C.tabTitle) : C.tabTitle;
}
/* favicon */
function setIcon(href){var l=document.querySelector('link[rel~="icon"]');
  if(!l){l=document.createElement('link');l.rel='icon';document.head.appendChild(l);} l.href=href;}
setIcon(C.favicon);
/* brand text — only elements explicitly marked with data-brand */
var MAP={name:C.panelName,short:C.shortName,login:C.loginTitle,header:C.headerBrand,
         sidebar:C.sidebarBrand,footer:C.footerText,support:C.supportText,tagline:C.tagline};
function apply(){
  var els=document.querySelectorAll('[data-brand]');
  for(var i=0;i<els.length;i++){
    var el=els[i],slot=el.getAttribute('data-brand'),v=MAP[slot];
    if(v==null||v==='')continue;
    if(el.tagName==='TITLE'){el.textContent=v;continue;}
    if(el.tagName==='IMG'){el.setAttribute('alt',v);continue;}
    if(el.textContent.trim()!==v) el.textContent=v;
  }
  /* accessible names that carry the brand, e.g. aria-label="GLOBAL SMS branding" */
  var ar=document.querySelectorAll('[data-brand-aria]');
  for(var k=0;k<ar.length;k++){
    var el3=ar[k],slot3=ar[k].getAttribute('data-brand-aria'),v3=MAP[slot3];
    var old3=(slot3==='short')?C.defaults.shortName:C.defaults.panelName;
    if(v3==null||v3===''||!old3)continue;
    var lb=el3.getAttribute('aria-label')||'';
    if(lb.indexOf(old3)===-1)continue;
    el3.setAttribute('aria-label',lb.split(old3).join(v3));
  }
  /* slots where the brand name sits inside a longer phrase, e.g.
     "Welcome to <brand>" — only these explicitly marked elements. */
  var rp=document.querySelectorAll('[data-brand-replace]');
  for(var j=0;j<rp.length;j++){
    var el2=rp[j],slot2=el2.getAttribute('data-brand-replace'),v2=MAP[slot2];
    var old2=(slot2==='short')?C.defaults.shortName:C.defaults.panelName;
    if(v2==null||v2===''||!old2)continue;
    if(el2.textContent.indexOf(old2)===-1)continue;
    el2.textContent=el2.textContent.split(old2).join(v2);
  }
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){try{apply();}catch(e){}});
/* logos: every image marked data-brand-logo, plus the known login logo classes */
function applyLogo(){
  var dark=document.body.classList.contains('ams-dark');
  var src=(dark&&C.logoDark)?C.logoDark:C.logo;
  var imgs=document.querySelectorAll('img[data-brand-logo],.m-brand img,.logo img,.login-hero-logo,.rail>.logo img,img.ams-sms-logo-img');
  for(var i=0;i<imgs.length;i++){ var im=imgs[i];
    if(im.getAttribute('src')!==src) im.setAttribute('src',src);
    if(im.hasAttribute('data-brand-logo')) im.setAttribute('alt',C.panelName); }
  var f=document.querySelector('[data-brand-favicon]'); if(f) f.href=C.favicon;
}
/* Re-apply when the app re-renders a section. The observer is disconnected
   while we write and debounced afterwards: an unguarded observer on
   document.body re-triggers on our own DOM writes and starves the event loop. */
var mo=null,timer=null,busy=false;
function run(){
  /* This file is loaded synchronously in <head> on the login pages so that
     AMS_BRAND exists before ams-login-anim.js runs, which means document.body
     is still null on the first call. Defer the DOM work instead of throwing. */
  if(!document.body){
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',run);
    else setTimeout(run,0);
    return;
  }
  if(busy)return; busy=true;
  if(mo){try{mo.disconnect();}catch(e){}}
  try{ applyMode(); apply(); applyLogo(); }catch(e){}
  if(mo){try{mo.observe(document.body,{childList:true,subtree:true});}catch(e){}}
  busy=false;
}
run();
try{
  mo=new MutationObserver(function(){
    if(timer)return;
    timer=setTimeout(function(){timer=null;run();},120);
  });
  if(document.body) mo.observe(document.body,{childList:true,subtree:true});
  else mo=null;
}catch(e){mo=null;}
})();`;
  }

  /* ---------------- auth ---------------- */
  function epoch() {
    const v = getRaw('session_epoch');
    return v ? parseInt(v, 10) || 1 : 1;
  }
  function bumpEpoch() { setRaw('session_epoch', String(epoch() + 1)); }

  function brandingSign(username) {
    return jwt.sign({ branding: true, username, type: 'branding', epoch: epoch() },
      SECRET, { expiresIn: SESSION_HOURS + 'h' });
  }

  /* Requires a BRANDING token. An ordinary user token has no type:'branding'
     claim, so it is rejected here even though it is correctly signed. */
  function brandingRequired(req, res, next) {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Branding authentication required' });
    try {
      const d = jwt.verify(token, SECRET);
      if (!d || d.type !== 'branding' || d.branding !== true) {
        return res.status(403).json({ error: 'Forbidden — branding credentials required' });
      }
      const row = db.get('SELECT username, must_change FROM branding_users WHERE username = ?', [d.username]);
      if (!row) return res.status(401).json({ error: 'Branding account no longer exists' });
      if (parseInt(d.epoch || 0, 10) !== epoch()) {
        return res.status(401).json({ error: 'Session expired — please sign in again' });
      }
      req.branding = { username: d.username, mustChange: !!row.must_change };
      next();
    } catch (e) {
      return res.status(401).json({ error: 'Invalid or expired branding session' });
    }
  }

  /* ---------------- seed the account ---------------- */
  function seedAccount() {
    const n = db.get('SELECT COUNT(*) AS n FROM branding_users');
    if (n && n.n > 0) return;
    // The initial password may be supplied by env; otherwise the requested
    // default is used and the account is flagged for an immediate change.
    const initial = process.env.BRANDING_PASSWORD || 'branding';
    const username = process.env.BRANDING_USERNAME || 'branding';
    const hash = bcrypt.hashSync(initial, BCRYPT_ROUNDS);
    const now = new Date().toISOString();
    db.run('INSERT INTO branding_users (username,password_hash,must_change,created_at,updated_at) VALUES (?,?,?,?,?)',
      [username, hash, 1, now, now]);
    console.log('[branding] created the initial branding account (change the password at /branding)');
  }

  /* ---------------- login throttling ---------------- */
  const attempts = new Map();
  function throttleKey(req, username) {
    const ip = (req.headers['x-forwarded-for'] || req.ip || req.socket.remoteAddress || '?').toString().split(',')[0].trim();
    return ip + '|' + String(username || '').toLowerCase();
  }
  function throttled(key) {
    const now = Date.now();
    const b = attempts.get(key);
    if (!b || now > b.resetAt) { attempts.set(key, { count: 0, resetAt: now + LOGIN_WINDOW_MS }); return false; }
    return b.count >= LOGIN_MAX_ATTEMPTS;
  }
  function recordFail(key) {
    const now = Date.now();
    let b = attempts.get(key);
    if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + LOGIN_WINDOW_MS }; attempts.set(key, b); }
    b.count++;
    if (attempts.size > 5000) for (const [k, v] of attempts) if (now > v.resetAt) attempts.delete(k);
  }
  function clearAttempts(key) { attempts.delete(key); }

  /* ---------------- file uploads ---------------- */
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  }).single('file');

  function writeAsset(kind, buf) {
    const detected = sniffImage(buf);
    if (!detected) return { error: 'Unsupported or corrupt image file' };
    if (detected === 'svg') return { error: 'SVG uploads are not accepted (they can carry scripts). Use PNG, JPEG, WebP or ICO.' };
    const mime = ALLOWED_KINDS[detected];
    if (!mime) return { error: 'Unsupported image type' };
    const base = ASSET_FILES[kind];
    if (!base) return { error: 'Unknown asset slot' };
    // fixed filename derived only from a whitelist -> no path traversal
    const file = path.join(ASSET_DIR, base + '.' + detected);
    for (const ext of Object.keys(ALLOWED_KINDS)) {
      const stale = path.join(ASSET_DIR, base + '.' + ext);
      if (stale !== file && fs.existsSync(stale)) { try { fs.unlinkSync(stale); } catch (e) {} }
    }
    fs.writeFileSync(file, buf, { mode: 0o644 });
    return { ok: true, file, mime };
  }
  function assetInfo(kind) {
    const base = ASSET_FILES[kind];
    if (!base) return null;
    for (const ext of Object.keys(ALLOWED_KINDS)) {
      const f = path.join(ASSET_DIR, base + '.' + ext);
      if (fs.existsSync(f)) return { file: f, mime: ALLOWED_KINDS[ext] };
    }
    return null;
  }
  function deleteAsset(kind) {
    const info = assetInfo(kind);
    if (info) { try { fs.unlinkSync(info.file); } catch (e) {} }
  }

  /* ================== routes ================== */

  /* Public: safe branding values only. No secrets, ever. */
  app.get('/api/branding/public', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(publicSettings());
  });

  /* Public: generated runtime assets */
  app.get('/branding/runtime.css', (req, res) => {
    res.set('Content-Type', 'text/css; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.send(buildCss());
  });
  app.get('/branding/runtime.js', (req, res) => {
    res.set('Content-Type', 'application/javascript; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.send(buildJs());
  });

  /* Public: uploaded assets, whitelisted names only */
  app.get('/branding/asset/:name', (req, res) => {
    const name = String(req.params.name || '');
    const kind = Object.keys(ASSET_FILES).find(k => ASSET_FILES[k] === name);
    if (!kind) return res.status(404).end();
    const info = assetInfo(kind);
    if (!info) return res.status(404).end();
    res.set('Content-Type', info.mime);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'no-cache');
    res.sendFile(info.file);
  });

  /* ---- login / session ---- */
  app.post('/api/branding/login', (req, res) => {
    const username = sanitizeText((req.body && req.body.username) || '', 64);
    const password = String((req.body && req.body.password) || '').slice(0, 200);
    const key = throttleKey(req, username);
    if (throttled(key)) {
      return res.status(429).json({ error: 'Too many failed sign-in attempts. Try again in 15 minutes.' });
    }
    if (!username || !password) {
      recordFail(key);
      return res.status(400).json({ error: 'Username and password are required' });
    }
    const row = db.get('SELECT * FROM branding_users WHERE username = ?', [username]);
    // constant-ish work factor even when the user does not exist
    const hash = row ? row.password_hash : '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
    let okPass = false;
    try { okPass = bcrypt.compareSync(password, hash); } catch (e) { okPass = false; }
    if (!row || !okPass) {
      recordFail(key);
      console.log('[branding] failed sign-in attempt for username=' + JSON.stringify(username) +
        ' ip=' + key.split('|')[0]);
      return res.status(401).json({ error: 'Invalid branding credentials' });
    }
    clearAttempts(key);
    const now = new Date().toISOString();
    db.run('UPDATE branding_users SET updated_at=? WHERE id=?', [now, row.id]);
    audit('branding_login', { by: username });
    res.json({
      ok: true,
      token: brandingSign(row.username),
      username: row.username,
      mustChange: !!row.must_change,
      expiresInHours: SESSION_HOURS,
      hasUploadedLogo: !!assetInfo('logo'),
    });
  });

  app.post('/api/branding/logout', brandingRequired, (req, res) => {
    bumpEpoch();                       // invalidates every existing branding session
    audit('branding_logout', { by: req.branding.username });
    res.json({ ok: true });
  });

  app.get('/api/branding/session', brandingRequired, (req, res) => {
    res.json({ ok: true, username: req.branding.username, mustChange: req.branding.mustChange });
  });

  /* Change the branding credentials. Requires the current password. */
  app.post('/api/branding/password', brandingRequired, (req, res) => {
    const current = String((req.body && req.body.currentPassword) || '').slice(0, 200);
    const next = String((req.body && req.body.newPassword) || '').slice(0, 200);
    const newUser = sanitizeText((req.body && req.body.newUsername) || '', 64);
    const row = db.get('SELECT * FROM branding_users WHERE username = ?', [req.branding.username]);
    if (!row) return res.status(401).json({ error: 'Account not found' });
    if (!current || !bcrypt.compareSync(current, row.password_hash)) {
      return res.status(403).json({ error: 'Current password is incorrect' });
    }
    if (next.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    if (newUser && newUser !== row.username) {
      const clash = db.get('SELECT id FROM branding_users WHERE username = ? AND id != ?', [newUser, row.id]);
      if (clash) return res.status(409).json({ error: 'That username is already taken' });
    }
    const now = new Date().toISOString();
    db.run('UPDATE branding_users SET username=?, password_hash=?, must_change=0, updated_at=? WHERE id=?',
      [newUser || row.username, bcrypt.hashSync(next, BCRYPT_ROUNDS), now, row.id]);
    bumpEpoch();                        // sign out every other branding session
    audit('branding_password_change', { by: req.branding.username });
    res.json({ ok: true, username: newUser || row.username, token: brandingSign(newUser || row.username) });
  });

  /* ---- settings ---- */
  app.get('/api/branding/settings', brandingRequired, (req, res) => {
    res.json({ ok: true, settings: getSettings(), tokens: COLOR_TOKENS, categories: CATEGORIES, textDefaults: TEXT_DEFAULTS });
  });

  app.put('/api/branding/settings', brandingRequired, (req, res) => {
    const body = req.body || {};
    const cur = getSettingsRaw();
    const general = {};
    for (const k of Object.keys(TEXT_DEFAULTS)) {
      general[k] = body.general && body.general[k] != null
        ? sanitizeText(body.general[k], 120) : (cur.general[k] || '');
    }
    /* Colours arrive as { light: {...}, dark: {...} }. Each set is written
       independently: a set that is absent is left exactly as it was, so
       saving the Light tab cannot clear or overwrite Dark (Req 5D). */
    const curColors = cur.colors || { light: {}, dark: {} };
    const colors = { light: Object.assign({}, curColors.light || {}), dark: Object.assign({}, curColors.dark || {}) };
    if (body.colors && (body.colors.light || body.colors.dark)) {
      for (const set of ['light', 'dark']) {
        const incoming = body.colors[set];
        if (!incoming) continue;                 /* absent set: leave it untouched */
        const allowed = set === 'light' ? LIGHT_KEYS : DARK_KEYS;
        for (const k of Object.keys(incoming)) {
          const v = incoming[k];
          if (v === undefined || v === null) continue;
          /* an unknown key is a bug or a probe: reject rather than store it */
          if (!allowed.includes(k)) return res.status(400).json({ error: 'Unknown colour key ' + set + '.' + k });
          if (v !== '' && !isColor(v)) return res.status(400).json({ error: 'Invalid colour value for ' + set + '.' + k });
          if (v === '') delete colors[set][k]; else colors[set][k] = String(v).trim();
        }
      }
    } else if (body.colors && typeof body.colors === 'object') {
      /* tolerate the pre-rework flat shape and migrate it on the way in */
      const m = migrateColors(body.colors);
      colors.light = Object.assign({}, m.light);
      colors.dark = Object.assign({}, m.dark);
    }
    const theme = {
      mode: ['light', 'dark', ''].includes(body.theme && body.theme.mode) ? (body.theme.mode || '') : cur.theme.mode,
      /* kept for backwards compatibility with older saved payloads; the
         authoritative values are now colors.light['theme.*'] / colors.dark['theme.*'] */
      accent: isColor(body.theme && body.theme.accent) ? ((body.theme.accent || '').trim() || (cur.theme.accent || '')) : cur.theme.accent,
      primary: isColor(body.theme && body.theme.primary) ? ((body.theme.primary || '').trim() || (cur.theme.primary || '')) : cur.theme.primary,
      secondary: isColor(body.theme && body.theme.secondary) ? ((body.theme.secondary || '').trim() || (cur.theme.secondary || '')) : cur.theme.secondary,
      animations: ['on', 'off', ''].includes(body.theme && body.theme.animations) ? (body.theme.animations || '') : cur.theme.animations,
    };
    const next = { general, colors, theme, assets: cur.assets, updatedAt: new Date().toISOString() };
    setRaw('config', JSON.stringify(next));
    audit('branding_settings_update', { by: req.branding.username });
    res.json({ ok: true, settings: getSettings() });
  });

  /* ---- logo / favicon upload ---- */
  app.post('/api/branding/logo/:kind', brandingRequired, (req, res) => {
    const kind = String(req.params.kind || '');
    if (!ASSET_FILES[kind]) return res.status(400).json({ error: 'Unknown asset slot' });
    upload(req, res, (err) => {
      if (err) {
        const msg = err.code === 'LIMIT_FILE_SIZE'
          ? 'File is too large (maximum 2 MB)'
          : 'Upload failed: ' + (err.message || 'unknown error');
        return res.status(400).json({ error: msg });
      }
      if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'No file received' });
      const w = writeAsset(kind, req.file.buffer);
      if (w.error) return res.status(400).json({ error: w.error });
      const s = getSettingsRaw();
      s.assets[kind] = w.file;
      setRaw('config', JSON.stringify(Object.assign(s, { updatedAt: new Date().toISOString() })));
      audit('branding_logo_upload', { by: req.branding.username });
      res.json({ ok: true, url: '/branding/asset/' + ASSET_FILES[kind], settings: getSettings() });
    });
  });

  app.delete('/api/branding/logo/:kind', brandingRequired, (req, res) => {
    const kind = String(req.params.kind || '');
    if (!ASSET_FILES[kind]) return res.status(400).json({ error: 'Unknown asset slot' });
    deleteAsset(kind);
    const s = getSettingsRaw();
    s.assets[kind] = '';
    setRaw('config', JSON.stringify(Object.assign(s, { updatedAt: new Date().toISOString() })));
    audit('branding_logo_remove', { by: req.branding.username });
    res.json({ ok: true, settings: getSettings() });
  });

  /* ---- reset ---- */
  app.post('/api/branding/reset', brandingRequired, (req, res) => {
    if (!req.body || req.body.confirm !== 'RESET BRANDING') {
      return res.status(400).json({ error: 'Confirmation required' });
    }
    /* Reset touches branding and theme ONLY. It never writes to users, SMS,
       providers, ranges, rates, payments or any other operational table. */
    const empty = {
      general: Object.assign({}, TEXT_DEFAULTS),
      colors: { light: {}, dark: {} },
      theme: { mode: 'light', accent: '', primary: '', secondary: '', animations: '' },
      assets: { logo: '', logoDark: '', favicon: '' },
      updatedAt: new Date().toISOString(),
    };
    for (const k of LIGHT_KEYS) empty.colors.light[k] = '';
    for (const k of DARK_KEYS) empty.colors.dark[k] = '';
    setRaw('config', JSON.stringify(empty));
    // remove uploaded assets only — never touches users, SMS, providers or rates
    for (const k of Object.keys(ASSET_FILES)) deleteAsset(k);
    audit('branding_reset', { by: req.branding.username });
    res.json({ ok: true, settings: getSettings() });
  });

  /* ------------------------------------------------------------------ *
   * Server-side brand text for places a browser never renders HTML:
   * export / report / download filenames and generated documents.
   * Fails safe (never throws) so a branding problem can never break an
   * export.
   * ------------------------------------------------------------------ */
  function brandText() {
    try {
      const p = publicSettings();
      return {
        panelName: p.panelName, shortName: p.shortName,
        reportBrand: p.reportBrand, footerText: p.footerText, supportText: p.supportText,
      };
    } catch (e) {
      return { panelName: 'GLOBAL SMS', shortName: 'GLOBAL', reportBrand: 'GLOBAL SMS', footerText: '', supportText: '' };
    }
  }
  /* filesystem/URL-safe slug for download filenames */
  function brandSlug() {
    try {
      const t = brandText();
      const raw = String(t.shortName || t.panelName || '').trim();
      const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      return slug || 'global-sms';
    } catch (e) { return 'global-sms'; }
  }

  return { publicSettings, getSettings, getSettingsRaw, buildCss, buildJs, brandingRequired, brandText, brandSlug };
};

module.exports.COLOR_TOKENS = COLOR_TOKENS;
module.exports.TEXT_DEFAULTS = TEXT_DEFAULTS;
