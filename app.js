import { loadFFmpeg, prepareInput, setFFmpegHandlers, terminateFFmpeg } from "./ffmpeg-loader.js";

// ============================== State ==============================
const queue = [];        // jobs waiting to be processed
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

// ============================== Dropzones ==============================
document.querySelectorAll(".dropzone").forEach((zone) => {
  const input = zone.querySelector('input[type="file"]');
  zone.addEventListener("click", () => input.click());
  zone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
  });
  input.addEventListener("change", (e) => {
    enqueueFiles(e.target.files, zone.dataset.kind);
    input.value = "";
  });

  ["dragenter", "dragover"].forEach((evt) =>
    zone.addEventListener(evt, (e) => { e.preventDefault(); zone.classList.add("drag-over"); }));
  ["dragleave", "drop"].forEach((evt) =>
    zone.addEventListener(evt, (e) => { e.preventDefault(); zone.classList.remove("drag-over"); }));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    enqueueFiles(e.dataTransfer?.files, zone.dataset.kind);
  });
});

// ============================== Enqueue ==============================
const snapshotOptions = (kind) => {
  if (kind === "video") return { format: $("video-format").value };
  if (kind === "audio") return { format: audioFmt.value, bitrate: $("audio-bitrate").value };
  if (kind === "image") return { format: imgFmt.value, quality: parseFloat(imgQuality.value) };
  return {};
};

const enqueueFiles = (files, kind) => {
  if (!files) return;
  for (const file of Array.from(files)) {
    if (!file) continue;
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
  updateCounts();
  processQueue();
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
  const queueTotal = queue.length + (queue.some((j) => j.status === "running") ? 0 : 0);
  // queue array drains as we shift; running job is held in a separate var
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
const buildVideoArgs = (input, output, format, attempt) => {
  const fast = attempt === 1;
  switch (format) {
    case "mp4":
      return fast
        ? ["-i", input, "-c", "copy", "-map", "0:v:0?", "-map", "0:a:0?",
           "-movflags", "+faststart", output]
        : ["-i", input, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
           "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", output];
    case "mov":
      return fast
        ? ["-i", input, "-c", "copy", "-map", "0:v:0?", "-map", "0:a:0?", output]
        : ["-i", input, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
           "-c:a", "aac", "-b:a", "192k", output];
    case "mkv":
      return fast
        ? ["-i", input, "-c", "copy", output]
        : ["-i", input, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
           "-c:a", "aac", "-b:a", "192k", output];
    case "webm":
      return fast
        ? ["-i", input, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "32",
           "-c:a", "libopus", "-b:a", "128k", output]
        : ["-i", input, "-c:v", "libvpx", "-b:v", "1M",
           "-c:a", "libvorbis", output];
    case "gif":
      return ["-i", input,
              "-vf", "fps=12,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse",
              "-loop", "0", output];
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
    let rc = await ffmpeg.exec(buildVideoArgs(inputPath, workOutput, job.format, 1));
    if (rc !== 0) {
      // remux failed (or VP9 too slow / unsupported codecs) — try full re-encode
      rc = await ffmpeg.exec(buildVideoArgs(inputPath, workOutput, job.format, 2));
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
const buildAudioArgs = (input, output, format, bitrate) => {
  const base = ["-i", input, "-vn"];
  switch (format) {
    case "mp3": return [...base, "-c:a", "libmp3lame", "-b:a", bitrate, output];
    case "wav": return [...base, "-c:a", "pcm_s16le", output];
    case "flac": return [...base, "-c:a", "flac", output];
    case "ogg": return [...base, "-c:a", "libvorbis", "-b:a", bitrate, output];
    case "m4a": return [...base, "-c:a", "aac", "-b:a", bitrate, output];
    case "opus": return [...base, "-c:a", "libopus", "-b:a", bitrate, output];
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
    const rc = await ffmpeg.exec(buildAudioArgs(inputPath, workOutput, job.format, job.bitrate));
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
const processImage = async (job) => {
  job.progress = 0.2; updateJobRow(job);
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    const url = URL.createObjectURL(job.file);
    i.onload = () => { URL.revokeObjectURL(url); resolve(i); };
    i.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Could not decode ${job.file.name}`)); };
    i.src = url;
  });
  job.progress = 0.5; updateJobRow(job);

  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (job.format === "jpeg") {
    // JPEG has no alpha — fill white so transparent PNGs don't render black
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(img, 0, 0);

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

// ============================== Init ==============================
updateCounts();
