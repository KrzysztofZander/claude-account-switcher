// Minimal "vscode" module stub so pure-logic modules can be tested under plain Node.
const scoped = { workspaceValue: undefined, workspaceFolderValue: undefined };

const cfg = {
  get: (key, def) =>
    key === "credentialsPath" ? process.env.TEST_CRED_PATH || "" : def,
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
  __setScopedCredentialsPath: (workspaceValue, workspaceFolderValue) => {
    scoped.workspaceValue = workspaceValue;
    scoped.workspaceFolderValue = workspaceFolderValue;
  },
};
