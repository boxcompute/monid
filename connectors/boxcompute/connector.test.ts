import { assert, assertEquals, assertRejects } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { type Json, type OwnedResource } from "@shared/core";
import { EngineError, EngineErrorCode } from "@monid/connector-engine";
import { loadFixture, runEndpoint, testSealedUnit } from "@shared/testing";

/**
 * THE boxcompute suite. Chains are real 2026-10-26 recordings against
 * app.boxcompute.ai unless named `synthetic-` (each fixture says what it
 * holds). Ownership is the FIXTURE's story: `resources` seeds the reader,
 * and a foreign id proves the uniform 404.
 */

const HERE = fromFileUrl(new URL("./", import.meta.url));
const fixture = (name: string) => loadFixture(`${HERE}fixtures/${name}.json`);

const NEW = "sbx_ed730f785e584b43982a8ada3722af1b";
const VM = "sbx_224ff457bf3f4724841f4ccf343f1fcd";
const FOREIGN = "sbx_ffffffffffffffffffffffffffffffff";

const OWNED: OwnedResource[] = [
    {
        resource: "boxcompute/vm",
        externalId: VM,
        data: { size: "small", name: "new-vm", blockNetwork: false },
        syncedAt: "2026-10-26T08:00:00.000Z",
    },
    {
        resource: "boxcompute/vm",
        externalId: NEW,
        data: { size: "small", name: "monid-fixture" },
    },
];

const CREATE_INPUT = { body: { name: "monid-fixture" } };

/** 204 replays fail in the fixture helpers until monid-ai/monid#199
 *  (`new Response` refuses a body on a null-body status). */
const NO_CONTENT_REPLAY_BROKEN = true;

// ---------------------------------------------------------------------------
// create-sandbox — create, then wait for the boot
// ---------------------------------------------------------------------------

Deno.test("boxcompute create-sandbox: pending, then running — 201, seed, pool internals stripped", async () => {
    const result = await runEndpoint({
        unit: await testSealedUnit("boxcompute#create-sandbox"),
        input: CREATE_INPUT,
        mode: "replay",
        fixture: await fixture("synthetic-create-running"),
    });
    assertEquals(result.httpStatus, 201);
    assertEquals(result.isProviderError, false);
    // the call is free: the VM's time is the resource's compute line
    assertEquals(result.usage.credits, {});
    const seed = result.resources?.provisions?.[0];
    assert(seed !== undefined, "expected a provision seed");
    assertEquals(seed.resource, "boxcompute/vm");
    assertEquals(seed.externalId, NEW);
    assertEquals(seed.identifier, "monid-fixture");
    assertEquals(seed.data, {
        size: "small",
        name: "monid-fixture",
        blockNetwork: false,
    });
    const sandbox = (result.output as Record<string, Json>).sandbox as Record<
        string,
        Json
    >;
    assertEquals(sandbox.id, NEW);
    assertEquals(sandbox.state, "running");
    assertEquals(sandbox.workspaceId, undefined);
    assertEquals(sandbox.metadata, undefined);
});

Deno.test("boxcompute create-sandbox: still booting after 100 s — 202, and the VM is owned all the same", async () => {
    const result = await runEndpoint({
        unit: await testSealedUnit("boxcompute#create-sandbox"),
        input: CREATE_INPUT,
        mode: "replay",
        // 20 pending reads: the chain fails if start reads more or fewer
        fixture: await fixture("synthetic-create-slow"),
    });
    assertEquals(result.httpStatus, 202);
    assertEquals(result.isProviderError, false);
    assertEquals(result.resources?.provisions?.[0].externalId, NEW);
    const sandbox = (result.output as Record<string, Json>).sandbox as Record<
        string,
        Json
    >;
    assertEquals(sandbox.state, "pending");
});

Deno.test("boxcompute create-sandbox: a VM refused at the account limit — 429, nothing provisioned", async () => {
    const result = await runEndpoint({
        unit: await testSealedUnit("boxcompute#create-sandbox"),
        input: CREATE_INPUT,
        mode: "replay",
        // its last call, the best-effort DELETE (204), is the replay that
        // monid-ai/monid#199 fixes; create-sandbox carries on either way
        fixture: await fixture("create-refused"),
    });
    assertEquals(result.httpStatus, 429);
    assertEquals(result.isProviderError, true);
    assertEquals(result.usage, { credits: {}, evidence: {} });
    assertEquals(result.resources?.provisions, undefined);
    assertEquals(
        (result.output as Record<string, Json>).code,
        "SANDBOX_REFUSED",
    );
});

Deno.test("boxcompute create-sandbox: an invalid key is relayed as data", async () => {
    const result = await runEndpoint({
        unit: await testSealedUnit("boxcompute#create-sandbox"),
        input: CREATE_INPUT,
        mode: "replay",
        fixture: await fixture("unauthorized"),
    });
    assertEquals(result.httpStatus, 401);
    assertEquals(result.isProviderError, true);
    assertEquals(result.resources?.provisions, undefined);
    assertEquals(
        (result.output as Record<string, Json>).code,
        "INVALID_API_KEY",
    );
});

Deno.test("boxcompute create-sandbox: only small and large, strict body", async () => {
    const unit = await testSealedUnit("boxcompute#create-sandbox");
    for (
        const body of [
            { size: "xl" },
            { size: "small", diskGiB: 10 },
        ] as Json[]
    ) {
        const error = await assertRejects(
            () => runEndpoint({ unit, input: { body }, mode: "replay" }),
            EngineError,
        );
        assertEquals(
            (error as EngineError).code,
            EngineErrorCode.INVALID_INPUT,
        );
    }
});

// ---------------------------------------------------------------------------
// get-sandbox / list-sandboxes — reads, never the pooled list
// ---------------------------------------------------------------------------

Deno.test("boxcompute get-sandbox: the live record, pool internals stripped", async () => {
    const result = await runEndpoint({
        unit: await testSealedUnit("boxcompute#get-sandbox"),
        input: { body: { sandboxId: VM } },
        mode: "replay",
        fixture: await fixture("get-cold"),
        resources: OWNED,
    });
    assertEquals(result.httpStatus, 200);
    const sandbox = (result.output as Record<string, Json>).sandbox as Record<
        string,
        Json
    >;
    assertEquals(sandbox.state, "cold");
    assertEquals(sandbox.size, "small");
    assertEquals(sandbox.workspaceId, undefined);
    assertEquals(sandbox.metadata, undefined);
});

Deno.test("boxcompute get-sandbox: a foreign id is the uniform 404 from the pre-gate", async () => {
    const result = await runEndpoint({
        unit: await testSealedUnit("boxcompute#get-sandbox"),
        input: { body: { sandboxId: FOREIGN } },
        mode: "replay",
        // no fixture: the pre-gate answers before any upstream call
        resources: OWNED,
    });
    assertEquals(result.httpStatus, 404);
    assertEquals(result.usage.credits, {});
});

Deno.test("boxcompute list-sandboxes: served from the ownership window only", async () => {
    const unit = await testSealedUnit("boxcompute#list-sandboxes");
    const result = await runEndpoint({
        unit,
        input: {},
        mode: "replay",
        // no fixture: an upstream call would fail the replay
        resources: OWNED,
    });
    assertEquals(result.httpStatus, 200);
    assertEquals(result.output, [
        {
            sandboxId: VM,
            size: "small",
            name: "new-vm",
            blockNetwork: false,
            syncedAt: "2026-10-26T08:00:00.000Z",
        },
        {
            sandboxId: NEW,
            size: "small",
            name: "monid-fixture",
            blockNetwork: false,
        },
    ]);
    const empty = await runEndpoint({
        unit,
        input: {},
        mode: "replay",
        resources: [],
    });
    assertEquals(empty.output, []);
});

// ---------------------------------------------------------------------------
// run-command / list-files / open-preview — uses of an owned VM
// ---------------------------------------------------------------------------

Deno.test("boxcompute run-command: stdout, stderr and the exit code", async () => {
    const result = await runEndpoint({
        unit: await testSealedUnit("boxcompute#run-command"),
        input: {
            body: {
                sandboxId: VM,
                argv: ["sh", "-c", "echo hello from boxcompute && uname -s"],
                timeoutSeconds: 60,
            },
        },
        mode: "replay",
        fixture: await fixture("execute-ok"),
        resources: OWNED,
    });
    assertEquals(result.httpStatus, 200);
    assertEquals(result.usage.credits, {});
    const out = (result.output as Record<string, Json>).result as Record<
        string,
        Json
    >;
    assertEquals(out.stdout, "hello from boxcompute\nLinux\n");
    assertEquals(out.exitCode, 0);
    assertEquals(out.timedOut, false);
});

Deno.test("boxcompute run-command: a non-zero exit is still a 200 answer", async () => {
    const result = await runEndpoint({
        unit: await testSealedUnit("boxcompute#run-command"),
        input: { body: { sandboxId: VM, argv: ["sh", "-c", "exit 3"] } },
        mode: "replay",
        fixture: await fixture("execute-exit-code"),
        resources: OWNED,
    });
    assertEquals(result.httpStatus, 200);
    assertEquals(result.isProviderError, false);
    const out = (result.output as Record<string, Json>).result as Record<
        string,
        Json
    >;
    assertEquals(out.exitCode, 3);
    assertEquals(out.stderr, "failing\n");
});

Deno.test("boxcompute run-command: foreign VMs, long timeouts and paths outside /workspace are refused", async () => {
    const unit = await testSealedUnit("boxcompute#run-command");
    const foreign = await runEndpoint({
        unit,
        input: { body: { sandboxId: FOREIGN, argv: ["true"] } },
        mode: "replay",
        resources: OWNED,
    });
    assertEquals(foreign.httpStatus, 404);
    for (
        const body of [
            { sandboxId: VM, argv: ["true"], timeoutSeconds: 900 },
            { sandboxId: VM, argv: ["true"], cwd: "/etc" },
            { sandboxId: VM, argv: ["true"], cwd: "/workspace/../etc" },
            { sandboxId: VM, argv: [] },
        ] as Json[]
    ) {
        const error = await assertRejects(
            () =>
                runEndpoint({
                    unit,
                    input: { body },
                    mode: "replay",
                    resources: OWNED,
                }),
            EngineError,
        );
        assertEquals(
            (error as EngineError).code,
            EngineErrorCode.INVALID_INPUT,
        );
    }
});

Deno.test("boxcompute list-files: one page, the path sent as a query parameter", async () => {
    const result = await runEndpoint({
        unit: await testSealedUnit("boxcompute#list-files"),
        input: { body: { sandboxId: VM, path: "/workspace/.monid-fixture" } },
        mode: "replay",
        fixture: await fixture("list-files-ok"),
        resources: OWNED,
    });
    assertEquals(result.httpStatus, 200);
    assertEquals(result.output, {
        entries: [{
            name: "hello.txt",
            path: "/workspace/.monid-fixture/hello.txt",
            kind: "file",
            size: 5,
            mtimeMs: 0,
        }],
        nextCursor: null,
    });
});

Deno.test("boxcompute list-files: a missing directory is a 404 answer", async () => {
    const result = await runEndpoint({
        unit: await testSealedUnit("boxcompute#list-files"),
        input: {
            body: { sandboxId: VM, path: "/workspace/.monid-fixture-missing" },
        },
        mode: "replay",
        fixture: await fixture("list-files-missing"),
        resources: OWNED,
    });
    assertEquals(result.httpStatus, 404);
    assertEquals(result.isProviderError, true);
    assertEquals(
        (result.output as Record<string, Json>).code,
        "FILE_NOT_FOUND",
    );
});

Deno.test("boxcompute open-preview: a one-hour URL for one port", async () => {
    const result = await runEndpoint({
        unit: await testSealedUnit("boxcompute#open-preview"),
        input: { body: { sandboxId: VM, port: 8080 } },
        mode: "replay",
        fixture: await fixture("preview-ok"),
        resources: OWNED,
    });
    assertEquals(result.httpStatus, 201);
    const preview = (result.output as Record<string, Json>).preview as Record<
        string,
        Json
    >;
    assertEquals(preview.port, 8080);
    assertEquals(
        preview.url,
        "https://0123456789abcdef0123456789abcdef.bxcpreview.site",
    );
});

// ---------------------------------------------------------------------------
// start / stop / delete
// ---------------------------------------------------------------------------

Deno.test("boxcompute start-sandbox: answers once the VM runs", async () => {
    const result = await runEndpoint({
        unit: await testSealedUnit("boxcompute#start-sandbox"),
        input: { body: { sandboxId: VM } },
        mode: "replay",
        fixture: await fixture("start-ok"),
        resources: OWNED,
    });
    assertEquals(result.httpStatus, 201);
    const sandbox = (result.output as Record<string, Json>).sandbox as Record<
        string,
        Json
    >;
    assertEquals(sandbox.state, "running");
});

Deno.test("boxcompute stop-sandbox: stopped, files kept; a busy VM is a 409 answer", async () => {
    const unit = await testSealedUnit("boxcompute#stop-sandbox");
    const stopped = await runEndpoint({
        unit,
        input: { body: { sandboxId: VM } },
        mode: "replay",
        fixture: await fixture("stop-ok"),
        resources: OWNED,
    });
    assertEquals(stopped.httpStatus, 200);
    const out = stopped.output as Record<string, Json>;
    assertEquals(out.stopped, true);
    assertEquals((out.sandbox as Record<string, Json>).state, "cold");
    const busy = await runEndpoint({
        unit,
        input: { body: { sandboxId: VM } },
        mode: "replay",
        fixture: await fixture("stop-busy"),
        resources: OWNED,
    });
    assertEquals(busy.httpStatus, 409);
    assertEquals(
        (busy.output as Record<string, Json>).code,
        "SANDBOX_UNAVAILABLE",
    );
});

Deno.test({
    name: "boxcompute delete-sandbox: deleted at once, and the release mark",
    ignore: NO_CONTENT_REPLAY_BROKEN,
    fn: async () => {
        const result = await runEndpoint({
            unit: await testSealedUnit("boxcompute#delete-sandbox"),
            input: { body: { sandboxId: NEW } },
            mode: "replay",
            fixture: await fixture("delete-ok"),
            resources: OWNED,
        });
        assertEquals(result.httpStatus, 200);
        assertEquals(result.output, { sandboxId: NEW, status: "deleted" });
        assertEquals(result.resources?.releases, [{
            resource: "boxcompute/vm",
            externalId: NEW,
        }]);
    },
});

Deno.test("boxcompute delete-sandbox: already gone counts as deleted, and still marks the release", async () => {
    const result = await runEndpoint({
        unit: await testSealedUnit("boxcompute#delete-sandbox"),
        input: { body: { sandboxId: NEW } },
        mode: "replay",
        fixture: await fixture("delete-gone"),
        resources: OWNED,
    });
    assertEquals(result.httpStatus, 200);
    assertEquals(result.output, { sandboxId: NEW, status: "deleted" });
    assertEquals(result.resources?.releases, [{
        resource: "boxcompute/vm",
        externalId: NEW,
    }]);
});

Deno.test("boxcompute delete-sandbox: a busy VM is relayed, not released; foreign ids never reach upstream", async () => {
    const unit = await testSealedUnit("boxcompute#delete-sandbox");
    const busy = await runEndpoint({
        unit,
        input: { body: { sandboxId: NEW } },
        mode: "replay",
        fixture: await fixture("synthetic-delete-busy"),
        resources: OWNED,
    });
    assertEquals(busy.httpStatus, 409);
    assertEquals(busy.resources?.releases, undefined);
    const foreign = await runEndpoint({
        unit,
        input: { body: { sandboxId: FOREIGN } },
        mode: "replay",
        resources: OWNED,
    });
    assertEquals(foreign.httpStatus, 404);
    assertEquals(foreign.resources?.releases, undefined);
});
