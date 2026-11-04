// PeerJS signaling server for Planning Poker.
// Listens on localhost only; expose it to your tailnet with:  tailscale serve --bg 9000
const express = require("express");
const { ExpressPeerServer } = require("peer");

const PORT = Number(process.env.PORT || 9000);
const HOST = process.env.HOST || "127.0.0.1";

const app = express();

// The app is served from github.io (public) but this server lives on a private
// tailnet address. Chrome asks the private server to opt in to that.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  next();
});

const server = app.listen(PORT, HOST, () =>
  console.log(`Signaling server on http://${HOST}:${PORT} — run: tailscale serve --bg ${PORT}`)
);

app.use("/", ExpressPeerServer(server, { path: "/", proxied: true, allow_discovery: false }));
