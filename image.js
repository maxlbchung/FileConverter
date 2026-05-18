// Image conversion via Canvas API — no wasm needed.
// Browsers natively decode PNG/JPEG/WebP/GIF/BMP and encode to PNG/JPEG/WebP.
import JSZip from "https://esm.sh/jszip@3.10.1";

const $ = (id) => document.getElementById(id);
const dropzone = $("dropzone");
const fileInput = $("file-input");
const fileInfo = $("file-info");
const fileCount = $("file-count");
const outputFormat = $("output-format");
const qualityInput = $("quality");
const qualityValue = $("quality-value");
const qualityRow = $("quality-row");
const convertBtn = $("convert-btn");
const resetBtn = $("reset-btn");
const progress = $("progress");
const progressFill = $("progress-fill");
const progressText = $("progress-text");
const result = $("result");
const downloads = $("downloads");
const downloadAll = $("download-all");

let currentFiles = [];
const createdUrls = new Set();

const formatBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let i = -1;
  do { bytes /= 1024; i++; } while (bytes >= 1024 && i < units.length - 1);
  return `${bytes.toFixed(2)} ${units[i]}`;
};

const setStatus = (msg, isError = false) => {
  progressText.textContent = msg;
  progressText.classList.toggle("error-status", isError);
};

const updateQualityVisibility = () => {
  qualityRow.classList.toggle("hidden", outputFormat.value === "png");
};

const selectFiles = (files) => {
  const list = Array.from(files || []).filter((f) => f.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name));
  if (list.length === 0) return;
  currentFiles = list;
  fileCount.textContent = list.length === 1 ? `1 file (${list[0].name})` : `${list.length} files`;
  fileInfo.classList.remove("hidden");
  convertBtn.disabled = false;
  result.classList.add("hidden");
  progress.classList.add("hidden");
  clearDownloads();
};

const clearDownloads = () => {
  for (const url of createdUrls) URL.revokeObjectURL(url);
  createdUrls.clear();
  downloads.innerHTML = "";
  downloadAll.classList.add("hidden");
};

const reset = () => {
  currentFiles = [];
  fileInput.value = "";
  fileInfo.classList.add("hidden");
  progress.classList.add("hidden");
  result.classList.add("hidden");
  convertBtn.disabled = true;
  progressFill.style.width = "0%";
  clearDownloads();
};

const loadImage = (file) => new Promise((resolve, reject) => {
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
  img.onerror = (e) => { URL.revokeObjectURL(url); reject(new Error(`Could not decode ${file.name}`)); };
  img.src = url;
});

const canvasToBlob = (canvas, type, quality) => new Promise((resolve, reject) => {
  canvas.toBlob((blob) => {
    if (blob) resolve(blob);
    else reject(new Error(`Encoding to ${type} failed`));
  }, type, quality);
});

const convertOne = async (file, format, quality) => {
  const img = await loadImage(file);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  // For JPEG, fill background white since JPEG has no alpha.
  if (format === "jpeg") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(img, 0, 0);
  const mime = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" }[format];
  const blob = await canvasToBlob(canvas, mime, format === "png" ? undefined : quality);
  const outName = file.name.replace(/\.[^.]+$/, "") + `.${format === "jpeg" ? "jpg" : format}`;
  return { blob, name: outName };
};

const addDownloadRow = ({ blob, name }) => {
  const url = URL.createObjectURL(blob);
  createdUrls.add(url);
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML = `
    <span class="value" style="text-align:left;flex:1">${name}</span>
    <span class="label">${formatBytes(blob.size)}</span>
  `;
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.textContent = "Download";
  link.className = "tab";
  link.style.color = "var(--accent)";
  row.appendChild(link);
  downloads.appendChild(row);
};

const convert = async () => {
  if (currentFiles.length === 0) return;
  const format = outputFormat.value;
  const quality = parseFloat(qualityInput.value);
  convertBtn.disabled = true;
  resetBtn.disabled = true;
  outputFormat.disabled = true;
  qualityInput.disabled = true;
  progress.classList.remove("hidden");
  result.classList.add("hidden");
  progressFill.style.width = "0%";
  progressFill.style.background = "var(--accent)";
  clearDownloads();

  const converted = [];
  try {
    for (let i = 0; i < currentFiles.length; i++) {
      const file = currentFiles[i];
      setStatus(`Converting ${i + 1} of ${currentFiles.length}: ${file.name}`);
      const out = await convertOne(file, format, quality);
      converted.push(out);
      addDownloadRow(out);
      progressFill.style.width = `${Math.round(((i + 1) / currentFiles.length) * 100)}%`;
    }

    if (converted.length > 1) {
      setStatus("Building zip…");
      const zip = new JSZip();
      for (const { blob, name } of converted) zip.file(name, blob);
      const zipBlob = await zip.generateAsync({ type: "blob" });
      const zipUrl = URL.createObjectURL(zipBlob);
      createdUrls.add(zipUrl);
      downloadAll.href = zipUrl;
      downloadAll.download = `converted-${Date.now()}.zip`;
      downloadAll.textContent = `Download all (${converted.length} files, ${formatBytes(zipBlob.size)})`;
      downloadAll.classList.remove("hidden");
    }

    progress.classList.add("hidden");
    result.classList.remove("hidden");
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message || err}`, true);
    progressFill.style.background = "var(--danger)";
  } finally {
    convertBtn.disabled = false;
    resetBtn.disabled = false;
    outputFormat.disabled = false;
    qualityInput.disabled = false;
  }
};

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener("change", (e) => selectFiles(e.target.files));
outputFormat.addEventListener("change", updateQualityVisibility);
qualityInput.addEventListener("input", () => {
  qualityValue.textContent = parseFloat(qualityInput.value).toFixed(2);
});

["dragenter", "dragover"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("drag-over");
  })
);
["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("drag-over");
  })
);
dropzone.addEventListener("drop", (e) => {
  selectFiles(e.dataTransfer?.files);
});

convertBtn.addEventListener("click", convert);
resetBtn.addEventListener("click", reset);
updateQualityVisibility();
