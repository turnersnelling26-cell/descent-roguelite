/**
 * Player controller — WASD/arrow movement over the dungeon tile grid with
 * axis-separated collision (which gives wall-sliding for free), plus a small
 * follow light. Pure prototype: no combat, no interaction.
 *
 * The player lives directly on the scene (never on the level `group`), so it
 * survives disposeLevel()/reforge; call spawnPlayer() after each build.
 */
import * as THREE from 'three';
import { FLOOR } from '../gen/dungeon.js';
import * as run from './state.js';
import { sfx } from './audio.js';

const SPEED = 7;      // tiles per second
const RADIUS = 0.3;   // collision radius, must stay < 0.5 (one tile)

/* -------- dash: a short, fast burst with i-frames, paid for in mana -------- */
const DASH_SPEED = 20, DASH_TIME = 0.16, DASH_CD = 0.55, DASH_IFRAME = 0.24, DASH_COST = 1;
let dashEnd = -1e9, dashCdEnd = -1e9, dashIfrEnd = -1e9, dashX = 0, dashZ = 0;
let velX = 0, velZ = 0;      // persisted so frozen lakes can carry momentum
/* Echo Step decoy — taunts foes for 1.5s at dash origin */
let decoy = null; // { x, z, until }
export function getDecoy(){ return decoy && decoy.until > 0 ? decoy : null; }
export function clearDecoy(t){ if(decoy && t >= decoy.until) decoy = null; }

export function tryDash(player, t){
  if(t < dashCdEnd || t < dashEnd) return false;
  if(!run.spendMana(DASH_COST)) return false;
  const rot = player.body.rotation.y;
  dashX = Math.sin(rot); dashZ = Math.cos(rot);
  const distMul = run.state.mods.dashDistMul || 1;
  dashEnd = t + DASH_TIME * distMul;
  dashCdEnd = t + DASH_CD * run.state.mods.dashCdMul;
  dashIfrEnd = t + DASH_IFRAME + run.state.mods.iframeBonus;
  if(run.state.mods.echoStep){
    const p = player.root.position;
    decoy = { x: p.x, z: p.z, until: t + 1.5 };
  }
  sfx.swing();
  return true;
}
export function failedDashNoMana(){
  return run.state.mana < DASH_COST;
}
export const dashInvuln = t => t < dashIfrEnd;      // enemies.js skips contact damage while true

/* -------- jump: a short hop that clears pits and low parkour blocks -------- */
const JUMP_T = 0.42, JUMP_H = 0.95;
let jumpEnd = -1e9;
export function tryJump(t){
  if(t < jumpEnd || t < rootUntil) return false;    // mid-air / rooted
  jumpEnd = t + JUMP_T;
  sfx.step();
  return true;
}
export const airborne = t => t < jumpEnd;

/* -------- crowd-control from hazards: root (frozen in place) and slow -------- */
let rootUntil = -1e9, slowUntil = -1e9;
export const applyRoot = until => {
  if(run.state.mods.cleanse) return;
  rootUntil = Math.max(rootUntil, until);
};
export const applySlow = until => {
  if(run.state.mods.cleanse) return;
  slowUntil = Math.max(slowUntil, until);
};

/* -------- game-side obstacle mask (parkour blocks): walkers are blocked,
   a jumping PLAYER passes. Registered per floor by parkour.js. -------- */
let obMask = null;
export const setObstacleMask = mask => { obMask = mask; };

/* -------- key state (held keys, not per-press) -------- */
const held = new Set();
const MOVE_KEYS = new Set(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight']);
addEventListener('keydown', e=>{
  if(!MOVE_KEYS.has(e.code)) return;
  const tag = e.target.tagName;                 // same guard as the HUD shortcuts:
  if(tag==='BUTTON') return;                    // never steal keys from the seed
  if(tag==='INPUT' && e.target.type!=='range' && e.target.type!=='checkbox') return;
  held.add(e.code);
  e.preventDefault();                           // arrows must not scroll the page
});
addEventListener('keyup', e=>held.delete(e.code));   // always release — no stuck keys
addEventListener('blur', ()=>held.clear());

/* -------- dash trail: a few fading afterimage discs dropped mid-dash -------- */
const TRAIL_N = 7, TRAIL_LIFE = 0.32;
let trail = [], trailIdx = 0, lastTrailAt = -1e9;
function dropTrail(p, t){
  if(t - lastTrailAt < 0.028) return;
  lastTrailAt = t;
  const s = trail[trailIdx % TRAIL_N]; trailIdx++;
  s.mesh.position.set(p.x, 0.5, p.z);
  s.at = t;
  s.mesh.visible = true;
}
function updateTrail(t){
  for(const s of trail){
    if(!s.mesh.visible) continue;
    const k = (t - s.at) / TRAIL_LIFE;
    if(k >= 1){ s.mesh.visible = false; continue; }
    s.mesh.material.opacity = 0.45 * (1 - k);
    s.mesh.scale.setScalar(1 - 0.5*k);
  }
}

export function createPlayer(scene){
  const tgeo = new THREE.CircleGeometry(0.26, 10);
  for(let i=0; i<TRAIL_N; i++){
    const m = new THREE.Mesh(tgeo, new THREE.MeshBasicMaterial({
      color:0x6fe8cd, transparent:true, opacity:0, toneMapped:false,
      blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide }));
    m.rotation.x = -Math.PI/2; m.position.y = 0.5; m.visible = false;
    scene.add(m);
    trail.push({ mesh:m, at:-1e9 });
  }

  const root = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.28, 0.5, 4, 12),
    new THREE.MeshStandardMaterial({ color:0x1c3a3f, roughness:0.35, metalness:0.1,
                                     emissive:0x3fd0bb, emissiveIntensity:0.55 })
  );
  body.position.y = 0.78;
  body.castShadow = true;
  root.add(body);

  const core = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.12),
    new THREE.MeshBasicMaterial({ color:0x9ffdea, toneMapped:false })
  );
  core.position.y = 1.32;
  root.add(core);

  const light = new THREE.PointLight(0x6fe8cd, 0.9 * 4*Math.PI, 9, 2);
  light.position.y = 1.5;
  root.add(light);

  /* Echo Step decoy — ghost twin left at dash origin */
  const decoyMesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.26, 0.45, 3, 8),
    new THREE.MeshBasicMaterial({ color:0x6fe8cd, transparent:true, opacity:0.45, toneMapped:false })
  );
  decoyMesh.visible = false;
  scene.add(decoyMesh);

  root.visible = false;
  scene.add(root);
  return { root, body, core, decoyMesh };
}

/* world → tile (inverse of wx = x - W/2 + 0.5: tile x covers [x-W/2, x+1-W/2)) */
const tileOk = (D, wxp, wzp, ignoreObstacles)=>{
  const tx = Math.floor(wxp + D.W/2), tz = Math.floor(wzp + D.H/2);
  if(tx<0 || tz<0 || tx>=D.W || tz>=D.H) return false;
  const c = tz*D.W + tx;
  if(D.grid[c] !== FLOOR) return false;
  return ignoreObstacles || !obMask || !obMask[c];
};
export const walkable = (D, wxp, wzp)=> tileOk(D, wxp, wzp, false);
export const canStand = (D, x, z, r=RADIUS, air=false)=>
  tileOk(D, x-r, z-r, air) && tileOk(D, x+r, z-r, air) &&
  tileOk(D, x-r, z+r, air) && tileOk(D, x+r, z+r, air);

export function spawnPlayer(player, D){
  const r = D.rooms[D.entrance];
  player.root.position.set(r.cx - D.W/2 + 0.5, 0, r.cy - D.H/2 + 0.5);
  player.root.position.y = 0;
  player.root.visible = true;
  velX = velZ = 0;                 // no carried momentum across floors/respawns
  jumpEnd = rootUntil = slowUntil = -1e9;
  obMask = null;                   // parkour re-registers per floor
}

export function updatePlayer(player, dt, D, yaw, t){
  const p = player.root.position;
  clearDecoy(t);
  if(player.decoyMesh){
    if(decoy && t < decoy.until){
      player.decoyMesh.visible = true;
      player.decoyMesh.position.set(decoy.x, 0.78, decoy.z);
      player.decoyMesh.material.opacity = 0.25 + 0.25 * ((decoy.until - t) / 1.5);
    } else player.decoyMesh.visible = false;
  }

  /* jump arc: a parabola over JUMP_T seconds (movement continues underneath) */
  const jk = 1 - (jumpEnd - t)/JUMP_T;
  /* landed on a parkour block? stand on top of it (and keep obstacle-passing
     movement so you can walk along or hop off — never wedged inside) */
  const ftx = Math.floor(p.x + D.W/2), ftz = Math.floor(p.z + D.H/2);
  const onBlock = obMask && ftx>=0 && ftz>=0 && ftx<D.W && ftz<D.H && obMask[ftz*D.W + ftx] === 1;
  const air = airborne(t) || onBlock;
  p.y = (jk >= 0 && jk <= 1) ? Math.max(onBlock ? 0.55 : 0, JUMP_H * Math.sin(Math.PI*jk))
                             : (onBlock ? 0.55 : 0);

  /* dash trail fade */
  updateTrail(t);

  /* dashing: locked velocity along the dash direction; a wall ends it early */
  if(t < dashEnd){
    const step = DASH_SPEED * dt;
    const nx = p.x + dashX*step;
    if(canStand(D, nx, p.z, RADIUS, air)) p.x = nx; else dashEnd = t;
    const nz = p.z + dashZ*step;
    if(canStand(D, p.x, nz, RADIUS, air)) p.z = nz; else dashEnd = t;
    player.body.rotation.y = Math.atan2(dashX, dashZ);
    dropTrail(p, t);
    return true;
  }

  if(t < rootUntil){ velX = velZ = 0; return false; }   // snared by a rune

  /* screen-relative input: W = up-screen = ground-projected view direction */
  const s = Math.sin(yaw), c = Math.cos(yaw);
  let mx = 0, mz = 0;
  if(held.has('KeyW') || held.has('ArrowUp'))    { mx -= s; mz -= c; }
  if(held.has('KeyS') || held.has('ArrowDown'))  { mx += s; mz += c; }
  if(held.has('KeyD') || held.has('ArrowRight')) { mx += c; mz -= s; }
  if(held.has('KeyA') || held.has('ArrowLeft'))  { mx -= c; mz += s; }

  const wpn = run.state.weaponKey;
  const wMove = (wpn === 'blade' ? 1.12 : 1); // blade duelist bonus
  const speed = SPEED * run.state.mods.moveMul * wMove * (t < slowUntil ? 0.5 : 1);
  const len = Math.hypot(mx, mz) || 1;
  const wantX = (mx/len)*speed, wantZ = (mz/len)*speed;

  /* frozen lakes are slippery: on lakeMask tiles velocity chases the input
     slowly, so you glide (and keep gliding after letting go). Solid ground
     snaps instantly — normal responsive movement everywhere else. */
  const tx = Math.floor(p.x + D.W/2), tz = Math.floor(p.z + D.H/2);
  const onIce = tx>=0 && tz>=0 && tx<D.W && tz<D.H && D.lakeMask[tz*D.W + tx] === 1;
  const blend = onIce ? 1 - Math.exp(-2.1*dt) : 1;
  velX += (wantX - velX)*blend;
  velZ += (wantZ - velZ)*blend;

  const sp = Math.hypot(velX, velZ);
  if(sp < 0.15){ velX = velZ = 0; return false; }

  /* axis-separated moves: rejecting one axis while the other passes = wall slide */
  const nx = p.x + velX*dt;
  if(canStand(D, nx, p.z, RADIUS, air)) p.x = nx; else velX = 0;
  const nz = p.z + velZ*dt;
  if(canStand(D, p.x, nz, RADIUS, air)) p.z = nz; else velZ = 0;

  player.body.rotation.y = Math.atan2(velX, velZ);
  return true;
}
