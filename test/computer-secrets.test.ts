// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  encodeUpdateComputerRequest,
  updateComputerRequestShape,
  validateUpdateComputerRequest,
  type UpdateComputerRequest,
} from "../src/api/computer.js";
import { validateComputerExecutionSettingsChange } from "../src/api/computer-execution-settings.js";
import {
  ComputerExecutionSettingsError,
  computerExecutionSettingsShape,
  validateComputerExecutionSettings,
  type ComputerExecutionSettings,
} from "../src/resource/computer-execution-settings.js";
import {
  decodeListComputerSecretAttachmentsResponse,
  validateComputerSecretAttachmentStatus,
  validateListComputerSecretAttachmentsResponse,
} from "../src/api/computer-secrets.js";
import { decodeText } from "../src/internal/strictdecode.js";
import { parseResourceId } from "../src/resource/uuid-id.js";

const secretId = parseResourceId("01954e20-7540-7ec4-93ec-14f783e6ab1a");

/** Settings that attach one Secret by ID and assume one AWS role. */
const attaching: ComputerExecutionSettings = {
  variables: [{ name: "LOG_LEVEL", value: "debug" }],
  secrets: [{ env: "GITHUB_TOKEN", secret: { id: secretId } }],
  identity: { aws: { roleArn: "arn:aws:iam::123456789012:role/ci/push" } },
};

function refusal(run: () => void): ComputerExecutionSettingsError {
  try {
    run();
  } catch (error) {
    if (error instanceof ComputerExecutionSettingsError) return error;
    if (
      error instanceof TypeError &&
      error.cause instanceof ComputerExecutionSettingsError
    ) {
      return error.cause;
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("a Computer's Secret attachments and identity", () => {
  // Contract: attachments and the identity are written after the variables
  // and before the shell, and read back as written.
  it("writes and reads attachments and the identity", () => {
    const encoded = computerExecutionSettingsShape.encode({
      ...attaching,
      shell: "/usr/bin/zsh",
    });
    expect(JSON.stringify(encoded)).toBe(
      '{"variables":[{"name":"LOG_LEVEL","value":"debug"}],' +
        '"secrets":[{"env":"GITHUB_TOKEN","secret":{"id":"01954e20-7540-7ec4-93ec-14f783e6ab1a"}}],' +
        '"identity":{"aws":{"roleArn":"arn:aws:iam::123456789012:role/ci/push"}},' +
        '"shell":"/usr/bin/zsh"}',
    );
    expect(
      decodeText(JSON.stringify(encoded), computerExecutionSettingsShape),
    ).toEqual({ ...attaching, shell: "/usr/bin/zsh" });
    expect(() => {
      validateComputerExecutionSettings(attaching);
    }).not.toThrow();
    expect(() => {
      validateComputerExecutionSettings({
        secrets: [{ env: "GITHUB_TOKEN", secret: { name: "github" } }],
      });
    }).not.toThrow();
  });

  // Contract: each refusal names the field of the attachment or the
  // identity it refuses.
  it("refuses attachments and identities by field", () => {
    const cases: readonly [ComputerExecutionSettings, string, string][] = [
      [
        { secrets: [{ env: "GITHUB-TOKEN", secret: { name: "github" } }] },
        "execution.secrets[0].env",
        "must match [a-zA-Z_][a-zA-Z0-9_]*",
      ],
      [
        {
          variables: [{ name: "GITHUB_TOKEN", value: "" }],
          secrets: [{ env: "GITHUB_TOKEN", secret: { name: "github" } }],
        },
        "execution.secrets[0].env",
        "duplicates variables[0]",
      ],
      [
        {
          secrets: [
            { env: "GITHUB_TOKEN", secret: { name: "github" } },
            { env: "GITHUB_TOKEN", secret: { id: secretId } },
          ],
        },
        "execution.secrets[1].env",
        "duplicates secrets[0]",
      ],
      [
        { secrets: [{ env: "GITHUB_TOKEN", secret: {} }] },
        "execution.secrets[0].secret",
        "must state exactly one of id and name",
      ],
      [
        {
          secrets: [
            { env: "GITHUB_TOKEN", secret: { id: secretId, name: "github" } },
          ],
        },
        "execution.secrets[0].secret",
        "must state exactly one of id and name",
      ],
      [
        { secrets: [{ env: "GITHUB_TOKEN", secret: { name: "GitHub" } }] },
        "execution.secrets[0].secret.name",
        'name "GitHub" is invalid',
      ],
      [{ identity: {} }, "execution.identity", "must state aws"],
      [
        {
          variables: [
            {
              name: "AWS_ROLE_ARN",
              value: "arn:aws:iam::123456789012:role/other",
            },
          ],
          identity: { aws: { roleArn: "arn:aws:iam::123456789012:role/ci" } },
        },
        "execution.variables[0].name",
        "AWS_ROLE_ARN is set by IDYL for a computer with an identity",
      ],
      [
        {
          secrets: [
            { env: "AWS_ROLE_SESSION_NAME", secret: { name: "github" } },
          ],
          identity: { aws: { roleArn: "arn:aws:iam::123456789012:role/ci" } },
        },
        "execution.secrets[0].env",
        "AWS_ROLE_SESSION_NAME is set by IDYL for a computer with an identity",
      ],
      [
        { identity: { aws: { roleArn: "arn:aws:iam::123456789012:user/ci" } } },
        "execution.identity.aws.roleArn",
        "must be an IAM role ARN: arn:<partition>:iam::<account>:role/<name>",
      ],
    ];
    for (const [settings, field, rule] of cases) {
      const refused = refusal(() => {
        validateComputerExecutionSettings(settings);
      });
      expect([refused.field, refused.rule]).toEqual([field, rule]);
    }
  });

  // Contract: an update attaches and detaches by variable, writes both lists
  // after the variables, decodes them strictly, and names a refused
  // attachment by the request's own field.
  it("attaches and detaches through an update", () => {
    const request: UpdateComputerRequest = {
      client: "cli",
      removeSecrets: ["PROBE"],
      setSecrets: [{ env: "GITHUB_TOKEN", secret: { name: "github" } }],
    };
    expect(() => {
      validateUpdateComputerRequest(request);
    }).not.toThrow();
    const wire =
      '{"setSecrets":[{"env":"GITHUB_TOKEN","secret":{"name":"github"}}],"removeSecrets":["PROBE"],"client":"cli"}';
    expect(JSON.stringify(encodeUpdateComputerRequest(request))).toBe(wire);
    expect(decodeText(wire, updateComputerRequestShape)).toEqual(request);
    expect(() =>
      decodeText(
        '{"setSecrets":[{"env":"A","secret":{"name":"a","revision":1}}]}',
        updateComputerRequestShape,
      ),
    ).toThrow(/setSecrets\[0\]\.secret\.revision/u);

    const cases: readonly [UpdateComputerRequest, string][] = [
      [
        { setSecrets: [{ env: "IDYL_TOKEN", secret: { name: "github" } }] },
        "setSecrets[0].env",
      ],
      [{ removeSecrets: ["A", "A"] }, "removeSecrets[1]"],
      [
        {
          setSecrets: [{ env: "A", secret: { name: "github" } }],
          removeSecrets: ["A"],
        },
        "removeSecrets[0]",
      ],
    ];
    for (const [refused, field] of cases) {
      expect(
        refusal(() => {
          validateUpdateComputerRequest(refused);
        }).field,
      ).toBe(field);
    }
  });

  // Contract: a journal entry names a change of an attachment by its
  // variable and a change of the identity by `identity`.
  it("names attachment and identity changes in the journal", () => {
    const change = {
      cause: "settings",
      settings: attaching,
      revision: 2,
      changed: ["secrets.GITHUB_TOKEN", "identity"],
      creator: "550000000001",
      client: "cli",
    } as const;
    expect(() => {
      validateComputerExecutionSettingsChange(change);
    }).not.toThrow();
    expect(() => {
      validateComputerExecutionSettingsChange({
        ...change,
        changed: ["secrets.1BAD"],
      });
    }).toThrow(/"secrets\.1BAD" does not name a variable/u);
  });
});

describe("a Computer's attachment states and pinned versions", () => {
  // Contract: a pinned version is written beside the reference and read back
  // as written; an unpinned reference writes none.
  it("writes and reads a pinned version", () => {
    const settings: ComputerExecutionSettings = {
      secrets: [
        { env: "REGISTRY_TOKEN", secret: { name: "registry", version: 3 } },
      ],
    };
    const encoded = JSON.stringify(
      computerExecutionSettingsShape.encode(settings),
    );
    expect(encoded).toBe(
      '{"secrets":[{"env":"REGISTRY_TOKEN","secret":{"name":"registry","version":3}}]}',
    );
    expect(decodeText(encoded, computerExecutionSettingsShape)).toEqual(
      settings,
    );
    expect(
      JSON.stringify(
        computerExecutionSettingsShape.encode({
          secrets: [{ env: "A", secret: { name: "a" } }],
        }),
      ),
    ).toBe('{"secrets":[{"env":"A","secret":{"name":"a"}}]}');
  });

  // Contract: an attachment state names a reason exactly when it is not
  // healthy, `expiring` with its health and any other reason with `broken`;
  // a list names each variable once; unknown tokens decode and are judged.
  it("judges attachment states", () => {
    const secret = parseResourceId("01954e20-7540-7ec4-93ec-14f783e6ab1a");
    for (const status of [
      { env: "A", secret, health: "healthy" },
      { env: "A", secret, health: "expiring", reason: "expiring" },
      { env: "A", secret, health: "broken", reason: "secret_deleted" },
      { env: "A", secret, health: "broken", reason: "not_attached" },
    ] as const) {
      expect(() => {
        validateComputerSecretAttachmentStatus(status);
      }).not.toThrow();
    }
    for (const [status, message] of [
      [
        { env: "A", secret, health: "healthy", reason: "expired" },
        "reason must be absent when healthy",
      ],
      [
        { env: "A", secret, health: "expiring" },
        "reason must be expiring when expiring",
      ],
      [
        { env: "A", secret, health: "broken" },
        "reason is required when broken",
      ],
      [
        { env: "A", secret, health: "broken", reason: "revoked" },
        'unknown attachment reason "revoked"',
      ],
      [
        { env: "A", secret, health: "degraded" },
        'unknown attachment health "degraded"',
      ],
    ] as const) {
      expect(() => {
        validateComputerSecretAttachmentStatus(status);
      }).toThrow(message);
    }
    expect(() => {
      validateListComputerSecretAttachmentsResponse({
        items: [
          { env: "A", secret, health: "healthy" },
          { env: "A", secret, health: "healthy" },
        ],
      });
    }).toThrow("items[1].env duplicates items[0]");
    expect(
      decodeListComputerSecretAttachmentsResponse(
        `{"items":[{"env":"A","secret":"${secret}","health":"degraded","note":"x"}]}`,
      ).items[0]?.health,
    ).toBe("degraded");
  });
});

describe("an update of a Computer's workload identity", () => {
  // Contract: an update states an identity as its value or removes it as
  // null, reads both back, and judges the identity as the settings do.
  it("sets, removes, and judges the identity", () => {
    const role = "arn:aws:iam::123456789012:role/ci";
    const set: UpdateComputerRequest = { identity: { aws: { roleArn: role } } };
    expect(JSON.stringify(encodeUpdateComputerRequest(set))).toBe(
      `{"identity":{"aws":{"roleArn":"${role}"}}}`,
    );
    expect(
      decodeText(
        `{"identity":{"aws":{"roleArn":"${role}"}}}`,
        updateComputerRequestShape,
      ),
    ).toEqual(set);
    const removed: UpdateComputerRequest = { identity: null, client: "cli" };
    expect(JSON.stringify(encodeUpdateComputerRequest(removed))).toBe(
      '{"identity":null,"client":"cli"}',
    );
    expect(
      decodeText(
        '{"identity":null,"client":"cli"}',
        updateComputerRequestShape,
      ),
    ).toEqual(removed);
    expect(() => {
      validateUpdateComputerRequest(removed);
    }).not.toThrow();
    expect(
      refusal(() => {
        validateUpdateComputerRequest({
          identity: { aws: { roleArn: "arn:aws:iam::123456789012:user/ci" } },
        });
      }).field,
    ).toBe("identity.aws.roleArn");
    expect(
      refusal(() => {
        validateUpdateComputerRequest({
          identity: { aws: { roleArn: role } },
          setVariables: [{ name: "AWS_ROLE_ARN", value: "x" }],
        });
      }).field,
    ).toBe("setVariables[0].name");
  });
});
