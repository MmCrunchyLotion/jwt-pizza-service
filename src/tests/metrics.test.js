const os = require("os");
const express = require("express");
const request = require("supertest");
const config = require("../config.js");

// The order router talks to the database; these tests only care about the metrics it records.
jest.mock("../database/database.js", () => ({
  Role: { Admin: "admin", Diner: "diner", Franchisee: "franchisee" },
  DB: {
    addDinerOrder: jest.fn(async (user, order) => ({ ...order, id: 1 })),
  },
}));

const metrics = require("../metrics.js");
const { Metrics } = metrics;
const orderRouter = require("../routes/orderRouter.js");

const metricsOf = (payload) =>
  payload.resourceMetrics[0].scopeMetrics[0].metrics;
const find = (payload, name) => metricsOf(payload).find((m) => m.name === name);
const points = (payload, name) => {
  const metric = find(payload, name);
  return (metric.sum ?? metric.gauge).dataPoints;
};
const value = (point) => Number(point.asInt ?? point.asDouble);
const withAttr = (pts, key, expected) =>
  pts.find((p) =>
    p.attributes.some((a) => a.key === key && a.value.stringValue === expected),
  );
const single = (payload, name) => value(points(payload, name)[0]);

let originalMetricsConfig;
beforeEach(() => {
  originalMetricsConfig = config.metrics;
  config.metrics = {
    source: "jwt-pizza-service-test",
    endpointUrl: "http://otlp.test/v1/metrics",
    accountId: "123",
    apiKey: "glc_abc",
  };
});

afterEach(() => {
  config.metrics = originalMetricsConfig;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

// Mirrors how service.js installs the tracker: first, before the user is known.
function makeApp(m) {
  const app = express();
  app.use(express.json());
  app.use(m.requestTracker);
  app.use((req, res, next) => {
    if (req.headers["x-user"]) req.user = { id: Number(req.headers["x-user"]) };
    next();
  });
  app.put("/api/auth", (req, res) => {
    if (req.body.password === "good") {
      return res.json({ user: { id: 7 }, token: "t" });
    }
    res.status(404).json({ message: "unknown user" });
  });
  app.post("/api/auth", (req, res) => {
    if (!req.body.name) return res.status(400).json({ message: "required" });
    res.json({ user: { id: 8 }, token: "t" });
  });
  app.delete("/api/auth", (req, res) =>
    res.json({ message: "logout successful" }),
  );
  app.all("/api/order/menu", (req, res) => res.json([]));
  return app;
}

describe("request tracking", () => {
  test("counts requests by method, including all four main methods at zero", () => {
    const payload = new Metrics().buildPayload();
    const pts = points(payload, "http_requests_total");
    for (const method of ["GET", "PUT", "POST", "DELETE"]) {
      expect(value(withAttr(pts, "method", method))).toBe(0);
    }
  });

  test("counts each request under its method", async () => {
    const m = new Metrics();
    const app = makeApp(m);
    await request(app).get("/api/order/menu");
    await request(app).get("/api/order/menu");
    await request(app).post("/api/order/menu").send({});
    await request(app).put("/api/order/menu").send({});
    await request(app).delete("/api/order/menu");
    await request(app).patch("/api/order/menu").send({});

    const pts = points(m.buildPayload(), "http_requests_total");
    expect(value(withAttr(pts, "method", "GET"))).toBe(2);
    expect(value(withAttr(pts, "method", "POST"))).toBe(1);
    expect(value(withAttr(pts, "method", "PUT"))).toBe(1);
    expect(value(withAttr(pts, "method", "DELETE"))).toBe(1);
    expect(value(withAttr(pts, "method", "PATCH"))).toBe(1);
  });

  test("averages endpoint latency per period and then resets", () => {
    const m = new Metrics();
    m.recordRequest("GET", 10);
    m.recordRequest("GET", 30);
    expect(single(m.buildPayload(), "latency_endpoint_ms")).toBe(20);
    expect(find(m.buildPayload(), "latency_endpoint_ms")).toBeUndefined();
  });

  test("measures real latency for real requests", async () => {
    const m = new Metrics();
    await request(makeApp(m)).get("/api/order/menu");
    expect(single(m.buildPayload(), "latency_endpoint_ms")).toBeGreaterThan(0);
  });
});

describe("authentication attempts", () => {
  test("counts successful and failed logins", async () => {
    const m = new Metrics();
    const app = makeApp(m);
    await request(app).put("/api/auth").send({ password: "good" });
    await request(app).put("/api/auth").send({ password: "good" });
    await request(app).put("/api/auth").send({ password: "bad" });

    const pts = points(m.buildPayload(), "auth_attempts_total");
    expect(value(withAttr(pts, "result", "success"))).toBe(2);
    expect(value(withAttr(pts, "result", "failure"))).toBe(1);
  });

  test("counts registrations as attempts too", async () => {
    const m = new Metrics();
    const app = makeApp(m);
    await request(app).post("/api/auth").send({ name: "n" });
    await request(app).post("/api/auth").send({});

    const pts = points(m.buildPayload(), "auth_attempts_total");
    expect(value(withAttr(pts, "result", "success"))).toBe(1);
    expect(value(withAttr(pts, "result", "failure"))).toBe(1);
  });

  test("a query string or trailing slash is still the auth endpoint", async () => {
    const m = new Metrics();
    const app = makeApp(m);
    await request(app).put("/api/auth/?x=1").send({ password: "good" });
    expect(m.auth.success).toBe(1);
  });

  test("logout is not an authentication attempt", async () => {
    const m = new Metrics();
    await request(makeApp(m)).delete("/api/auth").set("x-user", "7");
    expect(m.auth).toEqual({ success: 0, failure: 0 });
  });
});

describe("active users", () => {
  test("login adds the user, other requests add the caller, logout removes", async () => {
    const m = new Metrics();
    const app = makeApp(m);
    await request(app).put("/api/auth").send({ password: "good" });
    expect(single(m.buildPayload(), "active_users")).toBe(1);

    await request(app).get("/api/order/menu").set("x-user", "9");
    expect(single(m.buildPayload(), "active_users")).toBe(2);

    await request(app).delete("/api/auth").set("x-user", "7");
    expect(single(m.buildPayload(), "active_users")).toBe(1);
  });

  test("failed logins and anonymous requests do not count", async () => {
    const m = new Metrics();
    const app = makeApp(m);
    await request(app).put("/api/auth").send({ password: "bad" });
    await request(app).get("/api/order/menu");
    expect(m.activeUserCount()).toBe(0);
  });

  test("users go inactive after the idle window", () => {
    const m = new Metrics();
    m.touchUser(1);
    const fiveMinutes = 5 * 60 * 1000;
    expect(m.activeUserCount(Date.now() + fiveMinutes - 1000)).toBe(1);
    expect(m.activeUserCount(Date.now() + fiveMinutes + 1000)).toBe(0);
  });

  test("ignores a missing user id and an unreadable login response", async () => {
    const m = new Metrics();
    m.touchUser(undefined);
    m.touchUser(null);

    const app = express();
    app.use(m.requestTracker);
    app.put("/api/auth", (req, res) => res.send("not json"));
    await request(app).put("/api/auth");

    expect(m.activeUserCount()).toBe(0);
    expect(m.auth.success).toBe(1);
  });
});

describe("pizza purchases", () => {
  test("tracks sold pizzas, revenue and latency for successes", () => {
    const m = new Metrics();
    m.pizzaPurchase(true, 100, 0.0076, 2);
    m.pizzaPurchase(true, 300, 0.0038);

    const payload = m.buildPayload();
    expect(single(payload, "pizzas_sold_total")).toBe(3);
    expect(single(payload, "pizza_revenue_total")).toBeCloseTo(0.0114, 8);
    expect(single(payload, "pizza_creation_failures_total")).toBe(0);
    expect(single(payload, "latency_pizza_creation_ms")).toBe(200);
  });

  test("tracks failures without revenue", () => {
    const m = new Metrics();
    m.pizzaPurchase(false, 1500, 0, 21);

    const payload = m.buildPayload();
    expect(single(payload, "pizza_creation_failures_total")).toBe(21);
    expect(single(payload, "pizzas_sold_total")).toBe(0);
    expect(single(payload, "pizza_revenue_total")).toBe(0);
    expect(single(payload, "latency_pizza_creation_ms")).toBe(1500);
  });

  test("pizza latency is only reported when there was a purchase", () => {
    expect(
      find(new Metrics().buildPayload(), "latency_pizza_creation_ms"),
    ).toBeUndefined();
  });
});

describe("order router integration", () => {
  const order = {
    franchiseId: 1,
    storeId: 1,
    items: [
      { menuId: 1, description: "Veggie", price: 0.1 },
      { menuId: 2, description: "Pepperoni", price: 0.2 },
    ],
  };
  let app;

  beforeEach(() => {
    // The order router uses the shared instance, so start it from a clean slate.
    const fresh = new Metrics();
    for (const key of [
      "requests",
      "auth",
      "pizzas",
      "activeUsers",
      "endpointLatency",
      "pizzaLatency",
    ]) {
      metrics[key] = fresh[key];
    }

    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { id: 5, name: "n", email: "e@jwt.com" };
      next();
    });
    app.use("/api/order", orderRouter);
    app.use((err, req, res, next) => {
      res.status(500).json({ message: err.message });
      next();
    });
  });

  test("a fulfilled order records pizzas, revenue and latency", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ jwt: "j", reportUrl: "http://report" }),
    });

    const res = await request(app).post("/api/order").send(order);

    expect(res.status).toBe(200);
    expect(metrics.pizzas.sold).toBe(2);
    expect(metrics.pizzas.revenue).toBeCloseTo(0.3, 8);
    expect(metrics.pizzas.failures).toBe(0);
    expect(metrics.pizzaLatency.count).toBe(1);
  });

  test("a factory failure records failed pizzas and no revenue", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      json: async () => ({ reportUrl: "http://report" }),
    });

    const res = await request(app).post("/api/order").send(order);

    expect(res.status).toBe(500);
    expect(metrics.pizzas.failures).toBe(2);
    expect(metrics.pizzas.sold).toBe(0);
    expect(metrics.pizzas.revenue).toBe(0);
    expect(metrics.pizzaLatency.count).toBe(1);
  });

  test("an unreachable factory is recorded as a failure and still errors", async () => {
    jest.spyOn(global, "fetch").mockRejectedValue(new Error("factory down"));

    const res = await request(app).post("/api/order").send(order);

    expect(res.status).toBe(500);
    expect(res.body.message).toBe("factory down");
    expect(metrics.pizzas.failures).toBe(2);
    expect(metrics.pizzaLatency.count).toBe(1);
  });
});

describe("system metrics", () => {
  test("reports CPU and memory as percentages", () => {
    jest.spyOn(os, "loadavg").mockReturnValue([2, 0, 0]);
    jest.spyOn(os, "cpus").mockReturnValue([{}, {}, {}, {}]);
    jest.spyOn(os, "totalmem").mockReturnValue(1000);
    jest.spyOn(os, "freemem").mockReturnValue(250);

    const payload = new Metrics().buildPayload();
    expect(single(payload, "cpu_usage_percent")).toBe(50);
    expect(single(payload, "memory_usage_percent")).toBe(75);
  });

  test("does not divide by zero when the CPU count is unknown", () => {
    jest.spyOn(os, "loadavg").mockReturnValue([0.5, 0, 0]);
    jest.spyOn(os, "cpus").mockReturnValue([]);
    expect(new Metrics().getCpuUsagePercentage()).toBe(50);
  });
});

describe("OTLP payload", () => {
  test("has every required metric with the right types", () => {
    const payload = new Metrics().buildPayload(1700000000000);
    const names = metricsOf(payload).map((m) => m.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "http_requests_total",
        "auth_attempts_total",
        "active_users",
        "cpu_usage_percent",
        "memory_usage_percent",
        "pizzas_sold_total",
        "pizza_creation_failures_total",
        "pizza_revenue_total",
      ]),
    );

    for (const name of [
      "http_requests_total",
      "auth_attempts_total",
      "pizzas_sold_total",
      "pizza_creation_failures_total",
      "pizza_revenue_total",
    ]) {
      const sum = find(payload, name).sum;
      expect(sum.aggregationTemporality).toBe(2);
      expect(sum.isMonotonic).toBe(true);
      for (const p of sum.dataPoints) {
        expect(p.startTimeUnixNano).toMatch(/^\d{19}$/);
      }
    }
    for (const name of [
      "active_users",
      "cpu_usage_percent",
      "memory_usage_percent",
    ]) {
      expect(find(payload, name).gauge).toBeDefined();
    }
  });

  test("tags every point with the configured source and timestamp", () => {
    const payload = new Metrics().buildPayload(1700000000000);
    expect(payload.resourceMetrics[0].resource.attributes[0]).toEqual({
      key: "service.name",
      value: { stringValue: "jwt-pizza-service-test" },
    });
    for (const metric of metricsOf(payload)) {
      for (const p of (metric.sum ?? metric.gauge).dataPoints) {
        expect(p.timeUnixNano).toBe("1700000000000000000");
        expect(withAttr([p], "source", "jwt-pizza-service-test")).toBeDefined();
      }
    }
  });

  test("integers are sent as strings and doubles as numbers", () => {
    const payload = new Metrics().buildPayload();
    expect(typeof points(payload, "active_users")[0].asInt).toBe("string");
    expect(typeof points(payload, "cpu_usage_percent")[0].asDouble).toBe(
      "number",
    );
  });

  test("falls back to the production source name without config", () => {
    config.metrics = undefined;
    const payload = new Metrics().buildPayload();
    expect(payload.resourceMetrics[0].resource.attributes[0].value).toEqual({
      stringValue: "jwt-pizza-service",
    });
  });
});

describe("sending to Grafana", () => {
  test("posts the payload with the account id and api key", async () => {
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValue({ ok: true });
    const m = new Metrics();
    const payload = m.buildPayload();

    await m.sendToGrafana(payload);

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://otlp.test/v1/metrics",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(payload),
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer 123:glc_abc",
        },
      }),
    );
  });

  test("reports a rejected push without throwing", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "bad key",
    });
    const log = jest.spyOn(console, "log").mockImplementation(() => {});

    await new Metrics().sendToGrafana({});

    expect(log).toHaveBeenCalledWith(
      "Failed to push metrics data to Grafana: 401 bad key",
    );
  });

  test("reports a network error without throwing", async () => {
    jest.spyOn(global, "fetch").mockRejectedValue(new Error("down"));
    const log = jest.spyOn(console, "log").mockImplementation(() => {});

    await new Metrics().sendToGrafana({});

    expect(log).toHaveBeenCalledWith("Error pushing metrics:", "down");
  });

  test("does nothing when no endpoint is configured", async () => {
    config.metrics = undefined;
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValue({ ok: true });
    await new Metrics().sendToGrafana({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("periodic reporting", () => {
  test("reports every period until stopped, and only runs one timer", () => {
    jest.useFakeTimers();
    const m = new Metrics();
    const report = jest.spyOn(m, "report").mockImplementation(() => {});

    m.start(1000);
    m.start(1000);
    jest.advanceTimersByTime(3000);
    expect(report).toHaveBeenCalledTimes(3);

    m.stop();
    jest.advanceTimersByTime(3000);
    expect(report).toHaveBeenCalledTimes(3);
    expect(m.timer).toBeNull();
  });

  test("defaults to a ten second period", () => {
    jest.useFakeTimers();
    const m = new Metrics();
    const report = jest.spyOn(m, "report").mockImplementation(() => {});
    m.start();
    jest.advanceTimersByTime(9999);
    expect(report).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(report).toHaveBeenCalledTimes(1);
    m.stop();
  });

  test("report builds and sends, and survives a failure", async () => {
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValue({ ok: true });
    const m = new Metrics();
    await m.report();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(m, "buildPayload").mockImplementation(() => {
      throw new Error("boom");
    });
    expect(() => m.report()).not.toThrow();
    expect(log).toHaveBeenCalledWith(
      "Error sending metrics",
      expect.any(Error),
    );
  });
});
