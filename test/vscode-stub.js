// Minimal "vscode" module stub so pure-logic modules can be tested under plain Node.
const cfg = {
  get: (key, def) =>
    key === "credentialsPath" ? process.env.TEST_CRED_PATH || "" : def,
};
module.exports = {
  workspace: { getConfiguration: () => cfg },
};
