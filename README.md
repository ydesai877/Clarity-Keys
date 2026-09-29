# Clarity & Keys — Affirmation Typing Practice

A single-page typing practice app. It shows one of your affirmations, you
type it, and it tracks your words per minute (WPM) and accuracy live.

It has two modes:

- **Solo practice.** Works with no setup. Your history stays in your browser.
- **Live race.** Race friends on the same affirmations, TypeRacer style, over
  a season of 1–24 races (or all of them), with points per race. Live race
  needs a free [Convex](https://www.convex.dev) backend. See "Live race setup".

Live site: https://ydesai877.github.io/Clarity-Keys/

## Files

- `index.html`: the page structure.
- `styles.css`: all styling (light and dark mode).
- `app.js`: solo typing, stats and the progress chart.
- `affirmations.js`: **your content**. Each entry is `{ category, text }`.
- `race.js`: the live race screen (rooms, countdown, progress bars, standings).
- `convex-config.js`: your Convex URL. Race mode stays off until you fill it in.
- `convex/`: the race server code that runs on Convex. GitHub Pages ignores it.
- `vendor/`: a pinned copy of the Convex browser client (Apache-2.0 license).
- `tests/`: server tests. Run them with `npm test`.

## Live race setup (one time, about 5 minutes)

You need Node.js. In Terminal, run `node -v`. If you get "command not found",
install the LTS version from https://nodejs.org first.

1. In Terminal, go to this folder and install the tools:

   ```
   npm install
   ```

2. Create your Convex backend and upload the race code:

   ```
   npx convex dev --once
   ```

   The first time, this opens a browser to log in (GitHub or Google). When it
   asks, choose **create a new project** and name it `clarity-keys`. Wait
   until you see **Convex functions ready!**

3. Show your Convex URL:

   ```
   grep CONVEX_URL .env.local
   ```

   It looks like `CONVEX_URL=https://happy-animal-123.convex.cloud`.

4. Open `convex-config.js` and paste the URL between the quotes:

   ```
   window.CLARITY_CONVEX_URL = "https://happy-animal-123.convex.cloud";
   ```

   This URL is public by design. It is safe to commit.

5. Commit and push:

   ```
   git add -A
   git commit -m "Connect live race to Convex"
   git push
   ```

`.env.local` and `node_modules/` are in `.gitignore`, so they are not uploaded.

**When you change anything in `convex/`**, run `npx convex dev --once` again
to upload the new server code, then commit and push as usual.

## How a live race works

1. Open **Live race**, enter your name, and click **Create a race room**.
   You get a 4-character code. Click **Copy invite link** and send it to
   your friends. The link opens the race tab with the code filled in.
2. The host picks a category and the season length. The slider goes from 1
   to 24 races. Its last stop, **All**, races every affirmation in the
   category once, in random order.
3. The host clicks **Start season**. Everyone gets the same affirmation and a
   Formula 1 start: five red lights come on one per second, then all go out
   after a random 0.2–3 second wait. Lights out is the start, and typing
   unlocks at that moment for everyone.
4. Each player has a car on the track. It moves as you type correct text, so
   a faster typist's car moves faster. Speed lines and wheel spin grow with
   your WPM.
5. **Race score = WPM × accuracy.** For example, 60 WPM at 80% = 48.0, and
   80 WPM at 60% = 48.0. The highest score wins the race, not the first to
   finish. On a tie, the faster time wins. Places are decided when everyone
   has finished or the time limit ends (at least 30 seconds, longer for long
   affirmations). If you don't finish, you get 0 for that race.
6. Points per race: 1st = 3, 2nd = 2, 3rd = 1, everyone else 0.
7. The race winner sees a winner's card with a famous F1 team-radio line. If
   you win after losing 3 or more races in a row, you get the special
   "About time, huh?" line instead. Your losing streak is counted on your
   device and carries across rooms and seasons. Press Enter, Escape or
   Close to dismiss the card.
8. Between races, standings show. The host clicks **Next race** or presses
   Enter. After the last race, the season champion is shown. The host can
   change the settings and start a new season.

Other details:

- If you refresh the page, you rejoin your room and keep your points.
- If the host leaves or goes offline for 20 seconds, the next player becomes
  host.
- Someone who joins mid-race sits out that race and races from the next one.
- The server checks each finish time. A reported WPM more than 25% above what
  the server-measured time allows is replaced by the server's figure.

**Race results in your stats:** each race you finish is saved to your
history with your selected hand mode, marked as online. The **Online races**
checkbox under the progress chart controls whether those results appear in
the chart and the stats table. Untick it to see solo practice only.

## Run it locally

Start a small local server in this folder:

```
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## GitHub Pages

The site deploys from the `main` branch, root folder
(**Settings → Pages → Deploy from a branch**). Every push goes live within a
minute or two.

## Updating your affirmations

Edit `affirmations.js`, then:

```
git add affirmations.js
git commit -m "Update affirmations"
git push
```

New affirmations are available in races immediately. You do not need to
re-run Convex for content changes.
