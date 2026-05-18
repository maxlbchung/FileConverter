import { loadFFmpeg, prepareInput, setFFmpegHandlers, terminateFFmpeg } from "./ffmpeg-loader.js";

// ============================== State ==============================
// Per-kind pending list: files picked but NOT yet committed to the queue.
// User must click Convert (per tab, under the dropzone) to move them.
const pending = { video: [], audio: [], image: [] };
const queue = [];        // jobs waiting to be processed (post-commit)
const complete = [];     // jobs done (success or error)
let isProcessing = false;
let nextId = 1;
let activeJob = null;    // the job currently running, if any

// ============================== Helpers ==============================
const $ = (id) => document.getElementById(id);
const escapeHtml = (s) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));

const formatBytes = (b) => {
  if (b < 1024) return `${b} B`;
  const u = ["KB", "MB", "GB"];
  let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
  return `${b.toFixed(2)} ${u[i]}`;
};

// ============================== DOM refs ==============================
const queueList = $("queue-list");
const completeList = $("complete-list");
const queueEmpty = $("queue-empty");
const completeEmpty = $("complete-empty");
const queueCount = $("queue-count");
const completeCount = $("complete-count");

// ============================== Tabs ==============================
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    document.querySelectorAll(".tab-pane").forEach((p) => {
      p.classList.toggle("hidden", p.dataset.tab !== tab.dataset.tab);
    });
  });
});

// ============================== Per-tab option toggles ==============================
const audioFmt = $("audio-format");
const audioBitrateRow = $("audio-bitrate-row");
const updateAudioBitrate = () => {
  const lossless = audioFmt.value === "wav" || audioFmt.value === "flac";
  audioBitrateRow.classList.toggle("hidden", lossless);
};
audioFmt.addEventListener("change", updateAudioBitrate);
updateAudioBitrate();

const imgFmt = $("image-format");
const imgQualityRow = $("image-quality-row");
const imgQuality = $("image-quality");
const imgQualityValue = $("image-quality-value");
const updateImageQuality = () => {
  imgQualityRow.classList.toggle("hidden", imgFmt.value === "png");
};
imgFmt.addEventListener("change", updateImageQuality);
imgQuality.addEventListener("input", () => {
  imgQualityValue.textContent = parseFloat(imgQuality.value).toFixed(2);
});
updateImageQuality();

// Video CRF slider — display the numeric value next to the label.
const videoCrf = $("video-crf");
const videoCrfValue = $("video-crf-value");
videoCrf.addEventListener("input", () => {
  videoCrfValue.textContent = videoCrf.value;
});

// Stretch toggle is only relevant when a target dimension is selected.
const videoDims = $("video-dims");
const videoStretchRow = $("video-stretch-row");
const updateStretchVisibility = () => {
  videoStretchRow.classList.toggle("hidden", !videoDims.value);
};
videoDims.addEventListener("change", updateStretchVisibility);
updateStretchVisibility();

// ============================== Dropzones ==============================
document.querySelectorAll(".dropzone").forEach((zone) => {
  const input = zone.querySelector('input[type="file"]');
  zone.addEventListener("click", () => input.click());
  zone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
  });
  input.addEventListener("change", (e) => {
    addPendingFiles(e.target.files, zone.dataset.kind);
    input.value = "";
  });

  ["dragenter", "dragover"].forEach((evt) =>
    zone.addEventListener(evt, (e) => { e.preventDefault(); zone.classList.add("drag-over"); }));
  ["dragleave", "drop"].forEach((evt) =>
    zone.addEventListener(evt, (e) => { e.preventDefault(); zone.classList.remove("drag-over"); }));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    addPendingFiles(e.dataTransfer?.files, zone.dataset.kind);
  });
});

// ============================== Pending ==============================
const pendingListEl = (kind) => document.getElementById(`${kind}-pending-list`);
const pendingActionBtns = (kind) =>
  document.querySelectorAll(`.pending button[data-kind="${kind}"]`);

const addPendingFiles = (files, kind) => {
  if (!files) return;
  const added = [];
  for (const file of Array.from(files)) {
    if (!file) continue;
    // dedupe by name+size+lastModified
    const key = `${file.name}|${file.size}|${file.lastModified}`;
    if (pending[kind].some((f) => `${f.name}|${f.size}|${f.lastModified}` === key)) continue;
    pending[kind].push(file);
    added.push(file);
  }
  renderPending(kind);

  // Background-probe sources so we can constrain the settings UI to the
  // smallest of the uploaded files' dimensions.
  if (kind === "image") {
    for (const file of added) {
      probeImageDimensions(file).then((dims) => {
        if (!dims) return;
        imageDims.set(file, dims);
        recomputeImageConstraints();
      });
    }
  } else if (kind === "video") {
    for (const file of added) {
      probeVideoDimensions(file).then((dims) => {
        if (!dims) return;
        videoFileDims.set(file, dims);
        recomputeVideoConstraints();
      });
    }
  }
};

const removePendingFile = (kind, index) => {
  pending[kind].splice(index, 1);
  renderPending(kind);
  if (kind === "image") recomputeImageConstraints();
  if (kind === "video") recomputeVideoConstraints();
};

const clearPending = (kind) => {
  pending[kind].length = 0;
  renderPending(kind);
  if (kind === "image") recomputeImageConstraints();
  if (kind === "video") recomputeVideoConstraints();
};

const renderPending = (kind) => {
  const list = pendingListEl(kind);
  list.innerHTML = "";
  pending[kind].forEach((file, i) => {
    const row = document.createElement("div");
    row.className = "pending-item";
    row.innerHTML = `
      <span class="pending-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
      <span class="pending-size">${formatBytes(file.size)}</span>
      <button class="pending-remove" title="Remove" aria-label="Remove">×</button>
    `;
    row.querySelector(".pending-remove").addEventListener("click", () => removePendingFile(kind, i));
    list.appendChild(row);
  });
  const has = pending[kind].length > 0;
  pendingActionBtns(kind).forEach((btn) => { btn.disabled = !has; });
};

// Wire the per-tab Convert / Clear buttons (one set per kind).
document.querySelectorAll('.pending button[data-action]').forEach((btn) => {
  btn.addEventListener("click", () => {
    const kind = btn.dataset.kind;
    if (btn.dataset.action === "convert") {
      commitPendingToQueue(kind);
    } else if (btn.dataset.action === "clear") {
      clearPending(kind);
    }
  });
});

const commitPendingToQueue = (kind) => {
  const files = pending[kind].slice();
  if (files.length === 0) return;
  for (const file of files) {
    const job = {
      id: nextId++,
      file,
      kind,
      status: "queued",
      progress: 0,
      ...snapshotOptions(kind),
    };
    queue.push(job);
    addQueueRow(job);
  }
  pending[kind].length = 0;
  renderPending(kind);
  updateCounts();
  // Auto-start the processor on commit. It's idempotent: returns immediately
  // if it's already draining the queue.
  processQueue();
};

// ============================== Format / options snapshot ==============================
const intOrNull = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const snapshotOptions = (kind) => {
  if (kind === "video") return {
    format: $("video-format").value,
    crf: $("video-crf").value,
    fps: $("video-fps").value || null,             // null = keep source
    dims: $("video-dims").value || null,           // "WxH" or null = keep source
    stretch: $("video-stretch").checked,           // true = force exact, may distort
  };
  if (kind === "audio") return {
    format: audioFmt.value,
    bitrate: $("audio-bitrate").value,
    samplerate: $("audio-samplerate").value || null,
  };
  if (kind === "image") return {
    format: imgFmt.value,
    quality: parseFloat(imgQuality.value),
    maxWidth: intOrNull($("image-max-width").value),
    maxHeight: intOrNull($("image-max-height").value),
  };
  return {};
};

// ============================== Rendering ==============================
const jobInnerHTML = (job) => `
  <div class="job-line">
    <span class="job-kind">${job.kind}</span>
    <span class="job-name" title="${escapeHtml(job.file.name)}">${escapeHtml(job.file.name)} → ${job.format}</span>
    <span class="job-state"></span>
    <button class="job-remove" title="Remove" aria-label="Remove">×</button>
  </div>
  <div class="job-bar"><div class="job-fill"></div></div>
`;

const wireRemoveButton = (el, jobId) => {
  el.querySelector(".job-remove")?.addEventListener("click", (e) => {
    e.stopPropagation();
    removeJob(jobId);
  });
};

const addQueueRow = (job) => {
  const el = document.createElement("div");
  el.className = "job";
  el.dataset.id = String(job.id);
  el.dataset.state = job.status;
  el.innerHTML = jobInnerHTML(job);
  wireRemoveButton(el, job.id);
  queueList.appendChild(el);
  updateJobRow(job);
};

const findJobElement = (id) =>
  queueList.querySelector(`[data-id="${id}"]`) || completeList.querySelector(`[data-id="${id}"]`);

const updateJobRow = (job) => {
  const el = findJobElement(job.id);
  if (!el) return;
  el.dataset.state = job.status;
  const state = el.querySelector(".job-state");
  const fill = el.querySelector(".job-fill");
  if (!state || !fill) return;
  if (job.status === "queued") {
    state.textContent = "Queued";
    fill.style.width = "0%";
  } else if (job.status === "running") {
    const pct = Math.round((job.progress || 0) * 100);
    state.textContent = pct > 0 ? `${pct}%` : "Starting…";
    fill.style.width = `${pct}%`;
  } else if (job.status === "done") {
    state.textContent = job.outputSize ? formatBytes(job.outputSize) : "Done";
    fill.style.width = "100%";
  } else if (job.status === "error") {
    state.textContent = "Failed";
  }
};

const moveJobToComplete = (job) => {
  queueList.querySelector(`[data-id="${job.id}"]`)?.remove();

  const card = document.createElement("div");
  card.className = "job";
  card.dataset.id = String(job.id);
  card.dataset.state = job.status;
  card.innerHTML = jobInnerHTML(job);
  wireRemoveButton(card, job.id);

  if (job.status === "done") {
    const dl = document.createElement("a");
    dl.className = "job-download";
    dl.href = job.blobUrl;
    dl.download = job.outputName;
    dl.textContent = `Download ${job.outputName}`;
    card.appendChild(dl);
  } else if (job.status === "error") {
    const err = document.createElement("p");
    err.className = "job-error";
    err.textContent = job.errorMessage || "Unknown error";
    card.appendChild(err);
  }
  completeList.appendChild(card);
  updateJobRow(job);
};

// Single entry point for the × button. Handles queued, running, or complete.
const removeJob = (id) => {
  // 1. Queued — splice out, never runs.
  const qIdx = queue.findIndex((j) => j.id === id);
  if (qIdx >= 0) {
    queue.splice(qIdx, 1);
    queueList.querySelector(`[data-id="${id}"]`)?.remove();
    updateCounts();
    return;
  }
  // 2. Currently running — terminate ffmpeg so it actually stops.
  //    The processor loop catches the rejection and disposes the job silently.
  if (activeJob?.id === id) {
    activeJob.cancelled = true;
    terminateFFmpeg();
    return;
  }
  // 3. Already complete — revoke URL and drop from list.
  const cIdx = complete.findIndex((j) => j.id === id);
  if (cIdx >= 0) {
    const job = complete[cIdx];
    if (job.blobUrl) URL.revokeObjectURL(job.blobUrl);
    complete.splice(cIdx, 1);
    completeList.querySelector(`[data-id="${id}"]`)?.remove();
    updateCounts();
  }
};

const updateCounts = () => {
  queueCount.textContent = String(queueList.children.length);
  completeCount.textContent = String(complete.length);
  queueEmpty.classList.toggle("hidden", queueList.children.length > 0);
  completeEmpty.classList.toggle("hidden", complete.length > 0);
};

$("clear-complete").addEventListener("click", () => {
  for (const job of complete) {
    if (job.blobUrl) URL.revokeObjectURL(job.blobUrl);
  }
  complete.length = 0;
  completeList.innerHTML = "";
  updateCounts();
});

// ============================== Processor loop ==============================
const isAbortLike = (err) =>
  /terminated|FFmpeg\.terminate|aborted/i.test(err?.message || "") || err?.name === "AbortError";

const processQueue = async () => {
  if (isProcessing) return;
  isProcessing = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift();
      activeJob = job;
      job.status = "running";
      updateJobRow(job);
      updateCounts();
      try {
        await processJob(job);
        if (job.cancelled) throw new Error("cancelled");
        job.status = "done";
      } catch (err) {
        if (job.cancelled || isAbortLike(err)) {
          // User clicked × on the running job. Drop it silently and move on;
          // ffmpeg was terminated, loadFFmpeg() will rebuild on next iteration.
          queueList.querySelector(`[data-id="${job.id}"]`)?.remove();
          activeJob = null;
          updateCounts();
          continue;
        }
        console.error(err);
        job.status = "error";
        job.errorMessage = err?.message || String(err);
      }
      activeJob = null;
      moveJobToComplete(job);
      complete.push(job);
      updateCounts();
    }
  } finally {
    isProcessing = false;
    activeJob = null;
    updateCounts();
  }
};

const processJob = (job) => {
  if (job.kind === "video") return processVideo(job);
  if (job.kind === "audio") return processAudio(job);
  if (job.kind === "image") return processImage(job);
  throw new Error(`Unknown kind: ${job.kind}`);
};

// Wrap whatever ffmpeg.readFile returned (Uint8Array OR array of Uint8Arrays
// from our chunked-read worker patch) into a Blob. Blob can hold multiple
// parts without copying or hitting any single-allocation cap.
const buildOutputBlob = (data, mime) => {
  if (Array.isArray(data)) return new Blob(data, { type: mime });
  return new Blob([data.buffer || data], { type: mime });
};

const readOutput = async (ffmpeg, path, mime) => {
  try {
    const data = await ffmpeg.readFile(path);
    return buildOutputBlob(data, mime);
  } catch (err) {
    if (err?.name === "RangeError" || /Array buffer allocation/i.test(err?.message || "")) {
      throw new Error(
        "Conversion finished but the output is too large to extract from the browser " +
        "(>~2 GB even after chunking). Use a desktop tool like ffmpeg or HandBrake for " +
        "files this big."
      );
    }
    throw err;
  }
};

// ============================== Video ==============================
// Build -vf filter expressions from FPS + dimensions + stretch options.
// Without stretch: fit inside target box, never upscale, pad to even dims.
// With stretch: force exact target dimensions even if it distorts/upscales.
const buildVideoFilters = (opts) => {
  const f = [];
  if (opts.fps) f.push(`fps=${opts.fps}`);
  if (opts.dims) {
    const [w, h] = opts.dims.split("x");
    if (opts.stretch) {
      f.push(`scale=${w}:${h}`);
    } else {
      f.push(`scale=${w}:${h}:force_original_aspect_ratio=decrease`);
      // libx264 needs even dimensions. Pad up to even if scale produced odd
      // (preserves content; max 1px black border on each axis).
      f.push("pad='ceil(iw/2)*2:ceil(ih/2)*2:0:0:black'");
    }
  }
  return f;
};

const hasCustomVideoSettings = (opts) =>
  opts.fps !== null || opts.dims !== null || opts.crf !== "23";

const buildVideoArgs = (input, output, opts, attempt) => {
  const { format, crf } = opts;
  // Remux fast path only allowed on attempt 1 AND when user hasn't touched
  // any quality/fps/scale settings (those need a real re-encode).
  const fast = attempt === 1 && !hasCustomVideoSettings(opts);
  const filters = buildVideoFilters(opts);
  const vf = filters.length ? ["-vf", filters.join(",")] : [];

  switch (format) {
    case "mp4":
      return fast
        ? ["-i", input, "-c", "copy", "-map", "0:v:0?", "-map", "0:a:0?",
           "-movflags", "+faststart", output]
        : ["-i", input, ...vf, "-c:v", "libx264", "-preset", "ultrafast",
           "-crf", crf, "-c:a", "aac", "-b:a", "192k",
           "-movflags", "+faststart", output];
    case "mov":
      return fast
        ? ["-i", input, "-c", "copy", "-map", "0:v:0?", "-map", "0:a:0?", output]
        : ["-i", input, ...vf, "-c:v", "libx264", "-preset", "ultrafast",
           "-crf", crf, "-c:a", "aac", "-b:a", "192k", output];
    case "mkv":
      return fast
        ? ["-i", input, "-c", "copy", output]
        : ["-i", input, ...vf, "-c:v", "libx264", "-preset", "ultrafast",
           "-crf", crf, "-c:a", "aac", "-b:a", "192k", output];
    case "webm":
      return fast
        ? ["-i", input, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", crf,
           "-c:a", "libopus", "-b:a", "128k", output]
        : ["-i", input, ...vf, "-c:v", "libvpx", "-b:v", "1M",
           "-c:a", "libvorbis", output];
    case "gif": {
      // GIF always re-encodes. Apply fps + dims (preserve aspect, no upscale)
      // on top of the palette pipeline.
      const fps = opts.fps || "12";
      let scaleExpr = "scale=-2:'min(480,ih)':flags=lanczos";
      if (opts.dims) {
        const [w, h] = opts.dims.split("x");
        scaleExpr = opts.stretch
          ? `scale=${w}:${h}:flags=lanczos`
          : `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos`;
      }
      return ["-i", input,
              "-vf", `fps=${fps},${scaleExpr},split[a][b];[a]palettegen[p];[b][p]paletteuse`,
              "-loop", "0", output];
    }
    default:
      throw new Error(`Unknown video format: ${format}`);
  }
};

const videoMime = {
  mp4: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska",
  webm: "video/webm", gif: "image/gif",
};

const processVideo = async (job) => {
  const ffmpeg = await loadFFmpeg();
  setFFmpegHandlers({
    onProgress: ({ progress: p }) => {
      job.progress = p;
      updateJobRow(job);
    },
  });
  const { inputPath, cleanup } = await prepareInput(ffmpeg, job.file);
  const workOutput = `output_${job.id}.${job.format}`;
  try {
    let rc = await ffmpeg.exec(buildVideoArgs(inputPath, workOutput, job, 1));
    if (rc !== 0) {
      // remux failed (or VP9 too slow / unsupported codecs) — try full re-encode
      rc = await ffmpeg.exec(buildVideoArgs(inputPath, workOutput, job, 2));
    }
    if (rc !== 0) throw new Error(`ffmpeg exited with code ${rc}`);
    const blob = await readOutput(ffmpeg, workOutput, videoMime[job.format]);
    job.blobUrl = URL.createObjectURL(blob);
    job.outputName = job.file.name.replace(/\.[^.]+$/, "") + "." + job.format;
    job.outputSize = blob.size;
    await ffmpeg.deleteFile(workOutput).catch(() => {});
  } finally {
    await cleanup();
    setFFmpegHandlers({});
  }
};

// ============================== Audio ==============================
const buildAudioArgs = (input, output, opts) => {
  const { format, bitrate, samplerate } = opts;
  const base = ["-i", input, "-vn"];
  const sr = samplerate ? ["-ar", samplerate] : [];
  switch (format) {
    case "mp3": return [...base, ...sr, "-c:a", "libmp3lame", "-b:a", bitrate, output];
    case "wav": return [...base, ...sr, "-c:a", "pcm_s16le", output];
    case "flac": return [...base, ...sr, "-c:a", "flac", output];
    case "ogg": return [...base, ...sr, "-c:a", "libvorbis", "-b:a", bitrate, output];
    case "m4a": return [...base, ...sr, "-c:a", "aac", "-b:a", bitrate, output];
    case "opus": return [...base, ...sr, "-c:a", "libopus", "-b:a", bitrate, output];
    default: throw new Error(`Unknown audio format: ${format}`);
  }
};

const audioMime = {
  mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac",
  ogg: "audio/ogg", m4a: "audio/mp4", opus: "audio/opus",
};

const processAudio = async (job) => {
  const ffmpeg = await loadFFmpeg();
  setFFmpegHandlers({
    onProgress: ({ progress: p }) => {
      job.progress = p;
      updateJobRow(job);
    },
  });
  const { inputPath, cleanup } = await prepareInput(ffmpeg, job.file);
  const workOutput = `output_${job.id}.${job.format}`;
  try {
    const rc = await ffmpeg.exec(buildAudioArgs(inputPath, workOutput, job));
    if (rc !== 0) throw new Error(`ffmpeg exited with code ${rc}`);
    const blob = await readOutput(ffmpeg, workOutput, audioMime[job.format]);
    job.blobUrl = URL.createObjectURL(blob);
    job.outputName = job.file.name.replace(/\.[^.]+$/, "") + "." + job.format;
    job.outputSize = blob.size;
    await ffmpeg.deleteFile(workOutput).catch(() => {});
  } finally {
    await cleanup();
    setFFmpegHandlers({});
  }
};

// ============================== Image (Canvas) ==============================
const loadImageBitmap = (file) => new Promise((resolve, reject) => {
  const i = new Image();
  const url = URL.createObjectURL(file);
  i.onload = () => { URL.revokeObjectURL(url); resolve(i); };
  i.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Could not decode ${file.name}`)); };
  i.src = url;
});

const processImage = async (job) => {
  job.progress = 0.2; updateJobRow(job);
  const img = await loadImageBitmap(job.file);
  job.progress = 0.5; updateJobRow(job);

  // Compute target dimensions, never upscaling. Either maxWidth or maxHeight
  // (or both) may be set; we honor whichever's more restrictive.
  let w = img.naturalWidth;
  let h = img.naturalHeight;
  const sw = job.maxWidth || Infinity;
  const sh = job.maxHeight || Infinity;
  if (sw < w || sh < h) {
    const scale = Math.min(sw / w, sh / h, 1);
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
  }

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (job.format === "jpeg") {
    // JPEG has no alpha — fill white so transparent PNGs don't render black
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(img, 0, 0, w, h);

  const mime = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" }[job.format];
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => b ? resolve(b) : reject(new Error(`Encoding to ${job.format} failed`)),
      mime,
      job.format === "png" ? undefined : job.quality,
    );
  });
  job.blobUrl = URL.createObjectURL(blob);
  const outExt = job.format === "jpeg" ? "jpg" : job.format;
  job.outputName = job.file.name.replace(/\.[^.]+$/, "") + "." + outExt;
  job.outputSize = blob.size;
  job.progress = 1; updateJobRow(job);
};

// ---------- Probe video dimensions and constrain dim presets ----------
// `<video>` can read metadata for MP4/WebM/OGG natively. MKV / AVI / etc. fail
// silently; in that case we just leave all preset options enabled.
const videoFileDims = new WeakMap(); // File → { width, height }

const probeVideoDimensions = async (file) =>
  new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = (dims) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      resolve(dims);
    };
    const timer = setTimeout(() => finish(null), 6000);
    v.addEventListener("loadedmetadata", () => {
      clearTimeout(timer);
      const w = v.videoWidth, h = v.videoHeight;
      finish(w && h ? { width: w, height: h } : null);
    }, { once: true });
    v.addEventListener("error", () => { clearTimeout(timer); finish(null); }, { once: true });
    v.src = url;
  });

const recomputeVideoConstraints = () => {
  let minW = Infinity, minH = Infinity, any = false;
  for (const file of pending.video) {
    const dims = videoFileDims.get(file);
    if (!dims) continue;
    any = true;
    if (dims.width < minW) minW = dims.width;
    if (dims.height < minH) minH = dims.height;
  }
  let restoreToOriginal = false;
  for (const opt of videoDims.options) {
    if (!opt.value) continue;
    const [w, h] = opt.value.split("x").map(Number);
    opt.disabled = any && (w > minW || h > minH);
    if (opt.disabled && opt.selected) restoreToOriginal = true;
  }
  if (restoreToOriginal) {
    videoDims.value = "";
    updateStretchVisibility();
  }
};

// ---------- Probe images and constrain max-width/height inputs ----------
const imageDims = new WeakMap(); // File → { width, height }

const probeImageDimensions = async (file) => {
  try {
    const img = await loadImageBitmap(file);
    return { width: img.naturalWidth, height: img.naturalHeight };
  } catch {
    return null;
  }
};

const imageMaxWidth = $("image-max-width");
const imageMaxHeight = $("image-max-height");

const recomputeImageConstraints = () => {
  let minW = Infinity, minH = Infinity, any = false;
  for (const file of pending.image) {
    const dims = imageDims.get(file);
    if (!dims) continue;
    any = true;
    if (dims.width < minW) minW = dims.width;
    if (dims.height < minH) minH = dims.height;
  }
  if (any) {
    imageMaxWidth.max = String(minW);
    imageMaxWidth.placeholder = `Original (≤ ${minW})`;
    imageMaxHeight.max = String(minH);
    imageMaxHeight.placeholder = `Original (≤ ${minH})`;
    // Clamp existing values to the new cap.
    const w = intOrNull(imageMaxWidth.value);
    const h = intOrNull(imageMaxHeight.value);
    if (w && w > minW) imageMaxWidth.value = String(minW);
    if (h && h > minH) imageMaxHeight.value = String(minH);
  } else {
    imageMaxWidth.removeAttribute("max");
    imageMaxWidth.placeholder = "Original";
    imageMaxHeight.removeAttribute("max");
    imageMaxHeight.placeholder = "Original";
  }
};

// ============================== Init ==============================
updateCounts();
renderPending("video");
renderPending("audio");
renderPending("image");
