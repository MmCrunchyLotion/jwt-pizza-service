const app = require("./service.js");
const logger = require("./logger.js");

logger.registerProcessHandlers();

const port = process.argv[2] || 3000;
app.listen(port, () => {
  console.log(`Server started on port ${port}`);
});
