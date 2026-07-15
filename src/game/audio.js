/**
 * Procedural sound — Web Audio only, zero audio files.
 * SFX one-shots only (no ambient drone — real music can be layered later).
 *
 * AudioContext starts after a user gesture (main.js → ensureAudio).
 */
let ctx = null, master = null, muted = false, plays = 0;
let noiseBuf = null;

export function ensureAudio(){
  if(ctx){
    if(ctx.state === 'suspended') ctx.resume();
    return;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if(!AC) return;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.35;
  master.connect(ctx.destination);
}

export function setMuted(on){
  muted = on;
  if(master) master.gain.value = on ? 0 : 0.35;
}

export function audioStats(){
  return { state: ctx ? ctx.state : 'none', muted, plays, music: false };
}

/* -------- tiny synth building blocks -------- */
const live = ()=>{ if(!ctx || muted) return false; plays++; return true; };

function env(gainAt, t0, dur, peak=1){
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.012, dur*0.2));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  g.connect(gainAt);
  return g;
}

function osc(type, f0, f1, t0, dur, out){
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t0);
  if(f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t0 + dur);
  o.connect(out);
  o.start(t0); o.stop(t0 + dur + 0.02);
}

function noise(t0, dur, out, filterType='bandpass', f0=1000, f1=null, q=1){
  if(!noiseBuf){
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for(let i=0;i<d.length;i++) d[i] = Math.random()*2 - 1;
  }
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = filterType; f.Q.value = q;
  f.frequency.setValueAtTime(f0, t0);
  if(f1) f.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
  src.connect(f); f.connect(out);
  src.start(t0, Math.random()); src.stop(t0 + dur + 0.02);
}

/* -------- the effects -------- */
export const sfx = {
  /** Visual tell only — no hum (user will add real music later). */
  mimicHum(){ /* no-op: humming removed */ },
  swing(){ if(!live()) return; const t = ctx.currentTime;
    noise(t, 0.08, env(master, t, 0.08, 0.5), 'bandpass', 2600, 700, 1.5);
  },
  hit(){ if(!live()) return; const t = ctx.currentTime;
    osc('square', 220, 110, t, 0.09, env(master, t, 0.09, 0.6));
    noise(t, 0.03, env(master, t, 0.03, 0.35), 'highpass', 2000, null, 0.8);
  },
  kill(){ if(!live()) return; const t = ctx.currentTime;
    osc('sawtooth', 300, 60, t, 0.25, env(master, t, 0.25, 0.55));
    noise(t, 0.2, env(master, t, 0.2, 0.3), 'lowpass', 900, 150);
  },
  hurt(){ if(!live()) return; const t = ctx.currentTime;
    const e = env(master, t, 0.18, 0.55);
    osc('sawtooth', 150, 95, t, 0.18, e);
    osc('sawtooth', 157, 99, t, 0.18, e);   // slight detune = mean buzz
  },
  die(){ if(!live()) return; const t = ctx.currentTime;
    [220, 175, 110].forEach((f,i)=>{
      osc('triangle', f, f*0.85, t + i*0.14, 0.28, env(master, t + i*0.14, 0.28, 0.5));
    });
  },
  pickup(){ if(!live()) return; const t = ctx.currentTime;
    osc('sine', 660, 660, t, 0.09, env(master, t, 0.09, 0.5));
    osc('sine', 990, 990, t + 0.09, 0.16, env(master, t + 0.09, 0.16, 0.5));
  },
  clear(){ if(!live()) return; const t = ctx.currentTime;   // room-clear: quick bright triad
    [523, 784].forEach((f,i)=>{
      const at = t + i*0.08;
      osc('sine', f, f, at, 0.12, env(master, at, 0.12, 0.4));
    });
    osc('triangle', 1047, 1047, t + 0.16, 0.18, env(master, t + 0.16, 0.18, 0.3));
  },
  win(){ if(!live()) return; const t = ctx.currentTime;
    [523, 659, 784, 1047].forEach((f,i)=>{
      const at = t + i*0.16;
      osc('sine', f, f, at, 0.22, env(master, at, 0.22, 0.45));
      osc('triangle', f/2, f/2, at, 0.22, env(master, at, 0.22, 0.25));
    });
  },
  boom(){ if(!live()) return; const t = ctx.currentTime;
    osc('sine', 55, 30, t, 0.4, env(master, t, 0.4, 0.8));
    noise(t, 0.35, env(master, t, 0.35, 0.25), 'lowpass', 400, 60);
  },
  step(){ if(!live()) return; const t = ctx.currentTime;
    noise(t, 0.03, env(master, t, 0.03, 0.10), 'bandpass', 400 + Math.random()*250, null, 1.2);
  },
  crit(){ if(!live()) return; const t = ctx.currentTime;   // bright upward zing
    osc('square', 880, 1760, t, 0.12, env(master, t, 0.12, 0.4));
    noise(t, 0.05, env(master, t, 0.05, 0.3), 'highpass', 3500, null, 1);
  },
  heartbeat(){ if(!live()) return; const t = ctx.currentTime;   // two low thumps
    osc('sine', 62, 40, t, 0.14, env(master, t, 0.14, 0.7));
    osc('sine', 58, 38, t + 0.22, 0.16, env(master, t + 0.22, 0.16, 0.55));
  },
  /** Heavy weapon whoosh */
  heavySwing(){ if(!live()) return; const t = ctx.currentTime;
    noise(t, 0.14, env(master, t, 0.14, 0.55), 'bandpass', 900, 200, 1.2);
    osc('triangle', 90, 50, t, 0.12, env(master, t, 0.12, 0.35));
  },
  /** Soft fail: stepped into a parkour gap */
  gapReset(){ if(!live()) return; const t = ctx.currentTime;
    osc('sine', 140, 70, t, 0.12, env(master, t, 0.12, 0.25));
    noise(t, 0.08, env(master, t, 0.08, 0.12), 'lowpass', 500, 120);
  },
  jump(){ if(!live()) return; const t = ctx.currentTime;
    osc('sine', 180, 320, t, 0.08, env(master, t, 0.08, 0.28));
  },
  land(){ if(!live()) return; const t = ctx.currentTime;
    noise(t, 0.04, env(master, t, 0.04, 0.2), 'lowpass', 600, 150);
  },
  block(){ if(!live()) return; const t = ctx.currentTime; // warden shield clank
    osc('square', 400, 200, t, 0.06, env(master, t, 0.06, 0.35));
    noise(t, 0.05, env(master, t, 0.05, 0.25), 'bandpass', 1800, 800, 2);
  },
};
