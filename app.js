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
  const f1Lights = document.getElementById("f1-lights");
  const f1LightPods = f1Lights.querySelectorAll(".f1-light");

  const statWpm = document.getElementById("stat-wpm");
  const statAccuracy = document.getElementById("stat-accuracy");
  const statTime = document.getElementById("stat-time");

  const resultCard = document.getElementById("result-card");
  const continueBtn = document.getElementById("continue-btn");
  const resultHeading = resultCard.querySelector("h2");

  const progressChartWrap = document.getElementById("progress-chart-wrap");
  const progressChart = document.getElementById("progress-chart");
  const chartTooltip = document.getElementById("chart-tooltip");
  const progressStatsEl = document.getElementById("progress-stats");
  const toggleStatsBtn = document.getElementById("toggle-stats-btn");
  const rangeToggle = document.getElementById("range-toggle");
  const seriesToggle = document.getElementById("series-toggle");
  const onlineToggle = document.getElementById("online-toggle");

  let currentEntry = null;
  let pool = [];
  let startTime = null;
  let timerId = null;
  let errorPositions = new Set();
  let finished = false;
  let currentHand = "both";
  let sessions = [];
  let ui = { hand: "both", range: "1m", hideStats: false, series: ["both"], includeOnline: true };
  let chartLayout = null;
  // Set while a live race drives the typing card (see window.ClarityApp below).
  let external = null;
  let countdownTimer = null;
  let hoverX = null;

  function loadUi() {
    try {
      const raw = localStorage.getItem(UI_KEY);
      if (!raw) return { hand: "both", range: "1m", hideStats: false, series: ["both"], includeOnline: true };
      const parsed = JSON.parse(raw);
      return {
        hand: HANDS.includes(parsed.hand) ? parsed.hand : "both",
        range: RANGE_DAYS[parsed.range] ? parsed.range : "1m",
        hideStats: !!parsed.hideStats,
        series: Array.isArray(parsed.series) ? parsed.series.filter((s) => HANDS.includes(s)) : ["both"],
        includeOnline: parsed.includeOnline !== false
      };
    } catch (e) {
      return { hand: "both", range: "1m", hideStats: false, series: ["both"], includeOnline: true };
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

  // Online race results count only when the "Online races" box is ticked.
  function visibleSessions() {
    return ui.includeOnline ? sessions : sessions.filter((s) => !s.online);
  }

  function aggregateFor(mode) {
    const arr = visibleSessions().filter((s) => s.mode === mode);
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

  function dayKey(ts) {
    const d = new Date(ts);
    return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();
  }

  // 1W shows every attempt as its own point. 1M/1Q/1Y show one point per
  // calendar day — the best (highest-WPM) attempt recorded that day —
  // so the line reads as a trend instead of a dense scatter.
  function pointsForSeries(mode, cutoff, now) {
    const inRange = visibleSessions().filter((s) => s.mode === mode && s.ts >= cutoff && s.ts <= now);
    if (ui.range === "1w") {
      return inRange
        .slice()
        .sort((a, b) => a.ts - b.ts)
        .map((s) => ({ ts: s.ts, wpm: s.wpm, accuracy: s.accuracy }));
    }
    const bestByDay = new Map();
    inRange.forEach((s) => {
      const key = dayKey(s.ts);
      const existing = bestByDay.get(key);
      if (!existing || s.wpm > existing.wpm) bestByDay.set(key, s);
    });
    return Array.from(bestByDay.values())
      .sort((a, b) => a.ts - b.ts)
      .map((s) => ({ ts: s.ts, wpm: s.wpm, accuracy: s.accuracy }));
  }

  // Smooth curve that never swings above or below the real data points
  // (monotone cubic interpolation, Fritsch–Carlson method).
  function traceMonotoneCurve(ctx, pts) {
    const n = pts.length;
    const slopes = [];
    for (let i = 0; i < n - 1; i++) {
      const dx = pts[i + 1].x - pts[i].x;
      slopes.push(dx === 0 ? 0 : (pts[i + 1].y - pts[i].y) / dx);
    }
    const tangents = new Array(n);
    tangents[0] = slopes[0];
    tangents[n - 1] = slopes[n - 2];
    for (let i = 1; i < n - 1; i++) {
      tangents[i] = slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2;
    }
    for (let i = 0; i < n - 1; i++) {
      if (slopes[i] === 0) {
        tangents[i] = 0;
        tangents[i + 1] = 0;
        continue;
      }
      const a = tangents[i] / slopes[i];
      const b = tangents[i + 1] / slopes[i];
      const s = a * a + b * b;
      if (s > 9) {
        const tau = 3 / Math.sqrt(s);
        tangents[i] = tau * a * slopes[i];
        tangents[i + 1] = tau * b * slopes[i];
      }
    }
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 0; i < n - 1; i++) {
      const p0 = pts[i];
      const p1 = pts[i + 1];
      const third = (p1.x - p0.x) / 3;
      if (third === 0) {
        ctx.lineTo(p1.x, p1.y);
        continue;
      }
      ctx.bezierCurveTo(
        p0.x + third, p0.y + tangents[i] * third,
        p1.x - third, p1.y - tangents[i + 1] * third,
        p1.x, p1.y
      );
    }
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
      .map((mode) => ({ mode, points: pointsForSeries(mode, cutoff, now) }))
      .filter((s) => s.points.length > 0);

    // Padding leaves room for the y-axis WPM labels on the left and the
    // date labels along the bottom, so the plotted line never overlaps them.
    const padL = 34;
    const padR = 12;
    const padT = 16;
    const padB = 20;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    chartLayout = null;

    if (activeSeries.length === 0) {
      ctx.font = "13px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.fillStyle = labelColor;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Not enough data yet — finish a round to start your chart.", width / 2, height / 2);
      chartTooltip.classList.add("hidden");
      return;
    }

    const allWpm = activeSeries.flatMap((s) => s.points.map((p) => p.wpm));
    const maxWpm = Math.max(...allWpm, 10);
    const minWpm = Math.min(0, Math.min(...allWpm));
    const wpmRange = maxWpm - minWpm || 1;

    // 1W: space attempts evenly in the order you did them. With a time
    // axis, all of one day's attempts stack into a single vertical smear.
    // 1M/1Q/1Y: one point per day, so a real time axis reads well.
    const byAttempt = ui.range === "1w";
    const attemptOrder = byAttempt
      ? Array.from(new Set(activeSeries.flatMap((s) => s.points.map((p) => p.ts)))).sort((a, b) => a - b)
      : [];
    const attemptIndex = new Map(attemptOrder.map((ts, i) => [ts, i]));

    const xFor = (ts) => {
      if (byAttempt) {
        const n = attemptOrder.length;
        if (n <= 1) return padL + plotW / 2;
        return padL + (attemptIndex.get(ts) / (n - 1)) * plotW;
      }
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

    // Date labels: range start and end, or first and last attempt for 1W.
    const startLabelTs = byAttempt ? attemptOrder[0] : cutoff;
    const endLabelTs = byAttempt ? attemptOrder[attemptOrder.length - 1] : now;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(dateLabel(startLabelTs), padL, height - padB + 6);
    ctx.textAlign = "right";
    ctx.fillText(dateLabel(endLabelTs), padL + plotW, height - padB + 6);

    // One smooth line per selected hand mode, plus a dot at each point.
    const seriesPixels = {};
    activeSeries.forEach((series) => {
      const color = colors[series.mode] || "#999";
      const pts = series.points.map((p) => ({ x: xFor(p.ts), y: yFor(p.wpm), ts: p.ts, wpm: p.wpm }));
      seriesPixels[series.mode] = pts;

      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      if (pts.length === 1) {
        ctx.moveTo(pts[0].x - 6, pts[0].y);
        ctx.lineTo(pts[0].x + 6, pts[0].y);
      } else {
        traceMonotoneCurve(ctx, pts);
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

    chartLayout = { width, height, padT, padB, colors, seriesPixels };

    if (hoverX !== null) drawHoverState(ctx);
    else chartTooltip.classList.add("hidden");
  }

  // Draws the white crosshair line and highlighted dots for the nearest
  // point in each visible series, and fills in the tooltip box's content.
  function drawHoverState(ctx) {
    if (!chartLayout) return;
    const { padT, padB, height, colors, seriesPixels } = chartLayout;
    const modes = Object.keys(seriesPixels);
    if (modes.length === 0) return;

    // Find the single closest point overall, to anchor the crosshair.
    let closest = null;
    let closestDist = Infinity;
    modes.forEach((mode) => {
      seriesPixels[mode].forEach((p) => {
        const d = Math.abs(p.x - hoverX);
        if (d < closestDist) {
          closestDist = d;
          closest = { mode, point: p };
        }
      });
    });
    if (!closest) return;

    const snapX = closest.point.x;

    ctx.save();
    ctx.strokeStyle = "#ffffff";
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(snapX, padT);
    ctx.lineTo(snapX, height - padB);
    ctx.stroke();
    ctx.restore();

    const rows = [];
    modes.forEach((mode) => {
      const pts = seriesPixels[mode];
      let nearest = pts[0];
      let nearestDist = Math.abs(pts[0].x - snapX);
      pts.forEach((p) => {
        const d = Math.abs(p.x - snapX);
        if (d < nearestDist) {
          nearestDist = d;
          nearest = p;
        }
      });

      ctx.save();
      ctx.fillStyle = colors[mode] || "#999";
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(nearest.x, nearest.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      rows.push({ mode, wpm: nearest.wpm, ts: nearest.ts, y: nearest.y });
    });

    rows.sort((a, b) => a.y - b.y);
    chartTooltip.innerHTML =
      '<div class="tooltip-date">' + dateLabel(rows[0].ts) + "</div>" +
      rows
        .map(
          (r) =>
            '<div class="tooltip-row"><span class="tooltip-swatch" style="background:' +
            (colors[r.mode] || "#999") +
            '"></span>' +
            (HAND_LABELS[r.mode] || r.mode) +
            " Best WPM: " +
            r.wpm +
            "</div>"
        )
        .join("");
    chartTooltip.classList.remove("hidden");
    chartTooltip.style.left = snapX + "px";
    chartTooltip.style.top = Math.max(rows[0].y - 14, 0) + "px";
  }

  function renderProgress() {
    renderProgressStats();
    drawChart();
  }

  function recordSession(wpm, accuracy, seconds, online) {
    const session = { mode: currentHand, wpm, accuracy, time: Math.round(seconds), ts: Date.now() };
    if (online) session.online = true;
    sessions.push(session);
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

  // Share of the text typed correctly from the start, 0–1. You only move
  // forward in a race while your text matches.
  function correctPrefixFraction(typed) {
    const target = currentEntry.text;
    let i = 0;
    while (i < typed.length && i < target.length && typed[i] === target[i]) i++;
    return target.length ? i / target.length : 0;
  }

  function finishRound() {
    finished = true;
    clearInterval(timerId);
    typingInput.disabled = true;
    const seconds = elapsedSeconds();
    const correctChars = countCorrect(typingInput.value);
    const wpm = computeWpm(correctChars, seconds);
    const accuracy = computeAccuracy(currentEntry.text.length);

    // The top stat row is now the only place these numbers show, so make
    // sure it reflects the exact final values rather than the last 250ms tick.
    statWpm.textContent = String(wpm);
    statAccuracy.textContent = accuracy + "%";
    statTime.textContent = Math.round(seconds) + "s";
    resultCard.classList.remove("hidden");

    if (external) {
      resultHeading.textContent = "Finished!";
      continueBtn.classList.add("hidden");
      recordSession(wpm, accuracy, seconds, true);
      if (external.onFinish) external.onFinish({ wpm, accuracy, seconds });
      return;
    }
    recordSession(wpm, accuracy, seconds);
  }

  function onInput() {
    const typed = typingInput.value;
    if (!startTime && typed.length > 0) {
      startTime = Date.now();
      timerId = setInterval(tick, 250);
      tapHint.classList.add("hidden");
    }
    if (typed.length > 0) tapHint.classList.add("hidden");
    updateHighlighting(typed);
    tick();
    if (external && external.onProgress && !finished) {
      external.onProgress(correctPrefixFraction(typed), Number(statWpm.textContent) || 0);
    }
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
    seriesToggle.querySelectorAll("input[data-series]").forEach((box) => {
      box.checked = ui.series.includes(box.dataset.series);
    });
    onlineToggle.checked = ui.includeOnline;
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
    ui.series = Array.from(seriesToggle.querySelectorAll("input[data-series]:checked")).map(
      (box) => box.dataset.series
    );
    ui.includeOnline = onlineToggle.checked;
    saveUi();
    renderProgress();
  });

  toggleStatsBtn.addEventListener("click", () => applyHideStats(!ui.hideStats));

  progressChart.addEventListener("mousemove", (e) => {
    const rect = progressChart.getBoundingClientRect();
    hoverX = e.clientX - rect.left;
    drawChart();
  });
  progressChart.addEventListener("mouseleave", () => {
    hoverX = null;
    chartTooltip.classList.add("hidden");
    drawChart();
  });

  window.addEventListener("resize", drawChart);

  categorySelect.addEventListener("change", () => resetRound(true));
  nextBtn.addEventListener("click", () => resetRound(true));
  retryBtn.addEventListener("click", () => resetRound(false));
  continueBtn.addEventListener("click", () => {
    if (!external) resetRound(true);
  });
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
    if (external) return;
    if (finished && !resultCard.classList.contains("hidden")) {
      e.preventDefault();
      resetRound(true);
    }
  });

  function stopCountdown() {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }

  function setLights(count) {
    f1LightPods.forEach((pod, i) => pod.classList.toggle("on", i < count));
  }

  function hideLights() {
    f1Lights.classList.add("hidden");
    f1Lights.classList.remove("out");
    setLights(0);
  }

  // Lets race.js drive the typing card with a shared text and start time.
  window.ClarityApp = {
    categories() {
      return Array.from(new Set(AFFIRMATIONS.map((a) => a.category)));
    },
    textsFor(category) {
      const pool = category === "All" ? AFFIRMATIONS : AFFIRMATIONS.filter((a) => a.category === category);
      return pool.map((a) => a.text);
    },
    // Loads `text`, locks the input until `startAtLocal` (a Date.now() value),
    // then starts the clock at that moment.
    beginExternalRound(text, opts) {
      stopCountdown();
      external = { onProgress: opts.onProgress, onFinish: opts.onFinish };
      currentEntry = { category: opts.label || "Live race", text };
      renderTarget();
      typingInput.value = "";
      finished = false;
      errorPositions = new Set();
      clearInterval(timerId);
      startTime = null;
      statWpm.textContent = "0";
      statAccuracy.textContent = "100%";
      statTime.textContent = "0s";
      resultCard.classList.add("hidden");
      continueBtn.classList.add("hidden");
      typingInput.disabled = true;
      tapHint.classList.remove("hidden");

      // Formula 1 start: five red lights come on one per second from
      // `lightsAtLocal`. They all go out at `startAtLocal` (after a random
      // hold chosen by the server), and that is the start.
      const lightsAt = typeof opts.lightsAtLocal === "number" ? opts.lightsAtLocal : opts.startAtLocal - 5000;
      f1Lights.classList.remove("hidden", "out");
      setLights(0);

      const update = () => {
        const now = Date.now();
        if (now < opts.startAtLocal) {
          const lit = now < lightsAt ? 0 : Math.min(5, Math.floor((now - lightsAt) / 1000) + 1);
          setLights(lit);
          tapHint.textContent = lit === 0 ? "Get ready…" : lit < 5 ? "Watch the lights…" : "Wait for lights out…";
          return;
        }
        stopCountdown();
        setLights(0);
        f1Lights.classList.add("out");
        setTimeout(() => {
          if (f1Lights.classList.contains("out")) f1Lights.classList.add("hidden");
        }, 1500);
        tapHint.textContent = "Lights out and away we go!";
        typingInput.disabled = false;
        typingInput.focus();
        startTime = opts.startAtLocal;
        timerId = setInterval(tick, 250);
      };
      update();
      if (typingInput.disabled) countdownTimer = setInterval(update, 50);
    },
    // Shows a message on the finished card, e.g. "2nd place · +2 pts".
    setResultMessage(message) {
      resultHeading.textContent = message;
    },
    // The race ended before you finished.
    stopExternalRound(message) {
      if (!external || finished) return;
      stopCountdown();
      hideLights();
      clearInterval(timerId);
      finished = true;
      typingInput.disabled = true;
      resultHeading.textContent = message;
      resultCard.classList.remove("hidden");
    },
    // Back to solo practice.
    endExternalMode() {
      stopCountdown();
      hideLights();
      external = null;
      tapHint.textContent = "Tap here and start typing…";
      resultHeading.textContent = "Nicely typed.";
      continueBtn.classList.remove("hidden");
      resetRound(true);
    },
    isRacing() {
      return !!external;
    },
  };

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
