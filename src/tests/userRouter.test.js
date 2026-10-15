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

// Registers a diner with a specific name so list/filter tests can find it.
async function registerNamedDiner(name) {
  const testUser = {
    name,
    email: `${randomName()}@test.com`,
    password: "a",
  };
  const res = await request(app).post("/api/auth").send(testUser);
  expect(res.status).toBe(200);
  return {
    ...res.body.user,
    password: testUser.password,
    token: res.body.token,
  };
}

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

describe("GET /api/user (list users)", () => {
  const prefix = randomName();
  let created;

  beforeAll(async () => {
    created = [];
    for (let i = 0; i < 3; i++) {
      created.push(await registerNamedDiner(`${prefix}-${i}`));
    }
  });

  const list = (query, token = admin.token) =>
    request(app).get(`/api/user${query}`).set("Authorization", bearer(token));

  test("unauthenticated request is rejected", async () => {
    const res = await request(app).get("/api/user");
    expect(res.status).toBe(401);
  });

  test.each(["diner", "franchisee"])("%s is forbidden", async (who) => {
    const res = await list("", users[who].token);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("unauthorized");
  });

  test("admin gets users with roles and without passwords", async () => {
    const res = await list(`?page=0&limit=10&name=${prefix}*`);
    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(3);
    expect(res.body.more).toBe(false);
    for (const user of res.body.users) {
      expect(user.id).toBeDefined();
      expect(user.email).toBeDefined();
      expect(user.password).toBeUndefined();
      expect(user.roles.map((r) => r.role)).toEqual(["diner"]);
    }
  });

  test("admin can list with default paging and filter", async () => {
    const res = await list("");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.users)).toBe(true);
    expect(typeof res.body.more).toBe("boolean");
  });

  test("pagination splits results and sets the more flag", async () => {
    const page0 = await list(`?page=0&limit=2&name=${prefix}*`);
    expect(page0.status).toBe(200);
    expect(page0.body.users).toHaveLength(2);
    expect(page0.body.more).toBe(true);

    const page1 = await list(`?page=1&limit=2&name=${prefix}*`);
    expect(page1.body.users).toHaveLength(1);
    expect(page1.body.more).toBe(false);

    const seen = [...page0.body.users, ...page1.body.users].map((u) => u.id);
    expect(new Set(seen).size).toBe(3);
  });

  test("name filter returns only matching users", async () => {
    const res = await list(`?name=${prefix}-1`);
    expect(res.status).toBe(200);
    expect(res.body.users.map((u) => u.name)).toEqual([`${prefix}-1`]);
  });

  test("filter with no matches returns an empty list", async () => {
    const res = await list(`?name=${randomName()}${randomName()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ users: [], more: false });
  });

  test("invalid paging values fall back to defaults", async () => {
    const res = await list(`?page=-5&limit=abc&name=${prefix}*`);
    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(3);
  });
});

describe("DELETE /api/user/:userId (not yet implemented)", () => {
  test.each(["diner", "franchisee", "admin"])(
    "%s gets the not implemented response",
    async (who) => {
      const res = await request(app)
        .delete(`/api/user/${users[who].id}`)
        .set("Authorization", bearer(users[who].token));
      expect(res.status).toBe(200);
      expect(res.body.message).toBe("not implemented");
    },
  );

  test("unauthenticated request is rejected", async () => {
    const res = await request(app).delete(`/api/user/${diner.id}`);
    expect(res.status).toBe(401);
  });
});
