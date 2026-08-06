import assert from "node:assert/strict";
import test from "node:test";

import { cookieStore } from "../dist/index.js";

test("cookieStore reads cookie names containing regular-expression characters", async (t) => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  t.after(() => {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
  });

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "other=value; app.token=access%20token" },
  });

  assert.equal(await cookieStore("app.token").get(), "access token");
});
