# How SHAKARA works (v0.1 prototype)

A plain-English tour of the game's code, written for a designer. It doesn't assume you've coded before.
Live: https://naija5-proto.sites.tab.bot/ · Code: this repo.

---

## 1. The big picture: phones and one referee

Every player opens the game in a browser. That browser is the **client**. All the clients connect to one small computer on the internet, the **server**.

```
   Tunde's phone        Chioma's phone        Emeka's laptop
   (client)             (client)              (client)
       │  "I'm pressing     │                     │
       │   right + SHOOT"   │                     │
       ▼                    ▼                     ▼
 ┌──────────────────────────────────────────────────────────┐
 │                    SERVER  (the referee)                  │
 │  runs the real match: players, ball, bots, score, clock   │
 └──────────────────────────────────────────────────────────┘
       │   "here is where everyone and the ball are now"  (15× a second)
       ▼                    ▼                     ▼
   draws the picture    draws the picture     draws the picture
```

- The **server is the authority**: it alone decides where the ball goes, who scored and how much time is left.
- A **client** only does two things. It sends what you're pressing, and it draws what the server says happened.
- Why do it this way? If each phone decided for itself, two phones would disagree ("it was a goal on mine!"), and a hacked phone could simply say "I scored 10". With one referee, everyone sees the same match and cheating is much harder.

## 2. The game loop and the "tick"

The server runs the match in small steps called **ticks**: **30 ticks per second** (`TICK_HZ`, `public/shared/sim.js` line 5). On every tick the server:

1. reads the latest buttons from each human player,
2. lets each bot decide what to press (section 7),
3. moves every player a tiny bit (MARK steers you automatically, see section 5),
4. moves the ball (rolling friction, bounces off the walls, goals),
5. checks the rules: tackles, pickups, keeper saves, calls for the ball, the clock, goals, half time and full time.

Every 2nd tick (**15 times a second**, `SNAP_EVERY`, line 7) it sends each player a **snapshot**: one small binary message of about 130 bytes with every player's position, the ball, the score and the clock. A whole match uses about 1 MB of data per player. That's cheap on Nigerian mobile data.

```
time ─▶  tick tick tick tick tick tick ...   (every 33 ms)
                snap      snap      snap     (every 67 ms → to all phones)
```

## 3. Why it still feels smooth at 300 ms ping

A message from Lagos to the server and back can take 150 to 300 ms (the **ping**). Without tricks, your player would move a third of a second after you push the stick. The client uses three tricks:

**Prediction (your own player).** Your phone runs the same movement rules as the server (`movePlayer()`, `sim.js` line 74), so it moves your player **immediately**. Each input carries a number (1, 2, 3…). When a snapshot comes back saying "I've used your inputs up to number 57", the phone starts from the server's position and re-applies inputs 58, 59… on top. If the two disagree slightly, the phone slides the difference away over a split second instead of jumping. This is `reconcile()` in `public/main.js` line 229.

**Interpolation (everyone else).** Other players and the ball are drawn about 0.1 to 0.2 seconds "in the past", sliding smoothly between the last two snapshots instead of jumping 15 times a second. That's `sampleState()` (line 505).

**Kick prediction.** When you pass or shoot, your phone launches the ball straight away on your screen and then blends it into the server's ball when the server's answer arrives (line 282).

Measured in testing, with a fake 288 ms ping: your player starts moving within about 50 ms of pressing, the server confirms about 355 ms later, and the correction is only 3 to 7 **millimetres**. In other words, you can't see it.

## 4. The camera

It's a close overhead camera with a slight tilt, like the in-match view in EA Sports FC Mobile:

- It aims **halfway between you and the ball**, with a small look-ahead in the direction the ball is travelling, and glides there smoothly instead of snapping (line 559).
- It never lets the ball leave the screen. If you're far from the action, it leans toward the ball.
- On phones it shows about **21 m** of pitch across the screen (27 m on laptops), so players look big. That zoom is one number: `VW`, line 409.
- A **minimap** in the top-right corner shows all 10 players (Lions yellow, Warriors green, you in white) and the ball. If the ball is off-screen, a white dot on the screen edge points to it.

## 5. Controls: what your phone sends

About 30 times a second, your phone sends a 6-byte message: a counter, the joystick direction (x and y), and which buttons are held. It never sends "my position". The server works that out itself.

```
 ┌───────────────────────────────────────────────────────────────┐
 │ ☰                 LIONS 1 │ 0 WARRIORS              minimap ▣ │
 │                      1ST HALF 2:41                             │
 │                                                    [DEFENDING] │
 │                                                  (MARK)        │
 │   ( joystick )                         (TACKLE)       (SHOOT)  │
 │   left thumb, anywhere          (CALL)                         │
 │   on the left side                          (PASS)             │
 └───────────────────────────────────────────────────────────────┘
```

| Button | Phone | Laptop | What it does |
|---|---|---|---|
| Move | joystick (left thumb, floats to wherever you touch) | WASD / arrows | run |
| SHOOT | big yellow | K (hold) | hold to charge power (bar under your player), release to shoot. Aim with the stick |
| PASS | big green | J or Space | passes to the best teammate in the direction you're facing, or to whoever just called for it |
| TACKLE / SPRINT | orange | L (tackle), Shift (sprint) | when defending: tap = slide tackle, keep holding = sprint. With the ball (or when your team has it), it's just sprint and the label changes to SPRINT |
| MARK | small violet | X (hold) | hold while defending: your player automatically shadows the opponent with the ball (or the one nearest to it), stays **goal-side** about 1.2 to 1.6 m away and faces the ball. A dashed pink ring shows who you're marking. Let go and you're back in control |
| CALL | small pink | C | "pass it to me!" When a teammate has the ball: a **bot passes to you straight away** if the lane is reasonably open. A **human** sees a bouncing PASS! bubble over you, their phone buzzes, their PASS button flashes, and their next pass goes to you for about 2 seconds. A 2.5-second cooldown stops spamming |

**Attack vs defend context.** A label above the buttons says YOUR BALL, ATTACKING, DEFENDING or LOOSE BALL, and the buttons follow it. SHOOT and PASS light up when you have the ball. MARK glows when you're defending. CALL glows when a teammate has the ball. TACKLE renames itself SPRINT when you're attacking. Buttons that can't do anything right now are dimmed (line 697).

**How MARK works under the hood.** `markTarget()` and `markInput()` (`sim.js` lines 130 and 142) pick the man and work out the goal-side spot. Far from him, you move at full speed to get there. Once you're close, you move at 90% speed, like jockeying (`MARK_SPEED`, line 21). The server does this for real (line 218), and your phone predicts the same steering so it feels instant (`main.js` line 264).

**How CALL works under the hood.** The server checks the cooldown and that a teammate has the ball (`sim.js` line 234), then tells that teammate "your next pass goes to the caller". Bots act on it at once (line 513). The bouncing bubble is drawn in `main.js` line 591.

Touch buttons are set up in `setupTouch` (`main.js` line 345) and laid out in `public/style.css` from line 99. Keys are read in `readInput()` (line 326).

## 6. Rooms, codes, share links and quick match

All of this lives in `server/server.js`.

- **Create room.** The server makes a 5-letter code with no I or O, so they can't be mistaken for 1 and 0 (`makeCode`, line 80), for example `PXWEW`.
- **Share link.** The link is `https://…/?room=PXWEW`. When a friend opens it from WhatsApp, the page reads `?room=` and drops them straight into the lobby. The WhatsApp button builds the message (`shareText()` in `main.js`, line 105).
- **Join with code.** This does the same thing, typed by hand.
- **Lobby.** You can have up to 4 humans per team. The keeper is always a bot for now. The host (whoever created the room) picks the half length, chooses public or private, and presses START. If the host drops, the crown passes to someone else.
- **Bots fill the gaps.** Every match always has 5 players per side. A human simply takes over a bot's body. If someone joins mid-match, they take a bot's place. If someone leaves, a bot takes over again.
- **Dropped connection.** Phones lose signal, so the server keeps your seat for 25 seconds (`GRACE_MS`, line 20). Your phone reconnects by itself and you're back in. If the server itself restarts (for example when we put out a new version), everyone is put back into a lobby with the same room code.
- **Quick match** (line 211). The server looks at all public rooms with space and scores each one by how close it is to you: the same country gets +3, the same timezone +1, and within about 60 km another +3 (only if you allowed location). You join the best one. If there's none, you become the host of a new public room that others nearby will find.
- **Privacy.** Your location is rounded to about 50 km (half a degree) before it leaves your phone, and it's only kept in memory while you're online. Nothing is saved. With no location, the country comes from your phone's timezone or language setting.
- **Rematch.** At full time, the host's REMATCH restarts immediately. If everyone else votes rematch, it also restarts.

## 7. How the bots think

Each bot "presses buttons" just like a human would. It decides fresh on every tick (`think()`, `sim.js` line 460):

```
Am I the keeper? ──yes──▶ stand between the ball and the goal centre
       │                  rush the ball if it's loose in my box
       │                  dive at hard shots; when I catch it, pass to a free teammate
       no
       ▼
Do I have the ball? ──yes──▶ a teammate CALLED for it?  → pass to them (if the lane is open)
       │                     close to goal (<11 m)?       → SHOOT at the corner away from the keeper
       │                     opponent right on me?        → PASS to the most open teammate
       │                     otherwise                    → dribble toward goal, away from pressure
       no
       ▼
Am I my team's closest bot to the ball (and no human is closer)?
       ──yes──▶ chase it; if an opponent has it, try a slide tackle
       no
       ▼
Go to my spot in the 2-2 shape, sliding with the ball and pushing up when we attack
```

Bots run 7% slower than humans, so you can beat them. Bots also prefer passing **to humans**, so you get the ball more. The keeper isn't perfect: a hard, well-placed shot has a fair chance of beating him (line 394). In bot-only test matches, about 5 to 7 goals go in per 6-minute game, which is lively, like real street football.

## 8. Rules of SHAKARA street football

- The pitch is 56 × 34 m with walls all round and cut corners. **The ball bounces off the walls, and there are no throw-ins or corners** (`buildWalls`, line 41).
- Goals are 5 m wide and 2 m high (line 9). A ball over the bar hits the wall above the goal.
- Kickoff after each goal goes to the team that conceded. Teams swap ends at half time.
- A slide tackle takes the ball about 72% of the time. If it misses, the tackler is stunned for half a second, so don't spam it.

## 9. File-by-file map

```
game/
├── server/server.js    the server: files, rooms, codes, quick match,
│                       runs matches, sends snapshots
├── public/             what the browser downloads (≈100 KB with fonts)
│   ├── index.html      screens: home, lobby, match HUD, full time
│   ├── style.css       the looks: colours, fonts, buttons, layouts
│   ├── main.js         the client: network, prediction, camera, drawing,
│   │                   touch controls, MARK ring, CALL bubble, sound
│   ├── shared/sim.js   THE RULES: pitch, physics, tackles, MARK, CALL,
│   │                   keeper, bots, commentary (server + phone use it)
│   ├── manifest.webmanifest   lets phones "install" it like an app
│   └── assets/         logo, icons, WhatsApp share picture, fonts
├── test/
│   ├── bots.mjs        3 fake players play a full match on the live site
│   ├── screens.mjs     phone screenshots: home, lobby, match, MARK, CALL
│   ├── latency.mjs     plays at a fake 288 ms ping, measures the feel
│   └── sim_smoke.mjs, tune.mjs   fast bot-only matches for balancing
├── screenshots/        the latest phone screenshots
└── README.md, ROADMAP.md, HOW_IT_WORKS.md
```

## 10. Run it on your own computer

1. Install Node.js (version 18 or newer) from nodejs.org.
2. Open a terminal in the project folder and type `npm install`. This adds the one helper library, `ws`, for websockets.
3. Type `npm start`, then open http://localhost:8080 in two browser tabs. Create a room in one tab and join with the code in the other.
4. To try a slow connection: `SIM_LAG_MS=125 npm start` adds 125 ms each way, which makes about a 250 ms ping (line 18).
5. Tests: `node test/bots.mjs http://localhost:8080 3 30` plays a full match with 30-second halves.

## 11. Easy edits you can make yourself

Open the file in any text editor (VS Code is free), change the value, save, and restart the server (or redeploy).

| What | File | Line | What to change |
|---|---|---|---|
| Team names | `public/main.js` | 12–13 | `name: 'Lagos Lions'`, `short: 'LIONS'`. These feed the lobby, scoreboard and full-time screens automatically |
| Kit colours | `public/main.js` | 12–13 | `shirt`, `trim`, `shorts`, `sock`, `gk` (keeper), as hex colours |
| Pitch colours | `public/main.js` | 15–16 | `pitch`, `pitchLight`, `chalk` (lines), `wall` |
| Button & menu colours, fonts | `public/style.css` | 4–10 | the `--yellow`, `--green`, `--pink`… brand tokens |
| Button sizes & positions | `public/style.css` | 99–103 | `width`/`height` (size) and `right`/`bottom` (position) of each button |
| Match length (default) | `server/server.js` | 94 | `this.halfLen = 180` (seconds per half) |
| Match length choices in the lobby | `public/index.html` | 64 | the `<option>` list (also allowed in `server.js` line 351) |
| Pidgin commentary | `public/shared/sim.js` | 27–35 | add or change lines in `goal`, `save`, `kickoff`, `half`, `full` |
| Pitch size | `public/shared/sim.js` | 8 | `HALF_W = 28, HALF_H = 17` (half the length and width, in metres) |
| Goal size | `public/shared/sim.js` | 9 | `GOAL_HALF = 2.5` (half the width) |
| Player speed | `public/shared/sim.js` | 15 | `RUN`, `SPRINT` |
| MARK speed, CALL cooldown | `public/shared/sim.js` | 21–23 | `MARK_SPEED = 0.9`, `CALL_COOLDOWN = 2.5`, `CALL_WINDOW = 2.2` |
| Camera zoom | `public/main.js` | 409 | `21` metres across on phones, `27` on laptops (bigger = further out) |
| Wall adverts | `public/main.js` | 484 | the `ads` list: text, background colour, text colour |
| Danfo route sign | `public/main.js` | 474 | `'OSHODI - OBALENDE'` |
| Page title / WhatsApp preview text | `public/index.html` | 7–12 | `<title>` and the `og:` lines |

Tip: line numbers move a little as the code changes. If a line doesn't match, search the file for the quoted text.

## 12. What it costs to run

The server is one small always-on box. Each match uses very little computer power: a full 6-minute bot match simulates in about 0.15 s of CPU time, so one small box should hold dozens of rooms at once. Section 5 of ROADMAP.md has the launch-scale numbers.
