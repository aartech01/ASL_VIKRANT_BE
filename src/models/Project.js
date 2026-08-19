const mongoose = require("mongoose");

/*
 * One document holds the whole dashboard state (BOQ, schedule, approvals,
 * risks, tasks, photo metadata, rates, etc.) as a single JSON blob, mirroring
 * the shape the frontend already keeps in memory. _id is fixed so there is
 * always exactly one shared project document — this app manages one site.
 */
const ProjectSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "vikrant-unit3" },
    state: { type: mongoose.Schema.Types.Mixed, required: true },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true, _id: false }
);

module.exports = mongoose.model("Project", ProjectSchema);
