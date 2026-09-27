(function () {
  "use strict";

  const OLD_STORAGE_KEY = "clarity-keys-stats-v1";
  const SESSIONS_KEY = "clarity-keys-sessions-v2";
  const UI_KEY = "clarity-keys-ui-v1";
  const HANDS = ["left", "both", "right"];
  const RANGE_DAYS = { "1w": 7, "1m": 30, "1q": 91, "1y": 365 };

  const categorySelect = document.getElementById("category-select");
  const handSelect = document.getElementById("hand-select");
  const nextBtn = document.getElementById("next-btn");
  const retryBtn = document.getElementById("retry-btn");
  const typingCard = document.getElementById("typing-card");
  const targetTextEl = document.getElementById("target-text");
  const typingInput = document.getElementById("typing-input");
  const categoryTag = document.getElementById("category-tag");
  const tapHint = document.getElementById("tap-hint");

  const statWpm = document.getElementById("stat-wpm");
  const statAccuracy = document.getElementById("stat-accuracy");
  const statTime = document.getElementById("stat-time");

  const resultCard = document.getElementById("result-card");
  const resultWpm = document.getElementById("result-wpm");
  const resultAccuracy = document.getElementById("result-accuracy");
  const resultTime = document.getElementById("result-time");
  const continueBtn = document.getElementById("continue-btn");

  const progressChartWrap = document.getElementById("progress-chart-wrap");
  const progressChart = document.getElementById("progress-chart");
  const progressStatsEl = document.getElementById("progress-stats");
  const toggleStatsBtn = document.getElementById("toggle-stats-btn");
  const rangeToggle = document.getElementById("range-toggle");
  const seriesToggle = document.getElementById("series-toggle");

  let currentEntry = null;
  let pool = [];
  let startTime = null;
  let timerId = null;
  let errorPositions = new Set();
  let finished = false;
  let currentHand = "both";
  let sessions = [];
  let ui = { hand: "both", range: "1m", hideStats: false, series: ["both"] };

  function loadUi() {
    try {
      const raw = localStorage.getItem(UI_KEY);
      if (!raw) return { hand: "both", range: "1m", hideStats: false, series: ["both"] };
      const parsed = JSON.parse(raw);
      return {
        hand: HANDS.includes(parsed.hand) ? parsed.hand : "both",
        range: RANGE_DAYS[parsed.range] ? parsed.range : "1m",
        hideStats: !!parsed.hideStats,
        series: Array.isArray(parsed.series) ? parsed.series.filter((s) => HANDS.includes(s)) : ["both"]
      };
    } catch (e) {
      return { hand: "both", range: "1m", hideStats: false, series: ["both"] };
    }
  }

  function saveUi() {
    try {
      localStorage.setItem(UI_KEY, JSON.stringify(ui));
    } catch (e) {
      // localStorage unavailable — settings just won't persist this session.
    }
  }

  function loadSessions() {
    try {
      const raw = localStorage.getItem(SESSIONS_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {
      // fall through to migration / empty
    }
    // Migrate the older single-number stats (pre hand-mode tracking), if present,
    // into one seed "both" session so a returning user doesn't see progress vanish.
    try {
      const oldRaw = localStorage.getItem(OLD_STORAGE_KEY);
      if (oldRaw) {
        const old = JSON.parse(oldRaw);
        if (old && old.sessions > 0) {
          return [
            {
              mode: "both",
              wpm: old.bestWpm || 0,
              accuracy: Math.round((old.accuracySum || 0) / old.sessions),
              time: 0,
              ts: Date.now()
            }
          ];
        }
      }
    } catch (e) {
      // ignore
    }
    return [];
  }

  function saveSessions() {
    try {
      // Cap history so localStorage doesn't grow without bound.
      if (sessions.length > 3000) sessions = sessions.slice(-3000);
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
    } catch (e) {
      // localStorage unavailable — stats just won't persist this session.
    }
  }

  function aggregateFor(mode) {
    const arr = sessions.filter((s) => s.mode === mode);
    if (arr.length === 0) return { best: "—", avgWpm: "—", avgAcc: "—", count: 0 };
    const best = Math.max(...arr.map((s) => s.wpm));
    const avgWpm = Math.round(arr.reduce((a, s) => a + s.wpm, 0) / arr.length);
    const avgAcc = Math.round(arr.reduce((a, s) => a + s.accuracy, 0) / arr.length);
    return { best, avgWpm, avgAcc, count: arr.length };
  }

  function renderProgressStats() {
    const left = aggregateFor("left");
    const both = aggregateFor("both");
    const right = aggregateFor("right");
    progressStatsEl.innerHTML =
      '<div class="stats-table">' +
      '<div class="stats-table-row header"><span></span><span>Left</span><span>Both</span><span>Right</span></div>' +
      '<div class="stats-table-row"><span class="row-label">Best WPM</span><span>' + left.best + '</span><span>' + both.best + '</span><span>' + right.best + '</span></div>' +
      '<div class="stats-table-row"><span class="row-label">Avg WPM</span><span>' + left.avgWpm + '</span><span>' + both.avgWpm + '</span><span>' + right.avgWpm + '</span></div>' +
      '<div class="stats-table-row"><span class="row-label">Avg accuracy</span><span>' + (left.count ? left.avgAcc + "%" : "—") + '</span><span>' + (both.count ? both.avgAcc + "%" : "—") + '</span><span>' + (right.count ? right.avgAcc + "%" : "—") + '</span></div>' +
      '<div class="stats-table-row"><span class="row-label">Sessions</span><span>' + left.count + '</span><span>' + both.count + '</span><span>' + right.count + '</span></div>' +
      '</div>';
  }

  const HAND_LABELS = { left: "LH", both: "Both", right: "RH" };

  function dateLabel(ts) {
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function drawChart() {
    const ctx = progressChart.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const width = progressChartWrap.clientWidth;
    const height = progressChartWrap.clientHeight;
    progressChart.width = Math.max(1, Math.round(width * dpr));
    progressChart.height = Math.max(1, Math.round(height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const styles = getComputedStyle(document.documentElement);
    const colors = {
      left: styles.getPropertyValue("--chart-left").trim(),
      both: styles.getPropertyValue("--chart-both").trim(),
      right: styles.getPropertyValue("--chart-right").trim()
    };
    const gridColor = styles.getPropertyValue("--border").trim();
    const labelColor = styles.getPropertyValue("--text-soft").trim();

    const days = RANGE_DAYS[ui.range] || 30;
    const now = Date.now();
    const cutoff = now - days * 24 * 60 * 60 * 1000;

    const activeSeries = ui.series
      .map((mode) => ({
        mode,
        points: sessions
          .filter((s) => s.mode === mode && s.ts >= cutoff)
          .sort((a, b) => a.ts - b.ts)
      }))
      .filter((s) => s.points.length > 0);

    // Padding leaves room for the y-axis WPM labels on the left and the
    // date labels along the bottom, so the plotted line never overlaps them.
    const padL = 34;
    const padR = 12;
    const padT = 16;
    const padB = 20;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    if (activeSeries.length === 0) {
      ctx.font = "13px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.fillStyle = labelColor;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Not enough data yet — finish a round to start your chart.", width / 2, height / 2);
      return;
    }

    const allWpm = activeSeries.flatMap((s) => s.points.map((p) => p.wpm));
    const maxWpm = Math.max(...allWpm, 10);
    const minWpm = Math.min(0, Math.min(...allWpm));
    const wpmRange = maxWpm - minWpm || 1;

    const xFor = (ts) => {
      const clamped = Math.min(now, Math.max(cutoff, ts));
      return padL + ((clamped - cutoff) / (now - cutoff || 1)) * plotW;
    };
    const yFor = (wpm) => padT + plotH - ((wpm - minWpm) / wpmRange) * plotH;

    // Horizontal gridlines with WPM labels, at roughly 4 even steps.
    const gridSteps = 4;
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.font = "11px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillStyle = labelColor;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= gridSteps; i++) {
      const wpmVal = Math.round(minWpm + (wpmRange * i) / gridSteps);
      const y = yFor(wpmVal);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillText(String(wpmVal), padL - 8, y);
    }

    // Date labels at the start and end of the selected range.
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(dateLabel(cutoff), padL, height - padB + 6);
    ctx.textAlign = "right";
    ctx.fillText(dateLabel(now), padL + plotW, height - padB + 6);

    // One smooth line per selected hand mode, plus a dot at each session.
    activeSeries.forEach((series) => {
      const color = colors[series.mode] || "#999";
      const pts = series.points.map((p) => ({ x: xFor(p.ts), y: yFor(p.wpm) }));

      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      if (pts.length === 1) {
        ctx.moveTo(pts[0].x - 6, pts[0].y);
        ctx.lineTo(pts[0].x + 6, pts[0].y);
      } else {
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) {
          const prev = pts[i - 1];
          const curr = pts[i];
          const midX = (prev.x + curr.x) / 2;
          const midY = (prev.y + curr.y) / 2;
          ctx.quadraticCurveTo(prev.x, prev.y, midX, midY);
        }
        ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
      }
      ctx.stroke();

      ctx.fillStyle = color;
      pts.forEach((p) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        ctx.fill();
      });
    });

    // Small legend in the top-right, one entry per line currently shown.
    ctx.font = "11px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textBaseline = "middle";
    let legendX = width - padR;
    activeSeries
      .slice()
      .reverse()
      .forEach((series) => {
        const label = HAND_LABELS[series.mode] || series.mode;
        const textWidth = ctx.measureText(label).width;
        legendX -= textWidth;
        ctx.textAlign = "left";
        ctx.fillStyle = colors[series.mode] || "#999";
        ctx.fillText(label, legendX, padT - 4);
        legendX -= 16;
      });
  }

  function renderProgress() {
    renderProgressStats();
    drawChart();
  }

  function recordSession(wpm, accuracy, seconds) {
    sessions.push({ mode: currentHand, wpm, accuracy, time: Math.round(seconds), ts: Date.now() });
    saveSessions();
    renderProgress();
  }

  function buildCategoryOptions() {
    const categories = ["All"].concat(
      Array.from(new Set(AFFIRMATIONS.map((a) => a.category)))
    );
    categorySelect.innerHTML = "";
    categories.forEach((cat) => {
      const opt = document.createElement("option");
      opt.value = cat;
      opt.textContent = cat;
      categorySelect.appendChild(opt);
    });
  }

  function currentPool() {
    const cat = categorySelect.value;
    if (cat === "All") return AFFIRMATIONS.slice();
    return AFFIRMATIONS.filter((a) => a.category === cat);
  }

  function pickEntry() {
    pool = currentPool();
    if (pool.length === 0) pool = AFFIRMATIONS.slice();
    let candidate;
    if (pool.length === 1) {
      candidate = pool[0];
    } else {
      do {
        candidate = pool[Math.floor(Math.random() * pool.length)];
      } while (currentEntry && candidate.text === currentEntry.text);
    }
    currentEntry = candidate;
  }

  function renderTarget() {
    categoryTag.textContent = currentEntry.category;
    targetTextEl.innerHTML = "";
    const frag = document.createDocumentFragment();
    currentEntry.text.split("").forEach((ch) => {
      const span = document.createElement("span");
      span.className = "char pending";
      span.textContent = ch;
      frag.appendChild(span);
    });
    targetTextEl.appendChild(frag);
  }

  function resetRound(newEntry) {
    if (newEntry) pickEntry();
    renderTarget();
    typingInput.value = "";
    startTime = null;
    finished = false;
    errorPositions = new Set();
    clearInterval(timerId);
    statWpm.textContent = "0";
    statAccuracy.textContent = "100%";
    statTime.textContent = "0s";
    resultCard.classList.add("hidden");
    typingInput.disabled = false;
    tapHint.classList.remove("hidden");
    typingInput.focus();
  }

  function elapsedSeconds() {
    if (!startTime) return 0;
    return (Date.now() - startTime) / 1000;
  }

  function computeWpm(correctChars, seconds) {
    if (seconds <= 0) return 0;
    return Math.round((correctChars / 5) / (seconds / 60));
  }

  function computeAccuracy(targetLength) {
    if (targetLength === 0) return 100;
    const acc = ((targetLength - errorPositions.size) / targetLength) * 100;
    return Math.max(0, Math.round(acc));
  }

  function tick() {
    const seconds = elapsedSeconds();
    const typed = typingInput.value;
    const correctChars = countCorrect(typed);
    statWpm.textContent = String(computeWpm(correctChars, seconds));
    statAccuracy.textContent = computeAccuracy(currentEntry.text.length) + "%";
    statTime.textContent = Math.round(seconds) + "s";
  }

  function countCorrect(typed) {
    const target = currentEntry.text;
    let correct = 0;
    for (let i = 0; i < typed.length && i < target.length; i++) {
      if (typed[i] === target[i]) correct++;
    }
    return correct;
  }

  function updateHighlighting(typed) {
    const target = currentEntry.text;
    const spans = targetTextEl.children;
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i];
      span.classList.remove("correct", "incorrect", "pending", "current");
      if (i < typed.length) {
        if (typed[i] === target[i]) {
          span.classList.add("correct");
        } else {
          span.classList.add("incorrect");
          errorPositions.add(i);
        }
      } else if (i === typed.length) {
        span.classList.add("pending", "current");
      } else {
        span.classList.add("pending");
      }
    }
  }

  function finishRound() {
    finished = true;
    clearInterval(timerId);
    typingInput.disabled = true;
    const seconds = elapsedSeconds();
    const correctChars = countCorrect(typingInput.value);
    const wpm = computeWpm(correctChars, seconds);
    const accuracy = computeAccuracy(currentEntry.text.length);

    resultWpm.textContent = wpm;
    resultAccuracy.textContent = accuracy + "%";
    resultTime.textContent = Math.round(seconds) + "s";
    resultCard.classList.remove("hidden");

    recordSession(wpm, accuracy, seconds);
  }

  function onInput() {
    const typed = typingInput.value;
    if (!startTime && typed.length > 0) {
      startTime = Date.now();
      timerId = setInterval(tick, 250);
      tapHint.classList.add("hidden");
    }
    updateHighlighting(typed);
    tick();
    if (typed.length >= currentEntry.text.length && !finished) {
      finishRound();
    }
  }

  function setActiveButton(container, selector, matchAttr, value) {
    container.querySelectorAll(selector).forEach((btn) => {
      btn.classList.toggle("active", btn.dataset[matchAttr] === value);
    });
  }

  function applyHand(hand) {
    currentHand = hand;
    ui.hand = hand;
    setActiveButton(handSelect, ".hand-btn", "hand", hand);
    saveUi();
  }

  function applyRange(range) {
    ui.range = range;
    setActiveButton(rangeToggle, ".range-btn", "range", range);
    saveUi();
    drawChart();
  }

  function applyHideStats(hidden) {
    ui.hideStats = hidden;
    progressStatsEl.classList.toggle("hidden-info", hidden);
    toggleStatsBtn.textContent = hidden ? "Show info" : "Hide info";
    toggleStatsBtn.setAttribute("aria-pressed", String(hidden));
    saveUi();
  }

  function applySeriesCheckboxes() {
    seriesToggle.querySelectorAll("input[type=checkbox]").forEach((box) => {
      box.checked = ui.series.includes(box.dataset.series);
    });
  }

  handSelect.addEventListener("click", (e) => {
    const btn = e.target.closest(".hand-btn");
    if (!btn) return;
    applyHand(btn.dataset.hand);
  });

  rangeToggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".range-btn");
    if (!btn) return;
    applyRange(btn.dataset.range);
  });

  seriesToggle.addEventListener("change", () => {
    ui.series = Array.from(seriesToggle.querySelectorAll("input[type=checkbox]:checked")).map(
      (box) => box.dataset.series
    );
    saveUi();
    drawChart();
  });

  toggleStatsBtn.addEventListener("click", () => applyHideStats(!ui.hideStats));

  window.addEventListener("resize", drawChart);

  categorySelect.addEventListener("change", () => resetRound(true));
  nextBtn.addEventListener("click", () => resetRound(true));
  retryBtn.addEventListener("click", () => resetRound(false));
  continueBtn.addEventListener("click", () => resetRound(true));
  typingInput.addEventListener("input", onInput);
  typingCard.addEventListener("click", () => typingInput.focus());
  typingInput.addEventListener("keydown", (e) => {
    // Prevent Enter from adding a newline the target text doesn't expect;
    // treat it as a normal keystroke against the target text instead.
    if (e.key === "Enter") e.preventDefault();
  });

  // Once a round is finished and the score is showing, pressing Enter
  // (from anywhere on the page, since the input is disabled at that point)
  // jumps straight to the next affirmation.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (finished && !resultCard.classList.contains("hidden")) {
      e.preventDefault();
      resetRound(true);
    }
  });

  ui = loadUi();
  sessions = loadSessions();

  buildCategoryOptions();
  applyHand(ui.hand);
  applyRange(ui.range);
  applyHideStats(ui.hideStats);
  applySeriesCheckboxes();
  renderProgress();
  resetRound(true);
})();
