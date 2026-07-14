/**
 * Persistent profile — the only module that touches localStorage.
 * Write on run end, descent unlocks, and settings changes — never per frame.
 *
 * Key: descent.save.v1
 */
const KEY = 'descent.save.v1';

const DEFAULT_TALLIES = {
  grunt:0, caster:0, charger:0, bomber:0, warden:0, summoner:0,
  boss:0, mega:0, chests:0, mimicsSprung:0, shrines:0, parkourPrizes:0,
};

const DEFAULT_UNLOCKS = {
  fangs:false, spear:false, rod:false, startChoice:false, altars:false, heat:false,
};

const DEFAULT_HINTS = {
  pit:false, dashMana:false, weaponSwap:false, seal:false, parkour:false, elite:false,
};

function blank(){
  return {
    best: { floor:0, timeSec:0, heat:0 },
    bestExplorer: { floor:0, timeSec:0 },
    runs: 0,
    wins: 0,
    history: [],
    tallies: { ...DEFAULT_TALLIES },
    unlocks: { ...DEFAULT_UNLOCKS },
    hints:   { ...DEFAULT_HINTS },
    settings:{ sound:true, explorerMode:false },
    weaponsWielded: [],
    rest: null,           // serialized run or null
    daily: { date:'', seed:0, attempted:false, bestFloor:0 },
    heatPrefs: { swift:false, scarce:false, hungry:false, iron:false, fickle:false },
  };
}

let cache = null;

function storage(){
  try { return typeof localStorage !== 'undefined' ? localStorage : null; }
  catch { return null; }
}

function normalize(raw){
  const b = blank();
  if(!raw || typeof raw !== 'object') return b;
  if(raw.best){
    b.best.floor   = raw.best.floor   | 0;
    b.best.timeSec = raw.best.timeSec | 0;
    b.best.heat    = raw.best.heat    | 0;
  }
  if(raw.bestExplorer){
    b.bestExplorer.floor = raw.bestExplorer.floor | 0;
    b.bestExplorer.timeSec = raw.bestExplorer.timeSec | 0;
  }
  b.runs = raw.runs | 0;
  b.wins = raw.wins | 0;
  if(Array.isArray(raw.history)) b.history = raw.history.slice(0, 25);
  if(raw.tallies) for(const k of Object.keys(DEFAULT_TALLIES))
    b.tallies[k] = (raw.tallies[k] | 0);
  if(raw.unlocks) for(const k of Object.keys(DEFAULT_UNLOCKS))
    b.unlocks[k] = !!raw.unlocks[k];
  if(raw.hints) for(const k of Object.keys(DEFAULT_HINTS))
    b.hints[k] = !!raw.hints[k];
  if(raw.settings){
    if(typeof raw.settings.sound === 'boolean') b.settings.sound = raw.settings.sound;
    if(typeof raw.settings.explorerMode === 'boolean') b.settings.explorerMode = raw.settings.explorerMode;
  }
  if(Array.isArray(raw.weaponsWielded)) b.weaponsWielded = [...new Set(raw.weaponsWielded.map(String))];
  if(raw.rest) b.rest = raw.rest;
  if(raw.daily) b.daily = { ...b.daily, ...raw.daily };
  if(raw.heatPrefs) for(const k of Object.keys(b.heatPrefs))
    b.heatPrefs[k] = !!raw.heatPrefs[k];
  return b;
}

export function load(){
  const s = storage();
  if(!s){ cache = blank(); return cache; }
  try {
    const raw = s.getItem(KEY);
    cache = normalize(raw ? JSON.parse(raw) : null);
  } catch {
    cache = blank();
  }
  return cache;
}

export function getSave(){
  return cache || load();
}

function persist(){
  const s = storage();
  if(!s || !cache) return;
  try { s.setItem(KEY, JSON.stringify(cache)); }
  catch { /* quota / private mode — ignore */ }
}

/** Wipe profile (tests / player reset). */
export function clearSave(){
  cache = blank();
  const s = storage();
  try { s?.removeItem(KEY); } catch { /* ignore */ }
  return cache;
}

/**
 * Horizontal unlocks from floor depth / first win.
 * Returns list of newly unlocked ids for UI copy.
 */
export function noteFloorReached(floor){
  const d = getSave();
  const u = d.unlocks;
  const gained = [];
  if(floor >= 2 && !u.fangs){ u.fangs = true; gained.push('fangs'); }
  if(floor >= 3 && !u.spear){ u.spear = true; u.startChoice = true; gained.push('spear'); }
  if(floor >= 4 && !u.rod){ u.rod = true; u.altars = true; gained.push('rod'); }
  if(gained.length) persist();
  return gained;
}

export function noteWin(){
  const d = getSave();
  const gained = [];
  if(!d.unlocks.heat){ d.unlocks.heat = true; gained.push('heat'); }
  if(gained.length) persist();
  return gained;
}

/* tallies accumulate in memory; flushed on run end / unlock / descent (never per frame) */
export function noteKill(kind){
  const d = getSave();
  if(kind in d.tallies) d.tallies[kind]++;
}

export function noteChest(){ getSave().tallies.chests++; }
export function noteMimic(){ getSave().tallies.mimicsSprung++; }
export function noteShrine(){ getSave().tallies.shrines++; }
export function noteParkour(){ getSave().tallies.parkourPrizes++; }

export function noteWeapon(key){
  if(!key) return;
  const d = getSave();
  if(!d.weaponsWielded.includes(key)){
    d.weaponsWielded.push(key);
    /* wielded list is rare; flush so start-choice data survives a crash */
    persist();
  }
}

/** Flush in-memory profile (tallies etc.) without changing structure. */
export function flushSave(){ persist(); }

export function setSetting(key, value){
  const d = getSave();
  if(!(key in d.settings)) return;
  d.settings[key] = value;
  persist();
}

/** One-time hint: returns true if this is the first fire (should show). */
export function markHint(key){
  const d = getSave();
  if(!(key in d.hints)) return false;
  if(d.hints[key]) return false;
  d.hints[key] = true;
  persist();
  return true;
}

export function setHeatPrefs(flags){
  const d = getSave();
  d.heatPrefs = { ...d.heatPrefs, ...flags };
  persist();
}

export function saveRest(data){
  getSave().rest = data;
  persist();
}
export function clearRest(){
  getSave().rest = null;
  persist();
}
export function loadRest(){ return getSave().rest; }

export function dailySeedFor(dateStr){
  /* deterministic seed from YYYY-MM-DD */
  let h = 2166136261;
  for(let i = 0; i < dateStr.length; i++){
    h ^= dateStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) || 1;
}

export function todayISO(){
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

export function claimDailyAttempt(){
  const d = getSave();
  const day = todayISO();
  if(d.daily.date !== day){
    d.daily = { date:day, seed:dailySeedFor(day), attempted:false, bestFloor:0 };
  }
  if(d.daily.attempted) return null;
  d.daily.attempted = true;
  persist();
  return d.daily.seed;
}

export function noteDailyFloor(floor){
  const d = getSave();
  if(floor > (d.daily.bestFloor|0)) d.daily.bestFloor = floor;
  persist();
}

/** Share code: DSC-<seed>-<heat> */
export function encodeShare(seed, heat = 0){
  return 'DSC-' + ((seed >>> 0) >>> 0) + '-' + (heat|0);
}
export function parseShare(code){
  if(!code || typeof code !== 'string') return null;
  const m = code.trim().toUpperCase().match(/^DSC-(\d+)-(\d+)$/);
  if(!m) return null;
  return { seed: (parseInt(m[1], 10) >>> 0), heat: parseInt(m[2], 10)|0 };
}

const UNLOCK_LABEL = {
  fangs: 'Twin Fangs join the weapon pool',
  spear: 'Warden Spear unlocked · starting-weapon choice available',
  rod:   'Frost Rod unlocked · cursed altars begin appearing',
  heat:  'Heat system + seed sharing unlocked',
};

const TEASES = [
  { need: s => !s.unlocks.fangs,       text: 'Reach Floor 2 to unlock the Twin Fangs' },
  { need: s => !s.unlocks.spear,       text: 'Reach Floor 3 to unlock the Warden Spear' },
  { need: s => !s.unlocks.rod,         text: 'Reach Floor 4 to unlock the Frost Rod' },
  { need: s => !s.unlocks.heat,        text: 'Conquer the depths to unlock Heat' },
  { need: () => true,                  text: 'Push further — the depths remember' },
];

export function unlockLabel(id){ return UNLOCK_LABEL[id] || id; }

/** Next goal line for death/victory / fresh start. */
export function nextUnlockTease(){
  const d = getSave();
  for(const t of TEASES) if(t.need(d)) return t.text;
  return TEASES[TEASES.length - 1].text;
}

/**
 * Record a finished run (death or victory). Updates bests, history (cap 25),
 * run counters. Returns { newBest, gainedUnlocks, profile }.
 */
export function recordRunEnd({
  seed = 0,
  floor = 1,
  level = 1,
  kills = 0,
  gold = 0,
  timeSec = 0,
  deathBy = null,
  won = false,
  explorer = false,
  heat = 0,
} = {}){
  const d = getSave();
  d.runs++;
  if(won) d.wins++;

  /* unlocks from deepest floor this run (and win) */
  const gained = noteFloorReached(floor);
  if(won) gained.push(...noteWin());
  let newBest = false;
  if(explorer){
    if(floor > d.bestExplorer.floor ||
      (floor === d.bestExplorer.floor && floor > 0 && (d.bestExplorer.timeSec === 0 || timeSec < d.bestExplorer.timeSec))){
      d.bestExplorer.floor = floor;
      d.bestExplorer.timeSec = timeSec;
      newBest = true;
    }
  } else {
    newBest = floor > d.best.floor ||
      (floor === d.best.floor && floor > 0 && (d.best.timeSec === 0 || timeSec < d.best.timeSec));
    if(floor > d.best.floor){
      d.best.floor = floor;
      d.best.timeSec = timeSec;
      if(won && heat > d.best.heat) d.best.heat = heat;
    } else if(floor === d.best.floor && floor > 0 && (d.best.timeSec === 0 || timeSec < d.best.timeSec)){
      d.best.timeSec = timeSec;
    }
    if(won && heat > d.best.heat) d.best.heat = heat;
  }

  d.history.unshift({
    seed: seed >>> 0,
    floor,
    level,
    kills,
    gold,
    timeSec: Math.max(0, Math.round(timeSec)),
    date: new Date().toISOString(),
    deathBy: won ? null : (deathBy || 'the depths'),
    won: !!won,
    explorer: !!explorer,
    heat,
  });
  if(d.history.length > 25) d.history.length = 25;

  d.rest = null; // death/win clears Rest slot
  persist();
  return { newBest, gainedUnlocks: gained, profile: d };
}

/** Snapshot for tests / HUD. */
export function snapshot(){
  const d = getSave();
  return JSON.parse(JSON.stringify(d));
}
