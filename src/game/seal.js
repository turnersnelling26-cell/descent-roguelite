/**
 * Boss ward — the answer to b-lining the floor. Every entrance tile of the
 * boss lair is sealed by a rune barrier (a real collision wall: the tiles are
 * temporarily written to WALL in the grid, so nothing walks through) until the
 * player has slain enough foes on this floor. Then the ward shatters, the
 * tiles revert to FLOOR, and the lair opens.
 *
 * Barrier meshes live on the scene (pooled, survive reforge).
 */
import * as THREE from 'three';
import { FLOOR, WALL } from '../gen/dungeon.js';
import * as run from './state.js';
import { fogSeen } from './fog.js';
import { showToast } from './loot.js';
import { sfx } from './audio.js';

const POOL = 14;
const QUOTA_FRAC = 0.5;      // slay half the floor's outside foes to break the ward

let walls = [];              // pooled barrier meshes
let cells = [];              // sealed tile indices in D.grid
let sealed = false, need = 0, killsBase = 0;

export function createSeal(scene){
  const geo = new THREE.BoxGeometry(0.98, 2.1, 0.98);
  for(let i=0; i<POOL; i++){
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color:0xff5040, transparent:true, opacity:0.32, toneMapped:false,
      blending:THREE.AdditiveBlending, depthWrite:false }));
    m.visible = false;
    scene.add(m);
    walls.push(m);
  }
}

/* entry tiles = FLOOR tiles outside the boss room that touch a boss-room tile */
export function spawnSeal(D, outsideEnemies){
  cells = []; sealed = false; need = 0;
  walls.forEach(m=>m.visible = false);
  const bossId = D.rooms[D.boss].id, W = D.W, H = D.H;
  const found = [];
  for(let z=0; z<H; z++) for(let x=0; x<W; x++){
    const c = z*W + x;
    if(D.grid[c] !== FLOOR || D.roomId[c] === bossId) continue;
    const touches =
      (x<W-1 && D.roomId[c+1] === bossId && D.grid[c+1] === FLOOR) ||
      (x>0   && D.roomId[c-1] === bossId && D.grid[c-1] === FLOOR) ||
      (z<H-1 && D.roomId[c+W] === bossId && D.grid[c+W] === FLOOR) ||
      (z>0   && D.roomId[c-W] === bossId && D.grid[c-W] === FLOOR);
    if(touches) found.push(c);
  }
  need = Math.min(Math.ceil(outsideEnemies * QUOTA_FRAC), Math.max(0, outsideEnemies));
  if(!found.length || need <= 0) return;          // nothing to seal / trivial floor
  sealed = true;
  killsBase = run.state.kills;
  cells = found.slice(0, POOL);
  cells.forEach((c, i)=>{
    D.grid[c] = WALL;                              // real collision
    const m = walls[i];
    m.position.set((c % W) - W/2 + 0.5, 1.05, Math.floor(c / W) - H/2 + 0.5);
    m.userData.ti = c;
    m.visible = false;                             // fog decides per-frame
  });
}

export function updateSeal(dt, D, t){
  if(!sealed) return;
  if(run.state.kills - killsBase >= need){         // the ward shatters
    sealed = false;
    for(const c of cells) D.grid[c] = FLOOR;
    walls.forEach(m=>m.visible = false);
    showToast('The ward shatters — the lair lies open.');
    sfx.boom();
    return;
  }
  const pulse = 0.24 + 0.14*Math.sin(t*3.1);
  for(let i=0; i<cells.length; i++){
    const m = walls[i];
    m.visible = fogSeen(m.userData.ti);
    m.material.opacity = pulse;
    m.scale.y = 1 + 0.05*Math.sin(t*2.2 + i);
  }
}

export const sealStats = ()=>({ sealed, need, have: Math.min(need, run.state.kills - killsBase) });
