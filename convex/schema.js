import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // One race room. A season is a list of affirmation texts raced in order.
  rooms: defineTable({
    code: v.string(),
    hostKey: v.string(),
    status: v.union(
      v.literal("lobby"),
      v.literal("racing"),
      v.literal("between"),
      v.literal("finished")
    ),
    category: v.string(),
    // 1–24 races, or 0 for "All" affirmations in the category.
    seasonSetting: v.number(),
    texts: v.array(v.string()),
    raceIndex: v.number(),
    // Server time (ms) when the current race's countdown ends.
    startAt: v.number(),
    // Server time (ms) when the current race ends even if not everyone finished.
    deadline: v.number(),
    createdAt: v.number(),
  }).index("by_code", ["code"]),

  players: defineTable({
    roomId: v.id("rooms"),
    playerKey: v.string(),
    name: v.string(),
    points: v.number(),
    progress: v.number(),
    wpm: v.number(),
    place: v.union(v.number(), v.null()),
    raceWpm: v.union(v.number(), v.null()),
    raceAccuracy: v.union(v.number(), v.null()),
    // A player who joins mid-race sits that race out and starts with the next one.
    activeFromRace: v.number(),
    lastSeen: v.number(),
    joinedAt: v.number(),
    left: v.boolean(),
  })
    .index("by_room", ["roomId"])
    .index("by_room_player", ["roomId", "playerKey"]),

  // One row per player per race, for standings and the final podium.
  results: defineTable({
    roomId: v.id("rooms"),
    raceIndex: v.number(),
    playerId: v.id("players"),
    name: v.string(),
    place: v.union(v.number(), v.null()),
    points: v.number(),
    wpm: v.number(),
    accuracy: v.union(v.number(), v.null()),
    timeMs: v.union(v.number(), v.null()),
  }).index("by_room", ["roomId"]),
});
