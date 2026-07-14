/**
 * DESCENT — dungeon generation core.
 *
 * Pure, engine-agnostic procedural pipeline (scatter → separate → Delaunay →
 * MST+loops → semantics → carve → rasterize+BFS → decorate): no Three.js,
 * no DOM. Runs in the browser or plain Node.
 *
 * Deterministic: a single mulberry32 stream (seeded once) is threaded
 * through every stage in call order, so any seed rebuilds the exact same
 * dungeon. Do not reorder rng consumption when editing.
 *
 * Lineage: pipeline and presentation ideas trace to Dungeon Forge
 * (Majid Manzarpour, MIT); this module lives inside Descent as its own
 * game project's generator.
 *
 * Entry point: `generateDungeon(params)` with
 *   params = {
 *     seed:         integer — the one source of entropy,
 *     roomCount:    rooms to scatter (demo range 12–80),
 *     loopChance:   0..1 — fraction of leftover Delaunay edges re-added as loops,
 *     decorDensity: 0..1 — prop/torch dressing density,
 *     themeKey:     'ancient'|'molten'|'frost'|'grim'|'verdant'
 *                   (use `themeFromSeed(seed)` for the AUTO behaviour),
 *   }
 *
 * Returns a plain data object:
 *   valid          — true when every floor tile is reachable from the entrance
 *   name           — generated dungeon name (theme word pools)
 *   W, H           — tile-grid dimensions; index flat arrays as [y*W + x]
 *   grid           — Uint8Array of VOID | FLOOR | WALL | POOL
 *   roomId         — Int16Array, room index per tile (−1 = none)
 *   corridor, doorway, lakeMask — Uint8Array flags per tile
 *   bfs, maxBfs    — Int16Array distance-from-entrance field (−1 unreached)
 *   rooms          — [{id, cx, cy, w, h, arch, shape, type (TYPE.*), depth,
 *                      difficulty 0..1, degree, ...}] in grid coordinates
 *   edges          — [{a, b, isLoop, isCritical}] indices into rooms
 *   entrance, boss — room indices; maxDepth — BFS depth of deepest room
 *   props, spawns, torches — placement data (positions/kinds/tiers), no meshes
 *   pools, lakeCells, arches — liquid + arch placements
 *   stats          — {rooms, edges, loops, critLen, floorTiles, reach, genMs, attempts}
 */

/* ---------------- RNG ---------------- */
function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeRng(seed){
  const r = mulberry32(seed);
  return {
    f:(a,b)=> a + r()*(b-a),
    i:(a,b)=> a + Math.floor(r()*(b-a+1)),
    pick:(arr)=> arr[Math.floor(r()*arr.length)],
    chance:(p)=> r() < p,
    raw:r,
    gauss(mu,sig){ let u=0,v=0; while(u===0)u=r(); while(v===0)v=r();
      return mu + sig*Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); }
  };
}

/* ---------------- constants ---------------- */
const VOID=0, FLOOR=1, WALL=2, POOL=3;
const TYPE = { ENTRANCE:'entrance', COMBAT:'combat', ELITE:'elite', TREASURE:'treasure', SHRINE:'shrine', BOSS:'boss' };

/* ---------------- theme specs ----------------
   Each theme is one data object: palette, lighting rig, liquid shader
   params, particle system, prop-kit flags consumed by the generator,
   and name-generator word pools. Everything downstream is data-driven. */
const THEMES = {
  ancient: {
    label:'ANCIENT', accent:'#e8973f',
    bg:0x07080d, fog:0x07080d, fogD:0.0021,
    hemi:[0x2e3a52, 0x0a0b10, 0.55], dir:[0xffe8c8, 0.85],
    floor:0x8a8f9c, corridor:0x6d7380, wall:0x5c626e, cap:0x757b88,
    pillar:0x6a707e, debris:[0x4c515e, 0x60584a],
    flame:0xffa640, flameCore:0xfff3c8, torchLight:[0xff8c3a, 1.5, 9.5],
    cloth:0x7d2c26,
    pools:null, particles:{kind:0, color:0xaab4cc, n:110},
    nameA:['Sunken','Forgotten','Silent','Hollow','Elder','Broken','Nameless','Fallen'],
    nameB:['Halls','Vaults','Catacombs','Depths','Sanctum','Undercroft','Barrows','Reliquary']
  },
  molten: {
    label:'MOLTEN', accent:'#ff8642',
    bg:0x0c0605, fog:0x1a0b04, fogD:0.0028,
    hemi:[0x6b3419, 0x160503, 0.55], dir:[0xffd9b0, 0.5],
    floor:0x7a685c, corridor:0x614f44, wall:0x503e34, cap:0x6b5546,
    pillar:0x5e4a3e, debris:[0x4a382e, 0x60462f],
    flame:0xff8c26, flameCore:0xffe9b0, torchLight:[0xff7326, 1.7, 10],
    cloth:0x7d2416,
    pools:{mode:0, colA:0x2b0d05, colB:0xff5a1f, glow:1.55, amount:0.16, pits:2},
    particles:{kind:1, color:0xffa050, n:240},
    nameA:['Molten','Ashen','Cindered','Smouldering','Charred','Burning','Ember','Scorched'],
    nameB:['Forges','Furnaces','Calderas','Foundry','Kilns','Vents','Crucible','Depths']
  },
  frost: {
    label:'FROST', accent:'#7fd4ff',
    bg:0x060a12, fog:0x0b1522, fogD:0.0024,
    hemi:[0x3a5a80, 0x0a0e18, 0.5], dir:[0xcfe4ff, 0.82],
    floor:0x93a0b2, corridor:0x78848f, wall:0x60708a, cap:0x8194ac,
    pillar:0x70809a, debris:[0x55617a, 0x6d7a90],
    flame:0x86d9ff, flameCore:0xe8f7ff, torchLight:[0x6fc4ff, 1.35, 9.5],
    cloth:0x2b4d70,
    pools:{mode:1, colA:0x4a86c0, colB:0xbfe4ff, glow:0.55, amount:0},
    lakes:true, icicles:true, particles:{kind:2, color:0xdff0ff, n:260},
    nameA:['Frozen','Rimebound','Glacial','Howling','Pale','Shivering','Wintered','Whitelocked'],
    nameB:['Crypts','Caverns','Hollows','Galleries','Sepulchre','Warrens','Reaches','Throat']
  },
  grim: {
    label:'GRIM', accent:'#9fe66a',
    bg:0x070a07, fog:0x0a130a, fogD:0.0030,
    hemi:[0x2c4030, 0x070a06, 0.52], dir:[0xbfd8b0, 0.45],
    floor:0x7c8276, corridor:0x62685c, wall:0x4f5549, cap:0x666c5e,
    pillar:0x5c6254, debris:[0x4a4f44, 0x5e5c48],
    flame:0x8fe05a, flameCore:0xe9ffd0, torchLight:[0x77d94a, 1.35, 9],
    cloth:0x33461f,
    pools:{mode:3, colA:0x0a1207, colB:0x41602c, glow:0.6, amount:0.05, pits:1},
    graveyards:true, bones:true, particles:{kind:3, color:0x9fe66a, n:150},
    nameA:['Blighted','Weeping','Rotting','Cursed','Umbral','Plagued','Mournful','Grim'],
    nameB:['Necropolis','Ossuary','Tombs','Charnels','Graves','Catacombs','Morgue','Crypts']
  },
  verdant: {
    label:'VERDANT', accent:'#59d68f',
    bg:0x060c09, fog:0x091510, fogD:0.0023,
    hemi:[0x2f5a46, 0x08120c, 0.6], dir:[0xd8f0c8, 0.8],
    floor:0x848e7e, corridor:0x6a7560, wall:0x556050, cap:0x6e7a66,
    pillar:0x606c5c, debris:[0x49543f, 0x5c644c],
    flame:0x62e0a8, flameCore:0xe6fff0, torchLight:[0x4ad98e, 1.3, 9],
    cloth:0x1f5038,
    pools:{mode:2, colA:0x0c3532, colB:0x2fa38a, glow:0.6, amount:0.05, pits:1},
    roots:true, shafts:true, particles:{kind:4, color:0x8fe6b8, n:200},
    nameA:['Verdant','Overgrown','Sporebound','Tangled','Mossgrown','Waking','Feral','Blooming'],
    nameB:['Gardens','Warrens','Roots','Conservatory','Hollows','Groves','Cisterns','Arbors']
  }
};
const THEME_KEYS = Object.keys(THEMES);

/* ---------------- name generator ---------------- */
function dungeonName(rng, th){
  const C=['Mal','Vor','Ash','Ker','Ul','Dra','Noth','Zar','Bel','Mor','Gol','Ith'];
  const D=['goth','ath','ruk','esh','mir','gul','dan','oth','ek','ash','uzek','arim'];
  return 'The ' + rng.pick(th.nameA) + ' ' + rng.pick(th.nameB) + ' of ' + rng.pick(C) + '\u2019' + rng.pick(D);
}

/* ---------------- Delaunay (Bowyer–Watson) ---------------- */
function delaunay(pts){
  const n = pts.length;
  if(n < 2) return [];
  if(n === 2) return [[0,1]];
  const P = pts.map((p,i)=>({x:p.x + ((i*0.618033)%1)*1e-3, y:p.y + ((i*0.414213)%1)*1e-3, i}));
  let minX=1e18,minY=1e18,maxX=-1e18,maxY=-1e18;
  for(const p of P){ if(p.x<minX)minX=p.x; if(p.y<minY)minY=p.y; if(p.x>maxX)maxX=p.x; if(p.y>maxY)maxY=p.y; }
  const dm = Math.max(maxX-minX, maxY-minY, 1), mx=(minX+maxX)/2, my=(minY+maxY)/2;
  const s1={x:mx-30*dm,y:my-dm,i:-1}, s2={x:mx,y:my+30*dm,i:-2}, s3={x:mx+30*dm,y:my-dm,i:-3};
  const mkTri=(a,b,c)=>{
    const t=[a,b,c];
    const d=2*(a.x*(b.y-c.y)+b.x*(c.y-a.y)+c.x*(a.y-b.y));
    if(Math.abs(d)<1e-12){ t.ccx=0; t.ccy=0; t.r2=Infinity; return t; }
    const a2=a.x*a.x+a.y*a.y, b2=b.x*b.x+b.y*b.y, c2=c.x*c.x+c.y*c.y;
    t.ccx=(a2*(b.y-c.y)+b2*(c.y-a.y)+c2*(a.y-b.y))/d;
    t.ccy=(a2*(c.x-b.x)+b2*(a.x-c.x)+c2*(b.x-a.x))/d;
    t.r2=(a.x-t.ccx)*(a.x-t.ccx)+(a.y-t.ccy)*(a.y-t.ccy);
    return t;
  };
  let tris=[mkTri(s1,s2,s3)];
  for(const p of P){
    const bad=[], edges=[];
    for(const t of tris){ if((p.x-t.ccx)*(p.x-t.ccx)+(p.y-t.ccy)*(p.y-t.ccy) < t.r2) bad.push(t); }
    for(const t of bad) for(let e=0;e<3;e++) edges.push([t[e],t[(e+1)%3]]);
    const poly=[];
    for(let i=0;i<edges.length;i++){
      let shared=false;
      for(let j=0;j<edges.length;j++){ if(i===j) continue;
        const a=edges[i],b=edges[j];
        if((a[0]===b[0]&&a[1]===b[1])||(a[0]===b[1]&&a[1]===b[0])){shared=true;break;}
      }
      if(!shared) poly.push(edges[i]);
    }
    tris = tris.filter(t=>!bad.includes(t));
    for(const e of poly) tris.push(mkTri(e[0],e[1],p));
  }
  tris = tris.filter(t=>t[0].i>=0 && t[1].i>=0 && t[2].i>=0);
  const seen=new Set(), out=[];
  for(const t of tris) for(let e=0;e<3;e++){
    const a=t[e].i, b=t[(e+1)%3].i, lo=Math.min(a,b), hi=Math.max(a,b), k=lo*4096+hi;
    if(!seen.has(k)){ seen.add(k); out.push([lo,hi]); }
  }
  return out;
}

/* ---------------- generator ---------------- */
function generateDungeon(params){
  const t0 = globalThis.performance?.now() ?? Date.now();
  let attempt = 0, seed = params.seed >>> 0, d = null;
  while(attempt < 5){
    d = tryGenerate(seed, params);
    if(d.valid) break;
    seed = (Math.imul(seed, 9301) + 49297) >>> 0; attempt++;
  }
  d.stats.genMs = (globalThis.performance?.now() ?? Date.now()) - t0;
  d.stats.attempts = attempt + 1;
  return d;
}

function tryGenerate(seed, params){
  const rng = makeRng(seed);
  const N = params.roomCount;
  const TH = THEMES[params.themeKey];

  /* -- 1. scatter -- */
  const R = Math.sqrt(N) * 4.6;
  const rooms = [];
  const large = [];
  for(let i=0;i<N;i++){
    const t = rng.raw();
    let w,h,arch;
    if(t<0.45){ arch='s'; w=rng.i(5,7);  h=rng.i(5,7); }
    else if(t<0.85){ arch='m'; w=rng.i(8,12); h=rng.i(8,12); }
    else { arch='l'; w=rng.i(13,18); h=rng.i(13,18); large.push(i); }
    const st = rng.raw();
    const shape = st<0.60 ? 'rect' : (st<0.82 ? 'ellipse' : 'oct');
    const ang = rng.f(0, Math.PI*2), rad = R*Math.sqrt(rng.raw());
    rooms.push({ id:i, cx:Math.cos(ang)*rad, cy:Math.sin(ang)*rad, w, h, arch, shape,
      sx0:Math.cos(ang)*rad, sy0:Math.sin(ang)*rad,
      type:TYPE.COMBAT, depth:0, difficulty:0.2, degree:0 });
  }
  while(large.length < 2){
    const j = rng.i(0, N-1);
    if(rooms[j].arch !== 'l'){ rooms[j].arch='l'; rooms[j].w=rng.i(13,18); rooms[j].h=rng.i(13,18); rooms[j].shape='rect'; large.push(j); }
  }

  /* -- 2. separate -- */
  const PAD = 2;
  { const CX=new Float64Array(N), CY=new Float64Array(N), HW=new Float64Array(N), HH=new Float64Array(N);
    for(let i=0;i<N;i++){ CX[i]=rooms[i].cx; CY[i]=rooms[i].cy; HW[i]=rooms[i].w/2+PAD/2; HH[i]=rooms[i].h/2+PAD/2; }
    for(let iter=0; iter<300; iter++){
      let moved = false;
      for(let i=0;i<N;i++) for(let j=i+1;j<N;j++){
        const ox = HW[i]+HW[j] - Math.abs(CX[i]-CX[j]);
        if(ox<=0) continue;
        const oy = HH[i]+HH[j] - Math.abs(CY[i]-CY[j]);
        if(oy<=0) continue;
        moved = true;
        if(ox < oy){ const s = CX[i] <= CX[j] ? -1 : 1; CX[i] += s*ox/2; CX[j] -= s*ox/2; }
        else       { const s = CY[i] <= CY[j] ? -1 : 1; CY[i] += s*oy/2; CY[j] -= s*oy/2; }
      }
      if(!moved) break;
    }
    for(let i=0;i<N;i++){ rooms[i].cx = Math.round(CX[i]); rooms[i].cy = Math.round(CY[i]); }
  }

  /* -- 3. graph: Delaunay -> MST -> loops -- */
  const centers = rooms.map(r=>({x:r.cx, y:r.cy}));
  let delEdges = delaunay(centers);
  if(delEdges.length === 0){ delEdges = []; for(let i=0;i<N-1;i++) delEdges.push([i,i+1]); }
  const elen = e => Math.hypot(centers[e[0]].x-centers[e[1]].x, centers[e[0]].y-centers[e[1]].y);

  const adj = Array.from({length:N},()=>[]);
  delEdges.forEach((e,idx)=>{ const w=elen(e); adj[e[0]].push({b:e[1],w,idx}); adj[e[1]].push({b:e[0],w,idx}); });
  const inT = new Uint8Array(N); inT[0]=1; let inCount=1;
  const mstIdx = new Set();
  while(inCount < N){
    let best=null;
    for(let a=0;a<N;a++) if(inT[a]) for(const e of adj[a]) if(!inT[e.b] && (!best || e.w<best.w)) best=e;
    if(!best) break;
    inT[best.b]=1; inCount++; mstIdx.add(best.idx);
  }
  if(inCount < N) return { valid:false, stats:{} };

  let mstLenSum=0; for(const i of mstIdx) mstLenSum += elen(delEdges[i]);
  const mstMean = mstLenSum / Math.max(1, mstIdx.size);

  const edges = [];
  delEdges.forEach((e,idx)=>{
    if(mstIdx.has(idx)) edges.push({a:e[0], b:e[1], isLoop:false, isCritical:false});
    else if(elen(e) < mstMean*2.2 && rng.chance(params.loopChance))
      edges.push({a:e[0], b:e[1], isLoop:true, isCritical:false});
  });
  for(const e of edges){ rooms[e.a].degree++; rooms[e.b].degree++; }

  /* leaf guard: dungeons need dead ends — prune loop edges until >=3 leaves */
  if(N >= 20){
    let leafCount = 0;
    for(let i=0;i<N;i++) if(rooms[i].degree===1) leafCount++;
    while(leafCount < 3){
      let bi=-1, bs=-1;
      for(let i=0;i<edges.length;i++){
        const e=edges[i]; if(!e.isLoop) continue;
        const s=(rooms[e.a].degree===2?1:0)+(rooms[e.b].degree===2?1:0);
        const L=Math.hypot(centers[e.a].x-centers[e.b].x, centers[e.a].y-centers[e.b].y);
        const score = s*10000 + L;
        if(score>bs){ bs=score; bi=i; }
      }
      if(bi<0) break;
      const e=edges[bi];
      if(--rooms[e.a].degree===1) leafCount++;
      if(--rooms[e.b].degree===1) leafCount++;
      edges.splice(bi,1);
    }
  }

  /* -- 4. semantics before carving -- */
  const gAdj = Array.from({length:N},()=>[]);
  edges.forEach((e,i)=>{ gAdj[e.a].push({b:e.b,i}); gAdj[e.b].push({b:e.a,i}); });

  let boss = 0; for(let i=1;i<N;i++) if(rooms[i].w*rooms[i].h > rooms[boss].w*rooms[boss].h) boss = i;

  const distFrom = src => {
    const D = new Int32Array(N).fill(-1); D[src]=0; const q=[src];
    for(let h=0; h<q.length; h++){ const a=q[h]; for(const e of gAdj[a]) if(D[e.b]<0){ D[e.b]=D[a]+1; q.push(e.b); } }
    return D;
  };
  const dB = distFrom(boss);
  let entrance = -1, bestD = -1;
  for(let i=0;i<N;i++) if(i!==boss && rooms[i].degree===1 && dB[i]>bestD){ bestD=dB[i]; entrance=i; }
  if(entrance < 0){ for(let i=0;i<N;i++) if(i!==boss && dB[i]>bestD){ bestD=dB[i]; entrance=i; } }

  const dE = distFrom(entrance);
  let maxDepth = 1; for(let i=0;i<N;i++) if(dE[i]>maxDepth) maxDepth = dE[i];
  rooms.forEach((r,i)=>{ r.depth = Math.max(0,dE[i]); r.difficulty = Math.min(1, 0.15 + 0.85*(r.depth/maxDepth)); });
  rooms[entrance].type = TYPE.ENTRANCE; rooms[entrance].difficulty = 0;
  rooms[boss].type = TYPE.BOSS; rooms[boss].difficulty = 1;

  const par = new Int32Array(N).fill(-1), pe = new Int32Array(N).fill(-1);
  { const q=[entrance], vis=new Uint8Array(N); vis[entrance]=1;
    for(let h=0; h<q.length; h++){ const a=q[h];
      for(const e of gAdj[a]) if(!vis[e.b]){ vis[e.b]=1; par[e.b]=a; pe[e.b]=e.i; q.push(e.b); } } }
  const critRooms = new Set(); let critLen = 0;
  for(let c=boss; c!==-1; c=par[c]){ critRooms.add(c); if(pe[c]>=0){ edges[pe[c]].isCritical=true; critLen++; } if(c===entrance) break; }

  const leaves = [];
  for(let i=0;i<N;i++) if(i!==entrance && i!==boss && rooms[i].degree===1) leaves.push(i);
  leaves.sort((a,b)=>rooms[b].depth-rooms[a].depth);
  leaves.slice(0,4).forEach(i=>{ rooms[i].type = TYPE.TREASURE; });

  const shrineC = [];
  for(let i=0;i<N;i++){ const r=rooms[i];
    if(r.type===TYPE.COMBAT && !critRooms.has(i) && r.depth>maxDepth*0.3 && r.depth<maxDepth*0.85) shrineC.push(i); }
  for(let k=0; k<2 && shrineC.length>0; k++){
    const j = shrineC.splice(rng.i(0,shrineC.length-1),1)[0]; rooms[j].type = TYPE.SHRINE;
  }
  const eliteC = [];
  for(const i of critRooms){ const r=rooms[i];
    if(r.type===TYPE.COMBAT && r.depth>=maxDepth*0.55 && r.depth<=maxDepth*0.85) eliteC.push(i); }
  eliteC.sort((a,b)=>rooms[a].depth-rooms[b].depth);
  for(let k=0;k<Math.min(2,eliteC.length);k++) rooms[eliteC[eliteC.length-1-k]].type = TYPE.ELITE;

  /* -- 4.5 theme room mutations (generation-aware) -- */
  if(TH.lakes){
    const lc = [];
    for(let i=0;i<N;i++){ const r=rooms[i];
      if((r.type===TYPE.COMBAT || r.type===TYPE.ELITE) && Math.min(r.w,r.h)>=9) lc.push(i); }
    for(let k=0; k<2 && lc.length>0; k++) rooms[lc.splice(rng.i(0,lc.length-1),1)[0]].lake = true;
  }
  if(TH.graveyards){
    const gc = [];
    for(let i=0;i<N;i++){ const r=rooms[i];
      if(r.type===TYPE.COMBAT && r.shape!=='ellipse' && Math.min(r.w,r.h)>=8) gc.push(i); }
    for(let k=0; k<3 && gc.length>0; k++) rooms[gc.splice(rng.i(0,gc.length-1),1)[0]].grave = true;
  }

  /* -- 5. carve + rasterize -- */
  let minX=1e9,minY=1e9,maxX=-1e9,maxY=-1e9;
  for(const r of rooms){
    minX=Math.min(minX, r.cx - Math.ceil(r.w/2)); maxX=Math.max(maxX, r.cx + Math.ceil(r.w/2));
    minY=Math.min(minY, r.cy - Math.ceil(r.h/2)); maxY=Math.max(maxY, r.cy + Math.ceil(r.h/2));
  }
  const PADG = 5, offX = PADG - minX, offY = PADG - minY;
  const W = (maxX-minX) + PADG*2 + 1, H = (maxY-minY) + PADG*2 + 1;
  for(const r of rooms){ r.cx += offX; r.cy += offY; r.sx0 += offX; r.sy0 += offY; }

  const grid = new Uint8Array(W*H);
  const roomId = new Int16Array(W*H).fill(-1);
  const corridor = new Uint8Array(W*H);
  const idx = (x,y)=> y*W + x;
  const inB = (x,y)=> x>=0 && y>=0 && x<W && y<H;

  for(const r of rooms){
    const rx=r.w/2, ry=r.h/2, sh=r.shape, ch=Math.min(rx,ry)*0.55;
    const irx2=1/(rx*rx), iry2=1/(ry*ry);
    const y0=Math.max(0,Math.floor(r.cy-ry)), y1=Math.min(H-1,Math.ceil(r.cy+ry));
    const x0=Math.max(0,Math.floor(r.cx-rx)), x1=Math.min(W-1,Math.ceil(r.cx+rx));
    for(let y=y0;y<=y1;y++){
      const dy=y-r.cy, ady=Math.abs(dy), row=y*W;
      if(ady>ry) continue;
      for(let x=x0;x<=x1;x++){
        const dx=x-r.cx, adx=Math.abs(dx);
        if(adx>rx) continue;
        let ok=true;
        if(sh==='ellipse') ok = dx*dx*irx2 + dy*dy*iry2 <= 1.0;
        else if(sh==='oct') ok = adx<=rx-ch || ady<=ry-ch || (adx-(rx-ch))+(ady-(ry-ch)) <= ch;
        if(ok){ const c=row+x; grid[c]=FLOOR; roomId[c]=r.id; }
      }
    }
  }

  const stamp = (x,y)=>{ if(inB(x,y) && grid[idx(x,y)]!==FLOOR){ grid[idx(x,y)]=FLOOR; corridor[idx(x,y)]=1; } };
  const offs = w => w===1?[0] : (w===2?[0,1] : [-1,0,1]);
  const hLine=(x0,x1,y,w)=>{ const o=offs(w); for(let x=Math.min(x0,x1); x<=Math.max(x0,x1); x++) for(const k of o) stamp(x,y+k); };
  const vLine=(y0,y1,x,w)=>{ const o=offs(w); for(let y=Math.min(y0,y1); y<=Math.max(y0,y1); y++) for(const k of o) stamp(x+k,y); };

  for(const e of edges){
    const A=rooms[e.a], B=rooms[e.b];
    let w = e.isCritical ? 3 : 2;
    if(!e.isCritical && (rooms[e.a].type===TYPE.TREASURE || rooms[e.b].type===TYPE.TREASURE) && rng.chance(0.4)) w = 1;
    const dx = Math.abs(A.cx-B.cx), dy = Math.abs(A.cy-B.cy);
    const ovX = Math.min(A.cx+A.w/2, B.cx+B.w/2) - Math.max(A.cx-A.w/2, B.cx-B.w/2);
    const ovY = Math.min(A.cy+A.h/2, B.cy+B.h/2) - Math.max(A.cy-A.h/2, B.cy-B.h/2);
    if(ovX >= w+2 && dy > 0){ const x = Math.round((Math.max(A.cx-A.w/2,B.cx-B.w/2)+Math.min(A.cx+A.w/2,B.cx+B.w/2))/2); vLine(A.cy,B.cy,x,w); }
    else if(ovY >= w+2 && dx > 0){ const y = Math.round((Math.max(A.cy-A.h/2,B.cy-B.h/2)+Math.min(A.cy+A.h/2,B.cy+B.h/2))/2); hLine(A.cx,B.cx,y,w); }
    else if(rng.chance(0.5)){ hLine(A.cx,B.cx,A.cy,w); vLine(A.cy,B.cy,B.cx,w); }
    else { vLine(A.cy,B.cy,A.cx,w); hLine(A.cx,B.cx,B.cy,w); }
  }

  for(let y=0;y<H;y++){
    const row=y*W;
    for(let x=0;x<W;x++){
      if(grid[row+x]!==FLOOR) continue;
      const ya=Math.max(0,y-1), yb=Math.min(H-1,y+1);
      const xa=Math.max(0,x-1), xb=Math.min(W-1,x+1);
      for(let ny=ya;ny<=yb;ny++){
        const nrow=ny*W;
        for(let nx=xa;nx<=xb;nx++){
          const ni=nrow+nx;
          if(grid[ni]===VOID) grid[ni]=WALL;
        }
      }
    }
  }

  const doorway = new Uint8Array(W*H);
  for(let y=0;y<H;y++){
    const row=y*W;
    for(let x=0;x<W;x++){
      const c=row+x;
      if(!corridor[c]) continue;
      if((x<W-1 && roomId[c+1]>=0) || (x>0 && roomId[c-1]>=0) ||
         (y<H-1 && roomId[c+W]>=0) || (y>0 && roomId[c-W]>=0)) doorway[c]=1;
    }
  }

  /* -- 5.5 theme carving: liquid pockets, frozen lakes, arches -- */
  /* Pockets replace single WALL cells with sunken liquid slots (POOL).
     Connectivity is untouched: floor cells never change, and any VOID
     exposed behind a pocket is backfilled with WALL. */
  const pools = [];
  if(TH.pools && TH.pools.amount > 0){
    const nearDoorC = (x,y,d)=>{ for(let oy=-d;oy<=d;oy++) for(let ox=-d;ox<=d;ox++){
      const nx=x+ox, ny=y+oy;
      if(nx>=0&&ny>=0&&nx<W&&ny<H && doorway[idx(nx,ny)]) return true; } return false; };
    const cand = [];
    for(let y=1;y<H-1;y++) for(let x=1;x<W-1;x++){
      const c=idx(x,y);
      if(grid[c]!==WALL || nearDoorC(x,y,2)) continue;
      let nf=0;
      if(grid[c+1]===FLOOR) nf++; if(grid[c-1]===FLOOR) nf++;
      if(grid[c+W]===FLOOR) nf++; if(grid[c-W]===FLOOR) nf++;
      if(nf===1) cand.push({x,y});
    }
    for(let i=cand.length-1;i>0;i--){ const j=rng.i(0,i); const t=cand[i]; cand[i]=cand[j]; cand[j]=t; }
    const target = Math.round(cand.length * TH.pools.amount);
    for(const s of cand){
      if(pools.length >= target) break;
      let close=false;
      for(const p of pools) if(Math.max(Math.abs(p.x-s.x),Math.abs(p.y-s.y)) < 3){ close=true; break; }
      if(close) continue;
      grid[idx(s.x,s.y)] = POOL; pools.push({x:s.x, y:s.y});
    }
    for(const p of pools)
      for(let oy=-1;oy<=1;oy++) for(let ox=-1;ox<=1;ox++){
        const nx=p.x+ox, ny=p.y+oy;
        if(nx>=0&&ny>=0&&nx<W&&ny<H && grid[idx(nx,ny)]===VOID) grid[idx(nx,ny)]=WALL;
      }
  }

  /* Interior liquid pits: single floor cells sunk into lava/water/miasma.
     Carved before BFS validation, so connectivity is still guaranteed;
     interior-only + spacing >= 4 means a room can never be split. */
  if(TH.pools && TH.pools.pits){
    for(const r of rooms){
      if((r.type!==TYPE.COMBAT && r.type!==TYPE.ELITE) || r.lake || r.grave) continue;
      let n = Math.min(TH.pools.pits, Math.floor(r.w*r.h/45)+1), guard=0;
      while(n>0 && guard++<40){
        const x=rng.i(Math.floor(r.cx-r.w/2)+2, Math.ceil(r.cx+r.w/2)-2);
        const y=rng.i(Math.floor(r.cy-r.h/2)+2, Math.ceil(r.cy+r.h/2)-2);
        if(!inB(x,y)) continue;
        const c=idx(x,y);
        if(roomId[c]!==r.id || grid[c]!==FLOOR || doorway[c]) continue;
        let ok=true;
        for(let oy=-1;oy<=1 && ok;oy++) for(let ox=-1;ox<=1;ox++)
          if(grid[idx(x+ox,y+oy)]!==FLOOR){ ok=false; break; }
        if(ok) for(const p of pools) if(Math.max(Math.abs(p.x-x),Math.abs(p.y-y))<4){ ok=false; break; }
        if(!ok) continue;
        grid[c]=POOL; pools.push({x,y}); n--;
      }
    }
  }

  /* Frozen lakes: interior floor cells of lake rooms stay walkable (FLOOR
     for BFS) but are flagged so rendering swaps stone tiles for ice. */
  const lakeMask = new Uint8Array(W*H);
  const lakeCells = [];
  for(const r of rooms){
    if(!r.lake) continue;
    for(let y=Math.floor(r.cy-r.h/2)+2; y<=Math.ceil(r.cy+r.h/2)-2; y++)
      for(let x=Math.floor(r.cx-r.w/2)+2; x<=Math.ceil(r.cx+r.w/2)-2; x++){
        if(!inB(x,y)) continue;
        const c=idx(x,y);
        if(roomId[c]!==r.id || grid[c]!==FLOOR || doorway[c]) continue;
        let solid=false;
        for(let oy=-1;oy<=1 && !solid;oy++) for(let ox=-1;ox<=1;ox++)
          if(grid[idx(x+ox,y+oy)]!==FLOOR){ solid=true; break; }
        if(!solid){ lakeMask[c]=1; lakeCells.push({x,y}); }
      }
  }

  /* Doorway arches: group doorway cells into runs perpendicular to the
     corridor axis; one arch frame per run of width <= 3. */
  const arches = [];
  { const aseen = new Uint8Array(W*H);
    for(let y=0;y<H;y++) for(let x=0;x<W;x++){
      const c=idx(x,y);
      if(!doorway[c] || aseen[c]) continue;
      let rx=0, ry=0;
      if(x<W-1 && roomId[c+1]>=0) rx=1; else if(x>0 && roomId[c-1]>=0) rx=-1;
      else if(y<H-1 && roomId[c+W]>=0) ry=1; else ry=-1;
      const px = rx===0 ? 1 : 0, py = rx===0 ? 0 : 1;
      let x0=x, y0=y, x1=x, y1=y;
      while(inB(x0-px,y0-py) && doorway[idx(x0-px,y0-py)] && !aseen[idx(x0-px,y0-py)]){ x0-=px; y0-=py; }
      while(inB(x1+px,y1+py) && doorway[idx(x1+px,y1+py)] && !aseen[idx(x1+px,y1+py)]){ x1+=px; y1+=py; }
      let len=0;
      for(let ax=x0, ay=y0;; ax+=px, ay+=py){ aseen[idx(ax,ay)]=1; len++; if(ax===x1 && ay===y1) break; }
      if(len<=3) arches.push({x:(x0+x1)/2, y:(y0+y1)/2, px, py, len});
    }
  }

  /* -- 6. BFS field + validation -- */
  const bfs = new Int16Array(W*H).fill(-1);
  const ei = idx(rooms[entrance].cx, rooms[entrance].cy);
  const total = W*H;
  let floorTotal=0; for(let i=0;i<total;i++) if(grid[i]===FLOOR) floorTotal++;
  let reach=0, maxBfs=0;
  if(grid[ei]===FLOOR){
    const q = new Int32Array(floorTotal); let qh=0, qt=0;
    q[qt++]=ei; bfs[ei]=0; reach=1;
    while(qh<qt){
      const c=q[qh++], x=c%W, b=bfs[c]+1;
      let n;
      if(x>0       && grid[n=c-1]===FLOOR && bfs[n]<0){ bfs[n]=b; q[qt++]=n; reach++; }
      if(x<W-1     && grid[n=c+1]===FLOOR && bfs[n]<0){ bfs[n]=b; q[qt++]=n; reach++; }
      if(c>=W      && grid[n=c-W]===FLOOR && bfs[n]<0){ bfs[n]=b; q[qt++]=n; reach++; }
      if(c<total-W && grid[n=c+W]===FLOOR && bfs[n]<0){ bfs[n]=b; q[qt++]=n; reach++; }
    }
    maxBfs = bfs[q[qt-1]];  /* FIFO: last enqueued cell is farthest */
  }
  const valid = reach === floorTotal && floorTotal > 0;

  /* -- 7. decoration (pure data) -- */
  const props=[], spawns=[];
  const occ = new Uint8Array(W*H);
  const nearDoor = (x,y,d)=>{ for(let oy=-d;oy<=d;oy++) for(let ox=-d;ox<=d;ox++)
    if(inB(x+ox,y+oy) && doorway[idx(x+ox,y+oy)]) return true; return false; };
  const interior = (x,y)=>{ for(let oy=-1;oy<=1;oy++) for(let ox=-1;ox<=1;ox++)
    if(!inB(x+ox,y+oy) || grid[idx(x+ox,y+oy)]!==FLOOR) return false; return true; };
  const put = (kind,x,y,rot,scale,rid)=>{ props.push({kind,x,y,rot:rot||0,scale:scale||1,roomId:rid}); occ[idx(x,y)]=1; };

  for(const r of rooms){
    const cix = idx(r.cx, r.cy);
    if(r.type===TYPE.ENTRANCE) put('ring', r.cx, r.cy, 0, 1, r.id);
    if(r.type===TYPE.BOSS){
      put('bossCrystal', r.cx, r.cy, rng.f(0,6.28), 1, r.id);
      const rr = Math.max(2.5, Math.min(r.w,r.h)/2 - 2), a0 = rng.f(0,1);
      for(let k=0;k<6;k++){
        const a = a0 + k*Math.PI/3;
        const bx = Math.round(r.cx + Math.cos(a)*rr), by = Math.round(r.cy + Math.sin(a)*rr);
        if(inB(bx,by) && grid[idx(bx,by)]===FLOOR && !occ[idx(bx,by)] && !nearDoor(bx,by,1)) put('brazier',bx,by,0,1,r.id);
      }
    }
    if(r.type===TYPE.TREASURE && grid[cix]===FLOOR) put('chest', r.cx, r.cy, rng.i(0,3)*Math.PI/2, 1, r.id);
    if(r.type===TYPE.SHRINE && grid[cix]===FLOOR) put('shrineCrystal', r.cx, r.cy, rng.f(0,6.28), 1, r.id);

    if((r.type===TYPE.COMBAT || r.type===TYPE.ELITE) && Math.min(r.w,r.h)>=10 && r.shape!=='ellipse' && !r.grave && !r.lake){
      const step = Math.min(r.w,r.h) >= 14 ? 4 : 3;
      for(let y=Math.ceil(r.cy-r.h/2)+2; y<=r.cy+r.h/2-2; y++)
        for(let x=Math.ceil(r.cx-r.w/2)+2; x<=r.cx+r.w/2-2; x++){
          if(((x-r.cx)%step)!==0 || ((y-r.cy)%step)!==0) continue;
          if(x===r.cx && y===r.cy) continue;
          if(interior(x,y) && !occ[idx(x,y)] && !nearDoor(x,y,2)) put('pillar',x,y,0,rng.f(0.94,1.06),r.id);
        }
    }
    if(r.grave){
      for(let y=Math.ceil(r.cy-r.h/2)+2; y<=r.cy+r.h/2-2; y+=2)
        for(let x=Math.ceil(r.cx-r.w/2)+2; x<=r.cx+r.w/2-2; x+=2){
          if(Math.abs(x-r.cx)<=1 && Math.abs(y-r.cy)<=1) continue;
          if(interior(x,y) && !occ[idx(x,y)] && !nearDoor(x,y,2) && rng.chance(0.8))
            put('grave', x, y, rng.f(-0.3,0.3), rng.f(0.85,1.15), r.id);
        }
      if(Math.min(r.w,r.h)>=10 && grid[cix]===FLOOR && !occ[cix])
        put('sarco', r.cx, r.cy, rng.chance(0.5)?0:Math.PI/2, 1, r.id);
      let cd=4;
      while(cd-->0){
        const x=rng.i(Math.floor(r.cx-r.w/2)+1, Math.ceil(r.cx+r.w/2)-1);
        const y=rng.i(Math.floor(r.cy-r.h/2)+1, Math.ceil(r.cy+r.h/2)-1);
        if(inB(x,y) && roomId[idx(x,y)]===r.id && grid[idx(x,y)]===FLOOR && !occ[idx(x,y)])
          put('candle', x, y, 0, rng.f(0.85,1.2), r.id);
      }
    }
    if(r.type===TYPE.COMBAT || r.type===TYPE.ELITE || r.type===TYPE.BOSS){
      let area=0;
      for(let y=Math.floor(r.cy-r.h/2); y<=Math.ceil(r.cy+r.h/2); y++)
        for(let x=Math.floor(r.cx-r.w/2); x<=Math.ceil(r.cx+r.w/2); x++)
          if(inB(x,y) && roomId[idx(x,y)]===r.id) area++;
      /* enemy density tuned for play, not spectacle: a handful per room,
         hard-capped, so a floor is a sequence of fights rather than a slog */
      let count = Math.round((area/42) * (0.4 + r.difficulty));
      count = Math.min(count, 5);
      if(r.type===TYPE.ELITE) count = Math.max(2, Math.round(count*0.7));
      if(r.type===TYPE.BOSS)  count = rng.i(2,3);
      const tier = r.type===TYPE.ELITE ? 3 : Math.max(1, Math.ceil(r.difficulty*3));
      let guard=0;
      while(count>0 && guard++<220){
        const x=rng.i(Math.floor(r.cx-r.w/2)+1, Math.ceil(r.cx+r.w/2)-1);
        const y=rng.i(Math.floor(r.cy-r.h/2)+1, Math.ceil(r.cy+r.h/2)-1);
        if(!inB(x,y)) continue;
        const c=idx(x,y);
        if(roomId[c]===r.id && grid[c]===FLOOR && !occ[c] && !doorway[c] && !lakeMask[c]){
          spawns.push({x,y,tier,roomId:r.id}); occ[c]=1; count--;
        }
      }
    }
  }

  /* floor-wide encounter budget — thin the roster to a fun size, always keeping
     the boss lair intact and favouring the deeper, harder rooms so the fight
     count still ramps toward the boss instead of swarming every early room. The
     budget grows with the run's floor depth (floor 1 = 34, matching the fixed
     value it replaced, so floor-1 output is unchanged). */
  const SPAWN_CAP = Math.min(64, 28 + (params.floor || 1) * 6);
  if(spawns.length > SPAWN_CAP){
    const bossSp = spawns.filter(s=>s.roomId===boss);
    const rest = spawns.filter(s=>s.roomId!==boss)
      .map(s=>({ s, w:(rooms[s.roomId]?.difficulty ?? 0.3) + rng.f(0,0.5) }))
      .sort((a,b)=>b.w-a.w)
      .slice(0, Math.max(0, SPAWN_CAP - bossSp.length))
      .map(o=>o.s);
    spawns.length = 0;
    spawns.push(...bossSp, ...rest);
  }

  const torchCand=[];
  for(let y=0;y<H;y++){
    const row=y*W;
    for(let x=0;x<W;x++){
      const c=row+x;
      if(grid[c]!==WALL) continue;
      if(x<W-1 && grid[c+1]===FLOOR)      torchCand.push({x,y,dx:1,dy:0});
      else if(x>0 && grid[c-1]===FLOOR)   torchCand.push({x,y,dx:-1,dy:0});
      else if(y<H-1 && grid[c+W]===FLOOR) torchCand.push({x,y,dx:0,dy:1});
      else if(y>0 && grid[c-W]===FLOOR)   torchCand.push({x,y,dx:0,dy:-1});
    }
  }
  for(let i=torchCand.length-1;i>0;i--){ const j=rng.i(0,i); const t=torchCand[i]; torchCand[i]=torchCand[j]; torchCand[j]=t; }
  const torches=[];
  for(const c of torchCand){
    let ok=true;
    for(const t of torches) if(Math.max(Math.abs(t.x-c.x),Math.abs(t.y-c.y))<4){ ok=false; break; }
    if(ok) torches.push(c);
  }
  for(let y=0;y<H;y++){
    const row=y*W;
    for(let x=0;x<W;x++){
      const c=row+x;
      if(grid[c]!==FLOOR || occ[c] || doorway[c] || lakeMask[c]) continue;
      const rid = roomId[c];
      const diff = rid>=0 ? rooms[rid].difficulty : 0.5;
      let p = params.decorDensity * 0.045 * (1.25 - 0.6*diff);
      if(corridor[c]) p *= 0.45;
      if(rng.chance(p)) props.push({kind:'debris',x,y,rot:rng.f(0,6.28),scale:rng.f(0.6,1.35),roomId:rid,v:rng.i(0,2)});
    }
  }

  /* -- 7.5 theme prop sweeps -- */
  const floorDir = (x,y)=>{
    const c=idx(x,y);
    if(x<W-1 && grid[c+1]===FLOOR) return [1,0];
    if(x>0 && grid[c-1]===FLOOR) return [-1,0];
    if(y<H-1 && grid[c+W]===FLOOR) return [0,1];
    if(y>0 && grid[c-W]===FLOOR) return [0,-1];
    return null;
  };
  if(TH.icicles){
    for(let y=0;y<H;y++) for(let x=0;x<W;x++){
      if(grid[idx(x,y)]!==WALL) continue;
      const d = floorDir(x,y);
      if(d && rng.chance(0.06 + 0.08*params.decorDensity))
        props.push({kind:'icicle',x,y,dx:d[0],dy:d[1],rot:rng.f(0,6.28),scale:rng.f(0.7,1.3)});
    }
    for(const lc of lakeCells)
      if(rng.chance(0.05)) props.push({kind:'shardIce',x:lc.x,y:lc.y,rot:rng.f(0,6.28),scale:rng.f(0.6,1.2)});
  }
  if(TH.roots){
    const sites=[];
    for(let y=1;y<H-1;y++) for(let x=1;x<W-1;x++){
      if(grid[idx(x,y)]!==WALL) continue;
      const d = floorDir(x,y);
      if(d && roomId[idx(x+d[0],y+d[1])]>=0) sites.push({x,y,dx:d[0],dy:d[1]});
    }
    for(let i=sites.length-1;i>0;i--){ const j=rng.i(0,i); const t=sites[i]; sites[i]=sites[j]; sites[j]=t; }
    const breaches=[];
    for(const s of sites){
      if(breaches.length>=5) break;
      let close=false;
      for(const b of breaches) if(Math.max(Math.abs(b.x-s.x),Math.abs(b.y-s.y))<7){ close=true; break; }
      if(!close) breaches.push(s);
    }
    const mossMask = new Uint8Array(W*H);
    for(const b of breaches){
      props.push({kind:'roots',x:b.x,y:b.y,dx:b.dx,dy:b.dy,rot:0,scale:rng.f(0.9,1.2)});
      for(let oy=-2;oy<=2;oy++) for(let ox=-2;ox<=2;ox++){
        const nx=b.x+ox, ny=b.y+oy;
        if(!inB(nx,ny)) continue;
        const c=idx(nx,ny);
        if(grid[c]===FLOOR && !mossMask[c] && rng.chance(0.75)){
          mossMask[c]=1; props.push({kind:'moss',x:nx,y:ny,rot:rng.f(0,6.28),scale:rng.f(0.7,1.4)});
        }
      }
    }
    for(let y=0;y<H;y++) for(let x=0;x<W;x++){
      const c=idx(x,y);
      if(grid[c]!==FLOOR || mossMask[c] || lakeMask[c]) continue;
      let nw=0;
      if(x<W-1 && grid[c+1]===WALL) nw++; if(x>0 && grid[c-1]===WALL) nw++;
      if(y<H-1 && grid[c+W]===WALL) nw++; if(y>0 && grid[c-W]===WALL) nw++;
      if(nw>0 && rng.chance(0.12*params.decorDensity)){
        mossMask[c]=1; props.push({kind:'moss',x,y,rot:rng.f(0,6.28),scale:rng.f(0.6,1.3)});
      }
    }
  }
  if(TH.bones){
    for(let y=0;y<H;y++) for(let x=0;x<W;x++){
      const c=idx(x,y);
      if(grid[c]!==FLOOR || occ[c] || doorway[c] || corridor[c]) continue;
      const rid = roomId[c];
      if(rid>=0 && rooms[rid].depth>1 && rng.chance(0.018 + 0.02*params.decorDensity))
        props.push({kind:'bones',x,y,rot:rng.f(0,6.28),scale:rng.f(0.8,1.2),roomId:rid});
    }
  }
  /* liquid veins: crack decals anchored to pool edges so they read as heat/
     rot radiating FROM the liquid into the surrounding stone, never floating
     mid-room. Frost gets pale fracture lines around lake shores. */
  { const DIRS = [[1,0],[-1,0],[0,1],[0,-1]];
    if(TH.pools && (TH.pools.mode===0 || TH.pools.mode===3)){
      const pv = TH.pools.mode===0 ? 0.8 : 0.45;
      for(const p of pools)
        for(const [dx,dy] of DIRS){
          const nx=p.x+dx, ny=p.y+dy;
          if(!inB(nx,ny) || grid[idx(nx,ny)]!==FLOOR) continue;
          if(rng.chance(pv))
            props.push({kind:'crack',x:nx,y:ny,dx,dy,rot:rng.f(0,6.28),scale:rng.f(0.9,1.5)});
        }
    }
    if(TH.lakes){
      for(const lc of lakeCells)
        for(const [dx,dy] of DIRS){
          const nx=lc.x+dx, ny=lc.y+dy;
          if(!inB(nx,ny)) continue;
          const c2 = idx(nx,ny);
          if(grid[c2]!==FLOOR || lakeMask[c2]) continue;
          if(rng.chance(0.3))
            props.push({kind:'crack',x:nx,y:ny,dx,dy,rot:rng.f(0,6.28),scale:rng.f(0.7,1.2),ice:1});
        }
    }
  }
  for(const r of rooms){
    if(r.type!==TYPE.ELITE && r.type!==TYPE.BOSS) continue;
    const cand=[];
    for(let y=Math.floor(r.cy-r.h/2)-1; y<=Math.ceil(r.cy+r.h/2)+1; y++)
      for(let x=Math.floor(r.cx-r.w/2)-1; x<=Math.ceil(r.cx+r.w/2)+1; x++){
        if(!inB(x,y) || grid[idx(x,y)]!==WALL) continue;
        const d = floorDir(x,y);
        if(d && roomId[idx(x+d[0],y+d[1])]===r.id) cand.push({x,y,dx:d[0],dy:d[1]});
      }
    for(let i=cand.length-1;i>0;i--){ const j=rng.i(0,i); const t=cand[i]; cand[i]=cand[j]; cand[j]=t; }
    const placed=[];
    for(const s of cand){
      if(placed.length >= (r.type===TYPE.BOSS?4:2)) break;
      let close=false;
      for(const p of placed) if(Math.max(Math.abs(p.x-s.x),Math.abs(p.y-s.y))<4){ close=true; break; }
      if(!close){ placed.push(s); props.push({kind:'banner',x:s.x,y:s.y,dx:s.dx,dy:s.dy,rot:0,scale:1}); }
    }
  }

  const loops = edges.filter(e=>e.isLoop).length;
  return {
    valid, params, seed, name:dungeonName(rng, TH),
    W,H, grid, roomId, corridor, doorway, bfs, maxBfs,
    rooms, edges, entrance, boss, maxDepth,
    props, spawns, torches, pools, lakeCells, lakeMask, arches,
    stats:{ rooms:N, edges:edges.length, loops, critLen, floorTiles:floorTotal, reach, genMs:0, attempts:1 }
  };
}

/* ---------------- theme-from-seed (AUTO) ---------------- */
function themeFromSeed(seed){
  return THEME_KEYS[(Math.imul(seed ^ 0x9e37, 2654435761)>>>0) % THEME_KEYS.length];
}

export {
  generateDungeon, tryGenerate,
  mulberry32, makeRng, delaunay, dungeonName, themeFromSeed,
  THEMES, THEME_KEYS, TYPE, VOID, FLOOR, WALL, POOL,
};
