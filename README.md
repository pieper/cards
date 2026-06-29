# Cards

A small collection of card games — pure HTML/CSS/JS, no build step, no
dependencies, no tracking. More games (bridge, …) may be added over time.

**Play:** https://pieper.github.io/cards/ &nbsp;·&nbsp; the site root is **Klondike Solitaire**.

---

## Klondike Solitaire

A clean, ad‑free Klondike solitaire. Drag or *throw* cards to play, turn‑3,
double‑click to send a card up to the foundation, and a little reward on a win.

## Features

- **Traditional card design** — pick a deck from the toolbar. Both are bundled
  locally as SVGs under `assets/decks/`:
  - **Classic** — Byron Knoll's *Vector Playing Cards* (public domain).
  - **English** — Dmitry Fomin's *English‑pattern* deck (CC0).
  Your choice is remembered between sessions.
- **Turn‑3** dealing (toggle to turn‑1 in the toolbar).
- **Drag to play** — grab a card or a valid run and drop it on a pile.
- **Throw‑to‑play physics** — flick a card and let go; if there's a legal move in
  the direction you threw it, the card is pulled there with a damped spring
  (lively, but never wild). Tune `SPRING_K` / `SPRING_D` / `THROW_*` at the top
  of `solitaire.js`.
- **Autoplay when obvious** — safe cards fly to the foundations automatically
  (toggle off if you prefer). **Double‑click** any top card to send it home,
  and an **Auto‑finish** button appears once the game is decided.
- **Undo** every move.
- **Win screen art** — on a win it pulls a random image. About **1 in 3** is a
  portrait (live from Wikimedia Commons, a real public repo, no API key); the
  rest are nice random photos of any subject (Lorem Picsum).

## Run locally

Just open `index.html`, or serve the folder:

```sh
python3 -m http.server 8000   # then visit http://localhost:8000
```

## Host on GitHub Pages

1. Create a repo and add `index.html`, `styles.css`, `solitaire.js` (this folder).
2. Push to GitHub.
3. Repo **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   pick `main` / root, save.
4. Your game is live at `https://<user>.github.io/<repo>/`.

Everything runs client‑side, so HTTPS "just works" via GitHub's certificate.

## Customizing the win images

Edit the `WIN_IMAGE` config near the top of `solitaire.js`:

- `portraitOdds` — chance of the portrait branch (default `1/3`).
- `commonsCategory` — any Wikimedia Commons category name.
- `genericUrl` — swap in any image URL generator (e.g. your own GitHub‑hosted
  folder of favorites).

## Credits / license

Card faces are bundled in `assets/decks/` so the game has no runtime dependencies:

- **Classic** — *Vector Playing Cards* by Byron Knoll, released into the **public domain**.
- **English** — *English‑pattern* deck by Dmitry Fomin, **public domain (CC0)** via Wikimedia Commons.

Everything else here is yours to do with as you like.

> Note: Unsplash's old key‑free `source.unsplash.com` endpoint was retired, which
> is why the portrait branch uses Wikimedia Commons. If a fetch ever fails it
> silently falls back to a Picsum photo so the win screen always shows something.
