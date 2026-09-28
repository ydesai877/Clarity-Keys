import { convexTest } from "convex-test";
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.js");
const TEXTS = ["I trust myself.", "Clarity comes from action.", "I am safe in my body."];

async function setup(t) {
  const host = await t.mutation(api.race.createRoom, { playerKey: "k-host", name: "Dev", category: "All", seasonSetting: 3 });
  const guest = await t.mutation(api.race.joinRoom, { code: host.code, playerKey: "k-guest", name: "Yash" });
  return { host, guest };
}

describe("race rooms", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("create and join; player keys are not exposed", async () => {
    const t = convexTest(schema, modules);
    const { host, guest } = await setup(t);
    expect(host.code).toMatch(/^[A-Z2-9]{4}$/);
    const state = await t.query(api.race.getRoom, { code: host.code.toLowerCase() });
    expect(state.players.map((p) => p.name)).toEqual(["Dev", "Yash"]);
    expect(state.room.hostPlayerId).toBe(host.playerId);
    expect(JSON.stringify(state)).not.toContain("k-host");
    expect(guest.roomId).toBe(host.roomId);
  });

  test("join with a bad code fails with a clear message", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.race.joinRoom, { code: "ZZZZ", playerKey: "x", name: "A" })).rejects.toThrow(/No room/);
  });

  test("only the host can start; places and points are awarded; season finishes", async () => {
    const t = convexTest(schema, modules);
    const { host } = await setup(t);
    await expect(t.mutation(api.race.startSeason, { roomId: host.roomId, playerKey: "k-guest", texts: TEXTS })).rejects.toThrow(/host/);
    await t.mutation(api.race.startSeason, { roomId: host.roomId, playerKey: "k-host", texts: TEXTS });

    for (let race = 0; race < 3; race++) {
      vi.advanceTimersByTime(3500 + 5000);
      // Guest wins races 0 and 2, host wins race 1.
      const first = race === 1 ? "k-host" : "k-guest";
      const second = race === 1 ? "k-guest" : "k-host";
      const r1 = await t.mutation(api.race.finishRace, { roomId: host.roomId, playerKey: first, raceIndex: race, wpm: 40, accuracy: 98 });
      expect(r1.place).toBe(1);
      const r2 = await t.mutation(api.race.finishRace, { roomId: host.roomId, playerKey: second, raceIndex: race, wpm: 30, accuracy: 95 });
      expect(r2.place).toBe(2);
      const s = await t.query(api.race.getRoom, { code: host.code });
      expect(s.room.status).toBe(race < 2 ? "between" : "finished");
      if (race < 2) await t.mutation(api.race.nextRace, { roomId: host.roomId, playerKey: "k-host" });
    }
    const end = await t.query(api.race.getRoom, { code: host.code });
    const pts = Object.fromEntries(end.players.map((p) => [p.name, p.points]));
    expect(pts).toEqual({ Yash: 3 + 2 + 3, Dev: 2 + 3 + 2 });
    expect(end.results).toHaveLength(6);
  });

  test("an impossible WPM is replaced by the server-measured WPM", async () => {
    const t = convexTest(schema, modules);
    const { host } = await setup(t);
    await t.mutation(api.race.startSeason, { roomId: host.roomId, playerKey: "k-host", texts: ["x".repeat(100)] });
    vi.advanceTimersByTime(3500 + 60000); // 100 chars in 60 s = 20 WPM
    const r = await t.mutation(api.race.finishRace, { roomId: host.roomId, playerKey: "k-host", raceIndex: 0, wpm: 250, accuracy: 100 });
    expect(r.wpm).toBe(20);
  });

  test("the race times out at its deadline and non-finishers get a DNF", async () => {
    const t = convexTest(schema, modules);
    const { host } = await setup(t);
    await t.mutation(api.race.startSeason, { roomId: host.roomId, playerKey: "k-host", texts: TEXTS });
    vi.advanceTimersByTime(4000);
    await t.mutation(api.race.finishRace, { roomId: host.roomId, playerKey: "k-host", raceIndex: 0, wpm: 40, accuracy: 100 });
    vi.advanceTimersByTime(40000);
    await t.finishInProgressScheduledFunctions();
    const s = await t.query(api.race.getRoom, { code: host.code });
    expect(s.room.status).toBe("between");
    const dnf = s.results.find((r) => r.name === "Yash");
    expect(dnf.place).toBeNull();
    expect(dnf.points).toBe(0);
  });

  test("a disconnected racer does not block the race", async () => {
    const t = convexTest(schema, modules);
    const { host } = await setup(t);
    await t.mutation(api.race.startSeason, { roomId: host.roomId, playerKey: "k-host", texts: TEXTS });
    vi.advanceTimersByTime(25000); // guest has sent nothing for 25 s
    await t.mutation(api.race.finishRace, { roomId: host.roomId, playerKey: "k-host", raceIndex: 0, wpm: 40, accuracy: 100 });
    const s = await t.query(api.race.getRoom, { code: host.code });
    expect(s.room.status).toBe("between");
  });

  test("a mid-race joiner sits out that race and races the next", async () => {
    const t = convexTest(schema, modules);
    const { host } = await setup(t);
    await t.mutation(api.race.startSeason, { roomId: host.roomId, playerKey: "k-host", texts: TEXTS });
    const late = await t.mutation(api.race.joinRoom, { code: host.code, playerKey: "k-late", name: "Late" });
    await expect(t.mutation(api.race.finishRace, { roomId: host.roomId, playerKey: "k-late", raceIndex: 0, wpm: 40, accuracy: 100 })).rejects.toThrow(/next race/);
    vi.advanceTimersByTime(5000);
    await t.mutation(api.race.finishRace, { roomId: host.roomId, playerKey: "k-host", raceIndex: 0, wpm: 40, accuracy: 100 });
    await t.mutation(api.race.finishRace, { roomId: host.roomId, playerKey: "k-guest", raceIndex: 0, wpm: 30, accuracy: 100 });
    let s = await t.query(api.race.getRoom, { code: host.code });
    expect(s.room.status).toBe("between");
    await t.mutation(api.race.nextRace, { roomId: host.roomId, playerKey: "k-host" });
    s = await t.query(api.race.getRoom, { code: host.code });
    expect(s.players.find((p) => p._id === late.playerId).activeFromRace).toBe(1);
  });

  test("when the host leaves, the next player becomes host", async () => {
    const t = convexTest(schema, modules);
    const { host, guest } = await setup(t);
    await t.mutation(api.race.leaveRoom, { roomId: host.roomId, playerKey: "k-host" });
    const s = await t.query(api.race.getRoom, { code: host.code });
    expect(s.room.hostPlayerId).toBe(guest.playerId);
    expect(s.players.map((p) => p.name)).toEqual(["Yash"]);
  });

  test("rejoining keeps your points", async () => {
    const t = convexTest(schema, modules);
    const { host } = await setup(t);
    await t.mutation(api.race.startSeason, { roomId: host.roomId, playerKey: "k-host", texts: TEXTS });
    vi.advanceTimersByTime(5000);
    await t.mutation(api.race.finishRace, { roomId: host.roomId, playerKey: "k-guest", raceIndex: 0, wpm: 40, accuracy: 100 });
    await t.mutation(api.race.joinRoom, { code: host.code, playerKey: "k-guest", name: "Yash" });
    const s = await t.query(api.race.getRoom, { code: host.code });
    expect(s.players.find((p) => p.name === "Yash").points).toBe(3);
  });

  test("settings validation", async () => {
    const t = convexTest(schema, modules);
    const { host } = await setup(t);
    await expect(t.mutation(api.race.updateSettings, { roomId: host.roomId, playerKey: "k-host", category: "All", seasonSetting: 30 })).rejects.toThrow(/1–24/);
    await t.mutation(api.race.updateSettings, { roomId: host.roomId, playerKey: "k-host", category: "Core Beliefs", seasonSetting: 0 });
    const s = await t.query(api.race.getRoom, { code: host.code });
    expect(s.room.seasonSetting).toBe(0);
    expect(s.room.category).toBe("Core Beliefs");
  });
});
