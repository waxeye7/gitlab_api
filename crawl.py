import csv
import os
import sys
import requests
from dotenv import load_dotenv
from urllib.parse import quote

load_dotenv()

GITLAB_URL = "https://gitlab.com"   # change if self-hosted
PRIVATE_TOKEN = os.getenv("GITLAB_TOKEN")
GROUP_PATH = "batchnz/work"  # e.g. "company/work" if it's nested

if not PRIVATE_TOKEN:
    print("Error: GITLAB_TOKEN not found.")
    print("Please create a .env file and add GITLAB_TOKEN=your_token")
    sys.exit(1)

session = requests.Session()
session.headers.update({"PRIVATE-TOKEN": PRIVATE_TOKEN})

# 1) get group id from path
encoded_group_path = quote(GROUP_PATH, safe="")

resp = session.get(f"{GITLAB_URL}/api/v4/groups/{encoded_group_path}")
try:
    resp.raise_for_status()
except requests.HTTPError as exc:
    if resp.status_code == 401:
        print("Error: Unauthorized (401).")
        print("The GITLAB_TOKEN likely expired or lacks the read_api scope.")
    elif resp.status_code == 404:
        print("Error: Group path not found (404).")
        print(f"Check GROUP_PATH '{GROUP_PATH}' in crawl.py and ensure the token can access it.")
    else:
        print(f"Unexpected error when fetching group info: {exc}")
    raise
group = resp.json()
group_id = group["id"]

projects = []
page = 1
while True:
    r = session.get(
        f"{GITLAB_URL}/api/v4/groups/{group_id}/projects",
        params={
            "include_subgroups": True,
            "per_page": 100,
            "page": page,
            "order_by": "path",
        },
    )
    r.raise_for_status()
    data = r.json()
    if not data:
        break
    projects.extend(data)

    next_page = r.headers.get("X-Next-Page")
    if not next_page:
        break
    page = int(next_page)

# 2) write report
with open("gitlab_projects_report.csv", "w", newline="", encoding="utf-8") as f:
    writer = csv.writer(f)
    writer.writerow([
        "name",
        "path_with_namespace",
        "archived",
        "last_activity_at",
        "web_url",
        "empty_repo",
        "visibility",
    ])
    for p in projects:
        writer.writerow([
            p.get("name"),
            p.get("path_with_namespace"),
            p.get("archived"),
            p.get("last_activity_at"),
            p.get("web_url"),
            p.get("empty_repo"),
            p.get("visibility"),
        ])

print(f"Exported {len(projects)} projects to gitlab_projects_report.csv")
