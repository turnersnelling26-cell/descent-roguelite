/**
 * Environmental hazards — the dungeon fights back.
 *
 * Spike traps: scattered on combat/elite room floors. Each runs a fixed cycle
 * (idle → glowing telegraph → spikes out → retract) on its own phase offset.
 * The strike hurts the PLAYER and ENEMIES alike — a wakeful eye can lure a
 * chase across a trap. Dash i-frames dodge the strike. Trap count scales with
 * floor depth. Fog-gated like everything else.
 *
 * Two InstancedMeshes (plates + spikes) on the scene, rewritten per frame
 * (≤24 instances — trivial).
 */
import * as THREE from 'three';
import { FLOOR } from '../gen/dungeon.js';
import * as run from './state.js';
import { fogSeen, fogGate } from './fog.js';
import { dashInvuln } from './player.js';
import { damageEnemiesAt } from './enemies.js';
import { sfx } from './audio.js';

const CAP = 24, PERIOD = 2.6, WARN_AT = 1.5, OUT_AT = 2.0, IN_AT = 2.4;
const HIT_R = 0.62, DMG = 1, PLAYER_CD = 1.0;

let plates = null, spikes = null, traps = [], lastHitAt = -1e9;

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(),
      _s = new THREE.Vector3(), _m = new THREE.Matrix4(), _c = new THREE.Color();

function spikeGeo(){
  /* five-cone cluster, merged by hand (positions+normals only) */
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
}

export function spawnHazards(D){
  traps = [];
  const W = D.W, count = Math.min(CAP, 8 + run.state.floor*2);
  const rooms = D.rooms.filter(r=>r.type==='combat' || r.type==='elite');
  let guard = 0;
  while(traps.length < count && guard++ < 400 && rooms.length){
    const r = rooms[Math.floor(Math.random()*rooms.length)];
    const x = Math.floor(r.cx - r.w/2 + 1 + Math.random()*(r.w - 2));
    const z = Math.floor(r.cy - r.h/2 + 1 + Math.random()*(r.h - 2));
    if(x<0 || z<0 || x>=W || z>=D.H) continue;
    const c = z*W + x;
    if(D.grid[c] !== FLOOR || D.roomId[c] !== r.id || D.doorway[c] || D.lakeMask[c]) continue;
    if(traps.some(tr=>Math.abs(tr.tx-x) + Math.abs(tr.tz-z) < 3)) continue;   // spacing
    traps.push({ tx:x, tz:z, x:x - W/2 + 0.5, z:z - D.H/2 + 0.5, ti:c,
                 ph: Math.random()*PERIOD, cd:0 });
  }
  plates.count = spikes.count = traps.length;
  traps.forEach((tr,i)=>{
    plates.setColorAt(i, _c.set(0x3a3f4e));
    spikes.setColorAt(i, _c.set(0xd8dbe6));
  });
  if(plates.instanceColor) plates.instanceColor.needsUpdate = true;
  if(spikes.instanceColor) spikes.instanceColor.needsUpdate = true;
}

export function updateHazards(dt, D, player, t){
  if(!traps.length) return;
  const pp = player.root.position;
  let colors = false;
  for(let i=0; i<traps.length; i++){
    const tr = traps[i];
    const k = (t + tr.ph) % PERIOD;
    const g = fogSeen(tr.ti) ? fogGate(tr.ti, t) : 0;
    const striking = k >= OUT_AT && k < IN_AT;
    const warning  = k >= WARN_AT && k < OUT_AT;

    /* plate: glows amber during the telegraph */
    const want = warning ? 0xcf7a2e : (striking ? 0x8a3226 : 0x3a3f4e);
    if(tr.pcol !== want){ plates.setColorAt(i, _c.set(want)); tr.pcol = want; colors = true; }
    _p.set(tr.x, 0.02, tr.z); _q.identity(); _s.setScalar(Math.max(g, 0.0001));
    _m.compose(_p,_q,_s); plates.setMatrixAt(i,_m);

    /* spikes: rise fast on strike, sink otherwise; a sliver peeks in telegraph */
    const sy = striking ? 1 : (warning ? 0.12 : 0.0001);
    _s.set(Math.max(g,0.0001), Math.max(sy*g, 0.0001), Math.max(g,0.0001));
    _m.compose(_p,_q,_s); spikes.setMatrixAt(i,_m);

    if(striking && g >= 0.99){
      if(tr.cd <= 0){ damageEnemiesAt(tr.x, tr.z, HIT_R, DMG, D, t); tr.cd = 0.5; }
      if(t - lastHitAt > PLAYER_CD && !dashInvuln(t) &&
         Math.hypot(pp.x - tr.x, pp.z - tr.z) < HIT_R){
        lastHitAt = t;
        sfx.hurt();
        if(run.damage(DMG)) sfx.die();
      }
    }
    tr.cd -= dt;
  }
  plates.instanceMatrix.needsUpdate = true;
  spikes.instanceMatrix.needsUpdate = true;
  if(colors && plates.instanceColor) plates.instanceColor.needsUpdate = true;
}

export const hazardStats = ()=>({ traps: traps.length,
  positions: traps.slice(0,4).map(tr=>({x:+tr.x.toFixed(2), z:+tr.z.toFixed(2), ph:+tr.ph.toFixed(2)})) });
