// ci-db: the database image of a GitHub Actions run is docker-compose.yml's, read from one place (TASK-0015).
import assert from "node:assert/strict";
import { test } from "node:test";
import { composeDbImage } from "../ci-db.ts";

const DIGEST = `sha256:${"b".repeat(64)}`;

test("the db service's pinned image is read from the compose text", () => {
  const compose = `x-app: &app\n  build: .\nservices:\n  db:\n    image: postgres:18.6-alpine@${DIGEST}\n  api:\n    <<: *app\n`;
  assert.equal(composeDbImage(compose), `postgres:18.6-alpine@${DIGEST}`);
});

test("a db service without an image, or with an image that is not pinned, is an error", () => {
  assert.throws(() => composeDbImage("services:\n  db:\n    build: ./db\n"), /service db has no image/);
  assert.throws(() => composeDbImage("services:\n  web:\n    image: nginx\n"), /service db has no image/);
  assert.throws(
    () => composeDbImage("services:\n  db:\n    image: postgres:18-alpine\n"),
    /must name a patch version and its sha256 digest: postgres:18-alpine/,
  );
});
