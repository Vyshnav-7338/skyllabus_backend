const Product = require("../models/Product");
const Category = require("../models/Category");
const Giveaway = require("../models/Giveaway");
const User = require("../models/User");
const { removeFileObject } = require("./fileutils");

function mediaKey(value) {
  return value && typeof value === "object" ? String(value.name || "") : "";
}

function collectProductMedia(product) {
  const result = [];
  if (product?.thumbnail) result.push(product.thumbnail);
  if (product?.banner) result.push(product.banner);
  for (const module of product?.modules || []) {
    for (const chapter of module.chapters || []) {
      for (const video of chapter.videos || []) if (video.file) result.push(video.file);
      for (const note of chapter.notes || []) if (note.file) result.push(note.file);
    }
  }
  return result.filter((value) => mediaKey(value));
}

async function isMediaReferenced(value) {
  const name = mediaKey(value);
  if (!name) return false;
  const [product, category, giveaway, user] = await Promise.all([
    Product.exists({ $or: [
      { "thumbnail.name": name }, { "banner.name": name },
      { "modules.chapters.videos.file.name": name }, { "modules.chapters.notes.file.name": name },
    ] }),
    Category.exists({ "image.name": name }),
    Giveaway.exists({ "image.name": name }),
    User.exists({ "profilePhoto.name": name }),
  ]);
  return Boolean(product || category || giveaway || user);
}

async function removeIfUnreferenced(value) {
  if (!(await isMediaReferenced(value))) await removeFileObject(value);
}

module.exports = { mediaKey, collectProductMedia, removeIfUnreferenced };
