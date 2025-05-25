import fetch from "node-fetch"; // or use global fetch in Node 18+
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import readline from "readline/promises";

//
// ——— Interfaces for OpenRouter tool‐calling schema ———
//
interface ToolPart {
  type: "text";
  text: string;
}

interface ToolUsePart {
  type: "tool_use";
  name: string;
  input: Record<string, unknown>;
}

type ORContentPart = ToolPart | ToolUsePart;

interface ORChoice {
  message: {
    role: "assistant"; // Assuming this will always be assistant role for choices
    content: ORContentPart[] | string; // Content can be an array of parts OR an empty string
    tool_calls?: Array<{ // OpenRouter can include tool_calls directly on message
      id: string;
      type: "function";
      function: {
        name: string;
        arguments: string; // Arguments come as a stringified JSON
      };
    }>;
  };
}

interface ORResponse {
  choices: ORChoice[];
}

interface ORMessage {
  role: "system" | "user" | "assistant";
  content: { type: "text"; text: string }[];
}

//
// ——— Your MCPClient class ———
//

class MCPClient {
  private mcp = new Client({ name: "mcp-client-cli", version: "1.0.0" });
  private transport!: StdioClientTransport;
  private tools: Array<{
    type: "function";
    function: {
      name: string;
      description?: string;
      parameters: any;
    };
  }> = [];

  async connectToServer(serverPath: string) {
    this.transport = new StdioClientTransport({
      command: "node",
      args: [serverPath],
    });
    this.mcp.connect(this.transport);
    console.log("[MCPClient] Connected to MCP server. Listing tools...");

    try {
      const { tools } = await this.mcp.listTools();
      // Map MCP tools into OpenRouter’s "tools" format
      this.tools = tools.map(t => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    } catch (error) {
      throw error; // Re-throw to indicate a critical setup failure
    }
  }

  private async callOR(messages: ORMessage[]): Promise<ORResponse> {
 
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer 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`, // **WARNING: Hardcoded API key is bad practice. Use environment variables.**
      },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages,
        tools: this.tools,       // pass your MCP tools here
        tool_choice: "auto",     // let the model decide when to call them
      }),
    });

    const json = await res.json();
    console.log(`[OpenRouter API] Received response status: ${res.status}`);
    console.log("[OpenRouter API] Full JSON response:", JSON.stringify(json, null, 2));

    if (!res.ok) {
      console.error(`[OpenRouter API] Error from OpenRouter: ${res.status} - ${JSON.stringify(json)}`);
      throw new Error(`OpenRouter ${res.status}: ${JSON.stringify(json)}`);
    }

    // Basic validation of the response structure
    if (!json.choices || json.choices.length === 0 || !json.choices[0].message) {
      console.warn("[OpenRouter API] OpenRouter response missing expected 'choices[0].message' structure.");
    }

    return json as ORResponse;
  }

  async processQuery(query: string): Promise<string> {
    console.log(`\n--- Processing new query: "${query}" ---`);

    const history: ORMessage[] = [
      { role: "user", content: [{ type: "text", text: query }] },
    ];

    const finalText: string[] = [];
    let currentContent: ORContentPart[] | string | undefined = undefined; // Can be array of parts or string
    let toolCalls: ORChoice['message']['tool_calls'] = undefined; // Tool calls are on the message object

    for (let turn = 0; turn < 2; turn++) {
        let resp: ORResponse;
        if (turn === 0) {
            // First call to OpenRouter
            console.log("[ProcessQuery] Making initial call to OpenRouter.");
            resp = await this.callOR(history);
        } else {
            // Subsequent calls after a tool execution
            console.log("[ProcessQuery] Making follow-up call to OpenRouter after tool execution.");
            resp = await this.callOR(history);
        }

        const message = resp.choices[0]?.message;
        if (!message) {
            console.warn(`[ProcessQuery] No message found in OpenRouter response turn ${turn}.`);
            if (turn === 0) {
                finalText.push("Model did not provide any content for the initial query.");
            } else {
                finalText.push("[Model did not provide a follow-up response after tool execution.]");
            }
            break; // No message, nothing more to do
        }

        currentContent = message.content;
        toolCalls = message.tool_calls;

        


        if (toolCalls && toolCalls.length > 0) {
            console.log(`[ProcessQuery] Model requested ${toolCalls.length} tool call(s) in turn ${turn}.`);
            // Process each tool call
            for (const toolCall of toolCalls) {
                if (toolCall.type === "function") {
                    const { name, arguments: argsJson } = toolCall.function;
                    let input: Record<string, unknown>;
                    try {
                        input = JSON.parse(argsJson);
                    } catch (e) {
                        finalText.push(`[Error: Could not parse arguments for tool ${name}]`);
                        // This tool call could not be executed, move to next part or break
                        continue;
                    }

                    console.log(`[ProcessQuery] Calling tool: ${name} with input:`, JSON.stringify(input));

                    try {
                        const toolRes = await this.mcp.callTool({ name, arguments: input });
                        const toolOutput = toolRes.content !== undefined && toolRes.content !== null
                            ? (typeof toolRes.content === 'object' ? JSON.stringify(toolRes.content) : String(toolRes.content))
                            : "No content from tool.";

                        finalText.push(`[Calling tool ${name} → ${toolOutput}]`);

                        // Feed the tool result back into the conversation history
                        history.push({
                            role: "assistant", // The model assistant is providing the tool output
                            content: [{ type: "text", text: toolOutput }],
                        });

                       
                        break; // Break from processing current tool calls and proceed to next turn for follow-up
                    } catch (toolError) {
                        finalText.push(`[Error calling tool ${name}: ${toolError instanceof Error ? toolError.message : String(toolError)}]`);
                        // Feed the error back to the model
                        history.push({
                            role: "assistant",
                            content: [{ type: "text", text: `Error executing tool ${name}: ${toolError instanceof Error ? toolError.message : String(toolError)}` }],
                        });
                        break; // Break from processing current tool calls and proceed to next turn for follow-up
                    }
                }
            }
           
            break; // Exit the loop here if we processed tool calls in the first turn
        } else if (currentContent) {
            console.log(`[ProcessQuery] Model responded with content (Turn ${turn}).`);
            if (typeof currentContent === 'string') {
                if (currentContent.trim().length > 0) {
                    finalText.push(currentContent);
                    console.log(`[ProcessQuery] Added string text to finalText: "${currentContent}"`);
                } else {
                    console.log("[ProcessQuery] Content was an empty string, no text added.");
                }
            } else if (Array.isArray(currentContent)) { // If content is an array of ORContentPart
                for (const part of currentContent) {
                    if (part.type === "text") {
                        finalText.push(part.text);
                        console.log(`[ProcessQuery] Added text part to finalText: "${part.text}"`);
                    } else if (part.type === "tool_use") {
                        console.warn(`[ProcessQuery] Unexpected 'tool_use' found in 'content' array. This indicates content parsing mismatch or older model behavior. Processing as text for now.`);
                        // For models like gpt-4o-mini, tool_use should be in `tool_calls` array, not `content`
                        finalText.push(`[Unexpected tool_use in content: ${part.name}. Not executed via content array.]`);
                    }
                }
            }
            // If model provided text content, we might be done with this turn
            break; // Exit the loop after processing text content
        } else {
            console.warn(`[ProcessQuery] OpenRouter response turn ${turn} had neither text content nor explicit tool calls. This might be the end of the conversation or an unexpected state.`);
            if (turn === 0) {
                finalText.push("Model did not provide any content or tool calls for the initial query.");
            } else {
                finalText.push("[Model did not provide a follow-up response.]");
            }
            break; // No content or tools, exit loop
        }
    }


    const finalOutput = finalText.join("\n");
    console.log(`--- Finished processing query. Final accumulated text: ---\n${finalOutput}\n-------------------------------------------------`);
    return finalOutput;


  }
//CLI is here with loop 

    /**
     * Starts a chat loop where the user can input queries and receive responses.
     * The loop continues until the user types 'quit'.
     */ 

    
  async chatLoop() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    console.log("\n--- Chat started. Type ‘quit’ to exit. ---");
    try {
      while (true) {
        const q = await rl.question("> ");
        if (q.toLowerCase() === "quit") {
          console.log("Exiting chat loop.");
          break;
        }
        try {
          const ans = await this.processQuery(q);
          console.log("\nModel says:\n" + ans + "\n"); // Present the final answer clearly
        } catch (e) {
          console.error(`\nError during query processing:`, e);
          console.log("Please try again or type 'quit' to exit.");
        }
      }
    } finally {
      rl.close();
      console.log("Readline interface closed.");
    }
  }

  async cleanup() {
    console.log("[MCPClient] Cleaning up and closing MCP connection.");
    await this.mcp.close();
    console.log("[MCPClient] MCP connection closed.");
  }
}

//
// ——— Bootstrap ———
//
(async () => {
  const client = new MCPClient();
  const serverPath = "C:/Users/PMLS/Desktop/code/mcp-json/mcp-ip/server/index.js";
  try {
    await client.connectToServer(serverPath);
    await client.chatLoop();
  } catch (error) {
    console.error(`\nFatal error during client initialization or chat loop:`, error);
    process.exit(1); // Exit with an error code
  } finally {
    await client.cleanup();
    console.log("Application gracefully shut down.");
  }
})();