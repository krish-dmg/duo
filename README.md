# duo

Two-person voice + screen share, built for the case where one side has a good
connection and the other does not.

Runs on Cloudflare Workers. Media never touches the server — audio and video go
peer to peer, with Cloudflare TURN only as a fallback path when a direct
connection cannot be established.

---

## Deploy

```bash
npm install
npx wrangler login
npx wrangler deploy
```

That is enough to have a working call. Open the URL it prints, you get bounced
to a random room, and you send that link to your friend.

### Add TURN (do this — it matters)

Without TURN, a direct connection fails on symmetric NAT, most mobile carriers,
and some corporate/campus networks. Cloudflare's TURN is free up to 1000 GB
egress per month, which at these bitrates is thousands of hours of calling.

1. Cloudflare dashboard → **Realtime** → **TURN** → create an app.
2. Copy the key ID and API token, then:

```bash
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_KEY_API_TOKEN
```

Redeploy. The app picks it up automatically and the "Force TURN relay" toggle
becomes available.

### Local development

```bash
npx wrangler dev
```

Open the printed localhost URL in two browser windows. `localhost` counts as a
secure context, so the microphone works without HTTPS.

---

## Why this is built the way it is

**Voice and screen share are two separate peer connections.**
This is the single most important decision in the codebase. Each
`RTCPeerConnection` runs its own bandwidth estimator. On one shared connection,
a screen share that saturates a weak uplink will starve the voice stream — that
is exactly the "his voice shatters when he shares his screen" symptom. Split
apart, the screen share can collapse to nothing and the voice stream never
notices. It also means starting or stopping a share never renegotiates the audio
connection, so nobody drops out mid-sentence.

**Both connections are fully negotiated the moment you join, using placeholder
transceivers with no track attached.** Starting a share is a `replaceTrack()`
call on an already-negotiated sender: no new SDP exchange, no ICE round trip, no
race. This is the fix for "I share my screen and it never shows up on his end,"
which is almost always a renegotiation that got lost or collided on a flaky
link.

**Opus RED is on by default.** RED packs a copy of each audio frame into the
following packets, so a lost packet is reconstructed from its neighbours rather
than concealed. Measured against no redundancy: at 20 percent packet loss,
concealment drops from about 18 percent to under 1 percent. It costs roughly
double the voice bitrate, which at 40 kbps is still nothing. Opus in-band FEC
layers on top of it. If his voice is shattering, this is the setting doing the
work.

**Screen share defaults to sharp and slow, not smooth and blurry.**
`degradationPreference` is set to `maintain-resolution` with a 5 fps cap and
`contentHint = 'text'`. Unreadable code at 30 fps is useless; readable code at
5 fps is what you actually want when you are pointing at a function. On a weak
uplink this is the difference between a usable share and a smear.

**Negotiation uses the perfect-negotiation pattern** with roles assigned by the
server, so the two sides can never deadlock arguing over who offers first. The
person already in the room is polite and yields on collisions; the newcomer
drives. ICE restarts happen automatically on `failed`, and after a 3-second
grace period on `disconnected`.

---

## Tuning it for his connection

Start here and adjust from what the stats panel says.

| Symptom in the stats panel | What to change |
|---|---|
| `voice concealed` above 2 percent | RED is already on; raise **latency vs stability** to Stable or Rough link |
| `voice in loss` high only while sharing | Leave "Protect voice" on — it is already throttling. Drop screen bitrate manually if it is not enough |
| `rtt` above 200 ms | Try **Force TURN relay**. Cloudflare's anycast path is sometimes shorter than the direct one |
| `screen limited by: cpu` | Switch codec to **VP8** or **H264** — his machine cannot keep up with VP9/AV1 |
| `screen limited by: bandwidth` | Lower **max bitrate**, keep resolution, drop frame rate to 2-3 |
| Screen share is sharp then goes soft | Frame rate is stealing the bitrate. Use the Code/text profile |
| Connection keeps dying | **Repair connection** forces an ICE restart without dropping the call |

The **Ask peer for** panel sets the caps on *his* encoder from *your* side. This
is deliberately there so you can fix his settings without walking him through
menus while the audio is already breaking up.

### Sensible starting point for a weak uplink

- Latency: **Balanced** (80 ms). Move to Stable only if it breaks up.
- Outgoing voice: 40 kbps. His outgoing: 24-32 kbps — Opus is clean down there.
- RED: on. FEC: on. DTX: off (turn it on only if his uplink is truly tiny).
- Screen: Code/text profile, 500-700 kbps, 3-5 fps, VP9. Drop to VP8 if his CPU
  is loaded.

A call configured like this needs roughly 100-150 kbps for voice in each
direction, plus whatever the screen share is capped at.

---

## Notes

- The room link is the credential. It is 144 bits of randomness and the page
  sends `Referrer-Policy: no-referrer` so it cannot leak through outbound links.
  Rooms hold two people; a third gets refused.
- Media is encrypted end to end by WebRTC's DTLS-SRTP. Even when relayed through
  TURN, Cloudflare forwards encrypted packets and cannot read them.
- Desktop Chrome, Edge, or Firefox. Screen sharing is unavailable on mobile
  browsers; voice works fine there.
- Cost at these bitrates is effectively zero. Workers' free tier covers the
  signalling, and TURN only carries traffic when a direct connection fails.
