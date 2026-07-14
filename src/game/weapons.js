/**
 * Weapon registry — pure data, no imports. Each weapon gives combat a distinct
 * feel; enemies.js resolves the equipped weapon by key from run state and drives
 * tryAttack() off these numbers.
 *
 *   melee  — a radial swipe around the player (radius/cd/dmg/knock)
 *   ranged — spends mana to loose a homing-ish bolt (projSpeed/mana)
 *
 * `label` is the pickup color used for the floating weapon token in loot.js.
 */
export const WEAPONS = {
  blade: {
    key:'blade',  name:'Rusted Blade',  kind:'melee',
    dmg:1, radius:1.3, cd:0.34, knock:0.45, speedTag:'Fast',
    color:0x9ffdea,
  },
  hammer: {
    key:'hammer', name:'Stone Hammer',  kind:'melee',
    dmg:3, radius:1.95, cd:0.9, knock:1.15, speedTag:'Heavy',
    color:0xffb15a,
  },
  wand: {
    key:'wand',   name:'Ember Wand',    kind:'ranged',
    dmg:2, cd:0.42, mana:1, projSpeed:16, range:16, knock:0.35, speedTag:'Ranged',
    color:0xff7a4a,
  },
};

export const WEAPON_KEYS = Object.keys(WEAPONS);
export const weaponOf = key => WEAPONS[key] || WEAPONS.blade;
