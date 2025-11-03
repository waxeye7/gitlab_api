#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execFile } = require("child_process");

function loadEnv(envPath = path.join(process.cwd(), ".env")) {
  if (!fs.existsSync(envPath)) {
    return;
  }
  const raw = fs.readFileSync(envPath, "utf8");
  raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .forEach((line) => {
      const eq = line.indexOf("=");
      if (eq === -1) {
        return;
      }
      const key = line.slice(0, eq).trim();
      if (!key) {
        return;
      }
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
        process.env[key] = value;
      }
    });
}

function runGh(args) {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        if (error.code === "ENOENT") {
          reject(new Error("gh CLI not found in PATH."));
          return;
        }
        const message = stderr ? stderr.trim() : error.message;
        reject(new Error(`gh command failed: ${message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function fetchGithubRepo(org, name) {
  const stdout = await runGh([
    "repo",
    "view",
    `${org}/${name}`,
    "--json",
    "name,nameWithOwner,isArchived,visibility,url,sshUrl",
  ]);
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error("Failed to parse gh output as JSON.");
  }
}

function gitlabGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        { headers },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            const status = res.statusCode || 0;
            if (status >= 400) {
              const error = new Error(
                `GitLab request failed with status ${status}`,
              );
              error.statusCode = status;
              error.body = data;
              error.headers = res.headers;
              reject(error);
              return;
            }
            resolve({ body: data, headers: res.headers });
          });
        },
      )
      .on("error", (error) => reject(error));
  });
}

async function fetchGitlabProject(apiBase, token, groupPath, repoName) {
  const fullPath = `${groupPath.replace(/\/$/, "")}/${repoName}`;
  const encoded = encodeURIComponent(fullPath);
  const url = `${apiBase}/projects/${encoded}`;
  try {
    const { body } = await gitlabGet(url, { "PRIVATE-TOKEN": token });
    try {
      return JSON.parse(body);
    } catch (parseError) {
      throw new Error("Failed to parse GitLab project response as JSON.");
    }
  } catch (error) {
    if (error.statusCode === 404) {
      return null;
    }
    throw new Error(
      `GitLab request failed for project '${fullPath}': ${error.message}`,
    );
  }
}

async function main() {
  loadEnv();

  const org = process.env.GITHUB_ORG || "batchnz";
  const groupPath = process.env.GITLAB_GROUP_PATH || "batchnz/work";
  const baseUrl = (process.env.GITLAB_URL || "https://gitlab.com").replace(
    /\/$/,
    "",
  );
  const apiBase = `${baseUrl}/api/v4`;
  const token = process.env.GITLAB_TOKEN;

  const [, , repoName] = process.argv;
  if (!repoName) {
    console.error(
      "Usage: node js/check_repo_status.js <repo_name_without_org>",
    );
    process.exit(1);
  }

  if (!token) {
    console.error("GITLAB_TOKEN missing. Set it before running this script.");
    process.exit(1);
  }

  console.log(`Checking GitHub repo ${org}/${repoName} ...`);
  let github;
  try {
    github = await fetchGithubRepo(org, repoName);
  } catch (error) {
    console.error(`GitHub error: ${error.message}`);
    process.exit(1);
  }

  console.log("  visibility:", github.visibility);
  console.log("  archived:", github.isArchived);
  console.log("  url:", github.url);

  console.log(`\nChecking GitLab project ${groupPath}/${repoName} ...`);
  let gitlab;
  try {
    gitlab = await fetchGitlabProject(apiBase, token, groupPath, repoName);
  } catch (error) {
    console.error(`GitLab error: ${error.message}`);
    process.exit(1);
  }

  if (!gitlab) {
    console.log("  project not found in GitLab.");
    return;
  }

  console.log("  visibility:", gitlab.visibility);
  console.log("  archived:", gitlab.archived);
  console.log("  web_url:", gitlab.web_url);
  console.log("  last_activity_at:", gitlab.last_activity_at);
  console.log("  empty_repo:", gitlab.empty_repo);

  if (gitlab.archived === true) {
    console.log("\nResult: OK - GitLab project is archived.");
  } else if (gitlab.archived === false) {
    console.log("\nResult: ATTENTION - GitLab project is NOT archived.");
  } else {
    console.log(
      `\nResult: UNKNOWN - GitLab archived flag is ${JSON.stringify(
        gitlab.archived,
      )}`,
    );
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
