import { z } from "zod";
import { defineEndpoint, type Json, UsageModelKind } from "@shared/core";
import { zSandboxId, zWorkspacePath } from "../../schema/common.ts";

/**
 * /run-command — run one program in an owned VM and wait for it (upstream:
 * `POST /api/v2/sandboxes/{id}/execute`). A DECLARATIVE relay: the USES
 * binding pre-gates the VM, toRequest moves the id into the path.
 *
 * A non-zero exit is still 200 with `exitCode`: the command ran, and its
 * output is the answer. The API allows 900 s; this binding caps
 * `timeoutSeconds` at 240 so one call stays inside the request timeout,
 * which also covers waking a stopped VM (about 30 s).
 */
export const zRunCommandBody = z.object({
    sandboxId: zSandboxId.describe(
        "The id of a VM YOU OWN (from /create-sandbox or /list-sandboxes).",
    ),
    argv: z.array(z.string().min(1).max(8192)).min(1).max(64).describe(
        "The program and its arguments, run directly WITHOUT a shell, e.g. " +
            '["python3", "main.py"]. For pipes, redirects, globs or several ' +
            'commands, use ["sh", "-c", "<script>"].',
    ),
    cwd: zWorkspacePath.describe(
        "Working directory, an absolute path inside /workspace. Default " +
            "/workspace.",
    ).optional(),
    env: z.record(z.string(), z.string()).describe(
        "Extra environment variables for this command only (at most 64).",
    ).optional(),
    timeoutSeconds: z.number().int().min(1).max(240).describe(
        "Seconds before the command is killed (timedOut: true). Default " +
            "120, at most 240.",
    ).optional(),
    maxOutputBytes: z.number().int().min(1).max(1_048_576).describe(
        "Cap on each of stdout and stderr; longer output is cut " +
            "(stdoutTruncated / stderrTruncated). Default 262144.",
    ).optional(),
}).strict();

export default defineEndpoint({
    meta: {
        displayName: "Run Command",
        summary:
            "Run a command in your VM and get stdout, stderr and the exit code.",
        description:
            "Run one program in a VM you own and wait for it to finish, up " +
            "to 240 s. Returns stdout, stderr, exitCode, and whether it " +
            "timed out or its output was cut. The VM is a normal Linux " +
            "machine with outbound internet unless created without it: " +
            "install packages, write files, run scripts, build and test " +
            "code. Files under /workspace persist across calls and stops.",
        docsUrl: "https://boxcompute.ai/docs/",
        categories: ["code-execution"],
        notes: [
            "A non-zero exit is not an error: the call answers 200 with " +
            "exitCode set.",
            "Each call is a fresh process: environment variables and the " +
            "working directory do not carry over. Chain steps in one " +
            '["sh", "-c", ...] call, or write state to files.',
            'Write a file with a shell, e.g. ["sh", "-c", "cat > ' +
            "/workspace/app.py <<'EOF'\\n...\\nEOF\"].",
            "To keep a server running after the call returns, start it in " +
            "the background (nohup ... &) and open it with /open-preview.",
        ],
    },
    endpoint: "/run-command",
    request: { method: "POST", path: "/api/v2/sandboxes/{id}/execute" },
    input: {
        schema: { body: zRunCommandBody },
        toRequest: ({ data }) => {
            const { sandboxId, ...command } = data.input.body as Record<
                string,
                Json
            >;
            return {
                pathParams: { id: String(sandboxId) },
                body: command,
            };
        },
    },
    timeouts: { requestMs: 300_000, runMs: 310_000 },
    resources: {
        uses: [{ id: "boxcompute/vm", key: "$.body.sandboxId" }],
    },
    usage: { model: { kind: UsageModelKind.FREE } },
});
