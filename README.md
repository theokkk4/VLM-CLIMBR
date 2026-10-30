# CLIMBR — read every move

CLIMBR turns a phone video of a boulder problem into a synced replay, a move-by-move read of the beta, and a coach's notes. It segments every hold on your route with **SAM 3.1**, tracks all four limbs with **ViTPose+**, and asks a vision-language model for feedback. All three models run through the [VLM Run](https://vlm.run) gateway. The camera can be on a tripod or in a friend's hand following you up the wall.

<p align="center"><img src="docs/finale.jpg" width="900" alt="The finale: holds relit in the colour of the limb that used them, order badges, the torso's path, and the climb measured in meters"></p>

## Run it

```bash
npm install
npm run dev                 # web on http://localhost:5173, API on :8787
```

Then connect your VLM Run key: click the status pill in the top bar (or use the card on the Import page) and paste it. The server tests it against the gateway, shows whether it can use SAM 3.1, ViTPose+ and a coach model, and saves it to `.env` only if it works. `.env` is gitignored. You can also put `VLMRUN_API_KEY=…` in `.env` yourself (see `.env.example`).

To check a key from the command line: `curl localhost:8787/api/models` returns `ok: true` and the models the key can use.

The first visit plays the onboarding. Click **Intro** in the top bar to see it again.

Without a key, everything except live analysis and the VLM coach still works: the example, the on-device coach and every export.

The server needs ffmpeg to read clips. `npm install` brings a static build (`ffmpeg-static`); a system ffmpeg/ffprobe is used when there is one.

For production, run `npm run build && npm start`. That serves `dist/` and the API from one process on port 8787.

## Deploy to Vercel

1. Import the repo at [vercel.com/new](https://vercel.com/new). `vercel.json` already sets the Vite build and the `api/` functions, so keep the defaults.
2. **Settings → Environment Variables:** add `VLMRUN_API_KEY`.
3. **For live video analysis:** go to **Storage → Create → Blob** and connect the store to the project. That adds `BLOB_READ_WRITE_TOKEN`. Clips are bigger than a function's 4.5 MB request limit, so the browser uploads them to Blob and `api/analyze` reads them from there. The upload is deleted when the run ends; the H.264 playback copy and the poster are written back to Blob for the replay.
4. Redeploy, then open `https://<your-app>.vercel.app/api/models`: `"ok": true` means the key works and can use SAM 3.1 and ViTPose+.

Without Blob, everything else still works: the example, the VLM coach and exports. The Import page says what's missing.

The functions bundle `ffmpeg-static`, so clips (including iPhone HDR `.mov`) are read on Vercel exactly as they are locally. `api/analyze` runs up to 300 s, the Hobby maximum; a 30 s climb takes 45–70 s. The coach cuts its 8 keyframes in the browser, so it needs no ffmpeg at all.

## What's in it

| | |
|---|---|
| **Onboarding** | A cinematic intro. Pick your capture device, watch the real example climb play itself through the route reader, then set your name, grade and favourite hold colour. |
| **Replay** | The clip, the route map and the live stats on one clock that runs the length of the clip. On the video, the holds sit where the camera saw them and light up as they are used, and the climber's real ViTPose+ skeleton is drawn on top. On the route map, a climber figure is solved from the four contact points and the tracked torso. You get *on a hold* percentages, each limb's holds in order, and per-limb contact lanes on a scrubbable timeline. |
| **Finale** | Shown after the top-out: the completion card comparing every attempt (gold = holds only that attempt used), then the route relights hold by hold in limb colours with order badges while the torso path grows. |
| **Attempts** | Time-to-top bars, a beta matrix (the order each hold was reached, per attempt) and a route map of each attempt's line. |
| **Coach** | A VLM reads the measurements plus 8 keyframes of the clip and writes a headline, scores, strengths, focus points (click one to jump the replay to that moment), drills, suggested beta and a next goal. On-device insights sit alongside. |
| **Import** | Drop a phone video (`.mov`, `.mp4`, `.webm`; any orientation, iPhone HDR, up to 2 minutes) and it is analyzed live: uploading → reading the video → segmenting holds ‖ tracking the climber → reading the route → coach notes. Every stage reports what it measured; a stage that fails says why and offers Retry, and a clip with nothing to read (no holds of that colour, nobody climbing) says so instead of opening an empty replay. |
| **Export** | The **analysis video**, rendered in the browser only when you ask for it: the clip with every hold, the skeleton, the clock and the sequence burned in (MP4 where the browser can record it, else WebM). Also a PDF coach report, a 1080×1350 share card and a moves CSV. |

Keyboard: <kbd>Space</kbd> play/pause · <kbd>←</kbd>/<kbd>→</kbd> seek (hold <kbd>Shift</kbd> for 2 s) · <kbd>1</kbd>–<kbd>3</kbd> views · <kbd>E</kbd> export.

The 3D wall and iPhone LiDAR are parked in `attic/3d/` until the video analysis is where we want it; its README says how to bring them back.

<p align="center">
  <img src="docs/replay.jpg" width="440" alt="Replay mid-climb">
  <img src="docs/coach.jpg" width="440" alt="VLM coach">
  <img src="docs/import.jpg" width="440" alt="Import: drop a video of the climb">
</p>

## How it works

```
 browser                                  CLIMBR server (server/)                      VLM Run gateway
  · replay, coach, exports                POST /api/analyze
  · route reader  (src/lib/analyze.ts) ◄── probe → analysis copy, 10 fps ─────────►  facebook/sam3.1    (track "{color} climbing hold")
  · camera motion (src/lib/motion.ts)      + H.264 playback copy + poster   ─────────►  vitpose-plus-large (pose, every analysis frame)
  · checks        (src/lib/live.ts)     ◄── NDJSON stages + normalized payloads
  · wall mosaic   (src/lib/wallplate.ts)  POST /api/coach ── 8 keyframes ───────────►  qwen3.8-27b / gemini (JSON feedback)
                                          the API key never leaves the server
```

1. **Reading the clip.** The server probes the original for duration, frame rate, display size after rotation, frame count and format. It uses ffprobe, or the bundled ffmpeg's own report, and fails the run if any of them cannot be read. One ffmpeg pass then makes the *analysis copy*: exactly 10 frames a second, upright, tone-mapped to SDR, long edge ≤ 960. Frame *i* sits at *i*/10 s, so the models' frame ids are real timestamps. The same pass makes an H.264 *playback copy* (≤ 1280 px, ≤ 30 fps) that every browser plays, and a poster. The original is kept beside them.
2. **SAM 3.1 and ViTPose+** run in parallel on the analysis copy. SAM samples up to 128 frames evenly across the whole clip, and ViTPose+ poses every frame. Each answer goes through a strict adapter (`server/vlm.mjs`). It checks the envelope against the clip that was sent and requires `vid.segment.masks` / `vid.pose.kpts` and COCO-17 keypoints. It turns pixel coordinates into 0–1 if a response ever uses them, and takes times from the response's own `frame_ts`. Anything off-shape fails the stage with the reason.
3. **The camera** is read from SAM's own hold tracks (`src/lib/motion.ts`). Holds are bolted down, so when they move in the picture, the camera moved. Every sampled frame gets a similarity transform onto one wall canvas. The fit is robust to a hold half-hidden under a hand, and it drops tracks that move against the wall and sightings where SAM switched holds. A tripod clip registers as exactly still and reads as the pipeline reads it. A hand-held one gets a canvas covering the wall the climber used, much as vision-demos' `camera.py` does with homographies.
4. **The route reader** (`src/lib/analyze.ts`) is a TypeScript port of the core of `vision-demos/rock_climbing/src/climb.py`. It judges contact in the picture itself, against each hold's outline as SAM saw it nearest that moment, carried by the camera's motion. It uses the pipeline's dwell, hysteresis, graze, toe-offset, start and top-out rules, with margins in hold heights and body heights. On the example's raw gateway responses it reproduces the pipeline's 16-hold numbering and finds all 9 holds of its sequence in the same order, plus two half-second touches the pipeline discards. Each limb's *share of contact* lands within 1 point of the pipeline's.
5. **Checks** (`src/lib/live.ts`) run before anything opens:
   - the playback copy is as long as the source;
   - SAM sampled the whole clip, and ViTPose+ posed at least 90% of it;
   - the camera was placed;
   - every move, skeleton frame and torso point sits on the clip's own clock;
   - every hold outline sits on the canvas.

   A failed check stops the run with its reason. No duration, frame size or frame rate is ever assumed.
6. **The replay** draws its overlay in the video's own pixels, letterboxed exactly as the video is. Holds appear where the camera saw them, light up once used and turn white while held, under the real 17-joint skeleton. One clock runs through the whole clip in real seconds, with the climb clock zeroed at the start.

- **The wall plate** is the climber-free photo of the wall. Frames are warped onto the canvas by their own camera transforms, the climber is cut out of each using the pose, and a per-pixel median does the rest. With a moving camera it is a mosaic of everything the camera saw. The route backdrop is drawn from it.
- **The coach** works through a model chain: `CLIMBR_COACH_MODEL`, then `google/gemini-3.7-flash`, `qwen/qwen3.8-27b` and `qwen/qwen3.5-0.8b`. A model the account isn't entitled to is skipped, and the one that answers is remembered. Qwen's thinking mode is switched off so it spends its budget on the answer. The clip goes in as 8 keyframes rather than a `video_url`, because not every chat model on the gateway decodes video.

Measured on a 29.4 s hand-held iPhone clip: reading it took ~8 s, SAM 3.1 + ViTPose+ took 40–60 s for **$0.036**, and the route reader took well under a second. The coach took ~10 s for **$0.003**.

### Debugging a run (development)

`npm run dev` keeps every run in `.climbr/runs/<id>/`:

- the original clip, plus the analysis and playback copies;
- `sam.raw.json` and `pose.raw.json`, the gateway's answers with masks stripped;
- the normalized `sam.json` and `pose.json`;
- `run.json`, a log with every stage's timing;
- `client.json`, the browser's report of what it read and which checks passed.

`GET /api/debug/runs` lists the runs and `/api/debug/runs/<id>` returns one. In the app, **Debug** on a live session shows the same. `tools/read-run.ts` runs the browser's reader in Node on a saved run, or on raw gateway responses:

```bash
npx rolldown tools/read-run.ts -p node -f esm -o .climbr/read-run.mjs
node .climbr/read-run.mjs run .climbr/runs/<id>
node .climbr/read-run.mjs raw public/examples/green-vb/gateway/sam3.1-track.json public/examples/green-vb/gateway/vitpose-plus-large.json public/examples/green-vb/climb.json
```

## Project layout

```
server/core.mjs    the API itself: VLM Run client, probe + frame extraction, SAM 3.1 + ViTPose+, coach, run folders
server/vlm.mjs     the strict adapter for SAM 3.1 and ViTPose+ responses
server/index.mjs   Express wrapper for local runs and `npm start` (plus /api/debug in development)
api/               the same core as Vercel functions (health, models, key, analyze, upload, coach)
src/lib/           route reader, camera motion, checks, session model, timeline + climber IK, overlay, coach, exports
src/components/    route panel (SVG), video stage, timeline, live stats, key connection, export sheet, debug panel
src/views/         onboarding, home, session (replay · attempts · coach), import
attic/3d/          the parked 3D wall and LiDAR view
public/examples/   the example climb: pipeline JSON, raw gateway JSON, clip, wall plate, coach feedback
tools/             read-run.ts: the browser's route reader, run in Node on saved gateway output
```

The bundled example lives in `public/examples/green-vb/`. Its `gateway/` folder holds the real SAM 3.1 and ViTPose+ responses for the clip, which `tools/read-run.ts` reads as a regression check.

## Credits

The example footage, its hold and contact data, and the reference pipeline the route reader is ported from come from [**jeremyipark/vision-demos**](https://github.com/jeremyipark/vision-demos) by Jeremy Park, Apache-2.0.
