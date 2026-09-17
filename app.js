(function () {
  "use strict";

  const STORAGE_KEY = "clarity-keys-stats-v1";

  const categorySelect = document.getElementById("category-select");
  const nextBtn = document.getElementById("next-btn");
  const retryBtn = document.getElementById("retry-btn");
  const targetTextEl = document.getElementById("target-text");
  const typingInput = document.getElementById("typing-input");
  const categoryTag = document.getElementById("category-tag");

  const statWpm = document.getElementById("stat-wpm");
  const statAccuracy = document.getElementById("stat-accuracy");
  const statTime = document.getElementById("stat-time");

  const resultCard = document.getElementById("result-card");
  const resultWpm = document.getElementById("result-wpm");
  const resultAccuracy = document.getElementById("result-accuracy");
  const resultTime = document.getElementById("result-time");
  const continueBtn = document.getElementById("continue-btn");

  const bestWpmEl = document.getElementById("best-wpm");
  const avgAccuracyEl = document.getElementById("avg-accuracy");
  const sessionsCountEl = document.getElementById("sessions-count");

  let currentEntry = null;
  let pool = [];
  let startTime = null;
  let timerId = null;
  let errorPositions = new Set();
  let finished = false;

  function loadStats() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { sessions: 0, bestWpm: 0, accuracySum: 0 };
      return JSON.parse(raw);
    } catch (e) {
      return { sessions: 0, bestWpm: 0, accuracySum: 0 };
    }
  }

  function saveStats(stats) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
    } catch (e) {
      // localStorage unavailable — stats just won't persist this session.
    }
  }

  function renderBestStats() {
    const stats = loadStats();
    bestWpmEl.textContent = stats.sessions > 0 ? stats.bestWpm : "—";
    avgAccuracyEl.textContent =
      stats.sessions > 0 ? Math.round(stats.accuracySum / stats.sessions) + "%" : "—";
    sessionsCountEl.textContent = stats.sessions;
  }

  function recordSession(wpm, accuracy) {
    const stats = loadStats();
    stats.sessions += 1;
    stats.bestWpm = Math.max(stats.bestWpm, wpm);
    stats.accuracySum += accuracy;
    saveStats(stats);
    renderBestStats();
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

    recordSession(wpm, accuracy);
  }

  function onInput() {
    const typed = typingInput.value;
    if (!startTime && typed.length > 0) {
      startTime = Date.now();
      timerId = setInterval(tick, 250);
    }
    updateHighlighting(typed);
    tick();
    if (typed.length >= currentEntry.text.length && !finished) {
      finishRound();
    }
  }

  categorySelect.addEventListener("change", () => resetRound(true));
  nextBtn.addEventListener("click", () => resetRound(true));
  retryBtn.addEventListener("click", () => resetRound(false));
  continueBtn.addEventListener("click", () => resetRound(true));
  typingInput.addEventListener("input", onInput);
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

  buildCategoryOptions();
  renderBestStats();
  resetRound(true);
})();
