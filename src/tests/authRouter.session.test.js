const request = require("supertest");
const app = require("../service");
const {
  randomName,
  bearer,
  expectValidJwt,
  registerDiner,
} = require("./helpers.js");

describe("register", () => {
  test("creates a diner and returns a token", async () => {
    const user = {
      name: randomName(),
      email: `${randomName()}@test.com`,
      password: "a",
    };
    const res = await request(app).post("/api/auth").send(user);
    expect(res.status).toBe(200);
    expectValidJwt(res.body.token);
    expect(res.body.user.email).toBe(user.email);
    expect(res.body.user.roles).toEqual([{ role: "diner" }]);
    expect(res.body.user.password).toBeUndefined();
  });

  test.each([
    { name: "", email: "a@test.com", password: "a" },
    { name: "a", email: "", password: "a" },
    { name: "a", email: "a@test.com", password: "" },
    {},
  ])("rejects missing fields: %j", async (body) => {
    const res = await request(app).post("/api/auth").send(body);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("name, email, and password are required");
  });
});

describe("login", () => {
  test("wrong password is rejected", async () => {
    const diner = await registerDiner();
    const res = await request(app)
      .put("/api/auth")
      .send({ email: diner.email, password: "wrong" });
    expect(res.status).toBe(404);
    expect(res.body.message).toBe("unknown user");
  });

  test("unknown email is rejected", async () => {
    const res = await request(app)
      .put("/api/auth")
      .send({ email: `${randomName()}@nowhere.com`, password: "a" });
    expect(res.status).toBe(404);
  });
});

describe("logout", () => {
  test("logged in user can log out and the token stops working", async () => {
    const diner = await registerDiner();

    const meBefore = await request(app)
      .get("/api/user/me")
      .set("Authorization", bearer(diner.token));
    expect(meBefore.status).toBe(200);

    const logoutRes = await request(app)
      .delete("/api/auth")
      .set("Authorization", bearer(diner.token));
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body.message).toBe("logout successful");

    const meAfter = await request(app)
      .get("/api/user/me")
      .set("Authorization", bearer(diner.token));
    expect(meAfter.status).toBe(401);
  });

  test("cannot log out without a token", async () => {
    const res = await request(app).delete("/api/auth");
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("unauthorized");
  });
});

describe("token validation", () => {
  test("garbage token is treated as unauthenticated", async () => {
    const res = await request(app)
      .get("/api/user/me")
      .set("Authorization", bearer("not-a-real-token"));
    expect(res.status).toBe(401);
  });

  test("tampered token with a known signature is rejected", async () => {
    const diner = await registerDiner();
    const signature = diner.token.split(".")[2];
    const forged = `forgedheader.forgedpayload.${signature}`;
    const res = await request(app)
      .get("/api/user/me")
      .set("Authorization", bearer(forged));
    expect(res.status).toBe(401);
  });
});
