import assert from "node:assert/strict";
import { test } from "node:test";
import { clientNetwork } from "../packages/backend/src/lib/client-network.ts";

test("client networks keep IPv4 and invalid input, group IPv6 /64 and normalize mapped IPv4", () => {
  for (const ip of ["192.0.2.7", "invalid-address", "2001:::1", "::ffff:999.2.3.4", ""]) assert.equal(clientNetwork(ip), ip);
  for (const ip of ["2001:db8:1:2::1", "2001:0DB8:0001:0002:ff:ff:ff:ff", "2001:db8:1:2::f%test"]) assert.equal(clientNetwork(ip), "2001:db8:1:2::/64");
  for (const ip of ["::ffff:192.0.2.7", "0:0:0:0:0:ffff:c000:0207", "::FFFF:c000:207", "::ffff:192.0.2.7%test"]) assert.equal(clientNetwork(ip), "192.0.2.7");
  assert.notEqual(clientNetwork("2001:db8:1:2::1"), clientNetwork("2001:db8:1:3::1"));
});
