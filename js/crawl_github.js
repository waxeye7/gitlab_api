#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
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

function writeCsv(pathname, headers, records) {
  const rows = [headers.join(",")];
  for (const record of records) {
    const row = headers
      .map((header) => stringifyCsvValue(record[header]))
      .join(",");
    rows.push(row);
  }
  fs.writeFileSync(pathname, `${rows.join("\n")}\n`, "utf8");
}

function stringifyCsvValue(value) {
  if (value === undefined || value === null) {
    return "";
  }
  const stringValue =
    typeof value === "string" ? value : String(value);
  if (/[",\n\r]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

async function fetchGitHubRepos(org, limit) {
  const stdout = await runGh([
    "repo",
    "list",
    org,
    "--json",
    "name,nameWithOwner,isArchived,visibility,url",
    "--limit",
    String(limit),
  ]);
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error("Failed to parse gh output as JSON.");
  }
}

async function main() {
  loadEnv();

  const org = process.env.GITHUB_ORG || "batchnz";
  const reportPath =
    process.env.GITHUB_REPORT_PATH || "github_projects_report.csv";
  const limitRaw = process.env.GITHUB_REPO_LIMIT || "1000";
  const parsedLimit = parseInt(limitRaw, 10);
  const limit = Number.isNaN(parsedLimit) ? 1000 : parsedLimit;

  console.log(`Fetching GitHub repos for org '${org}' via gh CLI...`);
  const repos = await fetchGitHubRepos(org, limit);
  console.log(`Fetched ${repos.length} GitHub repos.`);

  const rows = repos.map((repo) => ({
    name: repo.name,
    name_with_owner: repo.nameWithOwner,
    archived: repo.isArchived,
    visibility: repo.visibility,
    url: repo.url,
  }));

  writeCsv(reportPath, ["name", "name_with_owner", "archived", "visibility", "url"], rows);
  console.log(`Wrote GitHub report to ${reportPath}`);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
