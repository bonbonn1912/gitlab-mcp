# GitLab Data Center MCP tools

This is the tool inventory and implementation scope for the Gemini CLI MCP server. It targets only the configured GitLab Self-Managed/Data Center instance; `gitlab.com` is rejected.

## Projects and repository

- `get_project` — project metadata and settings.
- `list_projects` — visible projects, with search and pagination.
- `list_repository_tree` — files and directories at a ref/path.
- `get_file` — read a repository file at a branch, tag, or commit.
- `search_repository` — search repository blobs.
- `list_commits` — list commits, optionally by ref/path.
- `get_commit` — commit details.
- `compare_refs` — compare branches, tags, or commits.
- `create_branch` — create a branch.
- `create_commit` — create a commit with repository file actions.
- `list_branches` — list or search branches.
- `list_tags` — list or search tags.
- `list_releases` — list releases.

## Merge requests and issues

- `list_merge_requests` — list MRs with state and search filters.
- `get_merge_request` — MR details by IID.
- `create_merge_request` — create an MR.
- `update_merge_request` — update MR fields/state.
- `get_merge_request_diff` — changed files and diffs.
- `list_merge_request_discussions` — list discussion threads.
- `create_merge_request_comment` — add a discussion note or diff comment.
- `list_issues` — list issues with filters.
- `get_issue` — issue details by IID.
- `create_issue` — create an issue.
- `update_issue` — update issue fields/state.
- `create_issue_comment` — add an issue note.

## Pipelines, jobs, test reports, and artifacts

- `list_pipelines` — list pipelines with ref/status/SHA/user filters.
- `get_pipeline` — pipeline details and status.
- `run_pipeline` — start a pipeline for a ref, optionally with variables.
- `cancel_pipeline` — cancel active jobs in a pipeline.
- `list_pipeline_jobs` — jobs in a pipeline, optionally filtered by status.
- `get_job_details` — job status, stage, timing, runner, and artifact metadata.
- `play_job` — start one specifically selected manual job by job ID.
- `retry_job` — start a job again.
- `cancel_job` — cancel a running job, optionally forcing a job already canceling.
- `get_job_log` — read a job trace; output is capped at 100,000 characters.
- `get_pipeline_test_report` — detailed test results, including failed cases and stack traces.
- `get_pipeline_test_report_summary` — suite totals and pass/fail/error counts.
- `list_job_artifacts` — browse files in a job artifact archive. Requires GitLab 18.8 or newer.
- `get_job_artifact_file` — retrieve an individual file from an artifact archive. Text is returned as UTF-8, binary as Base64; output is capped at 90,000 bytes.
- `get_job_report_artifact` — retrieve a report by type, such as a JUnit report. The `file_type` API parameter requires GitLab 19.4 or newer; output is capped at 90,000 bytes.

Test reports and artifacts can be inspected together with job status and logs to identify failing tests and likely causes. The report APIs return GitLab's parsed test results; the artifact tools retrieve files for further analysis. The MCP does not execute tests itself.

## Shared behavior

- List tools return one page with `items`, `total_count`, `total_pages`, `has_more`, and `next_page`. Use `page` and `per_page` (1–100) to continue.
- Read-only tools are marked read-only. Tools that create or change GitLab state are marked as writes.
- `run_pipeline`, `cancel_pipeline`, `play_job`, `retry_job`, and `cancel_job` change CI state.
- Project IDs can be numeric IDs or URL-encoded namespace paths such as `group/subgroup/project`.
- The token is sent only to the configured instance. Tool inputs cannot choose an arbitrary host.
