const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const config = require("../config");

function ensureDirectories() {
  fs.mkdirSync(config.cdndir, { recursive: true });
  fs.mkdirSync(path.join(config.cdndir, "thumb"), { recursive: true });
  fs.mkdirSync(path.join(config.cdndir, "hls"), { recursive: true });
}

function safeExtension(originalName) {
  const extension = path.extname(String(originalName || "")).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : "";
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("md5");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function getFileObject(file) {
  if (!file) return null;
  ensureDirectories();
  const name = `${Date.now()}-${crypto.randomUUID()}${safeExtension(file.originalname)}`;
  const destination = path.join(config.cdndir, name);
  if (file.path) {
    await fs.promises.copyFile(file.path, destination);
    await fs.promises.rm(file.path, { force: true }).catch(() => {});
  } else if (file.buffer) {
    await fs.promises.writeFile(destination, file.buffer);
  } else {
    throw new Error("Uploaded file data is unavailable");
  }
  const stat = await fs.promises.stat(destination);
  return {
    name,
    thumb: "",
    size: stat.size,
    mime: String(file.mimetype || "application/octet-stream"),
    md5: await hashFile(destination),
    orgname: String(file.originalname || name),
  };
}

function resolveMediaPath(relativeName) {
  const relative = String(relativeName || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!relative || relative.includes("..") || path.isAbsolute(relative)) return null;
  const root = path.resolve(config.cdndir);
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
  return resolved;
}

async function removeFileObject(value) {
  if (!value || typeof value !== "object") return;
  const targets = [value.name, value.thumb].filter(Boolean);
  await Promise.all(targets.map(async (target) => {
    const resolved = resolveMediaPath(target);
    if (resolved) await fs.promises.rm(resolved, { force: true }).catch(() => {});
  }));
}

async function removeIncoming(files) {
  await Promise.all((files || []).map((file) => file.path
    ? fs.promises.rm(file.path, { force: true }).catch(() => {})
    : Promise.resolve()));
}

module.exports = { ensureDirectories, getFileObject, resolveMediaPath, removeFileObject, removeIncoming };
