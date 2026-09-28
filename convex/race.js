import { v, ConvexError } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

// Points for 1st, 2nd and 3rd place. Everyone else gets 0.
const POINTS = [3, 2, 1];
const COUNTDOWN_MS = 3500;
// A player with no heartbeat for this long counts as disconnected.
const STALE_MS = 20000;
// Time limit per race: at least 30 s, or 0.6 s per character (about 20 WPM).
const MIN_RACE_MS = 30000;
const MS_PER_CHAR = 600;
const MAX_TEXTS = 500;
const MAX_TEXT_LENGTH = 2000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function cleanName(name) {
  const trimmed = String(name || "").trim().slice(0, 20);
  if (!trimmed) throw new ConvexError("Enter a name first.");
  return trimmed;
}

function cleanSeasonSetting(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 0 || n > 24) throw new ConvexError("Season length must be 1–24, or All.");
  return n;
}

function randomCode() {
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

async function roomByCode(ctx, code) {
  const rooms = await ctx.db
    .query("rooms")
    .withIndex("by_code", (q) => q.eq("code", String(code || "").toUpperCase()))
    .collect();
  if (rooms.length === 0) return null;
  // Codes can be reused over time; the newest room wins.
  return rooms.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
}

async function playerFor(ctx, roomId, playerKey) {
  return ctx.db
    .query("players")
    .withIndex("by_room_player", (q) => q.eq("roomId", roomId).eq("playerKey", playerKey))
    .unique();
}

async function roomPlayers(ctx, roomId) {
  return ctx.db
    .query("players")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
    .collect();
}

async function requireRoom(ctx, roomId) {
  const room = await ctx.db.get(roomId);
  if (!room) throw new ConvexError("That room no longer exists.");
  return room;
}

async function requirePlayer(ctx, roomId, playerKey) {
  const player = await playerFor(ctx, roomId, playerKey);
  if (!player || player.left) throw new ConvexError("You are not in this room.");
  return player;
}

function requireHost(room, playerKey) {
  if (room.hostKey !== playerKey) throw new ConvexError("Only the host can do that.");
}

// Players who must finish (or time out) before the current race ends.
function racersFor(room, players, now) {
  return players.filter(
    (p) => !p.left && p.activeFromRace <= room.raceIndex && now - p.lastSeen < STALE_MS
  );
}

async function beginRace(ctx, room, raceIndex) {
  const now = Date.now();
  const text = room.texts[raceIndex];
  const startAt = now + COUNTDOWN_MS;
  const deadline = startAt + Math.max(MIN_RACE_MS, text.length * MS_PER_CHAR);
  await ctx.db.patch(room._id, { status: "racing", raceIndex, startAt, deadline });

  const players = await roomPlayers(ctx, room._id);
  for (const p of players) {
    await ctx.db.patch(p._id, {
      progress: 0,
      wpm: 0,
      place: null,
      raceWpm: null,
      raceAccuracy: null,
    });
  }
  await ctx.scheduler.runAt(deadline, internal.race.timeoutRace, {
    roomId: room._id,
    raceIndex,
    startAt,
  });
}

async function endRace(ctx, room) {
  if (room.status !== "racing") return;
  const players = await roomPlayers(ctx, room._id);
  // Anyone who was racing but did not finish gets a DNF with 0 points.
  for (const p of players) {
    if (p.left || p.activeFromRace > room.raceIndex || p.place !== null) continue;
    await ctx.db.insert("results", {
      roomId: room._id,
      raceIndex: room.raceIndex,
      playerId: p._id,
      name: p.name,
      place: null,
      points: 0,
      wpm: p.wpm,
      accuracy: null,
      timeMs: null,
    });
  }
  const last = room.raceIndex + 1 >= room.texts.length;
  await ctx.db.patch(room._id, { status: last ? "finished" : "between" });
}

async function endRaceIfEveryoneFinished(ctx, roomId) {
  const room = await ctx.db.get(roomId);
  if (!room || room.status !== "racing") return;
  const players = await roomPlayers(ctx, roomId);
  const racers = racersFor(room, players, Date.now());
  if (racers.length > 0 && racers.every((p) => p.place !== null)) {
    await endRace(ctx, room);
  }
}

// If the host has left or gone quiet, the earliest-joined connected player takes over.
async function fixHost(ctx, room, players, now) {
  const host = players.find((p) => p.playerKey === room.hostKey);
  if (host && !host.left && now - host.lastSeen < STALE_MS) return;
  const candidates = players
    .filter((p) => !p.left && now - p.lastSeen < STALE_MS)
    .sort((a, b) => a.joinedAt - b.joinedAt);
  if (candidates.length > 0 && candidates[0].playerKey !== room.hostKey) {
    await ctx.db.patch(room._id, { hostKey: candidates[0].playerKey });
  }
}

// ---------- Queries ----------

export const getRoom = query({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const room = await roomByCode(ctx, code);
    if (!room) return null;
    const players = await roomPlayers(ctx, room._id);
    const results = await ctx.db
      .query("results")
      .withIndex("by_room", (q) => q.eq("roomId", room._id))
      .collect();
    const host = players.find((p) => p.playerKey === room.hostKey);
    return {
      room: {
        _id: room._id,
        code: room.code,
        status: room.status,
        category: room.category,
        seasonSetting: room.seasonSetting,
        texts: room.texts,
        raceIndex: room.raceIndex,
        startAt: room.startAt,
        deadline: room.deadline,
        hostPlayerId: host ? host._id : null,
      },
      // Player keys are private: they are never sent to other players.
      players: players
        .filter((p) => !p.left)
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map((p) => ({
          _id: p._id,
          name: p.name,
          points: p.points,
          progress: p.progress,
          wpm: p.wpm,
          place: p.place,
          raceWpm: p.raceWpm,
          raceAccuracy: p.raceAccuracy,
          activeFromRace: p.activeFromRace,
          lastSeen: p.lastSeen,
        })),
      results: results.map((r) => ({
        raceIndex: r.raceIndex,
        playerId: r.playerId,
        name: r.name,
        place: r.place,
        points: r.points,
        wpm: r.wpm,
        accuracy: r.accuracy,
        timeMs: r.timeMs,
      })),
    };
  },
});

// ---------- Mutations ----------

// Returns the server clock, so each browser can line up its countdown.
export const serverTime = mutation({
  args: {},
  handler: async () => Date.now(),
});

export const createRoom = mutation({
  args: {
    playerKey: v.string(),
    name: v.string(),
    category: v.string(),
    seasonSetting: v.number(),
  },
  handler: async (ctx, args) => {
    const name = cleanName(args.name);
    const seasonSetting = cleanSeasonSetting(args.seasonSetting);
    const now = Date.now();

    let code = randomCode();
    for (let i = 0; i < 10; i++) {
      const existing = await roomByCode(ctx, code);
      // Reuse a code only if its room has been idle for a day.
      if (!existing || now - existing.createdAt > 24 * 60 * 60 * 1000) break;
      code = randomCode();
    }

    const roomId = await ctx.db.insert("rooms", {
      code,
      hostKey: args.playerKey,
      status: "lobby",
      category: String(args.category || "All").slice(0, 80),
      seasonSetting,
      texts: [],
      raceIndex: 0,
      startAt: 0,
      deadline: 0,
      createdAt: now,
    });
    const playerId = await ctx.db.insert("players", {
      roomId,
      playerKey: args.playerKey,
      name,
      points: 0,
      progress: 0,
      wpm: 0,
      place: null,
      raceWpm: null,
      raceAccuracy: null,
      activeFromRace: 0,
      lastSeen: now,
      joinedAt: now,
      left: false,
    });
    return { code, roomId, playerId };
  },
});

export const joinRoom = mutation({
  args: { code: v.string(), playerKey: v.string(), name: v.string() },
  handler: async (ctx, args) => {
    const name = cleanName(args.name);
    const room = await roomByCode(ctx, args.code);
    if (!room) throw new ConvexError("No room with that code. Check the code and try again.");
    const now = Date.now();
    const activeFromRace = room.status === "racing" ? room.raceIndex + 1 : room.raceIndex;

    const existing = await playerFor(ctx, room._id, args.playerKey);
    if (existing) {
      // Rejoining (for example after a page refresh) keeps your points.
      await ctx.db.patch(existing._id, {
        name,
        lastSeen: now,
        left: false,
        activeFromRace: existing.left ? activeFromRace : existing.activeFromRace,
      });
      return { code: room.code, roomId: room._id, playerId: existing._id };
    }

    const playerId = await ctx.db.insert("players", {
      roomId: room._id,
      playerKey: args.playerKey,
      name,
      points: 0,
      progress: 0,
      wpm: 0,
      place: null,
      raceWpm: null,
      raceAccuracy: null,
      activeFromRace,
      lastSeen: now,
      joinedAt: now,
      left: false,
    });
    return { code: room.code, roomId: room._id, playerId };
  },
});

export const heartbeat = mutation({
  args: { roomId: v.id("rooms"), playerKey: v.string() },
  handler: async (ctx, { roomId, playerKey }) => {
    const room = await requireRoom(ctx, roomId);
    const player = await requirePlayer(ctx, roomId, playerKey);
    const now = Date.now();
    await ctx.db.patch(player._id, { lastSeen: now });
    const players = await roomPlayers(ctx, roomId);
    await fixHost(ctx, room, players, now);
    // A racer who dropped off should not hold up everyone else.
    await endRaceIfEveryoneFinished(ctx, roomId);
  },
});

export const updateSettings = mutation({
  args: {
    roomId: v.id("rooms"),
    playerKey: v.string(),
    category: v.string(),
    seasonSetting: v.number(),
  },
  handler: async (ctx, args) => {
    const room = await requireRoom(ctx, args.roomId);
    requireHost(room, args.playerKey);
    if (room.status !== "lobby" && room.status !== "finished") {
      throw new ConvexError("Settings can only change between seasons.");
    }
    await ctx.db.patch(room._id, {
      category: String(args.category || "All").slice(0, 80),
      seasonSetting: cleanSeasonSetting(args.seasonSetting),
    });
  },
});

export const startSeason = mutation({
  args: { roomId: v.id("rooms"), playerKey: v.string(), texts: v.array(v.string()) },
  handler: async (ctx, args) => {
    const room = await requireRoom(ctx, args.roomId);
    requireHost(room, args.playerKey);
    if (room.status !== "lobby" && room.status !== "finished") {
      throw new ConvexError("A season is already running.");
    }
    const texts = args.texts.map((t) => String(t)).filter((t) => t.length > 0);
    if (texts.length === 0) throw new ConvexError("No affirmations to race.");
    if (texts.length > MAX_TEXTS) throw new ConvexError("Too many affirmations for one season.");
    if (texts.some((t) => t.length > MAX_TEXT_LENGTH)) throw new ConvexError("An affirmation is too long.");

    // New season: clear old results and points. Everyone in the room races.
    const oldResults = await ctx.db
      .query("results")
      .withIndex("by_room", (q) => q.eq("roomId", room._id))
      .collect();
    for (const r of oldResults) await ctx.db.delete(r._id);
    const players = await roomPlayers(ctx, room._id);
    for (const p of players) {
      await ctx.db.patch(p._id, { points: 0, activeFromRace: 0 });
    }

    await ctx.db.patch(room._id, { texts });
    await beginRace(ctx, { ...room, texts }, 0);
  },
});

export const reportProgress = mutation({
  args: {
    roomId: v.id("rooms"),
    playerKey: v.string(),
    progress: v.number(),
    wpm: v.number(),
  },
  handler: async (ctx, args) => {
    const room = await requireRoom(ctx, args.roomId);
    if (room.status !== "racing") return;
    const player = await requirePlayer(ctx, args.roomId, args.playerKey);
    if (player.place !== null || player.activeFromRace > room.raceIndex) return;
    const now = Date.now();
    await ctx.db.patch(player._id, {
      progress: Math.min(1, Math.max(0, args.progress)),
      wpm: Math.min(300, Math.max(0, Math.round(args.wpm))),
      lastSeen: now,
    });
  },
});

export const finishRace = mutation({
  args: {
    roomId: v.id("rooms"),
    playerKey: v.string(),
    raceIndex: v.number(),
    wpm: v.number(),
    accuracy: v.number(),
  },
  handler: async (ctx, args) => {
    const room = await requireRoom(ctx, args.roomId);
    if (room.status !== "racing" || room.raceIndex !== args.raceIndex) {
      throw new ConvexError("This race is already over.");
    }
    const player = await requirePlayer(ctx, args.roomId, args.playerKey);
    if (player.activeFromRace > room.raceIndex) throw new ConvexError("You join from the next race.");
    if (player.place !== null) return { place: player.place, points: 0 };

    const now = Date.now();
    const elapsedMs = Math.max(1, now - room.startAt);
    // The server clock is the referee. A WPM more than 25% above what the
    // server-measured time allows is replaced with the server's figure.
    const textLength = room.texts[room.raceIndex].length;
    const serverWpm = textLength / 5 / (elapsedMs / 60000);
    let wpm = Math.max(0, Math.round(args.wpm));
    if (wpm > serverWpm * 1.25) wpm = Math.round(serverWpm);
    const accuracy = Math.min(100, Math.max(0, Math.round(args.accuracy)));

    const players = await roomPlayers(ctx, room._id);
    const place = players.filter((p) => p.place !== null).length + 1;
    const points = POINTS[place - 1] || 0;

    await ctx.db.patch(player._id, {
      place,
      progress: 1,
      wpm,
      raceWpm: wpm,
      raceAccuracy: accuracy,
      points: player.points + points,
      lastSeen: now,
    });
    await ctx.db.insert("results", {
      roomId: room._id,
      raceIndex: room.raceIndex,
      playerId: player._id,
      name: player.name,
      place,
      points,
      wpm,
      accuracy,
      timeMs: elapsedMs,
    });
    await endRaceIfEveryoneFinished(ctx, room._id);
    return { place, points, wpm };
  },
});

export const hostEndRace = mutation({
  args: { roomId: v.id("rooms"), playerKey: v.string() },
  handler: async (ctx, args) => {
    const room = await requireRoom(ctx, args.roomId);
    requireHost(room, args.playerKey);
    await endRace(ctx, room);
  },
});

export const nextRace = mutation({
  args: { roomId: v.id("rooms"), playerKey: v.string() },
  handler: async (ctx, args) => {
    const room = await requireRoom(ctx, args.roomId);
    requireHost(room, args.playerKey);
    if (room.status !== "between") throw new ConvexError("There is no next race right now.");
    const players = await roomPlayers(ctx, room._id);
    // Players who joined mid-race race from now on.
    for (const p of players) {
      if (p.activeFromRace > room.raceIndex + 1) await ctx.db.patch(p._id, { activeFromRace: room.raceIndex + 1 });
    }
    await beginRace(ctx, room, room.raceIndex + 1);
  },
});

export const backToLobby = mutation({
  args: { roomId: v.id("rooms"), playerKey: v.string() },
  handler: async (ctx, args) => {
    const room = await requireRoom(ctx, args.roomId);
    requireHost(room, args.playerKey);
    if (room.status !== "finished") throw new ConvexError("Finish the season first.");
    await ctx.db.patch(room._id, { status: "lobby", raceIndex: 0 });
  },
});

export const leaveRoom = mutation({
  args: { roomId: v.id("rooms"), playerKey: v.string() },
  handler: async (ctx, args) => {
    const room = await ctx.db.get(args.roomId);
    if (!room) return;
    const player = await playerFor(ctx, args.roomId, args.playerKey);
    if (!player) return;
    await ctx.db.patch(player._id, { left: true });
    const players = await roomPlayers(ctx, room._id);
    await fixHost(ctx, room, players.map((p) => (p._id === player._id ? { ...p, left: true } : p)), Date.now());
    await endRaceIfEveryoneFinished(ctx, room._id);
  },
});

// Runs at the race deadline. Ends the race if it is still the same race.
export const timeoutRace = internalMutation({
  args: { roomId: v.id("rooms"), raceIndex: v.number(), startAt: v.number() },
  handler: async (ctx, args) => {
    const room = await ctx.db.get(args.roomId);
    if (!room || room.status !== "racing") return;
    if (room.raceIndex !== args.raceIndex || room.startAt !== args.startAt) return;
    await endRace(ctx, room);
  },
});
