# Swing — golf swing analysis

A lightweight replacement for Skillest / OnForm for the analysis half of the job:
load swings, compare them side by side, draw fluoro lines on them, and record a
voice-over lesson you can send to a student.

No frameworks, no build step, no dependencies. Three files do the work
(`index.html`, `styles.css`, `app.js`), which is why it opens instantly and stays
smooth while scrubbing two videos at once.

---

## Run it

```bash
node server.js
```

Then open the printed `http://localhost:5178`. The server also prints your Mac's
LAN address — open **that** one on your iPhone or iPad (same Wi-Fi) and the app
runs there natively.

### Install it to the home screen

On iPhone/iPad, open the LAN URL in Safari → Share → **Add to Home Screen**. It
then launches full-screen with no browser chrome and works offline (a service
worker caches the shell). On desktop Chrome/Edge, use the install icon in the
address bar.

> Camera capture, the microphone, and Picture-in-Picture need a secure context.
> `localhost` counts as secure; a plain `http://192.168.x.x` LAN address does not
> in some browsers. If the mic is refused on your phone, see **HTTPS on the LAN**
> below.

---

## What it does

**Four view modes** (segmented control, top centre — or keys `1`–`4`):

| Mode | What it's for |
|---|---|
| **Single / 1 Up** | One swing, full screen |
| **Split / 2 Up** | Two swings side by side — stacks automatically in portrait |
| **PiP** | Swing B floats over swing A as a draggable, resizable inset |
| **Ghost** | Swing B laid directly over A with an opacity slider and Normal / Screen / Difference blending |

**Linking two swings at impact** is the workflow that matters. Tap **Linked** to
unlink, scrub each swing independently until both sit at the same position in the
motion, then tap **Linked** again. That locks the offset between them.

In **Split**, each video gets its own scrubber directly underneath it instead of
one shared one — drag either directly, no need to focus a video first. While
**Linked**, dragging either scrubber carries the other along at the locked
offset; unlinked, each moves independently.

**Fluoro drawing tools** (left rail, or keys `P L W O B A`): freehand, straight
line, arrow, circle, box, and an angle tool that reads out degrees live. Seven
neon colours including red. Three line weights (thin / medium / thick) next to
the colour swatches. Drawings are stored relative to the video frame, so they
stay glued in place when you rotate the device, resize the window, switch view
modes, or zoom/pan.

**Zoom & pan** (top of the left rail): the magnifying-glass buttons zoom the
focused swing in for a closer look, or scroll the mouse wheel over a video
(zooms toward the cursor), or use `+`/`-`/`0`. Once zoomed, switch to the
**hand tool** (top of the rail, or key `H`) and drag to reposition the zoomed
video — the drawing tools always draw, so the hand tool is the dedicated way to
grab and move the picture instead. Both zoom and pan are recorded too —
whatever crop you're looking at when you hit Record is what ends up in the
exported lesson.

**Flip** (top of the rail, or key `F`): mirrors the focused swing horizontally
— handy when a student filmed from the "wrong" side and you want both swings
facing the same way for comparison. Drawings, zoom, and pan all stay correctly
attached to the video regardless of flip state — a line drawn along someone's
trail arm stays on their trail arm whether you flip before or after drawing
it, and it's captured correctly in recordings too.

**Frame-accurate transport**: play/pause, single-frame step both ways, and
0.1× / ¼× / ½× / 1× speeds. Set the **fps** chip to match your source footage
(24 → 240) so a frame step moves exactly one frame.

**Record a lesson**: hit **Record** (bottom right, next to Mic and Face). It
composites exactly what's on screen — both videos, the drawings, the zoom, the
layout you chose, your face-cam if it's on — into one video file and records
your microphone over the top. Stop, and it saves an `.mp4` (or offers the iOS
share sheet) ready to send. This is the piece that replaces the paid apps.

**Face** button (bottom transport, next to Mic): shows a small circular or
square bubble of your webcam, so a student can see you while you talk through
their swing. Drag it anywhere on screen; tap it to blow it up full-size for a
close demonstration, tap again to shrink it back. The small circle/square icon
in its top-right corner switches shape. It's captured in recordings exactly as
positioned live.

**Picture-in-Picture** button (top right, the rectangle icon) pops the focused
video out into a floating system window, so you can keep a swing on screen while
you're in another app.

**Loading video**: click directly on an empty pane ("Add swing A/B") to open
the file picker for that slot, the **+** button for the full load sheet (also
lists incoming ClickUp swings and lets you swap A/B), or drag a file straight
onto a pane on desktop. On iPhone/iPad the file picker also offers *Take Video*,
so you can film a swing and analyse it without leaving the app.

**Incoming swings**: the Load sheet also lists everything sitting in `Library/`,
newest first, with the student's name and camera angle. Tap **A** or **B** to
drop a clip straight into that pane. See below for filling it automatically.

---

## Automatic swing submissions (ClickUp → Library)

`sync-swings.js` polls the ClickUp **🏌️ Swing Analysis** list
(`900801277719`, in the Perform Golf space), pulls the video attachments off
each submission, and writes them into `Library/` named like:

```
2026-08-16__Joseph-Cuncic__face-on__86d425czc.mov
```

The camera angle comes from the ClickUp form field the student uploaded into
("UPLOAD A FACE ON VIDEO" → `face-on`, "Down the Line Video" → `down-the-line`,
and so on). Files it has already fetched are tracked in `.sync-state.json`, so
re-running never re-downloads.

### Setup

1. In ClickUp: avatar (bottom left) → **Settings → Apps → API Token → Generate**.
2. Create a file called `.env` next to `sync-swings.js`:

   ```
   CLICKUP_TOKEN=pk_your_token_here
   ```

3. Check what it would pull without downloading anything:

   ```bash
   node sync-swings.js --dry
   ```

4. Then run it for real:

   ```bash
   node sync-swings.js
   ```

### The daily run

**This is automatic — there's nothing to schedule.** `server.js` runs a sync the
moment you start the app, and then once every 24 hours while it stays running.
Since you open the app when you sit down to do analysis, "the beginning of every
day" is exactly when it fires. The Load sheet shows the result
("ClickUp: 2 new clips · 4 min ago"), and **Sync now** forces a check.

If the token is wrong or ClickUp is down, the sheet says so — a failed sync never
reports itself as "up to date".

> **Why not a scheduled background job?** A launchd agent was the obvious
> approach, but macOS privacy protection (TCC) blocks LaunchAgents from reading
> or writing anything inside `~/Documents`, which is where this project lives.
> The agent fails with `Operation not permitted` unless you grant Full Disk
> Access. Running the sync from the app process avoids the whole problem, since
> the terminal you launch it from already has permission.
>
> If you ever want it to run with the app closed, move this folder somewhere
> outside `~/Documents` (e.g. `~/Swing`) and a LaunchAgent will work fine.

To poll continuously instead, run it yourself in a spare terminal:

```bash
node sync-swings.js --watch
```

### Getting a copy into Google Drive

Set `SWING_MIRROR_DIR` to a folder that a Drive client syncs, and every clip is
copied there as well as into `Library/`:

```bash
SWING_MIRROR_DIR="$HOME/Google Drive/My Drive/Swing Submissions" node sync-swings.js
```

**Note for this Mac:** there's no Google Drive for Desktop installed — Drive is
mounted through CloudMounter, and that mount currently times out when read. The
app deliberately does **not** read video from it, because a stalled mount would
freeze scrubbing. Install *Google Drive for Desktop* (which keeps a real local
folder) and point `SWING_MIRROR_DIR` at it to get the Drive copy working.

---

## Kajabi community swings — what's possible

Checked directly against the Perform Golf community (site `2147576451`,
community `11984`). The relevant channels are **Post Your Swing** (190 posts) and
the per-student private channels under the *Online Lessons* access group.

**The videos can't be pulled automatically.** The Kajabi connector returns post
text only — `message`, `lexical_data`, author, reactions, engagement counts.
There is no attachment, file, or media field on a post. A video-only post (e.g.
David Wooding Biddle, 5 Jul) comes back with an empty message and empty
`lexical_data`: the attached swing simply isn't represented in the API at all.
No amount of scripting gets at a file the API never exposes.

So for community swings the options are:

- **Save the video from Kajabi and drop it into `Library/`** — it appears in the
  app immediately. This is the practical route today.
- **Ask members to also submit through the ClickUp form** for anything you intend
  to do a full analysis on, so it flows in automatically.

What *is* readable is the post metadata — author, timestamp, body, which channel.
A daily "new swing posts you haven't answered" digest is buildable on top of
that; it just can't fetch the file for you.

### Keyboard

`Space` play/pause · `←` `→` frame step · `1`–`4` view mode ·
`P` pen `L` line `W` arrow `O` circle `B` box `A` angle `H` hand (pan) ·
`+` `-` `0` zoom in / out / reset · `F` flip ·
`U` undo · `C` clear · `S` link/unlink · `R` record

---

## Files

```
index.html        markup
styles.css         all styling, including every responsive breakpoint
app.js             Deck class, drawing/zoom engine, transport, webcam, recorder
server.js          dependency-free static server + swing-library API + daily ClickUp sync
sync-swings.js     pulls swing videos out of ClickUp into Library/
sw.js              offline cache (bump CACHE after editing app files)
manifest.json      PWA install metadata
assets/            app icon
Library/           incoming swing videos (gitignored, except README.txt)
```

---

## HTTPS on the LAN (only if the mic is blocked on your phone)

Browsers gate `getUserMedia` behind a secure context. If your iPad refuses the
mic on the LAN address, put a trusted local certificate in front of it:

```bash
brew install mkcert nss && mkcert -install && mkcert 192.168.1.50
```

…then serve with those cert files, or tunnel it (`cloudflared tunnel --url http://localhost:5178`)
and use the HTTPS URL it hands back. Everything except mic recording works fine
over plain HTTP.

---

## Known limits

- Recording output is H.264 MP4 in Safari and Chrome; some Firefox builds fall
  back to WebM. Both play everywhere a student is likely to open them, but WebM
  won't import into iMovie without a convert.
- Very high frame-rate footage (240fps slow-mo from an iPhone) plays back at the
  rate the file is encoded at. Frame-stepping is exact as long as the **fps** chip
  matches the file.
- Drawings live in memory for the session — they are not saved between reloads by
  design, so the app stays instant and stores nothing of your students' footage.

## If you later want it on the App Store

The analysis engine here is portable, but a native build needs full Xcode (this
Mac only has Command Line Tools) plus an Apple Developer account. The native win
would be real 240fps frame-by-frame decode and camera control; everything else in
this app already matches what Skillest and OnForm do.
