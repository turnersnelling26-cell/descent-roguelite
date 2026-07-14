/**
 * Enemies + simple combat.
 *
 * One InstancedMesh (single draw call) holds every enemy, spawned beside the
 * generator's spawn markers. Enemies sleep until their tile is revealed by
 * fog AND the player comes near, then chase using the same axis-separated
 * grid collision as the player. Space swipes a radius around the player;
 * contact damages the player; 0 HP respawns at the entrance (fog and kills
 * persist). Lives on the scene, not the level group — survives reforge via
 * spawnEnemies() after each build.
 */
import * as THREE from 'three';
import { canStand, dashInvuln } from './player.js';
import { fogGate } from './fog.js';
import { sfx } from './audio.js';
import * as run from './state.js';
import { FINAL_FLOOR } from './state.js';
import { WEAPONS } from './weapons.js';

const CAP = 256;
/* three enemy archetypes, keyed by the generator's spawn tier:
   grunt   — melee swarmer, chases and touches you (tier 1)
   caster  — kites at range and lobs bolts (tier 2)
   charger — winds up, then dashes in a straight line (tier 3 / elite) */
const TIERS = {
  1: { behavior:'grunt',   scale:0.85, color:0xc4443a, speed:3.4, hp:1, dmg:1, xp:1, gold:1 },
  2: { behavior:'caster',  scale:0.98, color:0x53a8e6, speed:2.7, hp:2, dmg:1, xp:3, gold:3,
       fireCd:2.0, fireRange:9, keepDist:5, projSpeed:7, projDmg:1 },
  3: { behavior:'charger', scale:1.22, color:0xe07a30, speed:2.5, hp:3, dmg:2, xp:5, gold:6,
       chargeSpeed:17, windup:0.5, chargeTime:0.42, recover:1.1 },
};
/* boss — one per lair, a multi-phase fight with a HP bar (phases scale off HP) */
const BOSS_TIER = { behavior:'boss', scale:1.6, color:0xff5040, speed:2.9, hp:12, dmg:2, xp:14, gold:30,
       fireCd:1.7, fireRange:14, projSpeed:8, projDmg:1, burstCd:3.2 };
/* the mega boss — floor FINAL_FLOOR only: towering, relentless, and it summons */
const MEGA_TIER = { behavior:'boss', scale:2.1, color:0xff2a18, speed:3.2, hp:26, dmg:3, xp:60, gold:150,
       fireCd:1.3, fireRange:16, projSpeed:9, projDmg:1, burstCd:2.6, summonCd:5.5 };
const AGGRO = 6, DEAGGRO = 10, CONTACT = 0.65, E_R = 0.26;
const HIT_FLASH = 0.15, DEATH_ANIM = 0.25;
const INVULN = 0.8, HURT_FLASH = 0.25;
const PROJ_CAP = 24, PROJ_HIT = 0.55;
const EPROJ_CAP = 48, EPROJ_HIT = 0.45;

let bodies = null, ring = null, list = [];
let projPool = [], projActive = [];       // player bolts (damage enemies)
let eProjPool = [], eProjActive = [];     // enemy bolts (damage the player)
let attackAt = -1e9, hurtAt = -1e9, ringAt = -1e9, attackRadius = 1.3;
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
function gruntGeo(){    // horned imp: capsule + two out-turned horns
  return mergeGeos([
    xg(new THREE.CapsuleGeometry(0.24, 0.3, 4, 10), 0, 0.42, 0, 0,0,0, 1),
    xg(new THREE.ConeGeometry(0.06, 0.24, 5),  0.15, 0.68, 0, 0,0,-0.55, 1),
    xg(new THREE.ConeGeometry(0.06, 0.24, 5), -0.15, 0.68, 0, 0,0, 0.55, 1),
  ]);
}
function casterGeo(){   // hooded seer: robe cone + head + wide hat brim
  return mergeGeos([
    xg(new THREE.ConeGeometry(0.3, 0.62, 7),   0, 0.31, 0, 0,0,0, 1),
    xg(new THREE.SphereGeometry(0.13, 8, 7),   0, 0.70, 0, 0,0,0, 1),
    xg(new THREE.ConeGeometry(0.3, 0.14, 7),   0, 0.82, 0, 0,0,0, 1),
    xg(new THREE.ConeGeometry(0.05, 0.16, 5),  0, 0.94, 0, 0,0,0, 1),
  ]);
}
function chargerGeo(){  // battering brute: low slab + forward ram horn
  return mergeGeos([
    xg(new THREE.BoxGeometry(0.46, 0.36, 0.6), 0, 0.24, 0, 0,0,0, 1),
    xg(new THREE.ConeGeometry(0.13, 0.36, 6),  0, 0.34, 0.42, Math.PI/2,0,0, 1),
    xg(new THREE.ConeGeometry(0.06, 0.2, 5),   0.16, 0.5, 0.16, -0.5,0,-0.4, 1),
    xg(new THREE.ConeGeometry(0.06, 0.2, 5),  -0.16, 0.5, 0.16, -0.5,0, 0.4, 1),
  ]);
}
function bossGeo(){     // crowned tyrant: broad capsule + crown + shoulder spikes
  return mergeGeos([
    xg(new THREE.CapsuleGeometry(0.34, 0.5, 4, 12), 0, 0.68, 0, 0,0,0, 1),
    xg(new THREE.ConeGeometry(0.07, 0.3, 5),   0,    1.26, 0, 0,0,0, 1),
    xg(new THREE.ConeGeometry(0.06, 0.24, 5),  0.15, 1.2,  0, 0,0,-0.35, 1),
    xg(new THREE.ConeGeometry(0.06, 0.24, 5), -0.15, 1.2,  0, 0,0, 0.35, 1),
    xg(new THREE.ConeGeometry(0.09, 0.3, 5),   0.4,  0.9,  0, 0,0,-1.0, 1),
    xg(new THREE.ConeGeometry(0.09, 0.3, 5),  -0.4,  0.9,  0, 0,0, 1.0, 1),
  ]);
}
const BODY_CAPS = { grunt:160, caster:64, charger:64, boss:4 };

export function createEnemies(scene){
  const mat = new THREE.MeshStandardMaterial({ color:0xffffff, roughness:0.55, metalness:0.05 });
  bodies = {};
  const geos = { grunt:gruntGeo(), caster:casterGeo(), charger:chargerGeo(), boss:bossGeo() };
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
}

function checkWin(){
  if(won || !bossExists || list.some(e=>e.alive && e.isBoss)) return;   // the boss itself, not its minions
  won = true;
  sfx.win();     // boss down — main.js opens the descent portal off the `won` flag
}
export function dismissVictory(){
  document.getElementById('victory')?.classList.remove('show');
}

export function spawnEnemies(D){
  for(const pr of projActive){ pr.mesh.visible = false; projPool.push(pr); }
  for(const pr of eProjActive){ pr.mesh.visible = false; eProjPool.push(pr); }
  projActive.length = 0; eProjActive.length = 0;
  list = [];
  const bossRoom = D.rooms[D.boss];
  bossRoomId = bossRoom.id;
  bossPos = { x: bossRoom.cx - D.W/2 + 0.5, z: bossRoom.cy - D.H/2 + 0.5 };
  dungeonName = D.name;
  won = false; dismissVictory();
  /* enemies grow sturdier with the run's depth (character reset lives in
     newRun()/nextFloor(), called by main.js before the floor is built) */
  const hpMul = 1 + (run.state.floor - 1) * 0.3;
  let bossPlaced = false;
  for(const sp of D.spawns){
    if(list.length >= CAP) break;
    const bx = sp.x - D.W/2 + 0.5, bz = sp.y - D.H/2 + 0.5;
    /* stand beside the spawn totem, not inside it (cosmetic — plain Math.random
       is fine here, generation determinism is untouched) */
    let x = bx, z = bz;
    for(let a=0; a<6; a++){
      const ang = Math.random()*Math.PI*2, r = 0.35 + Math.random()*0.2;
      const tx = bx + Math.cos(ang)*r, tz = bz + Math.sin(ang)*r;
      if(canStand(D, tx, tz, E_R)){ x = tx; z = tz; break; }
    }
    /* the boss lair holds exactly one boss (the first spawn there); its other
       spawns become grunt minions that harry you during the fight. Elsewhere,
       archetype is a weighted roll (mostly grunts, some casters, few chargers)
       decoupled from the generator's difficulty tier — that tier instead scales
       HP, so deeper rooms are tougher without being all-elite. */
    let T, isBoss = false;
    if(sp.roomId === bossRoomId && !bossPlaced){
      T = run.state.floor >= FINAL_FLOOR ? MEGA_TIER : BOSS_TIER;
      isBoss = true; bossPlaced = true;
    }
    else if(sp.roomId === bossRoomId){ T = TIERS[1]; }
    else { const r = Math.random(); T = r < 0.6 ? TIERS[1] : r < 0.85 ? TIERS[2] : TIERS[3]; }
    const tierMul = isBoss ? 1 : 1 + (sp.tier - 1) * 0.3;
    const hp = Math.max(1, Math.round(T.hp * hpMul * tierMul));
    list.push({ x, z, tier:sp.tier, roomId:sp.roomId, T, behavior:T.behavior, isBoss,
                hp, maxHp:hp, alive:true, gone:false, aggro:false, cd:0, flashAt:-1e9, deadAt:0,
                mode:'idle', modeT:-1e9, recoverAt:-1e9, fireAt:-1e9, burstAt:-1e9, phase:1,
                cvx:0, cvz:0, curColor:-1, ti:sp.y*D.W + sp.x, ph:Math.random()*Math.PI*2 });
  }
  bossExists = bossPlaced;
  /* assign each enemy a slot in its archetype's InstancedMesh */
  const counts = { grunt:0, caster:0, charger:0, boss:0 };
  for(const e of list){
    e.mkey = e.behavior;
    if(counts[e.mkey] >= BODY_CAPS[e.mkey]) e.mkey = 'grunt';   // overflow safety
    e.mi = counts[e.mkey]++;
    e.face = 0;
  }
  for(const k in bodies) bodies[k].count = counts[k];
  list.forEach(e=>bodies[e.mkey].setColorAt(e.mi, _c.set(e.T.color)));
  for(const k in bodies) if(bodies[k].instanceColor) bodies[k].instanceColor.needsUpdate = true;
}

/* mid-fight reinforcement (mega boss summons) — grabs a free grunt slot */
function summonGrunt(x, z, ti, hpMul){
  const m = bodies.grunt;
  if(m.count >= BODY_CAPS.grunt) return;
  const T = TIERS[1];
  const e = { x, z, tier:1, roomId:bossRoomId, T, behavior:'grunt', isBoss:false,
    hp:Math.max(1, Math.round(T.hp*hpMul)), maxHp:1, alive:true, gone:false, aggro:true,
    cd:0, flashAt:-1e9, deadAt:0, mode:'idle', modeT:-1e9, recoverAt:-1e9,
    fireAt:-1e9, burstAt:-1e9, phase:1, cvx:0, cvz:0, curColor:-1, ti,
    ph:Math.random()*Math.PI*2, mkey:'grunt', mi:m.count, face:0 };
  m.count++;
  m.setColorAt(e.mi, _c.set(T.color));
  if(m.instanceColor) m.instanceColor.needsUpdate = true;
  list.push(e);
}

/* apply a hit from (fromX,fromZ): damage, knockback along the blow, death/kill */
function damageEnemy(e, dmg, knock, fromX, fromZ, D, t){
  e.hp -= dmg; e.flashAt = t;
  sfx.hit();
  const d = Math.hypot(e.x - fromX, e.z - fromZ) || 1;
  const ux = (e.x - fromX)/d, uz = (e.z - fromZ)/d, kx = e.x + ux*knock, kz = e.z + uz*knock;
  if(canStand(D, kx, e.z, E_R)) e.x = kx;
  if(canStand(D, e.x, kz, E_R)) e.z = kz;
  if(e.hp <= 0){
    e.alive = false; e.deadAt = t; e.aggro = false;
    run.addKill(e.T.xp, e.T.gold);
    if(run.state.mods.lifesteal) run.heal(run.state.mods.lifesteal);   // Vampiric Fang
    sfx.kill(); checkWin();
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
  pr.ttl = w.range / w.projSpeed + 0.1; pr.dmg = w.dmg + run.state.mods.dmgBonus; pr.knock = w.knock;
  pr.mesh.material.color.set(w.color);
  pr.mesh.position.set(pp.x, 0.9, pp.z); pr.mesh.visible = true;
  projActive.push(pr);
}

function updateProjectiles(dt, D, t){
  for(let i=projActive.length-1; i>=0; i--){
    const pr = projActive[i];
    pr.ttl -= dt;
    const nx = pr.x + pr.vx*dt, nz = pr.z + pr.vz*dt;
    let done = pr.ttl <= 0 || !canStand(D, nx, nz, 0.08);   // expire on wall / timeout
    if(!done){
      pr.x = nx; pr.z = nz; pr.mesh.position.set(nx, 0.9, nz);
      for(const e of list){
        if(!e.alive) continue;
        if(Math.hypot(e.x - nx, e.z - nz) < PROJ_HIT){ damageEnemy(e, pr.dmg, pr.knock, nx, nz, D, t); done = true; break; }
      }
    }
    if(done){ pr.mesh.visible = false; projActive.splice(i,1); projPool.push(pr); }
  }
}

/* environmental damage (spike traps etc.) — hurts enemies too; their deaths
   count as kills, feed relics, and chip the boss ward quota */
export function damageEnemiesAt(x, z, r, dmg, D, t){
  for(const e of list){
    if(!e.alive) continue;
    if(Math.hypot(e.x - x, e.z - z) < r) damageEnemy(e, dmg, 0.3, x, z, D, t);
  }
}

export function tryAttack(player, D, t){
  const w = WEAPONS[run.state.weaponKey] || WEAPONS.blade;
  if(t < attackAt + w.cd * run.state.mods.atkCdMul) return;   // Hunter's Mark speeds this up
  const pp = player.root.position;
  if(w.kind === 'ranged'){
    if(!run.spendMana(w.mana)) return;          // out of mana → no shot
    attackAt = t; sfx.swing();
    spawnProjectile(player, w, t);
    return;
  }
  /* melee: radial swipe scaled to the weapon's reach */
  attackAt = t; ringAt = t; attackRadius = w.radius;
  sfx.swing();
  ring.position.set(pp.x, 0.5, pp.z);
  const dmg = w.dmg + run.state.mods.dmgBonus;   // Focusing Lens
  for(const e of list){
    if(!e.alive) continue;
    if(Math.hypot(e.x - pp.x, e.z - pp.z) > w.radius) continue;
    damageEnemy(e, dmg, w.knock, pp.x, pp.z, D, t);
  }
}

/* -------- enemy behaviours -------- */
function moveToward(e, tx, tz, step, D){        // step<0 = retreat; axis-separated collision
  const dx = tx - e.x, dz = tz - e.z, d = Math.hypot(dx, dz) || 1;
  e.face = Math.atan2(dx, dz);                  // face the target even while retreating
  const nx = e.x + (dx/d)*step;
  if(canStand(D, nx, e.z, E_R)) e.x = nx;
  const nz = e.z + (dz/d)*step;
  if(canStand(D, e.x, nz, E_R)) e.z = nz;
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
function updateCaster(e, dt, D, pp, dist, t){    // kite at range, lob bolts
  const T = e.T;
  e.face = Math.atan2(pp.x - e.x, pp.z - e.z);
  if(dist < T.keepDist - 0.4) moveToward(e, pp.x, pp.z, -T.speed*dt, D);
  else if(dist > T.fireRange) moveToward(e, pp.x, pp.z, T.speed*dt, D);
  if(dist <= T.fireRange && t - e.fireAt > T.fireCd){
    e.fireAt = t;
    const dx = pp.x - e.x, dz = pp.z - e.z, l = Math.hypot(dx, dz) || 1;
    fireEnemyBolt(e.x, e.z, dx/l, dz/l, T.projSpeed, T.projDmg, 0x7fd0ff);
    sfx.swing();
  }
}
function updateCharger(e, dt, D, pp, dist, t){   // idle → wind-up → dash → recover
  const T = e.T;
  if(e.mode === 'idle'){
    if(dist > 0.6) moveToward(e, pp.x, pp.z, T.speed*dt, D);
    if(dist < 6 && t - e.recoverAt > T.recover){ e.mode = 'wind'; e.modeT = t; }
  } else if(e.mode === 'wind'){
    if(t - e.modeT > T.windup){                  // lock aim, then launch
      const dx = pp.x - e.x, dz = pp.z - e.z, l = Math.hypot(dx, dz) || 1;
      e.cvx = dx/l; e.cvz = dz/l; e.face = Math.atan2(e.cvx, e.cvz);
      e.mode = 'charge'; e.modeT = t;
    }
  } else if(e.mode === 'charge'){
    const step = T.chargeSpeed*dt;
    let hit = false;
    const nx = e.x + e.cvx*step; if(canStand(D, nx, e.z, E_R)) e.x = nx; else hit = true;
    const nz = e.z + e.cvz*step; if(canStand(D, e.x, nz, E_R)) e.z = nz; else hit = true;
    if(hit || t - e.modeT > T.chargeTime){ e.mode = 'recover'; e.recoverAt = t; }
  } else if(t - e.recoverAt > T.recover) e.mode = 'idle';
}
function updateBoss(e, dt, D, pp, dist, t){      // 3 phases by HP: stalk → volley → burst
  const T = e.T, frac = e.hp / e.maxHp;
  e.phase = frac > 0.66 ? 1 : frac > 0.33 ? 2 : 3;
  e.face = Math.atan2(pp.x - e.x, pp.z - e.z);
  const spd = T.speed * (e.phase===3 ? 1.4 : e.phase===2 ? 1.15 : 1);
  if(dist > 1.5) moveToward(e, pp.x, pp.z, spd*dt, D);   // close to melee; contact code handles the slam
  if(e.phase >= 2 && dist <= T.fireRange && t - e.fireAt > T.fireCd){
    e.fireAt = t;
    fireSpread(e, pp, e.phase===3 ? 5 : 3, T.projSpeed, T.projDmg);
    sfx.swing();
  }
  if(e.phase === 3 && t - e.burstAt > T.burstCd){
    e.burstAt = t;
    fireRing(e, 12, T.projSpeed*0.8, T.projDmg);
  }
  /* the mega boss (final floor) calls reinforcements from phase 2 on */
  if(T.summonCd && e.phase >= 2 && t - (e.summonAt ?? -1e9) > T.summonCd){
    e.summonAt = t;
    const hpMul = 1 + (run.state.floor - 1) * 0.3;
    for(let k=0; k<2; k++){
      const a = Math.random()*Math.PI*2, r = 1.6 + Math.random();
      const sx = e.x + Math.sin(a)*r, sz = e.z + Math.cos(a)*r;
      if(canStand(D, sx, sz, E_R)) summonGrunt(sx, sz, e.ti, hpMul);
    }
  }
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
          if(run.damage(pr.dmg)) sfx.die();
        }
      }
    }
    if(done){ pr.mesh.visible = false; eProjActive.splice(i,1); eProjPool.push(pr); }
  }
}
function updateBossBar(t){
  const bar = document.getElementById('bossbar');
  if(!bar) return;
  const boss = list.find(e=>e.isBoss && e.alive);
  if(boss && fogGate(boss.ti, t) > 0.5){
    bar.classList.add('show');
    const frac = Math.max(0, boss.hp / boss.maxHp), fill = bar.querySelector('.bfill');
    fill.style.width = (frac*100) + '%';
    fill.style.background = frac > 0.5 ? '#e0a53a' : frac > 0.25 ? '#e07a30' : '#d8433a';
  } else bar.classList.remove('show');
}

export function updateEnemies(dt, D, player, t){
  if(!list.length){ updateBossBar(t); return; }
  const pp = player.root.position;
  let colorsDirty = false;

  /* player hurt flash / restore */
  const pm = player.body.material;
  if(t - hurtAt < HURT_FLASH){ pm.emissive.set(0xff3020); pm.emissiveIntensity = 1.2; }
  else { pm.emissive.set(0x3fd0bb); pm.emissiveIntensity = 0.55; }

  for(let i=0; i<list.length; i++){
    const e = list[i];
    if(e.gone) continue;

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
      const aggroR = e.isBoss ? 12 : (e.behavior==='caster' ? 8 : AGGRO);
      if(dist < aggroR) e.aggro = true;
      else if(dist > aggroR + 4) e.aggro = false;

      if(e.aggro){                      // archetype-specific movement + attacks
        if(e.behavior === 'caster')       updateCaster(e, dt, D, pp, dist, t);
        else if(e.behavior === 'charger') updateCharger(e, dt, D, pp, dist, t);
        else if(e.behavior === 'boss')    updateBoss(e, dt, D, pp, dist, t);
        else if(dist > 0.45)              moveToward(e, pp.x, pp.z, e.T.speed*dt, D);  // grunt
      }

      /* contact damage (per-enemy cooldown + player invulnerability) */
      e.cd -= dt;
      if(dist < CONTACT && e.cd <= 0 && t - hurtAt > INVULN && !dashInvuln(t)){
        e.cd = 0.8; hurtAt = t;
        sfx.hurt();
        const dead = run.damage(e.T.dmg);
        if(run.state.mods.thorns && e.alive) damageEnemy(e, run.state.mods.thorns, 0.35, pp.x, pp.z, D, t);  // Bramble Heart
        const d = dist || 1;            // shove the player back
        const px = pp.x + (pp.x - e.x)/d * 0.5, pz = pp.z + (pp.z - e.z)/d * 0.5;
        if(canStand(D, px, pp.z)) pp.x = px;
        if(canStand(D, pp.x, pz)) pp.z = pz;
        if(dead){ sfx.die(); return; }   // run ends — main.js shows the summary off state.dead
      }
    }

    /* colour: hit-flash white; charger telegraphs its wind-up and glows mid-dash */
    let col;
    if(t - e.flashAt < HIT_FLASH)                     col = 0xffffff;
    else if(e.behavior==='charger' && e.mode==='wind')   col = 0xfff0c0;
    else if(e.behavior==='charger' && e.mode==='charge') col = 0xffd27a;
    else                                              col = e.T.color;
    if(col !== e.curColor){ bodies[e.mkey].setColorAt(e.mi, _c.set(col)); e.curColor = col; colorsDirty = true; }

    /* per-archetype idle/attack animation */
    let y = 0, rx = 0, rz = 0, face = e.face;
    if(e.behavior === 'caster'){
      y = 0.16 + 0.07*Math.sin(t*2.6 + e.ph);            // hover, always afloat
    } else if(e.behavior === 'charger'){
      y = 0.02*Math.sin(t*3 + e.ph);
      if(e.mode === 'wind'){ face += 0.1*Math.sin(t*38); rx = -0.12; }   // trembling wind-up
      else if(e.mode === 'charge') rx = 0.32;                            // head-down ram
      else if(e.mode === 'recover') rx = -0.1;
    } else if(e.behavior === 'boss'){
      y = 0.05*Math.sin(t*3.4 + e.ph);
      if(e.phase === 3) rz = 0.06*Math.sin(t*10);        // enraged shudder
    } else {
      y = e.aggro ? 0.07*Math.sin(t*9 + e.ph) : 0.03*Math.sin(t*2.2 + e.ph);
      if(e.aggro) rz = 0.08*Math.sin(t*9 + e.ph);        // scurrying waddle
    }
    _p.set(e.x, y, e.z);
    _q.setFromEuler(_E.set(rx, face, rz));
    _s.setScalar(Math.max(e.T.scale * g, 0.0001));
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
  updateBossBar(t);

  /* attack swing ring — sized to the equipped weapon's reach */
  const rk = (t - ringAt) / 0.25;
  if(rk < 1){
    ring.scale.setScalar((0.4 + rk*1.1) * attackRadius/1.3);
    ring.material.opacity = 0.7*(1 - rk);
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
