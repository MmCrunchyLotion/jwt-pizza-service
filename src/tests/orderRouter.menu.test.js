const request = require("supertest");
const app = require("../service");
const {
  randomName,
  bearer,
  registerDiner,
  createAdmin,
  createFranchisee,
  createMenuItem,
} = require("./helpers.js");

let admin;
let franchisee;
let diner;

beforeAll(async () => {
  admin = await createAdmin();
  franchisee = await createFranchisee(admin);
  diner = await registerDiner();
});

describe("GET /api/order/menu", () => {
  test("anyone can read the menu, even without logging in", async () => {
    const item = await createMenuItem(admin);

    const res = await request(app).get("/api/order/menu");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((m) => m.id === item.id)).toBe(true);
  });
});

describe("PUT /api/order/menu", () => {
  test("admin can add a menu item", async () => {
    const title = randomName();
    const res = await request(app)
      .put("/api/order/menu")
      .set("Authorization", bearer(admin.token))
      .send({
        title,
        description: "admin pizza",
        image: "pizza9.png",
        price: 0.0001,
      });
    expect(res.status).toBe(200);
    expect(res.body.find((m) => m.title === title)).toMatchObject({
      description: "admin pizza",
      image: "pizza9.png",
    });
  });

  test.each(["diner", "franchisee"])(
    "%s cannot add a menu item",
    async (who) => {
      const token = who === "diner" ? diner.token : franchisee.token;
      const res = await request(app)
        .put("/api/order/menu")
        .set("Authorization", bearer(token))
        .send({
          title: randomName(),
          description: "nope",
          image: "pizza9.png",
          price: 0.0001,
        });
      expect(res.status).toBe(403);
      expect(res.body.message).toBe("unable to add menu item");
    },
  );

  test("unauthenticated user cannot add a menu item", async () => {
    const res = await request(app)
      .put("/api/order/menu")
      .send({
        title: randomName(),
        description: "nope",
        image: "pizza9.png",
        price: 0.0001,
      });
    expect(res.status).toBe(401);
  });
});
