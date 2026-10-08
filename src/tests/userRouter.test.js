const request = require("supertest");
const app = require("../service");
const {
  randomName,
  bearer,
  expectValidJwt,
  loginUser,
  registerDiner,
  createAdmin,
  createFranchisee,
} = require("./helpers.js");

let admin;
let franchisee;
let diner;
let users;

beforeAll(async () => {
  admin = await createAdmin();
  franchisee = await createFranchisee(admin);
  diner = await registerDiner();
  users = { diner, franchisee, admin };
});

describe("GET /api/user/me", () => {
  test.each(["diner", "franchisee", "admin"])(
    "%s can get their own user",
    async (who) => {
      const res = await request(app)
        .get("/api/user/me")
        .set("Authorization", bearer(users[who].token));
      expect(res.status).toBe(200);
      expect(res.body.email).toBe(users[who].email);
      expect(res.body.roles.map((r) => r.role)).toContain(who);
    },
  );

  test("unauthenticated request is rejected", async () => {
    const res = await request(app).get("/api/user/me");
    expect(res.status).toBe(401);
  });
});

describe("PUT /api/user/:userId", () => {
  test("user can update their own account and log in with the new password", async () => {
    const user = await registerDiner();
    const update = {
      name: randomName(),
      email: `${randomName()}@test.com`,
      password: "newpassword",
    };

    const res = await request(app)
      .put(`/api/user/${user.id}`)
      .set("Authorization", bearer(user.token))
      .send(update);
    expect(res.status).toBe(200);
    expectValidJwt(res.body.token);
    expect(res.body.user.name).toBe(update.name);
    expect(res.body.user.email).toBe(update.email);

    const login = await loginUser({ ...update });
    expect(login.token).toBeDefined();
    expect(login.id).toBe(user.id);
  });

  test("diner cannot update another user", async () => {
    const other = await registerDiner();
    const res = await request(app)
      .put(`/api/user/${other.id}`)
      .set("Authorization", bearer(diner.token))
      .send({ name: "hacked", email: other.email, password: other.password });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("unauthorized");
  });

  test("franchisee cannot update another user", async () => {
    const other = await registerDiner();
    const res = await request(app)
      .put(`/api/user/${other.id}`)
      .set("Authorization", bearer(franchisee.token))
      .send({ name: "hacked", email: other.email, password: other.password });
    expect(res.status).toBe(403);
  });

  test("admin can update another user", async () => {
    const other = await registerDiner();
    const newName = randomName();
    const res = await request(app)
      .put(`/api/user/${other.id}`)
      .set("Authorization", bearer(admin.token))
      .send({ name: newName, email: other.email, password: other.password });
    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe(newName);
  });

  test("unauthenticated request is rejected", async () => {
    const res = await request(app)
      .put(`/api/user/${diner.id}`)
      .send({ name: "x", email: diner.email, password: diner.password });
    expect(res.status).toBe(401);
  });
});

describe("unimplemented endpoints", () => {
  test.each(["diner", "franchisee", "admin"])(
    "%s gets the not implemented response for delete and list",
    async (who) => {
      const del = await request(app)
        .delete(`/api/user/${users[who].id}`)
        .set("Authorization", bearer(users[who].token));
      expect(del.status).toBe(200);
      expect(del.body.message).toBe("not implemented");

      const list = await request(app)
        .get("/api/user")
        .set("Authorization", bearer(users[who].token));
      expect(list.status).toBe(200);
      expect(list.body).toEqual({
        message: "not implemented",
        users: [],
        more: false,
      });
    },
  );

  test("unauthenticated requests are rejected", async () => {
    expect((await request(app).delete(`/api/user/${diner.id}`)).status).toBe(401);
    expect((await request(app).get("/api/user")).status).toBe(401);
  });
});
