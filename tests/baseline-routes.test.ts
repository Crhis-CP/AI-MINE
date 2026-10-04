import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeRouteTree } from "../scripts/baseline/routes.ts";

test("route normalization retains relative suffixes, multiple methods and explicitly resolved wildcards", () => {
  const tree = [
    "├── /api/admin/feedback (GET, HEAD)",
    "│   └── -bans (POST)",
    "│       └── /:hash (DELETE)",
    "└── /api/v1 (GET)",
    "    └── * (OPTIONS, GET)",
  ].join("\n");
  assert.deepEqual(
    normalizeRouteTree(tree, { "/api/v1": "/api/v1/*" }),
    [
      "GET /api/admin/feedback",
      "HEAD /api/admin/feedback",
      "POST /api/admin/feedback-bans",
      "DELETE /api/admin/feedback-bans/:hash",
      "GET /api/v1",
      "GET /api/v1/*",
      "OPTIONS /api/v1/*",
    ].sort(),
  );
  assert.deepEqual(normalizeRouteTree("└── * (POST)\r\n", { "": "/api/public/*" }), ["POST /api/public/*"]);
});

test("unrecognized data, indentation gaps, malformed trees and duplicate routes are never silently dropped", () => {
  for (const tree of [
    "",
    "ignored",
    "└── /a (BOGUS)",
    "└── /a (GET, GET)",
    "└── a (GET)",
    "        └── /a (GET)",
    "  └── /a (GET)",
    "├── /a (GET)",
    "└── /a (GET)\n└── /b (GET)",
    "├── /a (GET)\n    └── /b (GET)",
    "├── /a (GET)\n│   ├── /b (GET)\n└── /c (GET)",
    "├── /a (GET)\n└── /a (GET)",
    "└── /a (GET)\nunknown",
  ])
    assert.throws(() => normalizeRouteTree(tree, {}), /Invalid route tree/);
});

test("wildcard mapping is mandatory, fully consumed and can resolve a parent only once", () => {
  assert.throws(() => normalizeRouteTree("└── * (GET)", {}), /wildcard mapping/);
  assert.throws(() => normalizeRouteTree("└── /a (GET)", { "": "/api/public/*" }), /unused wildcard mapping/);
  assert.throws(() => normalizeRouteTree("└── * (GET)", { "": "wrong" }), /invalid wildcard mapping/);
  assert.throws(() => normalizeRouteTree("├── * (GET)\n└── * (POST)", { "": "/api/public/*" }), /repeated wildcard mapping/);
  assert.throws(() => normalizeRouteTree("└── * (GET)\n    └── /a (GET)", { "": "/api/public/*" }), /wildcard cannot have children/);
});
