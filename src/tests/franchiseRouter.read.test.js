const request = require("supertest");
const app = require("../service");
const {
  bearer,
  registerDiner,
  createAdmin,
  createFranchisee,
  createStore,
} = require("./helpers.js");

let admin;
let franchisee;
let diner;
let franchise;
let store;

beforeAll(async () => {
  admin = await createAdmin();
  franchisee = await createFranchisee(admin);
  diner = await registerDiner();
  franchise = franchisee.franchise;
  store = await createStore(franchisee.token, franchise.id);
});

describe("GET /api/franchise", () => {
  test("unauthenticated user sees franchises and stores but not admin details", async () => {
    const res = await request(app)
      .get("/api/franchise")
      .query({ name: franchise.name });
    expect(res.status).toBe(200);
    expect(res.body.more).toBe(false);
    expect(res.body.franchises).toHaveLength(1);

    const found = res.body.franchises[0];
    expect(found.id).toBe(franchise.id);
    expect(found.stores).toEqual([{ id: store.id, name: store.name }]);
    expect(found.admins).toBeUndefined();
  });

  test("diner sees the same limited view", async () => {
    const res = await request(app)
      .get("/api/franchise")
      .query({ name: franchise.name })
      .set("Authorization", bearer(diner.token));
    expect(res.status).toBe(200);
    expect(res.body.franchises[0].admins).toBeUndefined();
    expect(res.body.franchises[0].stores[0].totalRevenue).toBeUndefined();
  });

  test("admin sees franchise admins and store revenue", async () => {
    const res = await request(app)
      .get("/api/franchise")
      .query({ name: franchise.name })
      .set("Authorization", bearer(admin.token));
    expect(res.status).toBe(200);

    const found = res.body.franchises[0];
    expect(found.admins).toHaveLength(1);
    expect(found.admins[0].email).toBe(franchisee.email);
    expect(found.stores[0]).toMatchObject({ id: store.id, totalRevenue: 0 });
  });

  test("name filter with a wildcard matches by prefix", async () => {
    const res = await request(app)
      .get("/api/franchise")
      .query({ name: `${franchise.name.slice(0, 5)}*` });
    expect(res.status).toBe(200);
    expect(res.body.franchises.some((f) => f.id === franchise.id)).toBe(true);
  });
});

describe("GET /api/franchise/:userId", () => {
  test("unauthenticated user is rejected", async () => {
    const res = await request(app).get(`/api/franchise/${franchisee.id}`);
    expect(res.status).toBe(401);
  });

  test("franchisee can see their own franchises", async () => {
    const res = await request(app)
      .get(`/api/franchise/${franchisee.id}`)
      .set("Authorization", bearer(franchisee.token));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(franchise.id);
    expect(res.body[0].stores[0].id).toBe(store.id);
    expect(res.body[0].admins[0].email).toBe(franchisee.email);
  });

  test("diner has no franchises of their own", async () => {
    const res = await request(app)
      .get(`/api/franchise/${diner.id}`)
      .set("Authorization", bearer(diner.token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test("diner cannot see another user's franchises", async () => {
    const res = await request(app)
      .get(`/api/franchise/${franchisee.id}`)
      .set("Authorization", bearer(diner.token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test("franchisee cannot see another franchisee's franchises", async () => {
    const other = await createFranchisee(admin);
    const res = await request(app)
      .get(`/api/franchise/${other.id}`)
      .set("Authorization", bearer(franchisee.token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test("admin can see any user's franchises", async () => {
    const res = await request(app)
      .get(`/api/franchise/${franchisee.id}`)
      .set("Authorization", bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(franchise.id);
  });
});
