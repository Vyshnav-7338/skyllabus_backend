const path = require("path");
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const dns = require("dns");
require("dotenv").config();
// Fix MongoDB Atlas SRV DNS resolution on Windows/PM2
dns.setServers([
  "8.8.8.8",
  "1.1.1.1",
]);


const authRouter = require("./router/auth");
const userRouter = require("./router/user");
const { adminRouter, usersRouter } = require("./router/admin");
const categoryRouter = require("./router/category");
const productRouter = require("./router/product");
const enrollmentRouter = require("./router/enrollment");
const progressRouter = require("./router/progress");
const { paymentRouter, stripeWebhook } = require("./router/payment");

const giveawayRouter = require("./router/giveaway");
const rewardRouter = require("./router/reward");
const walletRouter = require("./router/wallet");
const referralRouter = require("./router/referral");
const cdnRouter = require("./router/cdn");
const chapterPdfRouter = require("./router/chapter-pdf");
const moduleAssessmentRouter = require("./router/module-assessment");
const User = require("./models/User");
const Wallet = require("./models/Wallet");
const { sendApiError } = require("./utils/api-error");

const app = express();
const port = 5000;

app.use(cors());
app.post("/api/payments/stripe/webhook", express.raw({ type: "application/json" }), stripeWebhook);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use("/admin", express.static(path.join(__dirname, "..", "admin")));

app.use(express.static("public"));

app.get("/.well-known/assetlinks.json", (req, res) => {
  res.json([
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: "com.skyllabus.skyllabus",
        sha256_cert_fingerprints: [
          "F4:F6:BF:25:84:F7:6A:91:87:9B:C7:57:C3:DC:35:04:C7:FA:3B:11:38:F2:3E:92:37:14:86:11:12:A2:9D:4D"
        ]
      }
    }
  ]);
});
const fileUpload = require("express-fileupload");
app.use(
  fileUpload({
    limits: {
      fileSize: 50 * 1024 * 1024,
    },
    abortOnLimit: true,
  })
);

app.get("/", (_req, res) => {
  res.json({ success: true, message: "Skyllabus API is running" });
});
app.use("/api/payments", paymentRouter);
app.use("/", cdnRouter);
app.use("/api/auth", authRouter);
app.use("/api/user", userRouter);
app.use("/api/admin", adminRouter);
app.use("/api/users", usersRouter);
app.use("/api/categories", categoryRouter);
app.use("/api/products", productRouter);
app.use("/api/enrollments", enrollmentRouter);
app.use("/api/product", enrollmentRouter);
app.use("/api/progress", progressRouter);
app.use("/api/giveaways", giveawayRouter);
app.use("/api/rewards", rewardRouter);
app.use("/api/wallet", walletRouter);
app.use("/api/referral", referralRouter);
app.use("/api/chapter-pdfs", chapterPdfRouter);
app.use("/api/module-assessments", moduleAssessmentRouter);
ADMIN_NAME='Skyllabus Admin'
ADMIN_EMAIL='admin@skyllabus.com'
ADMIN_PHONE='+910000000000'
ADMIN_PASSWORD='Admin@12345'
MONGODB_URI='mongodb+srv://hibi:eWuXPuntiJRzRDyW@cluster0.x4b5gwa.mongodb.net/skyllabus'
LOCAL_MONGODB_AUTOSTART=true
LOCAL_MONGODB_PORT=27017
JWT_SECRET='local-development-secret-change-before-production'


app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.path}` });
});

app.use((error, _req, res, _next) => {
  if (error && error.name === "MulterError") {
    console.error(error);
    return res.status(400).json({ success: false, message: error.message });
  }
  if (error && (/^(Thumbnail|Images|Video|Note) must be/.test(error.message || "") || /^Unexpected upload field/.test(error.message || ""))) {
    console.error(error);
    return res.status(400).json({ success: false, message: error.message });
  }
  return sendApiError(res, error, { fallbackMessage: "Internal server error" });
});

async function generateReferralCode() {
  let code;
  let exists = true;
  while (exists) {
    code = `SKY${Math.floor(100000 + Math.random() * 900000)}`;
    exists = await User.exists({ referralCode: code });
  }
  return code;
}

async function ensureAdmin() {
  const email = String(ADMIN_EMAIL || "").trim().toLowerCase();
  const password = String(ADMIN_PASSWORD || "");
  const phone = String(ADMIN_PHONE || "").trim();
  if (!email || !password || !phone) return;
  const existing = await User.findOne({ email });
  if (existing) {
    if (existing.role !== "admin") {
      existing.role = "admin";
      await existing.save();
    }
    await Wallet.updateOne({ user: existing._id }, { $setOnInsert: { user: existing._id } }, { upsert: true });
    return;
  }
  const admin = await User.create({
    name: ADMIN_NAME || "Skyllabus Admin",
    email,
    phone,
    password,
    role: "admin",
    referralCode: await generateReferralCode(),
  });
  await Wallet.create({ user: admin._id });
  console.log(`Admin account created for ${email}`);
}

async function migrateLegacyWallets() {
  await Wallet.collection.updateMany(
    {
      $or: [
        { availableBalance: { $exists: false } },
        { totalCredits: { $exists: false } },
        { totalDebits: { $exists: false } },
      ],
    },
    [
      {
        $set: {
          availableBalance: { $ifNull: ["$availableBalance", { $ifNull: ["$balance", 0] }] },
          totalCredits: { $ifNull: ["$totalCredits", { $ifNull: ["$credits", 0] }] },
          totalDebits: { $ifNull: ["$totalDebits", 0] },
        },
      },
      { $unset: ["balance", "credits"] },
    ],
  );
}

async function migrateLegacyUsers() {
  await User.updateMany(
    { $or: [{ status: { $exists: false } }, { status: null }, { status: "" }] },
    { $set: { status: "active" } },
  );
}

async function verifyTransactionSupport() {
  const hello = await mongoose.connection.db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== "isdbgrid") {
    throw new Error(
      "MongoDB must run as a replica set or mongos because signup and enrollment use atomic transactions",
    );
  }
}

async function startServer() {
  if (!MONGODB_URI) throw new Error("MONGODB_URI is required");
  if (!JWT_SECRET) throw new Error("JWT_SECRET is required");
  if (JWT_SECRET.length < 32) throw new Error("JWT_SECRET must contain at least 32 characters");
  await mongoose.connect(MONGODB_URI);
  await verifyTransactionSupport();
  console.log("MongoDB connected");
  await migrateLegacyUsers();
  await migrateLegacyWallets();
  await ensureAdmin();
  app.listen(port, "0.0.0.0", () => {
    console.log(`Skyllabus API listening on http://localhost:${port}`);
    console.log(`Admin website: http://localhost:${port}/admin/login.html`);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error("Unable to start server", error);
    process.exit(1);
  });
}

module.exports = { app, startServer };
