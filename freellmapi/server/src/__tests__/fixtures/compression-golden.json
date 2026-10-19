[
  {
    "name": "claude-code-build",
    "messages": [
      {
        "role": "system",
        "content": "You are Claude Code. Work carefully.   \n\n\n\nPreserve the user's repository state."
      },
      {
        "role": "user",
        "content": "Fix the build and do not stop until the tests pass."
      },
      {
        "role": "assistant",
        "content": "",
        "tool_calls": [
          {
            "id": "toolu_build",
            "type": "function",
            "function": {
              "name": "run_command",
              "arguments": "{\"command\":\"npm run build\"}"
            }
          }
        ]
      },
      {
        "role": "tool",
        "tool_call_id": "toolu_build",
        "content": "building package alpha\nbuilding package alpha\nbuilding package alpha\nbuilding package alpha\nbuilding package alpha\nbuilding package alpha\nbuilding package alpha\nbuilding package alpha\nbuilding package alpha\nbuilding package alpha\nbuilding package alpha\nbuilding package alpha\nbuilding package alpha\nbuilding package alpha\nbuilding package alpha\nbuilding package alpha\nbuilding package alpha\nbuilding package alpha\nbuilding package alpha\nbuilding package alpha\nError: compilation failed in /repo/src/index.ts at 42\n    at compile (/repo/src/build.ts:42:7)\n@@ -10,2 +10,3 @@\nexit_code=1"
      }
    ]
  },
  {
    "name": "codex-json-tool-result",
    "messages": [
      {
        "role": "system",
        "content": "You are a coding agent."
      },
      {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "call_rows",
            "type": "function",
            "function": {
              "name": "query_database",
              "arguments": "{\"table\":\"models\"}"
            }
          }
        ]
      },
      {
        "role": "tool",
        "tool_call_id": "call_rows",
        "content": "[\n  { \"id\": 1, \"name\": \"alpha\", \"enabled\": true },\n  { \"id\": 2, \"name\": \"beta\", \"enabled\": true },\n  { \"id\": 3, \"name\": \"gamma\", \"enabled\": false },\n  { \"id\": 4, \"name\": \"delta\", \"enabled\": true },\n  { \"id\": 5, \"name\": \"epsilon\", \"enabled\": true },\n  { \"id\": 6, \"name\": \"zeta\", \"enabled\": false },\n  { \"id\": 7, \"name\": \"eta\", \"enabled\": true },\n  { \"id\": 8, \"name\": \"theta\", \"enabled\": true },\n  { \"id\": 9, \"name\": \"iota\", \"enabled\": true },\n  { \"id\": 10, \"name\": \"kappa\", \"enabled\": false }\n]"
      }
    ]
  },
  {
    "name": "aider-repeated-context",
    "messages": [
      {
        "role": "system",
        "content": "Act as an expert pair programmer."
      },
      {
        "role": "user",
        "content": "The application must remain responsive during catalog refreshes.\nThe catalog refresh runs in the background and publishes an immutable snapshot.\nReaders should continue using the previous snapshot until the new one is ready.\nThis paragraph is deliberately repeated by the client as repository context."
      },
      {
        "role": "assistant",
        "content": "I will inspect the refresh path."
      },
      {
        "role": "user",
        "content": "The application must remain responsive during catalog refreshes.\nThe catalog refresh runs in the background and publishes an immutable snapshot.\nReaders should continue using the previous snapshot until the new one is ready.\nThis paragraph is deliberately repeated by the client as repository context.\n\nNow implement the fix."
      }
    ]
  }
]
