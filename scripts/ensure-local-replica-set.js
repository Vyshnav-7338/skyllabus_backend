const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const dotenv = require("dotenv");
const { mongo } = require("mongoose");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const { MongoClient } = mongo;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function connectDirect(uri) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 750 });
  await client.connect();
  return client;
}

async function ensureLocalReplicaSet() {
  if (String(process.env.LOCAL_MONGODB_AUTOSTART || "").toLowerCase() !== "true") return;

  const port = Number(process.env.LOCAL_MONGODB_PORT || 27018);
  const replicaSet = String(process.env.LOCAL_MONGODB_REPLICA_SET || "rs0");
  const projectRoot = path.join(__dirname, "..");
  // Database files must not live inside the source checkout. Test/build cleanup can
  // remove ignored project directories while mongod is still using them, which
  // causes WiredTiger to abort and the next start to create an empty database.
  const durableRoot = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Skyllabus")
    : path.join(projectRoot, ".local-data");
  const dbPath = process.env.LOCAL_MONGODB_DB_PATH
    ? path.resolve(projectRoot, process.env.LOCAL_MONGODB_DB_PATH)
    : path.join(durableRoot, "mongodb-rs0");
  const logPath = process.env.LOCAL_MONGODB_LOG_PATH
    ? path.resolve(projectRoot, process.env.LOCAL_MONGODB_LOG_PATH)
    : path.join(durableRoot, "mongodb-rs0.log");
  const defaultWindowsBinary = "C:\\Program Files\\MongoDB\\Server\\8.3\\bin\\mongod.exe";
  const mongodPath = process.env.LOCAL_MONGOD_PATH || defaultWindowsBinary;
  const directUri = `mongodb://127.0.0.1:${port}/admin?directConnection=true`;

  let client;
  try {
    client = await connectDirect(directUri);
  } catch (_error) {
    if (!fs.existsSync(mongodPath)) {
      throw new Error(`Local mongod was not found at ${mongodPath}`);
    }
    fs.mkdirSync(dbPath, { recursive: true });
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const child = spawn(
      mongodPath,
      [
        "--dbpath", dbPath,
        "--port", String(port),
        "--bind_ip", "127.0.0.1",
        "--replSet", replicaSet,
        "--logpath", logPath,
        "--logappend",
      ],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    child.unref();

    for (let attempt = 0; attempt < 40 && !client; attempt += 1) {
      await delay(250);
      try {
        client = await connectDirect(directUri);
      } catch (_retryError) {
        // MongoDB is still starting.
      }
    }
  }

  if (!client) throw new Error("Local MongoDB replica-set process did not start");

  try {
    const admin = client.db("admin").admin();
    try {
      await admin.command({ replSetGetStatus: 1 });
    } catch (error) {
      if (error.code !== 94 && error.codeName !== "NotYetInitialized") throw error;
      await admin.command({
        replSetInitiate: {
          _id: replicaSet,
          members: [{ _id: 0, host: `127.0.0.1:${port}` }],
        },
      });
    }

    for (let attempt = 0; attempt < 60; attempt += 1) {
      const hello = await admin.command({ hello: 1 });
      if (hello.isWritablePrimary === true) {
        console.log(`Local MongoDB replica set ${replicaSet} is ready on port ${port} (${dbPath})`);
        return;
      }
      await delay(250);
    }
    throw new Error(`Local MongoDB replica set ${replicaSet} did not elect a primary`);
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  ensureLocalReplicaSet().catch((error) => {
    console.error(`Unable to prepare local MongoDB: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { ensureLocalReplicaSet };
