import { z } from "zod";
import { defineEndpoint, UsageModelKind } from "@shared/core";
import { zSandboxId, zWorkspacePath } from "../../schema/common.ts";

/**
 * /list-files — one page of a directory in an owned VM (upstream:
 * `GET /api/v2/sandboxes/{id}/files/list`). `nextCursor` is BoxCompute's
 * opaque page token, not a URL: it goes back in as `cursor` on this same
 * endpoint with the same path.
 */
export const zListFilesBody = z.object({
    sandboxId: zSandboxId.describe(
        "The id of a VM YOU OWN (from /create-sandbox or /list-sandboxes).",
    ),
    path: zWorkspacePath.describe(
        "The directory to list, an absolute path inside /workspace, e.g. " +
            "/workspace or /workspace/src.",
    ),
    pageSize: z.number().int().min(1).max(1000).describe(
        "Entries per page. Default 1000.",
    ).optional(),
    cursor: z.string().min(1).max(4096).describe(
        "The nextCursor of the previous page, unchanged, to read the next " +
            "one.",
    ).optional(),
}).strict();

export default defineEndpoint({
    meta: {
        displayName: "List Files",
        summary:
            "List a directory in your VM: name, path, kind, size, modified time.",
        description:
            "List one page of a directory under /workspace in a VM you " +
            "own. Each entry has name, path, kind (file, dir, symlink, " +
            "other), size in bytes and mtimeMs. Pass nextCursor back as " +
            "cursor for the next page; null means it was the last.",
        docsUrl: "https://boxcompute.ai/docs/",
        categories: ["code-execution"],
        notes: [
            "404 FILE_NOT_FOUND means the directory does not exist.",
            "Changing the directory between pages invalidates the cursor " +
            "(409 CURSOR_STALE); list again from the first page.",
            "To read a file's contents, use /run-command, e.g. " +
            '["cat", "/workspace/notes.txt"].',
        ],
    },
    endpoint: "/list-files",
    request: { method: "GET", path: "/api/v2/sandboxes/{id}/files/list" },
    input: {
        schema: { body: zListFilesBody },
        toRequest: ({ data }) => {
            const body = data.input.body as Record<string, unknown>;
            return {
                pathParams: { id: String(body.sandboxId) },
                queryParams: {
                    path: String(body.path),
                    ...(body.pageSize !== undefined
                        ? { pageSize: String(body.pageSize) }
                        : {}),
                    ...(body.cursor !== undefined
                        ? { cursor: String(body.cursor) }
                        : {}),
                },
            };
        },
    },
    resources: {
        uses: [{ id: "boxcompute/vm", key: "$.body.sandboxId" }],
    },
    usage: { model: { kind: UsageModelKind.FREE } },
});
