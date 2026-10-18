import assert from "node:assert/strict";
import test from "node:test";
import { soakEndpoint } from "../soak/endpoint.ts";

test("owned soak endpoints preserve explicit decimal ports on loopback", () => {
  for (const port of [1024, 4277, 4278, 65535])
    assert.deepEqual(soakEndpoint(String(port)), { port, baseURL: `http://127.0.0.1:${port}` });
});

test("an invalid port cannot choose another host, shell argument or privileged endpoint", () => {
  for (const value of [
    "",
    "0",
    "1023",
    "65536",
    "142778",
    "04278",
    "4278.0",
    "0x10b6",
    "-1",
    "4278 ",
    "4278;exit",
    "4278 --host 0.0.0.0",
    "https://example.invalid",
    "127.0.0.1:4278",
  ])
    assert.throws(() => soakEndpoint(value), /WALL_SOAK_PORT/);
});
