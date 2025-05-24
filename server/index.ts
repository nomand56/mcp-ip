import {
    McpServer,
    ResourceTemplate,
  } from "@modelcontextprotocol/sdk/server/mcp.js";
  import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
  import { z } from "zod";
  
  // Create an MCP server
  const server = new McpServer({
    name: "Demo",
    version: "1.0.0",
  });
  
  // Add an addition tool
  server.tool("get_location_by_ip", 
    { ip: z.string().ip({ version: "v4" }) },
    async ({ ip }) => {
    const resp = await fetch("https://ipleak.net/json/" + ip);
    const json:any = await resp.json();
    return {
      content: [{ type: "text", text: json.region_name + json.country_name }],
    };
  });
  
  // Start receiving messages on stdin and sending messages on stdout
  const transport = new StdioServerTransport();
  await server.connect(transport);


//   {
//   "mcpServers": {
//     "google-maps": {
//       "command": "docker",
//       "args": [
//         "run",
//         "-i",
//         "--rm",
//         "-e",
//         "GOOGLE_MAPS_API_KEY",
//         "mcp/google-maps"
//       ],
//       "env": {
//         "GOOGLE_MAPS_API_KEY": "<YOUR_API_KEY>"
//       }
//     }
//   }
// }
  