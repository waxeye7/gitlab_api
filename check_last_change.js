#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

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

function parseCsv(content) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    if (inQuotes) {
      if (char === '"') {
        const next = content[i + 1];
        if (next === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\r" || char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (char === "\r" && content[i + 1] === "\n") {
        i += 1;
      }
    } else {
      cell += char;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  if (
    rows.length > 0 &&
    rows[rows.length - 1].length === 1 &&
    rows[rows.length - 1][0] === ""
  ) {
    rows.pop();
  }

  return rows;
}

function readCsv(pathname) {
  const raw = fs.readFileSync(pathname, "utf8");
  const rows = parseCsv(raw);
  if (rows.length === 0) {
    return [];
  }
  const headers = rows[0];
  return rows.slice(1).map((cells) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = cells[index] ?? "";
    });
    return record;
  });
}

function getGithubTimestamp(record) {
  return record.pushed_at || record.pushedAt || "";
}

function toDate(value) {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function pickGitlabTimestamp(project) {
  return (
    project.last_repository_updated_at ||
    project.last_activity_at ||
    ""
  );
}

function formatNzDate(value) {
  if (!value) {
    return "n/a";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "n/a";
  }
  return new Intl.DateTimeFormat("en-NZ", {
    timeZone: "Pacific/Auckland",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function compareLastChanges(githubRecords, gitlabRecords) {
  const gitlabByName = {};
  for (const record of gitlabRecords) {
    const name = (record.name || "").trim().toLowerCase();
    if (!name) {
      continue;
    }
    if (!gitlabByName[name]) {
      gitlabByName[name] = record;
    }
  }

  const results = [];
  const counters = {
    compared: 0,
    missingInGitLab: 0,
    gitlabNewer: 0,
    githubNewerOrEqual: 0,
    unknown: 0,
  };

  for (const repo of githubRecords) {
    const name = (repo.name || "").trim();
    if (!name) {
      continue;
    }
    const project = gitlabByName[name.toLowerCase()];
    if (!project) {
      counters.missingInGitLab += 1;
      continue;
    }

    counters.compared += 1;
    const githubTimestamp = getGithubTimestamp(repo);
    const githubDate = toDate(githubTimestamp);
    const gitlabTimestamp = pickGitlabTimestamp(project);
    const gitlabDate = toDate(gitlabTimestamp);

    if (!githubDate && !gitlabDate) {
      counters.unknown += 1;
        results.push({
          name,
          githubPushedAt: githubTimestamp || "",
          gitlabUpdatedAt: gitlabTimestamp || "",
          status: "unknown_timestamps",
        });
      continue;
    }

    if (!githubDate) {
      counters.gitlabNewer += 1;
        results.push({
          name,
          githubPushedAt: githubTimestamp || "",
          gitlabUpdatedAt: gitlabTimestamp || "",
          status: "gitlab_has_timestamp_only",
        });
      continue;
    }

    if (!gitlabDate) {
      counters.githubNewerOrEqual += 1;
        results.push({
          name,
          githubPushedAt: githubTimestamp || "",
          gitlabUpdatedAt: gitlabTimestamp || "",
          status: "github_has_timestamp_only",
        });
        continue;
      }

      if (gitlabDate.getTime() > githubDate.getTime()) {
      counters.gitlabNewer += 1;
      results.push({
          name,
          githubPushedAt: githubTimestamp,
          gitlabUpdatedAt: gitlabTimestamp,
          status: "gitlab_newer",
        });
      } else {
      counters.githubNewerOrEqual += 1;
      results.push({
          name,
          githubPushedAt: githubTimestamp,
          gitlabUpdatedAt: gitlabTimestamp,
          status: "github_newer_or_equal",
        });
      }
  }

  return { results, counters };
}

async function main() {
  loadEnv();

  const githubPath =
    process.env.GITHUB_REPORT_PATH || "github_projects_report.csv";
  const gitlabPath =
    process.env.GITLAB_REPORT_PATH || "gitlab_projects_report.csv";

  if (!fs.existsSync(githubPath)) {
    console.error(`Error: GitHub report '${githubPath}' not found. Run js/crawl_github.js first.`);
    process.exit(1);
  }
  if (!fs.existsSync(gitlabPath)) {
    console.error(`Error: GitLab report '${gitlabPath}' not found. Run js/crawl_gitlab.js first.`);
    process.exit(1);
  }

  console.log(`Loading GitHub report from ${githubPath}`);
  const githubRecords = readCsv(githubPath);
  console.log(`Loaded ${githubRecords.length} GitHub repos.`);

  console.log(`Loading GitLab report from ${gitlabPath}`);
  const gitlabRecords = readCsv(gitlabPath);
  console.log(`Loaded ${gitlabRecords.length} GitLab projects.`);

  const { results, counters } = compareLastChanges(githubRecords, gitlabRecords);

  console.log("\nComparison summary:");
  console.log(`  Repos compared: ${counters.compared}`);
  console.log(`  Missing in GitLab: ${counters.missingInGitLab}`);
  console.log(`  GitLab newer: ${counters.gitlabNewer}`);
  console.log(`  GitHub newer or equal: ${counters.githubNewerOrEqual}`);
  console.log(`  Unknown timestamps: ${counters.unknown}`);

  if (counters.gitlabNewer > 0) {
    console.log("\nRepos where GitLab looks newer:");
    for (const entry of results.filter((item) => item.status === "gitlab_newer")) {
      const ghDate = formatNzDate(entry.githubPushedAt);
      const glDate = formatNzDate(entry.gitlabUpdatedAt);
      console.log(`- ${entry.name}: GitHub pushed_at=${ghDate}, GitLab last_repository_updated_at=${glDate}`);
    }
  } else {
    console.log("\nAll matching repos are up-to-date on GitHub or have equal timestamps.");
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
