# Planning Poker

A tiny, serverless planning poker app that runs on GitHub Pages.

1. Enter your name and click **Create new session** — you get a session token like `K7QM3XPA`.
2. Click **Copy invite link** and send it to your team (or share the token; others can paste it under *Have a session token?*).
3. Everyone picks a card. Votes stay hidden until someone clicks **Reveal cards**.
4. See the average, the spread, and whether you hit consensus. Click **New round** to go again.

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
