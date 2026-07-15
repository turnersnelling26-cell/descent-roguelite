/**
 * Junction maze rooms — combat rooms become parkour courses.
 *
 * Design goals:
 *   • Guaranteed: every floor gets at least one readable maze
 *   • Readable: gaps look like *removed floor blocks*, not damage pits
 *   • Fair: doorways and prize stay clear; walk path always exists
 *   • Skill: jump over 1-tile gaps; weave or hop onto low stone blocks
 *   • Soft fail only: landing in a gap snaps you back — never costs HP
 *
 * Styles (seeded per room, bias by theme when known):
 *   0 lanes   — bar walls with jump slots
 *   1 chasm   — gap river + stepping stones
 *   2 courts  — block courtyards + void corners
 *   3 spiral  — ring of blocks/gaps toward center prize
 */
import * as THREE from 'three';
import { FLOOR } from '../gen/dungeon.js';
import * as run from './state.js';
import { fogSeen, fogGate } from './fog.js';
import { setObstacleMask, setGapMask, airborne } from './player.js';
import { showToast } from './loot.js';
import { sfx } from './audio.js';
import { gI, gChance } from './rng.js';
import { noteParkour } from './save.js';

const CAP = 280, MAX_ROOMS = 3, GAP_CAP = 96;
/** Keep this many tiles free around every doorway so entry never soft-locks. */
const DOOR_CLEAR = 1;
/** Room ids that became mazes this floor (enemies spawn sparsely there). */
let mazeRoomIds = new Set();
let prizesTaken = 0;

let blocks = null, placed = [], rewards = [], rewardMeshes = [];
let gaps = [], gapMeshes = [];
let lastSafe = { x:0, z:0 }, gapFailCd = -1e9;

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(),
      _s = new THREE.Vector3(), _m = new THREE.Matrix4(), _c = new THREE.Color();

export function createParkour(scene){
  blocks = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.92, 0.58, 0.92),
    new THREE.MeshStandardMaterial({ color:0xffffff, roughness:0.78, metalness:0.12 }), CAP);
  blocks.count = 0;
  blocks.frustumCulled = false;
  blocks.castShadow = true;
  scene.add(blocks);

  for(let i = 0; i < GAP_CAP; i++){
    const g = new THREE.Group();
    /* recessed void: reads as a cube stolen from the floor grid */
    const pit = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.7, 0.9),
      new THREE.MeshBasicMaterial({ color:0x010204 })
    );
    pit.position.y = -0.32;
    const lip = new THREE.Mesh(
      new THREE.BoxGeometry(1.0, 0.07, 1.0),
      new THREE.MeshStandardMaterial({
        color:0x2e3548, roughness:0.9, metalness:0.05,
        emissive:0x0a0c14, emissiveIntensity:0.55,
      })
    );
    lip.position.y = 0.02;
    /* faint inner edge so fog-lit rooms still show the hole */
    const edge = new THREE.Mesh(
      new THREE.BoxGeometry(0.94, 0.03, 0.94),
      new THREE.MeshBasicMaterial({ color:0x1a2030, transparent:true, opacity:0.85 })
    );
    edge.position.y = -0.02;
    g.add(pit, lip, edge);
    g.visible = false;
    scene.add(g);
    gapMeshes.push(g);
  }

  const geo = new THREE.BoxGeometry(0.34, 0.34, 0.34);
  for(let i = 0; i < MAX_ROOMS; i++){
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color:0x9ffdea, toneMapped:false, transparent:true, opacity:0.95 }));
    m.visible = false;
    scene.add(m);
    rewardMeshes.push(m);
  }
}

function roomBounds(r){
  return {
    x0: Math.ceil(r.cx - r.w / 2) + 1,
    x1: Math.floor(r.cx + r.w / 2) - 1,
    z0: Math.ceil(r.cy - r.h / 2) + 1,
    z1: Math.floor(r.cy + r.h / 2) - 1,
  };
}

function cellOk(D, x, z, r){
  if(x < 1 || z < 1 || x >= D.W - 1 || z >= D.H - 1) return false;
  const c = z * D.W + x;
  return D.grid[c] === FLOOR && D.roomId[c] === r.id && !D.lakeMask[c];
}

/** Doorway tiles + neighborhood — always keep walkable. */
function markDoorClear(D, r, keep){
  const { x0, x1, z0, z1 } = roomBounds(r);
  for(let z = z0 - 1; z <= z1 + 1; z++){
    for(let x = x0 - 1; x <= x1 + 1; x++){
      if(!cellOk(D, x, z, r) && !(D.doorway[z * D.W + x] && D.roomId[z * D.W + x] === r.id))
        continue;
      const c = z * D.W + x;
      if(D.doorway[c] || D.roomId[c] !== r.id){
        /* expand clear radius around doorways */
        for(let dz = -DOOR_CLEAR; dz <= DOOR_CLEAR; dz++){
          for(let dx = -DOOR_CLEAR; dx <= DOOR_CLEAR; dx++){
            if(Math.abs(dx) + Math.abs(dz) > DOOR_CLEAR + 1) continue;
            const nx = x + dx, nz = z + dz;
            if(cellOk(D, nx, nz, r) || (D.doorway[nz * D.W + nx]))
              keep[nz * D.W + nx] = 1;
          }
        }
      }
    }
  }
}

function clearRect(mask, gapMask, x0, x1, z0, z1, W){
  for(let z = z0; z <= z1; z++) for(let x = x0; x <= x1; x++){
    const c = z * W + x;
    if(c >= 0 && c < mask.length){ mask[c] = 0; gapMask[c] = 0; }
  }
}

/**
 * Guaranteed walk-or-jump path from every doorway seed to prize.
 * Clears masks along a thick corridor (width 1 = walkable, can include jumps only as optional).
 * We clear ALL obstacles on the path so walking alone reaches the prize (skill is optional speed).
 */
function carveSafeRoutes(D, r, mask, gapMask, prizeX, prizeZ){
  const W = D.W;
  const doors = [];
  const { x0, x1, z0, z1 } = roomBounds(r);
  for(let z = z0 - 1; z <= z1 + 1; z++){
    for(let x = x0 - 1; x <= x1 + 1; x++){
      if(x < 0 || z < 0 || x >= W || z >= D.H) continue;
      const c = z * W + x;
      if(D.doorway[c] && D.roomId[c] === r.id) doors.push({ x, z });
      /* also door tiles just outside that touch the room */
      if(D.doorway[c]){
        for(const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]){
          const nx = x + dx, nz = z + dz, nc = nz * W + nx;
          if(nx >= 0 && nz >= 0 && nx < W && nz < D.H && D.roomId[nc] === r.id)
            doors.push({ x: nx, z: nz });
        }
      }
    }
  }
  if(!doors.length) doors.push({ x: x0, z: Math.round(r.cy) });

  for(const d of doors){
    let x = d.x, z = d.z;
    for(let step = 0; step < 100; step++){
      const c = z * W + x;
      mask[c] = 0; gapMask[c] = 0;
      /* 3-wide clear for comfort */
      for(const [dx, dz] of [[0,0],[1,0],[-1,0],[0,1],[0,-1]]){
        const nc = (z + dz) * W + (x + dx);
        if(nc >= 0 && nc < mask.length && cellOk(D, x + dx, z + dz, r)){
          mask[nc] = 0; gapMask[nc] = 0;
        }
      }
      if(x === prizeX && z === prizeZ) break;
      if(Math.abs(prizeX - x) >= Math.abs(prizeZ - z))
        x += Math.sign(prizeX - x) || 0;
      else
        z += Math.sign(prizeZ - z) || 0;
      if(x < x0) x = x0; if(x > x1) x = x1;
      if(z < z0) z = z0; if(z > z1) z = z1;
    }
  }
  /* prize dais */
  clearRect(mask, gapMask, prizeX - 1, prizeX + 1, prizeZ - 1, prizeZ + 1, W);
}

function layoutLanes(D, r, mask, gapMask, keep){
  const { x0, x1, z0, z1 } = roomBounds(r);
  const spacing = 2; // tight bars so the maze is unmistakable
  for(let z = z0 + 1; z <= z1 - 1; z += spacing){
    const gapSlot = x0 + 1 + gI(0, Math.max(0, x1 - x0 - 2));
    const gapSlot2 = x0 + 1 + gI(0, Math.max(0, x1 - x0 - 2));
    for(let x = x0 + 1; x <= x1 - 1; x++){
      if(!cellOk(D, x, z, r) || keep[z * D.W + x]) continue;
      if(x === gapSlot || x === gapSlot2){
        gapMask[z * D.W + x] = 1;
      } else {
        mask[z * D.W + x] = 1;
      }
    }
  }
  /* cross-axis walls for a real grid maze feel */
  for(let x = x0 + 2; x <= x1 - 2; x += 2 + gI(0, 1)){
    for(let z = z0 + 1; z <= z1 - 1; z++){
      if(!cellOk(D, x, z, r) || keep[z * D.W + x]) continue;
      if(mask[z * D.W + x] || gapMask[z * D.W + x]) continue;
      if((z - z0) % 4 === 2) gapMask[z * D.W + x] = 1;
      else if(gChance(0.55)) mask[z * D.W + x] = 1;
    }
  }
}

function layoutChasm(D, r, mask, gapMask, keep){
  const { x0, x1, z0, z1 } = roomBounds(r);
  const horiz = gChance(0.5);
  if(horiz){
    /* band of gaps across the room mid */
    const band = Math.round((z0 + z1) / 2);
    for(let x = x0 + 1; x <= x1 - 1; x++){
      if(!cellOk(D, x, band, r) || keep[band * D.W + x]) continue;
      gapMask[band * D.W + x] = 1;
    }
    /* stepping stones: clear every 2–3 tiles so jump-hop works */
    for(let x = x0 + 2; x <= x1 - 2; x += 2 + gI(0, 1)){
      gapMask[band * D.W + x] = 0;
    }
    /* low blocks flanking the chasm as cover */
    for(const zz of [band - 2, band + 2]){
      if(zz <= z0 || zz >= z1) continue;
      for(let x = x0 + 1; x <= x1 - 1; x += 2){
        if(!cellOk(D, x, zz, r) || keep[zz * D.W + x]) continue;
        if(gChance(0.55)) mask[zz * D.W + x] = 1;
      }
    }
  } else {
    const band = Math.round((x0 + x1) / 2);
    for(let z = z0 + 1; z <= z1 - 1; z++){
      if(!cellOk(D, band, z, r) || keep[z * D.W + band]) continue;
      gapMask[z * D.W + band] = 1;
    }
    for(let z = z0 + 2; z <= z1 - 2; z += 2 + gI(0, 1)){
      gapMask[z * D.W + band] = 0;
    }
    for(const xx of [band - 2, band + 2]){
      if(xx <= x0 || xx >= x1) continue;
      for(let z = z0 + 1; z <= z1 - 1; z += 2){
        if(!cellOk(D, xx, z, r) || keep[z * D.W + xx]) continue;
        if(gChance(0.55)) mask[z * D.W + xx] = 1;
      }
    }
  }
}

function layoutCourts(D, r, mask, gapMask, keep){
  const { x0, x1, z0, z1 } = roomBounds(r);
  /* denser pillar grid — clearly a maze, not empty combat */
  for(let z = z0 + 1; z <= z1 - 1; z += 2){
    for(let x = x0 + 1; x <= x1 - 1; x += 2){
      if(!cellOk(D, x, z, r) || keep[z * D.W + x]) continue;
      mask[z * D.W + x] = 1;
      if(gChance(0.55) && cellOk(D, x + 1, z, r) && !keep[z * D.W + x + 1])
        mask[z * D.W + x + 1] = 1;
    }
  }
  const corners = [
    [x0 + 2, z0 + 2], [x1 - 2, z0 + 2], [x0 + 2, z1 - 2], [x1 - 2, z1 - 2],
    [Math.round(r.cx) - 2, Math.round(r.cy)], [Math.round(r.cx) + 2, Math.round(r.cy)],
  ];
  for(const [x, z] of corners){
    if(cellOk(D, x, z, r) && !keep[z * D.W + x] && gChance(0.85)){
      mask[z * D.W + x] = 0;
      gapMask[z * D.W + x] = 1;
    }
  }
  for(let n = 0; n < 8; n++){
    const x = x0 + 1 + gI(0, Math.max(0, x1 - x0 - 2));
    const z = z0 + 1 + gI(0, Math.max(0, z1 - z0 - 2));
    if(cellOk(D, x, z, r) && !keep[z * D.W + x] && !mask[z * D.W + x])
      gapMask[z * D.W + x] = 1;
  }
}

function layoutSpiral(D, r, mask, gapMask, keep){
  const { x0, x1, z0, z1 } = roomBounds(r);
  const cx = Math.round(r.cx), cz = Math.round(r.cy);
  for(let z = z0 + 1; z <= z1 - 1; z++){
    for(let x = x0 + 1; x <= x1 - 1; x++){
      if(!cellOk(D, x, z, r) || keep[z * D.W + x]) continue;
      const manh = Math.abs(x - cx) + Math.abs(z - cz);
      if(manh < 2) continue;
      if(manh % 3 === 0) gapMask[z * D.W + x] = 1;
      else if(manh % 3 === 1 && ((x + z) % 2 === 0)) mask[z * D.W + x] = 1;
    }
  }
}

function themeStyleBias(theme){
  /* preferred styles per theme for identity */
  if(theme === 'molten') return [1, 0, 2, 3];   // chasm first
  if(theme === 'frost') return [1, 3, 0, 2];
  if(theme === 'verdant') return [2, 0, 3, 1];
  if(theme === 'grim') return [3, 2, 1, 0];
  if(theme === 'ancient') return [0, 3, 2, 1]; // lanes
  return [0, 1, 2, 3];
}

function layoutMaze(D, r, mask, gapMask){
  const keep = new Uint8Array(D.W * D.H);
  markDoorClear(D, r, keep);
  const prizeX = Math.round(r.cx), prizeZ = Math.round(r.cy);
  for(let dz = -1; dz <= 1; dz++) for(let dx = -1; dx <= 1; dx++){
    const c = (prizeZ + dz) * D.W + (prizeX + dx);
    if(c >= 0 && c < keep.length) keep[c] = 1;
  }

  const order = themeStyleBias(run.state.floorTheme || D.params?.themeKey);
  const style = order[gI(0, order.length - 1)];
  if(style === 0) layoutLanes(D, r, mask, gapMask, keep);
  else if(style === 1) layoutChasm(D, r, mask, gapMask, keep);
  else if(style === 2) layoutCourts(D, r, mask, gapMask, keep);
  else layoutSpiral(D, r, mask, gapMask, keep);

  for(let i = 0; i < keep.length; i++){
    if(keep[i]){ mask[i] = 0; gapMask[i] = 0; }
  }
  for(let i = 0; i < mask.length; i++){
    if(mask[i] && gapMask[i]) gapMask[i] = 0;
  }

  carveSafeRoutes(D, r, mask, gapMask, prizeX, prizeZ);
}

function pickMazeRooms(D){
  const ban = new Set([D.rooms[D.entrance]?.id, D.rooms[D.boss]?.id]);
  const pool = D.rooms
    .filter(r =>
      (r.type === 'combat' || r.type === 'elite') &&
      !ban.has(r.id) && !r.lake && !r.grave &&
      r.w >= 7 && r.h >= 7
    )
    .sort((a, b) =>
      ((b.degree || 0) - (a.degree || 0)) ||
      (b.w * b.h - a.w * a.h)
    );

  const picked = pool.slice(0, MAX_ROOMS);
  /* guarantee at least one maze every floor */
  if(!picked.length){
    const fallback = D.rooms
      .filter(r => !ban.has(r.id) && r.type !== 'entrance' && r.type !== 'boss' && r.w >= 6 && r.h >= 6)
      .sort((a, b) => (b.w * b.h) - (a.w * a.h));
    if(fallback[0]) picked.push(fallback[0]);
  }
  return picked;
}

export function mazeRooms(){ return mazeRoomIds; }
export function isMazeRoom(id){ return mazeRoomIds.has(id); }

export function spawnParkour(D){
  placed = []; rewards = []; gaps = [];
  prizesTaken = 0;
  mazeRoomIds = new Set();
  rewardMeshes.forEach(m=>{ m.visible = false; m.scale.setScalar(1); });
  gapMeshes.forEach(m=>{ m.visible = false; });
  const mask = new Uint8Array(D.W * D.H);
  const gapMask = new Uint8Array(D.W * D.H);

  const rooms = pickMazeRooms(D);
  for(const r of rooms){
    mazeRoomIds.add(r.id);
    const localMask = new Uint8Array(D.W * D.H);
    const localGap = new Uint8Array(D.W * D.H);
    layoutMaze(D, r, localMask, localGap);
    for(let i = 0; i < localMask.length; i++){
      if(localMask[i]) mask[i] = 1;
      if(localGap[i]) gapMask[i] = 1;
    }
    if(rewards.length < rewardMeshes.length){
      const ri = Math.round(r.cy) * D.W + Math.round(r.cx);
      rewards.push({
        x: r.cx - D.W / 2 + 0.5,
        z: r.cy - D.H / 2 + 0.5,
        ti: ri,
        taken: false,
        mesh: rewardMeshes[rewards.length],
      });
    }
  }

  placed = []; gaps = [];
  for(let i = 0; i < mask.length; i++){
    if(mask[i] && placed.length < CAP){
      const x = i % D.W, z = Math.floor(i / D.W);
      placed.push({ x: x - D.W / 2 + 0.5, z: z - D.H / 2 + 0.5, ti: i });
    } else if(gapMask[i] && !mask[i] && gaps.length < GAP_CAP){
      const x = i % D.W, z = Math.floor(i / D.W);
      gaps.push({ x: x - D.W / 2 + 0.5, z: z - D.H / 2 + 0.5, ti: i });
    }
  }

  blocks.count = placed.length;
  const theme = run.state.floorTheme || D.params?.themeKey;
  const tonesByTheme = {
    ancient: [0x5a5368, 0x6a6080, 0x4a4560, 0x706888],
    molten:  [0x6a4030, 0x8a4a28, 0x5a3020, 0x7a4530],
    frost:   [0x4a6078, 0x5a7090, 0x3a5068, 0x6a80a0],
    grim:    [0x3a3048, 0x4a3858, 0x2a2038, 0x503e60],
    verdant: [0x3a5840, 0x4a6850, 0x2a4830, 0x507858],
  };
  const tones = tonesByTheme[theme] || [0x4a5368, 0x555e74, 0x3f475c, 0x5a6478];
  placed.forEach((b, i) => blocks.setColorAt(i, _c.set(tones[i % tones.length])));
  if(blocks.instanceColor) blocks.instanceColor.needsUpdate = true;

  gaps.forEach((g, i) => {
    if(gapMeshes[i]) gapMeshes[i].position.set(g.x, 0, g.z);
  });

  setObstacleMask(placed.length ? mask : null);
  setGapMask(gaps.length ? gapMask : null);
  lastSafe = { x: 0, z: 0 };
  gapFailCd = -1e9;
}

export function updateParkour(dt, D, player, t){
  const pp = player.root.position;

  for(let i = 0; i < placed.length; i++){
    const b = placed[i];
    const g = fogSeen(b.ti) ? fogGate(b.ti, t) : 0;
    _p.set(b.x, 0.29, b.z); _q.identity(); _s.setScalar(Math.max(g, 0.0001));
    _m.compose(_p, _q, _s); blocks.setMatrixAt(i, _m);
  }
  if(placed.length) blocks.instanceMatrix.needsUpdate = true;

  for(let i = 0; i < gaps.length; i++){
    const gp = gaps[i], m = gapMeshes[i];
    if(!m) continue;
    const vis = fogSeen(gp.ti) ? fogGate(gp.ti, t) : 0;
    m.visible = vis > 0.04;
    if(m.visible) m.scale.setScalar(Math.max(vis, 0.001));
  }

  if(!airborne(t)){
    const tx = Math.floor(pp.x + D.W / 2), tz = Math.floor(pp.z + D.H / 2);
    const c = tz * D.W + tx;
    const onGap = gaps.some(g => g.ti === c);
    if(!onGap) lastSafe = { x: pp.x, z: pp.z };
    else if(t - gapFailCd > 0.4){
      gapFailCd = t;
      pp.x = lastSafe.x; pp.z = lastSafe.z;
      sfx.gapReset?.() || sfx.step();
    }
  }

  for(const rw of rewards){
    const m = rw.mesh;
    if(rw.taken){ m.visible = false; continue; }
    const g = fogSeen(rw.ti) ? fogGate(rw.ti, t) : 0;
    m.visible = g > 0.01;
    if(!m.visible) continue;
    m.position.set(rw.x, 1.08 + 0.14 * Math.sin(t * 2.4), rw.z);
    m.rotation.y = t * 1.5;
    m.rotation.x = t * 0.6;
    m.scale.setScalar(g * (0.92 + 0.1 * Math.sin(t * 5)));
    if(g >= 0.99 && Math.hypot(pp.x - rw.x, pp.z - rw.z) < 0.85){
      rw.taken = true;
      const gold = 30 + run.state.floor * 6;
      run.state.gold += gold;
      run.renderHud();
      noteParkour();
      prizesTaken++;
      showToast('Maze prize — +' + gold + ' gold!');
      sfx.win();
    }
  }
}

export const parkourStats = () => ({
  rooms: rewards.length,
  blocks: placed.length,
  gaps: gaps.length,
  mazeIds: [...mazeRoomIds],
  prizesTaken,
  rewardsLeft: rewards.filter(r => !r.taken).length,
  rewards: rewards.filter(r => !r.taken).map(r => ({ x: +r.x.toFixed(2), z: +r.z.toFixed(2) })),
  pitPositions: gaps.slice(0, 10).map(g => ({ x: +g.x.toFixed(2), z: +g.z.toFixed(2) })),
});
