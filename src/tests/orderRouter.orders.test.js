const request = require("supertest");
const app = require("../service");
const config = require("../config.js");
const {
  bearer,
  registerDiner,
  createAdmin,
  createFranchisee,
  createStore,
  createMenuItem,
} = require("./helpers.js");

let admin;
let users;
let franchise;
let store;
let menuItem;

function orderBody() {
  return {
    franchiseId: franchise.id,
    storeId: store.id,
    items: [{ menuId: menuItem.id, description: menuItem.title, price: 0.05 }],
  };
}

function mockFactory({ ok, body }) {
  return jest
    .spyOn(global, "fetch")
    .mockResolvedValue({ ok, json: async () => body });
}

beforeAll(async () => {
  admin = await createAdmin();
  const franchisee = await createFranchisee(admin);
  const diner = await registerDiner();
  users = { diner, franchisee, admin };

  franchise = franchisee.franchise;
  store = await createStore(franchisee.token, franchise.id);
  menuItem = await createMenuItem(admin);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("GET /api/order", () => {
  test("unauthenticated user cannot see orders", async () => {
    const res = await request(app).get("/api/order");
    expect(res.status).toBe(401);
  });

  test.each(["diner", "franchisee", "admin"])(
    "%s starts with an empty order history",
    async (who) => {
      const res = await request(app)
        .get("/api/order")
        .set("Authorization", bearer(users[who].token));
      expect(res.status).toBe(200);
      expect(res.body.dinerId).toBe(users[who].id);
      expect(res.body.orders).toEqual([]);
      expect(res.body.page).toBe(1);
    },
  );
});

describe("POST /api/order", () => {
  test("unauthenticated user cannot order", async () => {
    const fetchSpy = mockFactory({ ok: true, body: {} });
    const res = await request(app).post("/api/order").send(orderBody());
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test.each(["diner", "franchisee", "admin"])(
    "%s can order a pizza and sees it in their history",
    async (who) => {
      const fetchSpy = mockFactory({
        ok: true,
        body: { jwt: "factory.jwt.token", reportUrl: "http://report.test" },
      });

      const res = await request(app)
        .post("/api/order")
        .set("Authorization", bearer(users[who].token))
        .send(orderBody());
      expect(res.status).toBe(200);
      expect(res.body.jwt).toBe("factory.jwt.token");
      expect(res.body.followLinkToEndChaos).toBe("http://report.test");
      expect(res.body.order.id).toBeDefined();

      expect(fetchSpy).toHaveBeenCalledWith(
        `${config.factory.url}/api/order`,
        expect.objectContaining({ method: "POST" }),
      );

      const history = await request(app)
        .get("/api/order")
        .set("Authorization", bearer(users[who].token));
      expect(history.status).toBe(200);
      const saved = history.body.orders.find((o) => o.id === res.body.order.id);
      expect(saved).toBeDefined();
      expect(saved.items).toHaveLength(1);
      expect(saved.items[0].menuId).toBe(menuItem.id);
    },
  );

  test("returns 500 when the factory fails to fulfill the order", async () => {
    mockFactory({ ok: false, body: { reportUrl: "http://report.test" } });

    const res = await request(app)
      .post("/api/order")
      .set("Authorization", bearer(users.diner.token))
      .send(orderBody());
    expect(res.status).toBe(500);
    expect(res.body.message).toBe("Failed to fulfill order at factory");
    expect(res.body.followLinkToEndChaos).toBe("http://report.test");
  });

  test("users only see their own orders", async () => {
    mockFactory({ ok: true, body: { jwt: "a.b.c", reportUrl: "http://r" } });
    const other = await registerDiner();
    const otherOrder = await request(app)
      .post("/api/order")
      .set("Authorization", bearer(other.token))
      .send(orderBody());

    const res = await request(app)
      .get("/api/order")
      .set("Authorization", bearer(users.admin.token));
    expect(res.body.dinerId).toBe(users.admin.id);
    expect(res.body.orders.some((o) => o.id === otherOrder.body.order.id)).toBe(
      false,
    );
  });
});
