const app = require("./service.js");
const logger = require("./logger.js");
const metrics = require("./metrics.js");

logger.registerProcessHandlers();
metrics.start();

const port = process.argv[2] || 3000;
app.listen(port, () => {
  console.log(`Server started on port ${port}`);
});
