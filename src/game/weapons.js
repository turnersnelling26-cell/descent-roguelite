/**
 * Weapon registry — pure data. Each weapon answers: what decision does carrying
 * this represent? Unlockable arms join the drop pool via save.unlocks.
 */
export const WEAPONS = {
  blade: {
    key:'blade',  name:'Rusted Blade',  kind:'melee',
    dmg:1, radius:1.3, cd:0.34, knock:0.45, speedTag:'Fast · Crit',
    color:0x9ffdea, crit:0.20, moveWhileHeld:1.12,
  },
  hammer: {
    key:'hammer', name:'Stone Hammer',  kind:'melee',
    dmg:3, radius:1.95, cd:0.9, knock:1.15, speedTag:'Heavy',
    color:0xffb15a, crit:0.10,
  },
  wand: {
    key:'wand',   name:'Ember Wand',    kind:'ranged',
    dmg:2, cd:0.42, mana:1, projSpeed:16, range:16, knock:0.35, speedTag:'Ranged',
    color:0xff7a4a, crit:0.10,
  },
  fangs: {
    key:'fangs',  name:'Twin Fangs',    kind:'melee',
    dmg:1, radius:1.05, cd:0.22, knock:0.1, speedTag:'Frenzy',
    color:0xff6a9a, crit:0.25,
  },
  spear: {
    key:'spear',  name:'Warden Spear',  kind:'melee',
    dmg:2, radius:2.3, cd:0.60, knock:0.9, speedTag:'Lancer',
    color:0x8ab4ff, crit:0.10, arcDeg:100, pierceShield:true,
  },
  rod: {
    key:'rod',    name:'Frost Rod',     kind:'ranged',
    dmg:1, cd:0.50, mana:1, projSpeed:14, range:14, knock:0.2, speedTag:'Control',
    color:0x9fd8ff, crit:0.10, slowOnHit:1.2, slowChance:0.35,
  },
};

export const WEAPON_KEYS = Object.keys(WEAPONS);
export const weaponOf = key => WEAPONS[key] || WEAPONS.blade;

/** Keys available as floor drops given unlock flags. */
export function droppableWeapons(unlocks = {}){
  const pool = ['hammer', 'wand'];
  if(unlocks.fangs) pool.push('fangs');
  if(unlocks.spear) pool.push('spear');
  if(unlocks.rod)   pool.push('rod');
  return pool.filter(k => WEAPONS[k]);
}
