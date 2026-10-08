const request = require("supertest");
const app = require("../service");
const {
  randomName,
  bearer,
  registerDiner,
  createAdmin,
  createFranchisee,
  createStore,
} = require("./helpers.js");

let admin;
let franchisee;
let otherFranchisee;
let diner;
let franchise;

beforeAll(async () => {
  admin = await createAdmin();
  franchisee = await createFranchisee(admin);
  otherFranchisee = await createFranchisee(admin);
  diner = await registerDiner();
  franchise = franchisee.franchise;
});

function postStore(token, franchiseId = franchise.id) {
  const req = request(app).post(`/api/franchise/${franchiseId}/store`);
  if (token) req.set("Authorization", bearer(token));
  return req.send({ franchiseId, name: randomName() });
}

function deleteStore(token, storeId, franchiseId = franchise.id) {
  const req = request(app).delete(
    `/api/franchise/${franchiseId}/store/${storeId}`,
  );
  if (token) req.set("Authorization", bearer(token));
  return req;
}

describe("POST /api/franchise/:franchiseId/store", () => {
  test("franchisee can create a store in their own franchise", async () => {
    const res = await postStore(franchisee.token);
    expect(res.status).toBe(200);
    expect(res.body.franchiseId).toBe(franchise.id);
    expect(res.body.id).toBeDefined();
    expect(res.body.name).toBeDefined();
  });

  test("admin can create a store in any franchise", async () => {
    const res = await postStore(admin.token);
    expect(res.status).toBe(200);
    expect(res.body.franchiseId).toBe(franchise.id);
  });

  test("diner cannot create a store", async () => {
    const res = await postStore(diner.token);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("unable to create a store");
  });

  test("franchisee cannot create a store in someone else's franchise", async () => {
    const res = await postStore(otherFranchisee.token);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("unable to create a store");
  });

  test("unauthenticated user cannot create a store", async () => {
    const res = await postStore(null);
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/franchise/:franchiseId/store/:storeId", () => {
  test("franchisee can delete a store in their own franchise", async () => {
    const store = await createStore(franchisee.token, franchise.id);
    const res = await deleteStore(franchisee.token, store.id);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("store deleted");

    const list = await request(app)
      .get("/api/franchise")
      .query({ name: franchise.name });
    expect(list.body.franchises[0].stores.some((s) => s.id === store.id)).toBe(
      false,
    );
  });

  test("admin can delete any store", async () => {
    const store = await createStore(franchisee.token, franchise.id);
    const res = await deleteStore(admin.token, store.id);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("store deleted");
  });

  test("diner cannot delete a store", async () => {
    const store = await createStore(franchisee.token, franchise.id);
    const res = await deleteStore(diner.token, store.id);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("unable to delete a store");
  });

  test("franchisee cannot delete a store in someone else's franchise", async () => {
    const store = await createStore(franchisee.token, franchise.id);
    const res = await deleteStore(otherFranchisee.token, store.id);
    expect(res.status).toBe(403);
  });

  test("unauthenticated user cannot delete a store", async () => {
    const store = await createStore(franchisee.token, franchise.id);
    const res = await deleteStore(null, store.id);
    expect(res.status).toBe(401);
  });
});
