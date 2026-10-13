const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const mongoose = require("mongoose");
const request = require("supertest");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

process.env.JWT_SECRET = "integration-test-secret-with-sufficient-length";
process.env.BASE_URL = "http://localhost:5000";
const testCdnDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "skyllabus-media-test-"));
process.env.CDN_DIR_LOCAL = testCdnDirectory;
process.env.CDN_DIR_LIVE = testCdnDirectory;

const { app } = require("../server");
const User = require("../models/User");
const Enrollment = require("../models/Enrollment");
const Product = require("../models/Product");
const Wallet = require("../models/Wallet");
const WalletTransaction = require("../models/WalletTransaction");
const Category = require("../models/Category");
const ReferralSettings = require("../models/ReferralSettings");
const VideoProgress = require("../models/VideoProgress");
const ReferralCommission = require("../models/ReferralCommission");

let mongo;
let firstUser;
let userToken;
let adminToken;
let categoryId;
let productId;
let videoId;
let secondVideoId;
let moduleId;
let chapterId;
let giveawayId;
let lastReferralToken;
let lastReferralUserId;
test.before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
});

test.after(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  fs.rmSync(testCdnDirectory, { recursive: true, force: true });
});

test("signup works without a referral and never returns a password", async () => {
  const response = await request(app).post("/api/auth/signup").send({
    name: "First Learner",
    email: "first@example.com",
    phone: "+919876543210",
    password: "Password@123",
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.success, true);
  assert.match(response.body.user.referralCode, /^SKY[A-Z0-9]{4}\d{4}$/);
  assert.equal(response.body.user.password, undefined);
  const persistedUser = await User.findById(response.body.user._id).select("+password");
  assert.ok(persistedUser?._id);
  assert.notEqual(persistedUser.password, "Password@123");
  assert.equal(await persistedUser.comparePassword("Password@123"), true);
  assert.ok(persistedUser.createdAt instanceof Date);
  assert.ok(persistedUser.updatedAt instanceof Date);
  assert.ok(await Wallet.exists({ user: persistedUser._id }));
  firstUser = response.body.user;
  userToken = response.body.token;
});

test("signup accepts a normalized legacy-user referral and stores the referrer", async () => {
  await User.collection.updateOne(
    { _id: new mongoose.Types.ObjectId(firstUser._id) },
    { $unset: { status: "" } },
  );
  const response = await request(app).post("/api/auth/signup").send({
    name: "Referred Learner",
    email: "referred@example.com",
    phone: "+919876543211",
    password: "Password@123",
    referralCode: ` ${firstUser.referralCode.slice(0, 3).toLowerCase()} ${firstUser.referralCode.slice(3).toLowerCase()} `,
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.success, true);
  assert.equal(response.body.user.referredBy, firstUser._id);
  const persistedUser = await User.findById(response.body.user._id);
  assert.equal(persistedUser.referredBy.toString(), firstUser._id);
});

test("referral relationship is persisted while wallet remains database-owned", async () => {
  const headers = { Authorization: `Bearer ${userToken}` };
  const referredUser = await User.findOne({ email: "referred@example.com" });
  assert.equal(referredUser.referredBy.toString(), firstUser._id);

  const wallet = await request(app).get("/api/wallet/me").set(headers);
  assert.equal(wallet.status, 200);
  assert.equal(wallet.body.data.availableBalance, 200);
  assert.equal(wallet.body.data.totalCredits, 200);
  assert.equal(wallet.body.data.totalDebits, 0);

  const transactions = await request(app).get("/api/wallet/transactions").set(headers);
  assert.equal(transactions.status, 200);
  assert.equal(transactions.body.data.length, 1);
});

test("signup rejects invalid referrals and duplicate users", async () => {
  const invalid = await request(app).post("/api/auth/signup").send({
    name: "Invalid Referral",
    email: "invalid@example.com",
    phone: "+919876543212",
    password: "Password@123",
    referralCode: "SKY000000",
  });
  assert.equal(invalid.status, 400);

  const duplicate = await request(app).post("/api/auth/signup").send({
    name: "Duplicate",
    email: "first@example.com",
    phone: "+919876543213",
    password: "Password@123",
  });
  assert.equal(duplicate.status, 409);
});

test("login, phone login, and authenticated profile work", async () => {
  const emailLogin = await request(app).post("/api/auth/login").send({
    email: "first@example.com",
    password: "Password@123",
  });
  assert.equal(emailLogin.status, 200);
  assert.ok(emailLogin.body.token);

  const phoneLogin = await request(app).post("/api/auth/login").send({
    phone: "+919876543210",
    password: "Password@123",
  });
  assert.equal(phoneLogin.status, 200);

  const profile = await request(app).get("/api/user/me").set("Authorization", `Bearer ${userToken}`);
  assert.equal(profile.status, 200);
  assert.equal(profile.body.data.email, "first@example.com");

});

test("admin authorization protects category management", async () => {
  const denied = await request(app)
    .post("/api/categories")
    .set("Authorization", `Bearer ${userToken}`)
    .send({ name: "Technology" });
  assert.equal(denied.status, 403);

  await User.create({
    name: "API Admin",
    email: "admin@example.com",
    phone: "+919000000000",
    password: "Admin@12345",
    role: "admin",
    referralCode: "SKY999999",
  });
  const login = await request(app).post("/api/auth/login").send({
    email: "admin@example.com",
    password: "Admin@12345",
  });
  assert.equal(login.status, 200);
  adminToken = login.body.token;
});

test("wallet, referral, and admin APIs enforce authentication and authorization", async () => {
  assert.equal((await request(app).get("/api/wallet")).status, 401);
  assert.equal((await request(app).get("/api/referral/me")).status, 401);
  assert.equal(
    (await request(app).get("/api/admin/referral-settings").set("Authorization", `Bearer ${userToken}`)).status,
    403,
  );
  assert.equal(
    (await request(app).get("/api/wallet").set("Authorization", "Bearer expired-or-invalid")).status,
    401,
  );
});

test("category CRUD works", async () => {
  const created = await request(app)
    .post("/api/categories")
    .set("Authorization", `Bearer ${adminToken}`)
    .field("name", "Technology")
    .field("description", "Technology courses")
    .field("icon", "memory")
    .field("isActive", "true")
    .attach("image", Buffer.from([0x89, 0x50, 0x4e, 0x47]), { filename: "technology.png", contentType: "image/png" });
  assert.equal(created.status, 201);
  categoryId = created.body.data._id;
  const persistedCategory = await Category.findById(categoryId);
  assert.equal(persistedCategory.name, "Technology");
  assert.equal(persistedCategory.slug, "technology");
  assert.equal(persistedCategory.image.orgname, "technology.png");

  const updated = await request(app)
    .put(`/api/categories/${categoryId}`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ sortOrder: 2, isActive: true });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.sortOrder, 2);

  const list = await request(app).get("/api/categories");
  assert.equal(list.status, 200);
  assert.equal(list.body.data.length, 1);
});

test("admin configures all five signup referral rewards", async () => {
  const rewards = {
    level1Reward: 200,
    level2Reward: 100,
    level3Reward: 50,
    level4Reward: 25,
    level5Reward: 25,
    isActive: true,
  };
  const updated = await request(app)
    .put("/api/admin/referral-settings")
    .set("Authorization", `Bearer ${adminToken}`)
    .send(rewards);
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.level5Reward, 25);
  assert.equal(updated.body.data.isActive, true);
  const persistedSettings = await ReferralSettings.findOne({ key: "default" });
  assert.equal(persistedSettings.level1Reward, 200);
  assert.equal(persistedSettings.level5Reward, 25);
  const loaded = await request(app)
    .get("/api/admin/referral-settings")
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.data.level1Reward, 200);
});

test("one product form creates and edits nested modules, chapters, videos, and notes", async () => {
  const authorization = `Bearer ${adminToken}`;
  const modules = [{ title: "Introduction", description: "Start here", order: 1, chapters: [{
    title: "Getting Started", description: "Basics", order: 1,
    videos: [
      { title: "Course introduction", duration: "08:20", order: 1, isPreview: true, isPublished: true },
      { title: "Core lesson", duration: "16:30", order: 2, isPreview: false, isPublished: true },
    ],
    notes: [{ title: "Starter notes", order: 1, isPublished: true }],
  }] }];
  const created = await request(app)
    .post("/api/products")
    .set("Authorization", authorization)
    .field("title", "Complete Product Workflow")
    .field("slug", "complete-product-workflow")
    .field("shortDescription", "A complete course saved once")
    .field("description", "Product details and multiple videos are submitted together.")
    .field("categoryId", categoryId)
    .field("instructorName", "Workflow Instructor")
    .field("originalPrice", "2499")
    .field("price", "899")
    .field("currency", "INR")
    .field("level", "Beginner")
    .field("duration", "4 weeks")
    .field("isPublished", "true")
    .field("isActive", "true")
    .field("modules", JSON.stringify(modules))
    .attach("thumbnail", Buffer.from([0x89, 0x50, 0x4e, 0x47]), { filename: "course.png", contentType: "image/png" })
    .attach("banner", Buffer.from([0xff, 0xd8, 0xff]), { filename: "banner.jpg", contentType: "image/jpeg" })
    .attach("videoFile_0_0_0", Buffer.from("introduction-video"), { filename: "introduction.mp4", contentType: "video/mp4" })
    .attach("videoFile_0_0_1", Buffer.from("core-video"), { filename: "core.mp4", contentType: "video/mp4" })
    .attach("noteFile_0_0_0", Buffer.from("chapter notes"), { filename: "notes.txt", contentType: "text/plain" });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.thumbnail.orgname, "course.png");
  assert.equal(created.body.data.modules.length, 1);
  assert.equal(created.body.data.modules[0].chapters[0].videos.length, 2);
  assert.equal(created.body.data.modules[0].chapters[0].notes[0].file.orgname, "notes.txt");
  const completeProductId = created.body.data._id;
  const module = created.body.data.modules[0];
  const chapter = module.chapters[0];
  const retained = chapter.videos[0];
  const persistedProduct = await Product.findById(completeProductId);
  assert.equal(persistedProduct.modules[0].chapters[0].videos.length, 2);

  const rejectedUpdate = await request(app)
    .put(`/api/products/${completeProductId}`)
    .set("Authorization", authorization)
    .field("title", "This title must not persist")
    .field("modules", JSON.stringify([{ id: new mongoose.Types.ObjectId().toString(), title: "Foreign", chapters: [] }]));
  assert.equal(rejectedUpdate.status, 400);
  assert.equal((await Product.findById(completeProductId)).title, "Complete Product Workflow");

  const editor = await request(app)
    .get(`/api/products/${completeProductId}/manage`)
    .set("Authorization", authorization);
  assert.equal(editor.status, 200);
  assert.equal(editor.body.data.slug, "complete-product-workflow");
  assert.equal(editor.body.data.modules[0].chapters[0].videos.length, 2);
  const updatedModules = [{ id: module._id, title: "Introduction", order: 1, chapters: [{
    id: chapter._id, title: "Getting Started", order: 1,
    videos: [{ id: retained._id, title: "Updated introduction", duration: "09:00", order: 2, isPreview: false, isPublished: true }, { title: "New first lesson", order: 1, isPreview: true, isPublished: true }],
    notes: [{ id: chapter.notes[0]._id, title: "Starter notes", order: 1, isPublished: true }],
  }] }];
  const updated = await request(app)
    .put(`/api/products/${completeProductId}`)
    .set("Authorization", authorization)
    .field("title", "Complete Product Workflow Updated")
    .field("modules", JSON.stringify(updatedModules))
    .attach("videoFile_0_0_1", Buffer.from("new-first-video"), { filename: "new-first.mp4", contentType: "video/mp4" });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.title, "Complete Product Workflow Updated");
  assert.equal(updated.body.data.modules[0].chapters[0].videos[0].title, "New first lesson");
  assert.equal(updated.body.data.modules[0].chapters[0].videos[1].file.name, retained.file.name);

  const deleted = await request(app)
    .delete(`/api/products/${completeProductId}`)
    .set("Authorization", authorization);
  assert.equal(deleted.status, 200);
  assert.equal(await Product.exists({ _id: completeProductId }), null);
});

test("product creation, CDN metadata, search, and category filtering work", async () => {
  const modules = [{ title: "Workflow Foundation", order: 1, chapters: [{ title: "Automation", order: 1, videos: [
    { title: "Workflow mapping", description: "Map the process before automating it.", duration: "12:30", order: 1, isPreview: true, isPublished: true },
    { title: "Workflow delivery", description: "Deliver the automated workflow.", duration: "08:00", order: 2, isPreview: false, isPublished: true },
  ], notes: [{ title: "Workflow checklist", order: 1, isPublished: true }] }] }];
  const created = await request(app)
    .post("/api/products")
    .set("Authorization", `Bearer ${adminToken}`)
    .field("title", "AI Workflow Architect")
    .field("shortDescription", "Automate real tasks")
    .field("description", "A complete workflow automation course.")
    .field("categoryId", categoryId)
    .field("price", "449")
    .field("offerPrice", "399")
    .field("originalPrice", "4499")
    .field("instructorName", "Course Instructor")
    .field("currency", "INR")
    .field("level", "Foundational")
    .field("duration", "8 weeks")
    .field("isPublished", "true")
    .field("modules", JSON.stringify(modules))
    .attach("thumbnail", Buffer.from([0xff, 0xd8, 0xff]), { filename: "course.jpg", contentType: "image/jpeg" })
    .attach("videoFile_0_0_0", Buffer.from("lesson-video"), { filename: "lesson.mp4", contentType: "video/mp4" })
    .attach("videoFile_0_0_1", Buffer.from("delivery-video"), { filename: "delivery.mp4", contentType: "video/mp4" })
    .attach("noteFile_0_0_0", Buffer.from("workflow checklist"), { filename: "checklist.pdf", contentType: "application/pdf" });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.thumbnail.orgname, "course.jpg");
  assert.equal(created.body.data.offerPrice, 399);
  productId = created.body.data._id;
  moduleId = created.body.data.modules[0]._id;
  chapterId = created.body.data.modules[0].chapters[0]._id;
  videoId = created.body.data.modules[0].chapters[0].videos[0]._id;
  secondVideoId = created.body.data.modules[0].chapters[0].videos[1]._id;

  const searched = await request(app).get("/api/products?search=workflow");
  assert.equal(searched.status, 200);
  assert.equal(searched.body.data.length, 1);

  const byCategory = await request(app).get(`/api/products/category/${categoryId}`);
  assert.equal(byCategory.status, 200);
  assert.equal(byCategory.body.data[0]._id, productId);
});

test("product details return embedded videos and protect locked playback URLs", async () => {
  const details = await request(app).get(`/api/products/${productId}`);
  assert.equal(details.status, 200);
  const chapter = details.body.data.modules[0].chapters[0];
  assert.equal(chapter.videos.length, 2);
  assert.equal(chapter.videos.find((item) => item._id === videoId).file.orgname, "lesson.mp4");
  assert.equal(chapter.videos.find((item) => item._id === secondVideoId).file, null);
  assert.equal(chapter.notes[0].file, null);
});

test("successful signups credit only the configured five-level referral chain exactly once", async () => {
  let sponsor = firstUser;
  const networkTokens = [];
  for (let level = 1; level <= 8; level += 1) {
    const response = await request(app).post("/api/auth/signup").send({
      name: `Network User ${level}`,
      email: `network${level}@example.com`,
      phone: `+91987654000${level}`,
      password: "Password@123",
      referralCode: sponsor.referralCode,
    });
    assert.equal(response.status, 201, response.body.message);
    assert.equal(response.body.user.referredBy, sponsor._id);
    sponsor = response.body.user;
    lastReferralToken = response.body.token;
    lastReferralUserId = response.body.user._id;
    networkTokens.push(response.body.token);
  }

  const wallet = await request(app).get("/api/wallet").set("Authorization", `Bearer ${userToken}`);
  assert.equal(wallet.status, 200);
  assert.equal(wallet.body.data.availableBalance, 600);
  assert.equal(wallet.body.data.totalCredits, 600);
  assert.equal(wallet.body.data.totalDebits, 0);

  const summary = await request(app).get("/api/referral/me").set("Authorization", `Bearer ${userToken}`);
  assert.equal(summary.status, 200);
  assert.equal(summary.body.data.totalReferrals, 6);
  assert.equal(summary.body.data.level1Count, 2);
  assert.equal(summary.body.data.level5Count, 1);
  assert.equal(summary.body.data.level1Earnings, 400);
  assert.equal(summary.body.data.level5Earnings, 25);
  assert.equal(summary.body.data.totalReferralEarnings, 600);
  assert.equal(summary.body.data.totalMembers, 6);
  assert.equal(summary.body.data.levels.length, 5);
  assert.deepEqual(summary.body.data.levels[0], { level: 1, reward: 200, memberCount: 2, earnings: 400 });
  assert.deepEqual(summary.body.data.levels[4], { level: 5, reward: 25, memberCount: 1, earnings: 25 });

  const rewardsByLevel = [200, 100, 50, 25, 25];
  for (let userIndex = 0; userIndex < networkTokens.length; userIndex += 1) {
    const perspective = await request(app)
      .get("/api/referral/me")
      .set("Authorization", `Bearer ${networkTokens[userIndex]}`);
    assert.equal(perspective.status, 200);
    const visibleDepth = Math.min(5, Math.max(0, 7 - userIndex));
    assert.equal(perspective.body.data.totalReferrals, visibleDepth);
    assert.equal(
      perspective.body.data.totalReferralEarnings,
      rewardsByLevel.slice(0, visibleDepth).reduce((total, reward) => total + reward, 0),
    );
    for (let level = 1; level <= 5; level += 1) {
      assert.equal(perspective.body.data[`level${level}Count`], level <= visibleDepth ? 1 : 0);
    }
  }

  const levelFive = await request(app).get("/api/referral/tree?level=5&page=1&limit=20").set("Authorization", `Bearer ${userToken}`);
  assert.equal(levelFive.status, 200);
  assert.equal(levelFive.body.data.length, 1);
  assert.equal(levelFive.body.meta.total, 1);

  const levelOneMembers = await request(app)
    .get("/api/referral/level/1?page=1&limit=1")
    .set("Authorization", `Bearer ${userToken}`);
  assert.equal(levelOneMembers.status, 200);
  assert.equal(levelOneMembers.body.data.level, 1);
  assert.equal(levelOneMembers.body.data.total, 2);
  assert.equal(levelOneMembers.body.data.pages, 2);
  assert.equal(levelOneMembers.body.data.members.length, 1);
  assert.equal(levelOneMembers.body.data.members[0].email, undefined);
  assert.equal(levelOneMembers.body.data.members[0].phone, undefined);
  assert.equal(levelOneMembers.body.data.members[0].referralCode, undefined);
  assert.equal(
    (await request(app).get("/api/referral/level/6").set("Authorization", `Bearer ${userToken}`)).status,
    400,
  );

  const transactions = await WalletTransaction.find({ user: firstUser._id, transactionType: "REFERRAL_REWARD" });
  assert.equal(transactions.length, 6);
  assert.equal(await ReferralCommission.countDocuments({ beneficiary: firstUser._id }), 6);
  assert.equal(transactions.some((item) => item.referredUser.toString() === lastReferralUserId), false);
  const retry = await request(app).post("/api/auth/signup").send({
    name: "Network User 8",
    email: "network8@example.com",
    phone: "+919876540008",
    password: "Password@123",
    referralCode: "IGNORED-BECAUSE-EMAIL-IS-DUPLICATE",
  });
  assert.equal(retry.status, 409);
  assert.equal((await Wallet.findOne({ user: firstUser._id })).availableBalance, 600);
  assert.equal(await WalletTransaction.countDocuments({ user: firstUser._id, transactionType: "REFERRAL_REWARD" }), 6);
  await assert.rejects(
    WalletTransaction.create({ ...transactions[0].toObject(), _id: new mongoose.Types.ObjectId() }),
    (error) => error && error.code === 11000,
  );
});

test("updated referral rewards apply to future signups with exact currency precision", async () => {
  const sponsorSignup = await request(app).post("/api/auth/signup").send({
    name: "Future Reward Sponsor",
    email: "future-sponsor@example.com",
    phone: "+919876540020",
    password: "Password@123",
  });
  assert.equal(sponsorSignup.status, 201);

  const updated = await request(app)
    .put("/api/admin/referral-settings")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      level1Reward: 250.25,
      level2Reward: 100,
      level3Reward: 50,
      level4Reward: 25,
      level5Reward: 25,
      isActive: true,
    });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.data.level1Reward, 250.25);

  const childSignup = await request(app).post("/api/auth/signup").send({
    name: "Future Reward Child",
    email: "future-child@example.com",
    phone: "+919876540021",
    password: "Password@123",
    referralCode: sponsorSignup.body.user.referralCode,
  });
  assert.equal(childSignup.status, 201);
  const sponsorWallet = await Wallet.findOne({ user: sponsorSignup.body.user._id });
  assert.equal(sponsorWallet.availableBalance, 250.25);
  assert.equal(sponsorWallet.totalCredits, 250.25);
  const sponsorTransactions = await WalletTransaction.find({
    user: sponsorSignup.body.user._id,
    transactionType: "REFERRAL_REWARD",
  });
  assert.equal(sponsorTransactions.length, 1);
  assert.equal(sponsorTransactions[0].amount, 250.25);
  assert.equal((await Wallet.findOne({ user: firstUser._id })).availableBalance, 600);
});

test("selected course, enrollment, learning list, and video progress persist", async () => {
  const auth = { Authorization: `Bearer ${userToken}` };
  const course = await request(app).get(`/api/products/${productId}`);
  assert.equal(course.status, 200);
  assert.equal(course.body.data._id, productId);

  const before = await request(app).get(`/api/enrollments/check/${productId}`).set(auth);
  assert.equal(before.status, 200);
  assert.equal(before.body.data.enrolled, false);

  const enrollmentAttempts = await Promise.all([
    request(app).post(`/api/product/${productId}/enroll`).set(auth).send({ price: 0, userId: lastReferralUserId }),
    request(app).post(`/api/product/${productId}/enroll`).set(auth).send({ price: 1, reward: 999999 }),
  ]);
  assert.deepEqual(enrollmentAttempts.map((response) => response.status).sort(), [201, 409]);
  const enrolled = enrollmentAttempts.find((response) => response.status === 201);
  assert.equal(enrolled.body.data.enrollment.product._id, productId);
  assert.equal(enrolled.body.data.wallet.availableBalance, 201);
  assert.equal(enrolled.body.data.wallet.totalDebits, 399);
  assert.equal((await Wallet.findOne({ user: firstUser._id })).availableBalance, 201);
  assert.equal(await WalletTransaction.countDocuments({ user: firstUser._id, transactionType: "COURSE_ENROLLMENT", product: productId }), 1);
  assert.equal(await Enrollment.countDocuments({ user: firstUser._id, product: productId }), 1);
  assert.equal((await Product.findById(productId)).enrollmentCount, 1);

  const learning = await request(app).get("/api/enrollments/my").set(auth);
  assert.equal(learning.status, 200);
  assert.equal(learning.body.data.length, 1);
  assert.equal(learning.body.data[0].product.title, "AI Workflow Architect");

  const playableProduct = await request(app).get(`/api/products/${productId}`).set(auth);
  assert.equal(playableProduct.status, 200);
  const playableChapter = playableProduct.body.data.modules[0].chapters[0];
  assert.equal(playableChapter.videos.length, 2);
  assert.equal(playableChapter.videos[1].file.orgname, "delivery.mp4");
  assert.equal(playableChapter.notes[0].file.orgname, "checklist.pdf");
  const playback = await request(app).get(`/cdn?file=${encodeURIComponent(playableChapter.videos[0].file.name)}`);
  assert.equal(playback.status, 200);

  const started = await request(app)
    .put(`/api/progress/product/${productId}/module/${moduleId}/chapter/${chapterId}/video/${videoId}`)
    .set(auth)
    .send({ currentTime: 50, duration: 100 });
  assert.equal(started.status, 200);
  assert.equal(started.body.data.progress.started, true);
  assert.equal(started.body.data.progress.completed, false);
  assert.equal(started.body.data.course.progress, 0);

  const progress = await request(app)
    .put(`/api/progress/product/${productId}/module/${moduleId}/chapter/${chapterId}/video/${videoId}`)
    .set(auth)
    .send({ currentTime: 95, duration: 100 });
  assert.equal(progress.status, 200);
  assert.equal(progress.body.data.progress.completed, true);
  assert.equal(progress.body.data.course.progress, 50);
  assert.equal(progress.body.data.course.completed, false);

  const secondProgress = await request(app)
    .put(`/api/progress/product/${productId}/module/${moduleId}/chapter/${chapterId}/video/${secondVideoId}`)
    .set(auth)
    .send({ currentTime: 100, duration: 100 });
  assert.equal(secondProgress.status, 200);
  assert.equal(secondProgress.body.data.course.progress, 100);
  assert.equal(secondProgress.body.data.course.completed, true);
  assert.equal(await VideoProgress.countDocuments({ user: firstUser._id, product: productId }), 2);
  const persistedEnrollment = await Enrollment.findOne({ user: firstUser._id, product: productId });
  assert.equal(persistedEnrollment.progress, 100);
  assert.equal(persistedEnrollment.completed, true);

  const restored = await request(app).get(`/api/progress/product/${productId}`).set(auth);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.data.enrollment.status, "completed");
  assert.equal(restored.body.data.videos.length, 2);
  assert.equal(restored.body.data.videos.find((item) => item.videoId === videoId).currentTime, 95);

  const relogin = await request(app).post("/api/auth/login").send({
    email: "first@example.com",
    password: "Password@123",
  });
  assert.equal(relogin.status, 200);
  const restoredAfterRelogin = await request(app)
    .get(`/api/progress/product/${productId}`)
    .set("Authorization", `Bearer ${relogin.body.token}`);
  assert.equal(restoredAfterRelogin.status, 200);
  assert.equal(restoredAfterRelogin.body.data.enrollment.status, "completed");
  assert.equal(restoredAfterRelogin.body.data.videos.length, 2);
});

test("insufficient wallet balance creates neither enrollment nor debit", async () => {
  const lastUser = await User.findOne({ email: "network8@example.com" });
  const auth = { Authorization: `Bearer ${lastReferralToken}` };
  const denied = await request(app).post(`/api/product/${productId}/enroll`).set(auth).send({ price: 0 });
  assert.equal(denied.status, 400);
  assert.equal(denied.body.message, "Insufficient wallet balance");
  assert.equal(await Enrollment.exists({ user: lastUser._id, product: productId }), null);
  assert.equal(await WalletTransaction.countDocuments({ user: lastUser._id, transactionType: "COURSE_ENROLLMENT" }), 0);
  assert.equal((await Wallet.findOne({ user: lastUser._id })).availableBalance, 0);
  assert.equal(
    (await request(app).put(`/api/progress/product/${productId}/module/${moduleId}/chapter/${chapterId}/video/${videoId}`).set(auth).send({ currentTime: 100, duration: 100 })).status,
    403,
  );
});

test("giveaway, reward, user, enrollment, and dashboard APIs work", async () => {
  const admin = { Authorization: `Bearer ${adminToken}` };
  const user = { Authorization: `Bearer ${userToken}` };
  const startDate = new Date(Date.now() - 60_000).toISOString();
  const endDate = new Date(Date.now() + 86_400_000).toISOString();
  const giveaway = await request(app).post("/api/giveaways").set(admin)
    .field("title", "Course completion campaign")
    .field("description", "Complete a published course to participate.")
    .field("reward", "Published reward")
    .field("startDate", startDate)
    .field("endDate", endDate)
    .field("target", "10")
    .field("isActive", "true")
    .attach("image", Buffer.from([0xff, 0xd8, 0xff]), { filename: "giveaway.jpg", contentType: "image/jpeg" });
  assert.equal(giveaway.status, 201);
  assert.equal(giveaway.body.data.image.orgname, "giveaway.jpg");
  giveawayId = giveaway.body.data._id;
  assert.equal((await request(app).post(`/api/giveaways/${giveawayId}/join`).set(user)).status, 201);
  assert.equal((await request(app).post(`/api/giveaways/${giveawayId}/join`).set(user)).status, 409);
  const participants = await request(app).get(`/api/giveaways/${giveawayId}/participants`).set(admin);
  assert.equal(participants.status, 200);
  assert.equal(participants.body.data.length, 1);

  const reward = await request(app).post("/api/rewards").set(admin).send({
    userId: firstUser._id,
    type: "completion",
    title: "Course completed",
    description: "Awarded from persisted course progress",
    points: 25,
    source: productId,
  });
  assert.equal(reward.status, 201);
  const myRewards = await request(app).get("/api/rewards/my").set(user);
  assert.equal(myRewards.status, 200);
  assert.equal(myRewards.body.data.length, 1);

  const users = await request(app).get("/api/users").set(admin);
  assert.equal(users.status, 200);
  assert.equal(users.body.data.length, 13);
  const enrollments = await request(app).get("/api/admin/enrollments").set(admin);
  assert.equal(enrollments.status, 200);
  assert.equal(enrollments.body.data.length, 1);
  const dashboard = await request(app).get("/api/user/dashboard").set(user);
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.data.stats.enrolledCourses, 1);
  assert.equal(dashboard.body.data.stats.completedCourses, 1);
  assert.equal(dashboard.body.data.stats.videosCompleted, 2);
});

test("admin stats and protected deletion flow work", async () => {
  const stats = await request(app).get("/api/admin/stats").set("Authorization", `Bearer ${adminToken}`);
  assert.equal(stats.status, 200);
  assert.equal(stats.body.data.categories, 1);
  assert.equal(stats.body.data.products, 1);
  assert.equal(stats.body.data.videos, 2);
  assert.equal(stats.body.data.enrollments, 1);
  assert.equal(stats.body.data.giveaways, 1);

  const referralOverview = await request(app).get("/api/admin/referral-overview").set("Authorization", `Bearer ${adminToken}`);
  assert.equal(referralOverview.status, 200);
  assert.equal(referralOverview.body.data.totalReferralUsers, 10);
  assert.equal(referralOverview.body.data.totalReferralRewards > 0, true);
  assert.equal(referralOverview.body.data.totalDebits, 399);

  assert.equal((await request(app).delete(`/api/products/${productId}`).set("Authorization", `Bearer ${adminToken}`)).status, 409);
  await Enrollment.deleteMany({ product: productId });
  assert.equal((await request(app).delete(`/api/products/${productId}`).set("Authorization", `Bearer ${adminToken}`)).status, 200);
  assert.equal((await request(app).delete(`/api/categories/${categoryId}`).set("Authorization", `Bearer ${adminToken}`)).status, 200);
});

test("all admin management pages are served", async () => {
  for (const page of ["index", "categories", "products", "giveaways", "users", "enrollments", "rewards", "referrals"]) {
    const response = await request(app).get(`/admin/${page}.html`);
    assert.equal(response.status, 200, page);
    assert.match(response.text, /Skyllabus|skyllabus/);
    assert.doesNotMatch(response.text, /href="videos\.html"/);
    if (page === "products") {
      assert.match(response.text, /id="courseContent"/);
      assert.match(response.text, /id="addModuleButton"/);
      assert.doesNotMatch(response.text, /productVideoForm|managedVideoRows/);
    }
    if (page === "referrals") {
      assert.match(response.text, /level5Reward/);
      assert.doesNotMatch(response.text, /level6Reward|level7Reward/);
    }
  }
  assert.equal((await request(app).get("/admin/videos.html")).status, 404);
});
