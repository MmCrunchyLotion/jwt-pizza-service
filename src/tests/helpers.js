const request = require("supertest");
const app = require("../service");
const { Role, DB } = require("../database/database.js");

function randomName() {
  return Math.random().toString(36).substring(2, 12);
}

function bearer(token) {
  return `Bearer ${token}`;
}

function expectValidJwt(potentialJwt) {
  expect(potentialJwt).toMatch(
    /^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/,
  );
}

// Logs in an existing user and returns { ...user, password, token }.
async function loginUser(user) {
  const res = await request(app)
    .put("/api/auth")
    .send({ email: user.email, password: user.password });
  return { ...res.body.user, password: user.password, token: res.body.token };
}

// Standard user (someone who orders pizza).
async function registerDiner() {
  const user = {
    name: randomName(),
    email: `${randomName()}@test.com`,
    password: "diner",
  };
  const res = await request(app).post("/api/auth").send(user);
  return { ...res.body.user, password: user.password, token: res.body.token };
}

// Admin users can't be registered through the API, so insert directly.
async function createAdmin() {
  const user = {
    name: randomName(),
    password: "toomanysecrets",
    roles: [{ role: Role.Admin }],
  };
  user.email = `${user.name}@admin.com`;
  await DB.addUser(user);
  return loginUser(user);
}

// Creates a franchise as the given admin. Returns the franchise body.
async function createFranchise(admin, franchiseeEmails = []) {
  const res = await request(app)
    .post("/api/franchise")
    .set("Authorization", bearer(admin.token))
    .send({
      name: randomName(),
      admins: franchiseeEmails.map((email) => ({ email })),
    });
  return res.body;
}

// Creates a user who owns a brand new franchise. The user logs in again after
// the franchise is created so the token carries the franchisee role.
// Returns { ...user, token, franchise }.
async function createFranchisee(admin) {
  const diner = await registerDiner();
  const franchise = await createFranchise(admin, [diner.email]);
  const franchisee = await loginUser(diner);
  return { ...franchisee, franchise };
}

async function createStore(token, franchiseId) {
  const res = await request(app)
    .post(`/api/franchise/${franchiseId}/store`)
    .set("Authorization", bearer(token))
    .send({ franchiseId, name: randomName() });
  return res.body;
}

// Adds a menu item as the given admin and returns the new item.
async function createMenuItem(admin) {
  const title = randomName();
  const res = await request(app)
    .put("/api/order/menu")
    .set("Authorization", bearer(admin.token))
    .send({
      title,
      description: "test pizza",
      image: "pizza9.png",
      price: 0.05,
    });
  return res.body.find((item) => item.title === title);
}

module.exports = {
  randomName,
  bearer,
  expectValidJwt,
  loginUser,
  registerDiner,
  createAdmin,
  createFranchise,
  createFranchisee,
  createStore,
  createMenuItem,
};
