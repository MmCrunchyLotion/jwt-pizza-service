const request = require("supertest");
const app = require("../service");

test("welcome message", async () => {
  const res = await request(app).get("/");
  expect(res.status).toBe(200);
  expect(res.body.message).toBe("welcome to JWT Pizza");
  expect(res.body.version).toBeDefined();
});

test("docs lists every endpoint", async () => {
  const res = await request(app).get("/api/docs");
  expect(res.status).toBe(200);
  expect(res.body.version).toBeDefined();
  expect(res.body.endpoints.length).toBeGreaterThan(0);
  expect(res.body.config.factory).toBeDefined();
});

test("unknown endpoint returns 404", async () => {
  const res = await request(app).get("/api/does-not-exist");
  expect(res.status).toBe(404);
  expect(res.body.message).toBe("unknown endpoint");
});

test("errors are handled by the default error handler", async () => {
  const res = await request(app)
    .put("/api/auth")
    .send({ email: "nobody@nowhere.com", password: "nope" });
  expect(res.status).toBe(404);
  expect(res.body.message).toBe("unknown user");
  expect(res.body.stack).toBeDefined();
});

test("CORS headers are set", async () => {
  const res = await request(app).get("/").set("Origin", "http://localhost:5173");
  expect(res.headers["access-control-allow-origin"]).toBe(
    "http://localhost:5173",
  );
  expect(res.headers["access-control-allow-methods"]).toContain("DELETE");
});
