import http from "http";
import { randomUUID } from "crypto";
import WebSocket, { WebSocketServer } from "ws";

type Vec2 = { x: number; y: number };
type InputState = {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  aimX: number;
  aimY: number;
  shoot: boolean;
  reload: boolean;
  interact: boolean;
  slot1: boolean;
  slot2: boolean;
  swap: boolean;
};

type Weapon = {
  id: string;
  name: string;
  category: "pistol" | "smg" | "rifle" | "sniper" | "mg" | "shotgun";
  rarity: "common" | "uncommon" | "rare" | "epic" | "legendary";
  damage: number;
  fireRate: number;
  spread: number;
  range: number;
  magSize: number;
  reloadTime: number;
};

type WeaponSlot = {
  weaponId: string;
  ammo: number;
  reserve: number;
};

type Player = {
  id: string;
  name: string;
  x: number;
  y: number;
  hp: number;
  armor: number;
  alive: boolean;
  primary: WeaponSlot | null;
  secondary: WeaponSlot | null;
  activeSlot: 0 | 1;
  velX: number;
  velY: number;
  lastShotAt: number;
  reloadingUntil: number;
  input: InputState;
  kills: number;
  color: string;
  isBot: boolean;
  lastLootAt: number;
  lastLootWeaponId: string;
  lastHitAt: number;
  lastHitConfirmAt: number;
};

type Crate = {
  id: string;
  x: number;
  y: number;
  tier: number;
  opened: boolean;
};

type Shot = {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  weaponId: string;
  expiresAt: number;
};

type KillEvent = {
  id: string;
  killer: string;
  victim: string;
  weaponId: string;
};

type MatchResults = {
  id: string;
  finishedAt: number;
  placements: Array<{
    name: string;
    kills: number;
    alive: boolean;
  }>;
};

type ChatMessage = {
  id: string;
  name: string;
  color: string;
  text: string;
  time: number;
};

const clampNumber = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const TICK_RATE = clampNumber(Number(process.env.SERVER_TICK_RATE ?? 20), 10, 60);
const DT = 1 / TICK_RATE;
const PORT = Number(process.env.SERVER_PORT ?? process.env.PORT ?? 3001);

const MAP = { width: 3600, height: 3600 };
const PLAYER_SPEED = 260;
const PLAYER_RADIUS = 14;
const FOG_DAMAGE_PER_SEC = 7;
const SAFE_ZONE_INTERVAL_MS = 18000;
const SAFE_ZONE_SHRINK_FACTOR = 0.78;
const SAFE_ZONE_MIN_RADIUS = 320;
const SAFE_ZONE_START_RADIUS = 2600;
const SHOT_LIFETIME_MS = 160;
const CRATE_COUNT = 32;
const BOT_TARGET = 6;
const KILLFEED_MAX = 6;
const BOT_VISION_RANGE = 520;

const weapons: Weapon[] = [
  {
    id: "p2000",
    name: "P2000",
    category: "pistol",
    rarity: "common",
    damage: 22,
    fireRate: 4,
    spread: 0.08,
    range: 620,
    magSize: 13,
    reloadTime: 1.3,
  },
  {
    id: "cz75",
    name: "CZ-75",
    category: "pistol",
    rarity: "common",
    damage: 17,
    fireRate: 6,
    spread: 0.12,
    range: 540,
    magSize: 12,
    reloadTime: 1.5,
  },
  {
    id: "mp9",
    name: "MP9",
    category: "smg",
    rarity: "uncommon",
    damage: 16,
    fireRate: 12,
    spread: 0.16,
    range: 520,
    magSize: 30,
    reloadTime: 1.9,
  },
  {
    id: "mac10",
    name: "MAC-10",
    category: "smg",
    rarity: "uncommon",
    damage: 14,
    fireRate: 13,
    spread: 0.18,
    range: 500,
    magSize: 30,
    reloadTime: 2.1,
  },
  {
    id: "nova",
    name: "Nova",
    category: "shotgun",
    rarity: "uncommon",
    damage: 54,
    fireRate: 1.4,
    spread: 0.28,
    range: 360,
    magSize: 8,
    reloadTime: 2.6,
  },
  {
    id: "xm1014",
    name: "XM1014",
    category: "shotgun",
    rarity: "rare",
    damage: 40,
    fireRate: 2.2,
    spread: 0.25,
    range: 380,
    magSize: 7,
    reloadTime: 2.8,
  },
  {
    id: "ak47",
    name: "AK-47",
    category: "rifle",
    rarity: "rare",
    damage: 33,
    fireRate: 8.5,
    spread: 0.11,
    range: 900,
    magSize: 30,
    reloadTime: 2.3,
  },
  {
    id: "m4a1",
    name: "M4A1",
    category: "rifle",
    rarity: "rare",
    damage: 29,
    fireRate: 9,
    spread: 0.1,
    range: 880,
    magSize: 30,
    reloadTime: 2.2,
  },
  {
    id: "awp",
    name: "AWP",
    category: "sniper",
    rarity: "legendary",
    damage: 120,
    fireRate: 1.1,
    spread: 0.03,
    range: 1300,
    magSize: 5,
    reloadTime: 3.3,
  },
  {
    id: "scar20",
    name: "SCAR-20",
    category: "sniper",
    rarity: "epic",
    damage: 48,
    fireRate: 2.2,
    spread: 0.05,
    range: 1200,
    magSize: 20,
    reloadTime: 2.8,
  },
  {
    id: "negev",
    name: "Negev",
    category: "mg",
    rarity: "epic",
    damage: 20,
    fireRate: 11,
    spread: 0.2,
    range: 800,
    magSize: 120,
    reloadTime: 4.6,
  },
];

const weaponsById = new Map(weapons.map((weapon) => [weapon.id, weapon]));
const ROOM_CAP = 16;
const rooms = new Map<string, RoomState>();
const socketRoom = new Map<string, string>();
const socketRate = new Map<string, RateState>();
const SNAPSHOT_RATE = clampNumber(Number(process.env.SNAPSHOT_RATE ?? 20), 10, 60);
const MAX_MESSAGE_SIZE = 4096;
const MAX_MESSAGES_PER_SEC = 120;
const MAX_INPUTS_PER_SEC = 70;
const CHAT_COOLDOWN_MS = 650;
const PING_COOLDOWN_MS = 400;

const walls = [
  // Soft cover / props
  { id: "b1", kind: "crate", x: 520, y: 620, w: 60, h: 60 },
  { id: "b2", kind: "crate", x: 860, y: 640, w: 60, h: 60 },
  { id: "b3", kind: "crate", x: 1120, y: 760, w: 60, h: 60 },
  { id: "b4", kind: "crate", x: 1480, y: 760, w: 60, h: 60 },
  { id: "b5", kind: "crate", x: 2080, y: 700, w: 60, h: 60 },
  { id: "b6", kind: "crate", x: 2440, y: 760, w: 60, h: 60 },
  { id: "b7", kind: "crate", x: 2920, y: 760, w: 60, h: 60 },
  { id: "b8", kind: "crate", x: 680, y: 2260, w: 60, h: 60 },
  { id: "b9", kind: "crate", x: 1040, y: 2240, w: 60, h: 60 },
  { id: "b10", kind: "crate", x: 1400, y: 2300, w: 60, h: 60 },
  { id: "b11", kind: "crate", x: 2200, y: 2300, w: 60, h: 60 },
  { id: "b12", kind: "crate", x: 2560, y: 2240, w: 60, h: 60 },
  { id: "b13", kind: "crate", x: 3000, y: 2260, w: 60, h: 60 },
  { id: "t1", kind: "tree", x: 980, y: 400, w: 90, h: 90 },
  { id: "t2", kind: "tree", x: 1320, y: 420, w: 90, h: 90 },
  { id: "t3", kind: "tree", x: 2140, y: 420, w: 90, h: 90 },
  { id: "t4", kind: "tree", x: 2600, y: 420, w: 90, h: 90 },
  { id: "t5", kind: "tree", x: 820, y: 1480, w: 90, h: 90 },
  { id: "t6", kind: "tree", x: 2820, y: 1480, w: 90, h: 90 },
  { id: "t7", kind: "tree", x: 980, y: 3000, w: 90, h: 90 },
  { id: "t8", kind: "tree", x: 2420, y: 3000, w: 90, h: 90 },
  { id: "u1", kind: "bush", x: 1180, y: 1280, w: 120, h: 70 },
  { id: "u2", kind: "bush", x: 2100, y: 1280, w: 120, h: 70 },
  { id: "u3", kind: "bush", x: 1180, y: 2080, w: 120, h: 70 },
  { id: "u4", kind: "bush", x: 2100, y: 2080, w: 120, h: 70 },
  // Central plaza + pillars
  { id: "c1", kind: "wall", x: 1720, y: 1720, w: 160, h: 40 },
  { id: "c2", kind: "wall", x: 1720, y: 1840, w: 160, h: 40 },
  { id: "c3", kind: "wall", x: 1680, y: 1680, w: 40, h: 200 },
  { id: "c4", kind: "wall", x: 1880, y: 1680, w: 40, h: 200 },
  { id: "p1", kind: "wall", x: 1560, y: 1560, w: 60, h: 60 },
  { id: "p2", kind: "wall", x: 1980, y: 1560, w: 60, h: 60 },
  { id: "p3", kind: "wall", x: 1560, y: 1980, w: 60, h: 60 },
  { id: "p4", kind: "wall", x: 1980, y: 1980, w: 60, h: 60 },

  // Mid lane long walls
  { id: "m1", kind: "wall", x: 880, y: 1120, w: 840, h: 40 },
  { id: "m2", kind: "wall", x: 1880, y: 1120, w: 840, h: 40 },
  { id: "m3", kind: "wall", x: 880, y: 2440, w: 840, h: 40 },
  { id: "m4", kind: "wall", x: 1880, y: 2440, w: 840, h: 40 },

  // Left lane cover
  { id: "l1", kind: "wall", x: 360, y: 520, w: 320, h: 40 },
  { id: "l2", kind: "wall", x: 360, y: 800, w: 40, h: 320 },
  { id: "l3", kind: "wall", x: 360, y: 1400, w: 320, h: 40 },
  { id: "l4", kind: "wall", x: 360, y: 1960, w: 40, h: 320 },
  { id: "l5", kind: "wall", x: 360, y: 2520, w: 320, h: 40 },

  // Right lane cover
  { id: "r1", kind: "wall", x: 2920, y: 520, w: 320, h: 40 },
  { id: "r2", kind: "wall", x: 3200, y: 800, w: 40, h: 320 },
  { id: "r3", kind: "wall", x: 2920, y: 1400, w: 320, h: 40 },
  { id: "r4", kind: "wall", x: 3200, y: 1960, w: 40, h: 320 },
  { id: "r5", kind: "wall", x: 2920, y: 2520, w: 320, h: 40 },

  // Corner compounds
  { id: "ul1", kind: "wall", x: 640, y: 320, w: 360, h: 40 },
  { id: "ul2", kind: "wall", x: 640, y: 320, w: 40, h: 360 },
  { id: "ur1", kind: "wall", x: 2600, y: 320, w: 360, h: 40 },
  { id: "ur2", kind: "wall", x: 2920, y: 320, w: 40, h: 360 },
  { id: "ll1", kind: "wall", x: 640, y: 2920, w: 360, h: 40 },
  { id: "ll2", kind: "wall", x: 640, y: 2600, w: 40, h: 360 },
  { id: "lr1", kind: "wall", x: 2600, y: 2920, w: 360, h: 40 },
  { id: "lr2", kind: "wall", x: 2920, y: 2600, w: 40, h: 360 },
];

type SafeZone = {
  x: number;
  y: number;
  radius: number;
  nextShrinkAt: number;
  lastShrunkAt: number;
};

type RoomState = {
  id: string;
  players: Map<string, Player>;
  sockets: Map<string, WebSocket>;
  crates: Crate[];
  shots: Shot[];
  killFeed: KillEvent[];
  lastResults: MatchResults | null;
  chatLog: ChatMessage[];
  matchOverAt: number;
  lastBroadcastAt: number;
  safeZone: SafeZone;
};

type RateState = {
  windowStart: number;
  msgCount: number;
  inputCount: number;
  lastChatAt: number;
  lastPingAt: number;
};

const palette = [
  "#2f7dff",
  "#ff5c7a",
  "#f5c04d",
  "#3ddc97",
  "#6f78ff",
  "#ff8a4c",
  "#25c2ff",
];

const createSafeZone = (): SafeZone => ({
  x: MAP.width * 0.5,
  y: MAP.height * 0.5,
  radius: SAFE_ZONE_START_RADIUS,
  nextShrinkAt: Date.now() + SAFE_ZONE_INTERVAL_MS,
  lastShrunkAt: Date.now(),
});

const createInput = (): InputState => ({
  up: false,
  down: false,
  left: false,
  right: false,
  aimX: 1,
  aimY: 0,
  shoot: false,
  reload: false,
  interact: false,
  slot1: false,
  slot2: false,
  swap: false,
});

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const vecLength = (x: number, y: number) => Math.hypot(x, y);

const normalize = (x: number, y: number): Vec2 => {
  const len = vecLength(x, y) || 1;
  return { x: x / len, y: y / len };
};

const randomInRange = (min: number, max: number) =>
  min + Math.random() * (max - min);

const spawnPoint = (): Vec2 => {
  for (let i = 0; i < 25; i += 1) {
    const x = randomInRange(120, MAP.width - 120);
    const y = randomInRange(120, MAP.height - 120);
    const blocked = walls.some((wall) => circleIntersectsRect(x, y, 24, wall));
    if (!blocked) {
      return { x, y };
    }
  }
  return { x: MAP.width * 0.5, y: MAP.height * 0.5 };
};

const circleIntersectsRect = (cx: number, cy: number, r: number, rect: { x: number; y: number; w: number; h: number }) => {
  const closestX = clamp(cx, rect.x, rect.x + rect.w);
  const closestY = clamp(cy, rect.y, rect.y + rect.h);
  const dx = cx - closestX;
  const dy = cy - closestY;
  return dx * dx + dy * dy < r * r;
};

const moveWithCollisions = (player: Player, dx: number, dy: number) => {
  let nextX = clamp(player.x + dx, PLAYER_RADIUS, MAP.width - PLAYER_RADIUS);
  let nextY = player.y;
  for (const wall of walls) {
    if (circleIntersectsRect(nextX, nextY, PLAYER_RADIUS, wall)) {
      nextX = player.x;
      player.velX = 0;
      break;
    }
  }

  nextY = clamp(player.y + dy, PLAYER_RADIUS, MAP.height - PLAYER_RADIUS);
  for (const wall of walls) {
    if (circleIntersectsRect(nextX, nextY, PLAYER_RADIUS, wall)) {
      nextY = player.y;
      player.velY = 0;
      break;
    }
  }

  player.x = nextX;
  player.y = nextY;
};

const distance = (a: Vec2, b: Vec2) => vecLength(a.x - b.x, a.y - b.y);

const getActiveSlot = (player: Player): WeaponSlot | null => {
  if (player.activeSlot === 0 && player.primary) return player.primary;
  if (player.activeSlot === 1 && player.secondary) return player.secondary;
  if (player.primary) {
    player.activeSlot = 0;
    return player.primary;
  }
  if (player.secondary) {
    player.activeSlot = 1;
    return player.secondary;
  }
  return null;
};

const setSlotWeapon = (slot: WeaponSlot, weaponId: string) => {
  const weapon = weaponsById.get(weaponId)!;
  slot.weaponId = weapon.id;
  slot.ammo = weapon.magSize;
  slot.reserve = weapon.magSize * 3;
};

const getAlivePlayers = (room: RoomState) =>
  Array.from(room.players.values()).filter((player) => player.alive);

const createCrates = (room: RoomState) => {
  room.crates = Array.from({ length: CRATE_COUNT }, () => {
    const pos = spawnPoint();
    return {
      id: randomUUID(),
      x: pos.x,
      y: pos.y,
      tier: Math.random() < 0.2 ? 2 : Math.random() < 0.5 ? 1 : 0,
      opened: false,
    };
  });
};

const ensureCrates = (room: RoomState) => {
  room.crates = room.crates.filter((crate) => !crate.opened);
  if (room.crates.length < CRATE_COUNT) {
    const needed = CRATE_COUNT - room.crates.length;
    for (let i = 0; i < needed; i += 1) {
      const pos = spawnPoint();
      room.crates.push({
        id: randomUUID(),
        x: pos.x,
        y: pos.y,
        tier: Math.random() < 0.25 ? 2 : Math.random() < 0.5 ? 1 : 0,
        opened: false,
      });
    }
  }
};

const pickWeaponForTier = (tier: number): Weapon => {
  const pool = weapons.filter((weapon) => {
    if (tier === 0) return ["pistol", "smg", "shotgun"].includes(weapon.category);
    if (tier === 1) return ["smg", "rifle", "shotgun"].includes(weapon.category);
    return ["rifle", "sniper", "mg", "shotgun"].includes(weapon.category);
  });
  return pool[Math.floor(Math.random() * pool.length)];
};

const openCrate = (room: RoomState, player: Player, crate: Crate) => {
  if (crate.opened) return;
  crate.opened = true;
  const weapon = pickWeaponForTier(crate.tier);
  player.hp = 100;
  const armorRoll = Math.random();
  if (armorRoll < 0.5 || crate.tier >= 1) {
    const armorGain = crate.tier === 2 ? 60 : crate.tier === 1 ? 40 : 20;
    player.armor = Math.min(100, player.armor + armorGain);
  }
  if (!player.primary) {
    player.primary = {
      weaponId: weapon.id,
      ammo: weapon.magSize,
      reserve: weapon.magSize * 3,
    };
    player.activeSlot = 0;
    player.lastLootAt = Date.now();
    player.lastLootWeaponId = weapon.id;
    return;
  }
  if (!player.secondary) {
    player.secondary = {
      weaponId: weapon.id,
      ammo: weapon.magSize,
      reserve: weapon.magSize * 3,
    };
    player.activeSlot = 1;
    player.lastLootAt = Date.now();
    player.lastLootWeaponId = weapon.id;
    return;
  }
  const slot = getActiveSlot(player);
  if (slot) {
    setSlotWeapon(slot, weapon.id);
    player.lastLootAt = Date.now();
    player.lastLootWeaponId = weapon.id;
  }
};

const dropLoot = (room: RoomState, x: number, y: number, tier: number) => {
  room.crates.push({ id: randomUUID(), x, y, tier, opened: false });
};

const shrinkSafeZone = (room: RoomState) => {
  const now = Date.now();
  const safeZone = room.safeZone;
  if (now < safeZone.nextShrinkAt || safeZone.radius <= SAFE_ZONE_MIN_RADIUS) {
    return;
  }

  const newRadius = Math.max(SAFE_ZONE_MIN_RADIUS, safeZone.radius * SAFE_ZONE_SHRINK_FACTOR);
  const maxOffset = Math.max(0, safeZone.radius - newRadius);
  const offsetAngle = Math.random() * Math.PI * 2;
  const offsetDistance = Math.random() * maxOffset;
  safeZone.x = clamp(
    safeZone.x + Math.cos(offsetAngle) * offsetDistance,
    newRadius,
    MAP.width - newRadius
  );
  safeZone.y = clamp(
    safeZone.y + Math.sin(offsetAngle) * offsetDistance,
    newRadius,
    MAP.height - newRadius
  );
  safeZone.radius = newRadius;
  safeZone.nextShrinkAt = now + SAFE_ZONE_INTERVAL_MS;
  safeZone.lastShrunkAt = now;
};

const createBot = (room: RoomState) => {
  const id = randomUUID();
  const pos = spawnPoint();
  const color = palette[room.players.size % palette.length];
  const starter = weaponsById.get("p2000")!;
  const bot: Player = {
    id,
    name: `BOT-${id.slice(0, 4)}`,
    x: pos.x,
    y: pos.y,
    hp: 100,
    armor: 0,
    alive: true,
    primary: null,
    secondary: {
      weaponId: starter.id,
      ammo: starter.magSize,
      reserve: 52,
    },
    activeSlot: 1,
    velX: 0,
    velY: 0,
    lastShotAt: 0,
    reloadingUntil: 0,
    input: createInput(),
    kills: 0,
    color,
    isBot: true,
    lastLootAt: 0,
    lastLootWeaponId: "",
    lastHitAt: 0,
    lastHitConfirmAt: 0,
  };
  room.players.set(id, bot);
};

const ensureBots = (room: RoomState) => {
  const humans = Array.from(room.players.values()).filter((p) => !p.isBot).length;
  const bots = Array.from(room.players.values()).filter((p) => p.isBot).length;
  const desired = Math.max(0, BOT_TARGET - humans);
  const toSpawn = Math.max(0, desired - bots);
  for (let i = 0; i < toSpawn; i += 1) {
    createBot(room);
  }
  if (bots > desired) {
    let removed = 0;
    for (const [id, player] of room.players) {
      if (removed >= bots - desired) break;
      if (player.isBot) {
        room.players.delete(id);
        removed += 1;
      }
    }
  }
};

const applyBotBrain = (room: RoomState, bot: Player) => {
  if (!bot.alive) return;
  if (bot.primary && bot.activeSlot !== 0) {
    bot.activeSlot = 0;
  }
  const activeSlot = getActiveSlot(bot);
  if (!activeSlot) return;
  const weapon = weaponsById.get(activeSlot.weaponId)!;
  const aliveEnemies = Array.from(room.players.values()).filter(
    (p) => p.alive && p.id !== bot.id && distance(bot, p) <= BOT_VISION_RANGE
  );
  let target: Player | null = null;
  let nearestDist = Infinity;
  for (const enemy of aliveEnemies) {
    const d = distance(bot, enemy);
    if (d < nearestDist) {
      nearestDist = d;
      target = enemy;
    }
  }

  const distToZone = distance(bot, room.safeZone);
  const edgeThreshold = room.safeZone.radius * 0.85;
  const moveToZone = distToZone > edgeThreshold;
  const stayOffEdge =
    distToZone > room.safeZone.radius * 0.65 && distToZone < room.safeZone.radius * 0.9;
  let aimX = bot.input.aimX;
  let aimY = bot.input.aimY;
  let move = { x: 0, y: 0 };
  let shouldShoot = false;

  if (target && nearestDist < weapon.range * 0.9) {
    aimX = target.x - bot.x;
    aimY = target.y - bot.y;
    shouldShoot = true;
    const strafe = Math.random() < 0.5 ? -1 : 1;
    move = normalize(-(aimY) * strafe, aimX * strafe);
  } else {
    const unopened = room.crates.filter((crate) => !crate.opened);
    let crateTarget = unopened[0] ?? null;
    if (crateTarget) {
      let closest = distance(bot, crateTarget);
      for (const crate of unopened) {
        const d = distance(bot, crate);
        if (d < closest) {
          closest = d;
          crateTarget = crate;
        }
      }
    }
    const centerBias = stayOffEdge || moveToZone;
    const zoneGoal = {
      x: room.safeZone.x + randomInRange(-room.safeZone.radius * 0.15, room.safeZone.radius * 0.15),
      y: room.safeZone.y + randomInRange(-room.safeZone.radius * 0.15, room.safeZone.radius * 0.15),
    };
    const goal = centerBias
      ? zoneGoal
      : crateTarget
        ? { x: crateTarget.x, y: crateTarget.y }
        : zoneGoal;
    aimX = goal.x - bot.x;
    aimY = goal.y - bot.y;
    move = normalize(aimX, aimY);
  }

  const nearCrate = room.crates.some(
    (crate) => !crate.opened && distance(bot, crate) < 40
  );

  bot.input = {
    up: move.y < -0.2,
    down: move.y > 0.2,
    left: move.x < -0.2,
    right: move.x > 0.2,
    aimX,
    aimY,
    shoot: shouldShoot && activeSlot.ammo > 0,
    reload: activeSlot.ammo === 0 && activeSlot.reserve > 0,
    interact: nearCrate,
    slot1: false,
    slot2: false,
    swap: false,
  };
};

const createRoom = (): RoomState => {
  const room: RoomState = {
    id: randomUUID(),
    players: new Map(),
    sockets: new Map(),
    crates: [],
    shots: [],
    killFeed: [],
    lastResults: null,
    chatLog: [],
    matchOverAt: 0,
    lastBroadcastAt: 0,
    safeZone: createSafeZone(),
  };
  createCrates(room);
  return room;
};

const findRoomForJoin = () => {
  for (const room of rooms.values()) {
    if (room.players.size < ROOM_CAP && room.matchOverAt === 0) {
      return room;
    }
  }
  const room = createRoom();
  rooms.set(room.id, room);
  return room;
};

const removeFromRoom = (room: RoomState, playerId: string) => {
  room.players.delete(playerId);
  room.sockets.delete(playerId);
  if (room.players.size === 0) {
    rooms.delete(room.id);
  }
};

const createPlayer = (id: string, name: string, color: string): Player => {
  const pos = spawnPoint();
  const starter = weaponsById.get("p2000")!;
  return {
    id,
    name,
    x: pos.x,
    y: pos.y,
    hp: 100,
    armor: 0,
    alive: true,
    primary: null,
    secondary: {
      weaponId: starter.id,
      ammo: starter.magSize,
      reserve: 52,
    },
    activeSlot: 1,
    velX: 0,
    velY: 0,
    lastShotAt: 0,
    reloadingUntil: 0,
    input: createInput(),
    kills: 0,
    color,
    isBot: false,
    lastLootAt: 0,
    lastLootWeaponId: "",
    lastHitAt: 0,
    lastHitConfirmAt: 0,
  };
};

const applyReload = (player: Player, now: number) => {
  if (player.reloadingUntil > 0 && now >= player.reloadingUntil) {
    const slot = getActiveSlot(player);
    if (!slot) return;
    const weapon = weaponsById.get(slot.weaponId)!;
    const needed = weapon.magSize - slot.ammo;
    const taken = Math.min(needed, slot.reserve);
    slot.ammo += taken;
    slot.reserve -= taken;
    player.reloadingUntil = 0;
  }
};

const startReload = (player: Player, now: number) => {
  if (player.reloadingUntil > 0) return;
  const slot = getActiveSlot(player);
  if (!slot) return;
  const weapon = weaponsById.get(slot.weaponId)!;
  if (slot.ammo >= weapon.magSize || slot.reserve <= 0) return;
  player.reloadingUntil = now + weapon.reloadTime * 1000;
};

const lineDistance = (ax: number, ay: number, bx: number, by: number, px: number, py: number) => {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return vecLength(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = clamp(t, 0, 1);
  const lx = ax + t * dx;
  const ly = ay + t * dy;
  return vecLength(px - lx, py - ly);
};

const rayIntersectRect = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
  rect: { x: number; y: number; w: number; h: number }
) => {
  const dx = bx - ax;
  const dy = by - ay;
  let tmin = 0;
  let tmax = 1;

  if (dx !== 0) {
    const tx1 = (rect.x - ax) / dx;
    const tx2 = (rect.x + rect.w - ax) / dx;
    tmin = Math.max(tmin, Math.min(tx1, tx2));
    tmax = Math.min(tmax, Math.max(tx1, tx2));
  } else if (ax < rect.x || ax > rect.x + rect.w) {
    return null;
  }

  if (dy !== 0) {
    const ty1 = (rect.y - ay) / dy;
    const ty2 = (rect.y + rect.h - ay) / dy;
    tmin = Math.max(tmin, Math.min(ty1, ty2));
    tmax = Math.min(tmax, Math.max(ty1, ty2));
  } else if (ay < rect.y || ay > rect.y + rect.h) {
    return null;
  }

  if (tmax >= tmin && tmin >= 0 && tmin <= 1) {
    return tmin;
  }
  return null;
};

const fireWeapon = (room: RoomState, player: Player, now: number) => {
  const slot = getActiveSlot(player);
  if (!slot) return;
  const weapon = weaponsById.get(slot.weaponId);
  if (!weapon || player.reloadingUntil > 0 || slot.ammo <= 0) return;
  const cooldown = 1000 / weapon.fireRate;
  if (now - player.lastShotAt < cooldown) return;

  player.lastShotAt = now;
  slot.ammo -= 1;

  const aim = normalize(player.input.aimX, player.input.aimY);
  const spreadAngle = (Math.random() - 0.5) * weapon.spread;
  const angle = Math.atan2(aim.y, aim.x) + spreadAngle;
  const dir = { x: Math.cos(angle), y: Math.sin(angle) };
  const end = {
    x: player.x + dir.x * weapon.range,
    y: player.y + dir.y * weapon.range,
  };

  let wallHitT: number | null = null;
  for (const wall of walls) {
    const t = rayIntersectRect(player.x, player.y, end.x, end.y, wall);
    if (t !== null && (wallHitT === null || t < wallHitT)) {
      wallHitT = t;
    }
  }
  if (wallHitT !== null) {
    end.x = player.x + (end.x - player.x) * wallHitT;
    end.y = player.y + (end.y - player.y) * wallHitT;
  }

  let hitPlayer: Player | undefined;
  let hitDistance = Infinity;
  for (const target of room.players.values()) {
    if (!target.alive || target.id === player.id) continue;
    const dist = lineDistance(player.x, player.y, end.x, end.y, target.x, target.y);
    const centerDist = distance({ x: player.x, y: player.y }, { x: target.x, y: target.y });
    if (dist <= PLAYER_RADIUS && centerDist < hitDistance) {
      hitPlayer = target;
      hitDistance = centerDist;
    }
  }

  if (hitPlayer) {
    const armorReduction = weapon.category === "sniper" ? 0.2 : 0.4;
    const armorDamage = Math.min(hitPlayer.armor, weapon.damage * armorReduction);
    hitPlayer.armor = Math.max(0, hitPlayer.armor - armorDamage);
    const healthDamage = weapon.damage - armorDamage;
    hitPlayer.hp -= healthDamage;
    hitPlayer.lastHitAt = now;
    if (hitPlayer.hp <= 0) {
      hitPlayer.hp = 0;
      hitPlayer.alive = false;
      player.kills += 1;
      room.killFeed.unshift({
        id: randomUUID(),
        killer: player.name,
        victim: hitPlayer.name,
        weaponId: weapon.id,
      });
      if (room.killFeed.length > KILLFEED_MAX) {
        room.killFeed = room.killFeed.slice(0, KILLFEED_MAX);
      }
      const dropTier = Math.random() < 0.6 ? 2 : Math.random() < 0.8 ? 1 : 0;
      dropLoot(room, hitPlayer.x, hitPlayer.y, dropTier);
    }
    player.lastHitConfirmAt = now;
  }

  room.shots.push({
    id: randomUUID(),
    x1: player.x,
    y1: player.y,
    x2: end.x,
    y2: end.y,
    weaponId: weapon.id,
    expiresAt: now + SHOT_LIFETIME_MS,
  });
};

const tickRoom = (room: RoomState) => {
  const now = Date.now();
  shrinkSafeZone(room);
  ensureCrates(room);
  ensureBots(room);

  room.players.forEach((player) => {
    if (player.isBot) applyBotBrain(room, player);
  });

  room.players.forEach((player) => {
    if (!player.alive) return;
    applyReload(player, now);

    if (player.input.slot1 && player.primary) {
      player.activeSlot = 0;
    } else if (player.input.slot2 && player.secondary) {
      player.activeSlot = 1;
    } else if (player.input.swap) {
      if (player.activeSlot === 0 && player.secondary) {
        player.activeSlot = 1;
      } else if (player.activeSlot === 1 && player.primary) {
        player.activeSlot = 0;
      }
    }

    const moveX = Number(player.input.right) - Number(player.input.left);
    const moveY = Number(player.input.down) - Number(player.input.up);
    const move = normalize(moveX, moveY);
    player.velX = 0;
    player.velY = 0;
    moveWithCollisions(player, move.x * PLAYER_SPEED * DT, move.y * PLAYER_SPEED * DT);

    if (player.input.shoot) {
      fireWeapon(room, player, now);
    }

    const activeSlot = getActiveSlot(player);
    if (
      activeSlot &&
      activeSlot.ammo === 0 &&
      activeSlot.reserve > 0 &&
      player.reloadingUntil === 0
    ) {
      startReload(player, now);
    }

    if (player.input.reload) {
      startReload(player, now);
    }

    if (player.input.interact) {
      const target = room.crates
        .filter((crate) => !crate.opened)
        .map((crate) => ({ crate, dist: distance(player, crate) }))
        .filter((entry) => entry.dist < 120)
        .sort((a, b) => a.dist - b.dist)[0]?.crate;
      if (target) openCrate(room, player, target);
    }

    const distToZone = distance(player, room.safeZone);
    if (distToZone > room.safeZone.radius) {
      player.hp -= FOG_DAMAGE_PER_SEC * DT;
      if (player.hp <= 0) {
        player.hp = 0;
        player.alive = false;
      }
    }
  });

  room.shots = room.shots.filter((shot) => shot.expiresAt > now);

  const alive = getAlivePlayers(room);
  if (alive.length <= 1 && room.matchOverAt === 0 && room.players.size > 0) {
    room.matchOverAt = now + 5000;
    const placements = Array.from(room.players.values())
      .sort((a, b) => {
        if (a.alive !== b.alive) return a.alive ? -1 : 1;
        if (a.kills !== b.kills) return b.kills - a.kills;
        return b.hp - a.hp;
      })
      .map((player) => ({
        name: player.name,
        kills: player.kills,
        alive: player.alive,
      }));
    room.lastResults = {
      id: randomUUID(),
      finishedAt: now,
      placements,
    };
  }

  // Match reset is triggered by player request after results are shown.

  if (now - room.lastBroadcastAt >= 1000 / SNAPSHOT_RATE) {
    room.lastBroadcastAt = now;
    broadcastState(room);
  }
};

const broadcastState = (room: RoomState) => {
  const snapshot = {
    type: "state",
    time: Date.now(),
    safeZone: {
      x: room.safeZone.x,
      y: room.safeZone.y,
      radius: room.safeZone.radius,
      nextShrinkAt: room.safeZone.nextShrinkAt,
      lastShrunkAt: room.safeZone.lastShrunkAt,
    },
    players: Array.from(room.players.values()).map((player) => {
      const active = getActiveSlot(player);
      return {
        id: player.id,
        name: player.name,
        x: player.x,
        y: player.y,
        hp: player.hp,
        armor: player.armor,
        alive: player.alive,
        primaryWeaponId: player.primary?.weaponId ?? null,
        secondaryWeaponId: player.secondary?.weaponId ?? null,
        activeSlot: player.activeSlot,
        activeWeaponId: active?.weaponId ?? "",
        ammo: active?.ammo ?? 0,
        reserve: active?.reserve ?? 0,
        kills: player.kills,
        color: player.color,
        reloading: player.reloadingUntil > 0,
        lastLootAt: player.lastLootAt,
        lastLootWeaponId: player.lastLootWeaponId,
        lastHitAt: player.lastHitAt,
        lastHitConfirmAt: player.lastHitConfirmAt,
      };
    }),
    crates: room.crates.filter((crate) => !crate.opened),
    shots: room.shots,
    killFeed: room.killFeed,
    match: {
      overAt: room.matchOverAt,
      results: room.lastResults,
      phase: room.matchOverAt > 0 ? "resetting" : "playing",
    },
    aliveCount: getAlivePlayers(room).length,
    chat: room.chatLog,
  };

  const payload = JSON.stringify(snapshot);
  room.sockets.forEach((socket) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(payload);
    }
  });
};

const server = http.createServer((req, res) => {
  if (!req.url || req.method !== "GET") {
    res.statusCode = 404;
    res.end();
    return;
  }
  if (req.url === "/health") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, time: Date.now() }));
    return;
  }
  res.statusCode = 404;
  res.end();
});
const wss = new WebSocketServer({ server });

const send = (socket: WebSocket, data: unknown) => {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
  }
};

wss.on("connection", (socket) => {
  const id = randomUUID();
  const color = palette[Math.floor(Math.random() * palette.length)];
  const room = findRoomForJoin();
  const player = createPlayer(id, `Operator-${id.slice(0, 4)}`, color);

  room.players.set(id, player);
  room.sockets.set(id, socket);
  socketRoom.set(id, room.id);
  socketRate.set(id, {
    windowStart: Date.now(),
    msgCount: 0,
    inputCount: 0,
    lastChatAt: 0,
    lastPingAt: 0,
  });

  send(socket, {
    type: "welcome",
    id,
    map: MAP,
    weapons,
    walls,
    safeZone: {
      x: room.safeZone.x,
      y: room.safeZone.y,
      radius: room.safeZone.radius,
      nextShrinkAt: room.safeZone.nextShrinkAt,
    },
  });

  socket.on("message", (data) => {
    try {
      const raw = data.toString();
      if (raw.length > MAX_MESSAGE_SIZE) return;
      const msg = JSON.parse(raw);
      const roomId = socketRoom.get(id);
      if (!roomId) return;
      const currentRoom = rooms.get(roomId);
      if (!currentRoom) return;
      if (!currentRoom.players.has(id)) return;
      const current = currentRoom.players.get(id)!;
      const now = Date.now();
      const rate = socketRate.get(id);
      if (!rate) return;
      if (now - rate.windowStart >= 1000) {
        rate.windowStart = now;
        rate.msgCount = 0;
        rate.inputCount = 0;
      }
      rate.msgCount += 1;
      if (rate.msgCount > MAX_MESSAGES_PER_SEC) return;
      if (msg.type === "join" && typeof msg.name === "string") {
        current.name = msg.name.slice(0, 16);
        if (typeof msg.skin === "string" && palette.includes(msg.skin)) {
          current.color = msg.skin;
        }
      }
      if (msg.type === "respawn") {
        const currentName = current.name;
        const currentColor = current.color;
        removeFromRoom(currentRoom, id);
        const nextRoom = createRoom();
        rooms.set(nextRoom.id, nextRoom);
        const nextPlayer = createPlayer(id, currentName, currentColor);
        nextRoom.players.set(id, nextPlayer);
        nextRoom.sockets.set(id, socket);
        socketRoom.set(id, nextRoom.id);
        send(socket, {
          type: "welcome",
          id,
          weapons,
          walls,
          safeZone: {
            x: nextRoom.safeZone.x,
            y: nextRoom.safeZone.y,
            radius: nextRoom.safeZone.radius,
            nextShrinkAt: nextRoom.safeZone.nextShrinkAt,
          },
        });
      }
      if (msg.type === "input") {
        rate.inputCount += 1;
        if (rate.inputCount > MAX_INPUTS_PER_SEC) return;
        const aimX = Number(msg.aimX);
        const aimY = Number(msg.aimY);
        current.input = {
          up: Boolean(msg.up),
          down: Boolean(msg.down),
          left: Boolean(msg.left),
          right: Boolean(msg.right),
          aimX: Number.isFinite(aimX) ? clampNumber(aimX, -2000, 2000) : 1,
          aimY: Number.isFinite(aimY) ? clampNumber(aimY, -2000, 2000) : 0,
          shoot: Boolean(msg.shoot),
          reload: Boolean(msg.reload),
          interact: Boolean(msg.interact),
          slot1: Boolean(msg.slot1),
          slot2: Boolean(msg.slot2),
          swap: Boolean(msg.swap),
        };
      }
      if (msg.type === "ping" && typeof msg.t === "number") {
        if (now - rate.lastPingAt < PING_COOLDOWN_MS) return;
        rate.lastPingAt = now;
        send(socket, { type: "pong", t: msg.t });
      }
      if (msg.type === "chat" && typeof msg.text === "string") {
        if (now - rate.lastChatAt < CHAT_COOLDOWN_MS) return;
        rate.lastChatAt = now;
        const text = msg.text.trim().slice(0, 120);
        if (text.length > 0) {
          currentRoom.chatLog.push({
            id: randomUUID(),
            name: current.name,
            color: current.color,
            text,
            time: Date.now(),
          });
          if (currentRoom.chatLog.length > 30) {
            currentRoom.chatLog = currentRoom.chatLog.slice(-30);
          }
        }
      }
    } catch {
      // Ignore malformed payloads.
    }
  });

  socket.on("close", () => {
    const roomId = socketRoom.get(id);
    if (roomId) {
      const currentRoom = rooms.get(roomId);
      if (currentRoom) {
        removeFromRoom(currentRoom, id);
      }
      socketRoom.delete(id);
    }
    socketRate.delete(id);
  });
});

server.listen(PORT, () => {
  console.log(`Game server running on port ${PORT}`);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

setInterval(() => {
  rooms.forEach((room) => tickRoom(room));
}, 1000 / TICK_RATE);
