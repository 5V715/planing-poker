// Where browsers find each other (signaling). After that they talk directly.
//
// Set `host` to your tailnet signaling server, e.g. the address printed by
// `tailscale serve` on the machine running ./server (see README).
// Leave `host` empty to use the free public PeerJS server instead.
window.PP_CONFIG = {
  signaling: {
    host: "", // e.g. "poker.your-tailnet.ts.net"
    port: 443,
    path: "/",
    secure: true,
  },
};
