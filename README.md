# Planning Poker

A tiny, serverless planning poker app that runs on GitHub Pages.

1. Enter your name and click **Create new session** — you get a session token like `K7QM3XPA`.
2. Click **Copy invite link** and send it to your team (or share the token; others can paste it under *Have a session token?*).
3. Everyone picks a card (Fibonacci or T-shirt sizes — switch the deck in the room; it changes for everyone). Votes stay hidden until someone clicks **Reveal cards**.
4. See the average, the spread, and whether you hit consensus. Click **New round** to go again.
5. Paste a ticket link into the topic (press Return to save) — Jira and GitHub links get short labels like `SHOP-142` and are clickable.
6. Every revealed round is kept in **History** (saved in your browser per session). Tap a round to see who voted what, **Vote again** to re-estimate it, or **Copy as text** to paste the results elsewhere.

## Linear (optional)

Tap the Linear logo next to **Copy invite link** to connect your own Linear account:
enter your workspace slug, tap **Create API key in Linear** (opens Linear's "new API key" page),
paste the key and **Connect**. The key is only sent to `api.linear.app` — never to other players.
**Remember on this device** keeps it in this browser until you tap **Forget key**; note that other
sites on the same address (other GitHub Pages projects of this account) could read saved data.
With Linear connected, put a Linear ticket link (or just its key, e.g. `ENG-142`) in the topic:
your browser loads the title, state, current estimate and formatted description, shares them
with the room, and switches the cards to that team's estimation scale (Fibonacci, Exponential,
Linear or T-shirt, including "allow zero" and "extended"). Players without Linear see it too.
Grey logo = not connected, colourful logo with rainbow ring = connected, amber dot = key not working.

## How it works

No backend. Browsers connect to each other directly over WebRTC using [PeerJS](https://peerjs.com).
The session token maps to a fixed peer ID: the first person in the session claims it and holds the
room state; everyone else connects to them. If that person leaves, the others automatically take
over and keep going (topic and votes carry over).

PeerJS's free public server is used only to introduce browsers to each other. To use your own
[PeerServer](https://github.com/peers/peerjs-server), add query params:
`?peerhost=peer.example.com&peerport=443&peerpath=/`.

## Deploying

The workflow in `.github/workflows/pages.yml` publishes the site on every push to `main`.
One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

## Local development

Any static server works, e.g. `python3 -m http.server` and open http://localhost:8000.
