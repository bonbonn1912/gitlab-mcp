import { McpServer, type CallToolResult, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import {
  encodePathSegment,
  GitLabApiError,
  GitLabClient,
  type QueryParams,
} from "./gitlab-client.js";

const MAX_TOOL_TEXT_CHARS = 150_000;
const MAX_FILE_CHARS = 100_000;

const projectId = z.union([z.string().min(1), z.number().int().positive()])
  .describe("GitLab project ID or URL-encoded path such as group/subgroup/project.");
const pagination = {
  page: z.number().int().min(1).default(1).describe("Page number (GitLab REST pagination is one-based)."),
  per_page: z.number().int().min(1).max(100).default(20).describe("Maximum items in this page, from 1 to 100."),
};
const projectArgs = { project_id: projectId };

function createServer(): McpServer {
  const instanceUrl = process.env.GITLAB_URL?.trim();
  const token = process.env.GITLAB_TOKEN?.trim();
  if (!instanceUrl) throw new Error("GITLAB_URL is required and must point to a GitLab Self-Managed instance.");
  if (!token) throw new Error("GITLAB_TOKEN is required. Configure it as an environment variable.");
  const api = new GitLabClient(instanceUrl, token);

  const server = new McpServer(
    { name: "gitlab-datacenter-mcp-server", version: "1.0.0" },
    {
      instructions:
        "Use this server only for the configured GitLab Self-Managed/Data Center instance. " +
        "Project IDs can be numeric IDs or full namespace paths. List tools return one page at a time; " +
        "follow next_page when more results are needed. Write tools change GitLab state and should be used only when requested.",
    },
  );

  registerTools(server, api);
  return server;
}

type ZodObjectSchema = z.ZodObject<any>;
type ToolHandler<T extends ZodObjectSchema> = (args: z.infer<T>) => Promise<unknown>;

function register<T extends ZodObjectSchema>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: T,
  handler: ToolHandler<T>,
  readOnly = true,
): void {
  const callback = async (args: unknown): Promise<CallToolResult> => {
    try {
      return makeToolResult(await handler(args as z.infer<T>));
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: formatToolError(error) }],
      };
    }
  };

  server.registerTool(
    name,
    {
      title: name,
      description,
      inputSchema: inputSchema as unknown as StandardSchemaWithJSON,
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: !readOnly,
        idempotentHint: readOnly,
        openWorldHint: true,
      },
    },
    callback,
  );
}

function makeToolResult(value: unknown): CallToolResult {
  const json = JSON.stringify(value, null, 2);
  if (json.length > MAX_TOOL_TEXT_CHARS) {
    return {
      content: [{
        type: "text" as const,
        text: `${json.slice(0, MAX_TOOL_TEXT_CHARS)}\n\n[Output truncated at ${MAX_TOOL_TEXT_CHARS} characters. Narrow the query or request a specific file/resource.]`,
      }],
    };
  }
  const structuredContent =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : { result: value };
  return {
    content: [{ type: "text" as const, text: json }],
    structuredContent,
  };
}

function formatToolError(error: unknown): string {
  if (error instanceof GitLabApiError) {
    return `${error.message}${error.requestId ? ` (GitLab request ID: ${error.requestId})` : ""}`;
  }
  if (error instanceof Error) return error.message;
  return "An unknown error occurred while calling the GitLab API.";
}

function projectPath(project: string | number, suffix = ""): string {
  return `projects/${encodePathSegment(project)}${suffix}`;
}

interface PageArgs {
  page: number;
  per_page: number;
}

async function listPage<T>(
  api: GitLabClient,
  path: string,
  args: PageArgs,
  extra: QueryParams = {},
): Promise<Record<string, unknown>> {
  const response = await api.request<T[]>("GET", path, {
    ...extra,
    page: args.page,
    per_page: args.per_page,
  });
  if (!Array.isArray(response.data)) {
    throw new Error("GitLab returned an unexpected response for a list endpoint.");
  }
  const nextPageHeader = response.headers.get("x-next-page");
  const totalHeader = response.headers.get("x-total");
  const totalPagesHeader = response.headers.get("x-total-pages");
  const nextPage = nextPageHeader ? Number(nextPageHeader) : null;
  return {
    items: response.data,
    page: args.page,
    per_page: args.per_page,
    total_count: totalHeader && Number.isFinite(Number(totalHeader)) ? Number(totalHeader) : null,
    total_pages: totalPagesHeader && Number.isFinite(Number(totalPagesHeader)) ? Number(totalPagesHeader) : null,
    has_more: nextPage !== null,
    next_page: nextPage,
  };
}

function registerTools(server: McpServer, api: GitLabClient): void {
  register(server, "get_project", "Get project metadata and settings by project ID or namespace path.",
    z.object({ ...projectArgs }).strict(),
    ({ project_id }) => api.request("GET", projectPath(project_id)).then((r) => r.data));

  register(server, "list_projects", "List projects visible to the authenticated user. Supports search and GitLab pagination.",
    z.object({
      search: z.string().min(1).optional().describe("Optional project name/path search."),
      membership: z.boolean().optional().describe("When true, list only projects the current user is a member of."),
      archived: z.boolean().optional(),
      visibility: z.enum(["public", "internal", "private"]).optional(),
      ...pagination,
    }).strict(),
    (a) => listPage(api, "projects", a, { search: a.search, membership: a.membership, archived: a.archived, visibility: a.visibility }));

  register(server, "list_repository_tree", "List files and directories at a repository path and ref.",
    z.object({ ...projectArgs, path: z.string().default(""), ref: z.string().optional(), recursive: z.boolean().default(false), ...pagination }).strict(),
    (a) => listPage(api, projectPath(a.project_id, "/repository/tree"), a, { path: a.path, ref: a.ref, recursive: a.recursive }));

  register(server, "get_file", "Read a text file from a repository ref. File content is decoded from GitLab's Base64 response.",
    z.object({ ...projectArgs, file_path: z.string().min(1), ref: z.string().min(1).describe("Branch, tag, or commit SHA.") }).strict(),
    async ({ project_id, file_path, ref }) => {
      const response = await api.request<Record<string, unknown>>(
        "GET",
        projectPath(project_id, `/repository/files/${encodePathSegment(file_path)}`),
        { ref },
      );
      const file = response.data;
      if (typeof file.content !== "string") return file;
      const bytes = Buffer.from(file.content, "base64");
      let content: string;
      let contentEncoding: "utf-8" | "base64" = "utf-8";
      try {
        if (bytes.includes(0)) throw new Error("binary content");
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        content = bytes.toString("base64");
        contentEncoding = "base64";
      }
      const truncated = content.length > MAX_FILE_CHARS;
      return {
        ...file,
        content: truncated ? content.slice(0, MAX_FILE_CHARS) : content,
        content_encoding: contentEncoding,
        content_truncated: truncated,
      };
    });

  register(server, "search_repository", "Search repository blobs by text. GitLab's project search endpoint and instance permissions apply.",
    z.object({ ...projectArgs, query: z.string().min(1), ...pagination }).strict(),
    (a) => listPage(api, projectPath(a.project_id, "/search"), a, { scope: "blobs", search: a.query }));

  register(server, "list_commits", "List commits in a project, optionally filtered by ref or repository path.",
    z.object({ ...projectArgs, ref_name: z.string().optional(), path: z.string().optional(), ...pagination }).strict(),
    (a) => listPage(api, projectPath(a.project_id, "/repository/commits"), a, { ref_name: a.ref_name, path: a.path }));

  register(server, "get_commit", "Get details for a commit SHA or ref.",
    z.object({ ...projectArgs, sha: z.string().min(1) }).strict(),
    ({ project_id, sha }) => api.request("GET", projectPath(project_id, `/repository/commits/${encodePathSegment(sha)}`)).then((r) => r.data));

  register(server, "compare_refs", "Compare two branches, tags, or commits in a project.",
    z.object({ ...projectArgs, from_ref: z.string().min(1), to_ref: z.string().min(1), straight: z.boolean().default(false) }).strict(),
    ({ project_id, from_ref, to_ref, straight }) => api.request("GET", projectPath(project_id, "/repository/compare"), { from: from_ref, to: to_ref, straight }).then((r) => r.data));

  register(server, "create_branch", "Create a branch from an existing branch, tag, or commit SHA.",
    z.object({ ...projectArgs, branch: z.string().min(1), ref: z.string().min(1) }).strict(),
    ({ project_id, branch, ref }) => api.request("POST", projectPath(project_id, "/repository/branches"), { branch, ref }).then((r) => r.data), false);

  const commitAction = z.object({
    action: z.enum(["create", "delete", "move", "update", "chmod"]),
    file_path: z.string().min(1),
    previous_path: z.string().optional(),
    content: z.string().optional(),
    encoding: z.enum(["text", "base64"]).optional(),
    execute_filemode: z.boolean().optional(),
  }).strict();
  register(server, "create_commit", "Create a commit on a branch using GitLab repository file actions.",
    z.object({
      ...projectArgs,
      branch: z.string().min(1),
      commit_message: z.string().min(1),
      actions: z.array(commitAction).min(1).max(100)
        .refine((actions) => actions.every((action) => ["delete", "chmod", "move"].includes(action.action) || action.content !== undefined), "Create and update actions require content.")
        .refine((actions) => actions.every((action) => action.action !== "move" || action.previous_path !== undefined), "Move actions require previous_path.")
        .refine((actions) => actions.every((action) => action.action !== "chmod" || action.execute_filemode !== undefined), "Chmod actions require execute_filemode."),
    }).strict(),
    ({ project_id, ...body }) => api.request("POST", projectPath(project_id, "/repository/commits"), {}, body).then((r) => r.data), false);

  register(server, "list_merge_requests", "List merge requests in a project with optional state, branch, label, and search filters.",
    z.object({ ...projectArgs, state: z.enum(["opened", "closed", "locked", "merged", "all"]).optional(), source_branch: z.string().optional(), target_branch: z.string().optional(), labels: z.string().optional(), search: z.string().optional(), ...pagination }).strict(),
    (a) => listPage(api, projectPath(a.project_id, "/merge_requests"), a, { state: a.state, source_branch: a.source_branch, target_branch: a.target_branch, labels: a.labels, search: a.search }));

  register(server, "get_merge_request", "Get a merge request by its project-level IID.",
    z.object({ ...projectArgs, merge_request_iid: z.number().int().positive() }).strict(),
    ({ project_id, merge_request_iid }) => api.request("GET", projectPath(project_id, `/merge_requests/${merge_request_iid}`)).then((r) => r.data));

  register(server, "create_merge_request", "Create a merge request between two branches.",
    z.object({
      ...projectArgs,
      source_branch: z.string().min(1), target_branch: z.string().min(1), title: z.string().min(1),
      description: z.string().optional(), labels: z.string().optional(), assignee_id: z.number().int().positive().optional(),
      remove_source_branch: z.boolean().optional(), draft: z.boolean().optional(), squash: z.boolean().optional(),
    }).strict(),
    ({ project_id, ...body }) => api.request("POST", projectPath(project_id, "/merge_requests"), {}, body).then((r) => r.data), false);

  register(server, "update_merge_request", "Update selected merge request fields by project-level IID.",
    z.object({
      ...projectArgs, merge_request_iid: z.number().int().positive(), title: z.string().min(1).optional(),
      description: z.string().optional(), state_event: z.enum(["close", "reopen"]).optional(), target_branch: z.string().optional(),
      labels: z.string().optional(), assignee_id: z.number().int().positive().nullable().optional(),
      reviewer_ids: z.array(z.number().int().positive()).optional(), milestone_id: z.number().int().positive().nullable().optional(),
      remove_source_branch: z.boolean().optional(), squash: z.boolean().optional(),
    }).strict().refine((a) => Object.keys(a).some((key) => !["project_id", "merge_request_iid"].includes(key)), "Provide at least one field to update."),
    ({ project_id, merge_request_iid, ...body }) => api.request("PUT", projectPath(project_id, `/merge_requests/${merge_request_iid}`), {}, body).then((r) => r.data), false);

  register(server, "get_merge_request_diff", "List the changed files and diffs for a merge request.",
    z.object({ ...projectArgs, merge_request_iid: z.number().int().positive(), ...pagination }).strict(),
    (a) => listPage(api, projectPath(a.project_id, `/merge_requests/${a.merge_request_iid}/diffs`), a));

  register(server, "list_merge_request_discussions", "List discussion threads and notes on a merge request.",
    z.object({ ...projectArgs, merge_request_iid: z.number().int().positive(), ...pagination }).strict(),
    (a) => listPage(api, projectPath(a.project_id, `/merge_requests/${a.merge_request_iid}/discussions`), a));

  const mrPosition = z.object({
    position_type: z.literal("text").default("text"),
    base_sha: z.string().min(1),
    start_sha: z.string().min(1),
    head_sha: z.string().min(1),
    old_path: z.string().min(1),
    new_path: z.string().min(1),
    old_line: z.number().int().positive().optional(),
    new_line: z.number().int().positive().optional(),
  }).strict().refine((position) => position.old_line !== undefined || position.new_line !== undefined, "A text diff comment needs old_line or new_line.");
  register(server, "create_merge_request_comment", "Add a general discussion note or a line comment to a merge request.",
    z.object({ ...projectArgs, merge_request_iid: z.number().int().positive(), body: z.string().min(1), position: mrPosition.optional() }).strict(),
    ({ project_id, merge_request_iid, ...body }) => api.request("POST", projectPath(project_id, `/merge_requests/${merge_request_iid}/discussions`), {}, body).then((r) => r.data), false);

  register(server, "list_issues", "List project issues with optional state, label, assignee, and search filters.",
    z.object({ ...projectArgs, state: z.enum(["opened", "closed", "all"]).optional(), labels: z.string().optional(), assignee_username: z.string().optional(), search: z.string().optional(), ...pagination }).strict(),
    (a) => listPage(api, projectPath(a.project_id, "/issues"), a, { state: a.state, labels: a.labels, assignee_username: a.assignee_username, search: a.search }));

  register(server, "get_issue", "Get an issue by its project-level IID.",
    z.object({ ...projectArgs, issue_iid: z.number().int().positive() }).strict(),
    ({ project_id, issue_iid }) => api.request("GET", projectPath(project_id, `/issues/${issue_iid}`)).then((r) => r.data));

  register(server, "create_issue", "Create an issue in a project.",
    z.object({
      ...projectArgs, title: z.string().min(1), description: z.string().optional(), labels: z.string().optional(),
      assignee_ids: z.array(z.number().int().positive()).optional(), milestone_id: z.number().int().positive().optional(),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), confidential: z.boolean().optional(),
    }).strict(),
    ({ project_id, ...body }) => api.request("POST", projectPath(project_id, "/issues"), {}, body).then((r) => r.data), false);

  register(server, "update_issue", "Update selected issue fields by project-level IID.",
    z.object({
      ...projectArgs, issue_iid: z.number().int().positive(), title: z.string().min(1).optional(), description: z.string().optional(),
      state_event: z.enum(["close", "reopen"]).optional(), labels: z.string().optional(),
      assignee_ids: z.array(z.number().int().positive()).optional(), milestone_id: z.number().int().positive().nullable().optional(),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), confidential: z.boolean().optional(),
    }).strict().refine((a) => Object.keys(a).some((key) => !["project_id", "issue_iid"].includes(key)), "Provide at least one field to update."),
    ({ project_id, issue_iid, ...body }) => api.request("PUT", projectPath(project_id, `/issues/${issue_iid}`), {}, body).then((r) => r.data), false);

  register(server, "create_issue_comment", "Add a comment/note to an issue.",
    z.object({ ...projectArgs, issue_iid: z.number().int().positive(), body: z.string().min(1) }).strict(),
    ({ project_id, issue_iid, body }) => api.request("POST", projectPath(project_id, `/issues/${issue_iid}/notes`), {}, { body }).then((r) => r.data), false);

  register(server, "list_pipelines", "List project pipelines with optional ref, status, SHA, or username filters.",
    z.object({ ...projectArgs, ref: z.string().optional(), status: z.enum(["created", "waiting_for_resource", "preparing", "pending", "running", "success", "failed", "canceled", "skipped", "manual", "scheduled"]).optional(), sha: z.string().optional(), username: z.string().optional(), ...pagination }).strict(),
    (a) => listPage(api, projectPath(a.project_id, "/pipelines"), a, { ref: a.ref, status: a.status, sha: a.sha, username: a.username }));

  register(server, "get_pipeline", "Get pipeline details by project ID/path and pipeline ID.",
    z.object({ ...projectArgs, pipeline_id: z.number().int().positive() }).strict(),
    ({ project_id, pipeline_id }) => api.request("GET", projectPath(project_id, `/pipelines/${pipeline_id}`)).then((r) => r.data));

  register(server, "run_pipeline", "Create a pipeline for a branch, tag, or commit ref. This starts CI jobs.",
    z.object({
      ...projectArgs, ref: z.string().min(1),
      variables: z.array(z.object({ key: z.string().min(1), value: z.string(), variable_type: z.enum(["env_var", "file"]).optional() }).strict()).max(100).optional(),
    }).strict(),
    ({ project_id, ref, ...body }) => api.request("POST", projectPath(project_id, "/pipeline"), { ref }, body).then((r) => r.data), false);

  register(server, "list_pipeline_jobs", "List jobs for a pipeline, optionally filtered by job status.",
    z.object({
      ...projectArgs, pipeline_id: z.number().int().positive(),
      scope: z.array(z.enum(["created", "waiting_for_resource", "preparing", "pending", "running", "failed", "success", "canceled", "skipped", "manual", "scheduled"])).optional(),
      include_retried: z.boolean().default(false), ...pagination,
    }).strict(),
    (a) => listPage(api, projectPath(a.project_id, `/pipelines/${a.pipeline_id}/jobs`), a, { scope: a.scope, include_retried: a.include_retried }));

  register(server, "get_job_log", "Get the trace/log output for a CI job. Output is limited to 100,000 characters.",
    z.object({ ...projectArgs, job_id: z.number().int().positive() }).strict(),
    async ({ project_id, job_id }) => {
      const response = await api.request<string>("GET", projectPath(project_id, `/jobs/${job_id}/trace`));
      const text = response.data;
      return { job_id, log: text.slice(0, MAX_FILE_CHARS), truncated: text.length > MAX_FILE_CHARS };
    });

  register(server, "list_branches", "List repository branches, optionally matching a name search.",
    z.object({ ...projectArgs, search: z.string().optional(), ...pagination }).strict(),
    (a) => listPage(api, projectPath(a.project_id, "/repository/branches"), a, { search: a.search }));

  register(server, "list_tags", "List repository tags, optionally matching a name search.",
    z.object({ ...projectArgs, search: z.string().optional(), ...pagination }).strict(),
    (a) => listPage(api, projectPath(a.project_id, "/repository/tags"), a, { search: a.search }));

  register(server, "list_releases", "List project releases.",
    z.object({ ...projectArgs, ...pagination }).strict(),
    (a) => listPage(api, projectPath(a.project_id, "/releases"), a));
}

serveStdio(createServer, {
  onerror: (error) => {
    console.error(`GitLab Data Center MCP server error: ${error.message}`);
  },
});
