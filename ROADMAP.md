# SHAKARA: road to a real launch

The v0.1 prototype proves the core: browser 5v5, online rooms, bots, and street rules. This is the plan to go from "friends can play a link" to a launched game in Nigeria first, then Africa.

## Phase 1: Closed beta (weeks 1–4)

Goal: 100 to 300 real players in Lagos, and learn whether the game is fun.

- **Feedback loop:** an in-game "rate this match" prompt, plus a WhatsApp beta group. Track match length, rematch rate, drop-offs and ping by city.
- **Game feel:** tune tackle timing, keeper skill and shot power with real players. Add player switching (auto-switch to the player nearest the ball), a human keeper option, a sprint stamina UI and haptics.
- **Art:** turn the look pack into sprite sheets (4 to 6 characters × run/kick/tackle/celebrate, top-down), kits from team_kits.svg, a stadium of street props, and an animated goal celebration. Keep the total under 1 to 1.5 MB with WebP sprite atlases and lazy-loading after the lobby.
- **Audio:** recorded Pidgin commentary voice lines, crowd ambience and a whistle, as compressed Opus/MP3 at about 300 KB total, loaded after the first match starts.
- **Analytics:** privacy-light events (PostHog or self-hosted Plausible), with no personal data.

## Phase 2: Accounts, friends and identity (weeks 4–8)

- **Accounts:** phone number + OTP (the default in Nigeria; via Termii, Africa's Talking or Twilio Verify) with Google sign-in as an option. Guest play stays: you can upgrade a nickname to an account at any time.
- **Profile:** username, avatar (from the character set), favourite team and city, and stats (goals, assists, wins, MOTM).
- **Friends list:** add by username, phone contacts (opt-in, hashed) or "people I played with". See who's online, invite straight to a room, and get push notifications (web push + FCM in the app).
- **Parties:** 2 to 5 friends queue together into quick match as a unit.
- **Database:** Postgres (Supabase or Neon) for accounts and stats, Redis for presence, matchmaking queues and room routing.

## Phase 3: Ranked and competition (weeks 8–14)

- **Ranked 5v5** with seasons (6 to 8 weeks). Use Glicko-2 or TrueSkill MMR (team-based), with visible tiers: *Area Boy → Street Legend → Agbero → Baba → Odogwu*. Placement matches come first, with decay for inactivity.
- **Matchmaking:** queue by MMR band + region + party size, widening the band over time. Bots only fill in casual; ranked needs 5v5 humans (or 4v4 with bot keepers to start).
- **Leaderboards:** by city, state and country, plus weekly "estate vs estate" community cups.
- **Tournaments:** creator-hosted brackets, school and estate leagues, and sponsor cups.
- **Replays:** store input logs + seed so the server-side replay is tiny. Shareable 10-second highlight clips go to WhatsApp Status and TikTok, which is the biggest organic growth lever.

## Phase 4: Mobile app wrappers (in parallel with Phase 2)

- **Android first (Play Store):** wrap the PWA as a **Trusted Web Activity** with Bubblewrap. It's the same web code, with no WebView performance hit, and it gets a Play listing and install. It needs a Google Play developer account (**$25 one-time**), Digital Asset Links on the domain, and a 512 px icon + feature graphic (we have those from the look pack). It updates instantly with each deploy.
- **If native features are needed** (better haptics, background push, contacts, in-app purchases through Play Billing), move to **Capacitor** with the same web code inside.
- **iOS:** Capacitor build for the App Store (**$99/year** Apple developer). Apple doesn't accept thin web wrappers well, so ship it with native push, haptics and IAP.
- **Lite size:** keep the APK small (TWA APK is under 1 MB) and the in-game download under 3 MB. That suits low-storage phones.

## Phase 5: Infrastructure, regions and cost

**Regional game servers.** Ping is the experience. The plan:

| Region | Option | Why |
|---|---|---|
| Lagos (West Africa) | Local VPS/bare metal (e.g. Melbicom Lagos VPS; DataPacket Lagos dedicated from about $440/mo for high volume; Rack Centre, MainOne/Equinix LG) | the lowest ping for the core Nigerian audience (≈10–40 ms in Lagos vs ≈150–200 ms to Europe) |
| Johannesburg (South & East Africa) | Google Cloud africa-south1 (e2-small ≈ $13/mo on-demand), AWS af-south-1 (Cape Town), or Azure South Africa North | SA, Kenya, Ghana fallback |
| Europe (diaspora + fallback) | Hetzner / OVH / Fly.io in London or Frankfurt | cheap, with good links to West Africa via undersea cables |

- **Room routing:** a small "lobby/matchmaker" service (stateless, anywhere) picks the region with the best measured ping for the party (each client pings each region's `/health` on the home screen). The room code embeds the region (e.g. `L-PXWEW`), and the share link goes straight to the right box.
- **Scaling:** one Node process handles **hundreds of concurrent rooms** (a 6-minute match costs about 0.15 s of CPU). Scale by adding processes and boxes; rooms are independent (sharding by room). Use `uWebSockets.js` if a single box needs to hold more connections.
- **Later option:** managed game-server fleets (Edgegap, AWS GameLift, Rivet) if we need automatic placement in many cities.

**Data use per player:** about 3 KB/s down and 0.2 KB/s up, so about 11 MB per hour of play. That's cheap for players on ₦ data plans, and it's worth advertising ("1 match ≈ 1 MB").

**Rough monthly running cost** (estimates; validate with real usage):

| Stage | Concurrent players | Servers | Est. cost / month |
|---|---|---|---|
| Beta | ≤ 200 | 1 small box (Lagos or EU) + free-tier DB | **$10–30** |
| Launch (Nigeria) | 1,000–3,000 | 2–3 boxes Lagos + 1 Johannesburg, managed Postgres + Redis | **$150–400** |
| Growth (Africa) | 10,000+ | 10–20 boxes across regions, CDN, monitoring | **$1,500–4,000** |

Bandwidth is small: at ≈$0.09/GB cloud egress, one player-hour costs ≈ $0.001. Other fixed costs: domain (≈$15/yr), Play account $25 once, Apple $99/yr, SMS OTP (≈$0.01–0.03 per verification in Nigeria; prefer WhatsApp OTP or Google sign-in where possible), and error monitoring (Sentry free tier at first).

## Phase 6: Anti-cheat and safety

- **Already true:** the server is authoritative. Clients only send inputs, so no client can teleport, change the score or speed up.
- **Next steps:**
  - input validation (rate, values) and kicking players whose inputs are impossible,
  - per-IP/device rate limits on room creation and joins,
  - signed session tokens once accounts exist,
  - server-side replay checks for ranked (detect macro or impossible reaction patterns),
  - report-a-player with replay attached,
  - match outcomes and MMR computed only on the server.
- **Ranked integrity:** a phone number per ranked account (makes smurfing and win-trading harder), and party restrictions by MMR gap.
- **Safety:** name filter (English + Pidgin + Yoruba/Igbo/Hausa slurs list), quick-chat only (preset Pidgin phrases) before any free text chat, and block/mute. Protect minors: no open chat by default, and a guardian-friendly policy.

## Phase 7: Monetisation (fair, no pay-to-win)

1. **Cosmetics (core):** kits (club, estate, school, Ankara/Adire patterns), boots, hairstyles, celebrations ("shaku shaku", "zanku", "the Yaw"), goal effects, ball skins, pitch themes (Lagos beach, Kano dust, Enugu rain), and announcer voice packs (Pidgin, Yoruba, Igbo, Hausa).
2. **Season pass** (₦1,000–2,000 per season): a free track + paid track of cosmetics, with challenges like "score 5 volleys".
3. **Local payments:** Paystack/Flutterwave (cards, bank transfer, USSD), plus mobile money for Ghana and Kenya, and airtime billing (carrier billing via aggregators) for players without cards. In the app: Google Play Billing (required for digital goods in Play apps).
4. **Brands and sponsors:** in-pitch wall ads (the walls are already ad boards!), sponsored tournaments (telcos, drinks, betting-free brands), and branded kits for real local teams and academies.
5. **Creator tools:** private leagues for estates, schools and companies (₦ per league per season).
6. **Rewarded ads** (optional, opt-in): watch an ad for a cosmetic crate. Never mid-match.

Rule of thumb: nothing you buy changes speed, power or skill.

## Phase 8: Growth

- WhatsApp-first sharing (already built in): room links, highlight clips, "I beat you 5–2" result cards.
- Campus and estate ambassadors, 5-a-side pitch partnerships (real-world street football communities), and Afrobeats artist celebrations as limited cosmetics.
- Local press and TikTok creators; launch a "Lagos vs Abuja" city cup.

## Immediate next steps (suggested order)

1. Get a real domain + name check (SHAKARA trademark/app-store search), and move off the working slug.
2. 2-week closed beta with friends; fix feel and balance.
3. Sprite art + audio pass (size-budgeted).
4. Phone OTP accounts + friends + parties.
5. Play Store TWA beta.
6. Lagos server region.
7. Ranked season 0.
