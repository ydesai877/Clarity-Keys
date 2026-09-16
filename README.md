# Clarity & Keys — Affirmation Typing Practice

A small, single-page typing practice app: it shows one of your affirmations,
you type it, and it tracks your words-per-minute (WPM) and accuracy live.
No build step, no dependencies — it is three plain files plus your content.

## Files

- `index.html` — the page structure
- `styles.css` — all styling (works in light and dark mode)
- `app.js` — the typing logic and stats
- `affirmations.js` — **your content**. Edit this file to add, remove, or
  change what you practice. Each entry is `{ category, text }`.

Your best WPM, average accuracy, and session count are saved in your
browser's local storage, so they persist between visits on the same device.

## Run it locally

No server needed — just open `index.html` in a browser. If your browser
blocks local file scripts, run a tiny local server instead:

```
python3 -m http.server 8000
```

then open `http://localhost:8000`.

## Put it on GitHub

1. Create a new repository on GitHub (via github.com — click **New**), for
   example named `clarity-keys`. Leave it empty (no README/license), since
   this folder already has one.
2. From inside this folder, connect it to that repo and push:

   ```
   git remote add origin https://github.com/<your-username>/clarity-keys.git
   git branch -M main
   git push -u origin main
   ```

   (This folder is already a git repository with one commit, so this is
   the only push you need to do the first time.)

## Access it from your phone (GitHub Pages)

1. On GitHub, open the repo → **Settings** → **Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a
   branch**, branch **main**, folder **/ (root)**. Save.
3. GitHub gives you a URL that looks like
   `https://<your-username>.github.io/clarity-keys/`. It takes a minute
   or two to go live the first time.
4. Open that URL on your phone and bookmark it, or use your phone
   browser's "Add to Home Screen" option so it behaves like an app icon.

## Updating your affirmations later

Edit `affirmations.js`, then:

```
git add affirmations.js
git commit -m "Update affirmations"
git push
```

GitHub Pages will redeploy automatically within a minute or two.
