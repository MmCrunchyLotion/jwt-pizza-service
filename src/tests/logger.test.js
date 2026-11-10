const express = require("express");
const request = require("supertest");
const config = require("../config.js");
const logger = require("../logger.js");

const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwibmFtZSI6InRlc3QifQ.c2lnbmF0dXJlc2lnbmF0dXJl";

let sent;

beforeEach(() => {
  sent = [];
  jest.spyOn(logger, "sendLogToGrafana").mockImplementation((event) => {
    const { stream, values } = event.streams[0];
    sent.push({ labels: stream, data: JSON.parse(values[0][1]) });
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

// A small app that mirrors how service.js installs the middleware.
function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(logger.httpLogger);
  app.use((req, res, next) => {
    if (req.headers.authorization) req.user = { id: 42 };
    next();
  });
  app.post("/echo", async (req, res) => {
    await Promise.resolve();
    logger.dbLogger("SELECT * FROM user WHERE email=?");
    res.json({ ok: true, jwt: JWT, user: { name: "a", password: "hunter2" } });
  });
  app.get("/boom", () => {
    throw new Error("kaboom");
  });
  app.use((err, req, res, next) => {
    logger.unhandledErrorLogger(err, req);
    res.status(500).json({ message: err.message });
    next();
  });
  return app;
}

describe("http logging", () => {
  test("logs method, path, status, auth flag, user and sanitized bodies", async () => {
    await request(makeApp())
      .post("/echo?x=1")
      .set("Authorization", "Bearer secret-token")
      .send({ email: "a@b.com", password: "hunter2" });

    const http = sent.find((s) => s.labels.type === "http");
    expect(http.labels).toMatchObject({
      component: config.logging.source,
      level: "info",
    });
    expect(http.data).toMatchObject({
      authorized: true,
      user: 42,
      method: "POST",
      path: "/echo?x=1",
      statusCode: 200,
    });
    expect(http.data.reqBody).toContain("a@b.com");
    for (const field of [http.data.reqBody, http.data.resBody]) {
      expect(field).not.toContain("hunter2");
      expect(field).not.toContain(JWT);
    }
    expect(http.data.resBody).toContain("*****");
    expect(JSON.stringify(sent)).not.toContain("secret-token");
  });

  test("an unauthenticated request is flagged as such", async () => {
    await request(makeApp()).post("/echo").send({});
    const http = sent.find((s) => s.labels.type === "http");
    expect(http.data.authorized).toBe(false);
    expect(http.data.user).toBeUndefined();
  });

  test("database logs carry the user making the request", async () => {
    await request(makeApp())
      .post("/echo")
      .set("Authorization", "Bearer t")
      .send({});
    const db = sent.find((s) => s.labels.type === "db");
    expect(db.data).toEqual({
      user: 42,
      query: "SELECT * FROM user WHERE email=?",
    });
  });

  test("database logs outside a request have no user", () => {
    logger.dbLogger("SELECT 1");
    expect(sent[0].data.user).toBeUndefined();
  });

  test("server errors are logged as errors and as exceptions", async () => {
    await request(makeApp()).get("/boom");
    const http = sent.find((s) => s.labels.type === "http");
    expect(http.labels.level).toBe("error");
    expect(http.data.statusCode).toBe(500);
    const exception = sent.find((s) => s.labels.type === "exception");
    expect(exception.data).toMatchObject({ message: "kaboom", path: "/boom" });
    expect(exception.data.stack).toContain("kaboom");
  });

  test("client errors are logged as warnings", () => {
    expect(logger.statusToLogLevel(404)).toBe("warn");
    expect(logger.statusToLogLevel(200)).toBe("info");
  });
});

describe("factory logging", () => {
  test("logs the user and sanitized request and response", () => {
    logger.factoryLogger(
      { id: 7 },
      { diner: { id: 7 }, order: { id: 1 } },
      { jwt: JWT, reportUrl: "http://r" },
    );
    const factory = sent[0];
    expect(factory.labels).toMatchObject({ type: "factory", level: "info" });
    expect(factory.data.user).toBe(7);
    expect(factory.data.reqBody).toContain('"order"');
    expect(factory.data.resBody).not.toContain(JWT);
    expect(factory.data.resBody).toContain("http://r");
  });

  test("failed factory calls log at error level", () => {
    logger.factoryLogger({ id: 7 }, {}, {}, false);
    expect(sent[0].labels.level).toBe("error");
  });
});

describe("sanitizing", () => {
  test("masks sensitive keys at any depth and inside arrays", () => {
    const out = logger.sanitize({
      password: "p",
      nested: {
        apiKey: "k",
        Authorization: "Bearer x",
        list: [{ token: "t" }],
      },
      keep: "value",
    });
    expect(out).not.toMatch(/"(p|k|t)"|Bearer x/);
    expect(out).toContain("value");
  });

  test("parses JSON strings and tolerates empty, buffer and non-JSON input", () => {
    expect(logger.sanitize(undefined)).toBe("");
    expect(logger.sanitize(null)).toBe("");
    expect(logger.sanitize(Buffer.from('{"password":"p"}'))).not.toContain(
      '"p"',
    );
    expect(logger.sanitize("not json")).toBe("not json");
    expect(logger.sanitize(`password='abc' and ${JWT}`)).not.toMatch(/abc|eyJ/);
  });

  test("masks password literals in SQL", () => {
    const sql =
      "UPDATE user SET password='$2b$10$abcdefghijklmnop', name='x' WHERE id=1";
    const out = logger.sanitizeString(sql);
    expect(out).not.toContain("$2b$10");
    expect(out).toContain("name='x'");
  });

  test("leaves host names and emails alone", () => {
    expect(logger.sanitizeString("pizza-factory.cs329.click a@jwt.com")).toBe(
      "pizza-factory.cs329.click a@jwt.com",
    );
  });

  test("string log data is sanitized", () => {
    logger.sendLogToGrafana.mockRestore();
    const spy = jest
      .spyOn(logger, "sendLogToGrafana")
      .mockImplementation(() => {});
    logger.log("info", "other", `token ${JWT}`);
    expect(JSON.stringify(spy.mock.calls[0][0])).not.toContain(JWT);
  });
});

describe("sending to Grafana", () => {
  const original = {
    worker: process.env.JEST_WORKER_ID,
    logging: config.logging,
  };

  afterEach(() => {
    process.env.JEST_WORKER_ID = original.worker;
    config.logging = original.logging;
  });

  test("posts the event with the account id and api key", async () => {
    logger.sendLogToGrafana.mockRestore();
    delete process.env.JEST_WORKER_ID;
    config.logging = {
      source: "s",
      endpointUrl: "http://loki.test/push",
      accountId: "123",
      apiKey: "glc_abc",
    };
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValue({ ok: true });

    logger.log("info", "http", { hello: "world" });

    expect(fetchSpy).toHaveBeenCalledWith(
      "http://loki.test/push",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer 123:glc_abc",
        }),
      }),
    );
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.streams[0].stream).toEqual({
      component: "s",
      level: "info",
      type: "http",
    });
    expect(body.streams[0].values[0][0]).toMatch(/^\d{19}$/);
  });

  test("reports failures without throwing", async () => {
    logger.sendLogToGrafana.mockRestore();
    delete process.env.JEST_WORKER_ID;
    config.logging = {
      source: "s",
      endpointUrl: "http://loki.test/push",
      accountId: "1",
      apiKey: "k",
    };
    const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({ ok: false })
      .mockRejectedValueOnce(new Error("down"));

    logger.log("info", "http", {});
    logger.log("info", "http", {});
    await new Promise((resolve) => setImmediate(resolve));

    expect(consoleSpy).toHaveBeenCalledWith("Failed to send log to Grafana");
    expect(consoleSpy).toHaveBeenCalledWith(
      "Error sending log to Grafana:",
      "down",
    );
  });

  test("does nothing under Jest or when no endpoint is configured", () => {
    logger.sendLogToGrafana.mockRestore();
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValue({ ok: true });
    logger.log("info", "http", {});
    expect(fetchSpy).not.toHaveBeenCalled();

    delete process.env.JEST_WORKER_ID;
    config.logging = undefined;
    logger.log("info", "http", {});
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("process handlers", () => {
  test("log the failure and then exit", () => {
    jest.useFakeTimers();
    const handlers = {};
    jest.spyOn(process, "on").mockImplementation((event, fn) => {
      handlers[event] = fn;
      return process;
    });
    const exitSpy = jest.spyOn(process, "exit").mockImplementation(() => {});

    logger.registerProcessHandlers();
    handlers.uncaughtException(new Error("bad"));
    handlers.unhandledRejection("rejected");

    expect(sent.map((s) => s.data.message)).toEqual(["bad", "rejected"]);
    expect(sent[0].data.kind).toBe("uncaughtException");
    jest.runAllTimers();
    expect(exitSpy).toHaveBeenCalledWith(1);
    jest.useRealTimers();
  });
});
