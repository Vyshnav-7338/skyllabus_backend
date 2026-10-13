const path = require("path");
const dotenv = require("dotenv");
const { mongo } = require("mongoose");
const { ensureLocalReplicaSet } = require("./ensure-local-replica-set");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const { MongoClient } = mongo;

async function migrate() {
  await ensureLocalReplicaSet();
  const sourceUri = process.env.MIGRATION_SOURCE_MONGODB_URI || "mongodb://127.0.0.1:27017/skyllabus";
  const targetUri = process.env.MONGODB_URI;
  if (!targetUri) throw new Error("MONGODB_URI is required");

  const source = new MongoClient(sourceUri);
  const target = new MongoClient(targetUri);
  await Promise.all([source.connect(), target.connect()]);
  try {
    const sourceDb = source.db();
    const targetDb = target.db();
    const targetCollections = await targetDb.listCollections({}, { nameOnly: true }).toArray();
    for (const collection of targetCollections) {
      if (!collection.name.startsWith("system.") && await targetDb.collection(collection.name).estimatedDocumentCount() > 0) {
        throw new Error("Target Skyllabus database is not empty; migration was stopped to prevent duplicates");
      }
    }

    const sourceCollections = await sourceDb.listCollections({}, { nameOnly: true }).toArray();
    let copied = 0;
    for (const collection of sourceCollections) {
      if (collection.name.startsWith("system.")) continue;
      const documents = await sourceDb.collection(collection.name).find().toArray();
      if (documents.length > 0) {
        await targetDb.collection(collection.name).insertMany(documents, { ordered: true });
        copied += documents.length;
      }
    }
    console.log(`Migrated ${copied} Skyllabus documents to the local replica set`);
  } finally {
    await Promise.all([source.close(), target.close()]);
  }
}

migrate().catch((error) => {
  console.error(`Unable to migrate local MongoDB: ${error.message}`);
  process.exit(1);
});
