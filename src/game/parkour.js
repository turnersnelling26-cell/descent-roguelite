/**
 * Parkour rooms — junction rooms (3+ corridor connections) refitted with rows
 * of low stone blocks and a glittering prize. Blocks are real collision for
 * anything walking (player and enemies alike) but a JUMP (C) clears them — or
 * lands you on top, where you can walk the beam like a rogue.
 *
 * The obstacle mask is registered into player.js so its collision fold sees
 * it; visuals are one InstancedMesh, fog-gated per frame.
 */
import * as THREE from 'three';
import { FLOOR } from '../gen/dungeon.js';
import * as run from './state.js';
import { fogSeen, fogGate } from './fog.js';
import { setObstacleMask } from './player.js';
import { showToast } from './loot.js';
import { sfx } from './audio.js';

const CAP = 90, MAX_ROOMS = 2;

let blocks = null, placed = [], rewards = [], rewardMeshes = [];

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(),
      _s = new THREE.Vector3(), _m = new THREE.Matrix4(), _c = new THREE.Color();

export function createParkour(scene){
  blocks = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.92, 0.55, 0.92),
    new THREE.MeshStandardMaterial({ color:0xffffff, roughness:0.8, metalness:0.1 }), CAP);
  blocks.count = 0;
  blocks.frustumCulled = false;
  blocks.castShadow = true;
  scene.add(blocks);

  const geo = new THREE.OctahedronGeometry(0.24);
  for(let i=0; i<MAX_ROOMS; i++){
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color:0x9ffdea, toneMapped:false, transparent:true, opacity:0.95 }));
    m.visible = false;
    scene.add(m);
    rewardMeshes.push(m);
  }
}

export function spawnParkour(D){
  placed = []; rewards = [];
  rewardMeshes.forEach(m=>{ m.visible = false; m.scale.setScalar(1); });
  const mask = new Uint8Array(D.W * D.H);

  /* junction rooms: well-connected combat rooms, roomy enough for bar rows */
  const rooms = D.rooms.filter(r=>
    r.type === 'combat' && (r.degree ?? 0) >= 3 && r.w >= 9 && r.h >= 9 &&
    !r.lake && !r.grave).slice(0, MAX_ROOMS);

  for(const r of rooms){
    const x0 = Math.ceil(r.cx - r.w/2) + 1, x1 = Math.floor(r.cx + r.w/2) - 1;
    const z0 = Math.ceil(r.cy - r.h/2) + 1, z1 = Math.floor(r.cy + r.h/2) - 1;
    /* bar rows every 3rd row, each with a single random gap — jump or weave */
    for(let z = z0 + 1; z <= z1 - 1; z += 3){
      const gap = x0 + 1 + Math.floor(Math.random() * Math.max(1, x1 - x0 - 1));
      for(let x = x0; x <= x1; x++){
        if(x === gap || placed.length >= CAP) continue;
        const c = z*D.W + x;
        if(D.grid[c] !== FLOOR || D.roomId[c] !== r.id || D.doorway[c] || D.lakeMask[c]) continue;
        mask[c] = 1;
        placed.push({ x: x - D.W/2 + 0.5, z: z - D.H/2 + 0.5, ti: c });
      }
    }
    /* the prize at the room's heart */
    const ri = Math.round(r.cy)*D.W + Math.round(r.cx);
    rewards.push({ x: r.cx - D.W/2 + 0.5, z: r.cy - D.H/2 + 0.5, ti: ri,
                   taken:false, mesh: rewardMeshes[rewards.length] });
  }

  blocks.count = placed.length;
  placed.forEach((b,i)=>blocks.setColorAt(i, _c.set(0x565e74)));
  if(blocks.instanceColor) blocks.instanceColor.needsUpdate = true;
  setObstacleMask(placed.length ? mask : null);
}

export function updateParkour(dt, D, player, t){
  const pp = player.root.position;
  for(let i=0; i<placed.length; i++){
    const b = placed[i];
    const g = fogSeen(b.ti) ? fogGate(b.ti, t) : 0;
    _p.set(b.x, 0.275, b.z); _q.identity(); _s.setScalar(Math.max(g, 0.0001));
    _m.compose(_p,_q,_s); blocks.setMatrixAt(i,_m);
  }
  if(placed.length) blocks.instanceMatrix.needsUpdate = true;

  for(const rw of rewards){
    const m = rw.mesh;
    if(rw.taken){ m.visible = false; continue; }
    const g = fogSeen(rw.ti) ? fogGate(rw.ti, t) : 0;
    m.visible = g > 0.01;
    if(!m.visible) continue;
    m.position.set(rw.x, 1.0 + 0.12*Math.sin(t*2.2), rw.z);
    m.rotation.y = t*1.6;
    m.scale.setScalar(g);
    if(g >= 0.99 && Math.hypot(pp.x - rw.x, pp.z - rw.z) < 0.8){
      rw.taken = true;
      const gold = 25 + run.state.floor * 5;
      run.state.gold += gold;
      run.renderHud();
      showToast('Vaulter’s prize — +' + gold + ' gold!');
      sfx.win();
    }
  }
}

export const parkourStats = ()=>({
  rooms: rewards.length, blocks: placed.length,
  rewards: rewards.filter(r=>!r.taken).map(r=>({x:+r.x.toFixed(2), z:+r.z.toFixed(2)})),
});
