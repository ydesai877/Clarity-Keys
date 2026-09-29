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
  const STREAK_STORE = "clarity-keys-loss-streak-v1";
  const CELEBRATION_MS = 10000;
  const CAR_COLORS = ["#e0466b", "#2fae66", "#e0946c", "#3aa7c9", "#c9a23a", "#d06bd6"];

  // Shown to the race winner. One is picked at random.
  const WIN_QUOTES = [
    "Mamma mia, mamma mia!... It's just incredible. Grazie mille a tutti!",
    "That's all for the kids out there who dream the impossible. You can do it too, man. I believe in you guys.",
    "Si, Ragazzi! Grazie mille, grazie, grazie! Dai Forza Ferrari!",
    "What did we just do? What did we just do? We won the race! Oh my God, guys!",
    "F**king finally. Thank you, guys.",
    "Smoooth Operatooor!... Imma smooth operaatooorr.. Yeah, baby! Yeah!",
  ];
  // Shown instead when you win after losing 3 or more races in a row.
  const COMEBACK_QUOTE = "Woohoo! I love you all. Thank you so much! We did it!... About time, huh?";
  const COMEBACK_AFTER = 3;

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
    celebration: $("celebration"),
    celebrationTitle: $("celebration-title"),
    celebrationQuote: $("celebration-quote"),
    celebrationClose: $("celebration-close"),
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
  let resolvedRace = null; // the last race whose result was handled (streak, quote)
  let celebrationTimer = null;
  const lanes = new Map(); // player id -> lane elements, reused so cars animate
  const myLive = { progress: 0, wpm: 0 }; // your own car moves from local typing, not the server
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
    resolvedRace = null;
    lanes.clear();
    el.players.replaceChildren();
    hideCelebration();
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
    myLive.progress = progress;
    myLive.wpm = wpm;
    const lane = lanes.get(me.playerId);
    if (lane) placeCar(lane, progress, wpm, true);
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
    app.setResultMessage("Finished! Saving your time…");
    call(api.race.finishRace, {
      roomId: me.roomId,
      playerKey: me.key,
      raceIndex,
      wpm: result.wpm,
      accuracy: result.accuracy,
    })
      .then((res) => {
        if (state && state.room.status === "racing") app.setResultMessage(waitingMessage(res.score));
      })
      .catch((err) => app.setResultMessage("Finished, but " + errorMessage(err).toLowerCase()));
  }

  function fmtScore(score) {
    return (Math.round(score * 10) / 10).toFixed(1);
  }

  function waitingMessage(score) {
    return "Finished · score " + fmtScore(score) + ". Waiting for the others…";
  }

  function placeMessage(place, points, score) {
    return (
      ordinal(place) + " place · score " + fmtScore(score) + " · +" + points + (points === 1 ? " pt" : " pts")
    );
  }

  // ---------- Winner celebration and losing streak ----------

  function loadStreak() {
    const n = Number(storageGet(localStorage, STREAK_STORE));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  // Called once per race you took part in, after places are final.
  function recordRaceOutcome(won, raceNumber) {
    const streak = loadStreak();
    if (won) {
      storageSet(localStorage, STREAK_STORE, "0");
      showCelebration(raceNumber, streak >= COMEBACK_AFTER ? streak : 0);
    } else {
      storageSet(localStorage, STREAK_STORE, String(streak + 1));
    }
  }

  // `comebackAfter` is the number of races lost in a row before this win (0 if under 3).
  function showCelebration(raceNumber, comebackAfter) {
    const comeback = comebackAfter > 0;
    el.celebrationTitle.textContent = comeback
      ? "P1! You won race " + raceNumber + " after " + comebackAfter + " races without a win."
      : "P1! You won race " + raceNumber + ".";
    el.celebrationQuote.textContent = comeback
      ? COMEBACK_QUOTE
      : WIN_QUOTES[Math.floor(Math.random() * WIN_QUOTES.length)];
    el.celebration.classList.remove("hidden");
    clearTimeout(celebrationTimer);
    celebrationTimer = setTimeout(hideCelebration, CELEBRATION_MS);
    el.celebrationClose.focus();
  }

  function hideCelebration() {
    clearTimeout(celebrationTimer);
    el.celebration.classList.add("hidden");
  }

  function isCelebrating() {
    return !el.celebration.classList.contains("hidden");
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

  function resultFor(playerId, raceIndex) {
    return state.results.find((x) => x.playerId === playerId && x.raceIndex === raceIndex) || null;
  }

  function finishedRace(p) {
    return p.raceTimeMs !== null && p.raceTimeMs !== undefined;
  }

  // Loads each new race into the typing card, and reports the result.
  function syncTypingCard(mine) {
    const room = state.room;
    const spectating = mine.activeFromRace > room.raceIndex;

    if (room.status === "racing") {
      const key = room.raceIndex + ":" + room.startAt;
      if (key !== loadedRace) {
        loadedRace = key;
        myLive.progress = 0;
        myLive.wpm = 0;
        const raceIndex = room.raceIndex;
        app.beginExternalRound(room.texts[raceIndex], {
          label: "Race " + (raceIndex + 1) + " of " + room.texts.length,
          lightsAtLocal: room.lightsAt - clockOffset,
          startAtLocal: room.startAt - clockOffset,
          onProgress: queueProgress,
          onFinish: (result) => sendFinish(raceIndex, result),
        });
        if (spectating) app.stopExternalRound("You join from the next race. Watch this one!");
      }
      if (finishedRace(mine)) app.setResultMessage(waitingMessage(mine.raceScore));
      return;
    }

    if (room.status === "between" || room.status === "finished") {
      if (loadedRace && !spectating) {
        const result = resultFor(mine._id, room.raceIndex);
        if (mine.place !== null && result) {
          app.setResultMessage(placeMessage(mine.place, result.points, result.score || 0));
        } else {
          app.stopExternalRound("Race over. You did not finish this one.");
        }
        if (resolvedRace !== loadedRace) {
          resolvedRace = loadedRace;
          recordRaceOutcome(mine.place === 1, room.raceIndex + 1);
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
          ? "Race " + (room.raceIndex + 1) + " of " + n + ": watch the lights…"
          : "Race " + (room.raceIndex + 1) + " of " + n + ": go! Score = WPM × accuracy.";
      case "between": {
        const win = state.results.find((r) => r.raceIndex === room.raceIndex && r.place === 1);
        const won = win ? " Won by " + win.name + " (score " + fmtScore(win.score || 0) + ")." : " Nobody finished.";
        return isHost()
          ? "Race " + (room.raceIndex + 1) + " of " + n + " done." + won + " Press Next race (or Enter)."
          : "Race " + (room.raceIndex + 1) + " of " + n + " done." + won + " Waiting for " + hostName + ".";
      }
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

  const CAR_SVG =
    '<svg viewBox="0 0 56 22" width="56" height="22" aria-hidden="true">' +
    '<rect x="0" y="2" width="9" height="3" rx="1" fill="currentColor"/>' +
    '<rect x="2" y="4" width="3" height="9" fill="#1c1a24"/>' +
    '<path d="M5 12 L15 10 L24 9 L29 6 L35 6 L38 9 L48 11 L55 13 L55 16 L5 16 Z" fill="currentColor"/>' +
    '<path d="M28.5 9 L31 6.6 L34 6.6 L35.5 9 Z" fill="#1c1a24" opacity="0.75"/>' +
    '<rect x="47" y="15" width="9" height="2.5" rx="1" fill="currentColor"/>' +
    '<g class="wheel"><circle cx="13" cy="16" r="5.5" fill="#1c1a24"/><rect x="12" y="11.5" width="2" height="9" fill="#6b6780"/></g>' +
    '<g class="wheel"><circle cx="44" cy="16.5" r="5" fill="#1c1a24"/><rect x="43" y="12.5" width="2" height="8" fill="#6b6780"/></g>' +
    "</svg>";

  function makeLane() {
    const li = node("li", "race-player");
    const top = node("div", "rp-top");
    const name = node("span", "rp-name");
    const meta = node("span", "rp-meta");
    top.append(name, meta);
    const track = node("div", "lane-track");
    const car = node("div", "lane-car");
    const lines = node("span", "speed-lines");
    car.appendChild(lines);
    car.insertAdjacentHTML("beforeend", CAR_SVG); // fixed markup, no user text
    track.append(car, node("span", "finish-line"));
    li.append(top, track);
    return { li, name, meta, track, car, lines, colorIndex: 0 };
  }

  // Position = share of the text typed correctly, so a faster typist's car
  // moves faster. Speed lines and wheel spin also scale with WPM.
  function placeCar(lane, progress, wpm, moving) {
    const p = Math.min(1, Math.max(0, progress || 0));
    // Jump (no slide) when a new race puts the car back at the start line.
    const back = lane.p !== undefined && p < lane.p - 0.05;
    if (back) lane.car.style.transition = "none";
    lane.car.style.left = "calc((100% - 64px) * " + p.toFixed(4) + ")";
    if (back) {
      void lane.car.offsetWidth;
      lane.car.style.transition = "";
    }
    lane.p = p;
    const speed = moving ? Math.min(1, (wpm || 0) / 120) : 0;
    lane.car.style.setProperty("--speed", speed.toFixed(2));
    lane.car.classList.toggle("moving", moving && speed > 0.02);
    lane.car.style.setProperty("--spin", (0.9 - 0.75 * speed).toFixed(2) + "s");
  }

  function renderPlayers(mine, seasonStarted) {
    const room = state.room;
    const racing = room.status === "racing" && serverNow() >= room.startAt;
    const seen = new Set();

    state.players.forEach((p, index) => {
      seen.add(p._id);
      let lane = lanes.get(p._id);
      if (!lane) {
        lane = makeLane();
        lanes.set(p._id, lane);
      }
      if (el.players.children[index] !== lane.li) el.players.insertBefore(lane.li, el.players.children[index] || null);

      const isMe = p._id === me.playerId;
      lane.li.classList.toggle("me", isMe);
      lane.li.classList.toggle("offline", !isConnected(p));
      lane.li.classList.toggle("no-track", !seasonStarted);
      lane.car.style.color = isMe ? "var(--accent)" : CAR_COLORS[index % CAR_COLORS.length];

      lane.name.replaceChildren(document.createTextNode(p.name)); // text only, never HTML
      if (isMe) lane.name.appendChild(node("span", "rp-tag", "you"));
      if (p._id === room.hostPlayerId) lane.name.appendChild(node("span", "rp-tag", "host"));
      if (!isConnected(p)) lane.name.appendChild(node("span", "rp-tag", "offline"));

      let meta = "";
      if (seasonStarted) {
        const pts = " · " + p.points + (p.points === 1 ? " pt" : " pts");
        if (p.activeFromRace > room.raceIndex) meta = "joins next race" + pts;
        else if (room.status === "racing") {
          meta = finishedRace(p) ? "Finished · score " + fmtScore(p.raceScore) : (isMe ? myLive.wpm : p.wpm) + " WPM";
          meta += pts;
        } else if (p.place !== null) {
          meta = ordinal(p.place) + " · score " + fmtScore(p.raceScore || 0) + pts;
        } else meta = "did not finish" + pts;
      }
      lane.meta.textContent = meta;

      if (seasonStarted) {
        const done = finishedRace(p) || p.place !== null;
        const useLocal = isMe && room.status === "racing" && !done;
        const progress = done ? 1 : useLocal ? Math.max(myLive.progress, p.progress) : p.progress;
        const wpm = useLocal ? myLive.wpm : p.wpm;
        placeCar(lane, progress, wpm, racing && !done);
        lane.li.classList.toggle("done", done);
      }
    });

    for (const [id, lane] of lanes) {
      if (!seen.has(id)) {
        lane.li.remove();
        lanes.delete(id);
      }
    }
  }

  function renderStandings() {
    const room = state.room;
    const show = room.status === "between" || room.status === "finished";
    el.standings.classList.toggle("hidden", !show);
    if (!show) return;

    const rows = state.players.map((p) => {
      const mine = state.results.filter((r) => r.playerId === p._id && r.place !== null);
      const avg = mine.length ? Math.round(mine.reduce((a, r) => a + r.wpm, 0) / mine.length) : 0;
      const avgScore = mine.length ? mine.reduce((a, r) => a + (r.score || 0), 0) / mine.length : 0;
      const wins = mine.filter((r) => r.place === 1).length;
      return { p, avg, avgScore, wins };
    });
    rows.sort((a, b) => b.p.points - a.p.points || b.wins - a.wins || b.avgScore - a.avgScore);

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
    ["#", "Name", "Points", "Wins", "Avg score", "Avg WPM"].forEach((h) => head.appendChild(node("th", "", h)));
    table.appendChild(head);
    rows.forEach((r, i) => {
      const tr = node("tr", r.p._id === me.playerId ? "me" : "");
      [
        String(i + 1),
        r.p.name,
        String(r.p.points),
        String(r.wins),
        r.avgScore ? fmtScore(r.avgScore) : "—",
        r.avg ? String(r.avg) : "—",
      ].forEach((c) =>
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

  el.celebrationClose.addEventListener("click", hideCelebration);
  el.celebration.addEventListener("click", (e) => {
    if (e.target === el.celebration) hideCelebration();
  });

  // Enter or Escape closes the winner card first.
  document.addEventListener(
    "keydown",
    (e) => {
      if ((e.key === "Enter" || e.key === "Escape") && isCelebrating()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        hideCelebration();
      }
    },
    true
  );

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
