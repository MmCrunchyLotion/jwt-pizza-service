const { AsyncLocalStorage } = require("node:async_hooks");
const config = require("./config.js");

const SENSITIVE_KEYS = [
  "password",
  "token",
  "jwt",
  "apikey",
  "authorization",
  "secret",
];
const MASK = "*****";

class Logger {
  // Holds the current HTTP request so code deeper in the stack (like DB.query) can find the user.
  context = new AsyncLocalStorage();

  // ---------- Express middleware: HTTP requests ----------
  httpLogger = (req, res, next) => {
    const originalSend = res.send;
    let responseBody;
    res.send = function (body) {
      responseBody = body;
      return originalSend.call(this, body);
    };

    res.on("finish", () => {
      this.log(this.statusToLogLevel(res.statusCode), "http", {
        authorized: !!req.headers.authorization,
        user: req.user?.id,
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        reqBody: this.sanitize(req.body),
        resBody: this.sanitize(responseBody),
      });
    });

    this.context.run({ req }, next);
  };

  // ---------- Database requests ----------
  dbLogger(sql) {
    this.log("info", "db", {
      user: this.context.getStore()?.req?.user?.id,
      query: this.sanitizeString(sql),
    });
  }

  // ---------- Factory requests ----------
  factoryLogger(user, requestBody, responseBody, ok = true) {
    this.log(ok ? "info" : "error", "factory", {
      user: user?.id,
      reqBody: this.sanitize(requestBody),
      resBody: this.sanitize(responseBody),
    });
  }

  // ---------- Unhandled exceptions ----------
  unhandledErrorLogger(err, req) {
    this.log("error", "exception", {
      message: err?.message,
      statusCode: err?.statusCode,
      stack: err?.stack,
      method: req?.method,
      path: req?.originalUrl,
      user: req?.user?.id,
    });
  }

  // Errors that never reach Express (crashes outside a request). Call once from the server entry point.
  registerProcessHandlers() {
    const fatal = (kind) => (err) => {
      this.log("error", "exception", {
        kind,
        message: err?.message ?? String(err),
        stack: err?.stack,
      });
      // Give the log request a moment to leave, then die like Node would have.
      setTimeout(() => process.exit(1), 1000);
    };
    process.on("uncaughtException", fatal("uncaughtException"));
    process.on("unhandledRejection", fatal("unhandledRejection"));
  }

  statusToLogLevel(statusCode) {
    if (statusCode >= 500) return "error";
    if (statusCode >= 400) return "warn";
    return "info";
  }

  // ---------- Sanitizing ----------
  sanitize(data) {
    if (data === undefined || data === null) return "";
    let value = data;
    if (Buffer.isBuffer(value)) value = value.toString();
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        return this.sanitizeString(value);
      }
    }
    return JSON.stringify(this.redact(value));
  }

  redact(value) {
    if (Array.isArray(value)) return value.map((v) => this.redact(v));
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = SENSITIVE_KEYS.includes(k.toLowerCase())
          ? MASK
          : this.redact(v);
      }
      return out;
    }
    return typeof value === "string" ? this.sanitizeString(value) : value;
  }

  // Masks password literals in SQL and anything shaped like a JWT (three long dot-separated segments).
  sanitizeString(str) {
    return String(str)
      .replace(/(password\s*[:=]\s*)'[^']*'/gi, `$1'${MASK}'`)
      .replace(/\b[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g, MASK);
  }

  // ---------- Sending to Grafana Loki ----------
  log(level, type, logData) {
    const labels = {
      component: config.logging?.source ?? "jwt-pizza-service",
      level,
      type,
    };
    const message =
      typeof logData === "string"
        ? this.sanitizeString(logData)
        : JSON.stringify(logData);
    this.sendLogToGrafana({
      streams: [{ stream: labels, values: [[this.nowString(), message]] }],
    });
  }

  // Loki wants nanoseconds since the epoch, as a string.
  nowString() {
    return `${Date.now()}000000`;
  }

  sendLogToGrafana(event) {
    const { endpointUrl, accountId, apiKey } = config.logging ?? {};
    // No credentials configured, or running under Jest: don't call out (or disturb mocked fetch).
    if (!endpointUrl || process.env.JEST_WORKER_ID) return;

    fetch(endpointUrl, {
      method: "POST",
      body: JSON.stringify(event),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accountId}:${apiKey}`,
      },
    })
      .then((res) => {
        if (!res.ok) console.log("Failed to send log to Grafana");
      })
      .catch((err) =>
        console.log("Error sending log to Grafana:", err.message),
      );
  }
}

module.exports = new Logger();
