## Prereqs

- Copy `.env.example` → `.env` and fill in the GitLab PAT (readonly token lives in Alex’s GitLab 1Password entry). All other envs already default to `batchnz` values, so tweak only if you need a different org/group.
- Install Node (v18+) and the GitHub CLI:
  ```bash
  brew install node gh   # or use your OS package manager
  ```
- Authenticate the GitHub CLI once: `gh auth login` → GitHub.com → HTTPS → “Yes” to using `gh` for git operations → paste a Personal Access Token or log in via browser.

## Workflow

1. Clone the repo and set up `.env` as above. Make sure `GITLAB_TOKEN` is present in `.env`.
2. Run the crawlers (CSV files are git‑ignored, so this always has to happen before any checks):

   ```bash
   node crawl_github.js
   node crawl_gitlab.js
   ```

   - `crawl_github` talks to the `gh` CLI, so ensure you are logged in.
   - `crawl_gitlab` uses the PAT from `.env`.

3. Once the two CSVs exist (`github_projects_report.csv`, `gitlab_projects_report.csv`), run whichever analyses you need:
   - `node check_last_change.js` – compares `pushed_at` vs `last_repository_updated_at` to confirm GitHub has the latest commits.
   - `node check_legacy_repos.js` – finds GitLab projects under `batchnz/work/legacy` and reports which ones exist on GitHub.
   - `node compare_github_gitlab.js` – original archive-status cross-check.
   - `node check_repo_status.js <repo>` – spot-check a single repo using gh cli and gitlab api (not csv's for this one)

Every non-crawl script only reads the CSV reports generated in step 2, so re-run the crawlers whenever you need fresh data. CSV outputs stay local (git ignores `*.csv`) to avoid accidental leaks.
