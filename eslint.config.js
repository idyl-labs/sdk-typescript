// Copyright 2026 Idyl Labs. SPDX-License-Identifier: Apache-2.0

import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * One layering rule: the files named may not import the modules named. The
 * layering is `resource` → `api` → `internal` → `services` → `client`;
 * contract modules never reach transport or client code, and the package
 * entry never re-exports an internal module. ARCHITECTURE.md states
 * the layers and what each may import.
 *
 * The one allowance is `internal/strictdecode`: strict submission decoding is
 * one implementation used by both `resource` and `api`, so the two reject
 * documents by the same rules and name rejected fields the same way. It is
 * decode logic only, so the contract modules that import it still import no
 * client or transport code.
 *
 * @param {string[]} files
 * @param {string[]} group
 * @param {string} message
 * @returns {import("typescript-eslint").ConfigWithExtends}
 */
function layer(files, group, message) {
  return {
    files,
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group, message }] }],
    },
  };
}

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      ".package-test/**",
      "wasm/target/**",
      "wasm/pkg/**",
      "coverage/**",
      "test/conformance/fixtures/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: [
          "./tsconfig.json",
          "./tsconfig.test.json",
          "./tsconfig.examples.json",
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-exports": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/no-confusing-void-expression": "error",
      "@typescript-eslint/only-throw-error": "error",
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-console": "error",
    },
  },
  {
    // Examples are written as an application would write them, reading its
    // access key with `process.env.IDYL_ACCESS_KEY!`.
    files: ["examples/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  layer(["src/**/*.ts"], ["node:*"], "src uses web-standard APIs only"),
  layer(
    ["src/resource/**/*.ts"],
    [
      "../*.js",
      "**/api/**",
      "**/internal/**",
      "!**/internal/strictdecode.js",
      "**/services/**",
    ],
    "resource modules are contracts; they import only their siblings and the strict decoder",
  ),
  layer(
    ["src/api/**/*.ts"],
    [
      "../*.js",
      "**/internal/**",
      "!**/internal/strictdecode.js",
      "**/services/**",
    ],
    "api modules import only resource modules and the strict decoder",
  ),
  layer(
    ["src/internal/**/*.ts"],
    [
      "../*.js",
      "!../errors.js",
      "!../credential.js",
      "!../client-product.js",
      "**/services/**",
    ],
    "internal modules import only resource, api, errors, credential, and client-product modules",
  ),
  layer(
    ["src/index.ts"],
    ["./internal/**"],
    "the package entry never exports an internal module",
  ),
  {
    files: ["**/*.js", "**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: { globals: globals.node },
  },
);
