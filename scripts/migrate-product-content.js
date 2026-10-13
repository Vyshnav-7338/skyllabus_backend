const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const config = require("../config");
const Product = require("../models/Product");
const futils = require("../utils/fileutils");

const apply = process.argv.includes("--apply");

function legacyPath(value) {
  if (typeof value !== "string" || !value.startsWith("/uploads/")) return null;
  const resolved = path.resolve(__dirname, "..", value.replace(/^\/+/, ""));
  const backend = path.resolve(__dirname, "..");
  return resolved.startsWith(`${backend}${path.sep}`) ? resolved : null;
}

function mimeFor(source, fallback = "application/octet-stream") {
  return ({ ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" })[path.extname(source).toLowerCase()] || fallback;
}

async function legacyMedia(value, fallbackMime) {
  if (!value) return null;
  if (value.name) return value;
  const source = legacyPath(value);
  if (!source || !fs.existsSync(source)) {
    throw new Error(`Cannot safely migrate legacy media ${value}: file is unavailable`);
  }
  return futils.getFileObject({
    buffer: await fs.promises.readFile(source),
    originalname: path.basename(source),
    mimetype: mimeFor(source, fallbackMime),
  });
}

async function legacyFile(video) {
  const file = await legacyMedia(video.file || video.videoUrl, "video/mp4");
  if (!file) throw new Error(`Cannot safely migrate video ${video._id || video.title}: file is unavailable`);
  if (video.thumbnail) {
    const thumbnail = await legacyMedia(video.thumbnail, "image/jpeg");
    const current = path.join(config.cdndir, thumbnail.name);
    const target = path.join(config.cdndir, "thumb", thumbnail.name);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.rename(current, target);
    file.thumb = `/thumb/${thumbnail.name}`;
  }
  return file;
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");
  await mongoose.connect(process.env.MONGODB_URI);
  const rawProducts = await Product.collection.find({ videos: { $exists: true, $ne: [] } }).toArray();
  console.log(JSON.stringify({ legacyProducts: rawProducts.length, mode: apply ? "apply" : "dry-run" }));
  if (!apply || rawProducts.length === 0) return;

  const backupDirectory = path.join(path.dirname(config.cdndir), "skyllabus-migration-backups");
  await fs.promises.mkdir(backupDirectory, { recursive: true });
  const backupPath = path.join(backupDirectory, `products-before-modules-${Date.now()}.json`);
  await fs.promises.writeFile(backupPath, JSON.stringify(rawProducts, null, 2));

  for (const rawProduct of rawProducts) {
    if (Array.isArray(rawProduct.modules) && rawProduct.modules.length > 0) {
      throw new Error(`Product ${rawProduct._id} already has modules; migration stopped without changing it`);
    }
    const videos = [];
    for (const video of rawProduct.videos || []) {
      videos.push({
        _id: video._id,
        title: video.title,
        description: video.description || "",
        file: await legacyFile(video),
        duration: video.duration || "",
        order: Number(video.order || 0),
        isPreview: Boolean(video.isPreview),
        isPublished: video.isPublished !== false,
        createdAt: video.createdAt,
        updatedAt: video.updatedAt,
      });
    }
    const modules = [{
      _id: new mongoose.Types.ObjectId(),
      title: "Course Content",
      description: "",
      order: 1,
      chapters: [{
        _id: new mongoose.Types.ObjectId(),
        title: "General",
        description: "",
        order: 1,
        videos,
        notes: [],
      }],
    }];
    const thumbnail = await legacyMedia(rawProduct.thumbnail, "image/jpeg");
    const banner = await legacyMedia(rawProduct.banner, "image/jpeg");
    await Product.collection.updateOne(
      { _id: rawProduct._id, videos: { $exists: true } },
      { $set: { modules, thumbnail, banner }, $unset: { videos: "" } },
    );
  }
  console.log(JSON.stringify({ migratedProducts: rawProducts.length, backupPath }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await mongoose.disconnect();
});
