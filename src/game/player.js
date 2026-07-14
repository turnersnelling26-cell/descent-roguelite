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
export function tryDash(player, t){
  if(t < dashCdEnd || t < dashEnd) return false;   // on cooldown / already dashing
  if(!run.spendMana(DASH_COST)) return false;       // no mana → no dash
  const rot = player.body.rotation.y;               // dash along current facing
  dashX = Math.sin(rot); dashZ = Math.cos(rot);
  dashEnd = t + DASH_TIME;
  dashCdEnd = t + DASH_CD * run.state.mods.dashCdMul;
  dashIfrEnd = t + DASH_IFRAME + run.state.mods.iframeBonus;
  sfx.swing();
  return true;
}
export const dashInvuln = t => t < dashIfrEnd;      // enemies.js skips contact damage while true

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

export function createPlayer(scene){
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

  root.visible = false;
  scene.add(root);
  return { root, body, core };
}

/* world → tile (inverse of wx = x - W/2 + 0.5: tile x covers [x-W/2, x+1-W/2)) */
export const walkable = (D, wxp, wzp)=>{
  const tx = Math.floor(wxp + D.W/2), tz = Math.floor(wzp + D.H/2);
  return tx>=0 && tz>=0 && tx<D.W && tz<D.H && D.grid[tz*D.W + tx] === FLOOR;
};
export const canStand = (D, x, z, r=RADIUS)=>
  walkable(D, x-r, z-r) && walkable(D, x+r, z-r) &&
  walkable(D, x-r, z+r) && walkable(D, x+r, z+r);

export function spawnPlayer(player, D){
  const r = D.rooms[D.entrance];
  player.root.position.set(r.cx - D.W/2 + 0.5, 0, r.cy - D.H/2 + 0.5);
  player.root.visible = true;
}

export function updatePlayer(player, dt, D, yaw, t){
  const p = player.root.position;

  /* dashing: locked velocity along the dash direction; a wall ends it early */
  if(t < dashEnd){
    const step = DASH_SPEED * dt;
    const nx = p.x + dashX*step;
    if(canStand(D, nx, p.z)) p.x = nx; else dashEnd = t;
    const nz = p.z + dashZ*step;
    if(canStand(D, p.x, nz)) p.z = nz; else dashEnd = t;
    player.body.rotation.y = Math.atan2(dashX, dashZ);
    return true;
  }

  /* screen-relative input: W = up-screen = ground-projected view direction */
  const s = Math.sin(yaw), c = Math.cos(yaw);
  let mx = 0, mz = 0;
  if(held.has('KeyW') || held.has('ArrowUp'))    { mx -= s; mz -= c; }
  if(held.has('KeyS') || held.has('ArrowDown'))  { mx += s; mz += c; }
  if(held.has('KeyD') || held.has('ArrowRight')) { mx += c; mz -= s; }
  if(held.has('KeyA') || held.has('ArrowLeft'))  { mx -= c; mz += s; }
  if(mx === 0 && mz === 0) return false;

  const len = Math.hypot(mx, mz), step = SPEED * run.state.mods.moveMul * dt;
  /* axis-separated moves: rejecting one axis while the other passes = wall slide */
  const nx = p.x + (mx/len)*step;
  if(canStand(D, nx, p.z)) p.x = nx;
  const nz = p.z + (mz/len)*step;
  if(canStand(D, p.x, nz)) p.z = nz;

  player.body.rotation.y = Math.atan2(mx, mz);
  return true;
}
