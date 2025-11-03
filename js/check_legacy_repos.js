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

async function main() {
  loadEnv();

  const githubPath =
    process.env.GITHUB_REPORT_PATH || "github_projects_report.csv";
  const gitlabPath =
    process.env.GITLAB_REPORT_PATH || "gitlab_projects_report.csv";
  const legacyPrefix =
    (process.env.GITLAB_LEGACY_GROUP_PATH || "batchnz/work/legacy").toLowerCase();

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
  const githubByName = {};
  for (const repo of githubRecords) {
    const key = (repo.name || "").trim().toLowerCase();
    if (!key || githubByName[key]) {
      continue;
    }
    githubByName[key] = repo;
  }
  console.log(`Loaded ${githubRecords.length} GitHub repos.`);

  console.log(`Loading GitLab report from ${gitlabPath}`);
  const gitlabRecords = readCsv(gitlabPath);
  console.log(`Loaded ${gitlabRecords.length} GitLab projects.`);

  const legacyProjects = gitlabRecords.filter((project) => {
    const pathWithNamespace = (project.path_with_namespace || "").toLowerCase();
    return pathWithNamespace.startsWith(legacyPrefix);
  });

  const matches = [];
  const missing = [];

  for (const project of legacyProjects) {
    const key = (project.name || "").trim().toLowerCase();
    if (!key) {
      continue;
    }
    const repo = githubByName[key];
    if (repo) {
      matches.push({
        name: project.name,
        githubArchived: repo.archived || repo.isArchived || "",
        githubVisibility: repo.visibility || "",
        githubUrl: repo.url || "",
        gitlabArchived: project.archived,
        gitlabPath: project.path_with_namespace,
        gitlabUrl: project.web_url,
      });
    } else {
      missing.push({
        name: project.name,
        gitlabArchived: project.archived,
        gitlabPath: project.path_with_namespace,
        gitlabUrl: project.web_url,
      });
    }
  }

  console.log("\nSummary:");
  console.log(`  Legacy projects total: ${legacyProjects.length}`);
  console.log(`  Legacy projects with GitHub repo: ${matches.length}`);
  console.log(`  Legacy projects missing from GitHub: ${missing.length}`);

  if (matches.length > 0) {
    console.log("\nLegacy projects present in GitHub:");
    for (const item of matches) {
      console.log(
        `- ${item.name}: GitHub archived=${item.githubArchived}, GitLab archived=${item.gitlabArchived}, GH=${item.githubUrl}, GL=${item.gitlabUrl}`,
      );
    }
  } else {
    console.log("\nNo GitLab legacy projects found in GitHub.");
  }

  if (missing.length > 0) {
    console.log("\nLegacy projects missing from GitHub:");
    for (const item of missing) {
      console.log(
        `- ${item.name}: GitLab archived=${item.gitlabArchived}, path=${item.gitlabPath}, url=${item.gitlabUrl}`,
      );
    }
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
