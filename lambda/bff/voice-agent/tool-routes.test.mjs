// Every webhook tool the prompt builder gives an agent must have an API
// Gateway route, or Retell gets a 404 on every call. The service-area check
// shipped without one, so callers asking "do you serve Gaithersburg?" got
// "I couldn't verify coverage".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const toolsSource = readFileSync(new URL("./tools.mjs", import.meta.url), "utf8");
const routesSource = readFileSync(new URL("../../../lambda_tools.tf", import.meta.url), "utf8");

test("every /retell/tools path the prompt builder registers has an API Gateway route", () => {
  const paths = [...new Set([...toolsSource.matchAll(/["'`](\/retell\/tools\/[A-Za-z.-]+)["'`]/g)].map((match) => match[1]))];
  assert.ok(paths.length >= 5, "found the registered tool paths");
  const routes = new Set([...routesSource.matchAll(/"POST (\/retell\/tools\/[A-Za-z.-]+)"/g)].map((match) => match[1]));
  const missing = paths.filter((path) => !routes.has(path));
  assert.deepEqual(missing, [], `lambda_tools.tf retell_tool_routes is missing: ${missing.join(", ")}`);
});
