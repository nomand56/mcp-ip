// {
//   "mcpServers": {
//     "get-location-by-ip": {
//       "command": "node",
//       "args": ["D:/mcp-ip/server/index.js"]
//     }
//   }
// }

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const server = new McpServer({
  name: "Demo",
  version: "1.0.0",
})

server.tool(
  "get_location_by_ip",
  { ip: z.string().ip({ version: "v4" }) },
  async ({ ip }) => {
    const resp = await fetch("https://ipleak.net/json/" + ip)
    const json = await resp.json()
    return {
      content: [
        { type: "text", text: json.region_name + ", " + json.country_name },
      ],
    }
  }
)

// Start receiving messages on stdin and sending messages on stdout
const transport = new StdioServerTransport()
await server.connect(transport)
