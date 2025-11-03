#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const https = require("https");

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

async function fetchGroup(apiBase, token, groupPath) {
  const encodedPath = encodeURIComponent(groupPath);
  const url = `${apiBase}/groups/${encodedPath}`;
  try {
    const { body } = await gitlabGet(url, { "PRIVATE-TOKEN": token });
    try {
      return JSON.parse(body);
    } catch (parseError) {
      throw new Error("Failed to parse GitLab group response as JSON.");
    }
  } catch (error) {
    if (error.statusCode === 401) {
      console.error("Error: Unauthorized (401).");
      console.error(
        "The GITLAB_TOKEN likely expired or lacks the read_api scope.",
      );
    } else if (error.statusCode === 404) {
      console.error("Error: Group path not found (404).");
      console.error(
        `Check GROUP_PATH '${groupPath}' in crawl_gitlab.js and ensure the token can access it.`,
      );
    } else if (error.statusCode) {
      console.error(
        `Unexpected error when fetching group info: ${error.statusCode}`,
      );
    } else {
      console.error(`Unexpected error when fetching group info: ${error.message}`);
    }
    throw error;
  }
}

async function fetchProjects(apiBase, token, groupId) {
  const records = [];
  let page = 1;

  while (true) {
    const url = new URL(`${apiBase}/groups/${groupId}/projects`);
    url.searchParams.set("include_subgroups", "true");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    url.searchParams.set("order_by", "path");

    const response = await gitlabGet(url.toString(), { "PRIVATE-TOKEN": token });
    let data;
    try {
      data = JSON.parse(response.body);
    } catch (error) {
      throw new Error("Failed to parse GitLab JSON response.");
    }
    if (!Array.isArray(data) || data.length === 0) {
      break;
    }
    records.push(...data);

    const nextPage = response.headers["x-next-page"];
    if (!nextPage) {
      break;
    }
    page = parseInt(nextPage, 10);
    if (Number.isNaN(page) || page < 1) {
      break;
    }
  }

  return records;
}

async function fetchProjectDetail(apiBase, token, projectId) {
  const url = `${apiBase}/projects/${projectId}`;
  const { body } = await gitlabGet(url, { "PRIVATE-TOKEN": token });
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error("Failed to parse GitLab project detail response as JSON.");
  }
}

async function fetchProjectDetailsConcurrently(apiBase, token, projects) {
  const concurrencyRaw = process.env.GITLAB_DETAIL_CONCURRENCY || "8";
  const parsed = parseInt(concurrencyRaw, 10);
  const concurrency =
    Number.isNaN(parsed) || parsed < 1 ? 8 : Math.min(parsed, 16);

  let index = 0;
  let fetched = 0;

  async function worker() {
    while (true) {
      const currentIndex = index;
      index += 1;
      if (currentIndex >= projects.length) {
        return;
      }
      const project = projects[currentIndex];
      if (project.last_repository_updated_at) {
        continue;
      }
      try {
        const detail = await fetchProjectDetail(apiBase, token, project.id);
        project.last_repository_updated_at = detail.last_repository_updated_at;
        if (!project.last_activity_at) {
          project.last_activity_at = detail.last_activity_at;
        }
      } catch (error) {
        console.error(
          `Warning: failed to load extra details for project ${project.id}: ${error.message}`,
        );
      }
      fetched += 1;
      if (fetched % 25 === 0 || fetched === projects.length) {
        console.log(`  Fetched detail for ${fetched}/${projects.length} projects...`);
      }
    }
  }

  const workers = [];
  const workerCount = Math.min(concurrency, projects.length);
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
}

async function main() {
  loadEnv();

  const baseUrl = (process.env.GITLAB_URL || "https://gitlab.com").replace(
    /\/$/,
    "",
  );
  const apiBase = `${baseUrl}/api/v4`;
  const token = process.env.GITLAB_TOKEN;
  const groupPath = process.env.GITLAB_GROUP_PATH || "batchnz/work";
  const outputPath =
    process.env.GITLAB_REPORT_PATH || "gitlab_projects_report.csv";

  if (!token) {
    console.error("Error: GITLAB_TOKEN not found.");
    console.error("Please create a .env file and add GITLAB_TOKEN=your_token");
    process.exit(1);
  }

  let group;
  try {
    group = await fetchGroup(apiBase, token, groupPath);
  } catch (error) {
    process.exit(1);
  }

  const groupId = group.id;
  const projects = await fetchProjects(apiBase, token, groupId);
  console.log("Fetching GitLab project details to capture repository timestamps ...");
  await fetchProjectDetailsConcurrently(apiBase, token, projects);

  const rows = projects.map((p) => ({
    name: p.name,
    path_with_namespace: p.path_with_namespace,
    archived: p.archived,
    last_activity_at: p.last_activity_at,
    web_url: p.web_url,
    empty_repo: p.empty_repo,
    visibility: p.visibility,
    last_repository_updated_at: p.last_repository_updated_at,
  }));

  writeCsv(
    outputPath,
    [
      "name",
      "path_with_namespace",
      "archived",
      "last_activity_at",
      "web_url",
      "empty_repo",
      "visibility",
      "last_repository_updated_at",
    ],
    rows,
  );

  console.log(
    `Exported ${projects.length} projects to ${outputPath}`,
  );
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
