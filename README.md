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

Browsers need a small *signaling* server only to find each other. By default that's PeerJS's
free public server; on a Tailscale network you can run your own (below) so nothing leaves the tailnet
for signaling.

## Private signaling on your tailnet

On any always-on machine in the tailnet (Node 18+):

```sh
cd server
npm install
npm start                    # listens on 127.0.0.1:9000 only
tailscale serve --bg 9000    # HTTPS on https://<machine>.<tailnet>.ts.net
```

`tailscale serve` needs HTTPS certificates turned on for the tailnet (admin console → DNS → HTTPS).
Then set the host in `config.js` and push to `main`:

```js
signaling: { host: "<machine>.<tailnet>.ts.net", port: 443, path: "/", secure: true }
```

Notes:
- Only people on the tailnet can join; anyone else sees "Can't reach … — retrying…".
- Chrome may ask once to allow the page to access devices on your local network. Click **Allow**.
- To keep the server running after reboots, use a systemd service, `pm2`, or similar.
- You can try a server without changing `config.js` by adding
  `?peerhost=<host>&peerport=443&peerpath=/` to the page URL. Invite links keep these params.

## Deploying

The workflow in `.github/workflows/pages.yml` publishes the site on every push to `main`.
One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

## Local development

Any static server works, e.g. `python3 -m http.server` and open http://localhost:8000.
