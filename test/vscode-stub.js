// Minimal "vscode" module stub so pure-logic modules can be tested under plain Node.
const scoped = { workspaceValue: undefined, workspaceFolderValue: undefined };

const cfg = {
  get: (key, def) =>
    key === "credentialsPath" ? process.env.TEST_CRED_PATH || "" : def,
  // Mirrors WorkspaceConfiguration.inspect, so per-scope validation can be tested.
  inspect: (key) =>
    key === "credentialsPath"
      ? {
          key: "claudeSwitcher." + key,
          defaultValue: "",
          globalValue: process.env.TEST_CRED_PATH || undefined,
          workspaceValue: scoped.workspaceValue,
          workspaceFolderValue: scoped.workspaceFolderValue,
        }
      : undefined,
};

module.exports = {
  workspace: { getConfiguration: () => cfg },
  /** Test hook: sets the workspace-scoped values `inspect` reports. */
  __setScopedCredentialsPath: (workspaceValue, workspaceFolderValue) => {
    scoped.workspaceValue = workspaceValue;
    scoped.workspaceFolderValue = workspaceFolderValue;
  },
};
