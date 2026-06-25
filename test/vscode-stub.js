// Minimal "vscode" module stub so pure-logic modules can be tested under plain Node.
const cfg = {
  get: (key, def) =>
    key === "credentialsPath" ? process.env.TEST_CRED_PATH || "" : def,
};
class FakeStatusBarItem {
  show() {}
  dispose() {}
}
module.exports = {
  workspace: { getConfiguration: () => cfg },
  window: {
    createStatusBarItem: () => new FakeStatusBarItem(),
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ThemeColor: class ThemeColor {
    constructor(id) {
      this.id = id;
    }
  },
};
