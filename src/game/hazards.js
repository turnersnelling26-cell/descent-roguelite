/**
 * Environmental hazards — the dungeon fights back, in its own dialect.
 *
 * SPIKE TRAPS (all themes): telegraphed floor spikes that skewer players AND
 *   enemies. They conceal themselves — plates only fade into view when the
 *   player is near, and hide again as you move away.
 *
 * PITS (all themes): dark holes in the floor. Step in and you fall — one
 *   heart and you're hauled back to your last safe footing. Jump (C) clears
 *   them; a careless dash does not.
 *
 * THEMED HAZARD (one per theme):
 *   ancient  — rune snares: violet glyphs that root you in place
 *   molten   — fire vents: periodic flame jets on a heartbeat
 *   frost    — falling icicles: a warning ring chases you, then the sky drops
 *   grim     — soul wisps: drifting lights that drink your mana
 *   verdant  — spore pods: swell and burst, slowing and stinging
 */
import * as THREE from 'three';
import { FLOOR } from '../gen/dungeon.js';
import * as run from './state.js';
import { fogSeen, fogGate } from './fog.js';
import { dashInvuln, airborne, applyRoot, applySlow } from './player.js';
import { damageEnemiesAt } from './enemies.js';
import { sfx } from './audio.js';
import { gI, gF, gRaw } from './rng.js';
import { floorThemeHazards } from './curriculum.js';
import { noteThemeProgress } from './goals.js';

const CAP = 24, PERIOD = 2.6, WARN_AT = 1.5, OUT_AT = 2.0, IN_AT = 2.4;
const HIT_R = 0.62, DMG = 1, PLAYER_CD = 1.0, CONCEAL_R = 6;
const PIT_CAP = 12, PIT_R = 0.42, THEME_CAP = 8;

let plates = null, spikes = null, traps = [], lastHitAt = -1e9;
let pitMeshes = [], pits = [], lastSafe = { x:0, z:0 };
let themed = [], themeKind = '', themeMeshes = [];
let icicleRing = null, icicleCone = null, icicle = { state:'idle', at:-1e9, x:0, z:0 };
/* frost pacing: re-armed each forge so the first strike never greets the spawn.
   The sky holds its fire until the player takes their first step. */
let icicleGap = 3.6, icicleArm = true, icicleAwake = false, armX = 0, armZ = 0;
const ICICLE_GRACE = 2.5;

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(),
      _s = new THREE.Vector3(), _m = new THREE.Matrix4(), _c = new THREE.Color();

function spikeGeo(){
  const parts = [];
  const mk = (x, z, r, h)=>{
    const g = new THREE.ConeGeometry(r, h, 5).translate(x, h/2, z);
    parts.push(g.index ? g.toNonIndexed() : g);
  };
  mk(0, 0, 0.11, 0.55);
  mk( 0.24,  0.20, 0.085, 0.42); mk(-0.22,  0.24, 0.08, 0.4);
  mk( 0.20, -0.24, 0.08,  0.4);  mk(-0.25, -0.18, 0.085, 0.44);
  let vc = 0; for(const g of parts) vc += g.attributes.position.count;
  const pos = new Float32Array(vc*3), nor = new Float32Array(vc*3);
  let o = 0;
  for(const g of parts){
    pos.set(g.attributes.position.array, o*3);
    nor.set(g.attributes.normal.array, o*3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos,3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor,3));
  return out;
}

export function createHazards(scene){
  plates = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.86, 0.06, 0.86),
    new THREE.MeshStandardMaterial({ color:0xffffff, roughness:0.6, metalness:0.3 }), CAP);
  spikes = new THREE.InstancedMesh(
    spikeGeo(),
    new THREE.MeshStandardMaterial({ color:0xd8dbe6, roughness:0.35, metalness:0.55 }), CAP);
  for(const m of [plates, spikes]){ m.count = 0; m.frustumCulled = false; scene.add(m); }

  /* pits: dark disc + faint rim */
  const pitGeo = new THREE.CircleGeometry(PIT_R + 0.06, 14).rotateX(-Math.PI/2);
  const rimGeo = new THREE.RingGeometry(PIT_R + 0.04, PIT_R + 0.12, 14).rotateX(-Math.PI/2);
  for(let i=0; i<PIT_CAP; i++){
    const g = new THREE.Group();
    const hole = new THREE.Mesh(pitGeo, new THREE.MeshBasicMaterial({ color:0x000000 }));
    const rim  = new THREE.Mesh(rimGeo, new THREE.MeshBasicMaterial({
      color:0x11131c, transparent:true, opacity:0.8 }));
    hole.position.y = 0.012; rim.position.y = 0.013;
    g.add(hole, rim); g.visible = false;
    scene.add(g);
    pitMeshes.push(g);
  }

  /* themed hazard mesh pool: one small mesh per entity, retinted per theme */
  for(let i=0; i<THEME_CAP; i++){
    const m = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.26, 0),
      new THREE.MeshBasicMaterial({ color:0xffffff, toneMapped:false, transparent:true, opacity:0.9 }));
    m.visible = false;
    scene.add(m);
    themeMeshes.push(m);
  }
  /* frost icicle: warning ring + falling cone (single strike at a time) */
  icicleRing = new THREE.Mesh(
    new THREE.RingGeometry(0.5, 0.72, 22).rotateX(-Math.PI/2),
    new THREE.MeshBasicMaterial({ color:0x9fd8ff, toneMapped:false, transparent:true, opacity:0, depthWrite:false }));
  icicleRing.position.y = 0.03;
  icicleCone = new THREE.Mesh(
    new THREE.ConeGeometry(0.16, 0.9, 6).rotateX(Math.PI),
    new THREE.MeshBasicMaterial({ color:0xcfeaff, toneMapped:false, transparent:true, opacity:0.95 }));
  icicleCone.visible = false;
  scene.add(icicleRing, icicleCone);
}

/* pick a clear floor tile inside a room set, spaced from taken spots (seeded) */
function pickTile(D, rooms, taken, minGap){
  if(!rooms.length) return null;
  for(let guard=0; guard<80; guard++){
    const r = rooms[gI(0, rooms.length - 1)];
    const x = Math.floor(r.cx - r.w/2 + 1 + gRaw()*(r.w - 2));
    const z = Math.floor(r.cy - r.h/2 + 1 + gRaw()*(r.h - 2));
    if(x<1 || z<1 || x>=D.W-1 || z>=D.H-1) continue;
    const c = z*D.W + x;
    if(D.grid[c] !== FLOOR || D.roomId[c] !== r.id || D.doorway[c] || D.lakeMask[c]) continue;
    if(taken.some(p=>Math.abs(p.tx-x) + Math.abs(p.tz-z) < minGap)) continue;
    return { tx:x, tz:z, c };
  }
  return null;
}

export function spawnHazards(D, themeKey){
  const combat = D.rooms.filter(r=>r.type==='combat' || r.type==='elite');
  const anyRoom = D.rooms.filter(r=>r.type!=='entrance');

  /* spike traps */
  traps = [];
  const nTraps = Math.min(CAP, 8 + run.state.floor*2);
  while(traps.length < nTraps){
    const p = pickTile(D, combat, traps, 3);
    if(!p) break;
    traps.push({ ...p, x:p.tx - D.W/2 + 0.5, z:p.tz - D.H/2 + 0.5, ti:p.c,
                 ph:gF(0, PERIOD), cd:0, vis:0, pcol:-1 });
  }
  plates.count = spikes.count = traps.length;

  /* Damaging pits removed — parkour maze rooms own jump-gaps (no HP loss). */
  pits = [];
  pitMeshes.forEach(m=>{ m.visible = false; });

  /* themed hazard — light on floor 1, full after (each theme has a unique verb) */
  themeKind = themeKey;
  themed = [];
  themeMeshes.forEach(m=>m.visible = false);
  icicleRing.material.opacity = 0; icicleCone.visible = false; icicle.state = 'idle';
  const light = !floorThemeHazards(run.state.floor); // floor 1 still gets a taste
  if(themeKey === 'frost'){                              // frost is the global icicle controller
    icicleGap = light ? 7.5 : 3.6;                       // floor 1: a taste, not a barrage
    icicleArm = true; icicleAwake = false;               // hold fire until the player moves
    return;
  }
  const KINDS = {
    ancient: { n: light ? 3 : 8, color:0x9b6cf0 },
    molten:  { n: light ? 3 : 8, color:0xff7a30 },
    grim:    { n: light ? 2 : 5, color:0x8a5adf },
    verdant: { n: light ? 3 : 8, color:0x7ac04a },
  };
  const spec = KINDS[themeKey];
  if(!spec) return;
  for(let i=0; i<spec.n && i<THEME_CAP; i++){
    const p = pickTile(D, anyRoom, [...traps, ...pits, ...themed], light ? 6 : 4);
    if(!p) break;
    const h = { ...p, x:p.tx - D.W/2 + 0.5, z:p.tz - D.H/2 + 0.5, ti:p.c,
                cd:0, ph:gF(0, 4), at:-1e9, mesh:themeMeshes[i] };
    h.mesh.material.color.set(spec.color);
    themed.push(h);
  }
}



/* one damage gate for every hazard that can hit the player */
function hazHit(dmg, t){
  if(t - lastHitAt < PLAYER_CD || dashInvuln(t)) return false;
  lastHitAt = t;
  sfx.hurt();
  if(run.damage(dmg, 'a hazard')) sfx.die();
  return true;
}

function updateSpikes(dt, D, pp, t){
  if(!traps.length) return;
  let colors = false;
  for(let i=0; i<traps.length; i++){
    const tr = traps[i];
    const k = (t + tr.ph) % PERIOD;
    const striking = k >= OUT_AT && k < IN_AT;
    const warning  = k >= WARN_AT && k < OUT_AT;
    /* concealment: the plate only reveals itself near the player */
    const near = Math.hypot(pp.x - tr.x, pp.z - tr.z) < CONCEAL_R;
    tr.vis += ((near ? 1 : 0) - tr.vis) * Math.min(1, 5*dt);
    const g = (fogSeen(tr.ti) ? fogGate(tr.ti, t) : 0) * tr.vis;

    const want = warning ? 0xcf7a2e : (striking ? 0x8a3226 : 0x3a3f4e);
    if(tr.pcol !== want){ plates.setColorAt(i, _c.set(want)); tr.pcol = want; colors = true; }
    _p.set(tr.x, 0.02, tr.z); _q.identity(); _s.setScalar(Math.max(g, 0.0001));
    _m.compose(_p,_q,_s); plates.setMatrixAt(i,_m);
    const sy = striking ? 1 : (warning ? 0.12 : 0.0001);
    _s.set(Math.max(g,0.0001), Math.max(sy*g, 0.0001), Math.max(g,0.0001));
    _m.compose(_p,_q,_s); spikes.setMatrixAt(i,_m);

    if(striking && tr.vis > 0.3){
      if(tr.cd <= 0){ damageEnemiesAt(tr.x, tr.z, HIT_R, DMG, D, t); tr.cd = 0.5; }
      if(!airborne(t) && Math.hypot(pp.x - tr.x, pp.z - tr.z) < HIT_R) hazHit(DMG, t);
    }
    tr.cd -= dt;
  }
  plates.instanceMatrix.needsUpdate = true;
  spikes.instanceMatrix.needsUpdate = true;
  if(colors && plates.instanceColor) plates.instanceColor.needsUpdate = true;
}

function updatePits(){ /* no-op: damaging pits retired in favor of parkour gaps */ }

function updateThemed(dt, D, player, pp, t){
  /* frost: a warning ring finds you, then the ceiling lets go */
  if(themeKind === 'frost'){
    if(icicleArm){ icicleArm = false; armX = pp.x; armZ = pp.z; }
    if(!icicleAwake){
      /* asleep until the first step — reading the floor intro is always safe */
      if(Math.hypot(pp.x - armX, pp.z - armZ) < 0.75) return;
      icicleAwake = true;
      icicle.at = t + ICICLE_GRACE - icicleGap;
    }
    if(icicle.state === 'idle' && t - icicle.at > icicleGap){
      icicle.state = 'warn'; icicle.at = t;
      icicle.x = pp.x; icicle.z = pp.z;
      icicleRing.position.set(icicle.x, 0.03, icicle.z);
    } else if(icicle.state === 'warn'){
      const k = (t - icicle.at) / 0.8;
      icicleRing.material.opacity = 0.65 * (0.5 + 0.5*Math.sin(t*14));
      icicleRing.scale.setScalar(1 - 0.3*k);
      /* ring slowly tracks so dodging is a real decision */
      icicle.x += (pp.x - icicle.x) * Math.min(1, 1.8 * dt);
      icicle.z += (pp.z - icicle.z) * Math.min(1, 1.8 * dt);
      icicleRing.position.set(icicle.x, 0.03, icicle.z);
      if(k >= 1){
        icicle.state = 'drop'; icicle.at = t;
        icicleCone.visible = true;
      }
    } else if(icicle.state === 'drop'){
      const k = (t - icicle.at) / 0.22;
      icicleCone.position.set(icicle.x, 4.5*(1 - k) + 0.45, icicle.z);
      if(k >= 1){
        icicleRing.material.opacity = 0; icicleCone.visible = false;
        const hit = !airborne(t) && Math.hypot(pp.x - icicle.x, pp.z - icicle.z) < 0.75;
        if(hit) hazHit(DMG, t);
        else noteThemeProgress('frost'); // dodge counts toward theme goal
        damageEnemiesAt(icicle.x, icicle.z, 0.75, DMG, D, t);
        sfx.hit();
        icicle.state = 'idle'; icicle.at = t;
      }
    }
    return;
  }

  for(const h of themed){
    const m = h.mesh, g = fogSeen(h.ti) ? fogGate(h.ti, t) : 0;
    m.visible = g > 0.01;
    h.cd -= dt;
    const d = Math.hypot(pp.x - h.x, pp.z - h.z);

    if(themeKind === 'ancient'){                 // rune snare: flat spinning glyph
      m.position.set(h.x, 0.04, h.z);
      m.rotation.set(-Math.PI/2, 0, t*0.8 + h.ph);
      m.scale.set(g, g, 0.12*g);
      if(d < 0.55 && h.cd <= 0 && !airborne(t)){
        h.cd = 4;
        applyRoot(t + 0.9);
        sfx.hurt();
        /* progress when snared — surviving the root is the lesson */
        noteThemeProgress('ancient');
      }
    } else if(themeKind === 'molten'){           // fire vent on a heartbeat
      const k = (t + h.ph) % 3.4;
      const jet = k > 2.5 && k < 3.1, warn = k > 2.1 && k <= 2.5;
      m.position.set(h.x, jet ? 0.7 : 0.08, h.z);
      m.rotation.set(0, t*2, 0);
      const sy = jet ? 1.6 : (warn ? 0.35 : 0.16);
      m.scale.set(0.7*g, sy*g, 0.7*g);
      m.material.color.set(jet ? 0xffb040 : (warn ? 0xff7a30 : 0x7a2e18));
      if(jet && d < 0.7 && !airborne(t)) hazHit(DMG, t);
      if(jet && h.cd <= 0){
        const hits = damageEnemiesAt(h.x, h.z, 0.7, DMG, D, t);
        if(hits > 0) noteThemeProgress('molten', hits);
        h.cd = 0.6;
      }
    } else if(themeKind === 'grim'){             // soul wisp: drifts to you, sips mana
      if(g >= 0.99 && d < 8 && d > 0.1){
        const step = 1.6*dt;
        h.x += (pp.x - h.x)/d * step;
        h.z += (pp.z - h.z)/d * step;
      }
      m.position.set(h.x, 0.9 + 0.15*Math.sin(t*2 + h.ph), h.z);
      m.rotation.set(t, t*1.3, 0);
      m.scale.setScalar(0.7*g*(0.9 + 0.15*Math.sin(t*3 + h.ph)));
      if(d < 0.8 && h.cd <= 0){
        h.cd = 1.6;
        run.spendMana(1);                        // it drinks — no blood, just power
        applySlow(t + 0.6);
        sfx.swing();
        noteThemeProgress('grim');
      }
    } else if(themeKind === 'verdant'){          // spore pod: swells, then bursts
      const regrown = t - h.at > 8;
      m.visible = m.visible && regrown;
      if(!regrown) continue;
      const swell = d < 2 ? 1 + 0.3*Math.sin(t*10) : 1 + 0.05*Math.sin(t*2 + h.ph);
      m.position.set(h.x, 0.26, h.z);
      m.scale.setScalar(0.9*g*swell);
      if(d < 1.0){
        h.at = t;                                // burst
        if(!airborne(t)) { hazHit(DMG, t); applySlow(t + 1.2); }
        damageEnemiesAt(h.x, h.z, 1.2, DMG, D, t);
        sfx.kill();
        noteThemeProgress('verdant');
      }
    }
  }
}

export function updateHazards(dt, D, player, t){
  const pp = player.root.position;
  updateSpikes(dt, D, pp, t);
  updatePits(dt, D, player, pp, t);
  updateThemed(dt, D, player, pp, t);
}

export const hazardStats = ()=>({
  traps: traps.length, pits: pits.length, themeKind, themed: themed.length,
  positions: traps.slice(0,4).map(tr=>({x:+tr.x.toFixed(2), z:+tr.z.toFixed(2), ph:+tr.ph.toFixed(2)})),
  pitPositions: pits.slice(0,4).map(p=>({x:+p.x.toFixed(2), z:+p.z.toFixed(2)})),
});
