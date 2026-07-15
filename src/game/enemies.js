/**
 * Enemies + simple combat.
 *
 * One InstancedMesh (single draw call) holds every enemy, spawned beside the
 * generator's spawn markers. Enemies sleep until their tile is revealed by
 * fog AND the player comes near, then chase using the same axis-separated
 * grid collision as the player. Space swipes a radius around the player;
 * contact damages the player; 0 HP is permadeath (main.js ends the run).
 * Lives on the scene, not the level group — survives reforge via
 * spawnEnemies() after each build.
 */
import * as THREE from 'three';
import { canStand, dashInvuln, applyRoot, applySlow, airborne, getDecoy, clearDecoy } from './player.js';
import { fogGate } from './fog.js';
import { sfx } from './audio.js';
import * as run from './state.js';
import { FINAL_FLOOR } from './state.js';
import { WEAPONS } from './weapons.js';
import { gRaw } from './rng.js';
import { isMazeRoom } from './parkour.js';
import { noteKill } from './save.js';
import {
  floorHpMul, floorEliteChance, rollArchetypeForFloor, rollEliteAffix,
} from './curriculum.js';

const CAP = 256;
/* archetypes — curriculum table chooses which appear per floor */
const ARCH = {
  grunt:    { behavior:'grunt',    scale:0.85, color:0xc4443a, speed:3.4, hp:1, dmg:1, xp:1, gold:1 },
  caster:   { behavior:'caster',   scale:0.98, color:0x53a8e6, speed:2.7, hp:2, dmg:1, xp:3, gold:3,
              fireCd:2.0, fireRange:9, keepDist:5, projSpeed:7, projDmg:1 },
  charger:  { behavior:'charger',  scale:1.22, color:0xe07a30, speed:2.5, hp:3, dmg:2, xp:5, gold:6,
              chargeSpeed:17, windup:0.5, chargeTime:0.42, recover:1.1 },
  bomber:   { behavior:'bomber',   scale:1.05, color:0xe8c040, speed:2.2, hp:2, dmg:2, xp:4, gold:4,
              swellTime:0.8, blastR:1.6 },
  warden:   { behavior:'warden',   scale:1.15, color:0x6a8fbf, speed:2.2, hp:4, dmg:1, xp:6, gold:6,
              shieldDeg:120 },
  summoner: { behavior:'summoner', scale:0.95, color:0xb06cf0, speed:2.4, hp:2, dmg:0, xp:7, gold:8,
              keepDist:8, summonCd:4.5, summonCap:3 },
};
/* legacy tier keys used by generator-adjacent code / summons */
const TIERS = { 1: ARCH.grunt, 2: ARCH.caster, 3: ARCH.charger };
/* boss — one per lair, a multi-phase fight with a HP bar (phases scale off HP) */
const BOSS_TIER = { behavior:'boss', scale:1.6, color:0xff5040, speed:2.9, hp:12, dmg:2, xp:14, gold:30,
       fireCd:1.7, fireRange:14, projSpeed:8, projDmg:1, burstCd:3.2 };
/* the mega boss — floor FINAL_FLOOR only: towering, summons, dual theme signatures */
const MEGA_TIER = { behavior:'boss', scale:2.1, color:0xff2a18, speed:3.2, hp:30, dmg:3, xp:60, gold:150,
       fireCd:1.3, fireRange:16, projSpeed:9, projDmg:1, burstCd:2.6, summonCd:5.5 };

const AFFIX = {
  swift:     { color:0x7fd0ff, spdMul:1.35 },
  stony:     { color:0x9aa0b0, hpMul:1.60, knockImmune:true },
  vampiric:  { color:0xc44a6a, vamp:true },
  volatile:  { color:0xff8a30, deathBurst:true },
};
const ELITE_SCALE = 1.15;
const AGGRO = 6.5, DEAGGRO = 10, CONTACT = 0.62, E_R = 0.28;
const HIT_FLASH = 0.12, DEATH_ANIM = 0.28;
const INVULN = 0.75, HURT_FLASH = 0.22;
const PROJ_CAP = 24, PROJ_HIT = 0.55;
const EPROJ_CAP = 48, EPROJ_HIT = 0.45;
const HITSTOP = 0.045; // brief freeze on solid hits for impact

let bodies = null, ring = null, list = [];
let projPool = [], projActive = [];       // player bolts (damage enemies)
let eProjPool = [], eProjActive = [];     // enemy bolts (damage the player)
let attackAt = -1e9, hurtAt = -1e9, ringAt = -1e9, attackRadius = 1.3;
let hitstopUntil = -1e9, lungeUntil = -1e9, lungeX = 0, lungeZ = 0;
let bossRoomId = -1, bossPos = null, dungeonName = '', won = false, bossExists = false;

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(),
      _s = new THREE.Vector3(), _m = new THREE.Matrix4(), _c = new THREE.Color(),
      _E = new THREE.Euler();

/* ---- silhouette kit: single-color merged shapes, one InstancedMesh per
   archetype so each enemy type reads at a glance ---- */
function xg(g, x, y, z, rx, ry, rz, s){
  const c = g.index ? g.toNonIndexed() : g.clone();
  _m.compose(_p.set(x,y,z), _q.setFromEuler(_E.set(rx,ry,rz)), _s.setScalar(s));
  c.applyMatrix4(_m);
  return c;
}
function mergeGeos(parts){
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
/* Blocky silhouettes — same language as the dungeon geometry */
function gruntGeo(){    // stocky horned cube-imp
  return mergeGeos([
    xg(new THREE.BoxGeometry(0.42, 0.38, 0.36), 0, 0.36, 0, 0,0,0, 1),
    xg(new THREE.BoxGeometry(0.28, 0.22, 0.28), 0, 0.66, 0, 0,0,0, 1),
    xg(new THREE.BoxGeometry(0.10, 0.22, 0.10),  0.14, 0.86, 0, 0,0,-0.3, 1),
    xg(new THREE.BoxGeometry(0.10, 0.22, 0.10), -0.14, 0.86, 0, 0,0, 0.3, 1),
  ]);
}
function casterGeo(){   // floating robe tower + hat slab
  return mergeGeos([
    xg(new THREE.BoxGeometry(0.40, 0.55, 0.40), 0, 0.40, 0, 0,0,0, 1),
    xg(new THREE.BoxGeometry(0.26, 0.22, 0.26), 0, 0.78, 0, 0,0,0, 1),
    xg(new THREE.BoxGeometry(0.48, 0.10, 0.48), 0, 0.92, 0, 0,0,0, 1),
    xg(new THREE.BoxGeometry(0.10, 0.18, 0.10), 0, 1.06, 0, 0,0,0, 1),
  ]);
}
function chargerGeo(){  // low battering brick + ram block
  return mergeGeos([
    xg(new THREE.BoxGeometry(0.52, 0.36, 0.62), 0, 0.28, 0, 0,0,0, 1),
    xg(new THREE.BoxGeometry(0.22, 0.22, 0.36), 0, 0.38, 0.40, 0,0,0, 1),
    xg(new THREE.BoxGeometry(0.10, 0.18, 0.10),  0.18, 0.52, 0.18, 0,0,0, 1),
    xg(new THREE.BoxGeometry(0.10, 0.18, 0.10), -0.18, 0.52, 0.18, 0,0,0, 1),
  ]);
}
function bossGeo(){     // crowned tyrant brick stack
  return mergeGeos([
    xg(new THREE.BoxGeometry(0.62, 0.70, 0.50), 0, 0.55, 0, 0,0,0, 1),
    xg(new THREE.BoxGeometry(0.40, 0.30, 0.40), 0, 1.05, 0, 0,0,0, 1),
    xg(new THREE.BoxGeometry(0.12, 0.28, 0.12), 0, 1.34, 0, 0,0,0, 1),
    xg(new THREE.BoxGeometry(0.10, 0.22, 0.10),  0.16, 1.28, 0, 0,0,0, 1),
    xg(new THREE.BoxGeometry(0.10, 0.22, 0.10), -0.16, 1.28, 0, 0,0,0, 1),
    xg(new THREE.BoxGeometry(0.18, 0.20, 0.18),  0.40, 0.85, 0, 0,0,0, 1),
    xg(new THREE.BoxGeometry(0.18, 0.20, 0.18), -0.40, 0.85, 0, 0,0,0, 1),
  ]);
}
function bomberGeo(){   // fuse crate
  return mergeGeos([
    xg(new THREE.BoxGeometry(0.46, 0.42, 0.46), 0, 0.32, 0, 0,0,0, 1),
    xg(new THREE.BoxGeometry(0.10, 0.24, 0.10), 0, 0.62, 0, 0,0,0, 1),
    xg(new THREE.BoxGeometry(0.14, 0.14, 0.14), 0, 0.78, 0, 0,0,0, 1),
  ]);
}
function wardenGeo(){   // walking shield wall
  return mergeGeos([
    xg(new THREE.BoxGeometry(0.50, 0.72, 0.28), 0, 0.46, 0, 0,0,0, 1),
    xg(new THREE.BoxGeometry(0.56, 0.60, 0.12), 0, 0.50, 0.22, 0,0,0, 1),
    xg(new THREE.BoxGeometry(0.14, 0.48, 0.22),  0.30, 0.42, 0, 0,0,0, 1),
    xg(new THREE.BoxGeometry(0.14, 0.48, 0.22), -0.30, 0.42, 0, 0,0,0, 1),
  ]);
}
function summonerGeo(){ // staff mage tower
  return mergeGeos([
    xg(new THREE.BoxGeometry(0.32, 0.62, 0.32), 0, 0.40, 0, 0,0,0, 1),
    xg(new THREE.BoxGeometry(0.22, 0.22, 0.22), 0, 0.82, 0, 0,0,0, 1),
    xg(new THREE.BoxGeometry(0.08, 0.72, 0.08), 0.24, 0.50, 0, 0,0,0.2, 1),
    xg(new THREE.BoxGeometry(0.14, 0.14, 0.14), 0.24, 0.90, 0, 0,0,0, 1),
  ]);
}
const BODY_CAPS = { grunt:160, caster:64, charger:64, bomber:48, warden:32, summoner:24, boss:4 };
let nextEid = 1;

export function createEnemies(scene){
  const mat = new THREE.MeshStandardMaterial({ color:0xffffff, roughness:0.55, metalness:0.05 });
  bodies = {};
  const geos = {
    grunt:gruntGeo(), caster:casterGeo(), charger:chargerGeo(),
    bomber:bomberGeo(), warden:wardenGeo(), summoner:summonerGeo(), boss:bossGeo(),
  };
  for(const k in geos){
    const m = new THREE.InstancedMesh(geos[k], mat, BODY_CAPS[k]);
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = true;
    scene.add(m);
    bodies[k] = m;
  }

  const rg = new THREE.TorusGeometry(0.9, 0.045, 8, 36);
  rg.rotateX(-Math.PI/2);
  ring = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({
    color:0x9ffdea, transparent:true, opacity:0, toneMapped:false, depthWrite:false }));
  scene.add(ring);

  /* player projectile pool (ranged weapons) — small glowing bolts, reused */
  const pgeo = new THREE.SphereGeometry(0.15, 10, 8);
  for(let i=0; i<PROJ_CAP; i++){
    const m = new THREE.Mesh(pgeo, new THREE.MeshBasicMaterial({ color:0xff7a4a, toneMapped:false }));
    m.visible = false; scene.add(m);
    projPool.push({ mesh:m, x:0, z:0, vx:0, vz:0, ttl:0, dmg:0, knock:0 });
  }
  /* enemy projectile pool (caster + boss bolts) — damage the player */
  const egeo = new THREE.SphereGeometry(0.17, 10, 8);
  for(let i=0; i<EPROJ_CAP; i++){
    const m = new THREE.Mesh(egeo, new THREE.MeshBasicMaterial({ color:0xff5540, toneMapped:false }));
    m.visible = false; scene.add(m);
    eProjPool.push({ mesh:m, x:0, z:0, vx:0, vz:0, ttl:0, dmg:0 });
  }
  /* heart pickups */
  const hgeo = new THREE.OctahedronGeometry(0.16);
  for(let i=0; i<HEART_N; i++){
    const m = new THREE.Mesh(hgeo, new THREE.MeshBasicMaterial({
      color:0xff5a6a, toneMapped:false, transparent:true, opacity:1 }));
    m.visible = false; scene.add(m);
    hearts.push({ mesh:m, live:false, x:0, z:0, at:0 });
  }
}

function checkWin(){
  if(won || !bossExists || list.some(e=>e.alive && e.isBoss)) return;   // the boss itself, not its minions
  won = true;
  sfx.win();     // boss down — main.js opens the descent portal off the `won` flag
}
export function dismissVictory(){
  document.getElementById('victory')?.classList.remove('show');
}

function makeEnemyBase(x, z, T, sp, isBoss){
  return {
    id: nextEid++, x, z, tier:sp?.tier ?? 1, roomId:sp?.roomId ?? bossRoomId,
    T, behavior:T.behavior, isBoss,
    hp:1, maxHp:1, alive:true, gone:false, aggro:false, cd:0, flashAt:-1e9, deadAt:0,
    mode:'idle', modeT:-1e9, recoverAt:-1e9, fireAt:-1e9, burstAt:-1e9, phase:1,
    cvx:0, cvz:0, curColor:-1, ti:sp ? (sp.y*D_W_CACHE + sp.x) : 0,
    ph:Math.random()*Math.PI*2, face:0,
    elite:false, affix:null, knockImmune:false, spdMul:1, vamp:false, deathBurst:false,
    summonerId:null, sigs:[], sigAt:-1e9, lastPhase:1,
  };
}
let D_W_CACHE = 0;

function assignElite(e, affixKey){
  const a = AFFIX[affixKey];
  if(!a) return;
  e.elite = true; e.affix = affixKey;
  e.spdMul = a.spdMul || 1;
  e.knockImmune = !!a.knockImmune;
  e.vamp = !!a.vamp;
  e.deathBurst = !!a.deathBurst;
  if(a.hpMul){ e.hp = Math.max(1, Math.round(e.hp * a.hpMul)); e.maxHp = e.hp; }
  e.T = { ...e.T, scale: e.T.scale * ELITE_SCALE, color: a.color,
          gold: Math.round(e.T.gold * 3), xp: e.T.xp };
}

function tyrantSigs(){
  const seen = run.state.themesSeen || [];
  if(seen.length >= 2) return [seen[0], seen[seen.length - 1]];
  if(seen.length === 1) return [seen[0], run.state.floorTheme || seen[0]];
  return [run.state.floorTheme || 'ancient', 'molten'];
}

export function spawnEnemies(D){
  for(const pr of projActive){ pr.mesh.visible = false; projPool.push(pr); }
  for(const pr of eProjActive){ pr.mesh.visible = false; eProjPool.push(pr); }
  projActive.length = 0; eProjActive.length = 0;
  list = [];
  D_W_CACHE = D.W;
  const bossRoom = D.rooms[D.boss];
  bossRoomId = bossRoom.id;
  bossPos = { x: bossRoom.cx - D.W/2 + 0.5, z: bossRoom.cy - D.H/2 + 0.5 };
  dungeonName = D.name;
  won = false; introShown = false; dismissVictory();
  hearts.forEach(h=>{ h.live = false; h.mesh.visible = false; });
  let hpMul = floorHpMul(run.state.floor);
  const eliteChance = floorEliteChance(run.state.floor);
  const eliteRooms = new Set(
    D.rooms.filter(r=>r.type === 'elite').map(r=>r.id)
  );
  const eliteRoomClaimed = new Set();
  const entId = D.rooms[D.entrance]?.id;
  /* no spawns in entrance room or tiles adjacent to it (safe first room) */
  const safeRooms = new Set([entId]);
  if(entId != null){
    for(const r of D.rooms){
      if(r.id === entId) continue;
      /* adjoining: share an edge via doorway proximity — use room graph if present */
      if((r.degree != null && r.type === 'entrance')) safeRooms.add(r.id);
    }
  }
  let bossPlaced = false;
  let mazeSkip = 0;
  for(const sp of D.spawns){
    if(list.length >= CAP) break;
    if(safeRooms.has(sp.roomId) && sp.roomId !== bossRoomId) continue;
    /* maze rooms: sparse foes so parkour reads as traversal, not another kill-box */
    if(isMazeRoom(sp.roomId) && sp.roomId !== bossRoomId){
      mazeSkip++;
      if(mazeSkip % 3 !== 1) continue; // keep ~1/3 of spawns
    }
    /* also skip spawns very near entrance center */
    const ent = D.rooms[D.entrance];
    if(ent && Math.abs(sp.x - ent.cx) + Math.abs(sp.y - ent.cy) < 6) continue;
    const bx = sp.x - D.W/2 + 0.5, bz = sp.y - D.H/2 + 0.5;
    /* stand beside the spawn totem (cosmetic — unseeded) */
    let x = bx, z = bz;
    for(let a=0; a<6; a++){
      const ang = Math.random()*Math.PI*2, r = 0.35 + Math.random()*0.2;
      const tx = bx + Math.cos(ang)*r, tz = bz + Math.sin(ang)*r;
      if(canStand(D, tx, tz, E_R)){ x = tx; z = tz; break; }
    }
    let T, isBoss = false;
    if(sp.roomId === bossRoomId && !bossPlaced){
      T = { ...(run.state.floor >= FINAL_FLOOR ? MEGA_TIER : BOSS_TIER) };
      if(run.state.heatFlags?.iron){
        T.hp = Math.round(T.hp * 1.25);
        T.burstCd = (T.burstCd || 3) * 0.75;
        T.fireCd = (T.fireCd || 1.7) * 0.75;
        T.ironExtra = true; // extra mid-fight ring at phase changes
      }
      isBoss = true; bossPlaced = true;
    }
    else if(sp.roomId === bossRoomId){ T = ARCH.grunt; }
    else {
      const key = rollArchetypeForFloor(run.state.floor, gRaw());
      T = ARCH[key] || ARCH.grunt;
    }
    const tierMul = isBoss ? 1 : 1 + (sp.tier - 1) * 0.3;
    const hp = Math.max(1, Math.round(T.hp * hpMul * tierMul));
    const e = makeEnemyBase(x, z, T, sp, isBoss);
    e.ti = sp.y * D.W + sp.x;
    e.hp = hp; e.maxHp = hp;
    if(run.state.heatFlags?.swift) e.spdMul = (e.spdMul || 1) * 1.15;
    if(isBoss){
      e.sigs = run.state.floor >= FINAL_FLOOR
        ? tyrantSigs()
        : [run.state.floorTheme || 'ancient'];
    } else if(T.behavior !== 'grunt' || sp.roomId !== bossRoomId){
      /* elites: roll chance, or guarantee one per elite room from floor 3 */
      let makeElite = false;
      if(eliteChance > 0){
        if(eliteRooms.has(sp.roomId) && !eliteRoomClaimed.has(sp.roomId)){
          makeElite = true; eliteRoomClaimed.add(sp.roomId);
        } else if(gRaw() < eliteChance) makeElite = true;
      }
      if(makeElite) assignElite(e, rollEliteAffix(gRaw()));
    }
    list.push(e);
  }
  bossExists = bossPlaced;
  const counts = { grunt:0, caster:0, charger:0, bomber:0, warden:0, summoner:0, boss:0 };
  for(const e of list){
    e.mkey = e.behavior;
    if(!BODY_CAPS[e.mkey] || counts[e.mkey] >= BODY_CAPS[e.mkey]) e.mkey = 'grunt';
    e.mi = counts[e.mkey]++;
  }
  for(const k in bodies) bodies[k].count = counts[k] || 0;
  list.forEach(e=>bodies[e.mkey].setColorAt(e.mi, _c.set(e.T.color)));
  for(const k in bodies) if(bodies[k].instanceColor) bodies[k].instanceColor.needsUpdate = true;
}

/* mid-fight reinforcement — grabs a free grunt slot */
function summonGrunt(x, z, ti, hpMul, opts = {}){
  const m = bodies.grunt;
  if(m.count >= BODY_CAPS.grunt) return null;
  const T = ARCH.grunt;
  const hp = Math.max(1, Math.round(T.hp * hpMul));
  const e = makeEnemyBase(x, z, T, null, false);
  e.ti = ti; e.hp = hp; e.maxHp = hp; e.aggro = true;
  e.roomId = opts.roomId ?? bossRoomId;
  e.summonerId = opts.summonerId ?? null;
  e.mkey = 'grunt'; e.mi = m.count;
  m.count++;
  m.setColorAt(e.mi, _c.set(T.color));
  if(m.instanceColor) m.instanceColor.needsUpdate = true;
  list.push(e);
  return e;
}

/* a "chest" that bites — loot.js calls this when a mimic is sprung */
export function spawnMimicPack(x, z, ti, D){
  const hpMul = floorHpMul(run.state.floor);
  for(let k=0; k<3; k++){
    const a = k/3*Math.PI*2 + Math.random(), r = 0.6 + Math.random()*0.4;
    const sx = x + Math.sin(a)*r, sz = z + Math.cos(a)*r;
    if(canStand(D, sx, sz, E_R)) summonGrunt(sx, sz, ti, hpMul, { roomId: -1 });
  }
}

/** 120° front shield — true if the attack comes from the warden's facing cone. */
function wardenBlocks(e, fromX, fromZ){
  if(e.behavior !== 'warden' || !e.alive) return false;
  const dx = fromX - e.x, dz = fromZ - e.z;
  const ang = Math.atan2(dx, dz);
  let diff = ang - e.face;
  while(diff > Math.PI) diff -= Math.PI * 2;
  while(diff < -Math.PI) diff += Math.PI * 2;
  const half = ((e.T.shieldDeg || 120) / 2) * (Math.PI / 180);
  return Math.abs(diff) <= half;
}

/* hook for floating damage numbers (main.js renders them) */
let onDamageCb = null;
export const onEnemyDamage = cb => { onDamageCb = cb; };

/* apply a hit from (fromX,fromZ): damage, knockback along the blow, death/kill */
function damageEnemy(e, dmg, knock, fromX, fromZ, D, t, crit=false, opts={}){
  if(!opts.pierceShield && wardenBlocks(e, fromX, fromZ)){
    e.flashAt = t;
    if(sfx.block) sfx.block(); else sfx.swing();
    return false;
  }
  e.hp -= dmg; e.flashAt = t;
  /* execute: finish low HP */
  if(run.state.mods.execute && e.hp > 0 && e.hp / e.maxHp <= run.state.mods.execute){
    e.hp = 0;
  }
  if(onDamageCb) onDamageCb(e.x, e.z, dmg, crit);
  if(crit) sfx.crit();
  else sfx.hit();
  /* punchier knockback; scale by remaining HP for light enemies */
  const knockMul = e.isBoss ? 0.55 : (1 + 0.15 * (1 - e.hp / Math.max(1, e.maxHp)));
  if(!e.knockImmune){
    const d = Math.hypot(e.x - fromX, e.z - fromZ) || 1;
    const ux = (e.x - fromX)/d, uz = (e.z - fromZ)/d;
    const kAmt = knock * knockMul;
    const kx = e.x + ux*kAmt, kz = e.z + uz*kAmt;
    if(canStand(D, kx, e.z, E_R)) e.x = kx;
    if(canStand(D, e.x, kz, E_R)) e.z = kz;
  }
  if(e.hp <= 0){
    /* Volatile elite: 0.5s telegraph then burst (spec §5.3) */
    if(e.deathBurst && e.mode !== 'volSwell' && e.mode !== 'dead'){
      e.deathBurst = false; e.hp = 0.01; e.mode = 'volSwell'; e.modeT = t; e.aggro = false;
      return true;
    }
    e.alive = false; e.deadAt = t; e.aggro = false;
    run.addKill(e.T.xp, e.T.gold);
    if(run.state.mods.lifesteal) run.heal(run.state.mods.lifesteal);
    if(opts.boltKill && run.state.mods.boltMana) run.state.mana = Math.min(run.state.maxMana, run.state.mana + run.state.mods.boltMana);
    if(e.isBoss) noteKill(run.state.floor >= FINAL_FLOOR ? 'mega' : 'boss');
    else noteKill(e.behavior);
    const heartP = run.state.mods.heartChance || 0.08;
    if(e.elite || (!e.isBoss && Math.random() < heartP)) dropHeart(e.x, e.z, t);
    sfx.kill(); checkWin();
  }
  return true;
}

/* -------- heart drops: small pickups that heal 1, fading after 6s -------- */
const HEART_N = 8, HEART_TTL = 6;
let hearts = [];
function dropHeart(x, z, t){
  const h = hearts.find(h=>!h.live);
  if(!h) return;
  h.live = true; h.x = x; h.z = z; h.at = t;
  h.mesh.visible = true;
}
function updateHearts(dt, player, t){
  const pp = player.root.position;
  for(const h of hearts){
    if(!h.live) continue;
    const age = t - h.at;
    if(age > HEART_TTL){ h.live = false; h.mesh.visible = false; continue; }
    h.mesh.position.set(h.x, 0.55 + 0.1*Math.sin(t*3 + h.x), h.z);
    h.mesh.rotation.y = t*2;
    h.mesh.material.opacity = age > HEART_TTL-1.5 ? (HEART_TTL-age)/1.5 : 1;   // blink out
    if(Math.hypot(pp.x - h.x, pp.z - h.z) < 0.7){
      h.live = false; h.mesh.visible = false;
      run.heal(1); sfx.pickup();
    }
  }
}

/* fire a bolt toward the nearest alive foe in range, else straight ahead */
function spawnProjectile(player, w, t){
  const pr = projPool.pop();
  if(!pr) return;
  const pp = player.root.position;
  let tx = null, tz = null, best = w.range;
  for(const e of list){
    if(!e.alive) continue;
    const d = Math.hypot(e.x - pp.x, e.z - pp.z);
    if(d < best){ best = d; tx = e.x; tz = e.z; }
  }
  let dx, dz;
  if(tx !== null){ dx = tx - pp.x; dz = tz - pp.z; const l = Math.hypot(dx,dz)||1; dx/=l; dz/=l; }
  else { const rot = player.body.rotation.y; dx = Math.sin(rot); dz = Math.cos(rot); }
  pr.x = pp.x; pr.z = pp.z; pr.vx = dx*w.projSpeed; pr.vz = dz*w.projSpeed;
  pr.ttl = w.range / w.projSpeed + 0.1;
  pr.dmg = w.dmg + run.effectiveDmgBonus();
  pr.knock = w.knock;
  pr.crit = w.crit || 0.10;
  pr.pierceShield = !!w.pierceShield;
  pr.slowOnHit = w.slowOnHit || 0;
  pr.slowChance = w.slowChance || 0;
  pr.mesh.material.color.set(w.color);
  pr.mesh.position.set(pp.x, 0.9, pp.z); pr.mesh.visible = true;
  projActive.push(pr);
}

function updateProjectiles(dt, D, t){
  for(let i=projActive.length-1; i>=0; i--){
    const pr = projActive[i];
    pr.ttl -= dt;
    const nx = pr.x + pr.vx*dt, nz = pr.z + pr.vz*dt;
    let done = pr.ttl <= 0 || !canStand(D, nx, nz, 0.08);
    if(!done){
      pr.x = nx; pr.z = nz; pr.mesh.position.set(nx, 0.9, nz);
      for(const e of list){
        if(!e.alive) continue;
        if(Math.hypot(e.x - nx, e.z - nz) < PROJ_HIT){
          const crit = Math.random() < run.effectiveCrit(pr.crit);
          if(crit) sfx.crit();
          damageEnemy(e, pr.dmg * (crit ? 2 : 1), pr.knock, nx, nz, D, t, crit, {
            pierceShield: pr.pierceShield, boltKill: true,
          });
          if(e.alive && pr.slowChance && Math.random() < pr.slowChance){
            e.slowUntil = t + (pr.slowOnHit || 1.2);
          }
          done = true; break;
        }
      }
    }
    if(done){ pr.mesh.visible = false; projActive.splice(i,1); projPool.push(pr); }
  }
}

/* environmental damage (spike traps etc.) — hurts enemies too; their deaths
   count as kills, feed relics, and chip the boss ward quota */
export function damageEnemiesAt(x, z, r, dmg, D, t, except = null){
  let hits = 0;
  for(const e of list){
    if(!e.alive || e === except) continue;
    if(Math.hypot(e.x - x, e.z - z) < r){
      damageEnemy(e, dmg, 0.3, x, z, D, t);
      hits++;
    }
  }
  return hits;
}

/** Living foes inside a world-space radius (theme hazards / goals). */
export function countEnemiesAt(x, z, r){
  let n = 0;
  for(const e of list){
    if(!e.alive || e.gone) continue;
    if(Math.hypot(e.x - x, e.z - z) < r) n++;
  }
  return n;
}

export function tryAttack(player, D, t){
  const w = WEAPONS[run.state.weaponKey] || WEAPONS.blade;
  if(t < attackAt + w.cd * run.state.mods.atkCdMul) return;
  if(t < hitstopUntil) return;
  const pp = player.root.position;
  const face = player.body.rotation.y;
  if(w.kind === 'ranged'){
    if(!run.spendMana(w.mana)) return;
    attackAt = t; sfx.swing();
    spawnProjectile(player, w, t);
    noteStrike(null, D, t, pp);
    return;
  }
  attackAt = t; ringAt = t; attackRadius = w.radius;
  if(w.key === 'hammer'){ if(sfx.heavySwing) sfx.heavySwing(); else sfx.swing(); }
  else sfx.swing();
  /* forward lunge — sells the swing */
  const lunge = w.key === 'hammer' ? 0.22 : w.key === 'spear' ? 0.32 : w.key === 'fangs' ? 0.18 : 0.14;
  lungeX = Math.sin(face) * lunge; lungeZ = Math.cos(face) * lunge;
  lungeUntil = t + 0.09;
  const nx = pp.x + lungeX, nz = pp.z + lungeZ;
  if(canStand(D, nx, pp.z, 0.28, true)) pp.x = nx;
  if(canStand(D, pp.x, nz, 0.28, true)) pp.z = nz;

  ring.position.set(pp.x, 0.45, pp.z);
  ring.material.color.set(w.color || 0x9ffdea);
  const crit = Math.random() < run.effectiveCrit(w.crit);
  const dmg = (w.dmg + run.effectiveDmgBonus()) * (crit ? 2 : 1);
  const hitList = [];
  /* wide front cone — Space should feel generous; facing still matters at the edges */
  const arc = w.arcDeg || (w.key === 'hammer' ? 175 : w.key === 'fangs' ? 140 : 160);
  /* slight hitbox padding so blocky mobs near reach still register */
  const reach = w.radius + 0.22;
  for(const e of list){
    if(!e.alive) continue;
    const dist = Math.hypot(e.x - pp.x, e.z - pp.z);
    if(dist > reach) continue;
    const ang = Math.atan2(e.x - pp.x, e.z - pp.z);
    let diff = ang - face;
    while(diff > Math.PI) diff -= Math.PI*2;
    while(diff < -Math.PI) diff += Math.PI*2;
    if(Math.abs(diff) > (arc/2) * Math.PI/180) continue;
    const landed = damageEnemy(e, dmg, w.knock * (crit ? 1.5 : 1), pp.x, pp.z, D, t, crit, {
      pierceShield: !!w.pierceShield,
    });
    if(landed !== false) hitList.push(e);
  }
  if(hitList.length){
    hitstopUntil = t + HITSTOP * (crit ? 1.7 : 1) * (w.key === 'hammer' ? 1.5 : w.key === 'fangs' ? 0.7 : 1);
  }
  noteStrike(hitList, D, t, pp);
}

/** True if any living foe is close enough to make menus unsafe. */
export function combatNearby(player, range = 7){
  if(!player) return false;
  const pp = player.root.position;
  for(const e of list){
    if(!e.alive || e.gone) continue;
    if(Math.hypot(e.x - pp.x, e.z - pp.z) < range) return true;
  }
  return false;
}

function noteStrike(hitList, D, t, pp){
  run.state.strikeCount = (run.state.strikeCount || 0) + 1;
  const every = run.state.mods.staticEvery | 0;
  if(every && run.state.strikeCount % every === 0){
    /* arc to up to 2 nearby foes */
    const foes = list.filter(e=>e.alive).sort((a,b)=>
      Math.hypot(a.x-pp.x,a.z-pp.z) - Math.hypot(b.x-pp.x,b.z-pp.z)).slice(0, 2);
    for(const e of foes) damageEnemy(e, 1, 0.2, pp.x, pp.z, D, t, false, { pierceShield:true });
  }
}

/* -------- enemy behaviours -------- */
function moveToward(e, tx, tz, step, D, t=0){   // step<0 = retreat; axis-separated collision
  const slow = (e.slowUntil && t < e.slowUntil) ? 0.55 : 1;
  step *= slow;
  const dx = tx - e.x, dz = tz - e.z, d = Math.hypot(dx, dz) || 1;
  e.face = Math.atan2(dx, dz);
  const ux = dx/d, uz = dz/d;
  let moved = false;
  const nx = e.x + ux*step;
  if(canStand(D, nx, e.z, E_R)){ e.x = nx; moved = true; }
  const nz = e.z + uz*step;
  if(canStand(D, e.x, nz, E_R)){ e.z = nz; moved = true; }
  /* slide around parkour blocks when direct path is blocked */
  if(!moved && Math.abs(step) > 0.001){
    const side = 0.7 * Math.sign(step || 1);
    if(canStand(D, e.x - uz*side*Math.abs(step), e.z + ux*side*Math.abs(step), E_R)){
      e.x -= uz*side*Math.abs(step); e.z += ux*side*Math.abs(step);
    } else if(canStand(D, e.x + uz*side*Math.abs(step), e.z - ux*side*Math.abs(step), E_R)){
      e.x += uz*side*Math.abs(step); e.z -= ux*side*Math.abs(step);
    }
  }
}
function fireEnemyBolt(x, z, dx, dz, speed, dmg, color){
  const pr = eProjPool.pop();
  if(!pr) return;
  pr.x = x; pr.z = z; pr.vx = dx*speed; pr.vz = dz*speed; pr.ttl = 2.6; pr.dmg = dmg;
  pr.mesh.material.color.set(color);
  pr.mesh.position.set(x, 0.85, z); pr.mesh.visible = true;
  eProjActive.push(pr);
}
function fireSpread(e, pp, n, speed, dmg){       // fan of bolts aimed at the player
  const base = Math.atan2(pp.x - e.x, pp.z - e.z), spread = 0.6;
  for(let i=0;i<n;i++){
    const a = base + (i - (n-1)/2) * (spread / Math.max(1, n-1));
    fireEnemyBolt(e.x, e.z, Math.sin(a), Math.cos(a), speed, dmg, 0xff6a40);
  }
}
function fireRing(e, n, speed, dmg){             // radial burst in every direction
  for(let i=0;i<n;i++){ const a = i/n*Math.PI*2; fireEnemyBolt(e.x, e.z, Math.sin(a), Math.cos(a), speed, dmg, 0xff8a40); }
}
/** Target position: Echo Step decoy steals aggro when present. */
function huntPos(pp, t){
  const d = getDecoy();
  if(d && t < d.until) return { x: d.x, z: d.z };
  return { x: pp.x, z: pp.z };
}

function updateCaster(e, dt, D, pp, dist, t){    // kite at range, lob bolts
  const T = e.T;
  const spd = T.speed * (e.spdMul || 1);
  const hp = huntPos(pp, t);
  const hdist = Math.hypot(hp.x - e.x, hp.z - e.z);
  e.face = Math.atan2(hp.x - e.x, hp.z - e.z);
  if(hdist < T.keepDist - 0.4) moveToward(e, hp.x, hp.z, -spd*dt, D, t);
  else if(hdist > T.fireRange) moveToward(e, hp.x, hp.z, spd*dt, D, t);
  if(dist <= T.fireRange && t - e.fireAt > T.fireCd){
    e.fireAt = t;
    const dx = pp.x - e.x, dz = pp.z - e.z, l = Math.hypot(dx, dz) || 1;
    fireEnemyBolt(e.x, e.z, dx/l, dz/l, T.projSpeed, T.projDmg, 0x7fd0ff);
    sfx.swing();
  }
}
function updateCharger(e, dt, D, pp, dist, t){   // idle → wind-up → dash → recover
  const T = e.T;
  const spd = T.speed * (e.spdMul || 1);
  const hp = huntPos(pp, t);
  const hdist = Math.hypot(hp.x - e.x, hp.z - e.z);
  if(e.mode === 'idle'){
    if(hdist > 0.6) moveToward(e, hp.x, hp.z, spd*dt, D, t);
    if(hdist < 6 && t - e.recoverAt > T.recover){ e.mode = 'wind'; e.modeT = t; }
  } else if(e.mode === 'wind'){
    if(t - e.modeT > T.windup){                  // lock aim, then launch
      const dx = hp.x - e.x, dz = hp.z - e.z, l = Math.hypot(dx, dz) || 1;
      e.cvx = dx/l; e.cvz = dz/l; e.face = Math.atan2(e.cvx, e.cvz);
      e.mode = 'charge'; e.modeT = t;
    }
  } else if(e.mode === 'charge'){
    const step = T.chargeSpeed * (e.spdMul || 1) * dt;
    let hit = false;
    const nx = e.x + e.cvx*step; if(canStand(D, nx, e.z, E_R)) e.x = nx; else hit = true;
    const nz = e.z + e.cvz*step; if(canStand(D, e.x, nz, E_R)) e.z = nz; else hit = true;
    if(hit || t - e.modeT > T.chargeTime){ e.mode = 'recover'; e.recoverAt = t; }
  } else if(t - e.recoverAt > T.recover) e.mode = 'idle';
}
function detonateBomber(e, pp, D, t){
  const T = e.T, r = T.blastR || 1.6;
  damageEnemiesAt(e.x, e.z, r, T.dmg || 2, D, t, e);
  if(Math.hypot(pp.x - e.x, pp.z - e.z) < r && t - hurtAt > INVULN && !dashInvuln(t)){
    hurtAt = t; sfx.hurt();
    if(run.damage(T.dmg || 2, e.behavior === 'bomber' ? 'a bomber' : 'a volatile elite')) sfx.die();
  }
  e.alive = false; e.deadAt = t; e.aggro = false;
  run.addKill(T.xp, T.gold);
  noteKill(e.behavior === 'bomber' ? 'bomber' : e.behavior);
  if(e.elite) dropHeart(e.x, e.z, t);
  sfx.kill(); checkWin();
}

function updateBomber(e, dt, D, pp, dist, t, player){
  const T = e.T;
  const hp = huntPos(pp, t);
  const hdist = Math.hypot(hp.x - e.x, hp.z - e.z);
  e.face = Math.atan2(hp.x - e.x, hp.z - e.z);
  if(e.mode === 'idle'){
    if(hdist > 1.4) moveToward(e, hp.x, hp.z, T.speed * (e.spdMul || 1) * dt, D, t);
    if(hdist < 1.9){ e.mode = 'swell'; e.modeT = t; }
  } else if(e.mode === 'swell'){
    if(t - e.modeT >= T.swellTime) detonateBomber(e, pp, D, t);
  }
}
function updateWarden(e, dt, D, pp, dist, t){
  const T = e.T;
  const hp = huntPos(pp, t);
  e.face = Math.atan2(hp.x - e.x, hp.z - e.z);
  const hdist = Math.hypot(hp.x - e.x, hp.z - e.z);
  if(hdist > 0.55) moveToward(e, hp.x, hp.z, T.speed * (e.spdMul || 1) * dt, D, t);
}
function updateSummoner(e, dt, D, pp, dist, t){
  const T = e.T;
  const hp = huntPos(pp, t);
  const hdist = Math.hypot(hp.x - e.x, hp.z - e.z);
  e.face = Math.atan2(hp.x - e.x, hp.z - e.z);
  if(hdist < T.keepDist) moveToward(e, hp.x, hp.z, -T.speed * (e.spdMul || 1) * dt, D, t);
  else if(hdist > T.keepDist + 3) moveToward(e, hp.x, hp.z, T.speed * 0.4 * dt, D, t);
  const kids = list.filter(x => x.alive && x.summonerId === e.id).length;
  if(kids < T.summonCap && t - e.fireAt > T.summonCd){
    e.fireAt = t;
    const a = Math.random()*Math.PI*2, r = 0.9 + Math.random()*0.4;
    const sx = e.x + Math.sin(a)*r, sz = e.z + Math.cos(a)*r;
    if(canStand(D, sx, sz, E_R)){
      summonGrunt(sx, sz, e.ti, floorHpMul(run.state.floor), {
        roomId: e.roomId, summonerId: e.id,
      });
      sfx.swing();
    }
  }
}
/* the boss never leaves its lair — every step must land on a lair tile */
const roomAt = (D, x, z)=>{
  const tx = Math.floor(x + D.W/2), tz = Math.floor(z + D.H/2);
  return (tx<0 || tz<0 || tx>=D.W || tz>=D.H) ? -1 : D.roomId[tz*D.W + tx];
};
function moveBoss(e, tx, tz, step, D){
  const dx = tx - e.x, dz = tz - e.z, d = Math.hypot(dx, dz) || 1;
  e.face = Math.atan2(dx, dz);
  const nx = e.x + (dx/d)*step;
  if(canStand(D, nx, e.z, E_R) && roomAt(D, nx, e.z) === bossRoomId) e.x = nx;
  const nz = e.z + (dz/d)*step;
  if(canStand(D, e.x, nz, E_R) && roomAt(D, e.x, nz) === bossRoomId) e.z = nz;
}
/** Boss borrows theme hazards (inlined to avoid enemies↔hazards cycle). */
function pulseBossSig(kind, e, pp, t, D, phase){
  if(kind === 'ancient' && phase >= 2){
    applyRoot(t + 0.75); sfx.hurt();
  } else if(kind === 'molten'){
    const r = 1.4 + phase * 0.25;
    if(Math.hypot(pp.x - e.x, pp.z - e.z) < r && !airborne(t)
       && t - hurtAt > INVULN && !dashInvuln(t)){
      hurtAt = t; sfx.hurt();
      if(run.damage(1, 'molten vents')) sfx.die();
    }
    damageEnemiesAt(e.x, e.z, r, 1, D, t, e);
    sfx.hit();
  } else if(kind === 'frost'){
    /* delayed icicle: mark drop on player next frames via e.icicle */
    e.icicle = { x: pp.x, z: pp.z, at: t, state: 'warn' };
  } else if(kind === 'grim'){
    if(Math.hypot(pp.x - e.x, pp.z - e.z) < 5){
      run.spendMana(1); applySlow(t + 0.8); sfx.swing();
    }
  } else if(kind === 'verdant'){
    if(Math.hypot(pp.x - e.x, pp.z - e.z) < 1.8 && !airborne(t)
       && t - hurtAt > INVULN && !dashInvuln(t)){
      hurtAt = t; sfx.hurt();
      if(run.damage(1, 'spores')) sfx.die();
      applySlow(t + 1.0);
    }
    damageEnemiesAt(e.x, e.z, 1.8, 1, D, t, e);
    sfx.kill();
  }
}
function updateBossIcicle(e, pp, t){
  if(!e.icicle) return;
  const ic = e.icicle;
  if(ic.state === 'warn' && t - ic.at >= 0.75){
    ic.state = 'drop'; ic.at = t;
  } else if(ic.state === 'drop' && t - ic.at >= 0.2){
    if(Math.hypot(pp.x - ic.x, pp.z - ic.z) < 0.8 && !airborne(t)
       && t - hurtAt > INVULN && !dashInvuln(t)){
      hurtAt = t; sfx.hurt();
      if(run.damage(1, 'an icicle')) sfx.die();
    }
    e.icicle = null;
  }
}

function updateBoss(e, dt, D, pp, dist, t, player){  // 3 phases + theme signatures
  const T = e.T, frac = e.hp / e.maxHp;
  const prevPhase = e.phase;
  e.phase = frac > 0.66 ? 1 : frac > 0.33 ? 2 : 3;
  e.face = Math.atan2(pp.x - e.x, pp.z - e.z);
  const spd = T.speed * (e.phase===3 ? 1.4 : e.phase===2 ? 1.15 : 1);
  if(dist > 1.5) moveBoss(e, pp.x, pp.z, spd*dt, D);     // close to melee, lair-bound
  if(e.phase >= 2 && dist <= T.fireRange && t - e.fireAt > T.fireCd){
    e.fireAt = t;
    fireSpread(e, pp, e.phase===3 ? 5 : 3, T.projSpeed, T.projDmg);
    sfx.swing();
  }
  if(e.phase === 3 && t - e.burstAt > T.burstCd){
    e.burstAt = t;
    fireRing(e, 12, T.projSpeed*0.8, T.projDmg);
  }
  /* theme signatures: pulse on cadence; verdant also on phase change */
  const sigs = e.sigs && e.sigs.length ? e.sigs : [run.state.floorTheme || 'ancient'];
  const sigCd = e.phase >= 3 ? 2.4 : e.phase >= 2 ? 3.2 : 4.5;
  if(t - e.sigAt > sigCd){
    e.sigAt = t;
    const kind = sigs[Math.floor(Math.random() * sigs.length)];
    pulseBossSig(kind, e, pp, t, D, e.phase);
  }
  if(e.phase > prevPhase){
    if(sigs.includes('verdant')) pulseBossSig('verdant', e, pp, t, D, e.phase);
    if(T.ironExtra) fireRing(e, 10, T.projSpeed * 0.85, T.projDmg); // Iron Tyrants extra phase behavior
  }
  /* the mega boss (final floor) calls reinforcements from phase 2 on */
  if(T.summonCd && e.phase >= 2 && t - (e.summonAt ?? -1e9) > T.summonCd){
    e.summonAt = t;
    const hpMul = floorHpMul(run.state.floor);
    for(let k=0; k<2; k++){
      const a = Math.random()*Math.PI*2, r = 1.6 + Math.random();
      const sx = e.x + Math.sin(a)*r, sz = e.z + Math.cos(a)*r;
      if(canStand(D, sx, sz, E_R)) summonGrunt(sx, sz, e.ti, hpMul);
    }
  }
  updateBossIcicle(e, pp, t);
}
function updateEnemyProjectiles(dt, D, player, t){
  const pp = player.root.position;
  for(let i=eProjActive.length-1; i>=0; i--){
    const pr = eProjActive[i];
    pr.ttl -= dt;
    const nx = pr.x + pr.vx*dt, nz = pr.z + pr.vz*dt;
    let done = pr.ttl <= 0 || !canStand(D, nx, nz, 0.06);   // expire on wall / timeout
    if(!done){
      pr.x = nx; pr.z = nz; pr.mesh.position.set(nx, 0.85, nz);
      if(Math.hypot(pp.x - nx, pp.z - nz) < EPROJ_HIT){
        done = true;
        if(t - hurtAt > INVULN && !dashInvuln(t)){        // dash i-frames dodge bolts too
          hurtAt = t; sfx.hurt();
          if(run.damage(pr.dmg, 'an enemy bolt')) sfx.die();
        }
      }
    }
    if(done){ pr.mesh.visible = false; eProjActive.splice(i,1); eProjPool.push(pr); }
  }
}
/* dramatic splash the first time the boss is revealed each floor */
let introShown = false, introTimer = null;
function showBossIntro(mega){
  const el = document.getElementById('bossintro');
  if(!el) return;
  el.textContent = mega ? '⚔ THE TYRANT OF THE DEPTHS ⚔' : '⚔ GUARDIAN OF THE LAIR ⚔';
  el.classList.add('show');
  sfx.boom();
  clearTimeout(introTimer);
  introTimer = setTimeout(()=>el.classList.remove('show'), 2600);
}
function updateBossBar(t){
  const bar = document.getElementById('bossbar');
  if(!bar) return;
  const boss = list.find(e=>e.isBoss && e.alive);
  if(boss && fogGate(boss.ti, t) > 0.5){
    if(!introShown){ introShown = true; showBossIntro(boss.T.summonCd !== undefined); }
    bar.classList.add('show');
    const frac = Math.max(0, boss.hp / boss.maxHp), fill = bar.querySelector('.bfill');
    fill.style.width = (frac*100) + '%';
    fill.style.background = frac > 0.5 ? '#e0a53a' : frac > 0.25 ? '#e07a30' : '#d8433a';
  } else bar.classList.remove('show');
}

export function updateEnemies(dt, D, player, t){
  if(!list.length){ updateBossBar(t); return; }
  /* hitstop freezes enemy AI briefly on solid hits */
  if(t < hitstopUntil){
    updateBossBar(t);
    return;
  }
  const pp = player.root.position;
  let colorsDirty = false;
  clearDecoy(t);

  /* player hurt flash / stone-skin shimmer / restore */
  const pm = player.body.material;
  const skinReady = run.state.mods.stoneSkinCd &&
    ((typeof performance !== 'undefined' ? performance.now()/1000 : t) >= (run.state.stoneSkinReadyAt || 0));
  if(t - hurtAt < HURT_FLASH){ pm.emissive.set(0xff3020); pm.emissiveIntensity = 1.2; }
  else if(skinReady){ pm.emissive.set(0xc0d0ff); pm.emissiveIntensity = 0.85 + 0.25*Math.sin(t*8); }
  else { pm.emissive.set(0x3fd0bb); pm.emissiveIntensity = 0.55; }

  for(let i=0; i<list.length; i++){
    const e = list[i];
    if(e.gone) continue;

    /* volatile death telegraph */
    if(e.mode === 'volSwell'){
      if(t - e.modeT >= 0.5){
        e.mode = 'dead';
        damageEnemiesAt(e.x, e.z, 1.5, 2, D, t, e);
        if(Math.hypot(pp.x - e.x, pp.z - e.z) < 1.5 && t - hurtAt > INVULN && !dashInvuln(t)){
          hurtAt = t; sfx.hurt();
          if(run.damage(2, 'a volatile elite')) sfx.die();
        }
        e.alive = false; e.deadAt = t;
        run.addKill(e.T.xp, e.T.gold);
        noteKill(e.behavior);
        dropHeart(e.x, e.z, t);
        sfx.kill(); checkWin();
      }
    }

    if(!e.alive){                       // death shrink, then final zero write
      const k = (t - e.deadAt) / DEATH_ANIM;
      const s = e.T.scale * Math.max(0, 1 - k);
      if(k >= 1) e.gone = true;
      _s.setScalar(Math.max(s, 0.0001));
      _p.set(e.x, 0, e.z); _q.identity();
      _m.compose(_p,_q,_s); bodies[e.mkey].setMatrixAt(e.mi,_m);
      continue;
    }

    const g = fogGate(e.ti, t);         // hidden until the room reveals
    const dist = Math.hypot(pp.x - e.x, pp.z - e.z);

    if(g >= 0.99){
      const aggroR = e.isBoss ? 12
        : (e.behavior==='caster' || e.behavior==='summoner' ? 9 : AGGRO);
      if(dist < aggroR) e.aggro = true;
      else if(dist > aggroR + 4) e.aggro = false;

      if(e.mode === 'volSwell'){ /* rooted, glowing */ }
      else if(e.aggro){                      // archetype-specific movement + attacks
        if(e.behavior === 'caster')       updateCaster(e, dt, D, pp, dist, t);
        else if(e.behavior === 'charger') updateCharger(e, dt, D, pp, dist, t);
        else if(e.behavior === 'bomber')  updateBomber(e, dt, D, pp, dist, t, player);
        else if(e.behavior === 'warden')  updateWarden(e, dt, D, pp, dist, t);
        else if(e.behavior === 'summoner') updateSummoner(e, dt, D, pp, dist, t);
        else if(e.behavior === 'boss')    updateBoss(e, dt, D, pp, dist, t, player);
        else {
          const hp = huntPos(pp, t);
          const hd = Math.hypot(hp.x - e.x, hp.z - e.z);
          if(hd > 0.45) moveToward(e, hp.x, hp.z, e.T.speed*(e.spdMul||1)*dt, D, t);
        }
      }

      /* contact damage — shorter shove, clearer i-frames */
      e.cd -= dt;
      const contactDmg = e.T.dmg || 0;
      if(contactDmg > 0 && dist < CONTACT && e.cd <= 0 && t - hurtAt > INVULN && !dashInvuln(t)
         && e.mode !== 'swell' && e.mode !== 'volSwell' && e.behavior !== 'bomber'){
        e.cd = 0.85; hurtAt = t;
        sfx.hurt();
        const cause = e.isBoss
          ? (run.state.floor >= FINAL_FLOOR ? 'the Tyrant' : 'the boss')
          : ('a ' + e.behavior);
        let dmgHit = contactDmg;
        if(run.state.mods.bulwark && (e.isBoss || e.behavior === 'charger'))
          dmgHit = Math.max(1, dmgHit - 1);
        const dead = run.damage(dmgHit, cause);
        if(e.vamp && e.alive){ e.hp = Math.min(e.maxHp, e.hp + 1); }
        if(run.state.mods.thorns && e.alive) damageEnemy(e, run.state.mods.thorns, 0.35, pp.x, pp.z, D, t);
        /* softer knock so parkour near walls is less unfair */
        const d = dist || 1;
        const shove = e.isBoss ? 0.55 : 0.38;
        const px = pp.x + (pp.x - e.x)/d * shove, pz = pp.z + (pp.z - e.z)/d * shove;
        if(canStand(D, px, pp.z)) pp.x = px;
        if(canStand(D, pp.x, pz)) pp.z = pz;
        if(dead){ sfx.die(); return; }
      }
    }

    /* colour: hit-flash / telegraphs / elite glow */
    let col;
    if(t - e.flashAt < HIT_FLASH)                     col = 0xffffff;
    else if(e.behavior==='charger' && e.mode==='wind')   col = 0xfff0c0;
    else if(e.behavior==='charger' && e.mode==='charge') col = 0xffd27a;
    else if(e.behavior==='bomber' && e.mode==='swell')   col = 0xfff06a;
    else if(e.mode==='volSwell')                          col = 0xffaa40;
    else                                              col = e.T.color;
    if(col !== e.curColor){ bodies[e.mkey].setColorAt(e.mi, _c.set(col)); e.curColor = col; colorsDirty = true; }

    /* per-archetype idle/attack animation */
    let y = 0, rx = 0, rz = 0, face = e.face;
    let sc = e.T.scale;
    if(e.behavior === 'caster' || e.behavior === 'summoner'){
      y = 0.16 + 0.07*Math.sin(t*2.6 + e.ph);
    } else if(e.behavior === 'charger'){
      y = 0.02*Math.sin(t*3 + e.ph);
      if(e.mode === 'wind'){ face += 0.1*Math.sin(t*38); rx = -0.12; }
      else if(e.mode === 'charge') rx = 0.32;
      else if(e.mode === 'recover') rx = -0.1;
    } else if((e.behavior === 'bomber' && e.mode === 'swell') || e.mode === 'volSwell'){
      const dur = e.mode === 'volSwell' ? 0.5 : (e.T.swellTime || 0.8);
      const k = Math.min(1, (t - e.modeT) / dur);
      sc = e.T.scale * (1 + 0.55 * k);
      y = 0.05 * k;
    } else if(e.behavior === 'boss'){
      y = 0.05*Math.sin(t*3.4 + e.ph);
      if(e.phase === 3) rz = 0.06*Math.sin(t*10);
    } else {
      y = e.aggro ? 0.07*Math.sin(t*9 + e.ph) : 0.03*Math.sin(t*2.2 + e.ph);
      if(e.aggro) rz = 0.08*Math.sin(t*9 + e.ph);
    }
    /* swift elite trail: slight extra bob */
    if(e.affix === 'swift') y += 0.04*Math.sin(t*14 + e.ph);
    _p.set(e.x, y, e.z);
    _q.setFromEuler(_E.set(rx, face, rz));
    _s.setScalar(Math.max(sc * g, 0.0001));
    _m.compose(_p,_q,_s); bodies[e.mkey].setMatrixAt(e.mi,_m);
  }

  /* enemy-enemy push-apart, only among the (few) aggro'd */
  const active = list.filter(e=>e.alive && e.aggro);
  for(let a=0; a<active.length; a++) for(let b=a+1; b<active.length; b++){
    const e1 = active[a], e2 = active[b];
    const dx = e2.x - e1.x, dz = e2.z - e1.z, d = Math.hypot(dx, dz);
    if(d > 0.55 || d === 0) continue;
    const push = (0.55 - d)/2, ux = dx/d, uz = dz/d;
    if(canStand(D, e1.x - ux*push, e1.z - uz*push, E_R)){ e1.x -= ux*push; e1.z -= uz*push; }
    if(canStand(D, e2.x + ux*push, e2.z + uz*push, E_R)){ e2.x += ux*push; e2.z += uz*push; }
  }

  for(const k in bodies){
    bodies[k].instanceMatrix.needsUpdate = true;
    if(colorsDirty && bodies[k].instanceColor) bodies[k].instanceColor.needsUpdate = true;
  }

  updateProjectiles(dt, D, t);
  updateEnemyProjectiles(dt, D, player, t);
  updateHearts(dt, player, t);
  updateBossBar(t);

  /* attack swing ring — sized to the equipped weapon's reach */
  const rk = (t - ringAt) / 0.22;
  if(rk < 1){
    ring.scale.setScalar((0.55 + rk*1.15) * attackRadius/1.3);
    ring.material.opacity = 0.85*(1 - rk);
    ring.material.color.set(rk < 0.15 ? 0xffffff : 0x9ffdea);
  } else ring.material.opacity = 0;

}

export function enemyStats(){
  const alive = list.filter(e=>e.alive);
  const boss = list.find(e=>e.isBoss && e.alive);
  return {
    total: list.length, alive: alive.length, hp: run.state.hp, kills: run.state.kills, won,
    bossAlive: alive.filter(e=>e.roomId === bossRoomId).length,
    bossPos,
    bossHp: boss ? boss.hp : 0, bossMaxHp: boss ? boss.maxHp : 0, bossPhase: boss ? boss.phase : 0,
    bossX: boss ? +boss.x.toFixed(2) : 0, bossZ: boss ? +boss.z.toFixed(2) : 0,
    bossFoes: alive.filter(e=>e.roomId === bossRoomId).map(e=>({x:+e.x.toFixed(2), z:+e.z.toFixed(2)})),
    behaviors: alive.reduce((m,e)=>{ m[e.behavior]=(m[e.behavior]||0)+1; return m; }, {}),
    casterPos: (()=>{ const e = alive.find(x=>x.behavior==='caster'); return e?{x:+e.x.toFixed(2),z:+e.z.toFixed(2),ti:e.ti}:null; })(),
    chargerPos: (()=>{ const e = alive.find(x=>x.behavior==='charger'); return e?{x:+e.x.toFixed(2),z:+e.z.toFixed(2)}:null; })(),
    eProj: eProjActive.length,
    nearest: alive.slice(0,3).map(e=>({x:+e.x.toFixed(2), z:+e.z.toFixed(2), tier:e.tier})),
    foes: alive.slice(0,60).map(e=>({x:+e.x.toFixed(2), z:+e.z.toFixed(2), hp:e.hp,
      inLair: e.roomId === bossRoomId, behavior: e.behavior })),
  };
}
