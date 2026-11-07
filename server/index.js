import "dotenv/config";
import { createApp } from "./app.js";

const port = process.env.PORT || 3001;
const app = createApp();

app.listen(port, "0.0.0.0", () => {
  console.log(`Invitation maker server listening on http://localhost:${port}`);
});
