import { startServer } from "./app.js";

startServer().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
