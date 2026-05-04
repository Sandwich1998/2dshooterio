/* eslint-disable react-hooks/refs */

"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type PlayerSnapshot = {
  id: string;
  name: string;
  x: number;
  y: number;
  hp: number;
  armor: number;
  alive: boolean;
  primaryWeaponId: string | null;
  secondaryWeaponId: string | null;
  activeWeaponId: string;
  activeSlot: 0 | 1;
  ammo: number;
  reserve: number;
  kills: number;
  color: string;
  reloading: boolean;
  lastLootAt: number;
  lastLootWeaponId: string;
  lastHitAt: number;
  lastHitConfirmAt: number;
};

type CrateSnapshot = {
  id: string;
  x: number;
  y: number;
  tier: number;
};

type ShotSnapshot = {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  weaponId: string;
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

type ServerState = {
  time: number;
  map: { width: number; height: number };
  safeZone: { x: number; y: number; radius: number; nextShrinkAt: number; lastShrunkAt: number };
  walls: Array<{ id: string; kind: string; x: number; y: number; w: number; h: number }>;
  players: PlayerSnapshot[];
  crates: CrateSnapshot[];
  shots: ShotSnapshot[];
  killFeed: KillEvent[];
  chat: Array<{ id: string; name: string; text: string; time: number; color: string }>;
  match: {
    overAt: number;
    results: MatchResults | null;
    phase: "playing" | "resetting";
  };
  aliveCount: number;
};

type Weapon = {
  id: string;
  name: string;
  category: string;
  rarity: string;
  damage: number;
  fireRate: number;
  spread: number;
  range: number;
  magSize: number;
  reloadTime: number;
};

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

type StickState = {
  pointerId: number | null;
  startX: number;
  startY: number;
  x: number;
  y: number;
  active: boolean;
};

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:3001";
const INTERP_DELAY = 35;
const CLIENT_SPEED = 260;
const CLIENT_RADIUS = 14;
const WEAPON_ICON_BASE = "/weapons/csgo";
const USERNAME_MAX_LENGTH = 16;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));
const normalizeStick = (dx: number, dy: number, radius: number) => {
  const len = Math.hypot(dx, dy);
  if (len <= 0.0001) {
    return { x: 0, y: 0, distance: 0 };
  }
  const clamped = Math.min(radius, len);
  const scale = clamped / len;
  return { x: dx * scale, y: dy * scale, distance: clamped / radius };
};

const fillNoiseData = (data: Float32Array, intensity: number) => {
  for (let i = 0; i < data.length; i += 1) {
    data[i] = (Math.random() * 2 - 1) * intensity;
  }
};

const hostLabel = (url: string) => url.replace(/^wss?:\/\//, "");
const MOVEMENT_KEYS = new Set(["w", "a", "s", "d"]);
const normalizeUsername = (value: string) =>
  value.replace(/\s+/g, " ").trim().slice(0, USERNAME_MAX_LENGTH);

const getInputDirection = (input: InputState) => {
  const x = Number(input.right) - Number(input.left);
  const y = Number(input.down) - Number(input.up);
  const len = Math.hypot(x, y) || 1;
  return { x: x / len, y: y / len };
};

const circleIntersectsRect = (
  cx: number,
  cy: number,
  r: number,
  rect: { x: number; y: number; w: number; h: number }
) => {
  const closestX = clamp(cx, rect.x, rect.x + rect.w);
  const closestY = clamp(cy, rect.y, rect.y + rect.h);
  const dx = cx - closestX;
  const dy = cy - closestY;
  return dx * dx + dy * dy < r * r;
};

const moveWithCollisionsClient = (
  x: number,
  y: number,
  dx: number,
  dy: number,
  map: { width: number; height: number } | null,
  walls: Array<{ x: number; y: number; w: number; h: number }>
) => {
  if (!map || walls.length === 0) {
    return { x: x + dx, y: y + dy };
  }
  let nextX = clamp(x + dx, CLIENT_RADIUS, map.width - CLIENT_RADIUS);
  let nextY = y;
  for (const wall of walls) {
    if (circleIntersectsRect(nextX, nextY, CLIENT_RADIUS, wall)) {
      nextX = x;
      break;
    }
  }

  nextY = clamp(y + dy, CLIENT_RADIUS, map.height - CLIENT_RADIUS);
  for (const wall of walls) {
    if (circleIntersectsRect(nextX, nextY, CLIENT_RADIUS, wall)) {
      nextY = y;
      break;
    }
  }

  return { x: nextX, y: nextY };
};

const getViewportCenter = (canvas: HTMLCanvasElement | null) => {
  if (canvas) {
    const rect = canvas.getBoundingClientRect();
    return { x: rect.width * 0.5, y: rect.height * 0.5 };
  }
  const viewport = window.visualViewport;
  const width = viewport?.width ?? window.innerWidth;
  const height = viewport?.height ?? window.innerHeight;
  return { x: width * 0.5, y: height * 0.5 };
};

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const stateRef = useRef<ServerState | null>(null);
  const weaponsRef = useRef<Weapon[]>([]);
  const mapRef = useRef<{ width: number; height: number } | null>(null);
  const wallsRef = useRef<Array<{ id: string; kind: string; x: number; y: number; w: number; h: number }>>([]);
  const weaponsByIdRef = useRef<Map<string, Weapon>>(new Map());
  const weaponsByNameRef = useRef<Map<string, Weapon>>(new Map());
  const myIdRef = useRef<string | null>(null);
  const inputRef = useRef<InputState>({
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
  const mouseRef = useRef({ x: 0, y: 0 });
  const aimSmoothRef = useRef({ x: 1, y: 0 });
  const pressedKeysRef = useRef<Set<string>>(new Set());
  const mobilePerfAutoRef = useRef(false);
  const moveStickRef = useRef<StickState>({
    pointerId: null,
    startX: 0,
    startY: 0,
    x: 0,
    y: 0,
    active: false,
  });
  const aimStickRef = useRef<StickState>({
    pointerId: null,
    startX: 0,
    startY: 0,
    x: 0,
    y: 0,
    active: false,
  });

  const [status, setStatus] = useState<"idle" | "connecting" | "ready">("idle");
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState("");
  const [perfMode, setPerfMode] = useState(false);
  const [isMobileUi, setIsMobileUi] = useState(false);
  const [isLandscape, setIsLandscape] = useState(false);
  const [touchControlsReady, setTouchControlsReady] = useState(false);
  const skins = useMemo(
    () => ["#2f7dff", "#ff5c7a", "#f5c04d", "#3ddc97", "#6f78ff", "#ff8a4c", "#25c2ff"],
    []
  );
  const [skin, setSkin] = useState(skins[0]);
  const [hud, setHud] = useState({
    hp: 100,
    armor: 0,
    ammo: 0,
    reserve: 0,
    weapon: "P2000",
    kills: 0,
    aliveCount: 0,
    primary: "Empty",
    secondary: "P2000",
    activeSlot: 1 as 0 | 1,
    reloading: false,
  });
  const hudRef = useRef(hud);
  const [killFeed, setKillFeed] = useState<KillEvent[]>([]);
  const killFeedRef = useRef<KillEvent[]>([]);
  const [spectateId, setSpectateId] = useState<string | null>(null);
  const spectateRef = useRef<string | null>(null);
  const [matchResults, setMatchResults] = useState<MatchResults | null>(null);
  const matchResultsRef = useRef<MatchResults | null>(null);
  const [showScoreboard, setShowScoreboard] = useState(false);
  const [chatText, setChatText] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const chatInputRef = useRef<HTMLInputElement | null>(null);
  const [chatLog, setChatLog] = useState<
    Array<{ id: string; name: string; text: string; color: string }>
  >([]);
  const audioRef = useRef<AudioContext | null>(null);
  const audioChainRef = useRef<{ masterGain: GainNode; masterFilter: BiquadFilterNode } | null>(
    null
  );
  const recentShotsRef = useRef<Set<string>>(new Set());
  const lastShotSoundAtRef = useRef(0);
  const readyTickTimeoutRef = useRef<number | null>(null);
  const pingSentAtRef = useRef(0);
  const [pingMs, setPingMs] = useState(0);
  const reverbRef = useRef<{
    input: GainNode;
    output: GainNode;
    delay: DelayNode;
    feedback: GainNode;
    filter: BiquadFilterNode;
  } | null>(null);
  const snapshotsRef = useRef<ServerState[]>([]);
  const lastHitAtRef = useRef(0);
  const lastHitConfirmRef = useRef(0);
  const [hitFlash, setHitFlash] = useState(0);
  const [hitMarker, setHitMarker] = useState(0);
  const screenShakeRef = useRef(0);
  const lastShrinkAtRef = useRef(0);
  const [zoneBanner, setZoneBanner] = useState(0);
  const [killBanner, setKillBanner] = useState<{ text: string; at: number } | null>(null);
  const lastKillIdRef = useRef<string | null>(null);
  const ammoPulseRef = useRef(0);
  const [ammoPulse, setAmmoPulse] = useState(false);
  const lastReloadAtRef = useRef(0);
  const [lootRoll, setLootRoll] = useState<{
    id: string;
    items: string[];
    final: string;
    rarity: string;
  } | null>(null);
  const [lootOffset, setLootOffset] = useState(0);
  const [lootFinale, setLootFinale] = useState(false);
  const [lootBurst, setLootBurst] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const rollWindowRef = useRef<HTMLDivElement | null>(null);
  const rollTrackRef = useRef<HTMLDivElement | null>(null);
  const finalItemRef = useRef<HTMLSpanElement | null>(null);
  const lastLootAtRef = useRef(0);
  const camRef = useRef({ x: 0, y: 0 });
  const renderPosRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const gridPatternRef = useRef<CanvasPattern | null>(null);
  const gridPatternSizeRef = useRef(0);
  const dprRef = useRef(1);
  const lastFrameRef = useRef(0);
  const predictedRef = useRef<{
    id: string;
    x: number;
    y: number;
    serverX: number;
    serverY: number;
  } | null>(null);

  const connect = () => {
    const playerName = normalizeUsername(name);
    if (!playerName) {
      setNameError("Enter a username to join.");
      setName("");
      return;
    }
    setName(playerName);
    setNameError("");
    if (wsRef.current) {
      wsRef.current.close();
    }
    setStatus("connecting");
    if (!audioRef.current) {
      const audio = new AudioContext();
      audioRef.current = audio;
      const masterGain = audio.createGain();
      const masterFilter = audio.createBiquadFilter();
      masterFilter.type = "lowpass";
      masterFilter.frequency.value = 20000;
      masterGain.gain.value = 0.9;
      masterGain.connect(masterFilter);
      masterFilter.connect(audio.destination);
      audioChainRef.current = { masterGain, masterFilter };
      const delay = audio.createDelay(0.6);
      delay.delayTime.value = 0.18;
      const feedback = audio.createGain();
      feedback.gain.value = 0.22;
      const filter = audio.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 1200;
      delay.connect(feedback);
      feedback.connect(filter);
      filter.connect(delay);
      const input = audio.createGain();
      const output = audio.createGain();
      input.gain.value = 0.35;
      output.gain.value = 0.45;
      input.connect(delay);
      delay.connect(output);
      if (audioChainRef.current) {
        output.connect(audioChainRef.current.masterGain);
      } else {
        output.connect(audio.destination);
      }
      reverbRef.current = { input, output, delay, feedback, filter };
    }
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === "welcome") {
        myIdRef.current = data.id;
        weaponsRef.current = data.weapons;
        if (data.map) {
          mapRef.current = data.map;
        }
        if (Array.isArray(data.walls)) {
          wallsRef.current = data.walls;
        }
        const idMap = new Map<string, Weapon>();
        const nameMap = new Map<string, Weapon>();
        for (const weapon of data.weapons as Weapon[]) {
          idMap.set(weapon.id, weapon);
          nameMap.set(weapon.name, weapon);
        }
        weaponsByIdRef.current = idMap;
        weaponsByNameRef.current = nameMap;
        stateRef.current = null;
        snapshotsRef.current = [];
        killFeedRef.current = [];
        setKillFeed([]);
        spectateRef.current = data.id;
        setSpectateId(data.id);
        ws.send(JSON.stringify({ type: "join", name: playerName, skin }));
        setStatus("ready");
        return;
      }
      if (data.type === "error" && typeof data.message === "string") {
        setNameError(data.message);
        setStatus("idle");
        return;
      }
      if (data.type === "pong" && typeof data.t === "number") {
        setPingMs(Math.max(1, Math.round(Date.now() - data.t)));
        return;
      }
      if (data.type === "state") {
        if (!data.map && mapRef.current) {
          data.map = mapRef.current;
        }
        if (!data.walls && wallsRef.current.length > 0) {
          data.walls = wallsRef.current;
        }
        stateRef.current = data;
        snapshotsRef.current.push(data);
        if (snapshotsRef.current.length > 6) {
          snapshotsRef.current.shift();
        }
        if (Array.isArray(data.chat)) {
          setChatLog(
            data.chat.map(
              (msg: { id: string; name: string; text: string; color: string }) => ({
                id: msg.id,
                name: msg.name,
                text: msg.text,
                color: msg.color,
              })
            )
          );
        }
      }
    };

    ws.onclose = () => {
      setStatus("idle");
      myIdRef.current = null;
      wsRef.current = null;
    };
  };

  const sendInputNow = () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== ws.OPEN) return;
    const center = getViewportCenter(canvasRef.current);
    inputRef.current.aimX = mouseRef.current.x - center.x;
    inputRef.current.aimY = mouseRef.current.y - center.y;
    ws.send(
      JSON.stringify({
        type: "input",
        ...inputRef.current,
      })
    );
  };

  const syncMovementInput = () => {
    inputRef.current.up = pressedKeysRef.current.has("w");
    inputRef.current.down = pressedKeysRef.current.has("s");
    inputRef.current.left = pressedKeysRef.current.has("a");
    inputRef.current.right = pressedKeysRef.current.has("d");
  };

  const clearHeldInput = () => {
    pressedKeysRef.current.clear();
    inputRef.current.up = false;
    inputRef.current.down = false;
    inputRef.current.left = false;
    inputRef.current.right = false;
    inputRef.current.shoot = false;
    inputRef.current.reload = false;
    inputRef.current.interact = false;
    inputRef.current.slot1 = false;
    inputRef.current.slot2 = false;
    inputRef.current.swap = false;
    moveStickRef.current = {
      pointerId: null,
      startX: 0,
      startY: 0,
      x: 0,
      y: 0,
      active: false,
    };
    aimStickRef.current = {
      pointerId: null,
      startX: 0,
      startY: 0,
      x: 0,
      y: 0,
      active: false,
    };
  };

  const syncMoveStickInput = () => {
    const stick = moveStickRef.current;
    const deadZone = 0.18;
    inputRef.current.left = stick.active && stick.x < -deadZone;
    inputRef.current.right = stick.active && stick.x > deadZone;
    inputRef.current.up = stick.active && stick.y < -deadZone;
    inputRef.current.down = stick.active && stick.y > deadZone;
  };

  const updateAimFromStick = (x: number, y: number) => {
    const len = Math.hypot(x, y);
    if (len < 0.12) {
      return;
    }
    const canvas = canvasRef.current;
    const center = getViewportCenter(canvas);
    const aimRadius = Math.min(center.x, center.y) * 0.7;
    mouseRef.current = {
      x: center.x + x * aimRadius,
      y: center.y + y * aimRadius,
    };
    inputRef.current.aimX = x * aimRadius;
    inputRef.current.aimY = y * aimRadius;
  };

  const triggerInstantAction = (key: "reload" | "interact" | "slot1" | "slot2" | "swap") => {
    inputRef.current[key] = true;
    sendInputNow();
    window.setTimeout(() => {
      inputRef.current[key] = false;
    }, 0);
  };

  const playShotSound = () => {
    const audio = audioRef.current;
    if (!audio) return;
    const now = audio.currentTime;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(280, now);
    osc.frequency.exponentialRampToValueAtTime(140, now + 0.08);
    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    osc.connect(gain);
    gain.connect(audio.destination);
    osc.start();
    osc.stop(now + 0.1);
  };

  const playShotSoundAt = (dx: number, dy: number, weaponId?: string) => {
    const audio = audioRef.current;
    if (!audio) return;
    const distance = Math.hypot(dx, dy);
    const maxDistance = 900;
    const volume = Math.max(0.05, 1 - distance / maxDistance);
    const now = audio.currentTime;
    const category = weaponId ? resolveWeapon(weaponId)?.category : undefined;
    const baseFreq =
      category === "sniper"
        ? 140
        : category === "rifle"
          ? 220
          : category === "smg"
            ? 300
            : category === "shotgun"
              ? 170
              : category === "mg"
                ? 180
                : 260;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    const panner = audio.createPanner();
    const noise = audio.createBufferSource();
    const noiseGain = audio.createGain();
    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    panner.refDistance = 80;
    panner.maxDistance = 1200;
    panner.rolloffFactor = 1.4;
    const click = audio.createOscillator();
    const clickGain = audio.createGain();
    const noiseBuffer = audio.createBuffer(1, audio.sampleRate * 0.08, audio.sampleRate);
    const noiseData = noiseBuffer.getChannelData(0);
    fillNoiseData(noiseData, category === "shotgun" ? 0.9 : 0.4);
    noise.buffer = noiseBuffer;
    noiseGain.gain.setValueAtTime(category === "shotgun" ? 0.12 * volume : 0.03 * volume, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
    osc.type = category === "sniper" ? "sawtooth" : "square";
    osc.frequency.setValueAtTime(baseFreq, now);
    osc.frequency.exponentialRampToValueAtTime(
      baseFreq * (category === "sniper" ? 0.42 : 0.5),
      now + (category === "sniper" ? 0.14 : 0.1)
    );
    gain.gain.setValueAtTime(category === "sniper" ? 0.22 * volume : 0.24 * volume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + (category === "sniper" ? 0.16 : 0.1));

    click.type = "square";
    click.frequency.setValueAtTime(
      category === "sniper" ? 2200 : category === "smg" ? 1700 : 1200,
      now
    );
    clickGain.gain.setValueAtTime(0.06 * volume, now);
    clickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
    panner.setPosition(dx, 0, dy);
    osc.connect(gain);
    click.connect(clickGain);
    gain.connect(panner);
    clickGain.connect(panner);
    noise.connect(noiseGain);
    noiseGain.connect(panner);
    if (reverbRef.current) {
      gain.connect(reverbRef.current.input);
    }
    if (audioChainRef.current) {
      panner.connect(audioChainRef.current.masterGain);
    } else {
      panner.connect(audio.destination);
    }
    osc.start();
    osc.stop(now + 0.1);
    click.start();
    click.stop(now + 0.05);
    noise.start();
    noise.stop(now + 0.06);

    if (distance < 420) {
      const thump = audio.createOscillator();
      const thumpGain = audio.createGain();
      const thumpFilter = audio.createBiquadFilter();
      thump.type = "sine";
      thump.frequency.setValueAtTime(category === "shotgun" ? 120 : 90, now);
      thump.frequency.exponentialRampToValueAtTime(50, now + 0.12);
      thumpGain.gain.setValueAtTime((category === "shotgun" ? 0.35 : 0.25) * volume, now);
      thumpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
      thumpFilter.type = "lowpass";
      thumpFilter.frequency.setValueAtTime(160, now);
      thump.connect(thumpFilter);
      thumpFilter.connect(thumpGain);
      thumpGain.connect(panner);
      if (reverbRef.current) {
        thumpGain.connect(reverbRef.current.input);
      }
      thump.start();
      thump.stop(now + 0.15);
    }
  };

  const playCaseSound = () => {
    const audio = audioRef.current;
    if (!audio) return;
    const now = audio.currentTime;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(520, now);
    osc.frequency.exponentialRampToValueAtTime(980, now + 0.12);
    osc.frequency.exponentialRampToValueAtTime(420, now + 0.3);
    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc.connect(gain);
    gain.connect(audio.destination);
    osc.start();
    osc.stop(now + 0.36);
  };

  const playCaseStopSound = () => {
    const audio = audioRef.current;
    if (!audio) return;
    const now = audio.currentTime;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(180, now + 0.06);
    gain.gain.setValueAtTime(0.22, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    osc.connect(gain);
    gain.connect(audio.destination);
    osc.start();
    osc.stop(now + 0.09);
  };

  const playReloadSound = (weaponId?: string) => {
    const audio = audioRef.current;
    if (!audio) return;
    const now = audio.currentTime;
    const category = weaponId ? resolveWeapon(weaponId)?.category : "pistol";
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    const click = audio.createOscillator();
    const clickGain = audio.createGain();

    const base =
      category === "sniper"
        ? 180
        : category === "rifle"
          ? 300
          : category === "smg"
            ? 420
            : category === "shotgun"
              ? 240
              : category === "mg"
                ? 260
                : 380;

    osc.type = "triangle";
    osc.frequency.setValueAtTime(base * 1.5, now);
    osc.frequency.exponentialRampToValueAtTime(base, now + 0.16);
    gain.gain.setValueAtTime(0.14, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);

    click.type = "square";
    click.frequency.setValueAtTime(category === "sniper" ? 1800 : 1400, now + 0.06);
    clickGain.gain.setValueAtTime(category === "mg" ? 0.06 : 0.08, now + 0.06);
    clickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

    osc.connect(gain);
    click.connect(clickGain);
    if (audioChainRef.current) {
      gain.connect(audioChainRef.current.masterGain);
      clickGain.connect(audioChainRef.current.masterGain);
    } else {
      gain.connect(audio.destination);
      clickGain.connect(audio.destination);
    }
    osc.start();
    osc.stop(now + 0.24);
    click.start(now + 0.06);
    click.stop(now + 0.12);
  };

  const playReadyTickSound = (weaponId?: string) => {
    const audio = audioRef.current;
    if (!audio) return;
    const weapon = weaponId ? resolveWeapon(weaponId) : undefined;
    const now = audio.currentTime;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    const overtone = audio.createOscillator();
    const overtoneGain = audio.createGain();

    osc.type = "triangle";
    overtone.type = "sine";
    osc.frequency.setValueAtTime(weapon?.id === "awp" ? 1320 : 980, now);
    osc.frequency.exponentialRampToValueAtTime(weapon?.id === "awp" ? 1700 : 1240, now + 0.05);
    overtone.frequency.setValueAtTime(weapon?.id === "awp" ? 2300 : 1680, now);
    overtone.frequency.exponentialRampToValueAtTime(
      weapon?.id === "awp" ? 2520 : 1880,
      now + 0.04
    );
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    overtoneGain.gain.setValueAtTime(0.0001, now);
    overtoneGain.gain.exponentialRampToValueAtTime(0.035, now + 0.008);
    overtoneGain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);

    osc.connect(gain);
    overtone.connect(overtoneGain);
    if (audioChainRef.current) {
      gain.connect(audioChainRef.current.masterGain);
      overtoneGain.connect(audioChainRef.current.masterGain);
    } else {
      gain.connect(audio.destination);
      overtoneGain.connect(audio.destination);
    }

    osc.start(now);
    overtone.start(now);
    osc.stop(now + 0.09);
    overtone.stop(now + 0.06);
  };

  const cancelReadyTick = () => {
    if (readyTickTimeoutRef.current !== null) {
      window.clearTimeout(readyTickTimeoutRef.current);
      readyTickTimeoutRef.current = null;
    }
  };

  const scheduleReadyTick = (weaponId?: string) => {
    cancelReadyTick();
    const weapon = weaponId ? resolveWeapon(weaponId) : undefined;
    if (!weapon || weapon.id !== "awp") return;
    readyTickTimeoutRef.current = window.setTimeout(() => {
      playReadyTickSound(weaponId);
      readyTickTimeoutRef.current = null;
    }, Math.max(120, Math.round(1000 / weapon.fireRate)));
  };

  const playRarityStinger = (rarity: string) => {
    const audio = audioRef.current;
    if (!audio) return;
    const now = audio.currentTime;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "sawtooth";
    const base =
      rarity === "legendary" ? 220 : rarity === "epic" ? 190 : rarity === "rare" ? 170 : 150;
    osc.frequency.setValueAtTime(base, now);
    osc.frequency.exponentialRampToValueAtTime(base * 2.4, now + 0.22);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(rarity === "legendary" ? 0.22 : 0.14, now + 0.06);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
    osc.connect(gain);
    if (audioChainRef.current) {
      gain.connect(audioChainRef.current.masterGain);
    } else {
      gain.connect(audio.destination);
    }
    osc.start(now);
    osc.stop(now + 0.42);
  };

  const rarityStyle = (rarity?: string) => {
    switch (rarity) {
      case "legendary":
        return {
          borderColor: "#d9a441",
          boxShadow: "0 0 18px rgba(217,164,65,0.7), 0 0 36px rgba(217,164,65,0.35)",
          color: "#6a3b00",
          backgroundColor: "rgba(217, 164, 65, 0.22)",
        };
      case "epic":
        return {
          borderColor: "#8847ff",
          boxShadow: "0 0 16px rgba(136,71,255,0.65), 0 0 32px rgba(136,71,255,0.3)",
          color: "#3f1fa3",
          backgroundColor: "rgba(136, 71, 255, 0.2)",
        };
      case "rare":
        return {
          borderColor: "#4b69ff",
          boxShadow: "0 0 14px rgba(75,105,255,0.6), 0 0 28px rgba(75,105,255,0.3)",
          color: "#1e3fa6",
          backgroundColor: "rgba(75, 105, 255, 0.18)",
        };
      case "uncommon":
        return {
          borderColor: "#4b69ff",
          boxShadow: "0 0 10px rgba(75,105,255,0.5), 0 0 18px rgba(75,105,255,0.25)",
          color: "#1e3fa6",
          backgroundColor: "rgba(75, 105, 255, 0.12)",
        };
      default:
        return {
          borderColor: "#b0b0b0",
          color: "#4b4f57",
          backgroundColor: "rgba(176, 176, 176, 0.18)",
        };
    }
  };

  const tierStyle = (category?: string) => {
    switch (category) {
      case "pistol":
        return {
          borderColor: "#bfc5ce",
          boxShadow: "0 0 10px rgba(191,197,206,0.5)",
          color: "#2f3339",
          backgroundColor: "rgba(191, 197, 206, 0.35)",
        };
      case "smg":
      case "shotgun":
        return {
          borderColor: "#4b69ff",
          boxShadow: "0 0 12px rgba(75,105,255,0.6)",
          color: "#15256a",
          backgroundColor: "rgba(75, 105, 255, 0.3)",
        };
      case "rifle":
        return {
          borderColor: "#8847ff",
          boxShadow: "0 0 14px rgba(136,71,255,0.6)",
          color: "#2f1a8f",
          backgroundColor: "rgba(136, 71, 255, 0.28)",
        };
      case "sniper":
        return {
          borderColor: "#d9a441",
          boxShadow: "0 0 16px rgba(217,164,65,0.7)",
          color: "#5a2d00",
          backgroundColor: "rgba(217, 164, 65, 0.3)",
        };
      case "mg":
        return {
          borderColor: "#eb4b4b",
          boxShadow: "0 0 16px rgba(235,75,75,0.6)",
          color: "#6a1414",
          backgroundColor: "rgba(235, 75, 75, 0.3)",
        };
      default:
        return {
          borderColor: "#c6ccd6",
          color: "#2f3339",
          backgroundColor: "rgba(198, 204, 214, 0.32)",
        };
    }
  };

  const memoizedControls = useMemo(
    () => [
      "WASD to move",
      "Mouse to aim",
      "Click to fire",
      "R to reload",
      "E to loot crates",
    ],
    []
  );

  useEffect(() => {
    const updateTouchProfile = () => {
      const viewport = window.visualViewport;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const coarse = window.matchMedia("(pointer: coarse)").matches;
      const narrow = width <= 1024;
      const shortSide = Math.min(width, height);
      const mobile = coarse && (narrow || shortSide <= 900);
      setIsMobileUi(mobile);
      setIsLandscape(width > height);
      if (mobile && shortSide <= 900 && !mobilePerfAutoRef.current) {
        mobilePerfAutoRef.current = true;
        setPerfMode(true);
      }
    };

    updateTouchProfile();
    window.addEventListener("resize", updateTouchProfile);
    window.addEventListener("orientationchange", updateTouchProfile);
    window.visualViewport?.addEventListener("resize", updateTouchProfile);

    return () => {
      window.removeEventListener("resize", updateTouchProfile);
      window.removeEventListener("orientationchange", updateTouchProfile);
      window.visualViewport?.removeEventListener("resize", updateTouchProfile);
    };
  }, []);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent, isDown: boolean) => {
      const key = event.key.toLowerCase();
      if (event.key === "Tab") {
        event.preventDefault();
        setShowScoreboard(isDown);
      }
      if (event.key === "Enter" && isDown) {
        event.preventDefault();
        setChatOpen(true);
        window.setTimeout(() => {
          chatInputRef.current?.focus();
        }, 0);
      }
      if (event.target instanceof HTMLInputElement) {
        return;
      }
      const before = { ...inputRef.current };
      if (MOVEMENT_KEYS.has(key)) {
        if (isDown) {
          pressedKeysRef.current.add(key);
        } else {
          pressedKeysRef.current.delete(key);
        }
        syncMovementInput();
      }
      switch (key) {
        case "w":
        case "s":
        case "a":
        case "d":
          break;
        case "r":
          if (isDown) inputRef.current.reload = true;
          break;
        case "e":
          if (isDown) {
            inputRef.current.interact = true;
            sendInputNow();
            inputRef.current.interact = false;
          }
          break;
        case "1":
          if (isDown) inputRef.current.slot1 = true;
          break;
        case "2":
          if (isDown) inputRef.current.slot2 = true;
          break;
        case "q":
          if (isDown) inputRef.current.swap = true;
          break;
        default:
          break;
      }
      if (
        before.up !== inputRef.current.up ||
        before.down !== inputRef.current.down ||
        before.left !== inputRef.current.left ||
        before.right !== inputRef.current.right
      ) {
        sendInputNow();
      }
    };

    const handleMouseMove = (event: MouseEvent) => {
      mouseRef.current = { x: event.clientX, y: event.clientY };
      if (inputRef.current.shoot) {
        sendInputNow();
      }
    };

    const handleMouseDown = () => {
      inputRef.current.shoot = true;
      sendInputNow();
    };

    const handleMouseUp = () => {
      inputRef.current.shoot = false;
      sendInputNow();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        clearHeldInput();
        sendInputNow();
      }
    };

    const handleWindowBlur = () => {
      clearHeldInput();
      sendInputNow();
    };

    const handleMouseLeave = () => {
      if (inputRef.current.shoot) {
        clearHeldInput();
        sendInputNow();
      }
    };

    const preventZoomKeys = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && ["+", "=", "-", "0"].includes(event.key)) {
        event.preventDefault();
      }
    };

    const preventZoomWheel = (event: WheelEvent) => {
      if (event.ctrlKey) {
        event.preventDefault();
      }
    };

    const keyDown = (event: KeyboardEvent) => handleKey(event, true);
    const keyUp = (event: KeyboardEvent) => handleKey(event, false);
    if (!isMobileUi) {
      window.addEventListener("keydown", keyDown);
      window.addEventListener("keyup", keyUp);
      window.addEventListener("keydown", preventZoomKeys);
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mousedown", handleMouseDown);
      window.addEventListener("mouseup", handleMouseUp);
      window.addEventListener("mouseleave", handleMouseLeave);
      window.addEventListener("wheel", preventZoomWheel, { passive: false });
    }
    window.addEventListener("blur", handleWindowBlur);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("keydown", preventZoomKeys);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("mouseleave", handleMouseLeave);
      window.removeEventListener("wheel", preventZoomWheel);
      window.removeEventListener("blur", handleWindowBlur);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isMobileUi, perfMode]);

  useEffect(() => {
    if (status !== "ready") return;
    const interval = window.setInterval(() => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== ws.OPEN) return;

      if (pingSentAtRef.current === 0 || Date.now() - pingSentAtRef.current > 1000) {
        pingSentAtRef.current = Date.now();
        ws.send(JSON.stringify({ type: "ping", t: pingSentAtRef.current }));
      }

      ws.send(
        JSON.stringify({
          type: "input",
          ...inputRef.current,
        })
      );

      if (inputRef.current.reload) inputRef.current.reload = false;
      if (inputRef.current.interact) inputRef.current.interact = false;
      if (inputRef.current.slot1) inputRef.current.slot1 = false;
      if (inputRef.current.slot2) inputRef.current.slot2 = false;
      if (inputRef.current.swap) inputRef.current.swap = false;
    }, 1000 / 60);

    return () => window.clearInterval(interval);
  }, [status]);

  useEffect(() => {
    if (status !== "ready") {
      clearHeldInput();
      predictedRef.current = null;
      cancelReadyTick();
    }
  }, [status]);

  const sendRespawn = () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: "respawn" }));
  };

  const resolveWeapon = (weaponId: string) =>
    weaponsByIdRef.current.get(weaponId) ??
    weaponsRef.current.find((weapon) => weapon.id === weaponId);

  const resolveWeaponName = (weaponId: string | null) => {
    if (!weaponId) return "Empty";
    return weaponsByIdRef.current.get(weaponId)?.name ?? weaponId;
  };

  const weaponIconByCategory = (category: string, className: string) => {
    if (category === "shotgun") {
      return (
        <svg viewBox="0 0 56 20" className={className} aria-hidden="true">
          <rect x="4" y="8" width="34" height="4" rx="2" fill="currentColor" />
          <rect x="26" y="6" width="12" height="8" rx="2" fill="currentColor" />
          <rect x="16" y="12" width="10" height="4" fill="currentColor" />
          <rect x="38" y="9" width="10" height="2" fill="currentColor" />
        </svg>
      );
    }
    if (category === "sniper") {
      return (
        <svg viewBox="0 0 56 20" className={className} aria-hidden="true">
          <rect x="2" y="8" width="40" height="4" rx="2" fill="currentColor" />
          <rect x="36" y="6" width="10" height="8" rx="2" fill="currentColor" />
          <rect x="46" y="9" width="8" height="2" fill="currentColor" />
          <rect x="14" y="12" width="8" height="4" fill="currentColor" />
        </svg>
      );
    }
    if (category === "rifle") {
      return (
        <svg viewBox="0 0 56 20" className={className} aria-hidden="true">
          <rect x="2" y="8" width="42" height="4" rx="2" fill="currentColor" />
          <rect x="32" y="6" width="10" height="8" rx="2" fill="currentColor" />
          <rect x="14" y="12" width="10" height="4" fill="currentColor" />
          <rect x="44" y="9" width="10" height="2" fill="currentColor" />
        </svg>
      );
    }
    if (category === "smg") {
      return (
        <svg viewBox="0 0 56 20" className={className} aria-hidden="true">
          <rect x="6" y="8" width="34" height="4" rx="2" fill="currentColor" />
          <rect x="18" y="12" width="8" height="4" fill="currentColor" />
          <rect x="34" y="6" width="8" height="8" rx="2" fill="currentColor" />
          <rect x="42" y="9" width="8" height="2" fill="currentColor" />
        </svg>
      );
    }
    if (category === "mg") {
      return (
        <svg viewBox="0 0 56 20" className={className} aria-hidden="true">
          <rect x="2" y="8" width="44" height="4" rx="2" fill="currentColor" />
          <rect x="10" y="12" width="12" height="4" fill="currentColor" />
          <rect x="36" y="6" width="10" height="8" rx="2" fill="currentColor" />
          <rect x="46" y="9" width="8" height="2" fill="currentColor" />
        </svg>
      );
    }
    return (
      <svg viewBox="0 0 56 20" className={className} aria-hidden="true">
        <rect x="8" y="8" width="24" height="4" rx="2" fill="currentColor" />
        <rect x="16" y="12" width="6" height="4" fill="currentColor" />
        <rect x="28" y="6" width="8" height="8" rx="2" fill="currentColor" />
      </svg>
    );
  };

  const weaponSpriteFor = (key: string, className?: string) => {
    const fileMap: Record<string, string> = {
      p2000: "p2000.png",
      cz75: "cz75.png",
      mp9: "mp9.png",
      mac10: "mac10.png",
      nova: "nova.png",
      ak47: "ak47.png",
      m4a1: "m4a1.png",
      awp: "awp.png",
      scar20: "scar20.png",
      negev: "negev.png",
      "P2000": "p2000.png",
      "CZ-75": "cz75.png",
      "MP9": "mp9.png",
      "MAC-10": "mac10.png",
      "Nova": "nova.png",
      "AK-47": "ak47.png",
      "M4A1": "m4a1.png",
      "AWP": "awp.png",
      "SCAR-20": "scar20.png",
      "Negev": "negev.png",
    };
    const file = fileMap[key];
    if (!file) return null;
    return (
      <span
        className={`weapon-sprite ${className ?? "h-5 w-9"}`}
        style={{ backgroundImage: `url(${WEAPON_ICON_BASE}/${file})` }}
        aria-hidden="true"
      />
    );
  };

  const weaponIconByName = (weaponName: string, className?: string) => {
    const sprite = weaponSpriteFor(weaponName, className);
    if (sprite) return sprite;
    const iconClass =
      className ?? "h-5 w-9 text-black drop-shadow-[0_1px_0_rgba(255,255,255,0.4)]";
    const key = weaponName.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (key === "p2000") {
      return (
        <svg viewBox="0 0 56 20" className={iconClass} aria-hidden="true">
          <rect x="10" y="7" width="22" height="4" rx="2" fill="currentColor" />
          <rect x="18" y="11" width="5" height="7" rx="1" fill="currentColor" />
          <rect x="28" y="8" width="10" height="3" rx="1" fill="currentColor" />
          <rect x="9" y="6" width="6" height="2" rx="1" fill="currentColor" />
        </svg>
      );
    }
    if (key === "cz75") {
      return (
        <svg viewBox="0 0 56 20" className={iconClass} aria-hidden="true">
          <rect x="8" y="7" width="24" height="4" rx="2" fill="currentColor" />
          <rect x="16" y="11" width="6" height="7" rx="1" fill="currentColor" />
          <rect x="28" y="8" width="10" height="3" rx="1" fill="currentColor" />
          <rect x="8" y="6" width="7" height="2" rx="1" fill="currentColor" />
          <rect x="22" y="6" width="6" height="2" rx="1" fill="currentColor" />
        </svg>
      );
    }
    if (key === "mp9") {
      return (
        <svg viewBox="0 0 56 20" className={iconClass} aria-hidden="true">
          <rect x="8" y="8" width="24" height="4" rx="2" fill="currentColor" />
          <rect x="16" y="12" width="6" height="6" rx="1" fill="currentColor" />
          <rect x="26" y="6" width="10" height="6" rx="2" fill="currentColor" />
          <rect x="34" y="9" width="12" height="2" rx="1" fill="currentColor" />
          <rect x="10" y="6" width="6" height="2" rx="1" fill="currentColor" />
        </svg>
      );
    }
    if (key === "mac10") {
      return (
        <svg viewBox="0 0 56 20" className={iconClass} aria-hidden="true">
          <rect x="6" y="8" width="20" height="5" rx="2" fill="currentColor" />
          <rect x="12" y="12" width="8" height="6" rx="1" fill="currentColor" />
          <rect x="24" y="7" width="6" height="6" rx="1" fill="currentColor" />
          <rect x="30" y="9" width="12" height="2" rx="1" fill="currentColor" />
          <rect x="6" y="6" width="8" height="2" rx="1" fill="currentColor" />
        </svg>
      );
    }
    if (key === "nova") {
      return (
        <svg viewBox="0 0 56 20" className={iconClass} aria-hidden="true">
          <rect x="4" y="8" width="30" height="4" rx="2" fill="currentColor" />
          <rect x="20" y="12" width="12" height="4" rx="1" fill="currentColor" />
          <rect x="32" y="9" width="14" height="2" rx="1" fill="currentColor" />
          <rect x="8" y="6" width="10" height="2" rx="1" fill="currentColor" />
          <rect x="6" y="9" width="4" height="2" rx="1" fill="currentColor" />
        </svg>
      );
    }
    if (key === "xm1014") {
      return (
        <svg viewBox="0 0 56 20" className={iconClass} aria-hidden="true">
          <rect x="2" y="7.2" width="20" height="2.1" rx="1" fill="currentColor" />
          <rect x="2.6" y="10.1" width="15.4" height="1.8" rx="0.9" fill="currentColor" />
          <rect x="17.8" y="8.1" width="0.9" height="4.8" rx="0.4" fill="currentColor" />
          <rect x="18.8" y="6.4" width="14.8" height="5.6" rx="1.4" fill="currentColor" />
          <rect x="21.8" y="5.2" width="8.8" height="1.1" rx="0.5" fill="currentColor" />
          <rect x="31.8" y="6.6" width="0.9" height="1.2" rx="0.4" fill="currentColor" />
          <path d="M33.5 8.7 H40.2 L47.2 6.9 L50.2 8.2 L48.2 9.3 L47 9.3 L47 10.8 L48.7 13.3 L46 13.3 L44.2 10.6 L40.5 10.6 L40.5 16.8 L38.2 16.8 L35.7 11.9 L33.5 11.9 Z" fill="currentColor" />
          <path d="M27.3 12 L30.6 12 L32.9 17.7 L30.6 17.7 L28.2 14.5 L28.2 17.7 L26.1 17.7 L26.1 13 Z" fill="currentColor" />
          <rect x="50.1" y="6.8" width="1.8" height="7" rx="0.4" fill="currentColor" />
          <path d="M3.4 6.2 L5.1 4.6 L5.1 6.2 Z" fill="currentColor" />
        </svg>
      );
    }
    if (key === "ak47") {
      return (
        <svg viewBox="0 0 56 20" className={iconClass} aria-hidden="true">
          <rect x="4" y="8" width="30" height="4" rx="2" fill="currentColor" />
          <rect x="18" y="12" width="10" height="6" rx="2" fill="currentColor" />
          <rect x="28" y="6" width="10" height="8" rx="2" fill="currentColor" />
          <rect x="36" y="9" width="14" height="2" rx="1" fill="currentColor" />
          <rect x="8" y="6" width="8" height="2" rx="1" fill="currentColor" />
          <path d="M18 18 C22 18, 24 15, 26 13 L26 18 Z" fill="currentColor" />
        </svg>
      );
    }
    if (key === "m4a1") {
      return (
        <svg viewBox="0 0 56 20" className={iconClass} aria-hidden="true">
          <rect x="4" y="8" width="34" height="4" rx="2" fill="currentColor" />
          <rect x="22" y="12" width="8" height="6" rx="1" fill="currentColor" />
          <rect x="28" y="6" width="10" height="8" rx="2" fill="currentColor" />
          <rect x="38" y="9" width="12" height="2" rx="1" fill="currentColor" />
          <rect x="6" y="6" width="8" height="2" rx="1" fill="currentColor" />
          <rect x="12" y="6" width="6" height="2" rx="1" fill="currentColor" />
        </svg>
      );
    }
    if (key === "awp") {
      return (
        <svg viewBox="0 0 56 20" className={iconClass} aria-hidden="true">
          <rect x="2" y="8" width="40" height="3" rx="2" fill="currentColor" />
          <rect x="16" y="5" width="14" height="4" rx="2" fill="currentColor" />
          <rect x="28" y="11" width="8" height="6" rx="1" fill="currentColor" />
          <rect x="40" y="9" width="14" height="2" rx="1" fill="currentColor" />
          <rect x="8" y="6" width="6" height="2" rx="1" fill="currentColor" />
        </svg>
      );
    }
    if (key === "scar20") {
      return (
        <svg viewBox="0 0 56 20" className={iconClass} aria-hidden="true">
          <rect x="4" y="8" width="34" height="3" rx="2" fill="currentColor" />
          <rect x="16" y="5" width="12" height="4" rx="2" fill="currentColor" />
          <rect x="26" y="11" width="8" height="6" rx="1" fill="currentColor" />
          <rect x="36" y="9" width="14" height="2" rx="1" fill="currentColor" />
          <rect x="6" y="6" width="6" height="2" rx="1" fill="currentColor" />
        </svg>
      );
    }
    if (key === "negev") {
      return (
        <svg viewBox="0 0 56 20" className={iconClass} aria-hidden="true">
          <rect x="2" y="8" width="36" height="4" rx="2" fill="currentColor" />
          <rect x="12" y="12" width="12" height="6" rx="1" fill="currentColor" />
          <rect x="30" y="6" width="10" height="8" rx="2" fill="currentColor" />
          <rect x="38" y="9" width="14" height="2" rx="1" fill="currentColor" />
          <rect x="6" y="13" width="10" height="2" rx="1" fill="currentColor" />
          <rect x="4" y="6" width="6" height="2" rx="1" fill="currentColor" />
        </svg>
      );
    }
    const category = weaponsByNameRef.current.get(weaponName)?.category ?? "pistol";
    return weaponIconByCategory(category, iconClass);
  };

  const weaponIcon = (weaponId: string, className?: string) => {
    const sprite = weaponSpriteFor(weaponId, className);
    if (sprite) return sprite;
    const weaponName = resolveWeapon(weaponId)?.name ?? weaponId;
    return weaponIconByName(weaponName, className);
  };

  useEffect(() => {
    const saved = window.localStorage.getItem("sps-perf-mode");
    if (saved) {
      setPerfMode(saved === "1");
    }
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNow(Date.now());
    }, 200);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem("sps-perf-mode", perfMode ? "1" : "0");
  }, [perfMode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      const viewport = window.visualViewport;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const dpr = perfMode
        ? Math.min(1.25, window.devicePixelRatio || 1)
        : Math.min(1.5, window.devicePixelRatio || 1);
      dprRef.current = dpr;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);

    let rafId = 0;
    const render = () => {
      const dpr = dprRef.current;
      const latestState = stateRef.current;
      let state = latestState;
      const width = canvas.width / dpr;
      const height = canvas.height / dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      ctx.clearRect(0, 0, width, height);

      if (!state) {
        ctx.fillStyle = "rgba(10, 13, 18, 0.95)";
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = "#c3d2e6";
        ctx.font = "600 20px Space Grotesk, sans-serif";
        ctx.fillText("Awaiting match state...", width * 0.4, height * 0.5);
        rafId = requestAnimationFrame(render);
        return;
      }

      const snapshots = snapshotsRef.current;
      const renderTime = Date.now() - INTERP_DELAY;
      if (snapshots.length >= 2) {
        let s1Index = snapshots.findIndex((snap) => snap.time >= renderTime);
        if (s1Index === -1) s1Index = snapshots.length - 1;
        const s1 = snapshots[s1Index];
        const s0 = snapshots[Math.max(0, s1Index - 1)];
        const span = Math.max(1, s1.time - s0.time);
        const t = Math.min(1, Math.max(0, (renderTime - s0.time) / span));

        const playerMap = new Map(s0.players.map((player) => [player.id, player]));
        const interpolatedPlayers = s1.players.map((player) => {
          const prev = playerMap.get(player.id);
          if (!prev) return player;
          return {
            ...player,
            x: lerp(prev.x, player.x, t),
            y: lerp(prev.y, player.y, t),
          };
        });

        state = {
          ...s1,
          players: interpolatedPlayers,
          safeZone: {
            ...s1.safeZone,
            x: lerp(s0.safeZone.x, s1.safeZone.x, t),
            y: lerp(s0.safeZone.y, s1.safeZone.y, t),
            radius: lerp(s0.safeZone.radius, s1.safeZone.radius, t),
          },
        };
      }

      const playersById = new Map(state.players.map((player) => [player.id, player]));
      const me = myIdRef.current ? playersById.get(myIdRef.current) : undefined;
      const latestPlayersById = latestState
        ? new Map(latestState.players.map((player) => [player.id, player]))
        : null;
      const authoritativeMe =
        (myIdRef.current ? latestPlayersById?.get(myIdRef.current) : undefined) ?? me;
      const now = performance.now();
      const lastFrame = lastFrameRef.current;
      const dt = lastFrame ? Math.min(0.05, Math.max(0.001, (now - lastFrame) / 1000)) : 1 / 60;
      lastFrameRef.current = now;
      const inputDir = getInputDirection(inputRef.current);
      let predictedMe = me;
      if (authoritativeMe && authoritativeMe.alive) {
        const sinceServerUpdate = latestState ? Math.max(0, now - latestState.time) / 1000 : 0;
        const leadTime = Math.min(0.05, sinceServerUpdate + 1 / 60);
        const inputLen = Math.hypot(inputDir.x, inputDir.y);
        if (inputLen > 0) {
          const move = moveWithCollisionsClient(
            authoritativeMe.x,
            authoritativeMe.y,
            inputDir.x * CLIENT_SPEED * leadTime,
            inputDir.y * CLIENT_SPEED * leadTime,
            mapRef.current,
            wallsRef.current
          );
          predictedMe = { ...authoritativeMe, x: move.x, y: move.y };
        } else {
          predictedMe = authoritativeMe;
        }
        predictedRef.current = {
          id: authoritativeMe.id,
          x: predictedMe.x,
          y: predictedMe.y,
          serverX: authoritativeMe.x,
          serverY: authoritativeMe.y,
        };
      } else if (predictedRef.current) {
        predictedRef.current = null;
      }
      const alivePlayers = state.players.filter((player) => player.alive);
      const playerIds = new Set(state.players.map((player) => player.id));
      const lowFx = perfMode || state.players.length > 18 || state.shots.length > 20;
      const spectateTarget =
        (spectateRef.current ? playersById.get(spectateRef.current) : undefined) ??
        (me?.alive ? me : alivePlayers[0]) ??
        me;

      if (authoritativeMe?.alive && spectateRef.current !== authoritativeMe.id) {
        spectateRef.current = authoritativeMe.id;
        setSpectateId(authoritativeMe.id);
      }
      if (!authoritativeMe?.alive && spectateTarget && spectateTarget.id !== spectateRef.current) {
        spectateRef.current = spectateTarget.id;
        setSpectateId(spectateTarget.id);
      }

      const camTarget =
        spectateTarget?.id === myIdRef.current && predictedMe ? predictedMe : spectateTarget;
      const targetX = camTarget ? camTarget.x : state.map.width / 2;
      const targetY = camTarget ? camTarget.y : state.map.height / 2;
      if (!lastFrame) {
        camRef.current.x = targetX;
        camRef.current.y = targetY;
      } else {
        const camSmooth = 1 - Math.exp(-dt * 16);
        camRef.current.x = lerp(camRef.current.x, targetX, camSmooth);
        camRef.current.y = lerp(camRef.current.y, targetY, camSmooth);
      }
      let camX = camRef.current.x;
      let camY = camRef.current.y;
      if (screenShakeRef.current > 0.1) {
        camX += (Math.random() - 0.5) * screenShakeRef.current;
        camY += (Math.random() - 0.5) * screenShakeRef.current;
        screenShakeRef.current *= 0.88;
      }

      if (audioChainRef.current && spectateTarget) {
        const dx = spectateTarget.x - state.safeZone.x;
        const dy = spectateTarget.y - state.safeZone.y;
        const outside = Math.hypot(dx, dy) > state.safeZone.radius;
        const targetFreq = outside ? 1400 : 20000;
        audioChainRef.current.masterFilter.frequency.setTargetAtTime(
          targetFreq,
          audioRef.current?.currentTime ?? 0,
          0.08
        );
      }

      const zoom = isMobileUi ? 0.22 : 1.15;
      const worldToScreen = (x: number, y: number) => ({
        x: (x - camX) * zoom + width / 2,
        y: (y - camY) * zoom + height / 2,
      });
      const onScreen = (x: number, y: number, padding = 40) =>
        x > -padding && y > -padding && x < width + padding && y < height + padding;

      const mouse = mouseRef.current;
      const targetAimX = mouse.x - width / 2;
      const targetAimY = mouse.y - height / 2;
      aimSmoothRef.current.x = lerp(aimSmoothRef.current.x, targetAimX, 0.5);
      aimSmoothRef.current.y = lerp(aimSmoothRef.current.y, targetAimY, 0.5);
      inputRef.current.aimX = aimSmoothRef.current.x;
      inputRef.current.aimY = aimSmoothRef.current.y;

      ctx.fillStyle = "#f1f4f9";
      ctx.fillRect(0, 0, width, height);

      const gridSize = 140;
      if (!gridPatternRef.current || gridPatternSizeRef.current !== gridSize) {
        const gridCanvas = document.createElement("canvas");
        gridCanvas.width = gridSize;
        gridCanvas.height = gridSize;
        const gctx = gridCanvas.getContext("2d");
        if (gctx) {
          gctx.strokeStyle = "rgba(13, 18, 32, 0.06)";
          gctx.lineWidth = 1;
          gctx.beginPath();
          gctx.moveTo(0.5, 0);
          gctx.lineTo(0.5, gridSize);
          gctx.moveTo(0, 0.5);
          gctx.lineTo(gridSize, 0.5);
          gctx.stroke();
        }
        gridPatternRef.current = ctx.createPattern(gridCanvas, "repeat");
        gridPatternSizeRef.current = gridSize;
      }
      if (gridPatternRef.current) {
        const offsetX = camX % gridSize;
        const offsetY = camY % gridSize;
        ctx.save();
        ctx.translate(-offsetX, -offsetY);
        ctx.fillStyle = gridPatternRef.current;
        ctx.fillRect(offsetX, offsetY, width + gridSize, height + gridSize);
        ctx.restore();
      }

      const zonePos = worldToScreen(state.safeZone.x, state.safeZone.y);
      if (!lowFx) {
        ctx.save();
        ctx.fillStyle = "rgba(10, 12, 18, 0.58)";
        ctx.fillRect(0, 0, width, height);
        ctx.globalCompositeOperation = "destination-out";
        ctx.beginPath();
        ctx.arc(zonePos.x, zonePos.y, state.safeZone.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = "source-over";
        ctx.fillStyle = "rgba(255, 255, 255, 0.1)";
        ctx.beginPath();
        ctx.arc(zonePos.x, zonePos.y, state.safeZone.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else {
        ctx.save();
        ctx.fillStyle = "rgba(10, 12, 18, 0.18)";
        ctx.beginPath();
        ctx.arc(zonePos.x, zonePos.y, state.safeZone.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      ctx.strokeStyle = isMobileUi ? "rgba(79, 140, 255, 0.44)" : "rgba(79, 140, 255, 0.9)";
      ctx.lineWidth = isMobileUi ? 1 : 3;
      if (!lowFx) {
        ctx.shadowColor = isMobileUi ? "rgba(108, 75, 255, 0.08)" : "rgba(108, 75, 255, 0.3)";
        ctx.shadowBlur = isMobileUi ? 2 : 10;
      }
      ctx.beginPath();
      ctx.arc(zonePos.x, zonePos.y, state.safeZone.radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;

      state.walls.forEach((wall) => {
        const topLeft = worldToScreen(wall.x, wall.y);
        if (!onScreen(topLeft.x + wall.w * zoom * 0.5, topLeft.y + wall.h * zoom * 0.5, 120)) {
          return;
        }
        if (wall.kind === "tree") {
          ctx.fillStyle = "#3a7f4c";
          ctx.beginPath();
          ctx.ellipse(
            topLeft.x + (wall.w * zoom) / 2,
            topLeft.y + (wall.h * zoom) / 2,
            (wall.w * zoom) / 2,
            (wall.h * zoom) / 2,
            0,
            0,
            Math.PI * 2
          );
          ctx.fill();
          ctx.strokeStyle = "rgba(10, 30, 16, 0.25)";
          ctx.lineWidth = 2;
          ctx.stroke();
        } else if (wall.kind === "bush") {
          ctx.fillStyle = "#3c8f58";
          ctx.beginPath();
          ctx.roundRect(topLeft.x, topLeft.y, wall.w * zoom, wall.h * zoom, 18 * zoom);
          ctx.fill();
          ctx.strokeStyle = "rgba(10, 30, 16, 0.25)";
          ctx.lineWidth = 2;
          ctx.stroke();
        } else if (wall.kind === "crate") {
          ctx.fillStyle = "#c8a06a";
          ctx.fillRect(topLeft.x, topLeft.y, wall.w * zoom, wall.h * zoom);
          ctx.strokeStyle = "rgba(90, 60, 20, 0.35)";
          ctx.lineWidth = 2;
          ctx.strokeRect(topLeft.x, topLeft.y, wall.w * zoom, wall.h * zoom);
          ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
          ctx.beginPath();
          ctx.moveTo(topLeft.x, topLeft.y);
          ctx.lineTo(topLeft.x + wall.w * zoom, topLeft.y + wall.h * zoom);
          ctx.moveTo(topLeft.x + wall.w * zoom, topLeft.y);
          ctx.lineTo(topLeft.x, topLeft.y + wall.h * zoom);
          ctx.stroke();
        } else {
          ctx.fillStyle = "#e6eaf2";
          ctx.fillRect(topLeft.x, topLeft.y, wall.w * zoom, wall.h * zoom);
          ctx.strokeStyle = "rgba(13, 18, 32, 0.2)";
          ctx.lineWidth = 2;
          ctx.strokeRect(topLeft.x, topLeft.y, wall.w * zoom, wall.h * zoom);
          ctx.fillStyle = "rgba(13, 18, 32, 0.06)";
          ctx.fillRect(
            topLeft.x + 3 * zoom,
            topLeft.y + 3 * zoom,
            wall.w * zoom - 6 * zoom,
            wall.h * zoom - 6 * zoom
          );
        }
      });

      const pulse = (Math.sin(state.time / 260) + 1) / 2;
      state.crates.forEach((crate) => {
        const pos = worldToScreen(crate.x, crate.y);
        if (!onScreen(pos.x, pos.y, 80)) return;
        const base =
          crate.tier === 2 ? "#ffb347" : crate.tier === 1 ? "#4f8cff" : "#6c4bff";
        const glow =
          crate.tier === 2
            ? "rgba(255, 179, 71, 0.65)"
            : crate.tier === 1
              ? "rgba(79, 140, 255, 0.6)"
              : "rgba(108, 75, 255, 0.55)";
        const halo = 12 + pulse * 10;
        ctx.save();
        if (!lowFx) {
          ctx.shadowColor = glow;
          ctx.shadowBlur = halo;
        }
        const size = 28 * zoom;
        const x = pos.x - size / 2;
        const y = pos.y - size / 2;
        if (!lowFx) {
          const grad = ctx.createLinearGradient(x, y, x + size, y + size);
          grad.addColorStop(0, "#ffffff");
          grad.addColorStop(0.2, base);
          grad.addColorStop(0.7, "#0b1220");
          grad.addColorStop(1, "#000000");
          ctx.fillStyle = grad;
        } else {
          ctx.fillStyle = base;
        }
        ctx.fillRect(x, y, size, size);

        if (!lowFx) {
          ctx.shadowColor = "rgba(255, 255, 255, 0.8)";
          ctx.shadowBlur = 18;
        } else {
          ctx.shadowBlur = 0;
        }
        ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
        ctx.lineWidth = 2;
        ctx.strokeRect(x - 2 * zoom, y - 2 * zoom, size + 4 * zoom, size + 4 * zoom);

        ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x - 7 * zoom, y - 7 * zoom, size + 14 * zoom, size + 14 * zoom);

        ctx.fillStyle = "rgba(255, 255, 255, 0.65)";
        ctx.fillRect(x + 4 * zoom, y + 4 * zoom, size * 0.35, size * 0.12);
        ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
        ctx.fillRect(x + 4 * zoom, y + 8 * zoom, size * 0.22, size * 0.08);
        ctx.strokeStyle = "rgba(0, 0, 0, 0.18)";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x + size * 0.2, y + size * 0.2);
        ctx.lineTo(x + size * 0.8, y + size * 0.8);
        ctx.moveTo(x + size * 0.8, y + size * 0.2);
        ctx.lineTo(x + size * 0.2, y + size * 0.8);
        ctx.stroke();
        if (!lowFx) {
          const ringRadius = size * 0.9 + pulse * 6;
          ctx.save();
          ctx.translate(pos.x, pos.y);
          ctx.rotate(state.time / 900);
          ctx.strokeStyle = glow;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([6, 10]);
          ctx.beginPath();
          ctx.arc(0, 0, ringRadius, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();

          ctx.save();
          ctx.translate(pos.x, pos.y);
          ctx.rotate(-state.time / 700);
          ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
          ctx.beginPath();
          if (crate.tier === 2) {
            for (let i = 0; i < 5; i += 1) {
              const angle = (Math.PI * 2 * i) / 5 - Math.PI / 2;
              const inner = size * 0.12;
              const outer = size * 0.22;
              const x1 = Math.cos(angle) * outer;
              const y1 = Math.sin(angle) * outer;
              const x2 = Math.cos(angle + Math.PI / 5) * inner;
              const y2 = Math.sin(angle + Math.PI / 5) * inner;
              if (i === 0) {
                ctx.moveTo(x1, y1);
              } else {
                ctx.lineTo(x1, y1);
              }
              ctx.lineTo(x2, y2);
            }
            ctx.closePath();
          } else if (crate.tier === 1) {
            ctx.moveTo(0, -size * 0.18);
            ctx.lineTo(size * 0.18, 0);
            ctx.lineTo(0, size * 0.18);
            ctx.lineTo(-size * 0.18, 0);
            ctx.closePath();
          } else {
            ctx.moveTo(0, -size * 0.18);
            ctx.lineTo(size * 0.16, size * 0.12);
            ctx.lineTo(-size * 0.16, size * 0.12);
            ctx.closePath();
          }
          ctx.fill();
          ctx.restore();
        }
        ctx.restore();
      });

      state.shots.forEach((shot) => {
        const start = worldToScreen(shot.x1, shot.y1);
        const end = worldToScreen(shot.x2, shot.y2);
        if (!onScreen(start.x, start.y, 120) && !onScreen(end.x, end.y, 120)) return;
        const category = resolveWeapon(shot.weaponId)?.category ?? "pistol";
        const isSniper = category === "sniper";
        ctx.save();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
        ctx.lineWidth = isSniper ? 2 : 3;
        ctx.lineCap = isSniper ? "butt" : "round";
        if (!lowFx) {
          ctx.shadowColor = isSniper ? "rgba(255, 255, 255, 0.35)" : "rgba(255, 255, 255, 0.7)";
          ctx.shadowBlur = isSniper ? 2 : 8;
        } else {
          ctx.shadowBlur = 0;
        }
        if (!isSniper) {
          ctx.setLineDash([8, 10]);
        }
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
        ctx.restore();
      });

      state.players.forEach((player) => {
        const targetPlayer =
          player.id === myIdRef.current && predictedMe ? predictedMe : player;
        const smooth =
          player.id === myIdRef.current
            ? { x: targetPlayer.x, y: targetPlayer.y }
            : (() => {
                const existing = renderPosRef.current.get(player.id);
                return existing
                  ? {
                      x: lerp(existing.x, targetPlayer.x, Math.min(1, dt * 12)),
                      y: lerp(existing.y, targetPlayer.y, Math.min(1, dt * 12)),
                    }
                  : { x: targetPlayer.x, y: targetPlayer.y };
              })();
        renderPosRef.current.set(player.id, smooth);
        const renderPlayer = { ...targetPlayer, x: smooth.x, y: smooth.y };
        const pos = worldToScreen(renderPlayer.x, renderPlayer.y);
        if (!onScreen(pos.x, pos.y, 80)) return;
        ctx.save();
        if (!lowFx) {
          ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
          ctx.shadowBlur = 8;
        }
        ctx.fillStyle = renderPlayer.alive ? renderPlayer.color : "rgba(110, 110, 110, 0.6)";
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 14 * zoom, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        ctx.strokeStyle = "rgba(0, 0, 0, 0.5)";
        ctx.lineWidth = 3;
        ctx.stroke();

        ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        const hasArmor = renderPlayer.armor > 0;
        const hpBarY = hasArmor ? pos.y - 25 * zoom : pos.y - 28 * zoom;
        if (hasArmor) {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(pos.x - 18 * zoom, pos.y - 32 * zoom, 36 * zoom, 5 * zoom);
          ctx.fillStyle = "#6c4bff";
          ctx.fillRect(
            pos.x - 18 * zoom,
            pos.y - 32 * zoom,
            36 * zoom * (renderPlayer.armor / 100),
            5 * zoom
          );
        }
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(pos.x - 18 * zoom, hpBarY, 36 * zoom, 6 * zoom);
        ctx.fillStyle = renderPlayer.hp > 0 ? "#2f7dff" : "#ff4d5a";
        ctx.fillRect(
          pos.x - 18 * zoom,
          hpBarY,
          36 * zoom * (renderPlayer.hp / 100),
          6 * zoom
        );

        ctx.font = "600 12px Space Grotesk, sans-serif";
        ctx.textAlign = "center";
        ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
        ctx.lineWidth = 3;
        ctx.strokeText(renderPlayer.name, pos.x, pos.y - (hasArmor ? 42 : 38) * zoom);
        ctx.fillStyle = "#0b1220";
        ctx.fillText(renderPlayer.name, pos.x, pos.y - (hasArmor ? 42 : 38) * zoom);
      });

      const nowMs = Date.now();
      if (hitFlash > nowMs) {
        ctx.fillStyle = "rgba(255, 68, 76, 0.18)";
        ctx.fillRect(0, 0, width, height);
      }
      if (hitMarker > nowMs) {
        ctx.save();
        ctx.strokeStyle = "rgba(0, 0, 0, 0.65)";
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(width / 2 - 12, height / 2);
        ctx.lineTo(width / 2 - 4, height / 2);
        ctx.moveTo(width / 2 + 12, height / 2);
        ctx.lineTo(width / 2 + 4, height / 2);
        ctx.moveTo(width / 2, height / 2 - 12);
        ctx.lineTo(width / 2, height / 2 - 4);
        ctx.moveTo(width / 2, height / 2 + 12);
        ctx.lineTo(width / 2, height / 2 + 4);
        ctx.stroke();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
      }

      const showDesktopMinimap = !isMobileUi && width >= 1100 && height >= 700;
      if (showDesktopMinimap) {
        const minimapSize = 160;
        const miniX = 24;
        const miniY = Math.max(24, height - minimapSize - 240);
        ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
        ctx.fillRect(miniX, miniY, minimapSize, minimapSize);
        ctx.strokeStyle = "rgba(20, 24, 32, 0.2)";
        ctx.strokeRect(miniX, miniY, minimapSize, minimapSize);

        const mapScaleX = minimapSize / state.map.width;
        const mapScaleY = minimapSize / state.map.height;
        const safeMiniX = miniX + state.safeZone.x * mapScaleX;
        const safeMiniY = miniY + state.safeZone.y * mapScaleY;
        const safeMiniR = state.safeZone.radius * mapScaleX;
        ctx.strokeStyle = "rgba(79, 140, 255, 0.95)";
        ctx.beginPath();
        ctx.arc(safeMiniX, safeMiniY, safeMiniR, 0, Math.PI * 2);
        ctx.stroke();
      }

      if (spectateTarget) {
        const weaponName = resolveWeaponName(spectateTarget.activeWeaponId);
        const primaryName = resolveWeaponName(spectateTarget.primaryWeaponId);
        const secondaryName = resolveWeaponName(spectateTarget.secondaryWeaponId);
        const nextHud = {
          hp: Math.round(spectateTarget.hp),
          armor: Math.round(spectateTarget.armor),
          ammo: spectateTarget.ammo,
          reserve: spectateTarget.reserve,
          weapon: weaponName,
          kills: spectateTarget.kills,
          aliveCount: state.aliveCount,
          primary: primaryName,
          secondary: secondaryName,
          activeSlot: spectateTarget.activeSlot,
          reloading: spectateTarget.reloading,
        };
        const prev = hudRef.current;
        if (
          prev.hp !== nextHud.hp ||
          prev.armor !== nextHud.armor ||
          prev.ammo !== nextHud.ammo ||
          prev.reserve !== nextHud.reserve ||
          prev.weapon !== nextHud.weapon ||
          prev.kills !== nextHud.kills ||
          prev.aliveCount !== nextHud.aliveCount ||
          prev.primary !== nextHud.primary ||
          prev.secondary !== nextHud.secondary ||
          prev.activeSlot !== nextHud.activeSlot ||
          prev.reloading !== nextHud.reloading
        ) {
          hudRef.current = nextHud;
          setHud(nextHud);
          if (prev.ammo !== nextHud.ammo) {
            ammoPulseRef.current = Date.now();
            setAmmoPulse(true);
            window.setTimeout(() => setAmmoPulse(false), 180);
            if (
              spectateTarget.id === myIdRef.current &&
              spectateTarget.activeWeaponId === "awp" &&
              nextHud.ammo < prev.ammo
            ) {
              scheduleReadyTick(spectateTarget.activeWeaponId);
            }
          }
          if (prev.ammo > 0 && nextHud.ammo === 0 && nextHud.reserve > 0) {
            lastReloadAtRef.current = Date.now();
            cancelReadyTick();
            playReloadSound(spectateTarget.activeWeaponId);
          }
          if (!prev.reloading && nextHud.reloading) {
            lastReloadAtRef.current = Date.now();
            cancelReadyTick();
            playReloadSound(spectateTarget.activeWeaponId);
          }
          if (prev.reloading && !nextHud.reloading) {
            cancelReadyTick();
          }
        }
      }

      const nextFeed = state.killFeed ?? [];
      const prevFeed = killFeedRef.current;
      const changed =
        prevFeed.length !== nextFeed.length ||
        prevFeed.some((item, index) => item.id !== nextFeed[index]?.id);
      if (changed) {
        killFeedRef.current = nextFeed;
        setKillFeed(nextFeed);
      }

      if (me) {
        if (me.lastHitAt > lastHitAtRef.current) {
          lastHitAtRef.current = me.lastHitAt;
          setHitFlash(Date.now() + 160);
          screenShakeRef.current = 6;
        }
        if (me.lastHitConfirmAt > lastHitConfirmRef.current) {
          lastHitConfirmRef.current = me.lastHitConfirmAt;
          setHitMarker(Date.now() + 120);
        }
      }

      if (state.safeZone.lastShrunkAt > lastShrinkAtRef.current) {
        lastShrinkAtRef.current = state.safeZone.lastShrunkAt;
        setZoneBanner(Date.now() + 1800);
      }

      if (state.killFeed?.[0] && state.killFeed[0].id !== lastKillIdRef.current) {
        lastKillIdRef.current = state.killFeed[0].id;
        if (me && state.killFeed[0].killer === me.name) {
          setKillBanner({ text: `Eliminated ${state.killFeed[0].victim}`, at: Date.now() });
          window.setTimeout(() => setKillBanner(null), 1400);
        }
      }

      if (me && me.lastLootAt && me.lastLootAt !== lastLootAtRef.current) {
        lastLootAtRef.current = me.lastLootAt;
        const weaponPool = weaponsRef.current.filter((weapon) => weapon.id !== me.lastLootWeaponId);
        const finalWeaponObj =
          weaponsRef.current.find((weapon) => weapon.id === me.lastLootWeaponId) ?? null;
        const finalWeapon = finalWeaponObj?.name ?? me.lastLootWeaponId;
        const finalRarity = finalWeaponObj?.rarity ?? "common";
        const items: string[] = [];
        const shuffled = weaponPool
          .slice()
          .sort(() => Math.random() - 0.5)
          .map((weapon) => weapon.name);
        for (let i = 0; i < Math.min(8, shuffled.length); i += 1) {
          items.push(shuffled[i]);
        }
        items.push(finalWeapon);
        const id = `${me.lastLootAt}-${me.lastLootWeaponId}`;
        setLootRoll({ id, items, final: finalWeapon, rarity: finalRarity });
        setLootOffset(0);
        setLootFinale(false);
        playCaseSound();
        window.requestAnimationFrame(() => {
          const windowEl = rollWindowRef.current;
          const finalEl = finalItemRef.current;
          if (!windowEl || !finalEl) {
            return;
          }
          const windowWidth = windowEl.getBoundingClientRect().width;
          const finalRect = finalEl.getBoundingClientRect();
          const windowRect = windowEl.getBoundingClientRect();
          const finalCenter = finalRect.left - windowRect.left + finalRect.width / 2;
          const offset = finalCenter - windowWidth / 2;
          setLootOffset(offset);
        });
        window.setTimeout(() => {
          playCaseStopSound();
        }, 1200);
        window.setTimeout(() => {
          setLootFinale(true);
          setLootBurst(Date.now());
          playRarityStinger(finalRarity);
        }, 1320);
        window.setTimeout(() => {
          setLootRoll((current) => (current?.id === id ? null : current));
          setLootFinale(false);
        }, 1700);
      }

      if (state.match?.results?.id !== matchResultsRef.current?.id) {
        matchResultsRef.current = state.match?.results ?? null;
        setMatchResults(state.match?.results ?? null);
      }

      const recentShots = recentShotsRef.current;
      const unseen = state.shots.filter((shot) => !recentShots.has(shot.id));
      if (unseen.length > 0) {
        unseen.forEach((shot) => recentShots.add(shot.id));
        if (nowMs - lastShotSoundAtRef.current > 90) {
          const listener =
            (spectateRef.current ? playersById.get(spectateRef.current) : undefined) ??
            me ??
            state.players[0];
          if (listener) {
            let best = unseen[0];
            let bestDist = Infinity;
            for (const shot of unseen) {
              const dx = shot.x1 - listener.x;
              const dy = shot.y1 - listener.y;
              const dist = Math.hypot(dx, dy);
              if (dist < bestDist) {
                bestDist = dist;
                best = shot;
              }
            }
            playShotSoundAt(best.x1 - listener.x, best.y1 - listener.y, best.weaponId);
          } else {
            playShotSound();
          }
          lastShotSoundAtRef.current = nowMs;
        }
      }
      if (recentShots.size > 120) {
        recentShotsRef.current = new Set(state.shots.map((shot) => shot.id));
      }

      renderPosRef.current.forEach((_, key) => {
        if (!playerIds.has(key)) {
          renderPosRef.current.delete(key);
        }
      });

      rafId = requestAnimationFrame(render);
    };

    render();
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
    };
  }, []);

  const handleSpectate = (direction: -1 | 1) => {
    const state = stateRef.current;
    if (!state) return;
    const alive = state.players.filter((player) => player.alive);
    if (alive.length === 0) return;
    const currentIndex = alive.findIndex((player) => player.id === spectateRef.current);
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + direction + alive.length) % alive.length;
    spectateRef.current = alive[nextIndex].id;
    setSpectateId(alive[nextIndex].id);
  };

  const sendChat = () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== ws.OPEN) return;
    const text = chatText.trim();
    if (!text) return;
    ws.send(JSON.stringify({ type: "chat", text }));
    setChatText("");
  };

  const resultsVisible = matchResults && matchResults.placements.length > 0;
  const matchOverAt = stateRef.current?.match?.overAt ?? 0;
  const matchEnded = matchOverAt > 0 && now >= matchOverAt;
  const timeToNextMatch = matchOverAt > now ? Math.max(0, Math.ceil((matchOverAt - now) / 1000)) : 0;
  const moveStick = moveStickRef.current;
  const aimStick = aimStickRef.current;
  const mobileControlsVisible = isMobileUi && status === "ready";
  const showRotateHint = mobileControlsVisible && !isLandscape;
  const controlHints = isMobileUi
    ? ["Left stick to move", "Right stick to aim and fire", "Tap loot, reload, or swap"]
    : memoizedControls;

  return (
    <div className="fixed inset-0 h-screen w-screen overflow-hidden">
      <canvas ref={canvasRef} className="h-screen w-screen touch-none" />

      <div className="pointer-events-none absolute left-0 top-0 flex h-full w-full flex-col justify-between">
        <div className="flex flex-col gap-3 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] md:px-6 md:pt-6 lg:flex-row lg:items-start lg:justify-between">
          {!isMobileUi && (
          <div
            className={`hud-panel ui-slide-in rounded-2xl backdrop-blur ${
              isMobileUi
                ? "max-w-[min(100%,12.75rem)] px-3 py-2"
                : "max-w-[min(100%,26rem)] px-4 py-3 md:px-5 md:py-4"
            }`}
          >
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="hud-title text-xs uppercase tracking-[0.35em] text-black/60">
                  Dustline
                </p>
                <p className="text-base font-semibold text-black md:text-lg">
                  {isMobileUi ? "Mobile Ops" : "Tactical Battle Royale"}
                </p>
                {!isMobileUi && (
                  <p className="mt-1 text-[10px] uppercase tracking-[0.35em] text-black/50">
                    Live Drop Zone
                  </p>
                )}
              </div>
              <div className="flex flex-col items-end gap-2">
                <span className="ui-chip">
                  Ping {status === "ready" ? `${pingMs} ms` : "--"}
                </span>
                {!isMobileUi && <span className="ui-chip">Server {hostLabel(WS_URL)}</span>}
              </div>
            </div>
            {!isMobileUi ? (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.25em] text-black/50">
                <span>Performance</span>
                <button
                  className="ui-button pointer-events-auto px-3 py-1 text-[10px]"
                  onClick={() => setPerfMode((current) => !current)}
                >
                  {perfMode ? "On" : "Off"}
                </button>
              </div>
            ) : (
              <div className="mt-2 flex items-center gap-2">
                <button
                  className="ui-button pointer-events-auto px-3 py-1 text-[10px]"
                  onClick={() => setPerfMode((current) => !current)}
                >
                  Perf {perfMode ? "On" : "Off"}
                </button>
                <button
                  className="ui-button pointer-events-auto px-3 py-1 text-[10px]"
                  onClick={() => setMobileChatOpen((current) => !current)}
                >
                  Chat
                </button>
              </div>
            )}
          </div>
          )}
          {!isMobileUi && (
            <div className="flex w-full max-w-72 flex-col gap-2 self-end text-right">
            {killFeed.map((event) => (
              <div
                key={event.id}
                className="ui-slide-in flex items-center justify-end gap-2 rounded-full border border-black/10 bg-white/90 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-black shadow"
              >
                <span className="max-w-[120px] truncate">{event.killer}</span>
                <span className="rounded-full bg-white/80 px-2 py-1 ring-1 ring-black/10">
                  {weaponIcon(event.weaponId)}
                </span>
                <span className="max-w-[120px] truncate text-black/70">
                  {event.victim}
                </span>
              </div>
            ))}
            </div>
          )}
        </div>

        {!isMobileUi && (
        <div className="flex flex-col gap-3 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-6 md:pb-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="hud-card ui-slide-in max-w-[min(100%,18rem)] text-black/80">
            <p className="hud-label">Loadout</p>
            <div className="mt-1 flex items-center gap-2">
              <span className="rounded-full bg-white/80 p-1 ring-1 ring-black/10">
                {weaponIconByName(
                  hud.weapon,
                  "h-6 w-12 text-black drop-shadow-[0_1px_0_rgba(255,255,255,0.4)]"
                )}
              </span>
              <p className="hud-value">{hud.weapon}</p>
            </div>
            <p className={`text-sm text-black/70 ${ammoPulse ? "ammo-pop" : ""}`}>
              {hud.ammo} / {hud.reserve} ammo
            </p>
            <div className="mt-2 flex gap-3 text-xs text-black/60">
              <span className={hud.activeSlot === 0 ? "font-semibold text-black" : ""}>
                1: {hud.primary}
              </span>
              <span className={hud.activeSlot === 1 ? "font-semibold text-black" : ""}>
                2: {hud.secondary}
              </span>
            </div>
          </div>

          <div className="flex gap-2 self-end md:gap-3">
            <div className="hud-card ui-slide-in text-black/80">
              <p className="hud-label">HP</p>
              <p className="hud-value">{hud.hp}</p>
              <p className="text-xs text-black/50">Armor {hud.armor}</p>
            </div>
            <div className="hud-card ui-slide-in text-black/80">
              <p className="hud-label">Kills</p>
              <p className="hud-value">{hud.kills}</p>
            </div>
            <div className="hud-card ui-slide-in text-black/80">
              <p className="hud-label">Alive</p>
              <p className="hud-value">{hud.aliveCount}</p>
            </div>
          </div>
        </div>
        )}
      </div>

      <div
        className={`pointer-events-none absolute w-[min(22rem,calc(100%-1.5rem))] md:left-6 md:w-[22rem] ${
          isMobileUi
            ? mobileChatOpen
              ? "left-3 top-[calc(env(safe-area-inset-top)+4.8rem)]"
              : "hidden"
            : "left-4 top-48"
        }`}
      >
        <div className="chat-panel ui-slide-in rounded-[24px] px-4 py-3 text-black shadow-[0_18px_42px_rgba(11,14,24,0.14)]">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <p className="chat-panel-label">Squad Comms</p>
              <p className="text-[11px] uppercase tracking-[0.22em] text-black/50">
                Match chat
              </p>
            </div>
            {!chatOpen && !isMobileUi && (
              <p className="text-[10px] uppercase tracking-[0.25em] text-emerald-700/85">
                Press Enter
              </p>
            )}
          </div>
          <div className={`space-y-1.5 overflow-hidden text-sm ${isMobileUi ? "max-h-20" : "max-h-44"}`}>
            {chatLog.slice(-6).map((msg) => (
              <p key={msg.id}>
                <span className="font-semibold" style={{ color: msg.color }}>
                  {msg.name}:
                </span>{" "}
                <span className="text-black">{msg.text}</span>
              </p>
            ))}
          </div>
          {chatOpen && (
            <div className="pointer-events-auto mt-3">
              <input
                ref={chatInputRef}
                value={chatText}
                onChange={(event) => setChatText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    sendChat();
                    setChatOpen(false);
                  }
                }}
                className="w-full rounded-2xl border border-emerald-600/30 bg-white/72 px-3 py-2 text-sm text-black placeholder:text-black/40 focus:border-emerald-600/60 focus:outline-none"
                placeholder="Type message…"
              />
            </div>
          )}
          {isMobileUi && !chatOpen && (
            <div className="pointer-events-auto mt-3">
              <button
                className="ui-button w-full justify-center rounded-2xl py-2 text-[11px]"
                onClick={() => {
                  setChatOpen(true);
                  window.setTimeout(() => {
                    chatInputRef.current?.focus();
                  }, 0);
                }}
              >
                Open Chat
              </button>
            </div>
          )}
        </div>
      </div>

      {lootRoll && (
        <div className="pointer-events-none absolute left-1/2 top-24 -translate-x-1/2">
          <div
            className={`loot-panel loot-panel-${lootRoll.rarity} ${lootFinale ? "loot-panel-finale" : ""}`}
          >
            <div className="loot-aura" />
            <div className="loot-orbit" />
            <div className="loot-sparkles" />
            {lootBurst > 0 && (
              <div
                className="loot-burst"
                key={lootBurst}
                style={{ animationDuration: lootFinale ? "0.6s" : "0.4s" }}
              />
            )}
            <div className="loot-panel-header">
              <span>Supply Drop</span>
              <span className="rarity-tag" style={rarityStyle(lootRoll.rarity)}>
                {lootRoll.rarity}
              </span>
            </div>
            <div className="loot-panel-title">Weapon Acquired</div>
            <div className="loot-roll">
              <div className="loot-roll-window" ref={rollWindowRef}>
                <div
                  className={`loot-roll-track ${lootFinale ? "loot-roll-freeze" : ""}`}
                  ref={rollTrackRef}
                  style={{ transform: `translateX(-${lootOffset}px)` }}
                >
                  {lootRoll.items.map((item, index) => {
                    const weapon = weaponsByNameRef.current.get(item);
                    const itemStyle = weapon ? tierStyle(weapon.category) : rarityStyle("common");
                    const isFinal =
                      item === lootRoll.final && index === lootRoll.items.length - 1;
                    return (
                      <span
                        key={`${lootRoll.id}-${index}`}
                        className={`loot-roll-item ${
                          isFinal
                            ? "loot-roll-final"
                            : ""
                        }`}
                        ref={
                          isFinal
                            ? finalItemRef
                            : null
                        }
                        style={itemStyle}
                      >
                        <span className="loot-roll-icon">
                          {weaponIconByName(
                            item,
                            "h-6 w-12 text-black drop-shadow-[0_1px_0_rgba(255,255,255,0.35)]"
                          )}
                        </span>
                        <span className="loot-roll-label">{item}</span>
                      </span>
                    );
                  })}
                </div>
                <div className="loot-roll-marker" />
              </div>
            </div>
          </div>
        </div>
      )}

      {zoneBanner > now && (
        <div className="pointer-events-none absolute inset-x-0 top-24 flex justify-center">
          <div className="ui-chip ui-slide-in rounded-full border border-black/10 bg-white/90 px-5 py-2 text-xs font-semibold uppercase tracking-[0.3em] text-black shadow-lg">
            Safe Zone Shrinking
          </div>
        </div>
      )}

      {killBanner && killBanner.at + 1400 > now && (
        <div className="pointer-events-none absolute inset-x-0 top-36 flex justify-center">
          <div className="ui-button ui-button-primary ui-slide-in rounded-full px-6 py-2 text-sm font-semibold text-white shadow-lg">
            {killBanner.text}
          </div>
        </div>
      )}

      {stateRef.current && (
        <div className="pointer-events-none absolute inset-x-0 top-24 flex justify-center">
          {!stateRef.current.players.find((p) => p.id === myIdRef.current)?.alive && (
            <div className="ui-panel-soft ui-slide-in pointer-events-auto flex flex-wrap items-center justify-center gap-3 rounded-[28px] px-5 py-3 text-sm text-black backdrop-blur">
              <span className="text-xs uppercase tracking-[0.3em] text-black/50">Spectating</span>
              <button className="ui-button" onClick={() => handleSpectate(-1)}>
                ← Prev
              </button>
              <span className="max-w-[140px] truncate text-sm font-semibold text-black">
                {stateRef.current.players.find((p) => p.id === spectateId)?.name ?? "Player"}
              </span>
              <button className="ui-button" onClick={() => handleSpectate(1)}>
                Next →
              </button>
              <button className="ui-button ui-button-primary" onClick={sendRespawn}>
                Find New Game
              </button>
            </div>
          )}
        </div>
      )}

      {resultsVisible && (
        <div className="pointer-events-auto absolute inset-0 flex items-center justify-center bg-white/80">
          <div className="ui-panel-soft ui-slide-in w-full max-w-lg rounded-3xl px-8 py-8 text-black shadow-2xl">
            <p className="text-xs uppercase tracking-[0.35em] text-black/40">Match Results</p>
            <h2 className="hud-title mt-2 text-3xl font-semibold">
              Winner: {matchResults.placements[0]?.name ?? "Unknown"}
            </h2>
            <p className="mt-1 text-sm text-black/60">
              {matchEnded ? "Match ended. Start a new game when ready." : `Next match in ${timeToNextMatch}s`}
            </p>
            <div className="mt-6 space-y-2">
              {matchResults.placements.map((entry, index) => (
                <div
                  key={`${matchResults.id}-${entry.name}-${index}`}
                  className={`flex items-center justify-between rounded-2xl border border-black/10 px-4 py-2 ${
                    index === 0 ? "bg-[#eef2f7]" : "bg-white"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span className="text-xs uppercase tracking-[0.2em] text-black/50">
                      #{index + 1}
                    </span>
                    <span className="font-semibold">{entry.name}</span>
                  </div>
                  <span className="text-sm text-black/70">{entry.kills} K</span>
                </div>
              ))}
            </div>
            <div className="mt-6 flex justify-between gap-3">
              <button
                className="ui-button flex-1 rounded-xl text-xs"
                onClick={() => setMatchResults(null)}
              >
                Watch Spectate
              </button>
              <button
                className="ui-button ui-button-primary flex-1 rounded-xl text-xs"
                onClick={sendRespawn}
              >
                Find New Game
              </button>
            </div>
          </div>
        </div>
      )}

      {showScoreboard && stateRef.current && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/30">
          <div className="ui-panel-soft ui-slide-in pointer-events-auto w-full max-w-2xl rounded-3xl px-8 py-6 text-black shadow-2xl">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.35em] text-black/40">Scoreboard</p>
                <h3 className="mt-2 text-2xl font-semibold">Live Rankings</h3>
              </div>
              <span className="ui-chip">Ping {pingMs} ms</span>
            </div>
            <div className="mt-5 overflow-x-auto rounded-2xl border border-black/10">
              <div className="grid min-w-[640px] grid-cols-[56px_1fr_120px_120px] bg-[#f4f6fb] px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.3em] text-black/50">
                <span>Rank</span>
                <span>Player</span>
                <span>Kills</span>
                <span>Status</span>
              </div>
              <div className="divide-y divide-black/5">
                {stateRef.current.players
                  .slice()
                  .sort((a, b) => b.kills - a.kills)
                  .map((player, index) => (
                    <div
                      key={player.id}
                      className={`grid min-w-[640px] grid-cols-[56px_1fr_120px_120px] items-center px-4 py-3 text-sm ${
                        player.alive ? "bg-white" : "bg-[#f7f8fb] text-black/60"
                      }`}
                    >
                      <span className="text-xs uppercase tracking-[0.2em] text-black/50">
                        #{index + 1}
                      </span>
                      <div className="flex items-center gap-3">
                        <span
                          className={`h-2 w-2 rounded-full ${
                            player.alive ? "bg-green-500" : "bg-red-400"
                          }`}
                        />
                        <span className="font-semibold">{player.name}</span>
                      </div>
                      <span className="text-sm text-black/70">{player.kills} K</span>
                      <span className="text-xs uppercase tracking-[0.2em] text-black/50">
                        {player.alive ? "Alive" : "Dead"}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {showRotateHint && (
        <div className="pointer-events-none absolute inset-x-0 top-[calc(env(safe-area-inset-top)+1rem)] flex justify-center px-4">
          <div className="ui-panel-soft ui-slide-in rounded-[24px] px-5 py-3 text-center text-sm text-black shadow-xl">
            Rotate your phone to landscape for the smoothest controls.
          </div>
        </div>
      )}

      {mobileControlsVisible && !mobileChatOpen && (
        <div className="pointer-events-none absolute right-[max(0.5rem,env(safe-area-inset-right))] top-[max(0.5rem,env(safe-area-inset-top))]">
          <button
            className="ui-button pointer-events-auto px-3 py-1 text-[10px]"
            onClick={() => setMobileChatOpen(true)}
          >
            Chat
          </button>
        </div>
      )}

      {mobileControlsVisible && (
        <>
          <div className="pointer-events-none absolute inset-x-0 bottom-[max(3rem,calc(env(safe-area-inset-bottom)+2.25rem))] flex items-end justify-between px-[max(0.85rem,env(safe-area-inset-left))] pr-[max(0.85rem,env(safe-area-inset-right))]">
            <div className="pointer-events-auto flex items-end gap-2">
              <div
                className={`mobile-stick-shell ${moveStick.active ? "mobile-stick-shell-active" : ""}`}
                onPointerDown={(event) => {
                  if (!isMobileUi) return;
                  event.preventDefault();
                  setTouchControlsReady(true);
                  const next = moveStickRef.current;
                  next.pointerId = event.pointerId;
                  next.startX = event.clientX;
                  next.startY = event.clientY;
                  next.x = 0;
                  next.y = 0;
                  next.active = true;
                  syncMoveStickInput();
                  sendInputNow();
                  (event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  const stick = moveStickRef.current;
                  if (stick.pointerId !== event.pointerId) return;
                  event.preventDefault();
                  const normalized = normalizeStick(
                    event.clientX - stick.startX,
                    event.clientY - stick.startY,
                    40
                  );
                  stick.x = normalized.x / 40;
                  stick.y = normalized.y / 40;
                  syncMoveStickInput();
                }}
                onPointerUp={(event) => {
                  const stick = moveStickRef.current;
                  if (stick.pointerId !== event.pointerId) return;
                  event.preventDefault();
                  moveStickRef.current = {
                    pointerId: null,
                    startX: 0,
                    startY: 0,
                    x: 0,
                    y: 0,
                    active: false,
                  };
                  syncMoveStickInput();
                  sendInputNow();
                }}
                onPointerCancel={(event) => {
                  const stick = moveStickRef.current;
                  if (stick.pointerId !== event.pointerId) return;
                  moveStickRef.current = {
                    pointerId: null,
                    startX: 0,
                    startY: 0,
                    x: 0,
                    y: 0,
                    active: false,
                  };
                  syncMoveStickInput();
                }}
              >
                <div className="mobile-stick-ring" />
                <div
                  className="mobile-stick-thumb"
                  style={{
                    transform: `translate(${moveStick.x * 40}px, ${moveStick.y * 40}px)`,
                  }}
                />
              </div>
            </div>

            <div className="pointer-events-auto flex items-end gap-2">
              <div className="flex flex-col gap-1.5">
                <button
                  className="mobile-action-button"
                  onPointerDown={(event) => {
                    event.preventDefault();
                    triggerInstantAction("interact");
                  }}
                >
                  Loot
                </button>
                <button
                  className="mobile-action-button"
                  onPointerDown={(event) => {
                    event.preventDefault();
                    triggerInstantAction("reload");
                  }}
                >
                  Reload
                </button>
              </div>
              <div className="flex flex-col gap-1.5">
                <button
                  className="mobile-action-button"
                  onPointerDown={(event) => {
                    event.preventDefault();
                    triggerInstantAction("swap");
                  }}
                >
                  Swap
                </button>
                <button
                  className="mobile-action-button"
                  onPointerDown={(event) => {
                    event.preventDefault();
                    triggerInstantAction(hud.activeSlot === 0 ? "slot2" : "slot1");
                  }}
                >
                  Weapon
                </button>
              </div>
              <div
                className={`mobile-stick-shell mobile-stick-shell-aim ${aimStick.active ? "mobile-stick-shell-active" : ""}`}
                onPointerDown={(event) => {
                  if (!isMobileUi) return;
                  event.preventDefault();
                  setTouchControlsReady(true);
                  const next = aimStickRef.current;
                  next.pointerId = event.pointerId;
                  next.startX = event.clientX;
                  next.startY = event.clientY;
                  next.x = 0;
                  next.y = 0;
                  next.active = true;
                  inputRef.current.shoot = true;
                  sendInputNow();
                  (event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  const stick = aimStickRef.current;
                  if (stick.pointerId !== event.pointerId) return;
                  event.preventDefault();
                  const normalized = normalizeStick(
                    event.clientX - stick.startX,
                    event.clientY - stick.startY,
                    40
                  );
                  stick.x = normalized.x / 40;
                  stick.y = normalized.y / 40;
                  inputRef.current.shoot = normalized.distance > 0.16;
                  updateAimFromStick(stick.x, stick.y);
                }}
                onPointerUp={(event) => {
                  const stick = aimStickRef.current;
                  if (stick.pointerId !== event.pointerId) return;
                  event.preventDefault();
                  aimStickRef.current = {
                    pointerId: null,
                    startX: 0,
                    startY: 0,
                    x: 0,
                    y: 0,
                    active: false,
                  };
                  inputRef.current.shoot = false;
                  sendInputNow();
                }}
                onPointerCancel={(event) => {
                  const stick = aimStickRef.current;
                  if (stick.pointerId !== event.pointerId) return;
                  aimStickRef.current = {
                    pointerId: null,
                    startX: 0,
                    startY: 0,
                    x: 0,
                    y: 0,
                    active: false,
                  };
                  inputRef.current.shoot = false;
                }}
              >
                <div className="mobile-stick-ring" />
                <div
                  className="mobile-stick-thumb mobile-stick-thumb-aim"
                  style={{
                    transform: `translate(${aimStick.x * 40}px, ${aimStick.y * 40}px)`,
                  }}
                />
              </div>
            </div>
          </div>

          {mobileChatOpen && (
            <div className="pointer-events-none absolute right-[max(0.5rem,env(safe-area-inset-right))] top-[max(0.5rem,env(safe-area-inset-top))]">
              <button
                className="ui-button pointer-events-auto px-3 py-1 text-[10px]"
                onClick={() => setMobileChatOpen(false)}
              >
                Close Chat
              </button>
            </div>
          )}
        </>
      )}

      {status !== "ready" && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/70">
          <form
            className="w-full max-w-md rounded-3xl border border-black/10 bg-white px-8 py-10 text-black shadow-2xl"
            onSubmit={(event) => {
              event.preventDefault();
              connect();
            }}
          >
            <p className="text-xs uppercase tracking-[0.35em] text-black/40">
              Dustline
            </p>
            <h1 className="mt-3 text-3xl font-semibold">Drop Into The Line</h1>
            <p className="mt-2 text-sm text-black/60">
              Fast top-down firefights, clean sightlines, and one shrinking safe
              zone. Loot fast, rotate harder, and survive the final circle.
            </p>
            <div className="mt-6 flex flex-col gap-3">
              <label className="text-xs uppercase tracking-[0.3em] text-black/50">
                Username
              </label>
              <input
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  if (nameError) setNameError("");
                }}
                className={`w-full rounded-xl border bg-white px-4 py-3 text-black placeholder:text-black/40 focus:outline-none ${
                  nameError
                    ? "border-red-400 focus:border-red-500"
                    : "border-black/10 focus:border-black/40"
                }`}
                placeholder="Username"
                maxLength={USERNAME_MAX_LENGTH}
                required
                aria-invalid={nameError ? "true" : "false"}
                aria-describedby={nameError ? "username-error" : undefined}
                autoFocus
              />
              {nameError && (
                <p id="username-error" className="text-sm font-semibold text-red-600">
                  {nameError}
                </p>
              )}
            </div>
            <div className="mt-5">
              <p className="text-xs uppercase tracking-[0.3em] text-black/50">
                Player Skin
              </p>
              <div className="mt-3 flex flex-wrap gap-3">
                {skins.map((tone) => (
                  <button
                    type="button"
                    key={tone}
                    onClick={() => setSkin(tone)}
                    className={`h-10 w-10 rounded-full border-2 transition ${
                      skin === tone ? "border-black" : "border-black/20"
                    }`}
                    style={{ backgroundColor: tone }}
                    aria-label={`Skin ${tone}`}
                  />
                ))}
              </div>
            </div>
            <button
              type="submit"
              disabled={status === "connecting"}
              className="ui-button ui-button-primary mt-6 w-full rounded-xl py-3 text-sm"
            >
              {status === "connecting" ? "Connecting..." : "Enter Match"}
            </button>
            <div className="ui-panel-soft mt-6 rounded-2xl px-4 py-3">
              <p className="text-xs uppercase tracking-[0.3em] text-black/50">Controls</p>
              <ul className="mt-2 space-y-1 text-sm text-black/70">
                {controlHints.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
