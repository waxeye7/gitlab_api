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

function loadGithubReport(pathname) {
  const records = readCsv(pathname);
  const repos = {};
  const duplicates = {};

  for (const record of records) {
    const name = (record.name || "").trim();
    if (!name) {
      continue;
    }
    const key = name.toLowerCase();
    if (repos[key]) {
      if (!duplicates[key]) {
        duplicates[key] = [];
      }
      duplicates[key].push(record);
    } else {
      repos[key] = record;
    }
  }

  const duplicateKeys = Object.keys(duplicates);
  if (duplicateKeys.length > 0) {
    console.error(
      `Warning: found ${duplicateKeys.length} duplicate GitHub repo names. Using first occurrence.`,
    );
  }

  return repos;
}

function loadGitlabReport(pathname) {
  const records = readCsv(pathname);
  const projects = {};
  const duplicates = {};

  for (const record of records) {
    const name = (record.name || "").trim();
    if (!name) {
      continue;
    }
    const key = name.toLowerCase();
    if (projects[key]) {
      if (!duplicates[key]) {
        duplicates[key] = [];
      }
      duplicates[key].push(record);
    } else {
      projects[key] = record;
    }
  }

  const duplicateKeys = Object.keys(duplicates);
  if (duplicateKeys.length > 0) {
    console.error(
      `Warning: found ${duplicateKeys.length} duplicate GitLab project names. Using first occurrence.`,
    );
  }

  return projects;
}

function compare(github, gitlab) {
  const rows = [];
  const counters = {
    missing: 0,
    archived: 0,
    not_archived: 0,
    total_github: 0,
  };

  const keys = Object.keys(github).sort();
  for (const key of keys) {
    const ghRepo = github[key];
    const glProject = gitlab[key];

    if (!glProject) {
      counters.missing += 1;
      continue;
    }

    const gitlabArchived = glProject.archived;
    const archivedValue =
      typeof gitlabArchived === "string"
        ? gitlabArchived.toLowerCase()
        : String(gitlabArchived).toLowerCase();

    if (archivedValue === "true" || archivedValue === "1") {
      counters.archived += 1;
      continue;
    }

    counters.not_archived += 1;
    rows.push({
      github_name: ghRepo.name,
      github_name_with_owner:
        ghRepo.name_with_owner || ghRepo.nameWithOwner || "",
      github_archived: ghRepo.archived || ghRepo.isArchived || "",
      github_visibility: ghRepo.visibility || "",
      gitlab_path_with_namespace: glProject.path_with_namespace || "",
      gitlab_archived: glProject.archived,
      status: "gitlab_not_archived",
    });
  }

  counters.total_github = keys.length;
  return { rows, counters };
}

async function main() {
  loadEnv();

  const githubPath =
    process.env.GITHUB_REPORT_PATH || "github_projects_report.csv";
  const gitlabPath =
    process.env.GITLAB_REPORT_PATH || "gitlab_projects_report.csv";
  const outputPath =
    process.env.GITHUB_GITLAB_REPORT || "github_gitlab_archive_report.csv";

  if (!fs.existsSync(githubPath)) {
    console.error(`Error: GitHub report '${githubPath}' not found.`);
    process.exit(1);
  }

  if (!fs.existsSync(gitlabPath)) {
    console.error(`Error: GitLab report '${gitlabPath}' not found.`);
    process.exit(1);
  }

  console.log(`Loading GitHub report from ${githubPath}`);
  const github = loadGithubReport(githubPath);
  console.log(`Loaded ${Object.keys(github).length} GitHub repos.`);

  console.log(`Loading GitLab report from ${gitlabPath}`);
  const gitlab = loadGitlabReport(gitlabPath);
  console.log(`Loaded ${Object.keys(gitlab).length} GitLab projects.`);

  const { rows, counters } = compare(github, gitlab);

  writeCsv(
    outputPath,
    [
      "github_name",
      "github_name_with_owner",
      "github_archived",
      "github_visibility",
      "gitlab_path_with_namespace",
      "gitlab_archived",
      "status",
    ],
    rows,
  );

  console.log(`Wrote comparison report to ${outputPath}`);
  console.log(`GitHub repos checked: ${counters.total_github}`);
  console.log(`Missing in GitLab: ${counters.missing} (ignored)`);
  console.log(`GitLab not archived: ${counters.not_archived}`);

  if (rows.length > 0) {
    console.log("\nFound in GitLab but not archived:");
    for (const row of rows) {
      const name = row.github_name_with_owner || row.github_name;
      const glPath = row.gitlab_path_with_namespace || "unknown GitLab path";
      console.log(`- ${name} -> ${glPath}`);
    }
  } else {
    console.log(
      "\nAll matching GitLab projects are archived. Nothing to report.",
    );
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
