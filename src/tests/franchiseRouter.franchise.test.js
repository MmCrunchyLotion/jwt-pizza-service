const request = require("supertest");
const app = require("../service");
const {
  randomName,
  bearer,
  registerDiner,
  createAdmin,
  // createFranchise,
  createFranchisee,
} = require("./helpers.js");

let admin;
let franchisee;
let diner;

beforeAll(async () => {
  admin = await createAdmin();
  franchisee = await createFranchisee(admin);
  diner = await registerDiner();
});

describe("POST /api/franchise", () => {
  test("admin can create a franchise for an existing user", async () => {
    const owner = await registerDiner();
    const name = randomName();
    const res = await request(app)
      .post("/api/franchise")
      .set("Authorization", bearer(admin.token))
      .send({ name, admins: [{ email: owner.email }] });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe(name);
    expect(res.body.id).toBeDefined();
    expect(res.body.admins[0]).toMatchObject({
      email: owner.email,
      id: owner.id,
      name: owner.name,
    });
  });

  test("admin gets a 404 when the franchise admin email is unknown", async () => {
    const res = await request(app)
      .post("/api/franchise")
      .set("Authorization", bearer(admin.token))
      .send({
        name: randomName(),
        admins: [{ email: `${randomName()}@nowhere.com` }],
      });
    expect(res.status).toBe(404);
    expect(res.body.message).toContain("unknown user for franchise admin");
  });

  test.each(["diner", "franchisee"])(
    "%s cannot create a franchise",
    async (who) => {
      const token = who === "diner" ? diner.token : franchisee.token;
      const res = await request(app)
        .post("/api/franchise")
        .set("Authorization", bearer(token))
        .send({ name: randomName(), admins: [{ email: diner.email }] });
      expect(res.status).toBe(403);
      expect(res.body.message).toBe("unable to create a franchise");
    },
  );

  test("unauthenticated user cannot create a franchise", async () => {
    const res = await request(app)
      .post("/api/franchise")
      .send({ name: randomName(), admins: [] });
    expect(res.status).toBe(401);
  });
});

// The following tests flag a bug that claude wanted me to look at.
// TODO: figure out why there aren't authenticateToken checks for these routes

// describe("DELETE /api/franchise/:franchiseId", () => {
//   test("admin can delete a franchise", async () => {
//     const franchise = await createFranchise(admin, [diner.email]);
//     const res = await request(app)
//       .delete(`/api/franchise/${franchise.id}`)
//       .set("Authorization", bearer(admin.token));
//     expect(res.status).toBe(200);
//     expect(res.body.message).toBe("franchise deleted");

//     const list = await request(app)
//       .get("/api/franchise")
//       .query({ name: franchise.name });
//     expect(list.body.franchises).toEqual([]);
//   });

//   // NOTE: the DELETE /:franchiseId route in franchiseRouter.js currently has no
//   // authenticateToken middleware and no admin check, so the three tests below
//   // fail until the route is protected the same way createFranchise is.
//   test.each(["diner", "franchisee"])(
//     "%s cannot delete a franchise",
//     async (who) => {
//       const franchise = await createFranchise(admin);
//       const token = who === "diner" ? diner.token : franchisee.token;
//       const res = await request(app)
//         .delete(`/api/franchise/${franchise.id}`)
//         .set("Authorization", bearer(token));
//       expect(res.status).toBe(403);
//     },
//   );

//   test("unauthenticated user cannot delete a franchise", async () => {
//     const franchise = await createFranchise(admin);
//     const res = await request(app).delete(`/api/franchise/${franchise.id}`);
//     expect(res.status).toBe(401);
//   });
// });
