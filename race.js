// Live race mode: rooms, a synced countdown, live progress bars, and
// season standings. The server side lives in convex/race.js.
(function () {
  "use strict";

  const KEY_STORE = "clarity-keys-player-v1";
  const NAME_STORE = "clarity-keys-name-v1";
  const ROOM_STORE = "clarity-keys-room-v1";
  const SLIDER_ALL = 25; // the slider's last stop means "All"
  const PROGRESS_INTERVAL_MS = 250; // at most 4 progress updates per second
  const HEARTBEAT_MS = 5000;
  const STALE_MS = 20000;

  const $ = (id) => document.getElementById(id);
  const el = {
    tabs: $("mode-tabs"),
    panel: $("race-panel"),
    setupNeeded: $("race-setup-needed"),
    join: $("race-join"),
    name: $("race-name"),
    create: $("race-create"),
    codeInput: $("race-code-input"),
    joinBtn: $("race-join-btn"),
    room: $("race-room"),
    code: $("race-code"),
    copyLink: $("race-copy-link"),
    status: $("race-status"),
    settings: $("race-settings"),
    category: $("race-category"),
    count: $("race-count"),
    countLabel: $("race-count-label"),
    settingsReadonly: $("race-settings-readonly"),
    players: $("race-players"),
    standings: $("race-standings"),
    start: $("race-start"),
    next: $("race-next"),
    end: $("race-end"),
    leave: $("race-leave"),
    error: $("race-error"),
  };

  const app = window.ClarityApp;
  const convexUrl = String(window.CLARITY_CONVEX_URL || "").trim();
  const configured = /^https?:\/\//.test(convexUrl) && !!window.convex;
  const client = configured ? new window.convex.ConvexClient(convexUrl) : null;
  const api = configured ? window.convex.anyApi : null;

  let mode = "solo";
  const me = { key: loadPlayerKey(), roomId: null, playerId: null, code: null };
  let unsubscribe = null;
  let state = null;
  let clockOffset = 0; // server time minus local time, in ms
  let loadedRace = null; // "raceIndex:startAt" currently in the typing card
  let heartbeatTimer = null;
  let settingsTimer = null;
  let errorTimer = null;
  const sender = { latest: null, inFlight: false, lastSent: 0, timer: null };

  // ---------- Small helpers ----------

  function storageGet(store, key) {
    try {
      return store.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function storageSet(store, key, value) {
    try {
      if (value === null) store.removeItem(key);
      else store.setItem(key, value);
    } catch (e) {
      // Storage unavailable: the page still works, it just forgets on reload.
    }
  }

  function loadPlayerKey() {
    let key = storageGet(localStorage, KEY_STORE);
    if (!key) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      key = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      storageSet(localStorage, KEY_STORE, key);
    }
    return key;
  }

  function serverNow() {
    return Date.now() + clockOffset;
  }

  function ordinal(n) {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function shuffle(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function node(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text; // always text, never HTML
    return n;
  }

  // Convex sends user-facing messages as ConvexError data.
  function errorMessage(err) {
    if (err && typeof err.data === "string") return err.data;
    const match = /Uncaught (?:Convex)?Error: ([^\n]+)/.exec((err && err.message) || "");
    return match ? match[1] : "Something went wrong. Check your connection and try again.";
  }

  function showError(err) {
    el.error.textContent = typeof err === "string" ? err : errorMessage(err);
    el.error.classList.remove("hidden");
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => el.error.classList.add("hidden"), 7000);
  }

  function clearError() {
    el.error.classList.add("hidden");
  }

  function call(fnRef, args) {
    return client.mutation(fnRef, args);
  }

  // ---------- Clock sync ----------

  // Measures the server clock three times and keeps the fastest round trip,
  // so everyone's 3-2-1 countdown ends at the same moment.
  async function syncClock() {
    let best = null;
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      const server = await call(api.race.serverTime, {});
      const t1 = Date.now();
      const sample = { rtt: t1 - t0, offset: server - (t0 + t1) / 2 };
      if (!best || sample.rtt < best.rtt) best = sample;
    }
    clockOffset = best.offset;
  }

  // ---------- Mode tabs ----------

  function setMode(next) {
    if (next === mode) return;
    mode = next;
    el.tabs.querySelectorAll(".mode-tab").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    document.body.classList.toggle("race-mode", mode === "race");
    el.panel.classList.toggle("hidden", mode !== "race");
    if (mode === "solo") {
      if (me.roomId) leaveRoom();
      document.body.classList.remove("race-no-typing");
      app.endExternalMode();
    } else {
      el.setupNeeded.classList.toggle("hidden", configured);
      el.join.classList.toggle("hidden", !configured || !!me.roomId);
      document.body.classList.toggle("race-no-typing", true);
      if (configured && !el.name.value) el.name.focus();
    }
  }

  // ---------- Joining and leaving ----------

  function readName() {
    const name = el.name.value.trim();
    if (!name) {
      showError("Enter your name first.");
      el.name.focus();
      return null;
    }
    storageSet(localStorage, NAME_STORE, name);
    return name;
  }

  async function createRoom() {
    const name = readName();
    if (!name) return;
    clearError();
    el.create.disabled = true;
    try {
      const res = await call(api.race.createRoom, {
        playerKey: me.key,
        name,
        category: "All",
        seasonSetting: 5,
      });
      await enterRoom(res);
    } catch (err) {
      showError(err);
    } finally {
      el.create.disabled = false;
    }
  }

  async function joinRoom(code) {
    const name = readName();
    if (!name) return;
    const clean = String(code || "").trim().toUpperCase();
    if (clean.length !== 4) {
      showError("Room codes have 4 characters.");
      return;
    }
    clearError();
    el.joinBtn.disabled = true;
    try {
      const res = await call(api.race.joinRoom, { code: clean, playerKey: me.key, name });
      await enterRoom(res);
    } catch (err) {
      showError(err);
    } finally {
      el.joinBtn.disabled = false;
    }
  }

  async function enterRoom(res) {
    me.roomId = res.roomId;
    me.playerId = res.playerId;
    me.code = res.code;
    loadedRace = null;
    storageSet(sessionStorage, ROOM_STORE, res.code);
    history.replaceState(null, "", location.pathname + "?room=" + res.code);

    el.join.classList.add("hidden");
    el.room.classList.remove("hidden");
    el.code.textContent = res.code;

    try {
      await syncClock();
    } catch (err) {
      // Without a sync the countdown may be off by your network delay; still usable.
    }
    unsubscribe = client.onUpdate(api.race.getRoom, { code: res.code }, onState, (err) => showError(err));
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);
  }

  function exitRoomLocally() {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    clearInterval(heartbeatTimer);
    clearTimeout(sender.timer);
    sender.latest = null;
    me.roomId = null;
    me.playerId = null;
    me.code = null;
    state = null;
    loadedRace = null;
    storageSet(sessionStorage, ROOM_STORE, null);
    history.replaceState(null, "", location.pathname);
    el.room.classList.add("hidden");
    el.join.classList.toggle("hidden", mode !== "race");
    document.body.classList.add("race-no-typing");
    app.endExternalMode();
  }

  function leaveRoom() {
    if (!me.roomId) return;
    call(api.race.leaveRoom, { roomId: me.roomId, playerKey: me.key }).catch(() => {});
    exitRoomLocally();
  }

  function sendHeartbeat() {
    if (!me.roomId) return;
    call(api.race.heartbeat, { roomId: me.roomId, playerKey: me.key }).catch((err) => {
      if (/not in this room|no longer exists/.test(errorMessage(err))) {
        exitRoomLocally();
        showError("You are no longer in that room.");
      }
    });
  }

  // ---------- Sending progress ----------

  function queueProgress(progress, wpm) {
    sender.latest = { progress, wpm };
    if (sender.timer || sender.inFlight) return;
    const wait = Math.max(0, PROGRESS_INTERVAL_MS - (Date.now() - sender.lastSent));
    sender.timer = setTimeout(flushProgress, wait);
  }

  function flushProgress() {
    sender.timer = null;
    if (!sender.latest || !me.roomId) return;
    const payload = sender.latest;
    sender.latest = null;
    sender.inFlight = true;
    sender.lastSent = Date.now();
    call(api.race.reportProgress, { roomId: me.roomId, playerKey: me.key, ...payload })
      .catch(() => {})
      .finally(() => {
        sender.inFlight = false;
        if (sender.latest) queueProgress(sender.latest.progress, sender.latest.wpm);
      });
  }

  function sendFinish(raceIndex, result) {
    clearTimeout(sender.timer);
    sender.timer = null;
    sender.latest = null;
    app.setResultMessage("Finished! Checking your place…");
    call(api.race.finishRace, {
      roomId: me.roomId,
      playerKey: me.key,
      raceIndex,
      wpm: result.wpm,
      accuracy: result.accuracy,
    })
      .then((res) => app.setResultMessage(placeMessage(res.place, res.points)))
      .catch((err) => app.setResultMessage("Finished, but " + errorMessage(err).toLowerCase()));
  }

  function placeMessage(place, points) {
    return ordinal(place) + " place · +" + points + (points === 1 ? " pt" : " pts");
  }

  // ---------- Settings (host) ----------

  function seasonCount(setting, category) {
    const available = app.textsFor(category).length;
    return setting === 0 ? available : Math.min(setting, available);
  }

  function seasonLabel(setting, category) {
    const available = app.textsFor(category).length;
    if (setting === 0) return "All (" + available + ")";
    if (setting > available) return setting + " (only " + available + " in this category)";
    return String(setting);
  }

  function sliderToSetting(value) {
    const n = Number(value);
    return n >= SLIDER_ALL ? 0 : n;
  }

  function settingToSlider(setting) {
    return setting === 0 ? SLIDER_ALL : setting;
  }

  function onSettingsInput() {
    const setting = sliderToSetting(el.count.value);
    el.countLabel.textContent = seasonLabel(setting, el.category.value);
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => {
      settingsTimer = null;
      if (!me.roomId) return;
      call(api.race.updateSettings, {
        roomId: me.roomId,
        playerKey: me.key,
        category: el.category.value,
        seasonSetting: setting,
      }).catch(showError);
    }, 250);
  }

  async function startSeason() {
    if (!state) return;
    const category = el.category.value;
    const setting = sliderToSetting(el.count.value);
    const texts = shuffle(app.textsFor(category)).slice(0, seasonCount(setting, category));
    if (texts.length === 0) {
      showError("That category has no affirmations.");
      return;
    }
    el.start.disabled = true;
    try {
      // Save the latest settings first, in case the debounce has not fired yet.
      clearTimeout(settingsTimer);
      settingsTimer = null;
      await call(api.race.updateSettings, { roomId: me.roomId, playerKey: me.key, category, seasonSetting: setting });
      await call(api.race.startSeason, { roomId: me.roomId, playerKey: me.key, texts });
    } catch (err) {
      showError(err);
    } finally {
      el.start.disabled = false;
    }
  }

  function hostAction(fnRef, button) {
    button.disabled = true;
    call(fnRef, { roomId: me.roomId, playerKey: me.key })
      .catch(showError)
      .finally(() => {
        button.disabled = false;
      });
  }

  // ---------- Rendering ----------

  function onState(next) {
    if (!me.roomId) return;
    if (!next) {
      exitRoomLocally();
      showError("That room no longer exists.");
      return;
    }
    state = next;
    const mine = state.players.find((p) => p._id === me.playerId);
    if (!mine) {
      exitRoomLocally();
      return;
    }
    syncTypingCard(mine);
    render(mine);
  }

  function isHost() {
    return state && state.room.hostPlayerId === me.playerId;
  }

  function isConnected(p) {
    return serverNow() - p.lastSeen < STALE_MS;
  }

  function pointsThisRace(playerId, raceIndex) {
    const r = state.results.find((x) => x.playerId === playerId && x.raceIndex === raceIndex);
    return r ? r.points : 0;
  }

  // Loads each new race into the typing card, and reports the result.
  function syncTypingCard(mine) {
    const room = state.room;
    const spectating = mine.activeFromRace > room.raceIndex;

    if (room.status === "racing") {
      const key = room.raceIndex + ":" + room.startAt;
      if (key !== loadedRace) {
        loadedRace = key;
        const raceIndex = room.raceIndex;
        app.beginExternalRound(room.texts[raceIndex], {
          label: "Race " + (raceIndex + 1) + " of " + room.texts.length,
          startAtLocal: room.startAt - clockOffset,
          onProgress: queueProgress,
          onFinish: (result) => sendFinish(raceIndex, result),
        });
        if (spectating) app.stopExternalRound("You join from the next race. Watch this one!");
      }
      if (mine.place !== null) {
        app.setResultMessage(placeMessage(mine.place, pointsThisRace(mine._id, room.raceIndex)));
      }
      return;
    }

    if (room.status === "between" || room.status === "finished") {
      if (loadedRace && !spectating) {
        if (mine.place !== null) {
          app.setResultMessage(placeMessage(mine.place, pointsThisRace(mine._id, room.raceIndex)));
        } else {
          app.stopExternalRound("Race over. You did not finish this one.");
        }
      }
      return;
    }

    loadedRace = null; // lobby
  }

  function statusText(mine) {
    const room = state.room;
    const n = room.texts.length;
    const host = state.players.find((p) => p._id === room.hostPlayerId);
    const hostName = host ? host.name : "the host";
    switch (room.status) {
      case "lobby":
        return isHost()
          ? "Choose the settings, then start when everyone has joined."
          : "Waiting for " + hostName + " to start the season.";
      case "racing":
        return serverNow() < room.startAt
          ? "Race " + (room.raceIndex + 1) + " of " + n + " starts in a moment…"
          : "Race " + (room.raceIndex + 1) + " of " + n + " — go!";
      case "between":
        return isHost()
          ? "Race " + (room.raceIndex + 1) + " of " + n + " done. Press Next race (or Enter) when ready."
          : "Race " + (room.raceIndex + 1) + " of " + n + " done. Waiting for " + hostName + " to start the next one.";
      case "finished":
        return isHost()
          ? "Season over! Change the settings if you like, then start a new season."
          : "Season over! Waiting for " + hostName + " to start a new season.";
      default:
        return "";
    }
  }

  function render(mine) {
    const room = state.room;
    const host = isHost();
    const seasonStarted = room.status !== "lobby";

    el.code.textContent = room.code;
    el.status.textContent = statusText(mine);

    // Settings: the host edits them between seasons; everyone else sees a summary.
    const canEdit = host && (room.status === "lobby" || room.status === "finished");
    el.settings.classList.toggle("hidden", !canEdit);
    if (canEdit && !settingsTimer && document.activeElement !== el.count && document.activeElement !== el.category) {
      if (!Array.from(el.category.options).some((o) => o.value === room.category)) {
        el.category.appendChild(new Option(room.category, room.category));
      }
      el.category.value = room.category;
      el.count.value = String(settingToSlider(room.seasonSetting));
      el.countLabel.textContent = seasonLabel(room.seasonSetting, room.category);
    }
    const summary = room.category + " · " + seasonCount(room.seasonSetting, room.category) + " races";
    el.settingsReadonly.textContent = seasonStarted ? summary : "Season: " + summary;
    el.settingsReadonly.classList.toggle("hidden", canEdit);

    renderPlayers(mine, seasonStarted);
    renderStandings();

    el.start.classList.toggle("hidden", !(host && (room.status === "lobby" || room.status === "finished")));
    el.start.textContent = room.status === "finished" ? "Start new season" : "Start season";
    el.next.classList.toggle("hidden", !(host && room.status === "between"));
    el.end.classList.toggle("hidden", !(host && room.status === "racing"));

    const showTyping = room.status === "racing" || room.status === "between";
    document.body.classList.toggle("race-no-typing", !showTyping);
  }

  function renderPlayers(mine, seasonStarted) {
    const room = state.room;
    el.players.replaceChildren();
    state.players.forEach((p) => {
      const li = node("li", "race-player");
      if (p._id === me.playerId) li.classList.add("me");
      if (!isConnected(p)) li.classList.add("offline");

      const top = node("div", "rp-top");
      const name = node("span", "rp-name", p.name);
      if (p._id === me.playerId) name.appendChild(node("span", "rp-tag", "you"));
      if (p._id === room.hostPlayerId) name.appendChild(node("span", "rp-tag", "host"));
      if (!isConnected(p)) name.appendChild(node("span", "rp-tag", "offline"));
      top.appendChild(name);

      let meta = "";
      if (seasonStarted) {
        if (p.activeFromRace > room.raceIndex) meta = "joins next race";
        else if (p.place !== null) meta = ordinal(p.place) + " · " + p.raceWpm + " WPM";
        else if (room.status === "racing") meta = p.wpm + " WPM";
        else meta = "did not finish";
        meta += " · " + p.points + (p.points === 1 ? " pt" : " pts");
      }
      top.appendChild(node("span", "rp-meta", meta));
      li.appendChild(top);

      if (seasonStarted) {
        const bar = node("div", "rp-bar");
        const fill = node("div", "rp-fill");
        fill.style.width = Math.round(Math.min(1, Math.max(0, p.progress)) * 100) + "%";
        if (p.place !== null) fill.classList.add("done");
        bar.appendChild(fill);
        li.appendChild(bar);
      }
      el.players.appendChild(li);
    });
  }

  function renderStandings() {
    const room = state.room;
    const show = room.status === "between" || room.status === "finished";
    el.standings.classList.toggle("hidden", !show);
    if (!show) return;

    const rows = state.players.map((p) => {
      const mine = state.results.filter((r) => r.playerId === p._id && r.place !== null);
      const avg = mine.length ? Math.round(mine.reduce((a, r) => a + r.wpm, 0) / mine.length) : 0;
      const wins = mine.filter((r) => r.place === 1).length;
      return { p, avg, wins };
    });
    rows.sort((a, b) => b.p.points - a.p.points || b.wins - a.wins || b.avg - a.avg);

    el.standings.replaceChildren();
    if (room.status === "finished" && rows.length) {
      const top = rows[0].p.points;
      const champs = rows.filter((r) => r.p.points === top).map((r) => r.p.name);
      el.standings.appendChild(
        node("h3", "race-champion", (champs.length > 1 ? "Tied champions: " : "Season champion: ") + champs.join(" & "))
      );
    } else {
      el.standings.appendChild(node("h3", "", "Standings after race " + (room.raceIndex + 1) + " of " + room.texts.length));
    }

    const table = node("table", "race-table");
    const head = node("tr");
    ["#", "Name", "Points", "Wins", "Avg WPM"].forEach((h) => head.appendChild(node("th", "", h)));
    table.appendChild(head);
    rows.forEach((r, i) => {
      const tr = node("tr", r.p._id === me.playerId ? "me" : "");
      [String(i + 1), r.p.name, String(r.p.points), String(r.wins), r.avg ? String(r.avg) : "—"].forEach((c) =>
        tr.appendChild(node("td", "", c))
      );
      table.appendChild(tr);
    });
    el.standings.appendChild(table);
  }

  // ---------- Wiring ----------

  function buildCategoryOptions() {
    el.category.replaceChildren();
    ["All"].concat(app.categories()).forEach((c) => el.category.appendChild(new Option(c, c)));
  }

  el.tabs.addEventListener("click", (e) => {
    const tab = e.target.closest(".mode-tab");
    if (tab) setMode(tab.dataset.mode);
  });
  el.create.addEventListener("click", createRoom);
  el.joinBtn.addEventListener("click", () => joinRoom(el.codeInput.value));
  el.codeInput.addEventListener("input", () => {
    el.codeInput.value = el.codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  });
  el.codeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") joinRoom(el.codeInput.value);
  });
  el.name.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !el.codeInput.value) createRoom();
  });
  el.category.addEventListener("change", onSettingsInput);
  el.count.addEventListener("input", onSettingsInput);
  el.start.addEventListener("click", startSeason);
  el.next.addEventListener("click", () => hostAction(api.race.nextRace, el.next));
  el.end.addEventListener("click", () => hostAction(api.race.hostEndRace, el.end));
  el.leave.addEventListener("click", leaveRoom);
  el.copyLink.addEventListener("click", () => {
    const link = location.origin + location.pathname + "?room=" + me.code;
    const done = () => {
      el.copyLink.textContent = "Copied!";
      setTimeout(() => (el.copyLink.textContent = "Copy invite link"), 2000);
    };
    if (navigator.clipboard) navigator.clipboard.writeText(link).then(done, () => showError("Copy failed. Link: " + link));
    else showError("Invite link: " + link);
  });

  // Host shortcut: Enter starts the next race between races.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || mode !== "race" || !state || !isHost()) return;
    if (state.room.status !== "between") return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "BUTTON") return;
    e.preventDefault();
    hostAction(api.race.nextRace, el.next);
  });

  // Refresh "offline" tags and the countdown text even when nothing else changes.
  setInterval(() => {
    if (state && me.roomId) {
      const mine = state.players.find((p) => p._id === me.playerId);
      if (mine) render(mine);
    }
  }, 1000);

  buildCategoryOptions();
  el.name.value = storageGet(localStorage, NAME_STORE) || "";

  // An invite link (?room=CODE) opens the race tab with the code filled in.
  // After a page refresh, you rejoin your room automatically.
  const params = new URLSearchParams(location.search);
  const linkCode = (params.get("room") || "").toUpperCase();
  if (linkCode) {
    setMode("race");
    el.codeInput.value = linkCode;
    const previous = storageGet(sessionStorage, ROOM_STORE);
    if (configured && previous === linkCode && el.name.value) joinRoom(linkCode);
  }
})();
