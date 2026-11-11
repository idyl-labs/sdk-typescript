// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { ApiError, Idyl, TransportError } from "../src/index.js";
import { errorResponse, json } from "./fakes/control-plane.js";
import { accountId, subnetSlug } from "./fakes/fetch-queue.js";
import { testCredential } from "./fakes/keys.js";
import {
  FakeNetwork,
  computerHost,
  computerRecord,
  computersPath,
  endpoints,
} from "./fakes/network.js";

const SECRET_ID = "01954e20-7540-7ec4-93ec-14f783e6ab1a";
const secretsPath = `/v1/accounts/${accountId}/namespaces/default/vault/secrets`;

/** The metadata of the served Secret: the client's Namespace and Subnet. */
const servedMetadata = {
  id: SECRET_ID,
  name: "git",
  namespace: "default",
  subnet: subnetSlug,
  createdAt: "2026-01-02T03:04:05Z",
  updatedAt: "2026-01-02T03:04:05Z",
};

/** A redacted Secret as the platform serves it, with `fields` over the defaults. */
function servedSecret(
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: "Secret",
    metadata: servedMetadata,
    spec: {
      source: { value: { sizeBytes: 13, expiresAt: "2026-12-01T00:00:00Z" } },
      egress: {
        origins: ["https://git.example.com"],
        credential: { type: "basic-password" },
      },
      currentVersion: 1,
      versionCount: 1,
    },
    status: { state: "active", health: "healthy", resourceVersion: 1 },
    ...fields,
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (error: unknown) => error,
  );
}

describe("idyl.secrets", () => {
  // Contract: a create writes the Secret under its name in the client's
  // Namespace, on the API that serves its Computers, stamped with the
  // Namespace and the Subnet placement resolves, and returns the redacted
  // read with no value in it.
  it("creates a Secret with a stored value and an egress", async () => {
    let sent: unknown;
    const network = new FakeNetwork((request, body) => {
      if (
        request.method === "PUT" &&
        request.url.pathname === `${secretsPath}/git`
      ) {
        sent = body;
        return json(servedSecret(), 201);
      }
      return undefined;
    });
    const secret = await network.client().secrets.create({
      name: "git",
      value: "example-token",
      expiresAt: "2026-12-01T00:00:00Z",
      origins: ["https://git.example.com"],
      credential: { type: "basic-password" },
    });
    expect(sent).toEqual({
      kind: "Secret",
      metadata: { name: "git", namespace: "default", subnet: subnetSlug },
      spec: {
        source: { value: "example-token", expiresAt: "2026-12-01T00:00:00Z" },
        egress: {
          origins: ["https://git.example.com"],
          credential: { type: "basic-password" },
        },
      },
    });
    expect(secret).toEqual({
      id: SECRET_ID,
      name: "git",
      namespace: "default",
      origins: ["https://git.example.com"],
      credential: { type: "basic-password" },
      source: {
        type: "value",
        sizeBytes: 13,
        expiresAt: "2026-12-01T00:00:00Z",
      },
      version: 1,
      resourceVersion: 1,
      state: "active",
      health: "healthy",
      createdAt: "2026-01-02T03:04:05Z",
      updatedAt: "2026-01-02T03:04:05Z",
    });
    expect(JSON.stringify(secret)).not.toContain("example-token");
  });

  // Contract: a GitHub App source is sent with its IDs and key, and the read
  // reports the App without the key; a header credential names its header.
  it("creates a Secret with a GitHub App source and a header credential", async () => {
    let sent: unknown;
    const network = new FakeNetwork((request, body) => {
      if (request.method === "PUT") {
        sent = body;
        return json(
          servedSecret({
            spec: {
              source: { githubApp: { appId: 123456, installationId: 654321 } },
              egress: {
                origins: ["https://api.example.com"],
                credential: { type: "header", header: "PRIVATE-TOKEN" },
              },
              currentVersion: 1,
              versionCount: 1,
            },
          }),
        );
      }
      return undefined;
    });
    const key =
      "-----BEGIN RSA PRIVATE KEY-----\nEXAMPLE\n-----END RSA PRIVATE KEY-----\n";
    const secret = await network.client().secrets.create({
      name: "git",
      githubApp: { appId: 123456, installationId: 654321, privateKey: key },
      origins: ["https://api.example.com"],
      credential: { type: "header", header: "PRIVATE-TOKEN" },
    });
    expect((sent as { spec: unknown }).spec).toEqual({
      source: {
        githubApp: { appId: 123456, installationId: 654321, privateKey: key },
      },
      egress: {
        origins: ["https://api.example.com"],
        credential: { type: "header", header: "PRIVATE-TOKEN" },
      },
    });
    expect(secret.source).toEqual({
      type: "github-app",
      appId: 123456,
      installationId: 654321,
    });
    expect(secret.credential).toEqual({
      type: "header",
      header: "PRIVATE-TOKEN",
    });
  });

  // Contract: an invalid Secret is refused with a TypeError naming the field
  // before anything is read or sent, and the refusal never contains the
  // value.
  it("refuses an invalid Secret before any request", async () => {
    const network = new FakeNetwork(() => json(servedSecret()));
    const { secrets } = network.client();
    const base = {
      name: "git",
      origins: ["https://git.example.com"],
      credential: { type: "basic-password" },
    } as const;
    await expect(
      secrets.create({ ...base, value: "example\ntoken" }),
    ).rejects.toThrow("spec.source: value byte 7 is not printable ASCII");
    await expect(
      secrets.create({
        ...base,
        value: "example-token",
        origins: ["http://git.example.com"],
      }),
    ).rejects.toThrow(
      "spec.egress.origins[0]: origin must begin with https://",
    );
    await expect(
      secrets.create({
        ...base,
        value: "example-token",
        credential: { type: "header", header: "Host" },
      }),
    ).rejects.toThrow(
      "spec.egress.credential: header Host frames the request or controls the connection",
    );
    await expect(secrets.create({ ...base })).rejects.toThrow(
      "state exactly one of value and githubApp",
    );
    await expect(
      secrets.create({
        ...base,
        value: "example-token",
        expiresAt: "tomorrow",
      }),
    ).rejects.toThrow(/^expiresAt: invalid timestamp/u);
    await expect(
      secrets.create({ ...base, name: "Git", value: "example-token" }),
    ).rejects.toThrow('metadata.name "Git" is invalid');
    const refusal = await rejection(
      secrets.create({ ...base, value: `${"a".repeat(8192)}\n` }),
    );
    expect(refusal).toBeInstanceOf(TypeError);
    expect((refusal as Error).message).not.toContain("aaaa");
    expect(network.plane.requests).toHaveLength(0);
  });

  // Contract: a Vault refusal relays its status, code and the platform's
  // reading as `detail`; a refusal under any other code keeps its status and
  // code and replaces the reading, so no server text reaches a caller from a
  // route that carries a value.
  it("relays a Vault refusal and withholds any other message", async () => {
    let answer = errorResponse(
      409,
      "VAULT_RESOURCE_VERSION_CONFLICT",
      "Vault resource content conflicts with the existing resource",
    );
    const network = new FakeNetwork((request) =>
      request.method === "PUT" ? answer : undefined,
    );
    const { secrets } = network.client();
    const options = {
      name: "git",
      value: "example-token",
      origins: ["https://git.example.com"],
      credential: { type: "basic-password" },
    } as const;
    const conflict = await rejection(secrets.create(options));
    expect(conflict).toBeInstanceOf(ApiError);
    expect(conflict).toMatchObject({
      status: 409,
      code: "VAULT_RESOURCE_VERSION_CONFLICT",
    });
    expect((conflict as ApiError).detail).toBe(
      "Vault resource content conflicts with the existing resource",
    );
    answer = errorResponse(500, "INTERNAL", "value example-token was refused");
    const other = await rejection(secrets.create(options));
    expect(other).toMatchObject({ status: 500, code: "INTERNAL" });
    expect((other as ApiError).detail).toBe("request failed");
    expect(JSON.stringify(other)).not.toContain("example-token");
  });

  // Contract: get and delete address the named Secret in the Namespace.
  it("gets and deletes a Secret by name", async () => {
    const network = new FakeNetwork((request) => {
      if (request.url.pathname !== `${secretsPath}/git`) return undefined;
      if (request.method === "GET") return json(servedSecret());
      if (request.method === "DELETE") {
        return json({ accepted: true, deletedAt: "2026-01-03T00:00:00Z" });
      }
      return undefined;
    });
    const { secrets } = network.client();
    const secret = await secrets.get("git");
    expect(secret.id).toBe(SECRET_ID);
    await secrets.delete("git");
    expect(network.computerCalls()).toEqual([
      `GET ${secretsPath}/git`,
      `DELETE ${secretsPath}/git`,
    ]);
  });

  // Contract: a served Secret of another Subnet or name is never handed back.
  // Each case is a complete, valid Secret apart from the one field it
  // changes, so only the scope check can refuse it; the control is read.
  it("refuses a response that names another Secret", async () => {
    for (const [field, value] of [
      ["subnet", "550000000099"],
      ["namespace", "team-b"],
      ["name", "npm"],
    ] as const) {
      const network = new FakeNetwork((request) =>
        request.method === "GET"
          ? json(
              servedSecret({ metadata: { ...servedMetadata, [field]: value } }),
            )
          : undefined,
      );
      const error = await rejection(network.client().secrets.get("git"));
      expect(error, field).toBeInstanceOf(TransportError);
      expect((error as Error).message, field).toBe(
        "secret response names a secret other than the one addressed",
      );
    }
    const control = new FakeNetwork((request) =>
      request.method === "GET"
        ? json(servedSecret({ metadata: servedMetadata }))
        : undefined,
    );
    expect((await control.client().secrets.get("git")).id).toBe(SECRET_ID);
  });
});

describe("a Secret's lifecycle", () => {
  // Contract: a listing reads the Namespace's Secrets page by page with
  // `limit` and an offset carried as `continue`, and the walk reads every
  // page until the platform's total is reached.
  it("lists Secrets page by page", async () => {
    const names = ["a-git", "b-npm", "c-pypi"];
    const network = new FakeNetwork((request) => {
      if (request.method !== "GET" || request.url.pathname !== secretsPath) {
        return undefined;
      }
      const offset = Number(request.url.searchParams.get("offset") ?? "0");
      const limit = Number(request.url.searchParams.get("limit"));
      return json({
        items: names.slice(offset, offset + limit).map((name) =>
          servedSecret({
            metadata: {
              id: SECRET_ID,
              name,
              namespace: "default",
              subnet: subnetSlug,
            },
          }),
        ),
        totalCount: names.length,
      });
    });
    const { secrets } = network.client();
    const first = await secrets.listPage({ limit: 2 });
    expect(first.items.map((secret) => secret.name)).toEqual([
      "a-git",
      "b-npm",
    ]);
    expect(first.continue).toBe("2");
    const last = await secrets.listPage({ limit: 2, continue: "2" });
    expect(last.items.map((secret) => secret.name)).toEqual(["c-pypi"]);
    expect(last.continue).toBeUndefined();
    const walked: string[] = [];
    for await (const secret of secrets.list({ limit: 2 })) {
      walked.push(secret.name);
    }
    expect(walked).toEqual(names);
    expect(network.computerCalls()).toEqual([
      `GET ${secretsPath}?limit=2`,
      `GET ${secretsPath}?limit=2&offset=2`,
      `GET ${secretsPath}?limit=2`,
      `GET ${secretsPath}?limit=2&offset=2`,
    ]);
  });

  // Contract: a listed Secret of another Subnet or another Namespace is
  // never handed back. Each case is a complete, valid Secret apart from the
  // one field it changes, so only the scope check can refuse it; the
  // control is read.
  it("refuses a listing that names another Subnet or Namespace", async () => {
    const page = (metadata: Record<string, unknown>) =>
      new FakeNetwork((request) =>
        request.method === "GET"
          ? json({ items: [servedSecret({ metadata })], totalCount: 1 })
          : undefined,
      );
    for (const [field, value] of [
      ["subnet", "550000000099"],
      ["namespace", "team-b"],
    ] as const) {
      const error = await rejection(
        page({ ...servedMetadata, [field]: value })
          .client()
          .secrets.listPage(),
      );
      expect(error, field).toBeInstanceOf(TransportError);
      expect((error as Error).message, field).toBe(
        "secret list names a secret outside the addressed namespace",
      );
    }
    const control = await page(servedMetadata).client().secrets.listPage();
    expect(control.items.map((secret) => secret.id)).toEqual([SECRET_ID]);
  });

  // Contract: a listing returns every Secret the contract admits, keyed
  // Secrets included: a keyed Secret reads with its keys, no origins and no
  // credential, beside a Secret with a source.
  it("lists keyed Secrets beside Secrets with a source", async () => {
    const network = new FakeNetwork((request) =>
      request.method === "GET" && request.url.pathname === secretsPath
        ? json({
            items: [
              servedSecret({
                metadata: { ...servedMetadata, name: "certs" },
                spec: {
                  keys: [{ name: "tls.crt", sizeBytes: 1200 }, { name: "x" }],
                  currentVersion: 2,
                  versionCount: 2,
                },
              }),
              servedSecret(),
            ],
            totalCount: 2,
          })
        : undefined,
    );
    const { items } = await network.client().secrets.listPage();
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      id: SECRET_ID,
      name: "certs",
      namespace: "default",
      origins: [],
      source: {
        type: "keys",
        keys: [
          { name: "tls.crt", sizeBytes: 1200 },
          { name: "x", sizeBytes: 0 },
        ],
      },
      version: 2,
      resourceVersion: 1,
      state: "active",
      health: "healthy",
      createdAt: "2026-01-02T03:04:05Z",
      updatedAt: "2026-01-02T03:04:05Z",
    });
    expect(items[1]?.credential).toEqual({ type: "basic-password" });
    expect(items[1]?.source.type).toBe("value");
  });

  // Contract: a rotation posts the new version's spec to the Secret's
  // rotate route with the resource version it expects as a strong ETag in
  // If-Match and the caller's key in Idempotency-Key, and returns the
  // Secret as rotated, with no value in it.
  it("rotates a Secret under a precondition and an idempotency key", async () => {
    let sent: { body: unknown; headers: Headers } | undefined;
    const network = new FakeNetwork((request, body) => {
      if (
        request.method === "POST" &&
        request.url.pathname === `${secretsPath}/git:rotate`
      ) {
        sent = { body, headers: request.headers };
        return json(
          servedSecret({
            spec: {
              source: { value: { sizeBytes: 13 } },
              egress: {
                origins: ["https://git.example.com"],
                credential: { type: "authorization-token", scheme: "token" },
              },
              currentVersion: 2,
              versionCount: 2,
            },
            status: { state: "active", health: "healthy", resourceVersion: 4 },
          }),
        );
      }
      return undefined;
    });
    const secret = await network.client().secrets.rotate("git", {
      value: "example-token-2",
      origins: ["https://git.example.com"],
      credential: { type: "authorization-token", scheme: "token" },
      resourceVersion: 3,
      idempotencyKey: "rotate-git-1",
    });
    expect(sent?.body).toEqual({
      spec: {
        source: { value: "example-token-2" },
        egress: {
          origins: ["https://git.example.com"],
          credential: { type: "authorization-token", scheme: "token" },
        },
      },
    });
    expect(sent?.headers.get("If-Match")).toBe('"3"');
    expect(sent?.headers.get("Idempotency-Key")).toBe("rotate-git-1");
    expect(secret.version).toBe(2);
    expect(secret.resourceVersion).toBe(4);
    expect(secret.credential).toEqual({
      type: "authorization-token",
      scheme: "token",
    });
    expect(JSON.stringify(secret)).not.toContain("example-token");
  });

  // Contract: a rotation without its two guards, or with content a write
  // refuses, is refused with a TypeError naming the field before anything
  // is sent.
  it("refuses an invalid rotation before any request", async () => {
    const network = new FakeNetwork(() => json(servedSecret()));
    const { secrets } = network.client();
    const base = {
      value: "example-token",
      origins: ["https://git.example.com"],
      credential: { type: "basic-password" },
      resourceVersion: 1,
      idempotencyKey: "rotate-git-1",
    } as const;
    await expect(
      secrets.rotate("git", { ...base, idempotencyKey: " " }),
    ).rejects.toThrow("idempotencyKey is required");
    await expect(
      secrets.rotate("git", { ...base, idempotencyKey: "key\n" }),
    ).rejects.toThrow(
      "idempotencyKey must have no surrounding whitespace and no line break",
    );
    await expect(
      secrets.rotate("git", { ...base, resourceVersion: 0 }),
    ).rejects.toThrow("resourceVersion must be a positive integer");
    await expect(
      secrets.rotate("git", {
        ...base,
        origins: ["https://git.example.com:8443"],
      }),
    ).rejects.toThrow("spec.egress.origins[0]: origin must use port 443");
    expect(network.plane.requests).toHaveLength(0);
  });

  // Contract: a purge states the explicit confirmation `purge`, and
  // `force` only when asked; any other confirmation is refused before
  // anything is sent.
  it("purges a Secret only with an explicit confirmation", async () => {
    const sent: unknown[] = [];
    const network = new FakeNetwork((request, body) => {
      if (
        request.method === "POST" &&
        request.url.pathname === `${secretsPath}/git:purge`
      ) {
        sent.push(body);
        return json({ accepted: true, purgedAt: "2026-01-04T00:00:00Z" });
      }
      return undefined;
    });
    const { secrets } = network.client();
    await expect(
      secrets.purge("git", { confirm: "yes" as "purge" }),
    ).rejects.toThrow('confirm must be "purge"');
    expect(network.computerCalls()).toEqual([]);
    expect(await secrets.purge("git", { confirm: "purge" })).toEqual({
      accepted: true,
      purgedAt: "2026-01-04T00:00:00Z",
    });
    await secrets.purge("git", { confirm: "purge", force: true });
    expect(sent).toEqual([
      { confirm: "purge" },
      { confirm: "purge", force: true },
    ]);
  });

  // Contract: the versions read asks for the newest `limit` versions and
  // reports each without a value, newest first as served.
  it("reads a Secret's versions", async () => {
    const network = new FakeNetwork((request) =>
      request.method === "GET" &&
      request.url.pathname === `${secretsPath}/git/versions`
        ? json({
            items: [
              { version: 2, createdAt: "2026-01-03T00:00:00Z", current: true },
              { version: 1, createdAt: "2026-01-02T00:00:00Z", current: false },
            ],
            totalCount: 2,
          })
        : undefined,
    );
    const versions = await network.client().secrets.versions("git", {
      limit: 2,
    });
    expect(versions).toEqual([
      { version: 2, current: true, createdAt: "2026-01-03T00:00:00Z" },
      { version: 1, current: false, createdAt: "2026-01-02T00:00:00Z" },
    ]);
    expect(network.computerCalls()).toEqual([
      `GET ${secretsPath}/git/versions?limit=2`,
    ]);
  });
});

describe("the authorization-token credential and the port rule", () => {
  // Contract: an authorization-token credential is sent with its scheme and
  // no header, and the read reports it.
  it("creates a Secret that fills an Authorization token", async () => {
    let sent: unknown;
    const network = new FakeNetwork((request, body) => {
      if (request.method === "PUT") {
        sent = body;
        return json(
          servedSecret({
            spec: {
              source: { value: { sizeBytes: 13 } },
              egress: {
                origins: ["https://api.example.com"],
                credential: { type: "authorization-token", scheme: "Bearer" },
              },
              currentVersion: 1,
              versionCount: 1,
            },
          }),
        );
      }
      return undefined;
    });
    const secret = await network.client().secrets.create({
      name: "git",
      value: "example-token",
      origins: ["https://api.example.com:443"],
      credential: { type: "authorization-token", scheme: "Bearer" },
    });
    expect((sent as { spec: { egress: unknown } }).spec.egress).toEqual({
      origins: ["https://api.example.com:443"],
      credential: { type: "authorization-token", scheme: "Bearer" },
    });
    expect(secret.credential).toEqual({
      type: "authorization-token",
      scheme: "Bearer",
    });
  });

  // Contract: the scheme set is closed and spelled exactly, and a write
  // names port 443 only, each refused with the contract's sentence before
  // anything is sent.
  it("refuses another scheme and another port before any request", async () => {
    const network = new FakeNetwork(() => json(servedSecret()));
    const { secrets } = network.client();
    const base = {
      name: "git",
      value: "example-token",
      origins: ["https://git.example.com"],
      credential: { type: "basic-password" },
    } as const;
    const scheme = (value: string) =>
      secrets.create({
        ...base,
        credential: {
          type: "authorization-token",
          scheme: value as "Bearer",
        },
      });
    await expect(scheme("bearer")).rejects.toThrow(
      'spec.egress.credential: unknown authorization scheme "bearer"',
    );
    await expect(scheme("Basic")).rejects.toThrow(
      'spec.egress.credential: unknown authorization scheme "Basic"',
    );
    await expect(
      secrets.create({
        ...base,
        credential: { type: "authorization-token" } as unknown as {
          type: "authorization-token";
          scheme: "Bearer";
        },
      }),
    ).rejects.toThrow("spec.egress.credential: scheme is required");
    await expect(
      secrets.create({
        ...base,
        origins: ["https://git.example.com", "https://api.example.com:8443"],
      }),
    ).rejects.toThrow("spec.egress.origins[1]: origin must use port 443");
    expect(network.plane.requests).toHaveLength(0);
  });

  // Contract: a stored Secret on another port still reads, because only a
  // write is held to port 443.
  it("reads a stored Secret on another port", async () => {
    const network = new FakeNetwork((request) =>
      request.method === "GET"
        ? json(
            servedSecret({
              spec: {
                source: { value: { sizeBytes: 13 } },
                egress: {
                  origins: ["https://git.example.com:8443"],
                  credential: { type: "basic-password" },
                },
                currentVersion: 1,
                versionCount: 1,
              },
            }),
          )
        : undefined,
    );
    const secret = await network.client().secrets.get("git");
    expect(secret.origins).toEqual(["https://git.example.com:8443"]);
  });
});

describe("the client's Namespace", () => {
  // Contract: `namespace` selects the Namespace Computers and Secrets are
  // addressed in, and a client that names none addresses `default`.
  it("addresses a named Namespace", async () => {
    const network = new FakeNetwork((request) => {
      const prefix = `/v1/accounts/${accountId}/namespaces/team-a`;
      if (request.url.pathname === `${prefix}/computers/api-dev`) {
        return json({ computer: computerRecord({ namespace: "team-a" }) });
      }
      if (request.url.pathname === `${prefix}/vault/secrets/git`) {
        return json(
          servedSecret({
            metadata: {
              id: SECRET_ID,
              name: "git",
              namespace: "team-a",
              subnet: subnetSlug,
            },
          }),
        );
      }
      return undefined;
    });
    const client = network.client({ namespace: "team-a" });
    expect(client.namespace).toBe("team-a");
    expect((await client.computers.get("api-dev")).name).toBe("api-dev");
    expect((await client.secrets.get("git")).namespace).toBe("team-a");
    expect(network.client().namespace).toBe("default");
  });

  // Contract: an invalid Namespace is refused when the client is built.
  it("refuses an invalid Namespace", () => {
    expect(
      () =>
        new Idyl({
          credential: testCredential,
          endpoints,
          namespace: "Team A",
        }),
    ).toThrow('namespace "Team A" is invalid');
    expect(
      () => new Idyl({ credential: testCredential, endpoints, namespace: "" }),
    ).toThrow("namespace is required");
  });
});

describe("Computer Secret attachments", () => {
  // Contract: `secrets` attaches by variable; a canonical UUID names a Secret
  // by ID and anything else by name, and a version pins one.
  it("attaches Secrets on create by name and by ID", async () => {
    let sent: unknown;
    const network = new FakeNetwork((request, body) => {
      if (request.method === "POST" && request.url.pathname === computersPath) {
        sent = body;
        return json({ computer: computerRecord() }, 201);
      }
      return undefined;
    });
    await network.client().computers.create({
      name: "api-dev",
      secrets: {
        GIT_TOKEN: "git",
        API_TOKEN: { secret: SECRET_ID, version: 2 },
      },
    });
    expect((sent as { spec: unknown }).spec).toEqual({
      execution: {
        secrets: [
          { env: "GIT_TOKEN", secret: { name: "git" } },
          { env: "API_TOKEN", secret: { id: SECRET_ID, version: 2 } },
        ],
      },
    });
  });

  // Contract: an update attaches each stated Secret and detaches each one
  // set to null, by variable; a read reports each attachment by ID.
  it("attaches and detaches Secrets on update, and reads them", async () => {
    let sent: unknown;
    const attached = computerRecord({
      spec: {
        idleTimeout: "300s",
        execution: {
          secrets: [
            { env: "GIT_TOKEN", secret: { id: SECRET_ID, version: 3 } },
          ],
        },
      },
    });
    const network = new FakeNetwork((request, body) => {
      if (request.method === "GET") return json({ computer: attached });
      if (request.method === "PATCH") {
        sent = body;
        return json({ computer: attached });
      }
      return undefined;
    });
    const computer = await network.client().computers.get("api-dev");
    expect(computer.snapshot.settings.secrets).toEqual({
      GIT_TOKEN: { secret: SECRET_ID, version: 3 },
    });
    await computer.update({ secrets: { GIT_TOKEN: "git", OLD_TOKEN: null } });
    expect(sent).toEqual({
      setSecrets: [{ env: "GIT_TOKEN", secret: { name: "git" } }],
      removeSecrets: ["OLD_TOKEN"],
      client: "sdk",
    });
    await expect(
      computer.update({
        secrets: { GIT_TOKEN: { secret: "git", version: 0 } },
      }),
    ).rejects.toThrow("secrets.GIT_TOKEN.version must be a positive integer");
  });

  // Contract: a Computer's attachment states are read by its ID on the
  // Computer's own route and handed back as served.
  it("reads the state of each attachment", async () => {
    const network = new FakeNetwork((request) => {
      if (request.url.pathname === `${computersPath}/api-dev`) {
        return json({ computer: computerRecord() });
      }
      if (
        request.url.pathname ===
        `${computersPath}/by-id/01954e20-7540-7ec4-93ec-14f783e6ab04/secrets`
      ) {
        return json({
          items: [
            { env: "GIT_TOKEN", secret: SECRET_ID, health: "healthy" },
            {
              env: "NPM_TOKEN",
              secret: SECRET_ID,
              health: "broken",
              reason: "not_attached",
            },
          ],
        });
      }
      return undefined;
    });
    const computer = await network.client().computers.get("api-dev");
    expect(await computer.secrets()).toEqual([
      { env: "GIT_TOKEN", secret: SECRET_ID, health: "healthy" },
      {
        env: "NPM_TOKEN",
        secret: SECRET_ID,
        health: "broken",
        reason: "not_attached",
      },
    ]);
  });

  // Contract: the Computers that attach a Secret are read by the Secret's
  // ID under the reserved by-secret segment; a value that is not an ID is
  // refused before anything is sent.
  it("lists the Computers that attach a Secret", async () => {
    const network = new FakeNetwork((request) =>
      request.url.pathname === `${computersPath}/by-secret/${SECRET_ID}`
        ? json({
            items: [
              {
                computer: "01954e20-7540-7ec4-93ec-14f783e6ab2a",
                computerName: "build",
                env: "GITHUB_TOKEN",
                attached: true,
              },
              {
                computer: "01954e20-7540-7ec4-93ec-14f783e6ab2b",
                computerName: "release",
                env: "GITHUB_TOKEN",
                attached: false,
                version: 2,
              },
            ],
          })
        : undefined,
    );
    const { computers } = network.client();
    await expect(computers.listBySecret("git")).rejects.toThrow(
      "secret ID must be a canonical UUID",
    );
    expect(network.plane.requests).toHaveLength(0);
    expect(await computers.listBySecret(SECRET_ID)).toEqual([
      {
        computer: "01954e20-7540-7ec4-93ec-14f783e6ab2a",
        computerName: "build",
        env: "GITHUB_TOKEN",
        attached: true,
      },
      {
        computer: "01954e20-7540-7ec4-93ec-14f783e6ab2b",
        computerName: "release",
        env: "GITHUB_TOKEN",
        attached: false,
        version: 2,
      },
    ]);
  });

  // Contract: the request goes to the Computer API host, never elsewhere.
  it("sends Secret writes to the Computer API host", async () => {
    const network = new FakeNetwork((request) =>
      request.method === "PUT" ? json(servedSecret()) : undefined,
    );
    await network.client().secrets.create({
      name: "git",
      value: "example-token",
      origins: ["https://git.example.com"],
      credential: { type: "basic-password" },
    });
    const put = network.plane.requests.find((r) => r.method === "PUT");
    expect(put?.url.host).toBe(computerHost);
  });
});
