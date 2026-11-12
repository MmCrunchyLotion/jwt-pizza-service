const os = require("os");
const config = require("./config.js");

// A user counts as active until they log out or go this long without making a request.
const ACTIVE_USER_WINDOW_MS = 5 * 60 * 1000;
const REPORT_PERIOD_MS = 10 * 1000;
const AUTH_PATH = /^\/api\/auth\/?$/;
// AGGREGATION_TEMPORALITY_CUMULATIVE in the OTLP spec.
const CUMULATIVE = 2;

class Metrics {
  constructor() {
    this.startTimeNano = toNano(Date.now());
    // Cumulative counters. Grafana turns these into "per minute" with rate()/increase().
    this.requests = { GET: 0, PUT: 0, POST: 0, DELETE: 0 };
    this.auth = { success: 0, failure: 0 };
    this.pizzas = { sold: 0, failures: 0, revenue: 0 };
    // user id -> time of their last activity.
    this.activeUsers = new Map();
    // Latencies are averaged over each reporting period, then reset.
    this.endpointLatency = { total: 0, count: 0 };
    this.pizzaLatency = { total: 0, count: 0 };
    this.timer = null;
  }

  // ---------- Express middleware: every HTTP request ----------
  requestTracker = (req, res, next) => {
    const start = performance.now();
    const isAuth = AUTH_PATH.test(req.originalUrl.split("?")[0]);
    const isLoginOrRegister =
      isAuth && (req.method === "PUT" || req.method === "POST");

    // A login/register response is the only place we learn which user just signed in.
    let responseBody;
    if (isLoginOrRegister) {
      const originalSend = res.send;
      res.send = function (body) {
        responseBody = body;
        return originalSend.call(this, body);
      };
    }

    res.on("finish", () => {
      this.recordRequest(req.method, performance.now() - start);

      if (isLoginOrRegister) {
        const success = res.statusCode === 200;
        this.recordAuth(success);
        if (success) this.touchUser(userIdFrom(responseBody));
      } else if (req.user) {
        if (isAuth && req.method === "DELETE") this.removeUser(req.user.id);
        else this.touchUser(req.user.id);
      }
    });

    next();
  };

  recordRequest(method, latencyMs) {
    this.requests[method] = (this.requests[method] ?? 0) + 1;
    this.endpointLatency.total += latencyMs;
    this.endpointLatency.count += 1;
  }

  recordAuth(success) {
    if (success) this.auth.success += 1;
    else this.auth.failure += 1;
  }

  // ---------- Active users ----------
  touchUser(userId) {
    if (userId === undefined || userId === null) return;
    this.activeUsers.set(userId, Date.now());
  }

  removeUser(userId) {
    this.activeUsers.delete(userId);
  }

  activeUserCount(now = Date.now()) {
    for (const [userId, lastSeen] of this.activeUsers) {
      if (now - lastSeen > ACTIVE_USER_WINDOW_MS)
        this.activeUsers.delete(userId);
    }
    return this.activeUsers.size;
  }

  // ---------- Pizza purchases ----------
  // Call once per order after the factory answers (or fails to).
  pizzaPurchase(success, latencyMs, revenue, pizzas = 1) {
    this.pizzaLatency.total += latencyMs;
    this.pizzaLatency.count += 1;
    if (success) {
      this.pizzas.sold += pizzas;
      this.pizzas.revenue = Number((this.pizzas.revenue + revenue).toFixed(8));
    } else {
      this.pizzas.failures += pizzas;
    }
  }

  // ---------- System ----------
  getCpuUsagePercentage() {
    const cores = os.cpus().length || 1;
    return Number(((os.loadavg()[0] / cores) * 100).toFixed(2));
  }

  getMemoryUsagePercentage() {
    const total = os.totalmem();
    const used = total - os.freemem();
    return Number(((used / total) * 100).toFixed(2));
  }

  // ---------- Building and sending the OTLP payload ----------
  buildPayload(now = Date.now()) {
    const time = toNano(now);
    const source = config.metrics?.source ?? "jwt-pizza-service";
    const attributes = (extra = []) => [attr("source", source), ...extra];
    const intPoint = (value, extra) => ({
      asInt: String(value),
      timeUnixNano: time,
      attributes: attributes(extra),
    });
    const doublePoint = (value, extra) => ({
      asDouble: value,
      timeUnixNano: time,
      attributes: attributes(extra),
    });
    const counter = (name, dataPoints) => ({
      name,
      sum: {
        dataPoints: dataPoints.map((p) => ({
          ...p,
          startTimeUnixNano: this.startTimeNano,
        })),
        aggregationTemporality: CUMULATIVE,
        isMonotonic: true,
      },
    });
    const gauge = (name, dataPoints) => ({ name, gauge: { dataPoints } });

    const metrics = [
      counter(
        "http_requests_total",
        Object.entries(this.requests).map(([method, count]) =>
          intPoint(count, [attr("method", method)]),
        ),
      ),
      counter("auth_attempts_total", [
        intPoint(this.auth.success, [attr("result", "success")]),
        intPoint(this.auth.failure, [attr("result", "failure")]),
      ]),
      gauge("active_users", [intPoint(this.activeUserCount(now))]),
      gauge("cpu_usage_percent", [doublePoint(this.getCpuUsagePercentage())]),
      gauge("memory_usage_percent", [
        doublePoint(this.getMemoryUsagePercentage()),
      ]),
      counter("pizzas_sold_total", [intPoint(this.pizzas.sold)]),
      counter("pizza_creation_failures_total", [
        intPoint(this.pizzas.failures),
      ]),
      counter("pizza_revenue_total", [doublePoint(this.pizzas.revenue)]),
    ];

    // Only report a latency when there was something to measure this period.
    const endpointLatency = takeAverage(this.endpointLatency);
    if (endpointLatency !== null) {
      metrics.push(
        gauge("latency_endpoint_ms", [doublePoint(endpointLatency)]),
      );
    }
    const pizzaLatency = takeAverage(this.pizzaLatency);
    if (pizzaLatency !== null) {
      metrics.push(
        gauge("latency_pizza_creation_ms", [doublePoint(pizzaLatency)]),
      );
    }

    return {
      resourceMetrics: [
        {
          resource: { attributes: [attr("service.name", source)] },
          scopeMetrics: [{ scope: { name: "jwt-pizza-service" }, metrics }],
        },
      ],
    };
  }

  sendToGrafana(payload) {
    const { endpointUrl, accountId, apiKey } = config.metrics ?? {};
    if (!endpointUrl) return Promise.resolve();

    return fetch(endpointUrl, {
      method: "POST",
      body: JSON.stringify(payload),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accountId}:${apiKey}`,
      },
    })
      .then(async (res) => {
        if (!res.ok) {
          console.log(
            `Failed to push metrics data to Grafana: ${res.status} ${await res.text()}`,
          );
        }
      })
      .catch((err) => console.log("Error pushing metrics:", err.message));
  }

  report() {
    try {
      return this.sendToGrafana(this.buildPayload());
    } catch (error) {
      console.log("Error sending metrics", error);
    }
  }

  // ---------- Periodic reporting ----------
  // Called from index.js only, so tests never start a timer.
  start(period = REPORT_PERIOD_MS) {
    if (this.timer) return;
    this.timer = setInterval(() => this.report(), period);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

// Loki and OTLP want nanoseconds since the epoch, as a string.
function toNano(ms) {
  return `${ms}000000`;
}

function attr(key, value) {
  return { key, value: { stringValue: String(value) } };
}

function userIdFrom(body) {
  try {
    return JSON.parse(body)?.user?.id;
  } catch {
    return undefined;
  }
}

function takeAverage(latency) {
  if (!latency.count) return null;
  const average = Number((latency.total / latency.count).toFixed(2));
  latency.total = 0;
  latency.count = 0;
  return average;
}

module.exports = new Metrics();
module.exports.Metrics = Metrics;
