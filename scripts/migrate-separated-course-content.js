require("dotenv").config();
const mongoose = require("mongoose");
const Product = require("../models/Product");
const ModuleAssessment = require("../models/ModuleAssessment");

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  let moved = 0;
  const products = await Product.find({ "modules.assessment": { $ne: null } });
  for (const product of products) {
    let changed = false;
    for (const module of product.modules || []) {
      if (!module.assessment) continue;
      const a = module.assessment;
      const questions = (a.questions || []).map(q => ({
        question: q.question,
        options: q.options,
        correctOptionIndexes: [q.correctAnswerIndex],
        allowsMultipleSelections: false,
      }));
      await ModuleAssessment.findOneAndUpdate(
        { product: product._id, moduleId: module._id },
        { product: product._id, moduleId: module._id, moduleTitle: module.title, title: a.title || `${module.title} Assessment`, passingPercentage: a.passingPercentage ?? 50, questions, isPublished: a.isPublished !== false },
        { upsert: true, new: true, runValidators: true },
      );
      module.assessment = null;
      changed = true;
      moved += 1;
    }
    if (changed) { product.markModified("modules"); await product.save(); }
  }
  console.log(`Moved ${moved} module assessment(s) into the separate collection.`);
  await mongoose.disconnect();
}
run().catch(async e => { console.error(e); await mongoose.disconnect().catch(()=>{}); process.exit(1); });
